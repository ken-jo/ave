/**
 * SkillOverlay — per-conversation registry of skills the model has READ with
 * `skill_load`, plus the renderer for the `skill_load` tool result.
 *
 * Progressive disclosure (docs/development/skill-loading-policy.md): the
 * system prompt carries only the skill index (name + description). A skill's
 * SKILL.md body enters the context exclusively as the `skill_load`
 * tool_result, so the read is an explicit, visible step in the conversation
 * and the body never rides in the always-on prompt.
 *
 * Why the body is a tool_result and not a system-prompt section (revision of
 * the earlier C2(c) overlay design):
 *   - Prompt-cache stability. Splicing a body into the system prompt changed the
 *     cached prefix twice per turn (after the load, and again when the overlay
 *     cleared at the turn boundary), re-writing system prompt + tool schemas +
 *     history to the cache each time.
 *   - Continuity. The overlay expired at the user-turn boundary, so follow-up
 *     turns silently ran without the skill. A tool_result stays in history for
 *     the conversation and is re-read only after compaction removes it.
 *   - Provenance. A tool_result is the data channel (same as `read_file`); the
 *     body never masquerades as user input, and the `<ave-skill>` fence below is
 *     still neutralized against early-close / fake-sibling injection.
 *
 * What this registry still holds (no body): the identity captured when the skill
 * was approved and read — owner, generation, canonical file, and the bundled
 * resource manifest. `skill_read` authorizes resource reads against it. Entries
 * live for the conversation. They are cleared by `newConversation` (main loop),
 * sub-agent teardown (`SubAgentRunner.unregisterActiveChild`), and plugin
 * generation retirement (`PluginBundleLifecycle.retire`, "skills" phase).
 */
import { SKILL_MAX_BODY_BYTES, type LoadedSkill } from "./skill-store.js";
import { escapeHtml } from "../shared/escape-html.js";

export interface SkillOverlayEntry {
  name: string;
  pluginOwner?: LoadedSkill["pluginOwner"];
  agentPluginOwner?: LoadedSkill["agentPluginOwner"];
  /**
   * Bundled resources declared by the read skill (stage-3). This list is the
   * AUTHORIZED set: `skill_read` serves only what was listed at read time.
   */
  resources: LoadedSkill["resources"];
  /**
   * Canonical SKILL.md path resolved when the skill was approved and read.
   * `skill_read` resolves user-skill resources against THIS identity instead of
   * re-resolving the name from disk, so a later file swap cannot redirect a
   * read that the user authorized against a different file.
   */
  filePath: string;
}

export class SkillOverlay {
  private readonly bySession = new Map<string, Map<string, SkillOverlayEntry>>();

  /** Record (or refresh) a skill read in the given conversation. */
  register(sessionId: string, skill: LoadedSkill): void {
    if (!sessionId) return;
    const bySkill = this.bySession.get(sessionId) ?? new Map<string, SkillOverlayEntry>();
    const key = skill.approvalKey ?? skill.name;
    // Same name, new identity (e.g. a new plugin generation): drop the stale one
    // so the authorized set always reflects the latest read.
    for (const [existingKey, entry] of bySkill) {
      if (existingKey !== key && entry.name === skill.name) bySkill.delete(existingKey);
    }
    bySkill.set(key, {
      name: skill.name,
      pluginOwner: skill.pluginOwner,
      agentPluginOwner: skill.agentPluginOwner,
      resources: skill.resources,
      filePath: skill.filePath,
    });
    this.bySession.set(sessionId, bySkill);
  }

  /** Skills read in the conversation, ordered by first read. */
  list(sessionId: string): SkillOverlayEntry[] {
    const m = this.bySession.get(sessionId);
    if (!m) return [];
    return [...m.values()];
  }

  /** Drop all skills for a conversation — fired when the conversation is replaced. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Drop every conversation's reads of one retired plugin generation. */
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

/**
 * Base directory reported with a read skill: the directory holding SKILL.md
 * (a virtual `plugin://` / `agent-plugin://` root for packaged skills). Flat
 * `<name>.md` skills have no bundle root — their parent is the shared skills
 * directory — so they report none.
 */
export function skillBaseDir(skill: Pick<LoadedSkill, "filePath">): string | null {
  const match = /^(.*)[\\/]SKILL\.md$/.exec(skill.filePath);
  return match ? match[1] : null;
}

/**
 * Render the `skill_load` tool_result: the SKILL.md body inside an
 * `<ave-skill>` fence, followed (inside the fence) by the bundled-resource
 * manifest the model may fetch with `skill_read`.
 *
 * LOW (skill body sanitization): literal `<ave-skill …>` / `</ave-skill>`
 * patterns in the body are neutralized with a zero-width space so an
 * attacker-controlled body cannot close its fence early or forge a sibling.
 */
export function renderSkillReadResult(skill: LoadedSkill): string {
  const base = skillBaseDir(skill);
  const baseAttr = base ? ` base="${escapeHtml(base)}"` : "";
  const lines: string[] = [`<ave-skill name="${escapeHtml(skill.name)}"${baseAttr}>`];
  lines.push(neutralizeSkillFence(skill.body));
  if (skill.resources.length > 0) {
    // Inert manifest: names only. Fence integrity rests on the DISCOVERY-side
    // validator (`isSafeResourcePath` rejects control chars, `<`, `>`, `\`, `:`),
    // which is the single chokepoint — paths are deliberately NOT re-escaped
    // here, because escaping would rewrite a legitimate `Q&A.md` into a name
    // `skill_read` then refuses as "not listed".
    //
    // Bounded separately from the body: an attacker-chosen filename list must
    // not become a bigger budget than the body it accompanies.
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

/**
 * Skill name of a successful `skill_load` tool_result rendered by
 * {@link renderSkillReadResult}, or null for anything else (errors included).
 * Compaction uses it to keep the latest read of each skill.
 */
export function skillNameFromReadResult(content: string): string | null {
  const match = /^<ave-skill name="([^"]*)"/.exec(content);
  return match ? match[1] : null;
}

/** Total characters the bundled-resource manifest may add inside one fence. */
const MAX_MANIFEST_CHARS = 2048;

/**
 * Upper bound on a rendered `skill_load` result: the body is capped at
 * {@link SKILL_MAX_BODY_BYTES} (so at most that many UTF-16 units), the manifest
 * at {@link MAX_MANIFEST_CHARS}, plus the fence header (name + base path).
 */
export const MAX_SKILL_READ_RESULT_CHARS = SKILL_MAX_BODY_BYTES + MAX_MANIFEST_CHARS + 1024;

/**
 * Whether a tool_result is a complete skill read that the generic tool-result
 * preview cap must leave whole. A skill's instructions are only useful intact,
 * and the result is already host-bounded by {@link MAX_SKILL_READ_RESULT_CHARS};
 * anything larger (e.g. a tampered restored row) stays under the generic cap.
 */
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
