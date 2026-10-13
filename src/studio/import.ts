import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import AdmZip from "adm-zip";
import { tmpdir } from "node:os";
import { writeFileAtomicAtPath } from "../main/storage/feature-namespace.js";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { AGENT_PLUGINS_SCHEMA_URL } from "../plugins/public-contract.js";
import { parseStrictJson } from "../marketplace/catalog/strict-json.js";
import { MARKETPLACE_DESCRIPTOR_FILE } from "../marketplace/catalog/types.js";
import type { StudioDiagnostic } from "../shared/plugin-studio.js";
import { importLegacyHooks, type ImportedHookEntry } from "../hooks/hook-import-export.js";

export interface ImportedStudioPackage {
  files: Array<{ path: string; data: Buffer }>;
  diagnostics: StudioDiagnostic[];
  pendingHooks: ImportedHookEntry[];
  name: string;
  version?: string;
  description?: string;
}

const COMPONENT = /^[a-z][a-z0-9-]{0,62}$/u;
const MAX_FILES = 256;
const MAX_BYTES = 8 * 1024 * 1024;
const LEGACY_SIDE_PATHS = [".claude-plugin", ".codex-plugin", ".mcp.json", "commands", "agents", "hooks"];
const UNSUPPORTED_KEYS = ["outputStyles", "workflows", "lspServers", "monitors", "themes", "settings", "userConfig", "channels", "dependencies"];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function safeRelative(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$|^\.\//gu, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..") || path.includes("\0")) {
    throw new Error(`invalid package path: ${path}`);
  }
  return normalized;
}

async function regularFile(root: string, relative: string): Promise<Buffer | null> {
  const path = safeRelative(relative);
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) return null;
    if (stat.isSymbolicLink()) throw new Error(`symbolic link in package path: ${path}`);
  }
  const stat = await lstat(current);
  if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
  if (stat.size > MAX_BYTES) throw new Error(`${path} exceeds the package byte limit`);
  return readFile(current);
}

async function filesBelow(root: string, relative: string): Promise<Array<{ path: string; data: Buffer }>> {
  const start = resolve(root, safeRelative(relative));
  if (!start.startsWith(`${resolve(root)}${sep}`)) throw new Error(`path leaves package: ${relative}`);
  let parent = root;
  for (const segment of safeRelative(relative).split("/")) {
    parent = join(parent, segment);
    const stat = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) return [];
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Declared package directory is invalid: ${relative}`);
  }
  const found: Array<{ path: string; data: Buffer }> = [];
  let bytes = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const relativePath = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`symbolic link in package: ${relativePath}`);
      if (entry.isDirectory()) await walk(join(dir, entry.name), relativePath);
      else if (entry.isFile()) {
        const data = await regularFile(root, relativePath);
        if (!data) throw new Error(`${relativePath} disappeared while importing`);
        bytes += data.length;
        found.push({ path: relativePath, data });
        if (found.length > MAX_FILES || bytes > MAX_BYTES) throw new Error("package exceeds file or byte limit");
      } else throw new Error(`non-file package entry: ${relativePath}`);
    }
  };
  await walk(start, safeRelative(relative));
  return found;
}

function diagnostic(group: StudioDiagnostic["group"], path: string, message: string): StudioDiagnostic {
  return { group, path, message };
}

function json(data: Buffer, path: string): Record<string, unknown> {
  return object(parseStrictJson(data.toString("utf8")), path);
}

function promptFile(name: string, content: string, description: string, argumentHint?: string): Buffer {
  if (/[\r\n]/u.test(description) || (argumentHint !== undefined && /[\r\n]/u.test(argumentHint))) {
    throw new Error(`Imported prompt ${name} needs single-line description and argument hint`);
  }
  const body = content.replaceAll("$ARGUMENTS", "{args}");
  return Buffer.from(`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nkind: template\n${argumentHint ? `argumentHint: ${JSON.stringify(argumentHint)}\n` : ""}---\n${body}\n`);
}

function importedCommand(name: string, source: string, sourcePath: string, diagnostics: StudioDiagnostic[],
  description?: string, argumentHint?: string): Buffer {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source);
  const header: Record<string, string> = {};
  for (const line of front?.[1]?.split(/\r?\n/u) ?? []) {
    const match = /^([\w-]+):\s*(.*)$/u.exec(line);
    if (match) header[match[1]!] = match[2]!;
  }
  for (const key of Object.keys(header)) if (!["description", "argument-hint"].includes(key)) {
    diagnostics.push(diagnostic("lost", `${sourcePath}.${key}`, "Frontmatter field is not portable"));
  }
  const body = front ? source.slice(front[0].length) : source;
  if (body.includes("$ARGUMENTS")) diagnostics.push(diagnostic("rewritten", sourcePath, "Argument placeholder became {args}"));
  return promptFile(name, body, description ?? header.description ?? `Imported ${name}`, argumentHint ?? header["argument-hint"]);
}

function translatePlaceholder(value: string): string {
  return value.replaceAll("${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}").replaceAll("${CLAUDE_PLUGIN_DATA}", "${PLUGIN_DATA}");
}

function addFile(files: Map<string, Buffer>, path: string, data: Buffer, diagnostics: StudioDiagnostic[]): void {
  if (files.has(path)) diagnostics.push(diagnostic("rewritten", path, "Later declaration replaced an earlier component"));
  files.set(path, data);
}

async function scanMarkdown(root: string, declaration: unknown, defaultPath: string, additive: boolean): Promise<Array<{ path: string; data: Buffer }>> {
  const paths = declaration === undefined ? [defaultPath]
    : typeof declaration === "string" ? (additive ? [defaultPath, declaration] : [declaration])
      : Array.isArray(declaration) ? (additive ? [defaultPath, ...declaration] : declaration)
        : declaration && typeof declaration === "object" ? (additive ? [defaultPath] : []) : [];
  const out: Array<{ path: string; data: Buffer }> = [];
  for (const raw of paths) {
    if (typeof raw !== "string") throw new Error(`${defaultPath} declaration must be a path`);
    const path = safeRelative(raw);
    if (path.endsWith(".md")) {
      const data = await regularFile(root, path);
      if (data) out.push({ path, data });
    } else out.push(...(await filesBelow(root, path)).filter((file) => file.path.endsWith(".md")));
  }
  return out;
}

function convertMcp(name: string, raw: unknown, diagnostics: StudioDiagnostic[]): Record<string, unknown> | null {
  const server = object(raw, `mcpServers.${name}`);
  const type = server.type;
  const hasCommand = typeof server.command === "string";
  const hasUrl = typeof server.url === "string";
  if (hasCommand && hasUrl) {
    diagnostics.push(diagnostic("lost", `mcpServers.${name}`, "Command and URL are ambiguous; server dropped"));
    return null;
  }
  if (type !== undefined && type !== "stdio" && type !== "http") {
    diagnostics.push(diagnostic("lost", `mcpServers.${name}`, `Unsupported transport ${String(type)}; server dropped`));
    return null;
  }
  if ((!type && !hasCommand && !hasUrl) || (type === "stdio" && !hasCommand) || (type === "http" && !hasUrl)) {
    diagnostics.push(diagnostic("lost", `mcpServers.${name}`, "Server has no matching command or URL"));
    return null;
  }
  const portableType = type === "http" || (!type && hasUrl) ? "streamable-http" : "stdio";
  const result: Record<string, unknown> = { type: portableType };
  for (const key of portableType === "stdio" ? ["command", "args", "env"] : ["url", "headers"]) {
    if (server[key] !== undefined) result[key] = server[key];
  }
  for (const key of Object.keys(server)) {
    if (!["type", "command", "args", "env", "url", "headers"].includes(key)) diagnostics.push(diagnostic("lost", `mcpServers.${name}.${key}`, "Field is not portable"));
  }
  if (portableType === "stdio" && typeof result.command === "string") {
    const original = result.command;
    if (original.startsWith("${CLAUDE_PLUGIN_ROOT}/")) result.command = `./${original.slice("${CLAUDE_PLUGIN_ROOT}/".length)}`;
    else if (original.includes("${")) {
      diagnostics.push(diagnostic("lost", `mcpServers.${name}.command`, "Command placeholder cannot be mapped to a package file"));
      return null;
    }
    if (result.command !== original) diagnostics.push(diagnostic("rewritten", `mcpServers.${name}.command`, "Package command became relative"));
    if (Array.isArray(result.args)) result.args = result.args.map((arg, index) => {
      const rewritten = typeof arg === "string" ? translatePlaceholder(arg) : arg;
      if (rewritten !== arg) diagnostics.push(diagnostic("rewritten", `mcpServers.${name}.args[${index}]`, "Package placeholder changed"));
      return rewritten;
    });
    if (result.env && typeof result.env === "object") result.env = Object.fromEntries(Object.entries(result.env).map(([key, value]) => {
      const rewritten = typeof value === "string" ? translatePlaceholder(value) : value;
      if (rewritten !== value) diagnostics.push(diagnostic("rewritten", `mcpServers.${name}.env.${key}`, "Package placeholder changed"));
      return [key, rewritten];
    }));
  }
  if (type !== portableType) diagnostics.push(diagnostic("rewritten", `mcpServers.${name}.type`, `Transport became ${portableType}`));
  return result;
}

async function mergedDefinition(root: string, paths: readonly string[], declared: unknown, label: string,
  diagnostics: StudioDiagnostic[], sources?: Map<string, string>): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const merge = (value: Record<string, unknown>, from: string): void => {
    for (const [name, definition] of Object.entries(value)) {
      if (Object.hasOwn(merged, name)) diagnostics.push(diagnostic("rewritten", `${label}.${name}`, `Definition from ${from} replaced an earlier one`));
      merged[name] = definition;
      sources?.set(name, from);
    }
  };
  for (const path of paths) {
    const data = await regularFile(root, path);
    if (data) {
      const parsed = json(data, path);
      merge(object(parsed[label] ?? parsed, path), path);
    }
  }
  if (declared !== undefined) {
    const values = Array.isArray(declared) ? declared : [declared];
    for (const [index, value] of values.entries()) {
      if (typeof value === "string") {
        const data = await regularFile(root, value);
        if (!data) throw new Error(`${label} declared file is missing: ${value}`);
        const parsed = json(data, value);
        merge(object(parsed[label] ?? parsed, value), value);
      } else merge(object(value, `${label}[${index}]`), `inline ${index}`);
    }
  }
  return merged;
}

/** Read only canonical files when a portable root is present. */
export async function importStudioPackage(root: string): Promise<ImportedStudioPackage> {
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Import path must be a directory");
  const diagnostics: StudioDiagnostic[] = [];
  const files = new Map<string, Buffer>();
  const pendingHooks: ImportedStudioPackage["pendingHooks"] = [];
  const portable = await regularFile(root, "plugin.json");
  if (portable) {
    const manifest = json(portable, "plugin.json");
    if (manifest.$schema !== AGENT_PLUGINS_SCHEMA_URL) throw new Error("Root plugin.json is not a portable plugin manifest");
    files.set("plugin.json", portable);
    for (const path of ["mcp.json", "LICENSE", "NOTICE", "README.md", "CHANGELOG.md"]) {
      const data = await regularFile(root, path);
      if (data) files.set(path, data);
    }
    for (const prefix of ["skills", "ai.agent-connector.ave", "server"]) {
      for (const file of await filesBelow(root, prefix)) files.set(file.path, file.data);
    }
    const ignored = [];
    for (const path of LEGACY_SIDE_PATHS) if (await lstat(join(root, path)).then(() => true, () => false)) ignored.push(path);
    if (ignored.length) diagnostics.push(diagnostic("rewritten", "plugin.json", `Ignored legacy projection: ${ignored.join(", ")}`));
    return { files: [...files].map(([path, data]) => ({ path, data })), diagnostics, pendingHooks,
      name: String(manifest.name), version: typeof manifest.version === "string" ? manifest.version : undefined,
      description: typeof manifest.description === "string" ? manifest.description : undefined };
  }
  const layout = await regularFile(root, ".claude-plugin/plugin.json") ?? await regularFile(root, ".codex-plugin/plugin.json");
  if (!layout) throw new Error("No plugin found; looked for plugin.json, .claude-plugin/plugin.json, .codex-plugin/plugin.json");
  const manifest = json(layout, "legacy plugin.json");
  if (typeof manifest.name !== "string" || !COMPONENT.test(manifest.name)) throw new Error("Imported plugin needs a valid name");
  const name = manifest.name;
  const version = typeof manifest.version === "string" ? manifest.version : undefined;
  const description = typeof manifest.description === "string" ? manifest.description : undefined;
  const output: Record<string, unknown> = { $schema: AGENT_PLUGINS_SCHEMA_URL, name };
  for (const key of ["version", "description", "author", "homepage", "repository", "license", "keywords"]) if (manifest[key] !== undefined) output[key] = manifest[key];
  if (!version) diagnostics.push(diagnostic("needs-input", "plugin.json.version", "Enter a version; 0.1.0 is suggested"));
  if (!description) diagnostics.push(diagnostic("needs-input", "plugin.json.description", "Enter a description"));
  for (const key of Object.keys(manifest)) {
    if (!["name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills", "commands", "agents", "hooks", "mcpServers"].includes(key)) {
      diagnostics.push(diagnostic("lost", `plugin.json.${key}`, "Field is not imported"));
    }
  }
  for (const key of UNSUPPORTED_KEYS) if (manifest[key] !== undefined && !diagnostics.some((item) => item.path === `plugin.json.${key}`)) diagnostics.push(diagnostic("lost", `plugin.json.${key}`, "Component is not imported"));
  files.set("plugin.json", Buffer.from(`${JSON.stringify(output, null, 2)}\n`));

  const skillPaths = manifest.skills === undefined ? ["skills"] : typeof manifest.skills === "string" ? ["skills", manifest.skills]
    : Array.isArray(manifest.skills) ? ["skills", ...manifest.skills] : ["skills"];
  const skillFiles: Array<{ path: string; data: Buffer; sourceRoot: string }> = [];
  for (const declared of skillPaths) {
    if (typeof declared !== "string") throw new Error("Skill declaration must be a path");
    const sourceRoot = safeRelative(declared);
    if (sourceRoot.endsWith("SKILL.md")) {
      const data = await regularFile(root, sourceRoot);
      if (data) skillFiles.push({ path: sourceRoot, data, sourceRoot: dirname(sourceRoot) });
    } else skillFiles.push(...(await filesBelow(root, sourceRoot)).map((file) => ({ ...file, sourceRoot })));
  }
  const rootSkill = await regularFile(root, "SKILL.md");
  if (rootSkill) skillFiles.push({ path: "SKILL.md", data: rootSkill, sourceRoot: "" });
  for (const file of skillFiles) {
    const relativePath = file.sourceRoot ? relative(file.sourceRoot, file.path).split(sep).join("/") : file.path;
    const segments = relativePath.split("/");
    const skillName = file.path === "SKILL.md" ? name : segments.length > 1 ? segments[0] : basename(file.sourceRoot);
    const suffix = file.path === "SKILL.md" ? "SKILL.md" : segments.length > 1 ? segments.slice(1).join("/") : segments[0];
    if (skillName && COMPONENT.test(skillName) && suffix) addFile(files, `skills/${skillName}/${suffix}`, file.data, diagnostics);
    else diagnostics.push(diagnostic("lost", file.path, "Skill directory name is invalid"));
  }

  const commands = await scanMarkdown(root, manifest.commands, "commands", false);
  for (const file of commands) {
    const promptName = basename(file.path, ".md");
    if (!COMPONENT.test(promptName)) { diagnostics.push(diagnostic("lost", file.path, "Command name is invalid")); continue; }
    addFile(files, `ai.agent-connector.ave/prompts/${promptName}.md`, importedCommand(promptName, file.data.toString("utf8"), file.path, diagnostics), diagnostics);
  }
  if (manifest.commands && typeof manifest.commands === "object" && !Array.isArray(manifest.commands)) {
    for (const [promptName, definition] of Object.entries(manifest.commands)) {
      if (!COMPONENT.test(promptName)) { diagnostics.push(diagnostic("lost", `commands.${promptName}`, "Command name is invalid")); continue; }
      const entry = object(definition, `commands.${promptName}`);
      const source = typeof entry.source === "string" ? await regularFile(root, entry.source) : null;
      const content = typeof entry.content === "string" ? entry.content : source?.toString("utf8");
      if (!content) { diagnostics.push(diagnostic("lost", `commands.${promptName}`, "Command has no source or content")); continue; }
      addFile(files, `ai.agent-connector.ave/prompts/${promptName}.md`, importedCommand(promptName, content,
        typeof entry.source === "string" ? safeRelative(entry.source) : `commands.${promptName}`,
        diagnostics, typeof entry.description === "string" ? entry.description : undefined,
        typeof entry.argumentHint === "string" ? entry.argumentHint : undefined), diagnostics);
    }
  }
  for (const file of await scanMarkdown(root, manifest.agents, "agents", false)) {
    const agentName = basename(file.path, ".md");
    if (!COMPONENT.test(agentName)) { diagnostics.push(diagnostic("lost", file.path, "Agent name is invalid")); continue; }
    const body = file.data.toString("utf8");
    const text = body.startsWith("---") ? body : `---\nname: ${agentName}\ndescription: Imported profile\n---\n${body}`;
    addFile(files, `ai.agent-connector.ave/agents/${agentName}/AGENTS.md`, Buffer.from(text), diagnostics);
  }
  if (manifest.agents && typeof manifest.agents === "object" && !Array.isArray(manifest.agents)) {
    for (const [agentName, definition] of Object.entries(manifest.agents)) {
      if (!COMPONENT.test(agentName)) { diagnostics.push(diagnostic("lost", `agents.${agentName}`, "Agent name is invalid")); continue; }
      const entry = object(definition, `agents.${agentName}`);
      const source = typeof entry.source === "string" ? await regularFile(root, entry.source) : null;
      const content = typeof entry.content === "string" ? entry.content : source?.toString("utf8");
      if (!content) { diagnostics.push(diagnostic("lost", `agents.${agentName}`, "Agent has no source or content")); continue; }
      const text = content.startsWith("---") ? content : `---\nname: ${agentName}\ndescription: Imported profile\n---\n${content}`;
      addFile(files, `ai.agent-connector.ave/agents/${agentName}/AGENTS.md`, Buffer.from(text), diagnostics);
    }
  }
  for (const file of await filesBelow(root, "server")) addFile(files, file.path, file.data, diagnostics);
  const servers = await mergedDefinition(root, [".mcp.json"], manifest.mcpServers, "mcpServers", diagnostics);
  const converted: Record<string, unknown> = {};
  for (const [serverName, definition] of Object.entries(servers)) {
    const result = convertMcp(serverName, definition, diagnostics);
    if (result && typeof result.command === "string" && result.command.startsWith("./") && !(await regularFile(root, result.command.slice(2)))) {
      diagnostics.push(diagnostic("lost", `mcpServers.${serverName}.command`, "Package command file is missing"));
    } else if (result) converted[serverName] = result;
  }
  if (Object.keys(converted).length) files.set("mcp.json", Buffer.from(`${JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: converted }, null, 2)}\n`));
  const isFirstLayout = await regularFile(root, ".claude-plugin/plugin.json") !== null;
  if (isFirstLayout) {
    const sources: Array<{ value: Record<string, unknown>; path: string }> = [];
    const seenPaths = new Set<string>();
    const defaultHooks = await regularFile(root, "hooks/hooks.json");
    if (defaultHooks) {
      const parsed = json(defaultHooks, "hooks/hooks.json");
      sources.push({ value: Object.hasOwn(parsed, "hooks") ? parsed : { hooks: parsed }, path: "hooks/hooks.json" });
      seenPaths.add("hooks/hooks.json");
    }
    if (manifest.hooks !== undefined) {
      for (const [index, declared] of (Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks]).entries()) {
        if (typeof declared === "string") {
          const path = safeRelative(declared);
          if (seenPaths.has(path)) continue;
          const data = await regularFile(root, path);
          if (!data) throw new Error(`hooks declared file is missing: ${declared}`);
          const parsed = json(data, path);
          sources.push({ value: Object.hasOwn(parsed, "hooks") ? parsed : { hooks: parsed }, path });
          seenPaths.add(path);
        } else sources.push({ value: { hooks: object(declared, `hooks[${index}]`) }, path: `inline ${index}` });
      }
    }
    for (const source of sources) {
      const converted = importLegacyHooks(source.value, source.path);
      pendingHooks.push(...converted.entries);
      diagnostics.push(...converted.diagnostics.map((item) => diagnostic(
        item.group === "needs your input" ? "needs-input" : item.group,
        `hooks.${item.entry}`, `${item.sourcePath}: ${item.message}`,
      )));
    }
  }
  return { files: [...files].map(([path, data]) => ({ path, data })), diagnostics, pendingHooks, name, ...(version ? { version } : {}), ...(description ? { description } : {}) };
}

/** Archive import is extracted under a temporary root after path, link and size checks. */
export async function importStudioArchive(path: string): Promise<ImportedStudioPackage> {
  const stat = await lstat(path);
  if (stat.isDirectory()) return importStudioPackage(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !path.toLowerCase().endsWith(".zip")) throw new Error("Select a plugin folder or zip file");
  const bytes = await readFile(path);
  if (bytes.length > MAX_BYTES) throw new Error("Plugin archive exceeds the byte limit");
  const zip = new AdmZip(bytes);
  const entries = zip.getEntries();
  const rootManifest = entries.find((entry) => entry.entryName === "plugin.json" && !entry.isDirectory);
  const portable = rootManifest && rootManifest.header.size < 256 * 1024
    && json(rootManifest.getData(), "plugin.json").$schema === AGENT_PLUGINS_SCHEMA_URL;
  const ignored: string[] = [];
  const scratch = await mkdtemp(join(tmpdir(), "ave-studio-import-"));
  try {
    let total = 0;
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const name = safeRelative(entry.entryName);
      if ((entry.attr >>> 16 & 0o170000) === 0o120000) throw new Error(`Archive link is not allowed: ${name}`);
      if (portable && !(name === "plugin.json" || name === "mcp.json" || name === MARKETPLACE_DESCRIPTOR_FILE
        || ["LICENSE", "NOTICE", "README.md", "CHANGELOG.md"].includes(name)
        || name.startsWith("skills/") || name.startsWith("ai.agent-connector.ave/") || name.startsWith("server/"))) {
        ignored.push(name);
        continue;
      }
      const data = entry.getData();
      total += data.length;
      count += 1;
      if (count > MAX_FILES || total > MAX_BYTES) throw new Error("Plugin archive exceeds its limits");
      await writeFileAtomicAtPath(join(scratch, ...name.split("/")), data);
    }
    const imported = await importStudioPackage(scratch);
    if (ignored.length) imported.diagnostics.push(diagnostic("rewritten", "plugin.json", `Ignored legacy projection: ${ignored.join(", ")}`));
    return imported;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
