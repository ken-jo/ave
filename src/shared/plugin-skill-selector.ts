/** Catalog minting, skill tools, and the turn-scope gate must share this selector grammar. */

/** Unanchored so allow-list alternations can embed the same grammar. */
export const PLUGIN_SKILL_SELECTOR_PATTERN =
  "plugin:([a-z][a-z0-9-]{2,127}):([a-zA-Z_][a-zA-Z0-9_]*)";

export const AGENT_PLUGIN_SKILL_SELECTOR_PATTERN =
  "agent-plugin:([a-z][a-z0-9-]{0,62}):([a-z][a-z0-9-]{0,62})";

const PLUGIN_SKILL_SELECTOR = new RegExp(`^${PLUGIN_SKILL_SELECTOR_PATTERN}$`);
const AGENT_PLUGIN_SKILL_SELECTOR = new RegExp(`^${AGENT_PLUGIN_SKILL_SELECTOR_PATTERN}$`);

/** Returns null for user skills or malformed selectors; acceptance must match the plugin arm of SKILL_SELECTOR_ALLOWLIST. */
export function parsePluginSkillSelector(
  skillName: string,
): { pluginId: string; localId: string } | null {
  const match = PLUGIN_SKILL_SELECTOR.exec(skillName);
  if (!match) return null;
  return { pluginId: match[1], localId: match[2] };
}

export function parseAgentPluginSkillSelector(
  skillName: string,
): { packageName: string; localId: string } | null {
  const match = AGENT_PLUGIN_SKILL_SELECTOR.exec(skillName);
  return match ? { packageName: match[1]!, localId: match[2]! } : null;
}
