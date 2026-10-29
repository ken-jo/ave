// Drive the real adapter and category producer with differing declared and derived categories so missing inspection cannot pass.
import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { createDynamicTool } from "../../base.js";
import { resolvePluginOperation } from "../../plugin-operation-governance.js";
import { tmpdir } from "node:os";
import type { AuditEntry, AuditLogger } from "../../../audit/audit-logger.js";
import { mcpToolToPluginTool } from "../../../mcp/plugin-tool-from-mcp.js";
import { resolveEnforcedCategory } from "../risk-classification.js";

const TMP = realpathSync(tmpdir());

// Capture injected audit output without filesystem setup.
function shadowSink(): { logger: AuditLogger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const logger = {
    logShadow(entry: AuditEntry): void {
      records.push(JSON.parse(entry.output ?? "{}") as Record<string, unknown>);
    },
  } as unknown as AuditLogger;
  return { logger, records };
}

// Use production reverse projection so source, category, and pathFields match real registry values.
function productionPluginTool() {
  return mcpToolToPluginTool(
    "ave-plugin-fixture",
    {
      name: "fixture_run",
      description: "fixture plugin tool",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      _meta: {
        "ave/pathFields": ["path"],
        ui: { visibility: ["model"] },
      },
    },
    async () => ({ text: "ok" }),
  );
}

describe("resolveEnforcedCategory — producer → inspectHostRisk → enforced category", () => {
  it("the production adapter declares the write baseline the inspector must re-derive", () => {
    const tool = productionPluginTool();
    expect(tool.source).toBe("plugin");
    expect(tool.category).toBe("write");
  });

  it("enforces the HOST-derived category, not the declared one", () => {
    const { logger, records } = shadowSink();
    const tool = productionPluginTool();

    const enforced = resolveEnforcedCategory({
      tool,
      declaredCategory: tool.category,
      finalInput: { command: "ls -la /tmp" },
      correlationId: "corr-read",
      hostClassifiesRisk: true,
      sandboxFsContained: true,
      auditLogger: logger,
    });

    // Declared is "write"; only a real call into the inspector yields "read".
    expect(enforced).toBe("read");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      toolName: "fixture_run",
      source: "plugin",
      declaredCategory: "write",
      hostDerivedCategory: "read",
      diverged: true,
      enforced: true,
    });
  });

  it("keeps a host-derived plugin read write-equivalent without filesystem confinement", () => {
    const { logger } = shadowSink();
    const tool = productionPluginTool();
    const category = resolveEnforcedCategory({
      tool, declaredCategory: tool.category, finalInput: { command: "git status" }, correlationId: randomUUID(),
      hostClassifiesRisk: true, sandboxFsContained: false, auditLogger: logger,
    });
    const manager = new PermissionManager(join(TMP, `ave-risk-${randomUUID()}.json`));
    manager.setMode("default");
    expect(category).toBe("write");
    expect(manager.checkDetailed(tool.name, tool.source, category)).toMatchObject({ decision: "ask" });
  });

  it("still shadow-logs the host-derived category when enforcement is off", () => {
    const { logger, records } = shadowSink();
    const tool = productionPluginTool();

    const enforced = resolveEnforcedCategory({
      tool,
      declaredCategory: tool.category,
      finalInput: { command: "ls -la /tmp" },
      correlationId: "corr-shadow",
      hostClassifiesRisk: false,
      auditLogger: logger,
    });

    expect(enforced).toBe("write");
    expect(records[0]).toMatchObject({ hostDerivedCategory: "read", enforced: false });
  });

  it("keeps every filesystem-shaped call write-equivalent without a scope input", () => {
    // Inside and outside write targets must retain the same risk category; containment is a separate gate.
    const { logger, records } = shadowSink();
    const tool = productionPluginTool();

    for (const [correlationId, path] of [
      ["corr-escape", "/etc/passwd"],
      ["corr-inside", `${TMP}/workspace/note.md`],
    ] as const) {
      expect(
        resolveEnforcedCategory({
          tool,
          declaredCategory: tool.category,
          finalInput: { path },
          correlationId,
          hostClassifiesRisk: true,
          auditLogger: logger,
        }),
      ).toBe("write");
    }

    expect(records.map((r) => r.hostDerivedCategory)).toEqual(["write", "write"]);
    expect(records.map((r) => r.diverged)).toEqual([false, false]);
  });

  it.each([false, true])("preserves confinement evidence for a governed read with containment=%s", (contained) => {
    const { logger } = shadowSink();
    const tool = createDynamicTool({
      name: "governed_inspect", description: "Inspect bounded state", source: "plugin", category: "read", pluginId: "fixture-plugin",
      operationPolicy: { discriminant: "operation", operations: { inspect: { kind: "read", minimumRisk: "read", appVisible: true } } },
      jsonSchema: { type: "object", properties: { operation: { type: "string" }, command: { type: "string" } } },
      execute: async () => ({ output: "state", isError: false }),
    });
    const input = { operation: "inspect", command: "git status" };
    const operation = resolvePluginOperation(tool.operationPolicy!, input, "model");
    const category = resolveEnforcedCategory({
      tool, declaredCategory: tool.category, finalInput: input, correlationId: randomUUID(),
      hostClassifiesRisk: true, sandboxFsContained: contained, auditLogger: logger, operationFloor: operation.rule.minimumRisk,
    });
    const manager = new PermissionManager(join(TMP, `ave-risk-${randomUUID()}.json`));
    manager.setMode("default");
    expect(manager.checkDetailed(tool.name, tool.source, category)).toMatchObject({ decision: contained ? "allow" : "ask" });
    expect(category).toBe(contained ? "read" : "write");
  });

  it("classifies a foreign MCP peer as network through the producer", () => {
    const { logger, records } = shadowSink();
    const tool = { ...productionPluginTool(), source: "mcp" as const };

    const enforced = resolveEnforcedCategory({
      tool,
      declaredCategory: "write",
      finalInput: { command: "ls -la /tmp" },
      correlationId: "corr-mcp",
      hostClassifiesRisk: true,
      auditLogger: logger,
    });

    // Foreign peers never classify DOWN on the strength of their args.
    expect(enforced).toBe("network");
    expect(records[0]).toMatchObject({ hostDerivedCategory: "network", diverged: true });
  });
});
