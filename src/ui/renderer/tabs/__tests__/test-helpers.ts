import type { HookTrustRow } from "../../../../hooks/hook-trust-commands.js";
import type { PluginCardSummary } from "../../types.js";

export function makeHookTrustRow(name: string): HookTrustRow {
  return {
    fileName: name,
    hookType: "pre",
    sha256: "a".repeat(64),
    state: "disabled",
  };
}

/** Only id and version matter to catalog lookup; centralize the remaining type-required fixture fields. */
export function pluginCardSummary(
  over: Partial<PluginCardSummary> & { id: string },
): PluginCardSummary {
  return {
    name: over.id,
    description: "",
    sampleTools: [],
    capabilities: [],
    tools: [],
    ...over,
  };
}
