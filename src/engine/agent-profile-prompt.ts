import { escapeHtml } from "../shared/escape-html.js";

export interface AgentProfilePromptSource {
  name: string;
  body: string;
}

const AGENT_PROFILE_FENCE_PATTERN = /<(\s*\/?\s*ave-agent-(?:profile|task)[^>]*)>/gi;
const ZWSP = "\u200b";

/** Fence profile and task separately so neither can escape its prompt section. */
export function renderAgentProfilePrompt(
  profile: AgentProfilePromptSource,
  taskInstructions: string,
): string {
  return [
    '<ave-agent-profile name="' + escapeHtml(profile.name) + '">',
    neutralizeAgentProfileFence(profile.body),
    "</ave-agent-profile>",
    "",
    "<ave-agent-task>",
    neutralizeAgentProfileFence(taskInstructions),
    "</ave-agent-task>",
  ].join("\n");
}

function neutralizeAgentProfileFence(body: string): string {
  return body.replace(AGENT_PROFILE_FENCE_PATTERN, "<" + ZWSP + "$1>");
}
