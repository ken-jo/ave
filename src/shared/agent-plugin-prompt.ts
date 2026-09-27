import { formatStagedEnvelope, stagedOriginFor } from "./staged-origins.js";

export interface AgentPluginTemplatePrompt {
  id: string;
  packageName: string;
  version: string;
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
}

const NAME = /^[a-z][a-z0-9-]{0,62}$/u;

/** The selected template stays package-authored after inserting the user's arguments. */
export function formatAgentPluginTemplatePrompt(prompt: AgentPluginTemplatePrompt, args: string): string {
  if (!NAME.test(prompt.packageName) || !NAME.test(prompt.name)
    || prompt.id !== `agent-plugin:${prompt.packageName}:${prompt.name}`) {
    throw new Error("invalid agent plugin template identity");
  }
  const body = prompt.body.replaceAll("{args}", () => args);
  return formatStagedEnvelope(stagedOriginFor("plugin-prompt-emitted"), body,
    `plugin-prompt:${prompt.packageName}:${prompt.name}`);
}
