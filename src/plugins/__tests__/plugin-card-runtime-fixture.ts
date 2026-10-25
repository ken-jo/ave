/** Cards use the real runtime projection; only generation activation is replaced to avoid on-disk fixtures. */
import { TestPluginRuntime } from "./test-helpers.js";
import type { PluginRuntime } from "../runtime.js";

export const CARD_FIXTURE_IN_SCOPE_PLUGIN = "com.example.allowed";
export const CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN = "com.example.secret";
export const CARD_FIXTURE_IN_SCOPE_TOOL = "allowed_read";
export const CARD_FIXTURE_OUT_OF_SCOPE_TOOLS = ["secret_tool", "secret_tool2"] as const;

export function pluginCardRuntimeFixture(hostRoot: string): PluginRuntime {
  const rt = new TestPluginRuntime({ hostRoot, manifestPaths: [] });
  const internals = rt as unknown as {
    knownPluginManifests: Map<string, unknown>;
    plugins: Map<string, unknown>;
    isPluginGenerationActive: (pluginId: string) => boolean;
  };
  const specs = [
    [CARD_FIXTURE_IN_SCOPE_PLUGIN, "Allowed Plugin", [CARD_FIXTURE_IN_SCOPE_TOOL]],
    [CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN, "Secret Plugin", [...CARD_FIXTURE_OUT_OF_SCOPE_TOOLS]],
  ] as const;
  for (const [pluginId, name, tools] of specs) {
    internals.knownPluginManifests.set(pluginId, {
      id: pluginId,
      name,
      description: `${name} does things`,
      tools: tools.map((toolName) => ({ name: toolName, description: `${toolName} description` })),
    });
    internals.plugins.set(pluginId, { manifest: { id: pluginId }, started: true });
  }
  internals.isPluginGenerationActive = () => true;
  return rt as unknown as PluginRuntime;
}
