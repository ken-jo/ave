import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import type { PluginRuntimeGenerationAccess } from "../../plugins/plugin-host-generation.js";

const roots: string[] = [];
const loggers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const logger of loggers.splice(0)) await logger.close();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

/** Each call loads a fresh module graph, so a sealed ledger never leaks into another test. */
async function freshExecutor(toolCount: number, metaToolNames: string[] = [], generationAccess?: PluginRuntimeGenerationAccess) {
  vi.resetModules();
  const ledger = await import("../invocation-ledger.js");
  const { ToolExecutor } = await import("../executor.js");
  const { ToolRegistry } = await import("../registry.js");
  const { createDynamicTool } = await import("../base.js");
  const { PermissionManager } = await import("../../permissions/permission-manager.js");
  const { AuditLogger } = await import("../../audit/audit-logger.js");
  const { t } = await import("../../i18n/index.js");
  const { ScriptHookManager } = await import("../../hooks/script-hook-manager.js");
  const root = mkdtempSync(join(tmpdir(), "ave-executor-shutdown-"));
  roots.push(root);
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.checkDetailed = () => ({ decision: "allow", reason: "shutdown admission probe" });
  const audit = new AuditLogger(join(root, "audit"));
  loggers.push(audit);
  await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
  const executes = Array.from({ length: toolCount }, (_, index) => vi.fn(async () => `done ${index}`));
  const registry = new ToolRegistry();
  for (const [index, execute] of executes.entries()) {
    registry.register(createDynamicTool({
      name: `queued_probe_${index}`,
      description: "Shutdown admission probe",
      ...(generationAccess
        ? { source: "plugin" as const, pluginId: "probe-plugin", pluginGeneration: { pluginId: "probe-plugin", generationId: "gen-1" } }
        : { source: "builtin" as const }),
      category: "write",
      isReadOnly: () => false,
      jsonSchema: { type: "object", properties: { value: { type: "string" } } },
      execute: async () => ({ output: String(await execute()), isError: false }),
    }));
  }
  for (const name of metaToolNames) {
    registry.register(createDynamicTool({
      name,
      description: "Intercepted meta tool probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "unintercepted", isError: false }),
    }));
  }
  const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, generationAccess && new ScriptHookManager(), audit, undefined, undefined, undefined, generationAccess && (() => generationAccess));
  const rows = (): Array<Record<string, unknown>> => {
    const file = audit.getPermissionAuditLogFile();
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const hostShutdownRows = (all: Array<Record<string, unknown>>, toolUseId: string) => all.filter((row) =>
    row.toolUseId === toolUseId && row.decision === "deny" && JSON.stringify(row.denyReasons ?? []).includes("host-shutdown"));
  const toolUses = executes.map((_, index) => ({ id: `tu-queued-${index}`, name: `queued_probe_${index}`, input: { value: String(index) } }));
  const cancelled = t("be_executor.toolExecutionCancelled");
  return { ledger, executor, executes, audit, rows, hostShutdownRows, toolUses, cancelled };
}

describe("ToolExecutor admission across the quit seal", () => {
  it("writes one host-shutdown deny row before close for a tool arriving between seal and close", async () => {
    const { ledger, executor, executes, audit, rows, hostShutdownRows, toolUses } = await freshExecutor(1);
    ledger.sealToolInvocations();
    const running = executor.executeAll(toolUses, { sessionId: "sess-seal-open", permissionContext: userPermissionContext() });
    let rowsAtClose: Array<Record<string, unknown>> = [];
    const join = ledger.closeToolInvocationAudit(async () => { rowsAtClose = rows(); await audit.close(); });
    const [result] = await running;
    await expect(join).resolves.toBe(1);
    expect(result.is_error).toBe(true);
    expect(executes[0]).not.toHaveBeenCalled();
    expect(hostShutdownRows(rowsAtClose, "tu-queued-0")).toHaveLength(1);
    expect(hostShutdownRows(rows(), "tu-queued-0")).toHaveLength(1);
  });

  it.each(["executeAll", "executeConversationBatch"] as const)(
    "writes the host-shutdown row before close for a queued tool while the previous result waits on the journal (%s)",
    async (path) => {
      const { ledger, executor, executes, audit, rows, hostShutdownRows, toolUses, cancelled } = await freshExecutor(2);
      let firstDelivered!: () => void;
      const delivered = new Promise<void>((resolve) => { firstDelivered = resolve; });
      let releaseJournal!: () => void;
      const journal = new Promise<void>((resolve) => { releaseJournal = resolve; });
      const resultIds: string[] = [];
      const options = {
        sessionId: "sess-queued-row",
        permissionContext: userPermissionContext(),
        onToolResult: async (result: { tool_use_id: string }) => {
          resultIds.push(result.tool_use_id);
          if (result.tool_use_id === "tu-queued-0") { firstDelivered(); await journal; }
        },
      };
      const running = path === "executeAll"
        ? executor.executeAll(toolUses, options)
        : executor.executeConversationBatch(toolUses, { ...options, executionCwd: process.cwd(), interceptedMetaToolHandler: async () => null })
          .then((outcome) => (outcome.outcome === "completed" ? outcome.results : []));
      await delivered;
      let rowsAtClose: Array<Record<string, unknown>> = [];
      ledger.sealToolInvocations();
      const join = ledger.closeToolInvocationAudit(async () => { rowsAtClose = rows(); await audit.close(); });
      let results: Awaited<typeof running>;
      try {
        // The join does not wait on the journal.
        await expect(join).resolves.toBe(1);
      } finally {
        releaseJournal();
        results = await running;
      }
      expect(hostShutdownRows(rowsAtClose, "tu-queued-1")).toHaveLength(1);
      expect(hostShutdownRows(rows(), "tu-queued-1")).toHaveLength(1);
      expect(executes[1]).not.toHaveBeenCalled();
      expect(results.map((result) => [result.tool_use_id, result.is_error === true])).toEqual([
        ["tu-queued-0", false],
        ["tu-queued-1", true],
      ]);
      expect(results[1].content).toBe(cancelled);
      expect(resultIds).toEqual(["tu-queued-0", "tu-queued-1"]);
      expect(ledger.pendingToolInvocationCount()).toBe(0);
    },
  );

  it.each(["executeAll", "executeConversationBatch"] as const)(
    "leaves the queued tools of a batch that already exited out of the seal (%s)",
    async (path) => {
      const { ledger, executor, executes, rows, hostShutdownRows, toolUses } = await freshExecutor(2);
      const options = {
        sessionId: "sess-exited",
        permissionContext: userPermissionContext(),
        onToolResult: async () => { throw new Error("journal write failed"); },
      };
      const exited = path === "executeAll"
        ? executor.executeAll(toolUses, options)
        : executor.executeConversationBatch(toolUses, { ...options, executionCwd: process.cwd(), interceptedMetaToolHandler: async () => null });
      await expect(exited).rejects.toThrow("journal write failed");
      ledger.sealToolInvocations();
      await expect(ledger.closeToolInvocationAudit(async () => {})).resolves.toBe(0);
      expect(executes[1]).not.toHaveBeenCalled();
      expect(hostShutdownRows(rows(), "tu-queued-1")).toHaveLength(0);
    },
  );

  it("does not hand an intercepted meta tool to its handler after the seal", async () => {
    const { ledger, executor, cancelled } = await freshExecutor(0, ["request_plugin"]);
    const activated: string[] = [];
    const handler = vi.fn(async (toolUse: { id: string; name: string }) => {
      activated.push(toolUse.name);
      return { tool_use_id: toolUse.id, content: "activated", durationMs: 0 };
    });
    ledger.sealToolInvocations();
    const delivered: string[] = [];
    const outcome = await executor.executeConversationBatch(
      [{ id: "tu-meta", name: "request_plugin", input: {} }],
      {
        sessionId: "sess-meta",
        executionCwd: process.cwd(),
        permissionContext: userPermissionContext(),
        interceptedMetaToolHandler: handler,
        onToolResult: async (result) => { delivered.push(result.tool_use_id); },
      },
    );
    expect(handler).not.toHaveBeenCalled();
    expect(activated).toEqual([]);
    expect(outcome).toMatchObject({
      outcome: "completed",
      results: [{ tool_use_id: "tu-meta", is_error: true, content: cancelled }],
    });
    expect(delivered).toEqual(["tu-meta"]);
  });

  it("refuses a call that reaches the executor after close without failing the quit", async () => {
    const { ledger, executor, executes, toolUses } = await freshExecutor(1);
    ledger.sealToolInvocations();
    let releaseClose!: () => void;
    const closeHeld = new Promise<void>((resolve) => { releaseClose = resolve; });
    const join = ledger.closeToolInvocationAudit(async () => { await closeHeld; });
    const delivered: string[] = [];
    let results: Awaited<ReturnType<typeof executor.executeAll>>;
    try {
      results = await executor.executeAll(toolUses, {
        sessionId: "sess-after-close",
        permissionContext: userPermissionContext(),
        onToolResult: async (result) => { delivered.push(result.tool_use_id); },
      });
    } finally {
      releaseClose();
    }
    await expect(join).resolves.toBe(0);
    expect(executes[0]).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ tool_use_id: "tu-queued-0", is_error: true });
    expect(delivered).toEqual(["tu-queued-0"]);
    expect(ledger.pendingToolInvocationCount()).toBe(0);
  });

  it("refuses a claimed plugin tool at the seal instead of waiting on a pending generation transition", async () => {
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const lease = { generation: { generationId: "gen-1", state: { runtime: {} } }, release: () => {} };
    // The first call holds the active generation; later calls wait on a transition that never commits.
    const acquireExact = vi.fn(async () => {
      if (acquireExact.mock.calls.length === 1) return lease;
      return new Promise<never>(() => {});
    });
    const access = {
      getActive: () => undefined,
      isExactAdmitted: () => false,
      acquire: async () => lease,
      acquireExact,
      runWithLease: async <T>(_lease: unknown, operation: () => Promise<T>) => operation(),
    } as unknown as PluginRuntimeGenerationAccess;
    const { ledger, executor, executes, audit, rows, hostShutdownRows, toolUses } = await freshExecutor(2, [], access);
    executes[0].mockImplementationOnce(async () => { await blocker; return "done 0"; });
    const running = executor.executeAll(toolUses, { sessionId: "sess-generation", permissionContext: userPermissionContext() });
    await vi.waitFor(() => expect(executes[0]).toHaveBeenCalledOnce(), { timeout: 10_000 });
    ledger.sealToolInvocations();
    let rowsAtClose: Array<Record<string, unknown>> = [];
    const join = ledger.closeToolInvocationAudit(async () => { rowsAtClose = rows(); await audit.close(); });
    releaseBlocker();
    const settled = await Promise.race([join, new Promise((resolve) => { setTimeout(() => resolve("held"), 3_000); })]);
    expect(settled).toBe(2);
    expect(acquireExact).toHaveBeenCalledOnce();
    expect(executes[1]).not.toHaveBeenCalled();
    expect(hostShutdownRows(rowsAtClose, "tu-queued-1")).toHaveLength(1);
    expect((await running)[1].is_error).toBe(true);
  });

  it("refuses a queued tool without an audit failure when the force-kill path closes the audit in the seal's tick", async () => {
    const { ledger, executor, executes, audit, rows, hostShutdownRows, toolUses, cancelled } = await freshExecutor(2);
    let firstDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => { firstDelivered = resolve; });
    let releaseJournal!: () => void;
    const journal = new Promise<void>((resolve) => { releaseJournal = resolve; });
    const running = executor.executeAll(toolUses, {
      sessionId: "sess-force-kill",
      permissionContext: userPermissionContext(),
      onToolResult: async (result) => {
        if (result.tool_use_id === "tu-queued-0") { firstDelivered(); await journal; }
      },
    });
    await delivered;
    ledger.sealToolInvocations({ startQueued: false });
    ledger.markToolInvocationAuditClosed();
    const closed = audit.close();
    releaseJournal();
    const results = await running;
    await closed;
    expect(executes[1]).not.toHaveBeenCalled();
    expect(results[1]).toMatchObject({ tool_use_id: "tu-queued-1", is_error: true, content: cancelled });
    // The claimed start was skipped, so the queued tool met the closed gate and wrote nothing.
    expect(hostShutdownRows(rows(), "tu-queued-1")).toHaveLength(0);
    await expect(ledger.closeToolInvocationAudit(async () => {})).resolves.toBe(0);
  });
});
