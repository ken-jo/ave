import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
/** Foreground memory reuse requires a matching tuple and non-escalated verdict, records an audit hit, and never bypasses deny or forced-modal gates.
 * Revoked or legacy-null approvals re-prompt; headless calls remain outside this path. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWriteProbeTool } from "./approval-memory-test-fixtures.js";

// Store B lookup + audit sink; shaped per-test. vi.mock factories are hoisted above all imports, so the
// mock fns must be created via vi.hoisted (which runs even earlier) to be referenceable inside the factories.
const { lookupApprovalMock, lookupUserDecisionMock, emitSandboxAuditMock, state } = vi.hoisted(() => ({
  lookupApprovalMock: vi.fn(async (): Promise<unknown> => state.lookupResult),
  lookupUserDecisionMock: vi.fn(async (): Promise<unknown> => state.decisionResult),
  emitSandboxAuditMock: vi.fn(async () => {}),
  state: { lookupResult: null as unknown, decisionResult: null as unknown },
}));

vi.mock("../../permissions/user-approval-store.js", async () => {
  const actual: typeof import("../../permissions/user-approval-store.js") =
    await vi.importActual("../../permissions/user-approval-store.js");
  return {
    ...actual,
    lookupApproval: lookupApprovalMock,
    lookupUserDecision: lookupUserDecisionMock,
  };
});

vi.mock("../../audit/sandbox-audit-sink.js", async () => {
  const actual: typeof import("../../audit/sandbox-audit-sink.js") =
    await vi.importActual("../../audit/sandbox-audit-sink.js");
  return {
    ...actual,
    emitSandboxAudit: emitSandboxAuditMock,
  };
});

import { ToolExecutor } from "../executor.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { ToolRegistry } from "../registry.js";
import { permissionManagerReturning as pmReturning } from "./executor-reviewer-fixtures.js";
import { tryUserApprovalMemorySkip } from "../pipeline/approval-memory-skip.js";

describe("ToolExecutor — explicit-approval memory skips the foreground modal (Store B)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-memory-skip-"));
    state.lookupResult = null;
    state.decisionResult = null;
    lookupApprovalMock.mockClear();
    lookupUserDecisionMock.mockClear();
    emitSandboxAuditMock.mockClear();
  });

  it("(a) session approval → same tuple re-call skips the modal and audits memoryHit", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    // Normal foreground ask (layer 6); eligible for Store B skip.
    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });

    // Path is a direct LEAF of the allowed dir → rule verdict LOW. Stored verdict LOW → max(LOW, LOW) === LOW === stored → skip.
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-skip", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-skip",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Modal NOT shown; memory hit auto-allowed and the tool executed.
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBeUndefined();

    // Audit entry records the memory-hit provenance.
    expect(emitSandboxAuditMock).toHaveBeenCalled();
    const entry = emitSandboxAuditMock.mock.calls[0]?.[0] as unknown as {
      reviewer: {
        llmVerdict: string | null;
        userApprovalUsed: { memoryHit: boolean; verdictAtApproval: string | null } | null;
      };
      tool: { name: string };
    };
    expect(entry.tool.name).toBe("write_probe");
    expect(entry.reviewer.llmVerdict).toBeNull();
    expect(entry.reviewer.userApprovalUsed?.memoryHit).toBe(true);
    expect(entry.reviewer.userApprovalUsed?.verdictAtApproval).toBe("low");
  });

  it("an exact persistent deny blocks the matching tool and input before the approval dock", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));
    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });
    state.decisionResult = {
      decision: "deny",
      scope: "persistent",
      verdictAtApproval: "medium",
      nlJustification: null,
      revokedAt: null,
    };
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-exact-deny", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-exact-deny",
        // Deliberately do not allow the temp directory. The exact deny must block before the Layer-1 out-of-directory card can appear.
        permissionContext: userPermissionContext(),
      },
    );

    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(lookupUserDecisionMock).toHaveBeenCalledWith(
      "write_probe",
      expect.stringContaining("file.txt"),
      "builtin",
      "user-keyboard",
      undefined,
      process.cwd(),
      "sess-exact-deny",
    );
    expect(lookupApprovalMock).not.toHaveBeenCalled();
  });

  it("fails closed before any approval prompt when the exact-decision store cannot be read", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));
    const permMgr = pmReturning({ decision: "allow", reason: "ordinary allow", layer: 6 });
    lookupUserDecisionMock.mockRejectedValueOnce(new Error("decision store unreadable"));
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-decision-store-error", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-decision-store-error",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(lookupApprovalMock).not.toHaveBeenCalled();
  });

  it("a corrupt exact-decision store asks for non-read calls and leaves reads to the matrix (issue #28)", async () => {
    const { UserApprovalStoreCorruptError } = await import("../../permissions/user-approval-store.js");
    const { PermissionManager } = await import("../../permissions/permission-manager.js");
    const { createDynamicTool } = await import("../base.js");
    const writeSpy = vi.fn(async () => "wrote");
    const readSpy = vi.fn(async () => "read");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(writeSpy));
    registry.register(createDynamicTool({
      name: "read_probe", description: "read probe", source: "builtin", category: "read",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: String(await readSpy()), isError: false }),
    }));
    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.setMode("allow");
    const corrupt = new UserApprovalStoreCorruptError("/state/permissions/user-approvals.json", "invalid JSON");
    lookupUserDecisionMock.mockRejectedValue(corrupt);
    const requestAndWait = vi.fn(async (req: { id: string; reason?: string }) => ({ requestId: req.id, choice: "deny-once" as const }));
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, { requestAndWait } as never);
    try {
      const [write, read] = await executor.executeAll(
        [
          { id: "tu-corrupt-write", name: "write_probe", input: { path: join(dir, "file.txt") } },
          { id: "tu-corrupt-read", name: "read_probe", input: {} },
        ],
        { sessionId: "sess-corrupt-store", permissionContext: userPermissionContext({ additionalDirectories: [dir] }) },
      );
      // Write: asked (even in allow mode) with the file named; the user denied.
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(requestAndWait.mock.calls[0]![0].reason).toContain("user-approvals.json");
      expect(writeSpy).not.toHaveBeenCalled();
      expect(write!.is_error).toBe(true);
      // Read: not blocked by the corrupt store.
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(read!.is_error).toBeUndefined();
    } finally {
      lookupUserDecisionMock.mockReset();
      lookupUserDecisionMock.mockImplementation(async () => state.decisionResult);
    }
  });

  it("approval-memory audit persists the Host-owned governed projection", async () => {
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "high",
      nlJustification: null,
      revokedAt: null,
    };

    const result = await tryUserApprovalMemorySkip(
      "plugin_checkin_read",
      "plugin",
      "read",
      [],
      {
        operation: "status",
        opaqueSecret: "must-never-reach-audit",
      },
      process.cwd(),
      [],
      [],
      userPermissionContext({ trustOrigin: "plugin-emitted" }),
      undefined,
      {},
      undefined,
      undefined,
      "com.ave.checkin",
      undefined,
      { operation: "status" },
    );

    expect(result?.decision).toBe("allow");
    const entry = emitSandboxAuditMock.mock.calls.at(-1)?.[0] as unknown as
      | { tool: { args: string } }
      | undefined;
    expect(entry?.tool.args).toBe('{"operation":"status"}');
    expect(entry?.tool.args).not.toContain("must-never-reach-audit");
  });

  it("(a2) foreground-auto reviewer path checks Store B before reviewer dispatch", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({
      decision: "ask",
      reason: "foreground reviewer route",
      layer: 6,
      reviewer: { route: "foreground-auto" },
    });
    const classifySpy = vi.fn(() => ({ level: "high" as const, reason: "should not run" }));
    setReviewerForTest(permMgr, {
      classifier: { classify: classifySpy },
      cache: {} as never,
      deferredQueue: {} as never,
    });
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-foreground-auto-skip", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-foreground-auto-skip",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(result[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(classifySpy).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("(b) prior approval but args mutated to a higher rule verdict → re-prompt (maxVerdict)", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });

    // Stored LOW. Current path is DEEP inside the allowed dir → rule MEDIUM. max(MEDIUM, LOW) === MEDIUM !== stored LOW → escalation → re-prompt.
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-escalate", name: "write_probe", input: { path: join(dir, "nested", "deep", "file.txt") } }],
      {
        sessionId: "sess-escalate",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Modal IS shown (escalation); and we denied it, so the tool did not run.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result[0].is_error).toBe(true);
  });

  it("(c) revoked / absent approval (lookup null) → re-prompt", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });

    // lookupApproval returns null for revoked or missing entries.
    state.lookupResult = null;

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    await executor.executeAll(
      [{ id: "tu-revoked", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-revoked",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledTimes(1);
  });

  it("(d) legacy-null verdictAtApproval → re-prompt (fail-closed)", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Legacy entry; verdictAtApproval is null (provenance lost).
    state.lookupResult = {
      scope: "persistent",
      verdictAtApproval: null,
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    await executor.executeAll(
      [{ id: "tu-legacy-null", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-legacy-null",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Modal shown; legacy entry rejected. Stable structured marker emitted.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    const legacyCall = warnSpy.mock.calls.find((args: unknown[]) => {
      const marker = args[1];
      return (
        marker != null &&
        typeof marker === "object" &&
        (marker as { event?: unknown }).event === "legacy-null-verdict"
      );
    });
    expect(legacyCall).toBeDefined();
    warnSpy.mockRestore();
  });

  it("(e) deny rule + prior approval → deny wins, Store B never consulted", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    // Layer 1 deny rule.
    const permMgr = pmReturning({ decision: "deny", reason: "deny rule", layer: 1 });

    // A matching prior approval exists; it must be IGNORED.
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-deny", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-deny",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    // Store B must not even be queried for a deny decision.
    expect(lookupApprovalMock).not.toHaveBeenCalled();
  });

  it("(f) overlay-trigger mutating + prior approval → ask wins (layer 2 hard gate not skipped)", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    // Overlay-trigger mutating guard returns ask at layer 2 (hard gate).
    const permMgr = pmReturning({
      decision: "ask",
      reason: "overlay trigger mutating",
      layer: 2,
    });

    // A matching prior approval exists; it must NOT skip the hard-ask gate.
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-overlay", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-overlay",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Modal shown; layer 2 hard gate is never memory-skipped.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    // Store B must not be consulted for a layer <= 2 hard gate.
    expect(lookupApprovalMock).not.toHaveBeenCalled();
  });

  it("(g) headless path is unchanged — Store B is foreground-only", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    // Normal foreground-eligible ask (layer 6) but headless context.
    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });

    // A matching prior approval exists; headless must not read it.
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-headless", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-headless",
        permissionContext: userPermissionContext({ headless: true, trustOrigin: "llm-tool-arg" }),
      },
    );

    // Headless ask with no headless reviewer route → blocked, tool not run.
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    // Store B is foreground-only; never consulted on the headless path.
    expect(lookupApprovalMock).not.toHaveBeenCalled();
  });

  it("(h) plugin panel user action suppresses normal foreground plugin ask", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy, { source: "plugin", pluginId: "meeting" }));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-plugin-panel", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-plugin-panel",
        permissionContext: userPermissionContext({
          additionalDirectories: [dir],
          pluginPanelUserAction: true,
          trustOrigin: "plugin-emitted",
        }),
      },
    );

    expect(result[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(lookupApprovalMock).not.toHaveBeenCalled();
  });

  it("(h2) plugin panel user action does not suppress layer-2 hard asks", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy, { source: "plugin", pluginId: "meeting" }));

    const permMgr = pmReturning({ decision: "ask", reason: "hard gate", layer: 2 });
    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-plugin-panel-hard", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-plugin-panel-hard",
        permissionContext: userPermissionContext({
          additionalDirectories: [dir],
          pluginPanelUserAction: true,
          trustOrigin: "plugin-emitted",
        }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result[0].is_error).toBe(true);
  });

  it("(h3) plugin panel user action does not suppress forceModal asks", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy, { source: "plugin", pluginId: "meeting" }));

    const permMgr = pmReturning({
      decision: "ask",
      reason: "explicit per-invocation confirmation",
      layer: 6,
      forceModal: true,
    });
    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-plugin-panel-force", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-plugin-panel-force",
        permissionContext: userPermissionContext({
          additionalDirectories: [dir],
          pluginPanelUserAction: true,
          trustOrigin: "plugin-emitted",
        }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result[0].is_error).toBe(true);
  });

  // Drive real invocations and assert the consumer broadcast payload so remembered auto-approval remains visible to the renderer.

  it("(i) foreground memory skip broadcasts the user-approval hit to the renderer", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });
    // The real renderer seam.
    const broadcast = vi.fn();
    permMgr.setBroadcastUserApprovalHit(broadcast);

    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-disclose", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-disclose",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Precondition: this really was a silent memory skip, not a modal.
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBeUndefined();

    // The disclosure the user actually sees.
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      toolName: "write_probe",
      scope: "session",
      verdictAtApproval: "low",
    });
  });

  it("(i2) carries the persistent scope through to the renderer payload", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });
    const broadcast = vi.fn();
    permMgr.setBroadcastUserApprovalHit(broadcast);

    state.lookupResult = {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait: vi.fn() } as never,
    );

    await executor.executeAll(
      [{ id: "tu-disclose-p", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-disclose-p",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "persistent", verdictAtApproval: "low" }),
    );
  });

  it("(i3) does NOT disclose when the memory skip is refused (legacy-null → re-prompt)", async () => {
    // Negative control: the broadcast must track the actual auto-approve, not merely the presence of a stored entry.
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });
    const broadcast = vi.fn();
    permMgr.setBroadcastUserApprovalHit(broadcast);

    state.lookupResult = {
      scope: "session",
      verdictAtApproval: null,
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    await executor.executeAll(
      [{ id: "tu-disclose-legacy", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-disclose-legacy",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(broadcast).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    await cleanupTmpDir(dir);
  });
});
