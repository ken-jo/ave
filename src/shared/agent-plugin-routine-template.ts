import type { AddRoutineInput } from "./routines-types.js";

/** A verified suggestion. It has no runtime identity until the user creates a routine. */
export interface AgentPluginRoutineTemplate extends Omit<AddRoutineInput, "scope" | "source"> {
  id: string;
  packageName: string;
  version: string;
  title: string;
  description: string;
  suggestedScope?: { pluginIds: string[] };
}

export function agentPluginRoutineSource(template: Pick<AgentPluginRoutineTemplate, "packageName" | "id">): string {
  return `agent-plugin:${template.packageName}:${template.id}`;
}
