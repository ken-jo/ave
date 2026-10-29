// Both tool sources share deny, approval, audit, and effect gates.
// Each non-read-only source uses automatic review before a normal approval fallback.
import { describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLogger, type AuditEntry } from "../../audit/audit-logger.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor, type ToolCallMeta, type ToolExecutorCallbacks } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { makePermissionManager } from "./executor-reviewer-fixtures.js";

// Isolate identical tools in separate registries while sharing permission, approval, and audit state.
const PROBE = "parity_probe";
const SCHEMA = { type: "object", properties: { payload: { type: "string" } } } as const;
const INPUT = { payload: "send release notice" } as const;
const SECRET = "aa".repeat(32);

function pluginRegistry(executeSpy: ReturnType<typeof vi.fn>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: PROBE,
    description: "network parity probe",
    source: "plugin",
    pluginId: "parity-plugin",
    category: "network",
    jsonSchema: SCHEMA,
    execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
  }));
  return registry;
}

function mcpRegistry(executeSpy: ReturnType<typeof vi.fn>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: PROBE,
    description: "network parity probe",
    source: "mcp",
    mcpServerId: "parity-srv",
    category: "network",
    jsonSchema: SCHEMA,
    execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
  }));
  return registry;
}

function rowsFromChannel(dir: string, suffix: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(suffix))) {
    for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return rows;
}

function permissionAuditRows(dir: string): Array<Record<string, unknown>> {
  return rowsFromChannel(dir, ".permission-audit.jsonl");
}

function toolCallTelemetry(dir: string): Array<{ name: string; source?: string; trust?: string }> {
  const out: Array<{ name: string; source?: string; trust?: string }> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        continue;
      }
      if (entry.type !== "tool_call" || !entry.toolCalls) continue;
      for (const tc of entry.toolCalls) out.push({ name: tc.name, source: tc.source, trust: tc.trust });
    }
  }
  return out;
}

function effectShadowRows(dir: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf-8").trim().split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as AuditEntry;
      const out = entry.output ?? "";
      if (out.includes("effect-shadow")) rows.push(JSON.parse(out) as Record<string, unknown>);
    }
  }
  return rows;
}

interface ParityRun {
  dir: string;
  auditDir: string;
  classifySpy: ReturnType<typeof vi.fn>;
  gate: { requestAndWait: ReturnType<typeof vi.fn> };
  pluginResult: { is_error?: boolean; content: string };
  mcpResult: { is_error?: boolean; content: string };
  pluginExecuted: ReturnType<typeof vi.fn>;
  mcpExecuted: ReturnType<typeof vi.fn>;
  metas: ToolCallMeta[];
  cleanup: () => Promise<void>;
}

async function runParityPair(opts: { deny?: boolean; level?: "medium" | "high" } = {}): Promise<ParityRun> {
  const dir = mkdtempSync(join(tmpdir(), "ave-parity-"));
  const auditDir = mkdtempSync(join(tmpdir(), "ave-parity-audit-"));

  const classifySpy = vi.fn(() => ({ level: opts.level ?? "high" as const, reason: "needs confirm" }));
  const permMgr = makePermissionManager(dir, classifySpy);
  permMgr.setMode("auto");
  if (opts.deny) await permMgr.addAlwaysDeniedPersist(PROBE);

  const gate = {
    requestAndWait: vi.fn(async (req: { id: string }) => ({ requestId: req.id, choice: "allow-once" as const })),
  };
  const auditLogger = new AuditLogger(auditDir);
  await auditLogger.setupPermissionAuditChain(SECRET);

  const metas: ToolCallMeta[] = [];
  const callbacks: ToolExecutorCallbacks = {
    onToolEnd: (_name, _result, _isError, meta) => { metas.push(meta); },
  };

  const pluginExecuted = vi.fn(async () => "plugin-ok");
  const mcpExecuted = vi.fn(async () => "mcp-ok");

  const pluginExecutor = new ToolExecutor(
    pluginRegistry(pluginExecuted), undefined, permMgr, undefined, gate as never, undefined, auditLogger,
  );
  const mcpExecutor = new ToolExecutor(
    mcpRegistry(mcpExecuted), undefined, permMgr, undefined, gate as never, undefined, auditLogger,
  );

  const pluginResult = (await pluginExecutor.executeAll(
    [{ id: "tu-plugin", name: PROBE, input: { ...INPUT } }],
    { sessionId: "sess-plugin", permissionContext: { trustOrigin: "user-keyboard" }, callbacks },
  ))[0];
  const mcpResult = (await mcpExecutor.executeAll(
    [{ id: "tu-mcp", name: PROBE, input: { ...INPUT } }],
    { sessionId: "sess-mcp", permissionContext: { trustOrigin: "user-keyboard" }, callbacks },
  ))[0];
  await auditLogger.flush();

  return {
    dir, auditDir, classifySpy, gate, pluginResult, mcpResult,
    pluginExecuted, mcpExecuted, metas,
    cleanup: async () => {
      await auditLogger.close();
      await cleanupTmpDir(dir);
      await cleanupTmpDir(auditDir);
    },
  };
}

// Compare requests excluding generated IDs, source identity, and reviewer-lane consequences.
function stableGateReq(req: Record<string, unknown>): Record<string, unknown> {
  const { source: _s, ...evaluationContext } = (req.evaluationContext ?? {}) as Record<string, unknown>;
  return {
    category: req.category,
    toolName: req.toolName,
    toolCategory: req.toolCategory,
    args: req.args,
    isReadOnly: req.isReadOnly,
    mode: req.mode,
    sensitivePathPattern: req.sensitivePathPattern,
    trustOrigin: req.trustOrigin,
    sandboxCapability: req.sandboxCapability,
    evaluationContext,
  };
}

describe("ToolExecutor MCP↔plugin permission parity (regression lock)", () => {
  // Layer-1 deny must stop both sources before reviewer or approval.
  it("Layer-1 deny — both sources denied identically at layer 1 before any reviewer/gate step", async () => {
    const run = await runParityPair({ deny: true });
    try {
      // Both sources fail closed.
      expect(run.pluginResult.is_error).toBe(true);
      expect(run.mcpResult.is_error).toBe(true);

      const denyRows = permissionAuditRows(run.auditDir).filter((r) => r.decision === "deny");
      expect(denyRows).toHaveLength(2);
      const bySource = (s: string) => denyRows.find((r) => r.source === s)!;
      const pluginDeny = bySource("plugin");
      const mcpDeny = bySource("mcp");
      expect(pluginDeny).toBeDefined();
      expect(mcpDeny).toBeDefined();
      for (const row of [pluginDeny, mcpDeny]) {
        expect((row.denyReasons as Array<{ layer: number }>)[0].layer).toBe(1);
        expect(row.category).toBe("network");
      }

      // Deny must prevent reviewer, approval, and execution for both sources.
      expect(run.classifySpy).not.toHaveBeenCalled();
      expect(run.gate.requestAndWait).not.toHaveBeenCalled();
      expect(run.pluginExecuted).not.toHaveBeenCalled();
      expect(run.mcpExecuted).not.toHaveBeenCalled();
      expect(effectShadowRows(run.auditDir)).toHaveLength(0);
    } finally {
      await run.cleanup();
    }
  });

  // Both sources converge on approval; only source identity and reviewer consequences may differ.
  it("approval gate — both sources converge at the identical ApprovalGate request except source", async () => {
    const run = await runParityPair();
    try {
      expect(run.pluginResult.is_error).toBeFalsy();
      expect(run.mcpResult.is_error).toBeFalsy();
      expect(run.pluginExecuted).toHaveBeenCalledTimes(1);
      expect(run.mcpExecuted).toHaveBeenCalledTimes(1);

      expect(run.gate.requestAndWait).toHaveBeenCalledTimes(2);
      const reqs = run.gate.requestAndWait.mock.calls.map((c) => c[0] as Record<string, unknown>);
      const pluginReq = reqs.find((r) => r.source === "plugin")!;
      const mcpReq = reqs.find((r) => r.source === "mcp")!;
      expect(pluginReq).toBeDefined();
      expect(mcpReq).toBeDefined();

      expect(pluginReq.source).toBe("plugin");
      expect(mcpReq.source).toBe("mcp");
      expect(stableGateReq(pluginReq)).toEqual(stableGateReq(mcpReq));
      expect((pluginReq.evaluationContext as Record<string, unknown>).source).toBe("plugin");
      expect((mcpReq.evaluationContext as Record<string, unknown>).source).toBe("mcp");

      // Both sources retain their high review verdict on the normal card.
      expect(pluginReq.reviewerVerdict).toMatchObject({ level: "high" });
      expect(mcpReq.reviewerVerdict).toMatchObject({ level: "high" });
    } finally {
      await run.cleanup();
    }
  });

  // Source identity remains evidence while both sources follow the same review order.
  it("reviews both tool sources before the high-verdict approval card", async () => {
    const run = await runParityPair();
    try {
      expect(run.classifySpy).toHaveBeenCalledTimes(2);
      const classifiedSources = run.classifySpy.mock.calls.map((c) => (c[0] as { source: string }).source);
      expect(classifiedSources).toEqual(["plugin", "mcp"]);

      // The host derives the plugin sandbox root from trusted pluginId; external tools have no such root.
      const pluginCtx = run.classifySpy.mock.calls[0][0] as Record<string, unknown>;
      expect(pluginCtx.source).toBe("plugin");
      expect(pluginCtx.category).toBe("network");
      expect(typeof pluginCtx.ownerPluginSandboxRoot).toBe("string");
      expect(pluginCtx.ownerPluginSandboxRoot as string).toContain("parity-plugin");

      const mcpCtx = run.classifySpy.mock.calls[1][0] as Record<string, unknown>;
      expect(mcpCtx.source).toBe("mcp");
      expect(mcpCtx.category).toBe("network");
      expect(mcpCtx.ownerPluginSandboxRoot).toBeUndefined();

      // Both high verdicts converge at approval.
      expect(run.gate.requestAndWait).toHaveBeenCalledTimes(2);
    } finally {
      await run.cleanup();
    }
  });

  it("allows medium verdicts for both tool sources without a card", async () => {
    const run = await runParityPair({ level: "medium" });
    try {
      expect(run.classifySpy).toHaveBeenCalledTimes(2);
      expect(run.classifySpy.mock.calls.map(([input]) => input.source)).toEqual(["plugin", "mcp"]);
      expect(run.pluginResult.is_error).toBeFalsy();
      expect(run.mcpResult.is_error).toBeFalsy();
      expect(run.pluginExecuted).toHaveBeenCalledOnce();
      expect(run.mcpExecuted).toHaveBeenCalledOnce();
      expect(run.gate.requestAndWait).not.toHaveBeenCalled();
    } finally {
      await run.cleanup();
    }
  });

  it("audit + effect-ledger — one row per invocation, diverging only in the sanctioned host-derived fields", async () => {
    const run = await runParityPair();
    try {
      const allowRows = permissionAuditRows(run.auditDir).filter((r) => r.decision === "allow");
      expect(allowRows).toHaveLength(2);
      const auditBySource = (s: string) => allowRows.find((r) => r.source === s)!;
      expect(auditBySource("plugin")).toBeDefined();
      expect(auditBySource("mcp")).toBeDefined();
      for (const row of allowRows) {
        expect(row.decision).toBe("allow");
        expect(row.category).toBe("network");
      }

      // Audited trust differs by source: plugin=medium, mcp=low.
      const telemetry = toolCallTelemetry(run.auditDir).filter((t) => t.name === PROBE);
      const pluginTel = telemetry.find((t) => t.source === "plugin")!;
      const mcpTel = telemetry.find((t) => t.source === "mcp")!;
      expect(pluginTel.trust).toBe("medium");
      expect(mcpTel.trust).toBe("low");

      // Host-derived pluginId and mcpServerId are mutually exclusive.
      const metaBySource = (s: string) => run.metas.find((m) => m.source === s)!;
      const pluginMeta = metaBySource("plugin");
      const mcpMeta = metaBySource("mcp");
      expect(pluginMeta.pluginId).toBe("parity-plugin");
      expect(pluginMeta.mcpServerId).toBeUndefined();
      expect(mcpMeta.mcpServerId).toBe("parity-srv");
      expect(mcpMeta.pluginId).toBeUndefined();

      // Effect rows may differ only in source, plugin identity, and host observability.
      const shadows = effectShadowRows(run.auditDir).filter((r) => r.toolName === PROBE);
      expect(shadows).toHaveLength(2);
      const shadowBySource = (s: string) => shadows.find((r) => r.source === s)!;
      const pluginShadow = shadowBySource("plugin");
      const mcpShadow = shadowBySource("mcp");

      for (const row of [pluginShadow, mcpShadow]) {
        expect(typeof row.correlationId).toBe("string");
        expect((row.correlationId as string).length).toBeGreaterThan(0);
        expect(row.declaredCategory).toBe("network");
        expect(row.hasMutatingEffect).toBe(false);
        expect(row.effects).toEqual([]);
      }
      expect(pluginShadow.hostObservable).toBe(true);
      expect(mcpShadow.hostObservable).toBe(false);
      expect(pluginShadow.pluginId).toBe("parity-plugin");
      expect(mcpShadow.pluginId).toBeUndefined();

      const stripSanctioned = (r: Record<string, unknown>): Record<string, unknown> => {
        const { source: _s, pluginId: _p, hostObservable: _h, correlationId: _c, ...rest } = r;
        return rest;
      };
      expect(stripSanctioned(pluginShadow)).toEqual(stripSanctioned(mcpShadow));
    } finally {
      await run.cleanup();
    }
  });
});
