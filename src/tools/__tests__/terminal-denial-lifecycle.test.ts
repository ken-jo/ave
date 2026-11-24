import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalDenyKindOf } from "../../audit/audit-schema.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { answeredApprovalDecision } from "../../__tests__/support/answering-approval-gate.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import type { ApprovalGate, ApprovalRequest, ApprovalRequestInput } from "../../permissions/approval-gate.js";
import type { PluginRuntimeGenerationAccess } from "../../plugins/plugin-host-generation.js";
import type { HostPluginAuthLifecycle } from "../executor-contract.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/influence-command.cjs");
const TOOL = "denial_probe";
const SHELL_COMMAND = "printf lock-probe";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTmpDir(root); });

type Source =
  | "rule" | "unknown-tool" | "human" | "hook-mutation" | "host" | "integrity" | "plugin-generation"
  | "user-abort" | "host-shutdown" | "deadline" | "mid-execution" | "plugin-generation-shutdown"
  | "card-quit" | "card-abort" | "card-deny-then-abort" | "governed-operation" | "governed-auth"
  | "dir-hook-abort" | "dir-hook-inherited-abort" | "shell-prep-abort"
  | "human-then-abort" | "human-then-quit" | "headless-then-abort";

/** Each probe loads a fresh module graph, so a sealed or drained ledger never leaks into another case. */
async function setup(source: Source) {
  vi.resetModules();
  const ledger = await import("../invocation-ledger.js");
  const { ToolExecutor } = await import("../executor.js");
  const { ToolRegistry } = await import("../registry.js");
  const { createDynamicTool } = await import("../base.js");
  const { PermissionManager } = await import("../../permissions/permission-manager.js");
  const { ScriptHookManager } = await import("../../hooks/script-hook-manager.js");
  const { parseHookConfig } = await import("../../hooks/hook-config.js");
  const { bindHookConfigPaths } = await import("../../hooks/hook-config-trust.js");
  const { AuditLogger } = await import("../../audit/audit-logger.js");
  const { ApprovalGate, IPC_APPROVAL_REQUEST } = await import("../../permissions/approval-gate.js");
  const { t } = await import("../../i18n/index.js");
  const root = mkdtempSync(join(tmpdir(), "ave-denial-lock-"));
  roots.push(root);
  const audit = new AuditLogger(join(root, "audit"));
  await audit.setupPermissionAuditChain("ef".repeat(32));
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let started!: () => void;
  const running = new Promise<void>((done) => { started = done; });
  const holds = source === "deadline" || source === "mid-execution" || source === "user-abort";
  const generation = source === "plugin-generation" || source === "plugin-generation-shutdown";
  const governed = source === "governed-operation";
  const dirHook = source === "dir-hook-abort" || source === "dir-hook-inherited-abort";
  const humanThen = source === "human-then-abort" || source === "human-then-quit";
  const headlessThen = source === "headless-then-abort";
  const liveCard = source === "card-quit" || source === "card-abort" || source === "card-deny-then-abort";
  const outside = mkdtempSync(join(tmpdir(), "ave-denial-outside-"));
  roots.push(outside);
  const registry = new ToolRegistry();
  if (source === "shell-prep-abort") {
    const { BashTool } = await import("../shell-tools.js");
    registry.register(new BashTool());
  }
  registry.register(createDynamicTool({ name: TOOL, description: "Performs a bounded operation",
    ...(dirHook ? { pathFields: ["path"] } : {}),
    ...(generation || governed
      ? { source: "plugin" as const, pluginId: "probe-plugin", pluginGeneration: { pluginId: "probe-plugin", generationId: "gen-1" } }
      : { source: "builtin" as const }),
    ...(governed ? { operationPolicy: { discriminant: "operation", operations: { status: { kind: "read" as const, minimumRisk: "read" as const } } } } : {}),
    category: "write", isReadOnly: () => false,
    jsonSchema: { type: "object", properties: dirHook ? { path: { type: "string" } } : {} },
    execute: async () => {
      started();
      if (holds) await held;
      return { output: "completed", isError: false };
    } }));
  const permissions = new PermissionManager(join(root, "permissions.json"));
  if (source === "rule" || source === "governed-operation" || source === "governed-auth") permissions.setRules([{ pattern: TOOL, action: "deny" }]);
  if (source === "human" || source === "host" || source === "integrity" || liveCard || humanThen || headlessThen) {
    permissions.setRules([{ pattern: TOOL, action: "ask" }]);
  }
  if (holds || generation || source === "host-shutdown") permissions.setRules([{ pattern: TOOL, action: "allow" }]);
  if (source === "shell-prep-abort") permissions.setRules([{ pattern: `Bash(${SHELL_COMMAND})`, action: "allow" }]);
  const controller = new AbortController();
  const inherited = new AbortController();
  // shell-prep-abort: the Stop lands during the exact Settings lookup (invocation-runner.ts lookupUserDecision), the last
  // await before the real shell preparation with no abort re-check between them.
  if (source === "shell-prep-abort") {
    const approvals = await import("../../permissions/user-approval-store.js");
    const lookup = approvals.lookupUserDecision;
    vi.spyOn(approvals, "lookupUserDecision").mockImplementation(async (...args) => {
      const decision = await lookup(...args);
      controller.abort();
      return decision;
    });
  }
  // human-then-*: the person's deny-always is accepted, and the Stop or the quit lands while its rule saves.
  let persisted!: () => void;
  const persisting = new Promise<void>((done) => { persisted = done; });
  let saving!: () => void;
  const saveStarted = new Promise<void>((done) => { saving = done; });
  if (humanThen) {
    vi.spyOn(permissions, "addAlwaysDeniedPersist").mockImplementation(async () => {
      saving();
      if (source === "human-then-abort") controller.abort();
      else await persisting;
    });
  }
  const hooks = new ScriptHookManager();
  // dir-hook-abort: the Stop lands during the folder card's PermissionRequest hook, so it returns the cancelled deny.
  if (dirHook) {
    vi.spyOn(hooks, "runPermissionRequest").mockImplementation(async () => {
      (source === "dir-hook-inherited-abort" ? inherited : controller).abort();
      return new Promise(() => {});
    });
  }
  if (source === "hook-mutation") {
    const entries = parseHookConfig({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["node", COMMAND, "loop"] }] }] } }).entries;
    bindHookConfigPaths(entries, dirname(COMMAND));
    hooks.setTrustedRegistry([], entries);
  }
  const lifecycle = vi.spyOn(hooks, "runLifecycleEvent");
  // human: the desk denies this call; host: an allow settled for another call; integrity: a deny settled for another call.
  const requestAndWait = vi.fn(async (request: ApprovalRequestInput) => answeredApprovalDecision(
    { requestId: request.id, choice: source === "host" ? "allow-once" : humanThen ? "deny-always" : "deny-once" },
    headlessThen ? "headless-exec" : "desk", request.toolName,
    source === "human" || humanThen || headlessThen ? request.invocationToolUseId : "another-call"));
  const lease = { generation: { generationId: "gen-1", state: { runtime: {} } }, release: () => {} };
  const access = {
    getActive: () => undefined,
    isExactAdmitted: () => false,
    acquire: async () => lease,
    acquireExact: async () => {
      if (source === "plugin-generation-shutdown") throw Object.assign(new Error("plugin runtime is shutting down"), { code: "plugin-runtime-shutdown" });
      if (source === "plugin-generation") throw new Error("generation gen-1 is retired");
      return lease;
    },
    runWithLease: async <T>(_lease: unknown, operation: () => Promise<T>) => operation(),
  } as unknown as PluginRuntimeGenerationAccess;
  let cardShown!: (card: ApprovalRequest) => void;
  const cardOpen = new Promise<ApprovalRequest>((done) => { cardShown = done; });
  const realGate = new ApprovalGate({ isDestroyed: () => false,
    send: (channel: string, card: ApprovalRequest) => { if (channel === IPC_APPROVAL_REQUEST) cardShown(card); } } as never);
  const gate = liveCard ? realGate : { requestAndWait } as unknown as ApprovalGate;
  const executor = new ToolExecutor(registry, undefined, permissions, undefined, gate, hooks, audit,
    undefined, undefined, undefined, () => access);
  const authLifecycle = { binding: { pluginId: "probe-plugin", generationId: "gen-1", toolName: TOOL, appSessionId: "app", accountScopeHash: "hash" },
    beforeHandler: () => {}, completeSuccess: () => {}, completeFailure: () => {} } satisfies HostPluginAuthLifecycle;
  const ids = source === "user-abort" ? ["held-call", "denied-call"] : ["denied-call"];
  const input = governed ? { operation: "status" }
    : dirHook ? { path: join(outside, "file.txt") }
    : source === "shell-prep-abort" ? { command: SHELL_COMMAND, executionMode: "host", justification: "Print the lock fixture" }
    : {};
  const name = source === "unknown-tool" ? "missing_probe" : source === "shell-prep-abort" ? "bash" : TOOL;
  const { turnExtensionPolicyContext } = await import("../../shared/turn-extension-policy.js");
  const execute = () => executor.executeAll(ids.map((id) => ({ id, name, input })), {
    sessionId: "denial-session", executionCwd: root, permissionContext: userPermissionContext(dirHook ? { trustOrigin: "llm-tool-arg" } : {}), abortSignal: controller.signal,
    ...(headlessThen ? { callbacks: { onToolEnd: () => { controller.abort(); } } } : {}),
    ...(source === "governed-auth" ? { pluginAuthLifecycle: authLifecycle } : {}),
  });
  const run = () => source === "dir-hook-inherited-abort"
    ? turnExtensionPolicyContext.run({ allowExternalHooks: true, abortSignal: inherited.signal }, execute)
    : execute();
  const allRows = () => readFileSync(audit.getPermissionAuditLogFile(), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.decision !== "ask");
  const rows = (id = "denied-call") => allRows().filter((row) => row.toolUseId === id);
  const denials = () => lifecycle.mock.calls.filter(([event]) => event === "PermissionDenied");
  const cancelledMessage = t("be_executor.toolExecutionCancelled");
  return { ledger, audit, root, permissions, run, rows, denials, running, release, controller, inherited, cardOpen, gate: realGate, saveStarted, persisted, source, cancelledMessage };
}

type Probe = Awaited<ReturnType<typeof setup>>;

function firstReason(row: Record<string, unknown> | undefined): string | undefined {
  return (row?.denyReasons as Array<{ reason: string }> | undefined)?.[0]?.reason;
}

async function settledRow(probe: Probe, id = "denied-call"): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(probe.rows(id)).toHaveLength(1));
  await new Promise<void>((done) => setImmediate(done));
  expect(probe.rows(id)).toHaveLength(1);
  return probe.rows(id)[0] as Record<string, unknown>;
}

async function expectOneDenial(probe: Probe, reason: string | RegExp): Promise<void> {
  const row = await settledRow(probe);
  await vi.waitFor(() => expect(probe.denials()).toHaveLength(1));
  expect(row).toMatchObject({ decision: "deny", terminalKind: "denied" });
  expect(terminalDenyKindOf(row as never)).toBe("denied");
  expect(firstReason(row)).toMatch(reason);
  expect(probe.denials()).toEqual([["PermissionDenied", "denial-session", "user-keyboard",
    expect.objectContaining({ toolName: expect.stringMatching(/_probe$/), denyReason: expect.objectContaining({ source: "tool-executor" }) }), expect.anything()]]);
}

async function expectNoDenial(probe: Probe, reason: string | RegExp): Promise<void> {
  const row = await settledRow(probe);
  expect(row).toMatchObject({ decision: "deny", terminalKind: governedCase(probe) ? "denied" : "cancelled" });
  expect(terminalDenyKindOf(row as never)).toBe(governedCase(probe) ? "denied" : "cancelled");
  expect(firstReason(row)).toMatch(reason);
  await new Promise<void>((done) => setImmediate(done));
  expect(probe.denials()).toEqual([]);
}

async function run(source: Source, check: (probe: Probe) => Promise<void>): Promise<void> {
  const probe = await setup(source);
  try {
    await probe.run().catch(() => undefined);
    await check(probe);
  } finally {
    probe.release();
    probe.persisted();
    await probe.audit.close();
  }
}

function governedCase(probe: Probe): boolean {
  return probe.source === "governed-operation" || probe.source === "governed-auth";
}

function reasons(row: Record<string, unknown>): string[] {
  return (row.denyReasons as Array<{ reason: string }>).map((entry) => entry.reason);
}

describe("a permission denial fires one PermissionDenied; a cancellation and a governed deny fire none", () => {
  it.each([
    ["rule", TOOL],
    ["unknown-tool", "tool not found"],
    ["human", "user denied approval request"],
    ["hook-mutation", "Hook input mutation could not safely restart permission classification"],
    ["host", /^the invocation failed: approval: the answer to .* does not settle this allow of denial_probe$/],
    ["integrity", /^the terminal row failed its integrity check: approval: the answer to .* does not settle this deny of denial_probe$/],
    ["plugin-generation", "Plugin generation admission denied: generation gen-1 is retired"],
  ] as const)("deny source %s: one row, one event", async (source, reason) => {
    await run(source, (probe) => expectOneDenial(probe, reason));
  });

  it("cancels a directory hook when only the inherited signal stops", async () => {
    await run("dir-hook-inherited-abort", async (probe) => {
      expect(probe.inherited.signal.aborted).toBe(true);
      expect(probe.controller.signal.aborted).toBe(false);
      await expectNoDenial(probe, "user aborted turn");
      expect(reasons(await settledRow(probe))[1]).toBe("Hook execution cancelled");
    });
  });

  it.each([
    ["governed-operation", "host-derived operation identity is missing"],
    ["governed-auth", "the invocation failed: host plugin auth lifecycle does not match the admitted governed Tool"],
  ] as const)("governed %s: one deny row, no event", async (source, reason) => {
    await run(source, (probe) => expectNoDenial(probe, reason));
  });

  it("plugin generation admission ended by runtime shutdown: one row, no event", async () => {
    await run("plugin-generation-shutdown", (probe) => expectNoDenial(probe, "Plugin generation admission denied: plugin runtime is shutting down"));
  });

  it("user abort: the queued call's refusal and the running call's allow fire no event", async () => {
    const probe = await setup("user-abort");
    try {
      const result = probe.run().catch(() => undefined);
      await probe.running;
      probe.controller.abort();
      await result;
      await expectNoDenial(probe, "user aborted turn");
      expect(await settledRow(probe, "held-call")).toMatchObject({ decision: "allow" });
      expect(probe.denials()).toEqual([]);
    } finally {
      probe.release();
      await probe.audit.close();
    }
  });

  it("host shutdown: a call arriving after the seal is refused with no event", async () => {
    const probe = await setup("host-shutdown");
    try {
      probe.ledger.sealToolInvocations();
      const result = probe.run().catch(() => undefined);
      const join = probe.ledger.closeToolInvocationAudit(async () => {});
      await result;
      await join;
      await expectNoDenial(probe, "host-shutdown");
    } finally {
      await probe.audit.close();
    }
  });

  it("mid-execution host shutdown: the allowed call's host-shutdown deny fires no event", async () => {
    const probe = await setup("mid-execution");
    try {
      const result = probe.run().catch(() => undefined);
      await probe.running;
      probe.ledger.sealToolInvocations();
      const join = probe.ledger.closeToolInvocationAudit(async () => {});
      await result;
      await join;
      await expectNoDenial(probe, "host-shutdown");
    } finally {
      probe.release();
      await probe.audit.close();
    }
  });

  it.each([
    ["card-quit", "host-shutdown"],
    ["card-abort", "user aborted turn"],
  ] as const)("%s: a call whose approval card the stop ends fires no event", async (source, reason) => {
    const probe = await setup(source);
    try {
      const result = probe.run().catch(() => undefined);
      await probe.cardOpen;
      if (source === "card-quit") {
        probe.ledger.sealToolInvocations();
        probe.gate.disposeAll();
      } else {
        probe.controller.abort();
      }
      await result;
      await expectNoDenial(probe, reason);
    } finally {
      await probe.audit.close();
    }
  });

  it("keeps a bound human Deny when Stop fires before the runner resumes", async () => {
    const probe = await setup("card-deny-then-abort");
    try {
      const result = probe.run();
      const card = await probe.cardOpen;
      const decision = probe.gate.resolve(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac });
      probe.controller.abort();
      expect(decision).toMatchObject({ choice: "deny-once" });
      await result;
      await expectOneDenial(probe, "user denied approval request");
    } finally {
      await probe.audit.close();
    }
  });

  it("deadline drain: the parked call's host-shutdown row fires no event, before or after its late return", async () => {
    const probe = await setup("deadline");
    try {
      const result = probe.run().catch(() => undefined);
      await probe.running;
      expect(await probe.ledger.drainToolInvocationAuditForExit(() => probe.audit.close(), 5_000)).toBe("committed");
      await expectNoDenial(probe, "host-shutdown");
      probe.release();
      await result;
      await new Promise<void>((done) => setImmediate(done));
      expect(probe.rows()).toHaveLength(1);
      expect(probe.denials()).toEqual([]);
    } finally {
      probe.release();
      await probe.audit.close();
    }
  });
  it.each([
    ["dir-hook-abort", /^Hook execution cancelled$/],
    ["shell-prep-abort", /^Shell preparation failed: /],
  ] as const)("%s: a deny committed after the Stop is a cancellation with no event", async (source, original) => {
    await run(source, async (probe) => {
      expect(probe.controller.signal.aborted).toBe(true);
      await expectNoDenial(probe, "user aborted turn");
      expect(reasons(await settledRow(probe))[1]).toMatch(original);
    });
  });

  it("a person's settled deny stays a denial when the Stop lands before its row", async () => {
    await run("human-then-abort", async (probe) => {
      expect(probe.controller.signal.aborted).toBe(true);
      await expectOneDenial(probe, "user denied approval request");
    });
  });

  it("an automatic headless refusal committed after Stop is cancelled without an event", async () => {
    await run("headless-then-abort", async (probe) => {
      expect(probe.controller.signal.aborted).toBe(true);
      await expectNoDenial(probe, "user aborted turn");
      expect(reasons(await settledRow(probe))[1]).toBe("user denied approval request");
    });
  });

  it("logs the committed cancellation in the general tool audit", async () => {
    const probe = await setup("dir-hook-abort");
    const auditLog = vi.spyOn(probe.audit, "log");
    try {
      await probe.run();
      expect(auditLog.mock.calls.filter(([entry]) => entry.type === "tool_call")).toEqual([[expect.objectContaining({
        output: probe.cancelledMessage,
        toolCalls: [expect.objectContaining({ permissionDecision: "cancelled", permissionReason: "Hook execution cancelled" })],
      })]]);
    } finally {
      await probe.audit.close();
    }
  });

  it("returns a cancellation result when the ledger downgrades the writer's denial", async () => {
    const probe = await setup("shell-prep-abort");
    try {
      const [result] = await probe.run();
      expect(result).toMatchObject({ is_error: true, content: expect.stringContaining(probe.cancelledMessage) });
    } finally {
      await probe.audit.close();
    }
  });

  it.each(["dir-hook-abort", "plugin-generation-shutdown"] as const)("excludes %s from recently denied history", async (source) => {
    const probe = await setup(source);
    const history = makeRecentlyDeniedStore(join(probe.root, "recently-denied.json"));
    vi.spyOn(probe.permissions, "getRecentlyDenied").mockReturnValue(history);
    try {
      await probe.run();
      expect(await history.list()).toEqual([]);
    } finally {
      await probe.audit.close();
    }
  });

  it("the host's row for a quit after a person's deny keeps it a denial with one event", async () => {
    const probe = await setup("human-then-quit");
    try {
      const result = probe.run().catch(() => undefined);
      await probe.saveStarted;
      probe.ledger.sealToolInvocations();
      expect(await probe.ledger.drainToolInvocationAuditForExit(() => probe.audit.close(), 5_000)).toBe("committed");
      await expectOneDenial(probe, "user denied approval request");
      probe.persisted();
      await result;
      await new Promise<void>((done) => setImmediate(done));
      expect(probe.rows()).toHaveLength(1);
      expect(probe.denials()).toHaveLength(1);
    } finally {
      probe.persisted();
      await probe.audit.close();
    }
  });
});

describe("an audit reader reads the kind of a deny row", () => {
  it("prefers the persisted kind, so one reason can be either kind", () => {
    const reason = [{ reason: "Plugin generation admission denied: plugin runtime is shutting down", source: "tool-executor" }];
    expect(terminalDenyKindOf({ denyReasons: reason, terminalKind: "denied" })).toBe("denied");
    expect(terminalDenyKindOf({ denyReasons: reason, terminalKind: "cancelled" })).toBe("cancelled");
  });

  it.each([
    ["user aborted turn", "cancelled"],
    ["host-shutdown", "cancelled"],
    ["Hook execution cancelled", "cancelled"],
    ["Plugin generation admission denied: plugin runtime is shutting down", "cancelled"],
    [TOOL, "denied"],
    ["tool not found", "denied"],
    ["user denied approval request", "denied"],
    ["Hook input mutation could not safely restart permission classification", "denied"],
    ["the invocation failed: boom", "denied"],
    ["the terminal row failed its integrity check: boom", "denied"],
    ["Plugin generation admission denied: generation gen-1 is retired", "denied"],
    ["approval request expired", "denied"],
    ["approval rejected by host", "denied"],
    ["host-derived operation identity is missing", "denied"],
  ] as const)("a row written before the kind was persisted, first reason %s, reads as %s", (reason, kind) => {
    expect(terminalDenyKindOf({ denyReasons: [{ reason, source: "tool-executor" }] })).toBe(kind);
  });
});
