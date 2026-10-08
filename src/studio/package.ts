import AdmZip from "adm-zip";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { checkContentFiles } from "../marketplace/content/rules.js";
import { deriveAgentPluginComponents } from "../marketplace/content/agent-plugin-components.js";
import { validateDescriptorText } from "../marketplace/catalog/validate.js";
import { parseStrictJson } from "../marketplace/catalog/strict-json.js";
import type { PackageDescriptor } from "../marketplace/catalog/types.js";
import { parsePortableMcp } from "../mcp/portable-mcp.js";
import { treeDigest } from "../marketplace/resolve/plugin-ladder.js";
import type { AgentPluginFile } from "../marketplace/content/agent-plugin-components.js";
import { parseHookConfig } from "../hooks/hook-config.js";
import { exportLegacyHooks } from "../hooks/hook-import-export.js";
import { containsStoredCredential } from "../mcp/studio-credential-guard.js";

const MAX_FILES = 257;
const MAX_BYTES = 8 * 1024 * 1024 + 256 * 1024;

export function studioFileText(data: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text) ? null : text;
  } catch { return null; }
}

function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid package file path: ${path}`);
  }
  return path;
}

function pretty(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }

function studioDescriptor(files: readonly AgentPluginFile[]): PackageDescriptor {
  const manifestBytes = files.find((file) => file.path === "plugin.json")?.data;
  if (!manifestBytes) throw new Error("plugin.json is missing");
  const manifest = parseStrictJson(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const components = deriveAgentPluginComponents(files);
  const descriptor: PackageDescriptor = {
    schemaVersion: 2, kind: "agent-plugin", name: String(manifest.name), version: String(manifest.version),
    minAppVersion: "0.13.0", description: String(manifest.description),
    payload: { manifest: "plugin.json", components },
  };
  const checked = validateDescriptorText(JSON.stringify(descriptor), { direct: true });
  if (!checked.ok) throw new Error(checked.error);
  return checked.value;
}

function projection(files: readonly AgentPluginFile[]): AgentPluginFile[] {
  const map = new Map(files.map((file) => [file.path, file.data]));
  const manifest = parseStrictJson(map.get("plugin.json")!.toString("utf8")) as Record<string, unknown>;
  const projected: AgentPluginFile[] = [{ path: ".claude-plugin/plugin.json", data: pretty(Object.fromEntries(
    ["name", "version", "description", "author"].filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]),
  )) }];
  for (const file of files) {
    const prompt = /^xyz\.ave\/prompts\/([a-z][a-z0-9-]*)\.md$/u.exec(file.path);
    if (prompt) {
      const text = file.data.toString("utf8");
      const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(text);
      if (/\bkind:\s*template\b/u.test(front?.[1] ?? "")) {
        const description = /^description:\s*(.*)$/mu.exec(front?.[1] ?? "")?.[1] ?? "";
        const hint = /^argumentHint:\s*(.*)$/mu.exec(front?.[1] ?? "")?.[1];
        const header = `---\ndescription: ${description}\n${hint ? `argument-hint: ${hint}\n` : ""}---\n`;
        projected.push({ path: `commands/${prompt[1]}.md`, data: Buffer.from(`${header}${text.slice(front?.[0].length ?? 0).replaceAll("{args}", "$ARGUMENTS")}`) });
      }
    }
    const agent = /^xyz\.ave\/agents\/([a-z][a-z0-9-]*)\/AGENTS\.md$/u.exec(file.path);
    if (agent) projected.push({ path: `agents/${agent[1]}.md`, data: Buffer.from(file.data) });
  }
  const mcp = map.get("mcp.json");
  if (mcp) {
    const document = parsePortableMcp(mcp);
    const servers: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(document.mcpServers)) {
      const converted = { ...server } as Record<string, unknown>;
      delete converted.type;
      if (server.type === "stdio") {
        converted.command = server.command.startsWith("./") ? `\${CLAUDE_PLUGIN_ROOT}/${server.command.slice(2)}` : server.command;
        if (server.args) converted.args = server.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}").replaceAll("${PLUGIN_DATA}", "${CLAUDE_PLUGIN_DATA}"));
        if (server.env) converted.env = Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, value.replaceAll("${PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}").replaceAll("${PLUGIN_DATA}", "${CLAUDE_PLUGIN_DATA}")]));
      }
      servers[name] = converted;
    }
    projected.push({ path: ".mcp.json", data: pretty({ mcpServers: servers }) });
  }
  const hooks = map.get("ai.agent-connector.ave/hooks.json");
  if (hooks) {
    const parsed = parseHookConfig(parseStrictJson(hooks.toString("utf8")), { bundled: true });
    if (parsed.errors.length || parsed.warnings.length) throw new Error(`Studio hook export is invalid: ${[...parsed.errors, ...parsed.warnings].join("; ")}`);
    const legacy = exportLegacyHooks(parsed.entries);
    projected.push({ path: "hooks/hooks.json", data: pretty({ hooks: legacy.hooks }) });
    projected.push({ path: "hooks/PROTOCOL.md", data: Buffer.from(`${legacy.notice}\n`) });
  }
  return projected;
}

function assertNoStoredCredentials(files: readonly AgentPluginFile[], storedCredentials: readonly string[]): void {
  if (!storedCredentials.some(Boolean)) return;
  for (const file of files) {
    const text = file.data.toString("utf8");
    for (const credential of storedCredentials) {
      if (credential && (file.data.includes(Buffer.from(credential)) || containsStoredCredential(text, credential))) {
        throw new Error(`Studio cannot export a stored credential in ${file.path}`);
      }
    }
    if (!file.path.endsWith(".json")) continue;
    const decoded = parseStrictJson(text);
    if (storedCredentials.some((credential) => containsStoredCredential(decoded, credential))) {
      throw new Error(`Studio cannot export a stored credential in ${file.path}`);
    }
  }
}

/** Exported files always include the canonical package and a checked descriptor. */
export function studioExportFiles(files: readonly AgentPluginFile[], legacyProjection: boolean,
  storedCredentials: readonly string[]): AgentPluginFile[] {
  checkContentFiles("agent-plugin", files);
  const descriptor = studioDescriptor(files);
  const output = [...files, { path: "ave-package.json", data: pretty(descriptor) }];
  const exported = legacyProjection ? [...output, ...projection(files)] : output;
  assertNoStoredCredentials(exported, storedCredentials);
  return exported;
}

export function studioZip(files: readonly AgentPluginFile[]): Buffer {
  const zip = new AdmZip();
  for (const file of files) zip.addFile(safePath(file.path), file.data, "", file.executable === true ? 0o755 : 0o644);
  return zip.toBuffer();
}

async function fromDirectory(root: string): Promise<AgentPluginFile[]> {
  const files: AgentPluginFile[] = [];
  let size = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = safePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link in package: ${path}`);
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else if (entry.isFile()) {
        const full = join(dir, entry.name);
        const data = await readFile(full);
        const executable = ((await lstat(full)).mode & 0o111) !== 0;
        files.push({ path, data, ...(executable ? { executable } : {}) });
        size += data.length;
        if (files.length > MAX_FILES || size > MAX_BYTES) throw new Error("Package exceeds file or byte limit");
      } else throw new Error(`Non-file package entry: ${path}`);
    }
  };
  await walk(root, "");
  return files;
}

/** File selection is done by the host; no path from a plugin frame reaches this reader. */
export async function readLocalAgentPlugin(path: string): Promise<{ files: AgentPluginFile[]; descriptor: PackageDescriptor; treeDigest: string }> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error("A package file cannot be a symbolic link");
  let all: AgentPluginFile[];
  if (stat.isDirectory()) all = await fromDirectory(path);
  else if (stat.isFile() && basename(path).toLowerCase().endsWith(".zip")) {
    const bytes = await readFile(path);
    if (bytes.length > MAX_BYTES) throw new Error("Archive exceeds package byte limit");
    const zip = new AdmZip(bytes);
    all = [];
    let size = 0;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const entryPath = safePath(entry.entryName);
      if ((entry.attr >>> 16 & 0o170000) === 0o120000) throw new Error(`Archive contains a symbolic link: ${entryPath}`);
      if (/^\.(?:claude|codex)-plugin\//u.test(entryPath) || entryPath === ".mcp.json"
        || /^(?:commands|agents|hooks)\//u.test(entryPath)) continue;
      const data = entry.getData();
      size += data.length;
      if (all.length >= MAX_FILES || size > MAX_BYTES) throw new Error("Archive exceeds file or byte limit");
      const executable = (entry.attr >>> 16 & 0o111) !== 0;
      all.push({ path: entryPath, data, ...(executable ? { executable } : {}) });
    }
  } else throw new Error("Select a package directory or zip file");
  const descriptorBytes = all.find((file) => file.path === "ave-package.json")?.data;
  const files = all.filter((file) => file.path !== "ave-package.json" && !/^\.(?:claude|codex)-plugin\//u.test(file.path)
    && file.path !== ".mcp.json" && !/^(?:commands|agents|hooks)\//u.test(file.path));
  checkContentFiles("agent-plugin", files);
  const descriptor = descriptorBytes ? (() => {
    const checked = validateDescriptorText(descriptorBytes.toString("utf8"), { direct: true });
    if (!checked.ok) throw new Error(checked.error);
    return checked.value;
  })() : studioDescriptor(files);
  if (descriptor.kind !== "agent-plugin") throw new Error("Selected file is not an agent plugin");
  const components = deriveAgentPluginComponents(files, { name: descriptor.name, version: descriptor.version, minAppVersion: descriptor.minAppVersion });
  if (JSON.stringify(descriptor.payload.components) !== JSON.stringify(components)) throw new Error("Package descriptor components differ from the files");
  return { files, descriptor, treeDigest: treeDigest(files.map((file) => ({ ...file, executable: file.executable === true }))) };
}
