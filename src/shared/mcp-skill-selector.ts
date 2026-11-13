// Origin and entry URI travel together through the existing name-keyed skill tools.
export const MCP_SKILL_SELECTOR_PATTERN = "mcp:([A-Za-z0-9_%!~*'().-]+):([A-Za-z0-9_%!~*'().-]+)";
const MCP_SKILL_SELECTOR = new RegExp(`^${MCP_SKILL_SELECTOR_PATTERN}$`);

export function mcpSkillSelector(serverId: string, uri: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `mcp:${encode(serverId)}:${encode(uri)}`;
}

export function parseMcpSkillSelector(selector: string): { serverId: string; uri: string } | null {
  const match = MCP_SKILL_SELECTOR.exec(selector);
  if (!match?.[1] || !match[2]) return null;
  try {
    const serverId = decodeURIComponent(match[1]);
    const uri = decodeURIComponent(match[2]);
    return serverId && uri && mcpSkillSelector(serverId, uri) === selector ? { serverId, uri } : null;
  } catch {
    return null;
  }
}
