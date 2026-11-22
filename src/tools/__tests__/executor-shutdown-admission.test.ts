import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { userPermissionContext } from "./tool-context-fixture.js";

const roots: string[] = [];
const loggers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const logger of loggers.splice(0)) await logger.close();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

/** Each call loads a fresh module graph, so a sealed ledger never leaks into another test. */
async function freshExecutor(toolCount: number) {
  vi.resetModules();
  const ledger = await import("../invocation-ledger.js");
  const { ToolExecutor } = await import("../executor.js");
  const { ToolRegistry } = await import("../registry.js");
  const { createDynamicTool } = await import("../base.js");
  const { PermissionManager } = await import("../../permissions/permission-manager.js");
  const { AuditLogger } = await import("../../audit/audit-logger.js");
  const { t } = await import("../../i18n/index.js");
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
      source: "builtin",
      category: "write",
      isReadOnly: () => false,
      jsonSchema: { type: "object", properties: { value: { type: "string" } } },
      execute: async () => ({ output: String(await execute()), isError: false }),
    }));
  }
  const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined, audit);
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

  it("refuses a queued tool after the seal while the previous result callback waits on the journal", async () => {
    const { ledger, executor, executes, toolUses, cancelled } = await freshExecutor(2);
    let firstDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => { firstDelivered = resolve; });
    let releaseJournal!: () => void;
    const journal = new Promise<void>((resolve) => { releaseJournal = resolve; });
    const resultIds: string[] = [];
    const running = executor.executeAll(toolUses, {
      sessionId: "sess-after-close",
      permissionContext: userPermissionContext(),
      onToolResult: async (result) => {
        resultIds.push(result.tool_use_id);
        if (result.tool_use_id === "tu-queued-0") { firstDelivered(); await journal; }
      },
    });
    await delivered;
    let releaseClose!: () => void;
    const closeHeld = new Promise<void>((resolve) => { releaseClose = resolve; });
    const close = vi.fn(async () => { await closeHeld; });
    ledger.sealToolInvocations();
    const join = ledger.closeToolInvocationAudit(close);
    let results: Awaited<typeof running>;
    try {
      // The join closes while the first callback still waits on the journal.
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce(), { timeout: 10_000 });
    } finally {
      releaseJournal();
      results = await running;
      releaseClose();
    }
    await expect(join).resolves.toBeGreaterThanOrEqual(0);
    expect(executes[0]).toHaveBeenCalledOnce();
    expect(executes[1]).not.toHaveBeenCalled();
    expect(results.map((result) => [result.tool_use_id, result.is_error === true])).toEqual([
      ["tu-queued-0", false],
      ["tu-queued-1", true],
    ]);
    expect(results[1].content).toBe(cancelled);
    expect(resultIds).toEqual(["tu-queued-0", "tu-queued-1"]);
    expect(ledger.pendingToolInvocationCount()).toBe(0);
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
});
