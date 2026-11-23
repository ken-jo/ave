import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answeredApprovalDecision, answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { answeredApprovalProvenance, answeredProvenanceRecord, isAnsweredApprovalDenial, provenanceTrustOrigin, type AnsweredProvenance, type ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ToolExecutor } from "../executor.js";
import { WriteFileTool } from "../file-tools.js";
import { ToolRegistry } from "../registry.js";
import { permissionAuditEntryFromToolCall } from "../pipeline/audit-entries.js";
import { RULE_PROVENANCE } from "../../permissions/decision-provenance.js";

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
      .toEqual({ decision: "allow", answerer: "desk", trustOrigin: "user-keyboard" });
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
    decision.choice = "allow-once";
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
  const ledger = async (toolUseId: string) => (await auditRows()).filter(row => row.toolUseId === toolUseId && row.decision !== "ask");

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
    const requestAndWait = vi.fn(async (request: ApprovalRequestInput) => {
      if (request.kind === "out-of-allowed-dir") throw new Error("approval surface crashed");
      return { requestId: request.id, choice: "allow-once" as const };
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
