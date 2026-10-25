/** Advertised plugin tools must use the same scoped registry as execution; exercise the production factory and narrowing path. */
import { describe, it, expect, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSystemPromptBuilder } from "../../boot/conversation.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  CARD_FIXTURE_IN_SCOPE_PLUGIN as IN_SCOPE_PLUGIN,
  CARD_FIXTURE_IN_SCOPE_TOOL,
  CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN as OUT_OF_SCOPE_PLUGIN,
  CARD_FIXTURE_OUT_OF_SCOPE_TOOLS,
  pluginCardRuntimeFixture,
} from "../../plugins/__tests__/plugin-card-runtime-fixture.js";
import type { Tool } from "../../tools/base.js";
import { makePromptMemorySource } from "./test-helpers.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const memoryManager = makePromptMemorySource();

function pluginTool(pluginId: string, name: string): Tool {
  return {
    name,
    description: `${name} description`,
    source: "plugin",
    pluginId,
    modelVisible: true,
    version: "1.0.0",
    inputSchema: { type: "object", properties: {} },
    toJsonSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
  } as unknown as Tool;
}

function globalRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(pluginTool(IN_SCOPE_PLUGIN, CARD_FIXTURE_IN_SCOPE_TOOL));
  for (const name of CARD_FIXTURE_OUT_OF_SCOPE_TOOLS) {
    registry.register(pluginTool(OUT_OF_SCOPE_PLUGIN, name));
  }
  return registry;
}

function buildWithScope(builder: ReturnType<typeof createSystemPromptBuilder>): string {
  builder.setToolScope({
    activePluginIds: new Set<string>(),
    includeBuiltins: true,
    includeMcp: true,
    includeEgress: true,
  });
  return builder.build();
}

describe("sub-agent prompt scope — advertisement is bounded by the child's registry", () => {
  it("the card provider receives the CHILD's scoped registry, not the boot-time global", () => {
    const registry = globalRegistry();
    const runtime = pluginCardRuntimeFixture(HOST_ROOT);
    const spy = vi.spyOn(runtime, "listPluginCards");

    const parent = createSystemPromptBuilder({ memoryManager, toolRegistry: registry, pluginRuntime: runtime });
    buildWithScope(parent);
    expect(spy).toHaveBeenCalledWith(registry);

    const scoped = registry.createScopedView([CARD_FIXTURE_IN_SCOPE_TOOL]);
    const child = parent.createIsolated({ memoryManager, toolRegistry: scoped });
    spy.mockClear();
    buildWithScope(child);

    expect(spy).toHaveBeenCalledWith(scoped);
    expect(spy).not.toHaveBeenCalledWith(registry);
    spy.mockRestore();
  });

  it("an out-of-scope plugin is NOT advertised to the child (and the in-scope one still is)", () => {
    const registry = globalRegistry();
    const runtime = pluginCardRuntimeFixture(HOST_ROOT);
    const parent = createSystemPromptBuilder({ memoryManager, toolRegistry: registry, pluginRuntime: runtime });

    // First prove the full registry advertises the plugin so missing rendering cannot satisfy scope rejection vacuously.
    const parentPrompt = buildWithScope(parent);
    expect(parentPrompt).toContain(OUT_OF_SCOPE_PLUGIN);
    expect(parentPrompt).toContain("secret_tool");
    expect(parentPrompt).toContain(IN_SCOPE_PLUGIN);

    const scoped = registry.createScopedView([CARD_FIXTURE_IN_SCOPE_TOOL]);
    const childPrompt = buildWithScope(parent.createIsolated({ memoryManager, toolRegistry: scoped }));

    expect(scoped.getModelVisibleTools().map((tool) => tool.name)).toEqual([CARD_FIXTURE_IN_SCOPE_TOOL]);
    expect(childPrompt).not.toContain(OUT_OF_SCOPE_PLUGIN);
    expect(childPrompt).not.toContain("secret_tool");
    expect(childPrompt).toContain(IN_SCOPE_PLUGIN);
  });

  it("a child scoped to zero plugin tools gets no plugin catalog section at all", () => {
    const registry = globalRegistry();
    const runtime = pluginCardRuntimeFixture(HOST_ROOT);
    const parent = createSystemPromptBuilder({ memoryManager, toolRegistry: registry, pluginRuntime: runtime });
    expect(buildWithScope(parent)).toContain(OUT_OF_SCOPE_PLUGIN);

    const childPrompt = buildWithScope(
      parent.createIsolated({ memoryManager, toolRegistry: registry.createScopedView([]) }),
    );
    expect(childPrompt).not.toContain(IN_SCOPE_PLUGIN);
    expect(childPrompt).not.toContain(OUT_OF_SCOPE_PLUGIN);
  });
});
