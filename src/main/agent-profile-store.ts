/**
 * AgentProfileStore — user-defined sub-agent profile discovery.
 *
 * Profiles live under `~/.ave/agents/` as markdown files with frontmatter.
 * Supported layouts:
 *   - `~/.ave/agents/<name>.md`
 *   - `~/.ave/agents/<name>/AGENTS.md`
 *
 * The body is used as the sub-agent profile prompt when `agent_spawn` is
 * invoked with `agentName`.
 */
import { readFile, readdir, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import type { Dirent } from "node:fs";
import { createLogger } from "../lib/logger.js";
import type { InstalledAgentPlugin } from "../marketplace/content/service.js";
import { aveHome } from "../shared/ave-home.js";
import {
  parseFrontmatterBlock,
  parseFrontmatterStringList,
  unquoteFrontmatterValue,
} from "./skill-store.js";

const log = createLogger("ave");

export const AGENT_NAME_ALLOWLIST = /^[a-zA-Z0-9_-]+$/;
const AGENT_PROFILE_MAX_BODY_BYTES = 16 * 1024;

export interface AgentProfileFrontmatter {
  name: string;
  description?: string;
  tools?: string[];
  triggers?: string[];
  model?: string;
  mode?: string;
}

export interface LoadedAgentProfile {
  name: string;
  description: string;
  sourceTools: string[];
  triggers: string[];
  model?: string;
  mode?: string;
  body: string;
  filePath: string;
}

export interface AgentProfileStoreOptions {
  userDir?: string;
}

const userAgentsDir = (): string => resolve(aveHome(), "agents");

export function parseAgentFrontmatter(raw: string): {
  fm: AgentProfileFrontmatter;
  body: string;
} {
  const { fields, body } = parseFrontmatterBlock(raw);
  const fm: AgentProfileFrontmatter = { name: "" };
  for (const [key, rawValue] of fields) {
    const val = unquoteFrontmatterValue(rawValue);
    if (key === "name") fm.name = val;
    else if (key === "description") fm.description = val;
    else if (key === "model") fm.model = val;
    else if (key === "mode") fm.mode = val;
    else if (key === "tools") fm.tools = parseFrontmatterStringList(rawValue);
    else if (key === "triggers") fm.triggers = parseFrontmatterStringList(rawValue);
  }
  return { fm, body };
}

export class AgentProfileStore {
  private readonly userDir: string;
  /** Agent profiles installed as marketplace packages: name → the package directory holding AGENTS.md. A user profile of the same name wins. */
  private packageDirs = new Map<string, string>();
  private agentPluginProfiles = new Map<string, LoadedAgentProfile>();

  constructor(opts: AgentProfileStoreOptions = {}) {
    this.userDir = opts.userDir ?? userAgentsDir();
  }

  /** Replace the installed agent packages; the installed-content service calls this after each load. */
  setInstalledPackages(packages: ReadonlyArray<{ name: string; dir: string }>): void {
    this.packageDirs = new Map(packages.filter((item) => AGENT_NAME_ALLOWLIST.test(item.name)).map((item) => [item.name, item.dir]));
  }

  /** Replace profiles supplied by verified agent plugin package bytes. */
  setInstalledAgentPlugins(packages: readonly InstalledAgentPlugin[]): void {
    const next = new Map<string, LoadedAgentProfile>();
    for (const { name: packageName, content } of packages) {
      const files = new Map(content.files.map((file) => [file.path, file.data]));
      for (const component of content.components.agents) {
        const selector = `agent-plugin:${packageName}:${component.name}`;
        const bytes = files.get(`ai.agent-connector.ave/agents/${component.name}/AGENTS.md`);
        if (!bytes) throw new Error(`installed agent plugin profile ${selector} is missing AGENTS.md`);
        const { fm, body } = parseAgentFrontmatter(bytes.toString("utf8"));
        if (fm.name !== component.name || !body.trim()
          || Buffer.byteLength(body.trim(), "utf8") > AGENT_PROFILE_MAX_BODY_BYTES) {
          throw new Error(`installed agent plugin profile ${selector} has invalid frontmatter`);
        }
        if (next.has(selector)) throw new Error(`duplicate installed agent plugin profile ${selector}`);
        next.set(selector, {
          name: selector,
          description: fm.description ?? "",
          sourceTools: fm.tools?.filter((tool) => AGENT_NAME_ALLOWLIST.test(tool)) ?? [],
          triggers: fm.triggers ?? [],
          model: fm.model,
          mode: fm.mode,
          body: body.trim(),
          filePath: `agent-plugin://${packageName}/${component.name}/AGENTS.md`,
        });
      }
    }
    this.agentPluginProfiles = next;
  }

  private async readProfile(realFile: string, baseName: string): Promise<LoadedAgentProfile | null> {
    const raw = await readFile(realFile, "utf-8");
    const { fm, body } = parseAgentFrontmatter(raw);
    const name = fm.name || baseName;
    if (!AGENT_NAME_ALLOWLIST.test(name)) {
      log.warn(`agent profile scan: rejected non-allowlist frontmatter name "${name}" in ${realFile}`);
      return null;
    }
    const trimmedBody = body.trim();
    if (Buffer.byteLength(trimmedBody, "utf-8") > AGENT_PROFILE_MAX_BODY_BYTES) {
      log.warn(`agent profile scan: rejected oversized body for ${realFile} (>${AGENT_PROFILE_MAX_BODY_BYTES} bytes)`);
      return null;
    }
    return {
      name,
      description: fm.description ?? "",
      sourceTools: fm.tools?.filter((t) => AGENT_NAME_ALLOWLIST.test(t)) ?? [],
      triggers: fm.triggers ?? [],
      model: fm.model,
      mode: fm.mode,
      body: trimmedBody,
      filePath: realFile,
    };
  }

  /** The AGENTS.md of an installed package, realpath-contained in its directory. */
  private async readPackageProfile(name: string, dir: string): Promise<LoadedAgentProfile | null> {
    try {
      const realDir = await realpath(dir);
      const realFile = await realpath(join(dir, "AGENTS.md"));
      const rel = relative(realDir, realFile);
      if (rel.startsWith("..") || isAbsolute(rel)) return null;
      const profile = await this.readProfile(realFile, name);
      return profile && profile.name === name ? profile : null;
    } catch (err) {
      log.warn(`agent package ${name} unreadable: %s`, (err as Error).message);
      return null;
    }
  }

  /** User agents, then installed package agents a user agent does not shadow. */
  async list(): Promise<LoadedAgentProfile[]> {
    const byName = new Map<string, LoadedAgentProfile>();
    for (const profile of await this.listUser()) byName.set(profile.name, profile);
    for (const [name, dir] of this.packageDirs) {
      if (byName.has(name)) continue;
      const profile = await this.readPackageProfile(name, dir);
      if (profile) byName.set(name, profile);
    }
    return [...byName.values(), ...this.agentPluginProfiles.values()];
  }

  /** The file of the user's own agent with this name, or null: an installed package of that name would never apply. */
  async userProfileFile(name: string): Promise<string | null> {
    return (await this.listUser()).find((profile) => profile.name === name)?.filePath ?? null;
  }

  private async listUser(): Promise<LoadedAgentProfile[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.userDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    let realDir: string;
    try {
      realDir = await realpath(this.userDir);
    } catch {
      realDir = resolve(this.userDir);
    }

    const profiles: LoadedAgentProfile[] = [];
    for (const entry of entries) {
      const candidate = this.agentCandidate(entry);
      if (!candidate) continue;
      const { baseName, filePath } = candidate;
      if (!AGENT_NAME_ALLOWLIST.test(baseName)) {
        log.warn(`agent profile scan: rejected non-allowlist entry: ${entry.name}`);
        continue;
      }

      let realFile: string;
      try {
        realFile = await realpath(join(this.userDir, filePath));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(
            `agent profile scan: realpath failed for ${filePath}: %s`,
            (err as Error).message,
          );
        }
        continue;
      }
      const rel = relative(realDir, realFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(
          `agent profile scan: rejected traversal — ${filePath} -> ${realFile} escapes ${realDir}`,
        );
        continue;
      }

      try {
        const profile = await this.readProfile(realFile, baseName);
        if (profile) profiles.push(profile);
      } catch (err) {
        log.warn(
          `agent profile load failed for ${realFile}: %s`,
          (err as Error).message,
        );
      }
    }

    return profiles;
  }

  async load(name: string): Promise<LoadedAgentProfile | null> {
    if (name.startsWith("agent-plugin:")) return this.agentPluginProfiles.get(name) ?? null;
    if (!AGENT_NAME_ALLOWLIST.test(name)) return null;
    const all = await this.list();
    return all.find((a) => a.name === name) ?? null;
  }

  private agentCandidate(entry: Dirent): { baseName: string; filePath: string } | null {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      return {
        baseName: entry.name.replace(/\.md$/i, ""),
        filePath: entry.name,
      };
    }
    if (entry.isDirectory()) {
      return {
        baseName: entry.name,
        filePath: join(entry.name, "AGENTS.md"),
      };
    }
    return null;
  }
}
