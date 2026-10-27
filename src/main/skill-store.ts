// Flat and directory skills share the skillComponent contract in schemas/skill-package.schema.json. Both standalone and plugin-bundled delivery must
// preserve its fields; seeded skills remain user-editable.
import { readFile, readdir, realpath, stat, open } from "node:fs/promises";
import { closeSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute, dirname, basename, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../lib/logger.js";
import { aveHome } from "../shared/ave-home.js";
import { AGENT_PLUGIN_SKILL_SELECTOR_PATTERN, parseAgentPluginSkillSelector, PLUGIN_SKILL_SELECTOR_PATTERN } from "../shared/plugin-skill-selector.js";
import type { InstalledAgentPlugin } from "../marketplace/content/service.js";
import type { ActivePluginGeneration } from "../plugins/plugin-generation-coordinator.js";
import type { MaterializedPluginContribution } from "../plugins/plugin-contributions.js";
const log = createLogger("ave");

// Skill names use the schema’s path-safe charset; reject traversal and control characters at the filesystem boundary.
// Publication owns the length ceiling; the host deliberately does not re-police it.
export const SKILL_NAME_ALLOWLIST = /^[a-zA-Z0-9_-]+$/;

// Bound keyword hints at record construction so every catalog consumer shares one token budget.
export const MAX_SKILL_TRIGGERS = 8;
export const MAX_SKILL_TRIGGER_CHARS = 48;

// Cap the declared hints in count and length; order and spelling are kept.
function boundedTriggers(triggers: readonly string[] | undefined): readonly string[] {
  if (!triggers || triggers.length === 0) return Object.freeze([]);
  return Object.freeze(
    triggers.slice(0, MAX_SKILL_TRIGGERS).map((trigger) =>
      trigger.length > MAX_SKILL_TRIGGER_CHARS ? trigger.slice(0, MAX_SKILL_TRIGGER_CHARS) : trigger,
    ),
  );
}
// Built from the ONE selector pattern (src/shared/plugin-skill-selector.ts), so the catalog, `skill_load`/`skill_read`, and the turn-scope gate cannot drift.
const PLUGIN_SKILL_SELECTOR_ALLOWLIST = new RegExp(`^${PLUGIN_SKILL_SELECTOR_PATTERN}$`);
const AGENT_PLUGIN_SKILL_SELECTOR_ALLOWLIST = new RegExp(`^${AGENT_PLUGIN_SKILL_SELECTOR_PATTERN}$`);
export const SKILL_SELECTOR_ALLOWLIST = new RegExp(
  `^(?:[a-zA-Z0-9_-]+|${PLUGIN_SKILL_SELECTOR_PATTERN}|${AGENT_PLUGIN_SKILL_SELECTOR_PATTERN})$`,
);

// C2(e): skills with a body larger than this are refused at load time.
export const SKILL_MAX_BODY_BYTES = 8 * 1024;

// Cap bundled skill scans, manifests, and on-demand reads so untrusted resources cannot flood prompts or context.
const SKILL_RESOURCE_MAX_BYTES = 256 * 1024;
const SKILL_RESOURCE_COUNT_CAP = 64;
const SKILL_RESOURCE_DEPTH_CAP = 4;
const SKILL_RESOURCE_SCAN_LIMIT = 256;
const SKILL_RESOURCE_PATH_MAX_CHARS = 256;

// Resource names enter both filesystem paths and trusted guidance; reject traversal, absolute paths, backslashes, ADS colons, controls, and fence metacharacters.
function isSafeResourcePath(resourcePath: string): boolean {
  if (typeof resourcePath !== "string") return false;
  if (resourcePath.length === 0 || resourcePath.length > SKILL_RESOURCE_PATH_MAX_CHARS) return false;
  for (const char of resourcePath) {
    const code = char.codePointAt(0) ?? 0;
    // Control characters (a newline in a filename would inject extra lines into the trusted overlay), plus fence/path metacharacters.
    if (code <= 0x1f || code === 0x7f) return false;
    if (char === "<" || char === ">" || char === "\\" || char === ":") return false;
  }
  if (isAbsolute(resourcePath) || resourcePath.startsWith("/")) return false;
  const segments = resourcePath.split("/");
  if (segments.length > SKILL_RESOURCE_DEPTH_CAP) return false;
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertSafeResourcePath(resourcePath: string): void {
  if (!isSafeResourcePath(resourcePath)) {
    throw new Error("rejected unsafe skill resource path");
  }
}

// Does a `relative()` result leave its root? Checked precisely: a plain `startsWith("..")` would also reject a legitimate `..notes.md` filename.
function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

// skill_read decodes text as UTF-8; reject NUL-bearing binary content rather than returning corrupted bytes.
function assertTextResource(content: string, resourcePath: string): void {
  if (content.includes("\u0000")) {
    throw new Error(`resource is not UTF-8 text: ${resourcePath}`);
  }
}

// One bundled file next to a skill's SKILL.md. Metadata only — never content.
export interface SkillResourceRef {
  // Skill-root-relative POSIX path (never `SKILL.md`).
  path: string;
  bytes: number;
}

// Content of one bundled resource, returned by `skill_read`.
export interface SkillResourceContent {
  path: string;
  content: string;
  bytes: number;
}

// Preserve every declared skillComponent field on both delivery paths, including trigger hints.
export interface SkillFrontmatter {
  name: string;
  description?: string;
  // Keyword hints, surfaced on the catalog the model reads.
  triggers?: string[];
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  // Space-delimited tools the skill declares itself pre-approved to use. Carried and surfaced; NOT enforced — the permission layer is unchanged by this
  // field, and a skill cannot widen its own reach by declaring it.
  allowedTools?: string;
}

function materializedSkill(
  generation: ActivePluginGeneration,
  contribution: MaterializedPluginContribution,
): LoadedSkill {
  const entryPath = `${contribution.path}/SKILL.md`;
  const entry = contribution.files.find((file) => file.path === entryPath);
  if (!entry) throw new Error(`materialized Skill '${contribution.localId}' is missing SKILL.md`);
  const { fm, body } = parseFrontmatter(entry.content);
  const trimmedBody = body.trim();
  if (Buffer.byteLength(trimmedBody, "utf-8") > SKILL_MAX_BODY_BYTES) {
    throw new Error(`materialized Skill '${contribution.localId}' exceeds ${SKILL_MAX_BODY_BYTES} bytes`);
  }
  const owner: PluginSkillOwner = Object.freeze({
    pluginId: generation.pluginId,
    pluginVersion: generation.pluginVersion,
    generationId: generation.generationId,
    localId: contribution.localId,
    fingerprint: contribution.fingerprint,
  });
  const selector = `plugin:${owner.pluginId}:${owner.localId}`;
  // Stage-3 manifest, derived with ZERO filesystem access: the generation's files are already materialized + sha256-verified in memory, so the manifest is
  // metadata over trusted bytes. `SKILL.md` itself is never a resource.
  const prefix = `${contribution.path}/`;
  const resources: SkillResourceRef[] = [];
  for (const file of contribution.files) {
    if (resources.length >= SKILL_RESOURCE_COUNT_CAP) break;
    if (file.path === entryPath || !file.path.startsWith(prefix)) continue;
    const relPath = file.path.slice(prefix.length);
    if (!isSafeResourcePath(relPath)) continue;
    const bytes = Buffer.byteLength(file.content, "utf-8");
    if (bytes > SKILL_RESOURCE_MAX_BYTES) continue;
    resources.push(Object.freeze({ path: relPath, bytes }));
  }
  return Object.freeze({
    name: selector,
    description: fm.description ?? "",
    ...skillComponentFields(fm),
    body: trimmedBody,
    filePath: `plugin://${owner.pluginId}/${owner.localId}/SKILL.md`,
    approvalKey: [owner.pluginId, owner.pluginVersion, owner.generationId, owner.localId, owner.fingerprint].join("|"),
    pluginOwner: owner,
    resources: Object.freeze(resources),
  });
}

// Project parsed front matter onto the fields a skill record carries. One function so the plugin path and the user-directory path cannot drift into
// keeping different subsets.
function skillComponentFields(fm: SkillFrontmatter): SkillComponentFields {
  const fields: SkillComponentFields = { triggers: boundedTriggers(fm.triggers) };
  if (fm.license !== undefined) fields.license = fm.license;
  if (fm.compatibility !== undefined) fields.compatibility = fm.compatibility;
  if (fm.metadata !== undefined) fields.metadata = fm.metadata;
  if (fm.allowedTools !== undefined) fields.allowedTools = fm.allowedTools;
  return fields;
}

// Use one metadata shape for disk-loaded and plugin-provided skills so neither delivery path drops fields.
interface SkillComponentFields {
  // Keyword hints the author declared; empty when the header carries none.
  triggers: readonly string[];
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  // Declared, surfaced, and NOT enforced — see {@link SkillFrontmatter}.
  allowedTools?: string;
}

export interface LoadedSkill extends SkillComponentFields {
  name: string;
  description: string;
  body: string;
  filePath: string;
  // Exact cache/approval identity for plugin-owned materialized bytes.
  approvalKey?: string;
  pluginOwner?: PluginSkillOwner;
  agentPluginOwner?: { packageName: string; version: string; digest: string };
  // Bundled files shipped next to SKILL.md (stage-3). Metadata only — contents load on demand through `skill_read`. Always present; empty for flat skills.
  resources: readonly SkillResourceRef[];
}

// Catalog rows carry bounded selection hints for the skill’s lifetime; other fields stay available on the loaded skill.
export interface SkillCatalogEntry {
  name: string;
  description: string;
  triggers: readonly string[];
  pluginOwner?: PluginSkillOwner;
}

interface PluginSkillOwner {
  pluginId: string;
  pluginVersion: string;
  generationId: string;
  localId: string;
  fingerprint: string;
}

export interface PreparedPluginSkillGeneration {
  readonly pluginId: string;
  readonly generationId: string;
  publish(): void;
}

interface SkillCatalogRecord extends SkillCatalogEntry {
  baseName: string;
  filePath: string;
}

const userSkillsDir = (): string => resolve(aveHome(), "skills");
const SKILL_CATALOG_SCAN_LIMIT = 256;
const SKILL_FRONTMATTER_READ_BYTES = 16 * 1024;
const SKILL_CATALOG_DESCRIPTION_MAX_CHARS = 1024;

export interface FrontmatterBlock {
  // `key` → the raw text after the colon (untrimmed, quotes intact). Last key wins.
  fields: ReadonlyMap<string, string>;
  // The block between the `---` fences, verbatim; empty when there is none.
  block: string;
  // Everything after the closing `---`; the whole input when there is no block.
  body: string;
}

// Return both scalar fields for simple headers and verbatim frontmatter for structured mappings such as metadata.
export function parseFrontmatterBlock(raw: string): FrontmatterBlock {
  const fmRegex = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;
  const match = raw.match(fmRegex);
  const fields = new Map<string, string>();
  if (!match) {
    return { fields, block: "", body: raw };
  }
  const [full, block] = match;
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    fields.set(m[1], m[2]);
  }
  return { fields, block, body: raw.slice(full.length) };
}

// Accept YAML string sequences and legacy inline/comma-separated lists; drop non-string entries instead of coercing them.
export function parseFrontmatterStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner
    .split(",")
    .map(unquoteFrontmatterValue)
    .filter((s) => s.length > 0);
}

// Trim a frontmatter scalar and unwrap one pair of surrounding quotes (single or double).
export function unquoteFrontmatterValue(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

// Use YAML for structured frontmatter; malformed headers refuse loading.
// Ignore undeclared keys so newly published fields do not break installed skills on older hosts.
export function parseFrontmatter(raw: string): {
  fm: SkillFrontmatter;
  body: string;
} {
  const { fields, block, body } = parseFrontmatterBlock(raw);
  const fm: SkillFrontmatter = { name: "" };
  const parsed: unknown = block.length > 0 ? parseYaml(block) : undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { fm, body };
  const doc = parsed as Record<string, unknown>;

  const scalar = (key: string): string | undefined => {
    const value = doc[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    warnOnShortenedScalar(key, fields.get(key), trimmed, doc.name);
    return trimmed;
  };

  const name = scalar("name");
  if (name !== undefined) fm.name = name;
  const description = scalar("description");
  if (description !== undefined) fm.description = description;
  if (doc.triggers !== undefined) fm.triggers = parseFrontmatterStringList(doc.triggers);
  const license = scalar("license");
  if (license !== undefined) fm.license = license;
  const compatibility = scalar("compatibility");
  if (compatibility !== undefined) fm.compatibility = compatibility;
  if (doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)) {
    fm.metadata = doc.metadata as Record<string, unknown>;
  }
  // The schema spells this key `allowed-tools`; the TS field is camel-cased because the rest of this record is, and the hyphen is not addressable.
  const allowedTools = scalar("allowed-tools");
  if (allowedTools !== undefined) fm.allowedTools = allowedTools;
  return { fm, body };
}

// Warn when YAML truncates an unquoted scalar at a comment marker; retain YAML’s authoritative value and skip comparisons for quoted scalars.
function warnOnShortenedScalar(
  key: string,
  rawLine: string | undefined,
  parsedValue: string,
  skillName: unknown,
): void {
  if (rawLine === undefined) return;
  const raw = rawLine.trim();
  if (raw.startsWith('"') || raw.startsWith("'")) return;
  if (raw === parsedValue) return;
  const label = typeof skillName === "string" && skillName.length > 0 ? skillName : "<unnamed>";
  log.warn(
    `skill frontmatter: '${key}' of "${label}" read as ${JSON.stringify(parsedValue)}, ` +
      `but the line carries ${JSON.stringify(raw)} — an unquoted '#' starts a YAML ` +
      `comment; quote the value to keep it whole`,
  );
}

export interface SkillStoreOptions {
  // Override user-skills directory.
  userDir?: string;
  // Read-only packaged directory skills; user and installed skills take precedence.
  bundledDir?: string;
}

export class SkillStore {
  private readonly userDir: string;
  private readonly bundledDir: string | undefined;
  private pluginSkills = new Map<string, LoadedSkill>();
  private agentPluginSkills = new Map<string, LoadedSkill>();
  private agentPluginResources = new Map<string, ReadonlyMap<string, Buffer>>();
  // User skills shadow installed packages of the same name, including skills added after package installation.
  private packageDirs = new Map<string, string>();

  constructor(opts: SkillStoreOptions = {}) {
    this.userDir = opts.userDir ?? userSkillsDir();
    this.bundledDir = opts.bundledDir;
  }

  // Replace the installed skill packages; the installed-content service calls this after each load.
  setInstalledPackages(packages: ReadonlyArray<{ name: string; dir: string }>): void {
    this.packageDirs = new Map(packages.filter((item) => SKILL_NAME_ALLOWLIST.test(item.name)).map((item) => [item.name, item.dir]));
  }

  // Publish skills from already-verified package bytes; this replaces the prior package snapshot.
  setInstalledAgentPlugins(packages: readonly InstalledAgentPlugin[]): void {
    const next = new Map<string, LoadedSkill>();
    const nextResources = new Map<string, ReadonlyMap<string, Buffer>>();
    for (const { name: packageName, version, content } of packages) {
      const files = new Map(content.files.map((file) => [file.path, file.data]));
      for (const component of content.components.skills) {
        const selector = `agent-plugin:${packageName}:${component.name}`;
        const root = `skills/${component.name}/`;
        const entry = files.get(`${root}SKILL.md`);
        if (!entry) throw new Error(`installed agent plugin skill ${selector} is missing SKILL.md`);
        const { fm, body } = parseFrontmatter(entry.toString("utf8"));
        if (fm.name !== component.name || !fm.description || !body.trim()
          || Buffer.byteLength(body.trim(), "utf8") > SKILL_MAX_BODY_BYTES) {
          throw new Error(`installed agent plugin skill ${selector} has invalid frontmatter`);
        }
        const resources = new Map<string, Buffer>();
        const refs: SkillResourceRef[] = [];
        for (const [path, data] of files) {
          if (!path.startsWith(root) || path === `${root}SKILL.md`) continue;
          const resourcePath = path.slice(root.length);
          if (!isSafeResourcePath(resourcePath) || data.length > SKILL_RESOURCE_MAX_BYTES || refs.length >= SKILL_RESOURCE_COUNT_CAP) continue;
          resources.set(resourcePath, data);
          refs.push(Object.freeze({ path: resourcePath, bytes: data.length }));
        }
        const owner = Object.freeze({ packageName, version, digest: component.digest });
        if (next.has(selector)) throw new Error(`duplicate installed agent plugin skill ${selector}`);
        next.set(selector, Object.freeze({
          name: selector,
          description: fm.description,
          ...skillComponentFields(fm),
          body: body.trim(),
          filePath: `agent-plugin://${packageName}/${component.name}/SKILL.md`,
          approvalKey: `${selector}|${version}|${component.digest}`,
          agentPluginOwner: owner,
          resources: Object.freeze(refs),
        }));
        nextResources.set(selector, resources);
      }
    }
    this.agentPluginSkills = next;
    this.agentPluginResources = nextResources;
  }

  readAgentPluginResource(selector: string, owner: NonNullable<LoadedSkill["agentPluginOwner"]>, path: string): SkillResourceContent | null {
    assertSafeResourcePath(path);
    const current = this.agentPluginSkills.get(selector)?.agentPluginOwner;
    if (!current || current.packageName !== owner.packageName || current.version !== owner.version || current.digest !== owner.digest) {
      throw new Error("skill package changed since load; call skill_load again");
    }
    const data = this.agentPluginResources.get(selector)?.get(path);
    if (!data) return null;
    const content = data.toString("utf8");
    assertTextResource(content, path);
    return { path, content, bytes: data.length };
  }

  // The SKILL.md of an installed package, realpath-contained in its directory; null when absent or escaping.
  private async packageSkillFile(dir: string): Promise<string | null> {
    try {
      const canonicalDir = await realpath(dir);
      const canonicalFile = await realpath(join(dir, "SKILL.md"));
      return escapesRoot(relative(canonicalDir, canonicalFile)) ? null : canonicalFile;
    } catch (err) {
      log.warn(`skill package unreadable at ${dir}: %s`, (err as Error).message);
      return null;
    }
  }

  private async loadPackageSkill(name: string, dir: string): Promise<LoadedSkill | null> {
    const file = await this.packageSkillFile(dir);
    if (!file) return null;
    try {
      return await this.loadFile(file, name);
    } catch (err) {
      log.warn(`skill package load failed for ${name}: %s`, (err as Error).message);
      return null;
    }
  }

  // The file of the user's own skill with this name, or null: an installed package of that name would never apply.
  async userSkillFile(name: string): Promise<string | null> {
    return (await this.scanDir(this.userDir)).find((skill) => skill.name === name)?.filePath ?? null;
  }

  // List user skills, then installed package skills a user skill does not shadow, then plugin skills.
  async list(): Promise<LoadedSkill[]> {
    const out = await this.scanDir(this.userDir);
    const byName = new Map<string, LoadedSkill>();
    for (const s of out) byName.set(s.name, s);
    for (const [name, dir] of this.packageDirs) {
      if (byName.has(name)) continue;
      const skill = await this.loadPackageSkill(name, dir);
      if (skill) byName.set(name, skill);
    }
    if (this.bundledDir) {
      for (const skill of await this.scanDir(this.bundledDir)) {
        if (basename(skill.filePath) === "SKILL.md" && !byName.has(skill.name)) byName.set(skill.name, skill);
      }
    }
    return [...byName.values(), ...this.pluginSkills.values(), ...this.agentPluginSkills.values()];
  }

  // Synchronous lightweight catalog for prompt assembly. It returns only metadata; skill bodies stay behind `skill_load` and the approval gate.
  listCatalogSync(): SkillCatalogEntry[] {
    const out = this.scanCatalogDirSync(this.userDir);
    const byName = new Map<string, SkillCatalogEntry>();
    for (const s of out) {
      byName.set(s.name, {
        name: s.name,
        description: s.description,
        triggers: s.triggers,
      });
    }
    for (const [name, dir] of this.packageDirs) {
      if (byName.has(name)) continue;
      try {
        const canonicalDir = realpathSync(dir);
        const canonicalFile = realpathSync(join(dir, "SKILL.md"));
        if (escapesRoot(relative(canonicalDir, canonicalFile))) continue;
        const fm = readFrontmatterSync(canonicalFile);
        byName.set(name, {
          name: resolveSkillName(name, fm),
          description: normalizeCatalogDescription(fm.description ?? ""),
          triggers: boundedTriggers(fm.triggers),
        });
      } catch (err) {
        log.warn(`skill catalog: package ${name} unreadable: %s`, (err as Error).message);
      }
    }
    if (this.bundledDir) {
      for (const skill of this.scanCatalogDirSync(this.bundledDir)) {
        if (basename(skill.filePath) === "SKILL.md" && !byName.has(skill.name)) {
          byName.set(skill.name, { name: skill.name, description: skill.description, triggers: skill.triggers });
        }
      }
    }
    return [
      ...byName.values(),
      ...[...this.pluginSkills.values()].map((skill) => ({
        name: skill.name,
        description: skill.description,
        triggers: skill.triggers,
        pluginOwner: skill.pluginOwner,
      })),
      ...[...this.agentPluginSkills.values()].map((skill) => ({
        name: skill.name,
        description: skill.description,
        triggers: skill.triggers,
      })),
    ];
  }

  async load(name: string): Promise<LoadedSkill | null> {
    if (AGENT_PLUGIN_SKILL_SELECTOR_ALLOWLIST.test(name)) {
      const selector = parseAgentPluginSkillSelector(name);
      return selector ? this.agentPluginSkills.get(name) ?? null : null;
    }
    if (PLUGIN_SKILL_SELECTOR_ALLOWLIST.test(name)) {
      return this.pluginSkills.get(name) ?? null;
    }
    if (!SKILL_NAME_ALLOWLIST.test(name)) return null;
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(this.userDir);
    } catch {
      canonicalDir = resolve(this.userDir);
    }
    const candidates = [
      join(this.userDir, name, "SKILL.md"),
      join(this.userDir, `${name}.md`),
    ];
    const loaded: LoadedSkill[] = [];
    for (const filePath of candidates) {
      let canonicalFile: string;
      try {
        canonicalFile = await realpath(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(`skill load: realpath failed for ${filePath}: %s`, (err as Error).message);
        }
        continue;
      }
      const rel = relative(canonicalDir, canonicalFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(`skill load: rejected traversal — ${filePath} -> ${canonicalFile} escapes ${canonicalDir}`);
        continue;
      }
      try {
        loaded.push(await this.loadFile(canonicalFile, name));
      } catch (err) {
        log.warn(`skill load failed for ${filePath}: %s`, (err as Error).message);
      }
    }
    if (loaded.length > 1) {
      log.warn(`skill load: duplicate skill id "${name}" exists as both directory and flat file; refusing ambiguous load`);
      return null;
    }
    if (loaded[0]) return loaded[0];
    const packageDir = this.packageDirs.get(name);
    if (packageDir) return this.loadPackageSkill(name, packageDir);
    return this.bundledDir
      ? (await this.scanDir(this.bundledDir)).find((skill) => skill.name === name && basename(skill.filePath) === "SKILL.md") ?? null
      : null;
  }

  // Resolve a plugin Skill only from an already-admitted immutable generation.
  loadPluginGeneration(generation: ActivePluginGeneration, selector: string): LoadedSkill | null {
    const prefix = `plugin:${generation.pluginId}:`;
    if (!selector.startsWith(prefix)) return null;
    const localId = selector.slice(prefix.length);
    const contribution = generation.contributions.find(
      (entry) => entry.kind === "skill" && entry.localId === localId,
    );
    return contribution ? materializedSkill(generation, contribution) : null;
  }

  // Read only exact paths from the frozen generation manifest, already hash-verified at install; never reread plugin resources from disk.
  readPluginResource(
    generation: ActivePluginGeneration,
    selector: string,
    resourcePath: string,
  ): SkillResourceContent | null {
    const prefix = `plugin:${generation.pluginId}:`;
    if (!selector.startsWith(prefix)) return null;
    const localId = selector.slice(prefix.length);
    const contribution = generation.contributions.find(
      (entry) => entry.kind === "skill" && entry.localId === localId,
    );
    if (!contribution) return null;
    assertSafeResourcePath(resourcePath);
    const entryPath = `${contribution.path}/SKILL.md`;
    const full = `${contribution.path}/${resourcePath}`;
    if (full === entryPath) return null; // SKILL.md is the body, not a resource
    const file = contribution.files.find((candidate) => candidate.path === full);
    if (!file) return null;
    const bytes = Buffer.byteLength(file.content, "utf-8");
    if (bytes > SKILL_RESOURCE_MAX_BYTES) {
      throw new Error(`skill resource exceeds ${SKILL_RESOURCE_MAX_BYTES} bytes`);
    }
    assertTextResource(file.content, resourcePath);
    return { path: resourcePath, content: file.content, bytes };
  }

  // Refuse flat-file skill bundles before filesystem access; using the shared skills root would make one approval authorize sibling files.
  async readUserResource(
    skill: Pick<LoadedSkill, "filePath"> & { pluginOwner?: LoadedSkill["pluginOwner"] },
    resourcePath: string,
  ): Promise<SkillResourceContent> {
    if (skill.pluginOwner) throw new Error("plugin skill resources load through readPluginResource");
    assertSafeResourcePath(resourcePath);
    const skillDir = dirname(skill.filePath);
    // Every filesystem resolution below runs inside a try: a raw ENOENT would otherwise carry the absolute host path into the error text, which `skill_read`
    // returns verbatim to the model.
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(skillDir);
    } catch (err) {
      // Log the true cause locally (EACCES vs ENOENT vs ELOOP); the model only ever sees the sanitized text.
      log.warn(`skill resources: skill directory unresolvable: %s`, (err as Error).message);
      throw new Error(`skill directory unavailable for resource: ${resourcePath}`);
    }
    if (!(await this.isBundleRoot(canonicalDir, basename(skill.filePath)))) {
      throw new Error("flat skills have no bundled resources");
    }
    let canonicalFile: string;
    try {
      canonicalFile = await realpath(join(skillDir, resourcePath));
    } catch (err) {
      log.warn("skill resources: resolve failed: %s", (err as Error).message);
      throw new Error(`resource not found: ${resourcePath}`);
    }
    const rel = relative(canonicalDir, canonicalFile);
    if (escapesRoot(rel)) {
      throw new Error("skill resource escapes its skill directory");
    }
    if (rel.split(sep).join("/") === "SKILL.md") {
      throw new Error("SKILL.md is the skill body, not a resource");
    }
    // Bind the size check and the read to ONE file handle: re-opening by path after `stat` leaves a swap window (mirrors the fd-bound read in `tools/file-tools.ts`).
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(canonicalFile, "r");
    } catch (err) {
      log.warn("skill resources: open failed: %s", (err as Error).message);
      throw new Error(`resource not found: ${resourcePath}`);
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("skill resource is not a regular file");
      // A hardlink can name an out-of-tree inode from inside the directory, so containment alone would not hold — the plugin ingest path rejects `nlink > 1` for the same reason.
      if (info.nlink > 1) throw new Error("skill resource is a hardlink");
      if (info.size > SKILL_RESOURCE_MAX_BYTES) {
        throw new Error(`skill resource exceeds ${SKILL_RESOURCE_MAX_BYTES} bytes`);
      }
      const content = await handle.readFile("utf-8");
      assertTextResource(content, resourcePath);
      return { path: resourcePath, content, bytes: info.size };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  // Bundle roots must be direct skill-directory children, never the shared root or a symlink back to it; approval cannot become transitive.
  private async isBundleRoot(canonicalDir: string, entryFileName: string): Promise<boolean> {
    if (entryFileName !== "SKILL.md") return false;
    // An installed package's own directory is its skill's bundle.
    for (const dir of this.packageDirs.values()) {
      try {
        if ((await realpath(dir)) === canonicalDir) return true;
      } catch {
        // A package directory that is gone owns nothing.
      }
    }
    if (this.bundledDir) {
      try {
        const rootRel = relative(await realpath(this.bundledDir), canonicalDir);
        if (rootRel !== "" && !escapesRoot(rootRel) && rootRel.split(sep).length === 1) return true;
      } catch {
        // Absent packaged resources own no bundles.
      }
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.userDir);
    } catch {
      canonicalRoot = resolve(this.userDir);
    }
    const rootRel = relative(canonicalRoot, canonicalDir);
    if (rootRel === "" || escapesRoot(rootRel)) return false;
    return rootRel.split(sep).length === 1;
  }

  // Publish materialized Skill bytes for exactly one active plugin generation.
  publishPluginGeneration(generation: ActivePluginGeneration): void {
    this.preparePluginGeneration(generation).publish();
  }

  // Parse and prebuild the complete Skill snapshot before durable commit.
  preparePluginGeneration(generation: ActivePluginGeneration): PreparedPluginSkillGeneration {
    const skills: LoadedSkill[] = [];
    for (const contribution of generation.contributions) {
      if (contribution.kind !== "skill") continue;
      // A malformed contributed skill drops only that skill; duplicate selectors still fail the generation because its declarations contradict each other.
      let skill: LoadedSkill;
      try {
        skill = materializedSkill(generation, contribution);
      } catch (err) {
        log.warn(
          `plugin Skill '${generation.pluginId}:${contribution.localId}' skipped: %s`,
          (err as Error).message,
        );
        continue;
      }
      skills.push(skill);
    }
    // Selectors are plugin-scoped, so this refuses only a generation that contradicts itself. Publish applies `skills` to the live catalog, which keeps any
    // plugin published while this one awaited its commit.
    this.pluginSkillsWith(generation.pluginId, skills);
    let published = false;
    return Object.freeze({
      pluginId: generation.pluginId,
      generationId: generation.generationId,
      publish: () => {
        if (published) return;
        this.pluginSkills = this.pluginSkillsWith(generation.pluginId, skills);
        published = true;
      },
    });
  }

  // The live plugin catalog with `pluginId`'s Skills replaced by `skills`.
  private pluginSkillsWith(pluginId: string, skills: readonly LoadedSkill[]): Map<string, LoadedSkill> {
    const next = new Map(this.pluginSkills);
    for (const [selector, skill] of next) {
      if (skill.pluginOwner?.pluginId === pluginId) next.delete(selector);
    }
    for (const skill of skills) {
      if (next.has(skill.name)) {
        throw new Error(`duplicate plugin Skill selector: ${skill.name}`);
      }
      next.set(skill.name, skill);
    }
    return next;
  }

  // Exact plugin catalog removal, applied to the live catalog at publish; leased overlays keep their body.
  preparePluginRemoval(pluginId: string, generationId: string): PreparedPluginSkillGeneration {
    let published = false;
    return Object.freeze({
      pluginId,
      generationId,
      publish: () => {
        if (published) return;
        const next = new Map(this.pluginSkills);
        for (const [selector, skill] of next) {
          if (skill.pluginOwner?.pluginId === pluginId && skill.pluginOwner.generationId === generationId) {
            next.delete(selector);
          }
        }
        this.pluginSkills = next;
        published = true;
      },
    });
  }

  // Remove one retired generation without touching user/global skill files.
  removePluginGeneration(pluginId: string, generationId: string): void {
    for (const [selector, skill] of this.pluginSkills) {
      if (skill.pluginOwner?.pluginId === pluginId && skill.pluginOwner.generationId === generationId) {
        this.pluginSkills.delete(selector);
      }
    }
  }

  removePlugin(pluginId: string): void {
    for (const [selector, skill] of this.pluginSkills) {
      if (skill.pluginOwner?.pluginId === pluginId) this.pluginSkills.delete(selector);
    }
  }

  private async scanDir(dir: string): Promise<LoadedSkill[]> {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    // Resolve the scan root once and confine each realpath against it; if the root cannot resolve, use the supplied directory consistently.
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(dir);
    } catch {
      canonicalDir = resolve(dir);
    }

    const skills: LoadedSkill[] = [];
    for (const entry of entries) {
      const candidate = this.skillCandidate(dir, entry);
      if (!candidate) continue;
      const { baseName, filePath } = candidate;
      // C2(b): allowlist on filename — reject anything with `/`, `..`, NUL, or other disallowed characters before opening the file.
      if (!SKILL_NAME_ALLOWLIST.test(baseName)) {
        log.warn(`skill scan: rejected non-allowlist entry: ${entry.name}`);
        continue;
      }
      // C2(a): resolve the entry's real path and verify it stays inside the (real) skills directory. Symlinks pointing outside (e.g. `evil.md → /etc/passwd`) are rejected here.
      let canonicalFile: string;
      try {
        canonicalFile = await realpath(filePath);
      } catch (err) {
        log.warn(
          `skill scan: realpath failed for ${filePath}: %s`,
          (err as Error).message,
        );
        continue;
      }
      const rel = relative(canonicalDir, canonicalFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(
          `skill scan: rejected traversal — ${filePath} -> ${canonicalFile} escapes ${canonicalDir}`,
        );
        continue;
      }
      try {
        skills.push(await this.loadFile(canonicalFile, baseName));
      } catch (err) {
        log.warn(
          `skill load failed for ${filePath}: %s`,
          (err as Error).message,
        );
      }
    }
    return skills;
  }

  private async loadFile(canonicalFile: string, baseName: string): Promise<LoadedSkill> {
    const raw = await readFile(canonicalFile, "utf-8");
    const { fm, body } = parseFrontmatter(raw);
    const name = resolveSkillName(baseName, fm);
    const trimmedBody = body.trim();
    // C2(e): cap body length so a malicious skill cannot blow up the system prompt or chew up tokens. 8 KB is generous for a markdown skill and tight enough
    // that abuse is bounded.
    if (Buffer.byteLength(trimmedBody, "utf-8") > SKILL_MAX_BODY_BYTES) {
      throw new Error(`rejected oversized body (>${SKILL_MAX_BODY_BYTES} bytes)`);
    }
    // Stage-3: only the directory layout (`<name>/SKILL.md`) owns a bundle directory. A flat `<name>.md` skill has no directory of its own — its parent IS
    // the shared skills root — so it never carries resources.
    const skillDir = dirname(canonicalFile);
    const resources = (await this.isBundleRoot(skillDir, basename(canonicalFile)))
      ? await this.listSkillResources(skillDir)
      : [];
    return {
      name,
      description: fm.description ?? "",
      ...skillComponentFields(fm),
      body: trimmedBody,
      filePath: canonicalFile,
      resources,
    };
  }

  // Resources must be realpath-contained, path-safe, size-capped, and bounded by depth/count/scan limits.
  // Broken bundles yield no resources without making the skill unloadable.
  private async listSkillResources(skillDir: string): Promise<SkillResourceRef[]> {
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(skillDir);
    } catch {
      return [];
    }
    const found: SkillResourceRef[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: canonicalDir, depth: 0 }];
    // Canonical paths already visited. A symlink cycle (`loop -> .`) otherwise re-emits the same file until the caps fill up, crowding real resources out of
    // both the manifest and the trusted overlay.
    const seen = new Set<string>([canonicalDir]);
    let scanned = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      if (found.length >= SKILL_RESOURCE_COUNT_CAP || scanned >= SKILL_RESOURCE_SCAN_LIMIT) break;
      let entries: Array<import("node:fs").Dirent>;
      try {
        entries = await readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (found.length >= SKILL_RESOURCE_COUNT_CAP || scanned >= SKILL_RESOURCE_SCAN_LIMIT) break;
        scanned += 1;
        const childPath = join(current.dir, entry.name);
        let canonicalChild: string;
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          // realpath + stat resolve symlinks; the containment check below then rejects anything whose real location escapes the skill directory.
          canonicalChild = await realpath(childPath);
          info = await stat(canonicalChild);
        } catch {
          continue;
        }
        const rel = relative(canonicalDir, canonicalChild);
        if (escapesRoot(rel)) {
          log.warn(`skill resources: skipped ${childPath} — escapes ${canonicalDir}`);
          continue;
        }
        if (seen.has(canonicalChild)) continue;
        seen.add(canonicalChild);
        if (info.isDirectory()) {
          if (current.depth + 1 < SKILL_RESOURCE_DEPTH_CAP) {
            queue.push({ dir: canonicalChild, depth: current.depth + 1 });
          }
          continue;
        }
        if (!info.isFile()) continue;
        // A hardlink can name an out-of-tree inode from inside the directory, so containment alone would not hold (the plugin ingest path rejects `nlink > 1` for the same reason).
        if (info.nlink > 1) continue;
        const posixRel = rel.split(sep).join("/");
        if (posixRel === "SKILL.md") continue;
        if (!isSafeResourcePath(posixRel)) {
          log.warn(`skill resources: skipped an unsafe resource filename under ${canonicalDir}`);
          continue;
        }
        if (info.size > SKILL_RESOURCE_MAX_BYTES) continue;
        found.push(Object.freeze({ path: posixRel, bytes: info.size }));
      }
    }
    return found;
  }

  private scanCatalogDirSync(dir: string, limit = SKILL_CATALOG_SCAN_LIMIT): SkillCatalogRecord[] {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    let canonicalDir: string;
    try {
      canonicalDir = realpathSync(dir);
    } catch {
      canonicalDir = resolve(dir);
    }

    const skills: SkillCatalogRecord[] = [];
    const sortedEntries = entries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const limitedEntries = Number.isFinite(limit)
      ? sortedEntries.slice(0, limit)
      : sortedEntries;
    if (Number.isFinite(limit) && entries.length > limit) {
      log.warn(
        `skill catalog: scanned first ${limit} entries out of ${entries.length}`,
      );
    }

    for (const entry of limitedEntries) {
      const candidate = this.skillCandidate(dir, entry);
      if (!candidate) continue;
      const { baseName, filePath } = candidate;
      if (!SKILL_NAME_ALLOWLIST.test(baseName)) {
        log.warn(`skill catalog: rejected non-allowlist entry: ${entry.name}`);
        continue;
      }

      let canonicalFile: string;
      try {
        canonicalFile = realpathSync(filePath);
      } catch (err) {
        log.warn(
          `skill catalog: realpath failed for ${filePath}: %s`,
          (err as Error).message,
        );
        continue;
      }
      const rel = relative(canonicalDir, canonicalFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(
          `skill catalog: rejected traversal — ${filePath} -> ${canonicalFile} escapes ${canonicalDir}`,
        );
        continue;
      }

      try {
        const fm = readFrontmatterSync(canonicalFile);
        const name = resolveSkillName(baseName, fm);
        skills.push({
          name,
          description: normalizeCatalogDescription(fm.description ?? ""),
          triggers: boundedTriggers(fm.triggers),
          baseName,
          filePath: canonicalFile,
        });
      } catch (err) {
        log.warn(
          `skill catalog failed for ${filePath}: %s`,
          (err as Error).message,
        );
      }
    }
    return skills;
  }

  private skillCandidate(
    dir: string,
    entry: import("node:fs").Dirent,
  ): { baseName: string; filePath: string } | null {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      return {
        baseName: entry.name.replace(/\.md$/i, ""),
        filePath: join(dir, entry.name),
      };
    }
    if (entry.isDirectory()) {
      return {
        baseName: entry.name,
        filePath: join(dir, entry.name, "SKILL.md"),
      };
    }
    return null;
  }
}

function readFrontmatterSync(filePath: string): SkillFrontmatter {
  const buf = Buffer.alloc(SKILL_FRONTMATTER_READ_BYTES);
  const fd = openSync(filePath, "r");
  try {
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const raw = buf.toString("utf-8", 0, bytes);
    const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (!match) return { name: "" };
    return parseFrontmatter(`---\n${match[1]}\n---\n`).fm;
  } finally {
    closeSync(fd);
  }
}

function resolveSkillName(baseName: string, fm: SkillFrontmatter): string {
  const name = fm.name || baseName;
  // C2(b): frontmatter may not redefine the canonical skill id. This keeps catalog metadata and `skill_load({skillName})` pointed at the same file and
  // avoids duplicate-alias ambiguity.
  if (name !== baseName) {
    throw new Error(`frontmatter name "${name}" must match skill id "${baseName}"`);
  }
  if (!SKILL_NAME_ALLOWLIST.test(name)) {
    throw new Error(`rejected non-allowlist frontmatter name "${name}"`);
  }
  return name;
}

function normalizeCatalogDescription(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").trim();
  if (oneLine.length <= SKILL_CATALOG_DESCRIPTION_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, SKILL_CATALOG_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}
