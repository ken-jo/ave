import type { PluginCardSummary } from "../../types.js";

export function makePluginCard<T extends Partial<PluginCardSummary>>(overrides: T) {
  const defaults: PluginCardSummary = {
    id: "meeting",
    name: "Meeting",
    description: "Meeting plugin",
    sampleTools: [],
    capabilities: [],
    tools: [],
    loadStatus: "loaded",
  };
  return { ...defaults, ...overrides };
}
