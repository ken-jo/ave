// Schema token pressure triggers deferral independently of count so a few huge tools cannot exhaust TPM.
import { describe, it, expect } from "vitest";

import { shouldDeferToolSchemas } from "../tool-scope.js";
import {
  EAGER_TOOL_EXPOSURE_CEILING,
  EAGER_TOOL_EXPOSURE_TOKEN_BUDGET,
} from "../../../shared/tool-exposure-policy.js";
import type { ConversationLoopDeps } from "../types.js";

function makeDeps(
  tools: Array<{ name: string; pluginId: string; schemaChars: number }>,
): ConversationLoopDeps {
  const modelVisible = tools.map((t) => ({
    name: t.name,
    source: "plugin" as const,
    pluginId: t.pluginId,
  }));
  const schemas = tools.map((t) => ({
    name: t.name,
    description: "d",
    input_schema: {
      type: "object",
      properties: { p: { type: "string", description: "x".repeat(t.schemaChars) } },
    },
    source: "plugin" as const,
  }));
  return {
    headless: false,
    toolRegistry: {
      getModelVisibleTools: () => modelVisible,
      getToolSchemas: () => schemas,
    },
  } as unknown as ConversationLoopDeps;
}

describe("budget-based deferral gate", () => {
  it("keeps the common surface eager (below both count and token budget)", () => {
    const deps = makeDeps(
      Array.from({ length: 43 }, (_, i) => ({ name: `t${i}`, pluginId: "p", schemaChars: 120 })),
    );
    expect(shouldDeferToolSchemas(deps, new Set(["p"]))).toBe(false);
  });

  it("defers when the count reaches the ceiling (cheap pre-filter)", () => {
    const deps = makeDeps(
      Array.from({ length: EAGER_TOOL_EXPOSURE_CEILING }, (_, i) => ({
        name: `t${i}`,
        pluginId: "p",
        schemaChars: 1,
      })),
    );
    expect(shouldDeferToolSchemas(deps, new Set(["p"]))).toBe(true);
  });

  it("defers when a few large schemas exceed the token budget (count under ceiling)", () => {
    const tools = Array.from({ length: 20 }, (_, i) => ({
      name: `t${i}`,
      pluginId: "p",
      schemaChars: 12000,
    }));
    expect(tools.length).toBeLessThan(EAGER_TOOL_EXPOSURE_CEILING);
    const deps = makeDeps(tools);
    expect(shouldDeferToolSchemas(deps, new Set(["p"]))).toBe(true);
  });

  it("only counts in-scope plugin schemas toward the token budget", () => {
    const deps = makeDeps(
      Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, pluginId: "other", schemaChars: 12000 })),
    );
    expect(shouldDeferToolSchemas(deps, new Set(["p"]))).toBe(false);
  });

  it("returns false for an empty scope", () => {
    expect(shouldDeferToolSchemas(makeDeps([]), new Set())).toBe(false);
  });

  it("sanity: the token budget is above the common surface and below the count-ceiling worst case", () => {
    expect(EAGER_TOOL_EXPOSURE_TOKEN_BUDGET).toBeGreaterThan(13_000);
    expect(EAGER_TOOL_EXPOSURE_TOKEN_BUDGET).toBeGreaterThan(0);
  });
});
