/**
 * PersonaPromptStore — user-editable main-agent persona prompts.
 *
 * Personas live under `~/.ave/prompts/` as markdown files with frontmatter.
 * The main composer can select one persona per turn. Agent profiles and skills
 * are intentionally not part of this store: agents belong to `agent_spawn`,
 * while skills are loaded by `skill_load` after the normal approval path.
 */
import { readFile, readdir, realpath, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createLogger } from "../lib/logger.js";
import type { InstalledAgentPlugin } from "../marketplace/content/service.js";
import type { AgentPluginTemplatePrompt } from "../shared/agent-plugin-prompt.js";
import { openFeatureNamespace, writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import { parseFrontmatterBlock, unquoteFrontmatterValue } from "./skill-store.js";

const log = createLogger("ave");

const LOCAL_PERSONA_PROMPT_ID = /^[a-zA-Z0-9_-]+$/;
export const PERSONA_PROMPT_ID_ALLOWLIST = /^(?:[a-zA-Z0-9_-]+|agent-plugin:[a-z][a-z0-9-]{0,62}:[a-z][a-z0-9-]{0,62})$/;
const PERSONA_PROMPT_MAX_BODY_BYTES = 8 * 1024;
const USER_PROMPTS_NAMESPACE = openFeatureNamespace("prompts");

export interface PersonaPromptFrontmatter {
  id: string;
  name: string;
  description?: string;
}

export interface PersonaPrompt {
  id: string;
  name: string;
  description: string;
  systemPromptAdd: string;
  filePath: string;
  origin?: { kind: "agent-plugin"; package: string; version: string };
}

export interface PersonaPromptStoreOptions {
  userDir?: string;
}

export function parsePersonaPromptFrontmatter(raw: string): {
  fm: PersonaPromptFrontmatter;
  body: string;
} {
  const { fields, body } = parseFrontmatterBlock(raw);
  const fm: PersonaPromptFrontmatter = { id: "", name: "" };
  for (const [key, rawValue] of fields) {
    const val = unquoteFrontmatterValue(rawValue);
    if (key === "id") fm.id = val;
    else if (key === "name") fm.name = val;
    else if (key === "description") fm.description = val;
  }
  return { fm, body };
}

export function renderPersonaPromptFile(prompt: Pick<PersonaPrompt, "id" | "name" | "description" | "systemPromptAdd">): string {
  const lines = [
    "---",
    `id: ${prompt.id}`,
    `name: ${prompt.name}`,
  ];
  if (prompt.description.trim()) {
    lines.push(`description: ${prompt.description.trim()}`);
  }
  lines.push("---", "", prompt.systemPromptAdd.trim(), "");
  return lines.join("\n");
}

export class PersonaPromptStore {
  private readonly userDir: string;
  private agentPluginPersonas = new Map<string, PersonaPrompt>();
  private agentPluginTemplates = new Map<string, AgentPluginTemplatePrompt>();

  constructor(opts: PersonaPromptStoreOptions = {}) {
    this.userDir = opts.userDir ?? USER_PROMPTS_NAMESPACE.dir;
  }

  /** Replace package personas from the installed content store's verified bytes. */
  setInstalledAgentPlugins(packages: readonly InstalledAgentPlugin[]): void {
    const next = new Map<string, PersonaPrompt>();
    const nextTemplates = new Map<string, AgentPluginTemplatePrompt>();
    for (const { name: packageName, version, content } of packages) {
      const files = new Map(content.files.map((file) => [file.path, file.data]));
      for (const component of content.components.prompts) {
        const id = `agent-plugin:${packageName}:${component.name}`;
        const bytes = files.get(`ai.agent-connector.ave/prompts/${component.name}.md`);
        if (!bytes) throw new Error(`installed agent plugin prompt ${id} is missing`);
        const { fields, body } = parseFrontmatterBlock(bytes.toString("utf8"));
        if (fields.get("name") !== component.name || fields.get("kind") !== component.kind || !body.trim()
          || Buffer.byteLength(body.trim(), "utf8") > PERSONA_PROMPT_MAX_BODY_BYTES) {
          throw new Error(`installed agent plugin prompt ${id} is invalid`);
        }
        if (component.kind === "persona") {
          if (next.has(id)) throw new Error(`duplicate installed agent plugin persona ${id}`);
          next.set(id, {
            id,
            name: `${component.name} (${packageName})`,
            description: fields.get("description") ?? "",
            systemPromptAdd: body.trim(),
            filePath: `agent-plugin://${packageName}/${component.name}.md`,
            origin: { kind: "agent-plugin", package: packageName, version },
          });
        } else {
          if (nextTemplates.has(id)) throw new Error(`duplicate installed agent plugin template ${id}`);
          nextTemplates.set(id, {
            id, packageName, version, name: component.name,
            description: fields.get("description") ?? "",
            ...(fields.get("argumentHint") ? { argumentHint: fields.get("argumentHint") } : {}),
            body: body.trim(),
          });
        }
      }
    }
    this.agentPluginPersonas = next;
    this.agentPluginTemplates = nextTemplates;
  }

  listTemplates(): AgentPluginTemplatePrompt[] {
    return [...this.agentPluginTemplates.values()];
  }

  async list(): Promise<PersonaPrompt[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.userDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") entries = [];
      else throw err;
    }

    let canonicalDir: string;
    try {
      canonicalDir = await realpath(this.userDir);
    } catch {
      canonicalDir = resolve(this.userDir);
    }

    const prompts: PersonaPrompt[] = [];
    for (const entry of entries) {
      const candidate = this.promptCandidate(entry);
      if (!candidate) continue;
      const { baseId, filePath } = candidate;
      if (!LOCAL_PERSONA_PROMPT_ID.test(baseId)) {
        log.warn(`persona prompt scan: rejected non-allowlist entry: ${entry.name}`);
        continue;
      }

      let canonicalFile: string;
      try {
        canonicalFile = await realpath(join(this.userDir, filePath));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(
            `persona prompt scan: realpath failed for ${filePath}: %s`,
            (err as Error).message,
          );
        }
        continue;
      }
      const rel = relative(canonicalDir, canonicalFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(
          `persona prompt scan: rejected traversal — ${filePath} -> ${canonicalFile} escapes ${canonicalDir}`,
        );
        continue;
      }

      try {
        const raw = await readFile(canonicalFile, "utf-8");
        const { fm, body } = parsePersonaPromptFrontmatter(raw);
        const id = fm.id || baseId;
        if (!LOCAL_PERSONA_PROMPT_ID.test(id) || id === "default") {
          log.warn(
            `persona prompt scan: rejected invalid frontmatter id "${id}" in ${canonicalFile}`,
          );
          continue;
        }
        const name = fm.name.trim() || id;
        const trimmedBody = body.trim();
        if (Buffer.byteLength(trimmedBody, "utf-8") > PERSONA_PROMPT_MAX_BODY_BYTES) {
          log.warn(
            `persona prompt scan: rejected oversized body for ${canonicalFile} (>${PERSONA_PROMPT_MAX_BODY_BYTES} bytes)`,
          );
          continue;
        }
        prompts.push({
          id,
          name: sanitizePersonaName(name),
          description: fm.description?.trim() ?? "",
          systemPromptAdd: trimmedBody,
          filePath: canonicalFile,
        });
      } catch (err) {
        log.warn(
          `persona prompt load failed for ${canonicalFile}: %s`,
          (err as Error).message,
        );
      }
    }

    const byId = new Map<string, PersonaPrompt>();
    for (const prompt of prompts) byId.set(prompt.id, prompt);
    return [...byId.values(), ...this.agentPluginPersonas.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<PersonaPrompt | null> {
    const trimmed = id.trim();
    if (!PERSONA_PROMPT_ID_ALLOWLIST.test(trimmed) || trimmed === "default") {
      throw new Error("invalid persona prompt id");
    }
    if (trimmed.startsWith("agent-plugin:")) return this.agentPluginPersonas.get(trimmed) ?? null;
    return (await this.list()).find((prompt) => prompt.id === trimmed) ?? null;
  }

  async save(input: {
    id: string;
    name: string;
    description?: string;
    systemPromptAdd: string;
  }): Promise<PersonaPrompt> {
    const id = input.id.trim();
    if (!LOCAL_PERSONA_PROMPT_ID.test(id) || id === "default") {
      throw new Error("invalid persona prompt id");
    }
    const name = sanitizePersonaName(input.name);
    const systemPromptAdd = input.systemPromptAdd.trim();
    if (!name) throw new Error("persona prompt name is required");
    if (!systemPromptAdd) throw new Error("persona prompt body is required");
    if (Buffer.byteLength(systemPromptAdd, "utf-8") > PERSONA_PROMPT_MAX_BODY_BYTES) {
      throw new Error(`persona prompt body exceeds ${PERSONA_PROMPT_MAX_BODY_BYTES} bytes`);
    }

    const filePath = join(this.userDir, `${id}.md`);
    const prompt: PersonaPrompt = {
      id,
      name,
      description: input.description?.trim() ?? "",
      systemPromptAdd,
      filePath,
    };
    await writeFileAtomicAtPath(filePath, renderPersonaPromptFile(prompt));
    return prompt;
  }

  async delete(id: string): Promise<boolean> {
    const trimmed = id.trim();
    if (!LOCAL_PERSONA_PROMPT_ID.test(trimmed) || trimmed === "default") {
      throw new Error("invalid persona prompt id");
    }
    const prompt = (await this.list()).find((item) => item.id === trimmed);
    if (!prompt) return false;
    await rm(prompt.filePath);
    return true;
  }

  private promptCandidate(entry: Dirent): { baseId: string; filePath: string } | null {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) return null;
    return {
      baseId: entry.name.replace(/\.md$/i, ""),
      filePath: entry.name,
    };
  }
}

function sanitizePersonaName(value: string): string {
  return value.replace(/[\r\n"\\<>]/g, " ").slice(0, 80).trim();
}
