import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { answeredApprovalDecision } from "../../__tests__/support/answering-approval-gate.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import type { ApprovalGate, ApprovalRequestInput } from "../../permissions/approval-gate.js";
import type { PluginRuntimeGenerationAccess } from "../../plugins/plugin-host-generation.js";
import type { HostPluginAuthLifecycle } from "../executor-contract.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/influence-command.cjs");
const TOOL = "denial_probe";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTmpDir(root); });

type Source =
  | "rule" | "unknown-tool" | "human" | "hook-mutation" | "host" | "integrity" | "plugin-generation"
  | "user-abort" | "host-shutdown" | "deadline" | "mid-execution" | "plugin-generation-shutdown"
  | "governed-operation" | "governed-auth";

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
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({ name: TOOL, description: "Performs a bounded operation",
    ...(generation || governed
      ? { source: "plugin" as const, pluginId: "probe-plugin", pluginGeneration: { pluginId: "probe-plugin", generationId: "gen-1" } }
      : { source: "builtin" as const }),
    ...(governed ? { operationPolicy: { discriminant: "operation", operations: { status: { kind: "read" as const, minimumRisk: "read" as const } } } } : {}),
    category: "write", isReadOnly: () => false,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      started();
      if (holds) await held;
      return { output: "completed", isError: false };
    } }));
  const permissions = new PermissionManager(join(root, "permissions.json"));
  if (source === "rule" || source === "governed-operation" || source === "governed-auth") permissions.setRules([{ pattern: TOOL, action: "deny" }]);
  if (source === "human" || source === "host" || source === "integrity") permissions.setRules([{ pattern: TOOL, action: "ask" }]);
  if (holds || generation || source === "host-shutdown") permissions.setRules([{ pattern: TOOL, action: "allow" }]);
  const hooks = new ScriptHookManager();
  if (source === "hook-mutation") {
    const entries = parseHookConfig({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["node", COMMAND, "loop"] }] }] } }).entries;
    bindHookConfigPaths(entries, dirname(COMMAND));
    hooks.setTrustedRegistry([], entries);
  }
  const lifecycle = vi.spyOn(hooks, "runLifecycleEvent");
  // human: the desk denies this call; host: an allow settled for another call; integrity: a deny settled for another call.
  const requestAndWait = vi.fn(async (request: ApprovalRequestInput) => answeredApprovalDecision(
    { requestId: request.id, choice: source === "host" ? "allow-once" : "deny-once" }, "desk", request.toolName,
    source === "human" ? request.invocationToolUseId : "another-call"));
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
  const executor = new ToolExecutor(registry, undefined, permissions, undefined, { requestAndWait } as unknown as ApprovalGate, hooks, audit,
    undefined, undefined, undefined, () => access);
  const authLifecycle = { binding: { pluginId: "probe-plugin", generationId: "gen-1", toolName: TOOL, appSessionId: "app", accountScopeHash: "hash" },
    beforeHandler: () => {}, completeSuccess: () => {}, completeFailure: () => {} } satisfies HostPluginAuthLifecycle;
  const controller = new AbortController();
  const ids = source === "user-abort" ? ["held-call", "denied-call"] : ["denied-call"];
  const run = () => executor.executeAll(ids.map((id) => ({ id, name: source === "unknown-tool" ? "missing_probe" : TOOL,
    input: governed ? { operation: "status" } : {} })), {
    sessionId: "denial-session", executionCwd: root, permissionContext: userPermissionContext(), abortSignal: controller.signal,
    ...(source === "governed-auth" ? { pluginAuthLifecycle: authLifecycle } : {}),
  });
  const allRows = () => readFileSync(audit.getPermissionAuditLogFile(), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.decision !== "ask");
  const rows = (id = "denied-call") => allRows().filter((row) => row.toolUseId === id);
  const denials = () => lifecycle.mock.calls.filter(([event]) => event === "PermissionDenied");
  return { ledger, audit, run, rows, denials, running, release, controller };
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
  expect(row).toMatchObject({ decision: "deny" });
  expect(firstReason(row)).toMatch(reason);
  expect(probe.denials()).toEqual([["PermissionDenied", "denial-session", "user-keyboard",
    expect.objectContaining({ toolName: expect.stringMatching(/_probe$/), denyReason: expect.objectContaining({ source: "tool-executor" }) }), expect.anything()]]);
}

async function expectNoDenial(probe: Probe, reason: string | RegExp): Promise<void> {
  const row = await settledRow(probe);
  expect(row).toMatchObject({ decision: "deny" });
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
    await probe.audit.close();
  }
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
});
