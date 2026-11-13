import type { LoadedSkill, SkillCatalogEntry, SkillResourceContent } from "./skill-store.js";
import { MCP_SKILLS_SPEC_COMMIT, mcpSkillFingerprint, mcpSkillText, skillResourcePath, verifiedMcpSkillBody, type McpSkill } from "../mcp/mcp-skills.js";
import { mcpSkillSelector, parseMcpSkillSelector } from "../shared/mcp-skill-selector.js";
import { isCanonicalSkillResourceUri } from "../shared/mcp-resource-bounds.js";

export interface McpSkillAccess {
  listSkills(): Array<{ serverId: string; skill: McpSkill }>;
  getSkill(serverId: string, uri: string): Promise<McpSkill>;
  readSkillResource(serverId: string, skill: McpSkill, uri: string): Promise<Buffer>;
}

export interface McpSkillOwner {
  readonly serverId: string;
  readonly entry: McpSkill;
  readonly fingerprint: string;
}

// Memory-only transport source: no disk cache can be rediscovered as a local skill.
export class McpSkillSource {
  constructor(private readonly getAccess: () => McpSkillAccess | undefined) {}

  listCatalogSync(): SkillCatalogEntry[] {
    return (this.getAccess()?.listSkills() ?? []).map(({ serverId, skill }) => ({
      name: mcpSkillSelector(serverId, skill.uri),
      description: skill.frontmatter.description,
      triggers: [],
      mcpOrigin: { serverId, uri: skill.uri },
    }));
  }

  isCurrent(owner: McpSkillOwner): boolean {
    const current = this.getAccess()?.listSkills().find(({ serverId, skill }) => serverId === owner.serverId && skill.uri === owner.entry.uri)?.skill;
    return current !== undefined && current.resources !== "dynamic" && mcpSkillFingerprint(current) === owner.fingerprint;
  }

  isSkillResource(serverId: string, uri: string): boolean {
    return (this.getAccess()?.listSkills() ?? []).some((entry) => {
      if (entry.serverId !== serverId) return false;
      const scheme = entry.skill.uri.slice(0, entry.skill.uri.indexOf(":") + 1);
      // Compare scheme case only to refuse aliases; leave the requested URI unchanged.
      return uri === entry.skill.uri || uri.startsWith(entry.skill.uri.slice(0, -"SKILL.md".length))
        || uri.slice(0, scheme.length).toLowerCase() === scheme && !isCanonicalSkillResourceUri(uri);
    });
  }

  async load(selector: string): Promise<LoadedSkill | null> {
    const origin = parseMcpSkillSelector(selector);
    if (!origin) return null;
    const access = this.getAccess();
    if (!access) throw new Error("Skill transport is unavailable");
    const entry = access.listSkills().find(({ serverId, skill }) => serverId === origin.serverId && skill.uri === origin.uri)?.skill
      ?? await access.getSkill(origin.serverId, origin.uri);
    const fingerprint = mcpSkillFingerprint(entry);
    const body = verifiedMcpSkillBody(entry, await access.readSkillResource(origin.serverId, entry, entry.uri));
    const owner = Object.freeze({ serverId: origin.serverId, entry, fingerprint });
    if (!this.isCurrent(owner)) throw new Error("Skill changed during load");
    return Object.freeze({
      name: selector,
      description: entry.frontmatter.description,
      triggers: [],
      body,
      filePath: `mcp-skill://${encodeURIComponent(origin.serverId)}/${encodeURIComponent(origin.uri)}/SKILL.md`,
      approvalKey: `${selector}|${MCP_SKILLS_SPEC_COMMIT}`,
      mcpOwner: owner,
      // Declarative hooks, scripts and permission-widening frontmatter never become host capabilities.
      resources: Object.freeze((entry.resources as Exclude<McpSkill["resources"], string>)
        .filter((file) => file.uri !== entry.uri)
        .map((file) => Object.freeze({ path: skillResourcePath(entry.uri, file.uri), bytes: file.size }))),
    });
  }

  async readResource(owner: McpSkillOwner, path: string): Promise<SkillResourceContent> {
    if (!this.isCurrent(owner)) throw new Error("Skill changed or disconnected; reload and approve it again");
    const access = this.getAccess();
    if (!access) throw new Error("Skill transport is unavailable");
    const uri = `${owner.entry.uri.slice(0, -"SKILL.md".length)}${path}`;
    const bytes = await access.readSkillResource(owner.serverId, owner.entry, uri);
    if (!this.isCurrent(owner)) throw new Error("Skill changed during read");
    return { path, bytes: bytes.length, content: mcpSkillText(bytes) };
  }
}
