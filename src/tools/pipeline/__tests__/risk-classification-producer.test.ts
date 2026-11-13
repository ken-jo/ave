// Drive the real adapter and category producer with differing declared and derived categories so missing inspection cannot pass.
import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { createDynamicTool } from "../../base.js";
import { resolvePluginOperation } from "../../plugin-operation-governance.js";
import { tmpdir } from "node:os";
import { mcpToolToPluginTool } from "../../../mcp/plugin-tool-from-mcp.js";
import { resolveEnforcedCategory } from "../risk-classification.js";

const TMP = realpathSync(tmpdir());

// Use production reverse projection so source, category, and pathFields match real registry values.
function productionPluginTool() {
  return mcpToolToPluginTool(
    "ave-plugin-fixture",
    {
      name: "fixture_run",
      description: "fixture plugin tool",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      _meta: {
        "ai.agent-connector.ave/pathFields": ["path"],
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
    const tool = productionPluginTool();

    const enforced = resolveEnforcedCategory({
      tool,
      registeredCategoryFloor: tool.category,
      finalInput: { command: "ls -la /tmp" },
      sandboxFsContained: true,
    });

    // Declared is "write"; only a real call into the inspector yields "read".
    expect(enforced).toBe("read");
  });

  it("keeps a host-derived plugin read write-equivalent without filesystem confinement", () => {
    const tool = productionPluginTool();
    const category = resolveEnforcedCategory({
      tool, registeredCategoryFloor: tool.category, finalInput: { command: "git status" }, sandboxFsContained: false,
    });
    const manager = new PermissionManager(join(TMP, `ave-risk-${randomUUID()}.json`));
    manager.setMode("default");
    expect(category).toBe("write");
    expect(manager.checkDetailed(tool.name, tool.source, category)).toMatchObject({ decision: "ask" });
  });

  it("keeps every filesystem-shaped call write-equivalent without a scope input", () => {
    // Inside and outside write targets must retain the same risk category; containment is a separate gate.
    const tool = productionPluginTool();

    for (const path of ["/etc/passwd", `${TMP}/workspace/note.md`]) {
      expect(
        resolveEnforcedCategory({
          tool,
          registeredCategoryFloor: tool.category,
          finalInput: { path },
        }),
      ).toBe("write");
    }
  });

  it.each([false, true])("preserves confinement evidence for a governed read with containment=%s", (contained) => {
    const tool = createDynamicTool({
      name: "governed_inspect", description: "Inspect bounded state", source: "plugin", category: "read", pluginId: "fixture-plugin",
      operationPolicy: { discriminant: "operation", operations: { inspect: { kind: "read", minimumRisk: "read", appVisible: true } } },
      jsonSchema: { type: "object", properties: { operation: { type: "string" }, command: { type: "string" } } },
      execute: async () => ({ output: "state", isError: false }),
    });
    const input = { operation: "inspect", command: "git status" };
    const operation = resolvePluginOperation(tool.operationPolicy!, input, "model");
    const category = resolveEnforcedCategory({
      tool, registeredCategoryFloor: tool.category, finalInput: input, sandboxFsContained: contained, operationFloor: operation.rule.minimumRisk,
    });
    const manager = new PermissionManager(join(TMP, `ave-risk-${randomUUID()}.json`));
    manager.setMode("default");
    expect(manager.checkDetailed(tool.name, tool.source, category)).toMatchObject({ decision: contained ? "allow" : "ask" });
    expect(category).toBe(contained ? "read" : "write");
  });

  it("classifies a foreign MCP peer as network through the producer", () => {
    const tool = { ...productionPluginTool(), source: "mcp" as const };

    const enforced = resolveEnforcedCategory({
      tool,
      registeredCategoryFloor: "write",
      finalInput: { command: "ls -la /tmp" },
    });

    // Foreign peers never classify DOWN on the strength of their args.
    expect(enforced).toBe("network");
  });

  it.each([
    ["read", { command: "touch report.txt" }, "read", "shell"],
    ["write", { command: "git status" }, "read", "write"],
    ["network", { command: "git status" }, "read", "network"],
    ["read", { command: "git status" }, "network", "network"],
  ] as const)("registered %s and operation floors only raise host risk", (registeredCategoryFloor, finalInput, operationFloor, expected) => {
    expect(resolveEnforcedCategory({
      tool: productionPluginTool(), registeredCategoryFloor, finalInput, operationFloor, sandboxFsContained: true,
    })).toBe(expected);
  });
});


describe("declared plugin reads preserve host risk and containment", () => {
  it("honors read declarations without relaxing commands or network", () => {
    const tool = mcpToolToPluginTool("sample-panel", {
      name: "panel_status", inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } },
    }, async () => ({ text: "ok" }));
    const classify = (finalInput: Record<string, unknown>, operationFloor?: "write" | "shell" | "network") => resolveEnforcedCategory({
      tool, registeredCategoryFloor: tool.category, finalInput,
      sandboxFsContained: false, operationFloor,
    });
    expect(classify({})).toBe("read");
    expect(classify({ path: "/outside/report.txt" })).toBe("read");
    expect(classify({ command: "git status" })).toBe("write");
    expect(classify({ command: "touch report.txt" })).toBe("shell");
    expect(classify({ url: "https://example.com" })).toBe("network");
    for (const risk of ["write", "shell", "network"] as const) expect(classify({}, risk)).toBe(risk);
  });
});
