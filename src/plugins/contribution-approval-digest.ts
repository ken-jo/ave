// Approval covers the declaration, anchored commands and whole package tree, normalizing only the top-level version value.
// Unpinned or indeterminate execution closures return null and always require review.
import { createHash } from "node:crypto";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { canonicalStringify } from "../shared/canonical-json.js";
import { parseHookConfig } from "../hooks/hook-config.js";
import { isBundledPathLikeToken } from "./plugin-bundled-command.js";
import { resolvePluginContributionDeclarations } from "./plugin-contributions.js";
import { flattenAgentPluginsManifest } from "./public-contract.js";

export interface PayloadFile {
  /** Package-relative POSIX path. */
  path: string;
  data: Buffer;
  executable?: boolean;
}

type ApprovalClosure =
  | { kind: "package"; treeSha256: string }
  | { kind: "launcher"; spec: string; treeSha256: string }
  | { kind: "remote" };

export interface ApprovalComponent {
  /** The static fingerprint of the declaring file (an extension) or the component digest (an agent plugin). */
  declaration: string;
  /** Package-relative directory a relative command path is read from ("" = the package root). */
  baseDir: string;
  transport: "stdio" | "http";
  /** Each command line the component runs (a hook file may hold several), with environment values appended. */
  argvs: readonly (readonly string[])[];
}

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function skipWhitespace(text: string, at: number): number {
  let i = at;
  while (i < text.length && JSON_WHITESPACE.has(text[i]!)) i += 1;
  return i;
}

/** Return the index past the opening-quote-delimited JSON string. */
function stringEnd(text: string, at: number): number {
  let i = at + 1;
  while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** Input is already valid JSON; return the index after the value. */
function valueEnd(text: string, at: number): number {
  const first = text[at];
  if (first === '"') return stringEnd(text, at);
  if (first === "{" || first === "[") {
    let depth = 0;
    let i = at;
    do {
      const char = text[i];
      if (char === '"') {
        i = stringEnd(text, i);
        continue;
      }
      if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") depth -= 1;
      i += 1;
    } while (depth > 0);
    return i;
  }
  let i = at;
  while (i < text.length && !JSON_WHITESPACE.has(text[i]!) && text[i] !== "," && text[i] !== "}" && text[i] !== "]") i += 1;
  return i;
}

/** Find the sole top-level string version, excluding quotes; duplicates, nonstrings and nonobjects return null. */
function versionValueSpan(text: string): { start: number; end: number } | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
  const found: Array<{ start: number; end: number; isString: boolean }> = [];
  let i = skipWhitespace(text, 0) + 1;
  i = skipWhitespace(text, i);
  while (text[i] === '"') {
    const keyEnd = stringEnd(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    const start = skipWhitespace(text, skipWhitespace(text, keyEnd) + 1);
    const end = valueEnd(text, start);
    if (key === "version") found.push({ start: start + 1, end: end - 1, isString: text[start] === '"' });
    i = skipWhitespace(text, end);
    if (text[i] !== ",") break;
    i = skipWhitespace(text, i + 1);
  }
  const only = found.length === 1 ? found[0]! : null;
  return only && only.isString ? { start: only.start, end: only.end } : null;
}

// Empty only the sole top-level version string; preserve every other byte.
// Invalid JSON or non-UTF-8 content is hashed unchanged.
function comparedBytes(file: PayloadFile): Buffer {
  if (file.path !== "plugin.json") return file.data;
  const text = file.data.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(file.data)) return file.data;
  const span = versionValueSpan(text);
  return span ? Buffer.from(text.slice(0, span.start) + text.slice(span.end), "utf8") : file.data;
}

/** Hash byte-sorted "<mode> <sha256> <path>\n" records with the same version normalization. */
export function payloadTreeSha256(files: readonly PayloadFile[]): string {
  const lines = files
    .map((file) => ({ key: Buffer.from(file.path, "utf8"), line: `${file.executable === true ? "100755" : "100644"} ${sha256Hex(comparedBytes(file))} ${file.path}\n` }))
    .sort((a, b) => Buffer.compare(a.key, b.key));
  const hash = createHash("sha256");
  for (const { line } of lines) hash.update(line, "utf8");
  return hash.digest("hex");
}

const NON_CODE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".json"]);

export const AGENT_PLUGIN_DECLARATION_PATHS: readonly string[] = ["mcp.json", "ai.agent-connector.ave/hooks.json"];

export function extensionDeclarationPaths(manifestDocument: unknown): string[] {
  return resolvePluginContributionDeclarations(flattenAgentPluginsManifest(manifestDocument))
    .filter((declaration) => declaration.kind === "hook" || declaration.kind === "mcpServer")
    .map((declaration) => declaration.path);
}

/** Declarations and non-version manifest changes are code changes; the code/data split is display-only. */
export function changedPayloadFiles(before: readonly PayloadFile[], after: readonly PayloadFile[], declaring: ReadonlySet<string>): { code: string[]; nonCode: string[] } {
  const digests = (files: readonly PayloadFile[]) => new Map(files.map((file) => [file.path, `${file.executable === true ? "x" : "-"}${sha256Hex(comparedBytes(file))}`]));
  const left = digests(before);
  const right = digests(after);
  const changed = [...new Set([...left.keys(), ...right.keys()])].filter((path) => left.get(path) !== right.get(path)).sort();
  const code: string[] = [];
  const nonCode: string[] = [];
  for (const path of changed) {
    const extension = posix.extname(path).toLowerCase();
    if (path !== "plugin.json" && !declaring.has(path) && NON_CODE_EXTENSIONS.has(extension)) nonCode.push(path);
    else code.push(path);
  }
  return { code, nonCode };
}

const PINNED_NPM = /^(@[^/@\s]+\/)?[^@\s/]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const PINNED_PYPI = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?(?:==|@)\d+(?:\.\d+)*(?:[-.+]?[0-9A-Za-z.]+)?$/u;
const PINNED_IMAGE = /@sha256:[a-f0-9]{64}$/u;

function commandName(command: string): string {
  return posix.basename(command.replace(/\\/gu, "/"));
}

function firstOperand(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

/** Return an immutable launcher spec, { spec: null } for an unpinned launcher, or null for a non-launcher. */
export function launcherSpec(argv: readonly string[]): { spec: string | null } | null {
  const [command, ...args] = argv;
  if (command === undefined) return null;
  switch (commandName(command)) {
    case "npx":
    case "bunx": {
      const spec = firstOperand(args);
      return { spec: spec !== undefined && PINNED_NPM.test(spec) ? spec : null };
    }
    case "uvx": {
      const spec = firstOperand(args);
      return { spec: spec !== undefined && PINNED_PYPI.test(spec) ? spec : null };
    }
    case "pipx": {
      if (args[0] !== "run") return null;
      const spec = firstOperand(args.slice(1));
      return { spec: spec !== undefined && PINNED_PYPI.test(spec) ? spec : null };
    }
    case "docker": {
      if (args[0] !== "run") return null;
      // Flags take values (`-e KEY=value`), so the image is the argument pinned by digest, or there is none.
      const image = args.slice(1).find((arg) => PINNED_IMAGE.test(arg));
      return { spec: image ?? null };
    }
    default:
      return null;
  }
}

/** Return null for a nonpath token and undefined for a path outside the package closure. */
function anchoredPath(token: string, baseDir: string, files: ReadonlyMap<string, PayloadFile>): string | null | undefined {
  if (token.startsWith("${PLUGIN_DATA}")) return null;
  let relative: string;
  if (token.startsWith("${PLUGIN_ROOT}/")) relative = token.slice("${PLUGIN_ROOT}/".length);
  else if (isBundledPathLikeToken(token)) {
    if (token.startsWith("~") || token.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(token) || token.includes("\\")) return undefined;
    relative = posix.join(baseDir, token);
  } else return null;
  const normalized = posix.normalize(relative);
  if (normalized.startsWith("../") || normalized === ".." || posix.isAbsolute(normalized)) return undefined;
  return files.has(normalized) ? normalized : undefined;
}

export function approvalDigest(component: ApprovalComponent, files: readonly PayloadFile[]): string | null {
  const byPath = new Map(files.map((file) => [file.path, file]));
  let closure: ApprovalClosure;
  const anchored: string[] = [];
  if (component.transport === "http") {
    closure = { kind: "remote" };
  } else {
    if (component.argvs.length === 0) return null;
    const treeSha256 = payloadTreeSha256(files);
    let launcher: string | null = null;
    for (const [entry, argv] of component.argvs.entries()) {
      const spec = launcherSpec(argv);
      if (spec !== null) {
        if (spec.spec === null) return null;
        launcher = launcher === null ? spec.spec : `${launcher}\n${spec.spec}`;
      }
      for (const [index, token] of argv.entries()) {
        // The launcher's registry spec (`@scope/pkg@1.2.3`, `image@sha256:…`) names no package file.
        if (spec !== null && token === spec.spec) continue;
        const path = anchoredPath(token, component.baseDir, byPath);
        if (path === undefined) return null;
        if (path === null) continue;
        anchored.push(`${entry}:${index}\0${path}\0${sha256Hex(byPath.get(path)!.data)}`);
      }
    }
    if (launcher !== null) closure = { kind: "launcher", spec: launcher, treeSha256 };
    // A command that names no package file and is no launcher is a command type this digest does not name.
    else if (anchored.length > 0) closure = { kind: "package", treeSha256 };
    else return null;
  }
  return sha256Hex(canonicalStringify({ declaration: component.declaration, anchored: anchored.sort(), closure }));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : [];
}

export interface ExtensionComponentDigest {
  kind: "hook" | "mcpServer";
  localId: string;
  approvalDigest: string | null;
}

/** Missing or malformed declaring files produce null approval digests. */
export function extensionComponentDigests(manifestDocument: unknown, files: readonly PayloadFile[]): ExtensionComponentDigest[] {
  const manifest = flattenAgentPluginsManifest(manifestDocument);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const result: ExtensionComponentDigest[] = [];
  for (const declaration of resolvePluginContributionDeclarations(manifest)) {
    if (declaration.kind !== "hook" && declaration.kind !== "mcpServer") continue;
    const file = byPath.get(declaration.path);
    const entry = { kind: declaration.kind, localId: declaration.localId } as const;
    if (!file) {
      result.push({ ...entry, approvalDigest: null });
      continue;
    }
    const fingerprint = sha256Hex(`${file.path}\0${sha256Hex(file.data)}`);
    let raw: unknown;
    try {
      raw = JSON.parse(file.data.toString("utf8"));
    } catch {
      result.push({ ...entry, approvalDigest: null });
      continue;
    }
    if (declaration.kind === "mcpServer") {
      // An MCP server's relative command paths are read from its descriptor's directory (`anchorBundledCommand`).
      const baseDir = posix.dirname(declaration.path) === "." ? "" : posix.dirname(declaration.path);
      const config = record(raw);
      const transport = config?.transport === "http" ? "http" : config?.transport === "stdio" ? "stdio" : null;
      if (!config || transport === null || (transport === "stdio" && typeof config.command !== "string")) {
        result.push({ ...entry, approvalDigest: null });
        continue;
      }
      const argv = transport === "stdio" ? [config.command as string, ...strings(config.args)] : [];
      result.push({ ...entry, approvalDigest: approvalDigest({ declaration: fingerprint, baseDir, transport, argvs: transport === "stdio" ? [argv] : [] }, files) });
      continue;
    }
    const parsed = parseHookConfig(raw, { bundled: true });
    if (parsed.errors.length > 0 || parsed.warnings.length > 0) {
      result.push({ ...entry, approvalDigest: null });
      continue;
    }
    const argvs = parsed.entries.map((hook) => [...hook.command, ...Object.values(hook.env ?? {})]);
    // A hook's package paths are read from the package root (`resolveBundledArgv`), not its file's directory.
    result.push({ ...entry, approvalDigest: approvalDigest({ declaration: fingerprint, baseDir: "", transport: "stdio", argvs }, files) });
  }
  return result;
}

export interface AgentPluginComponentInputs {
  mcpServers: Readonly<Record<string, { transport: "stdio"; command: string; args?: string[]; digest: string } | { transport: "http"; digest: string }>>;
  hooks: ReadonlyArray<{ command: string[]; env?: Record<string, string>; digest: string }>;
}

/** Agent component paths resolve from the package root, keyed by server name or hook index. */
export function agentPluginComponentDigests(components: AgentPluginComponentInputs, files: readonly PayloadFile[]): {
  mcpServers: Record<string, string | null>;
  hooks: Array<string | null>;
} {
  const mcpServers = Object.create(null) as Record<string, string | null>;
  for (const [name, server] of Object.entries(components.mcpServers)) {
    mcpServers[name] = server.transport === "http"
      ? approvalDigest({ declaration: server.digest, baseDir: "", transport: "http", argvs: [] }, files)
      : approvalDigest({ declaration: server.digest, baseDir: "", transport: "stdio", argvs: [[server.command, ...(server.args ?? [])]] }, files);
  }
  const hooks = components.hooks.map((hook) =>
    approvalDigest({ declaration: hook.digest, baseDir: "", transport: "stdio", argvs: [[...hook.command, ...Object.values(hook.env ?? {})]] }, files));
  return { mcpServers, hooks };
}

/** Hash payload files once without execute bits; retained generation sealing may add those bits. */
export async function readPayloadFiles(root: string, paths?: readonly string[]): Promise<PayloadFile[]> {
  const list: string[] = [];
  if (paths) list.push(...paths);
  else {
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(dir, entry.name), path);
        else if (entry.isFile()) list.push(path);
        else throw new Error(`plugin payload member ${path} is not a regular file`);
      }
    };
    await walk(root, "");
  }
  const files: PayloadFile[] = [];
  for (const path of [...new Set(list)].sort()) files.push({ path, data: await readFile(join(root, ...path.split("/"))) });
  return files;
}
