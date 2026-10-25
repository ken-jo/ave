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
  /** Process executables must be package files; rooted arguments may name package files, directories or data paths. */
  policy: "hook" | "mcp" | "process";
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
  /** Rooted process arguments may name directories. */
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

/** Rooted package arguments and env values must exist and resolve within the retained package. */
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

/** Data leaves may be missing; every existing component must refuse links, including dangling ones. */
function containedDataPath(dataDir: string, suffix: string, label: string): string {
  // Resolve trusted root ancestors, verify the root itself, then lstat each component below it.
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

/** Only PLUGIN_ROOT and PLUGIN_DATA placeholders expand; all other literals must contain no placeholder syntax. */
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

export function checkProcessEntryArgument(value: string, label: string): void {
  classifyProcessValue(value, label, "argument");
}

export function checkProcessEntryEnvironmentValue(value: string, label: string): void {
  classifyProcessValue(value, label, "environment value");
}

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

/** Validate launcher grammar before resolving classified tokens; mutable data bytes stay outside package fingerprints. */
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
