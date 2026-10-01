import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { anchorBundledCommand, isBundledPathLikeToken } from "./plugin-bundled-command.js";
import { isResolvedPathWithin, resolvePluginDataRoot } from "./plugin-storage-containment.js";

export interface BundledArgvInput {
  generationRoot: string;
  dataDir: string;
  argv: readonly string[];
  baseFingerprint: string;
  label: string;
  /**
   * `process` is a `process` entry's `[command, ...args]` (decision 37): the
   * executable is a package file, and an argument may name a package file OR
   * directory under `${PLUGIN_ROOT}/` or a path under `${PLUGIN_DATA}`.
   */
  policy: "hook" | "mcp" | "process";
  /** Launcher tokens already identified by the MCP launcher grammar. */
  launcherLiteralIndexes?: readonly number[];
}

export interface ResolvedBundledArgv {
  argv: readonly string[];
  fingerprint: string;
}

interface ClassifiedArgv {
  symbolic: string[];
  anchorIndexes: number[];
  dataIndexes: number[];
  /** `process` arguments under `${PLUGIN_ROOT}/`, which may name a directory. */
  rootIndexes: number[];
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const DRIVE = /^[A-Za-z]:/u;

function relativeSegments(raw: string, label: string): string {
  if (!raw || isAbsolute(raw) || DRIVE.test(raw) || raw.includes("\\") || CONTROL.test(raw) || raw.includes("${")) {
    throw new Error(`${label} is not a contained relative path`);
  }
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} is not a contained relative path`);
  }
  return segments.join("/");
}

/**
 * A `${PLUGIN_ROOT}/…` argument or environment value of a `process` entry.
 *
 * Unlike the executable it may name a directory — a vendored tree is one — so
 * it cannot go through `anchorBundledCommand`'s regular-file rule. The artifact
 * is immutable, so a path it does not ship is a manifest error rather than
 * something that may appear later, and its realpath must stay inside the root.
 */
function containedRootPath(rootReal: string, suffix: string, label: string): string {
  const candidate = resolve(rootReal, relativeSegments(suffix, label));
  if (!isResolvedPathWithin(rootReal, candidate)) throw new Error(`${label} escapes PLUGIN_ROOT`);
  let candidateReal: string;
  try {
    candidateReal = realpathSync(candidate);
  } catch {
    throw new Error(`${label} names a path the plugin package does not contain`);
  }
  if (!isResolvedPathWithin(rootReal, candidateReal)) throw new Error(`${label} escapes PLUGIN_ROOT through a symlink`);
  const stat = statSync(candidateReal);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`${label} is neither a file nor a directory`);
  return candidateReal;
}

/**
 * A `${PLUGIN_DATA}…` token: relative segments below the data directory, whose
 * leaf may not exist yet. No component that does exist may be a symlink, in or
 * out of the directory, dangling or not: the plugin writes this directory, so
 * a link that resolves inside it now can point anywhere when the path is
 * used, and a dangling one has no target to check at all.
 */
function containedDataPath(dataDir: string, suffix: string, label: string): string {
  // The root's ancestors are trusted host paths and are resolved, links
  // included; the root itself must be the real directory the host created
  // (`resolvePluginDataRoot`). Every component below it is walked with lstat.
  let root: string;
  try {
    root = resolvePluginDataRoot(label, dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label}: PLUGIN_DATA directory is missing`);
    throw error;
  }
  if (!suffix) return root;
  const candidate = resolve(root, relativeSegments(suffix, label));
  if (!isResolvedPathWithin(root, candidate)) throw new Error(`${label} escapes PLUGIN_DATA`);
  let component = root;
  for (const segment of suffix.split("/")) {
    component = join(component, segment);
    let entry: Stats;
    try {
      entry = lstatSync(component);
    } catch (error) {
      // Nothing exists from here down, so nothing below can be a link.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") break;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${label} passes through a symlink inside PLUGIN_DATA ('${segment}'); a data path may not use one, `
          + "because the plugin can repoint it after this check",
      );
    }
  }
  return candidate;
}

type ProcessValue =
  | { readonly kind: "root"; readonly suffix: string }
  | { readonly kind: "data"; readonly suffix: string }
  | { readonly kind: "literal" };

/**
 * Read one `process` argument or environment value (decision 37).
 *
 * `${PLUGIN_ROOT}/…` and `${PLUGIN_DATA}…` are the only placeholders. Any other
 * argument may not look like a path, because nothing would resolve it; any
 * other environment value is data the confined process reads, passed as an
 * opaque literal, which may not contain `${` either.
 */
function classifyProcessValue(value: string, label: string, place: "argument" | "environment value"): ProcessValue {
  if (typeof value !== "string") throw new Error(`${label} is not a string`);
  if (place === "argument" && CONTROL.test(value)) throw new Error(`${label} has control characters`);
  if (value.startsWith("${PLUGIN_ROOT}/")) {
    const suffix = value.slice("${PLUGIN_ROOT}/".length);
    relativeSegments(suffix, label);
    return { kind: "root", suffix };
  }
  if (value === "${PLUGIN_DATA}" || value.startsWith("${PLUGIN_DATA}/")) {
    const suffix = value === "${PLUGIN_DATA}" ? "" : value.slice("${PLUGIN_DATA}/".length);
    if (suffix) relativeSegments(suffix, label);
    return { kind: "data", suffix };
  }
  if (value.includes("${")) throw new Error(`${label} has a placeholder other than \${PLUGIN_ROOT}/ or \${PLUGIN_DATA}`);
  if (place === "argument" && isBundledPathLikeToken(value)) {
    throw new Error(`${label} looks like a path; name it as \${PLUGIN_ROOT}/… or \${PLUGIN_DATA}/…`);
  }
  return { kind: "literal" };
}

/** Check a `process` argument before any generation exists (manifest hardening). */
export function checkProcessEntryArgument(value: string, label: string): void {
  classifyProcessValue(value, label, "argument");
}

/** Check a `process` environment value before any generation exists (manifest hardening). */
export function checkProcessEntryEnvironmentValue(value: string, label: string): void {
  classifyProcessValue(value, label, "environment value");
}

/** Expand one `process` environment value against the retained generation and the data directory. */
export function resolveProcessEntryEnvironmentValue(
  generationRoot: string,
  dataDir: string,
  value: string,
  label: string,
): string {
  const classified = classifyProcessValue(value, label, "environment value");
  if (classified.kind === "root") return containedRootPath(realpathSync(generationRoot), classified.suffix, label);
  if (classified.kind === "data") return containedDataPath(dataDir, classified.suffix, label);
  return value;
}

/**
 * Resolve only explicitly classified package and data tokens from a bundled command.
 * The caller must first validate the MCP launcher grammar before supplying its
 * literal indexes. PLUGIN_DATA exists before this call; its contents are not
 * part of the package fingerprint because they may change at runtime.
 */
function classifyBundledArgv(input: Pick<BundledArgvInput, "argv" | "label" | "policy" | "launcherLiteralIndexes">): ClassifiedArgv {
  const { argv, label } = input;
  if (input.policy !== "hook" && input.policy !== "mcp" && input.policy !== "process") {
    throw new Error(`${label} has an unknown executable policy`);
  }
  if (argv.length === 0) throw new Error(`${label} has no executable`);
  const literalIndexes = new Set(input.launcherLiteralIndexes ?? []);
  if (input.policy !== "mcp" && literalIndexes.size > 0) throw new Error(`${label} has launcher literals outside MCP policy`);
  if (literalIndexes.size !== (input.launcherLiteralIndexes?.length ?? 0)
    || [...literalIndexes].some((index) => !Number.isInteger(index) || index <= 0 || index >= argv.length)) {
    throw new Error(`${label} has invalid launcher literal indexes`);
  }

  const symbolic: string[] = [];
  const anchorIndexes: number[] = [];
  const dataIndexes: number[] = [];
  const rootIndexes: number[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (typeof token !== "string" || CONTROL.test(token)) throw new Error(`${label} token ${index} has control characters`);
    if (input.policy === "process" && index > 0) {
      const classified = classifyProcessValue(token, `${label} argument ${index - 1}`, "argument");
      symbolic.push(token);
      if (classified.kind === "root") rootIndexes.push(index);
      if (classified.kind === "data") dataIndexes.push(index);
      continue;
    }
    if (literalIndexes.has(index)) {
      if (token.includes("${") || token.includes("\\") || token.startsWith(".") || token.includes("..")) {
        throw new Error(`${label} launcher literal ${index} is invalid`);
      }
      symbolic.push(token);
      continue;
    }
    if (token.startsWith("${PLUGIN_ROOT}/") || token.startsWith("./")) {
      const suffix = token.startsWith("./") ? token.slice(2) : token.slice("${PLUGIN_ROOT}/".length);
      symbolic.push(`./${relativeSegments(suffix, `${label} token ${index}`)}`);
      anchorIndexes.push(index);
      continue;
    }
    if (token === "${PLUGIN_DATA}" || token.startsWith("${PLUGIN_DATA}/")) {
      if (index === 0) throw new Error(`${label} executable cannot be in PLUGIN_DATA`);
      const suffix = token === "${PLUGIN_DATA}" ? "" : token.slice("${PLUGIN_DATA}/".length);
      if (suffix) relativeSegments(suffix, `${label} token ${index}`);
      symbolic.push(token);
      dataIndexes.push(index);
      continue;
    }
    if (token.includes("${") || isBundledPathLikeToken(token)) throw new Error(`${label} token ${index} is an undeclared path or placeholder`);
    symbolic.push(token);
  }

  const executable = symbolic[0]!;
  if (input.policy === "process") {
    if (!anchorIndexes.includes(0)) throw new Error(`${label} executable must be a package path`);
  } else if (input.policy === "hook") {
    if (!anchorIndexes.includes(0) && executable !== "node" && executable !== "bun") {
      throw new Error(`${label} hook executable must be a package path or node/bun`);
    }
    if ((executable === "node" || executable === "bun") && !anchorIndexes.includes(1)) {
      throw new Error(`${label} node/bun script must be a package path`);
    }
  } else if (!anchorIndexes.includes(0)) {
    if (!["npx", "uvx", "docker", "node", "bun"].includes(executable)) {
      throw new Error(`${label} MCP executable is not allowed`);
    }
    if ((executable === "node" || executable === "bun") && !anchorIndexes.includes(1)) {
      throw new Error(`${label} node/bun script must be a package path`);
    }
  }

  return { symbolic, anchorIndexes, dataIndexes, rootIndexes };
}

/** Validate the symbolic package hook command before it enters a descriptor. */
export function validateSymbolicHookArgv(argv: readonly string[], label: string): void {
  classifyBundledArgv({ argv, label, policy: "hook" });
}

export function resolveBundledArgv(input: BundledArgvInput): ResolvedBundledArgv {
  const { symbolic, anchorIndexes, dataIndexes, rootIndexes } = classifyBundledArgv(input);
  const anchored = anchorBundledCommand(input.generationRoot, "plugin.json", symbolic, input.baseFingerprint, input.label, anchorIndexes);
  const resolved = [...anchored.command];
  if (rootIndexes.length > 0) {
    const rootReal = realpathSync(input.generationRoot);
    for (const index of rootIndexes) {
      resolved[index] = containedRootPath(
        rootReal,
        symbolic[index]!.slice("${PLUGIN_ROOT}/".length),
        `${input.label} argument ${index - 1}`,
      );
    }
  }
  for (const index of dataIndexes) {
    const token = symbolic[index]!;
    const suffix = token === "${PLUGIN_DATA}" ? "" : token.slice("${PLUGIN_DATA}/".length);
    resolved[index] = containedDataPath(input.dataDir, suffix, `${input.label} token ${index}`);
  }
  return { argv: Object.freeze(resolved), fingerprint: anchored.fingerprint };
}
