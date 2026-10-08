import type { AddRoutineInput } from "./routines-types.js";

/** A verified suggestion. It has no runtime identity until the user creates a routine. */
export interface AgentPluginRoutineTemplate extends Omit<AddRoutineInput, "scope" | "source"> {
  id: string;
  packageName: string;
  version: string;
  title: string;
  description: string;
  suggestedScope?: { pluginIds: string[] };
  /** Entry-extension templates use a separate source namespace from agent plugins. */
  sourceKind?: "extension";
}

export function packageRoutineSource(template: Pick<AgentPluginRoutineTemplate, "packageName" | "id" | "sourceKind">): string {
  return `${template.sourceKind === "extension" ? "extension" : "agent-plugin"}:${template.packageName}:${template.id}`;
}
