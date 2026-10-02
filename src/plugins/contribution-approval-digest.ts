/**
 * The approval digest of a bundled MCP server or hook (design §18.7.3): what
 * an approval of that component covers, so an update that leaves it
 * unchanged keeps the approval and one that changes anything it could run or
 * read asks again.
 *
 * No runtime boundary keeps an approved server from reading another file of
 * its package and evaluating it, so the digest covers the **whole** package
 * tree, every byte as it is, with exactly one exception: the string value of
 * `plugin.json`'s one top-level `version` member ({@link comparedBytes}). A
 * release must change it, and a component that behaves differently by the
 * version string is reading input data, which is outside what an approval
 * covers (owner decision, design §18.7.3). It is the sha256 of canonical
 * JSON:
 *
 *   { declaration: <static fingerprint of the declaring file>,
 *     anchored:    ["<token index>\0<package path>\0<sha256>", ...] sorted,
 *     closure:     { kind: "package", treeSha256 }
 *                | { kind: "launcher", spec, treeSha256 }
 *                | { kind: "remote" } }
 *
 * A closure that cannot be determined — a launcher spec without an
 * immutable pin, a path token that names no package file, a command type
 * this module does not name — gives `null`, which never equals anything:
 * such a component never carries its approval and always needs review.
 *
 * Everything here reads the payload as a list of files, so the same bytes
 * give the same digest wherever they are read: the staged zip before
 * activation, the receipt-covered generation root, an agent plugin's
 * installed directory.
 */
import { createHash } from "node:crypto";
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

/** One bundled component as the digest reads it. */
export interface ApprovalComponent {
  /** The static fingerprint of the declaring file (an extension) or the component digest (an agent plugin). */
  declaration: string;
  /** Package-relative directory a relative command path is read from ("" = the package root). */
  baseDir: string;
  transport: "stdio" | "http";
  /** Each command line the component runs (a hook file may hold several), with environment values appended. */
  argvs: readonly (readonly string[])[];
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function skipWhitespace(text: string, at: number): number {
  let i = at;
  while (i < text.length && JSON_WHITESPACE.has(text[i]!)) i += 1;
  return i;
}

/** The index just past the JSON string that starts at `at` (an opening quote). */
function stringEnd(text: string, at: number): number {
  let i = at + 1;
  while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** The index just past the JSON value that starts at `at`, in text already known to parse. */
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

/**
 * Where the string value of the one top-level `version` member of a
 * `plugin.json` sits, quotes excluded; null when the file is not a JSON
 * object, has no such member, has it more than once, or its value is not a
 * string.
 */
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

/**
 * The bytes a file is compared and hashed as. `plugin.json` has the string
 * value of its one top-level `version` member emptied, every other byte kept
 * as it is: another key, key order, whitespace, a second `version` member or
 * a version that is not a string all still differ. A file whose bytes are
 * not exactly UTF-8, or that does not parse, is hashed as it is.
 */
function comparedBytes(file: PayloadFile): Buffer {
  if (file.path !== "plugin.json") return file.data;
  const text = file.data.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(file.data)) return file.data;
  const span = versionValueSpan(text);
  return span ? Buffer.from(text.slice(0, span.start) + text.slice(span.end), "utf8") : file.data;
}

/**
 * The tree digest (§6.4) of the payload with the one normalization above.
 * Lines are `"<mode> <sha256> <path>\n"` sorted by path bytes, as the
 * receipt's tree digest.
 */
export function payloadTreeSha256(files: readonly PayloadFile[]): string {
  const lines = files
    .map((file) => ({ key: Buffer.from(file.path, "utf8"), line: `${file.executable === true ? "100755" : "100644"} ${sha256(comparedBytes(file))} ${file.path}\n` }))
    .sort((a, b) => Buffer.compare(a.key, b.key));
  const hash = createHash("sha256");
  for (const { line } of lines) hash.update(line, "utf8");
  return hash.digest("hex");
}

const NON_CODE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".json"]);

/** The files that declare an agent plugin's MCP servers and hooks. */
export const AGENT_PLUGIN_DECLARATION_PATHS: readonly string[] = ["mcp.json", "ai.agent-connector.ave/hooks.json"];

/** The files an extension's `plugin.json` names as the declarations of its bundled hooks and MCP servers. */
export function extensionDeclarationPaths(manifestDocument: unknown): string[] {
  return resolvePluginContributionDeclarations(flattenAgentPluginsManifest(manifestDocument))
    .filter((declaration) => declaration.kind === "hook" || declaration.kind === "mcpServer")
    .map((declaration) => declaration.path);
}

/**
 * The package paths whose bytes differ between two payloads, under the same
 * normalization as {@link payloadTreeSha256}. `plugin.json` is listed only
 * when something other than its version's value differs, and then always as
 * code; so is every file in `declaring`, the declarations of the package's
 * servers and hooks, whose change changes what runs whatever its extension.
 * The split is for display only: it never decides whether an update applies.
 */
export function changedPayloadFiles(before: readonly PayloadFile[], after: readonly PayloadFile[], declaring: ReadonlySet<string>): { code: string[]; nonCode: string[] } {
  const digests = (files: readonly PayloadFile[]) => new Map(files.map((file) => [file.path, `${file.executable === true ? "x" : "-"}${sha256(comparedBytes(file))}`]));
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

/**
 * The launcher spec of a command line, when its command is a launcher of a
 * registry package: `{ spec }` with the spec when it names an immutable
 * artifact, `{ spec: null }` when it does not. `null` when the command is no
 * launcher.
 */
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

/**
 * The package file a command token names, or null when the token names no
 * path; `undefined` when it names a path that is not a package file (the
 * closure cannot be determined).
 */
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

/** The approval digest of one component over `files` (see the module comment); null when undeterminable. */
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
        anchored.push(`${entry}:${index}\0${path}\0${sha256(byPath.get(path)!.data)}`);
      }
    }
    if (launcher !== null) closure = { kind: "launcher", spec: launcher, treeSha256 };
    // A command that names no package file and is no launcher is a command type this digest does not name.
    else if (anchored.length > 0) closure = { kind: "package", treeSha256 };
    else return null;
  }
  return sha256(canonicalStringify({ declaration: component.declaration, anchored: anchored.sort(), closure }));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : [];
}

/** One bundled hook or MCP server of an extension, by kind and local id, with its approval digest. */
export interface ExtensionComponentDigest {
  kind: "hook" | "mcpServer";
  localId: string;
  approvalDigest: string | null;
}

/**
 * The approval digest of every bundled hook and MCP server an extension's
 * `plugin.json` declares, read from its payload files. A declaring file that
 * is missing or does not parse gives `null` for that component.
 */
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
    // The static fingerprint `materializePluginContributions` computes for a one-file declaration.
    const fingerprint = sha256(`${file.path}\0${sha256(file.data)}`);
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

/** The parts of an agent plugin's verified component inventory the digests read. */
export interface AgentPluginComponentInputs {
  mcpServers: Readonly<Record<string, { transport: "stdio"; command: string; args?: string[]; digest: string } | { transport: "http"; digest: string }>>;
  hooks: ReadonlyArray<{ command: string[]; env?: Record<string, string>; digest: string }>;
}

/**
 * The approval digest of every MCP server (by name) and hook (by index) of an
 * agent plugin, read from its installed or staged files. Its paths are read
 * from the package root (`${PLUGIN_ROOT}/…` or `./…`).
 */
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

/**
 * An extension's payload as the digests read it: the files under `root`
 * (`paths`, or every file), each read once. Extension payloads come from a
 * zip and are hashed without execute bits, wherever they are read: the
 * retained generation root is sealed with them set.
 */
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
