import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { answeredApprovalDecision, answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { redactFsPath } from "../../audit/dlp-filter.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { answeredApprovalProvenance, answeredProvenanceRecord, approvalDecisionTrustOrigin, isAnsweredApprovalDenial, provenanceTrustOrigin, type AnsweredProvenance, type ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ToolExecutor } from "../executor.js";
import { HookRunner } from "../../hooks/hook-runner.js";
import { WriteFileTool } from "../file-tools.js";
import { ToolRegistry } from "../registry.js";
import { permissionAuditEntryFromToolCall } from "../pipeline/audit-entries.js";
import { AuditWriter } from "../pipeline/audit-writer.js";
import { HOST_PROVENANCE, RULE_PROVENANCE } from "../../permissions/decision-provenance.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import type { TerminalRowWriter } from "../invocation-ledger.js";

const sessionRegistration = vi.hoisted(() => ({ error: undefined as string | undefined }));
vi.mock("../../permissions/permission-slash.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../permissions/permission-slash.js")>();
  return {
    ...actual,
    dispatchPermissionDirCommand: (...args: Parameters<typeof actual.dispatchPermissionDirCommand>) =>
      args[0].verb === "allow" && args[0].session && sessionRegistration.error !== undefined
        ? Promise.resolve({ ok: false as const, error: sessionRegistration.error })
        : actual.dispatchPermissionDirCommand(...args),
  };
});

let root: string;
let project: string;
let audit: AuditLogger;
let manager: PermissionManager;
let registry: ToolRegistry;

beforeAll(() => configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false }));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-answered-origin-")));
  project = join(root, "project");
  await mkdir(project);
  vi.stubEnv("AVE_HOME", join(root, "state"));
  audit = new AuditLogger(join(root, "audit"));
  await audit.setupPermissionAuditChain("aa".repeat(32));
  manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("default");
  registry = new ToolRegistry();
  registry.register(new WriteFileTool());
});
afterEach(async () => {
  sessionRegistration.error = undefined;
  await audit.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function auditRows(): Promise<Array<Record<string, unknown>>> {
  return (await readFile(audit.getPermissionAuditLogFile(), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

async function ledger(toolUseId: string): Promise<Array<Record<string, unknown>>> {
  return (await auditRows()).filter(row => row.toolUseId === toolUseId && row.decision !== "ask");
}

describe("plugin-emitted invocations answered at the desk", () => {
  it("records the tool allow as the desk's", async () => {
    const requestAndWait = answeringRequestAndWait(() => ({ choice: "allow-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await executor.executeAll([{ id: "plugin-tool-write", name: "write_file", input: { path: join(project, "answered.txt"), content: "answered" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project] },
    });
    expect(result.is_error, result.content).not.toBe(true);
    expect(requestAndWait).toHaveBeenCalledOnce();
    expect((await auditRows()).filter(row => row.toolUseId === "plugin-tool-write" && row.decision === "allow"))
      .toEqual([expect.objectContaining({ trustOrigin: "user-keyboard" })]);
  });

  it("records the directory grant and allow as the desk's", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const requestAndWait = answeringRequestAndWait((request: ApprovalRequestInput) => ({ choice: request.kind === "out-of-allowed-dir" ? "allow-session" as const : "allow-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await executor.executeAll([{ id: "plugin-dir-write", name: "write_file", input: { path: join(outside, "answered.txt"), content: "answered" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project], onTurnDirectoryGrant: vi.fn(), onSessionDirectoryGrant: vi.fn() },
    });
    expect(result.is_error, result.content).not.toBe(true);
    expect(requestAndWait.mock.calls.map(([request]) => request.kind)).toContain("out-of-allowed-dir");
    const rows = (await auditRows()).filter(row => row.toolUseId === "plugin-dir-write" && row.decision === "allow");
    expect(rows.find(row => row.grantLifetime === "session")).toMatchObject({ trustOrigin: "user-keyboard" });
    expect(rows.filter(row => row.grantLifetime === undefined)).toEqual([expect.objectContaining({ trustOrigin: "user-keyboard" })]);
  });
});

describe("the answerer contract", () => {
  it("throws for an answered decision the gate kept no record of", async () => {
    expect(() => answeredApprovalProvenance({ requestId: "unrecorded", choice: "allow-once" }))
      .toThrow("approval: an answered decision carries no record of who answered");
    expect(answeredProvenanceRecord(answeredApprovalProvenance(await answeredApprovalDecision({ choice: "allow-once" }))))
      .toEqual({ decision: "allow", requestId: expect.any(String), toolName: "answer", toolUseId: undefined, choice: "allow-once", answerer: "desk", trustOrigin: "user-keyboard" });
  });

  it("fails closed on a copied or edited answer handle", async () => {
    const handle = answeredApprovalProvenance(await answeredApprovalDecision({ choice: "deny-once" }));
    const edited = { ...handle, decision: "allow" } as AnsweredProvenance;
    expect(() => provenanceTrustOrigin(edited, "allow", "plugin-emitted")).toThrow("approval: an answered provenance the gate did not mint");
    expect(() => provenanceTrustOrigin({ ...handle } as AnsweredProvenance, "deny", "plugin-emitted")).toThrow("approval: an answered provenance the gate did not mint");
    expect(provenanceTrustOrigin(handle, "deny", "plugin-emitted")).toBe("user-keyboard");
  });

  it("keeps the recorded answer when the decision object is edited after the gate accepted it", async () => {
    const decision = await answeredApprovalDecision({ choice: "deny-once" });
    // The accepted decision is immutable: a consumer cannot branch on an edited choice.
    expect(() => { decision.choice = "allow-once"; }).toThrow(TypeError);
    expect(decision.choice).toBe("deny-once");
    expect(provenanceTrustOrigin(answeredApprovalProvenance(decision), "allow", "plugin-emitted")).toBe("plugin-emitted");
    expect(provenanceTrustOrigin(answeredApprovalProvenance(decision), "deny", "plugin-emitted")).toBe("user-keyboard");
    expect(isAnsweredApprovalDenial(decision)).toBe(true);
  });

  it("refuses a plugin-emitted write whose answer the gate never recorded", async () => {
    const requestAndWait = vi.fn(async (request: ApprovalRequestInput) => ({ requestId: request.id, choice: "allow-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    await expect(executor.executeAll([{ id: "plugin-unrecorded-write", name: "write_file", input: { path: join(project, "unrecorded.txt"), content: "unrecorded" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project] },
    })).rejects.toThrow("approval: an answered decision carries no record of who answered");
  });
  it("refuses another invocation's allow at the terminal and grant writers", async () => {
    const other = answeredApprovalProvenance(await answeredApprovalDecision({ choice: "allow-once" }, "desk", "write_file", "other-invocation"));
    const terminal = (toolUseId: string) => permissionAuditEntryFromToolCall({
      toolName: "write_file", source: "builtin", category: "write", input: { path: "notes.txt" },
      permission: { decision: "allow", reason: "answered", provenance: other },
      rateLimitRemaining: Infinity, trustOrigin: "plugin-emitted", cwd: "/workspace", audit: { toolUseId },
    });
    expect(() => terminal("this-invocation")).toThrow("does not settle this allow of write_file");
    expect(terminal("other-invocation")).toMatchObject({ decision: "allow", trustOrigin: "user-keyboard" });
    const writer = new AuditWriter(audit, registry, undefined, true);
    const grant = (toolUseId: string, toolName = "write_file") => writer.auditPermissionGrant({
      toolName, source: "builtin", category: "write", directory: project, grantLifetime: "turn", provenance: other, audit: { toolUseId },
    });
    await expect(grant("this-invocation")).rejects.toThrow("does not settle this allow of write_file");
    await expect(grant("other-invocation", "edit_file")).rejects.toThrow("does not settle this allow of edit_file");
    expect(existsSync(audit.getPermissionAuditLogFile()) ? (await readFile(audit.getPermissionAuditLogFile(), "utf8")).trim() : "").toBe("");
  });

  it("refuses an answer bound to no invocation at an invocation's terminal and grant writers", async () => {
    const unbound = answeredApprovalProvenance(await answeredApprovalDecision({ choice: "allow-once" }, "desk", "write_file"));
    const terminal = (audit?: { toolUseId: string }) => permissionAuditEntryFromToolCall({
      toolName: "write_file", source: "builtin", category: "write", input: { path: "notes.txt" },
      permission: { decision: "allow", reason: "answered", provenance: unbound },
      rateLimitRemaining: Infinity, trustOrigin: "plugin-emitted", cwd: "/workspace", ...(audit ? { audit } : {}),
    });
    expect(() => terminal({ toolUseId: "this-invocation" })).toThrow("does not settle this allow of write_file");
    expect(terminal()).toMatchObject({ decision: "allow", trustOrigin: "user-keyboard" });
    const writer = new AuditWriter(audit, registry, undefined, true);
    await expect(writer.auditPermissionGrant({
      toolName: "write_file", source: "builtin", category: "write", directory: project, grantLifetime: "turn", provenance: unbound,
      audit: { toolUseId: "this-invocation" },
    })).rejects.toThrow("does not settle this allow of write_file");
  });

  it("refuses an allow the gate settled for another invocation before the tool runs", async () => {
    const requestAndWait = vi.fn(async () => answeredApprovalDecision({ choice: "allow-once" }, "desk", "write_file", "other-invocation"));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    await expect(executor.executeAll([{ id: "plugin-substituted-write", name: "write_file", input: { path: join(project, "substituted.txt"), content: "substituted" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project] },
    })).rejects.toThrow("does not settle this allow of write_file");
    await expect(readFile(join(project, "substituted.txt"))).rejects.toThrow();
    await vi.waitFor(async () => expect((await auditRows()).filter(row => row.toolUseId === "plugin-substituted-write" && row.decision !== "ask"))
      .toEqual([expect.objectContaining({ decision: "deny", trustOrigin: "unknown" })]));
  });

  it("keeps the claim open when the terminal writer refuses another invocation's allow, so the host writes the one row", async () => {
    const other = answeredApprovalProvenance(await answeredApprovalDecision({ choice: "allow-once" }, "desk", "write_file", "other-invocation"));
    const { admitToolInvocation } = await import("../invocation-ledger.js");
    const writer = new AuditWriter(audit, registry, undefined, true);
    const call = (permission: PermissionCheckResult, cause?: "error") => (row: TerminalRowWriter) => writer.auditToolCall(
      "integrity-session", "write_file", "builtin", "medium", { path: "notes.txt" }, "refused", true, Date.now(), permission, Infinity,
      { trustOrigin: "plugin-emitted" }, "write", project, undefined, cause, undefined, { toolUseId: "integrity-call" }, { row, kind: "denied" });
    const admission = admitToolInvocation("write_file");
    const NO_DENIAL = { governed: () => false, fire: async () => {} };
    admission.terminal.hostTerminal((cause, detail, _selected, row) =>
      call({ decision: "deny", reason: detail, provenance: HOST_PROVENANCE }, cause === "error" ? cause : undefined)(row), NO_DENIAL);
    await expect(admission.terminal.commit(call({ decision: "allow", reason: "answered", provenance: other })))
      .rejects.toThrow("does not settle this allow of write_file");
    await vi.waitFor(() => expect(admission.terminal.state).toBe("failed"));
    admission.settle(new Error("does not settle this allow of write_file"));
    expect((await auditRows()).filter(row => row.toolUseId === "integrity-call")).toEqual([expect.objectContaining({
      decision: "deny", trustOrigin: "unknown",
      denyReasons: [expect.objectContaining({ reason: expect.stringContaining("the terminal row failed its integrity check") })],
    })]);
  });

  it("ends a selected deny whose record fails its integrity check with the host's own refusal row", async () => {
    const requestAndWait = vi.fn(async (request: ApprovalRequestInput) =>
      answeredApprovalDecision({ requestId: request.id, choice: "deny-once" }, "desk", request.toolName, "other-invocation"));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    await executor.executeAll([{ id: "integrity-deny", name: "write_file", input: { path: join(project, "integrity.txt"), content: "x" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project] },
    }).catch(() => undefined);
    await vi.waitFor(async () => expect(await ledger("integrity-deny")).toEqual([expect.objectContaining({
      decision: "deny", trustOrigin: "unknown",
      denyReasons: [expect.objectContaining({ reason: expect.stringContaining("the terminal row failed its integrity check") })],
    })]));
  });

  it("tells a host refusal from an allow without a record", () => {
    expect(approvalDecisionTrustOrigin(Object.freeze({ requestId: "host-refusal", choice: "deny-once" as const }))).toBe("unknown");
    expect(() => approvalDecisionTrustOrigin({ requestId: "forged", choice: "allow-once" })).toThrow("approval: an allow carries no record of who answered");
  });

  it("never projects an ask nobody settled as an allow", () => {
    const entry = permissionAuditEntryFromToolCall({
      toolName: "write_file", source: "builtin", category: "write", input: { path: "notes.txt" },
      permission: { decision: "ask", reason: "a person must answer this write", provenance: RULE_PROVENANCE },
      rateLimitRemaining: Infinity, trustOrigin: "plugin-emitted", cwd: "/workspace",
    });
    expect(entry).toMatchObject({ decision: "deny", trustOrigin: "unknown", denyReasons: [{ reason: "a person must answer this write" }] });
  });
});

describe("one terminal row per plugin-emitted invocation answered at the desk", () => {

  // The allow control proves the revoke is live on each card: it vetoes an affirmative answer, never a settled deny.
  it.each((["tool", "directory"] as const).flatMap(card => [
    ["deny-once", "before", card, "user-keyboard", false],
    ["deny-once", "after", card, "user-keyboard", false],
    ["allow-once", "before", card, "tailnet-surface", true],
  ] as const))("records the desk's %s with the remote share revoked %s the %s card", async (choice, when, card, origin, vetoed) => {
    let current = true;
    const sessionId = randomUUID();
    const remoteControllerAuthority = bindRemoteControllerToSession({
      kind: "tailnet-controller", actorId: "tailnet:alice",
      pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
      pairedShareGuard: { isCurrent: () => current, refreshCurrent: async () => current },
    }, sessionId);
    const answer = answeringRequestAndWait(() => ({ choice }));
    const requestAndWait = vi.fn(async (request: ApprovalRequestInput) => {
      if (when === "before") current = false;
      const decision = await answer(request);
      if (when === "after") current = false;
      return decision;
    });
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const id = `revoked-${choice}-${when}-${card}`;
    const folder = card === "tool" ? project : join(root, "outside");
    await mkdir(folder, { recursive: true });
    const [result] = await executor.executeAll([{ id, name: "write_file", input: { path: join(folder, "revoked.txt"), content: "revoked" } }], {
      sessionId, executionCwd: project,
      permissionContext: { trustOrigin: "tailnet-surface", additionalDirectories: [project], remoteControllerAuthority },
    });
    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(requestAndWait.mock.calls[0]?.[0].kind === "out-of-allowed-dir").toBe(card === "directory");
    expect(result.is_error).toBe(true);
    expect(String(result.content).includes("remote-controller-revoked")).toBe(vetoed);
    await expect(readFile(join(folder, "revoked.txt"))).rejects.toThrow();
    const rows = await ledger(id);
    expect(rows).toEqual([expect.objectContaining({ decision: "deny", trustOrigin: origin })]);
    expect(JSON.stringify(rows[0]?.denyReasons).includes("remote-controller-revoked")).toBe(vetoed);
  });

  it.each(["rule", "revoked"] as const)("reports a %s refusal after the directory answer", async outcome => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const sessionId = randomUUID();
    let current = true;
    const remoteControllerAuthority = bindRemoteControllerToSession({
      kind: "tailnet-controller", actorId: "tailnet:alice",
      pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
      pairedShareGuard: { isCurrent: () => current, refreshCurrent: async () => current },
    }, sessionId);
    const surface = await import("../pipeline/user-owned-surface.js");
    const reason = "The surface policy refused this directory.";
    const resolve = vi.spyOn(surface, "resolveUserOwnedSurfaceApproval").mockImplementationOnce(async ({ decision }) => {
      if (outcome === "revoked") current = false;
      const provenance = outcome === "revoked" ? HOST_PROVENANCE : RULE_PROVENANCE;
      return { permission: { decision: "deny", reason, provenance }, decision: { requestId: decision.requestId, choice: "deny-once" }, provenance, answer: undefined };
    });
    const requestAndWait = answeringRequestAndWait(() => ({ choice: "allow-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const id = `surface-${outcome}`;
    const path = join(outside, "refused.txt");
    try {
      const [result] = await executor.executeAll([{ id, name: "write_file", input: { path, content: "refused" } }], {
        sessionId, executionCwd: project,
        permissionContext: { trustOrigin: "tailnet-surface", additionalDirectories: [project], remoteControllerAuthority },
      });
      expect(resolve).toHaveBeenCalledOnce();
      expect(requestAndWait).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "out-of-allowed-dir" }));
      const expected = outcome === "revoked" ? "remote-controller-revoked" : reason;
      expect(result).toMatchObject({ is_error: true, content: expect.stringContaining(expected) });
      expect(await ledger(id)).toEqual([expect.objectContaining({
        decision: "deny", trustOrigin: "tailnet-surface", denyReasons: [expect.objectContaining({ reason: expected })],
      })]);
      await expect(readFile(path)).rejects.toThrow();
    } finally {
      resolve.mockRestore();
    }
  });

  it("records the desk's deny of the tool card", async () => {
    const requestAndWait = answeringRequestAndWait(() => ({ choice: "deny-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await executor.executeAll([{ id: "plugin-tool-deny", name: "write_file", input: { path: join(project, "denied.txt"), content: "denied" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project] },
    });
    expect(result.is_error).toBe(true);
    expect(await ledger("plugin-tool-deny")).toEqual([expect.objectContaining({ decision: "deny", trustOrigin: "user-keyboard" })]);
  });

  it.each([
    ["deny-once", [["deny", undefined]]],
    ["allow-once", [["allow", "turn"], ["allow", undefined]]],
    ["allow-always", [["allow", "always"], ["deny", undefined]]],
  ] as const)("records the desk's %s of the directory card with its grant", async (choice, expected) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const requestAndWait = answeringRequestAndWait((request: ApprovalRequestInput) => ({ choice: request.kind === "out-of-allowed-dir" ? choice : "allow-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    await executor.executeAll([{ id: "plugin-dir-answer", name: "write_file", input: { path: join(outside, "answered.txt"), content: "answered" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project], onTurnDirectoryGrant: vi.fn(), onSessionDirectoryGrant: vi.fn() },
    });
    const rows = await ledger("plugin-dir-answer");
    expect(rows.map(row => [row.decision, row.grantLifetime])).toEqual(expected);
    // A durable grant whose folder rule cannot be saved ends in the host's save failure, not in the desk's answer.
    expect(rows.map(row => row.trustOrigin)).toEqual(expected.map(([, lifetime]) => choice === "allow-always" && lifetime === undefined ? "unknown" : "user-keyboard"));
  });

  it("pairs the desk's saved folder grant with its terminal allow", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const allowDirectory = vi.fn(async (directory: string) => [directory]);
    const requestAndWait = answeringRequestAndWait((request: ApprovalRequestInput) => ({ choice: request.kind === "out-of-allowed-dir" ? "allow-always" as const : "allow-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit, undefined,
      () => ({ allowDirectory, denyDirectory: vi.fn() }) as never);
    const [result] = await executor.executeAll([{ id: "plugin-dir-kept", name: "write_file", input: { path: join(outside, "kept.txt"), content: "kept" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project], onTurnDirectoryGrant: vi.fn(), onSessionDirectoryGrant: vi.fn() },
    });
    expect(result.is_error, result.content).not.toBe(true);
    expect(allowDirectory).toHaveBeenCalledOnce();
    expect(await readFile(join(outside, "kept.txt"), "utf8")).toBe("kept");
    expect((await ledger("plugin-dir-kept")).map(row => [row.decision, row.grantLifetime, row.trustOrigin]))
      .toEqual([["allow", "always", "user-keyboard"], ["allow", undefined, "user-keyboard"]]);
  });

  it.each([
    ["allow-always", "folder rule save failed: workspace lifecycle unavailable", [["allow", "always"], ["deny", undefined]]],
    ["allow-session", "session folder registration failed: session scope unavailable", [["deny", undefined]]],
  ] as const)("keeps the desk's %s on the host's refusal when the folder grant cannot be kept", async (choice, reason, expected) => {
    sessionRegistration.error = "session scope unavailable";
    const outside = join(root, "outside");
    await mkdir(outside);
    const requestAndWait = answeringRequestAndWait((request: ApprovalRequestInput) => ({ choice: request.kind === "out-of-allowed-dir" ? choice : "allow-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await executor.executeAll([{ id: "plugin-dir-unkept", name: "write_file", input: { path: join(outside, "unkept.txt"), content: "unkept" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project], onTurnDirectoryGrant: vi.fn(), onSessionDirectoryGrant: vi.fn() },
    });
    expect(result.is_error).toBe(true);
    await expect(readFile(join(outside, "unkept.txt"))).rejects.toThrow();
    const rows = await ledger("plugin-dir-unkept");
    expect(rows.map(row => [row.decision, row.grantLifetime])).toEqual(expected);
    expect(rows.at(-1)).toMatchObject({ trustOrigin: "unknown", answerTrustOrigin: "user-keyboard", denyReasons: [{ reason }] });
  });

  it("keeps the desk's Deny Always row when its rule save fails on I/O", async () => {
    const save = vi.spyOn(manager, "addAlwaysDeniedPersist").mockRejectedValue(new Error("EIO: write failed"));
    const requestAndWait = answeringRequestAndWait(() => ({ choice: "deny-always" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await executor.executeAll([{ id: "plugin-deny-always-io", name: "write_file", input: { path: join(project, "denied.txt"), content: "denied" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project] },
    });
    expect(save).toHaveBeenCalledOnce();
    expect(result.is_error).toBe(true);
    await expect(readFile(join(project, "denied.txt"))).rejects.toThrow();
    expect(await ledger("plugin-deny-always-io")).toEqual([expect.objectContaining({ decision: "deny", trustOrigin: "user-keyboard" })]);
  });

  it("records a failing tool card as the host's refusal", async () => {
    const requestAndWait = vi.fn(async () => { throw new Error("approval surface crashed"); });
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await executor.executeAll([{ id: "plugin-tool-gate-error", name: "write_file", input: { path: join(project, "gate.txt"), content: "gate" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project] },
    });
    expect(result.is_error).toBe(true);
    expect(await ledger("plugin-tool-gate-error")).toEqual([expect.objectContaining({ decision: "deny", trustOrigin: "unknown" })]);
  });

  it("records a failing directory card as the host's refusal and never as an allow", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const requestAndWait = answeringRequestAndWait((request: ApprovalRequestInput) => {
      if (request.kind === "out-of-allowed-dir") throw new Error("approval surface crashed");
      return { choice: "allow-once" };
    });
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await executor.executeAll([{ id: "plugin-dir-gate-error", name: "write_file", input: { path: join(outside, "gate.txt"), content: "gate" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project], onTurnDirectoryGrant: vi.fn(), onSessionDirectoryGrant: vi.fn() },
    });
    expect(result.is_error).toBe(true);
    expect(await ledger("plugin-dir-gate-error")).toEqual([expect.objectContaining({ decision: "deny", trustOrigin: "unknown" })]);
  });
});

describe("refusals nobody answered", () => {

  it("records a PreToolUse block as the policy's deny, never as an allow", async () => {
    const hooks = new HookRunner();
    vi.spyOn(hooks, "runPreHooks").mockResolvedValue({ action: "deny", reason: "blocked by hook" } as never);
    const requestAndWait = answeringRequestAndWait(() => ({ choice: "allow-once" as const }));
    const executor = new ToolExecutor(registry, hooks, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await executor.executeAll([{ id: "hook-blocked", name: "write_file", input: { path: join(project, "hook.txt"), content: "hook" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project] },
    });
    expect(result.is_error).toBe(true);
    await expect(readFile(join(project, "hook.txt"))).rejects.toThrow();
    expect(await ledger("hook-blocked")).toEqual([expect.objectContaining({ decision: "deny", trustOrigin: "plugin-emitted" })]);
  });

  it("records a deny nobody could approve as the host's", async () => {
    const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined, audit);
    const [result] = await executor.executeAll([{ id: "no-approver", name: "write_file", input: { path: join(project, "unattended.txt"), content: "unattended" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project], headless: true },
    });
    expect(result.is_error).toBe(true);
    await expect(readFile(join(project, "unattended.txt"))).rejects.toThrow();
    expect(await ledger("no-approver")).toEqual([expect.objectContaining({ decision: "deny", trustOrigin: "unknown" })]);
  });

  it("leaves the host's refusal row when a folder card has no gate to ask", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined, audit);
    const [result] = await executor.executeAll([{ id: "no-folder-gate", name: "write_file", input: { path: join(outside, "gateless.txt"), content: "gateless" } }], {
      sessionId: randomUUID(), executionCwd: project,
      permissionContext: { trustOrigin: "plugin-emitted", additionalDirectories: [project] },
    });
    const reason = "Nobody can approve this request; do not retry.";
    expect(result).toMatchObject({ is_error: true, content: reason });
    await expect(readFile(join(outside, "gateless.txt"))).rejects.toThrow();
    expect(await ledger("no-folder-gate")).toEqual([expect.objectContaining({
      decision: "deny", trustOrigin: "unknown", denyReasons: [{ reason, source: "tool-executor" }],
    })]);
  });
});

describe("the deny row's working directory", () => {
  const deny = (cwd: string | undefined) => permissionAuditEntryFromToolCall({
    toolName: "write_file", source: "builtin", category: "write", input: { path: "notes.txt" },
    permission: { decision: "deny", reason: "refused by rule", provenance: RULE_PROVENANCE },
    rateLimitRemaining: Infinity, trustOrigin: "plugin-emitted", cwd,
  });

  it("persists the cwd home-redacted, or unknown when none was resolved", () => {
    const home = join(homedir(), "alice-project");
    expect(deny(home)).toMatchObject({ decision: "deny", cwd: redactFsPath(home) });
    expect(JSON.stringify(deny(home))).not.toContain(homedir().replaceAll("\\", "\\\\"));
    expect(deny(undefined)).toMatchObject({ decision: "deny", cwd: "unknown" });
  });

  it("keeps both rows readable through the chain verifier", async () => {
    await audit.appendPermissionAuditEntry(deny(join(homedir(), "alice-project")));
    await audit.appendPermissionAuditEntry(deny(undefined));
    await audit.close();
    const reader = new AuditLogger(join(root, "audit"));
    await reader.setupPermissionAuditChain("aa".repeat(32));
    expect(reader.isPermissionAuditChainReady()).toBe(true);
    await reader.close();
    expect((await auditRows()).map(row => row.cwd)).toEqual([redactFsPath(join(homedir(), "alice-project")), "unknown"]);
  });
});
