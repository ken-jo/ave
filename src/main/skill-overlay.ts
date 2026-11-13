// Skill bodies enter only visible tool results, preserving prompt-cache stability, history continuity, and data provenance. The registry holds approved
// resource identity until conversation teardown or plugin retirement; see docs/development/README.md#skill-loading-policy.
import { SKILL_MAX_BODY_BYTES, type LoadedSkill } from "./skill-store.js";
import { escapeHtml } from "../shared/escape-html.js";
import { parseMcpSkillSelector } from "../shared/mcp-skill-selector.js";
import type { SkillStore } from "./skill-store.js";

export interface SkillOverlayEntry {
  mcpOwner?: LoadedSkill["mcpOwner"];
  name: string;
  pluginOwner?: LoadedSkill["pluginOwner"];
  agentPluginOwner?: LoadedSkill["agentPluginOwner"];
  // Bundled resources declared by the read skill (stage-3). This list is the AUTHORIZED set: `skill_read` serves only what was listed at read time.
  resources: LoadedSkill["resources"];
  // Canonical SKILL.md path resolved when the skill was approved and read. `skill_read` resolves user-skill resources against THIS identity instead of
  // re-resolving the name from disk, so a later file swap cannot redirect a read that the user authorized against a different file.
  filePath: string;
}

export class SkillOverlay {
  constructor(private readonly store?: SkillStore) {}

  checkAdmission(sessionId: string | undefined, toolName: string, input: Record<string, unknown>, visibleSkillResults: readonly string[] = []): string | undefined {
    if (toolName !== "skill_load" && toolName !== "skill_list") {
      const loaded = new Set(this.list(sessionId ?? "").map((entry) => entry.name));
      for (const content of visibleSkillResults) {
        const selector = skillNameFromReadResult(content);
        if (selector && parseMcpSkillSelector(selector) && !loaded.has(selector)) {
          return "Restored MCP skill instructions require a verified skill_load before further tool use";
        }
      }
    }
    if (!this.store && this.list(sessionId ?? "").some((entry) => entry.mcpOwner)) return "Skill source is unavailable";
    return this.store ? this.mcpAdmissionDenial(this.store, sessionId, toolName, input) : undefined;
  }

  private readonly bySession = new Map<string, Map<string, SkillOverlayEntry>>();

  // Record (or refresh) a skill read in the given conversation.
  register(sessionId: string, skill: LoadedSkill): void {
    if (!sessionId) return;
    const bySkill = this.bySession.get(sessionId) ?? new Map<string, SkillOverlayEntry>();
    const key = skill.approvalKey ?? skill.name;
    // Same name, new identity (e.g. a new plugin generation): drop the stale one so the authorized set always reflects the latest read.
    for (const [existingKey, entry] of bySkill) {
      if (existingKey !== key && entry.name === skill.name) bySkill.delete(existingKey);
    }
    bySkill.set(key, {
      mcpOwner: skill.mcpOwner,
      name: skill.name,
      pluginOwner: skill.pluginOwner,
      agentPluginOwner: skill.agentPluginOwner,
      resources: skill.resources,
      filePath: skill.filePath,
    });
    this.bySession.set(sessionId, bySkill);
  }

  // Skills read in the conversation, ordered by first read.
  list(sessionId: string): SkillOverlayEntry[] {
    const m = this.bySession.get(sessionId);
    if (!m) return [];
    return [...m.values()];
  }

  // Drop all skills for a conversation — fired when the conversation is replaced.
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  // The held entry lasts at least as long as its visible instructions. A failed read or
  // observed rotation withdraws consent before any further invocation can use those instructions.
  mcpAdmissionDenial(store: SkillStore, sessionId: string | undefined, toolName: string, input: Record<string, unknown>): string | undefined {
    const owners = this.list(sessionId ?? "").flatMap((entry) => entry.mcpOwner ? [entry.mcpOwner] : []);
    const target = toolName === "mcp_resource_read" || toolName === "skill_load" && typeof input.serverId === "string" ? input.serverId
      : toolName === "skill_load" && typeof input.skillName === "string" ? parseMcpSkillSelector(input.skillName)?.serverId : undefined;
    if (typeof target === "string" && owners.some((owner) => owner.serverId !== target)) {
      return "Cross-server skill resource reads are disabled; use a separate conversation";
    }
    if (toolName === "mcp_resource_read" && typeof input.serverId === "string" && typeof input.uri === "string"
      && store.isMcpSkillResource(input.serverId, input.uri)) {
      return "Use skill_load and skill_read for declared skill files so consent and manifest verification apply";
    }
    if (toolName === "mcp_resource_read" && typeof input.uri === "string" && owners.some((owner) =>
      input.uri === owner.entry.uri || (input.uri as string).startsWith(owner.entry.uri.slice(0, -"SKILL.md".length)))) {
      return "Read active skill files with skill_read so their manifest digests are verified";
    }
    if (toolName === "skill_load" || toolName === "skill_list") return undefined;
    if (owners.some((owner) => !store.isMcpSkillCurrent(owner))) return "Skill consent was revoked by a change or disconnection; reload and approve the skill";
    return undefined;
  }

  // Drop every conversation's reads of one retired plugin generation.
  clearPluginGeneration(pluginId: string, generationId: string): void {
    for (const [sessionId, entries] of this.bySession) {
      for (const [key, entry] of entries) {
        if (entry.pluginOwner?.pluginId === pluginId && entry.pluginOwner.generationId === generationId) {
          entries.delete(key);
        }
      }
      if (entries.size === 0) this.bySession.delete(sessionId);
    }
  }
}

// Base directory reported with a read skill: the directory holding SKILL.md (a virtual `plugin://` / `agent-plugin://` root for packaged skills). Flat
// `<name>.md` skills have no bundle root — their parent is the shared skills directory — so they report none.
export function skillBaseDir(skill: Pick<LoadedSkill, "filePath">): string | null {
  const match = /^(.*)[\\/]SKILL\.md$/.exec(skill.filePath);
  return match ? match[1] : null;
}

// Neutralize skill fence tags in body text so an untrusted skill cannot close its fence or forge a sibling.
export function renderSkillReadResult(skill: LoadedSkill): string {
  const base = skillBaseDir(skill);
  const baseAttr = base ? ` base="${escapeHtml(base)}"` : "";
  const originAttr = skill.mcpOwner ? ` origin="mcp" server="${escapeHtml(skill.mcpOwner.serverId)}" uri="${escapeHtml(skill.mcpOwner.entry.uri)}"` : "";
  const lines: string[] = [`<ave-skill name="${escapeHtml(skill.name)}"${baseAttr}${originAttr}>`];
  lines.push(neutralizeSkillFence(skill.body));
  if (skill.resources.length > 0) {
    // Resource names are validated at discovery; re-escaping here would change valid names and break skill_read.
    // Bound the manifest separately so hostile filename lists cannot exceed the body budget.
    const manifest: string[] = [];
    let manifestChars = 0;
    let omitted = 0;
    for (const resource of skill.resources) {
      const line = `- ${resource.path} (${resource.bytes} bytes)`;
      if (manifestChars + line.length > MAX_MANIFEST_CHARS) {
        omitted += 1;
        continue;
      }
      manifestChars += line.length;
      manifest.push(line);
    }
    if (manifest.length > 0) {
      lines.push("");
      lines.push("bundled resources (fetch with skill_read):");
      lines.push(...manifest);
      if (omitted > 0) lines.push(`- …and ${omitted} more (not listed)`);
    }
  }
  lines.push(`</ave-skill>`);
  return lines.join("\n");
}

// Skill name of a successful `skill_load` tool_result rendered by {@link renderSkillReadResult}, or null for anything else (errors included). Compaction
// uses it to keep the latest read of each skill.
export function skillNameFromReadResult(content: string): string | null {
  const match = /^<ave-skill name="([^"]*)"/.exec(content);
  return match ? match[1] : null;
}

// Total characters the bundled-resource manifest may add inside one fence.
const MAX_MANIFEST_CHARS = 2048;

// Upper bound on a rendered `skill_load` result: the body is capped at {@link SKILL_MAX_BODY_BYTES} (so at most that many UTF-16 units), the manifest at
// {@link MAX_MANIFEST_CHARS}, plus the fence header (name + base path).
export const MAX_SKILL_READ_RESULT_CHARS = SKILL_MAX_BODY_BYTES + MAX_MANIFEST_CHARS + 1024;

// Keep complete host-bounded skill reads intact; oversized restored or tampered rows still use the generic preview cap.
export function isBoundedSkillReadResult(message: {
  toolName?: string;
  isError?: boolean;
  content: string;
}): boolean {
  return (
    message.toolName === "skill_load" &&
    message.isError !== true &&
    message.content.length <= MAX_SKILL_READ_RESULT_CHARS &&
    skillNameFromReadResult(message.content) !== null
  );
}

const SKILL_FENCE_PATTERN = /<(\s*\/?\s*ave-skill[^>]*)>/gi;
const ZWSP = "​";
function neutralizeSkillFence(body: string): string {
  return body.replace(SKILL_FENCE_PATTERN, `<${ZWSP}$1>`);
}
