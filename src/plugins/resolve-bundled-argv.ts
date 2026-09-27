import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { anchorBundledCommand, isBundledPathLikeToken } from "./plugin-bundled-command.js";
import { isResolvedPathWithin } from "./plugin-storage-containment.js";

export interface BundledArgvInput {
  generationRoot: string;
  dataDir: string;
  argv: readonly string[];
  baseFingerprint: string;
  label: string;
  policy: "hook" | "mcp";
  /** Launcher tokens already identified by the MCP launcher grammar. */
  launcherLiteralIndexes?: readonly number[];
}

export interface ResolvedBundledArgv {
  argv: readonly string[];
  fingerprint: string;
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

function containedDataPath(dataDir: string, suffix: string, label: string): string {
  if (!existsSync(dataDir)) throw new Error(`${label}: PLUGIN_DATA directory is missing`);
  const root = realpathSync(dataDir);
  const candidate = suffix ? resolve(root, relativeSegments(suffix, label)) : root;
  if (!isResolvedPathWithin(root, candidate)) throw new Error(`${label} escapes PLUGIN_DATA`);
  let existing = candidate;
  while (!existsSync(existing)) existing = dirname(existing);
  if (!isResolvedPathWithin(root, realpathSync(existing))) throw new Error(`${label} escapes PLUGIN_DATA through a symlink`);
  return candidate;
}

/**
 * Resolve only explicitly classified package and data tokens from a bundled command.
 * The caller must first validate the MCP launcher grammar before supplying its
 * literal indexes. PLUGIN_DATA exists before this call; its contents are not
 * part of the package fingerprint because they may change at runtime.
 */
export function resolveBundledArgv(input: BundledArgvInput): ResolvedBundledArgv {
  const { argv, label } = input;
  if (input.policy !== "hook" && input.policy !== "mcp") throw new Error(`${label} has an unknown executable policy`);
  if (argv.length === 0) throw new Error(`${label} has no executable`);
  const literalIndexes = new Set(input.launcherLiteralIndexes ?? []);
  if (input.policy === "hook" && literalIndexes.size > 0) throw new Error(`${label} has launcher literals outside MCP policy`);
  if (literalIndexes.size !== (input.launcherLiteralIndexes?.length ?? 0)
    || [...literalIndexes].some((index) => !Number.isInteger(index) || index <= 0 || index >= argv.length)) {
    throw new Error(`${label} has invalid launcher literal indexes`);
  }

  const symbolic: string[] = [];
  const anchorIndexes: number[] = [];
  const dataIndexes: number[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (typeof token !== "string" || CONTROL.test(token)) throw new Error(`${label} token ${index} has control characters`);
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
  if (input.policy === "hook") {
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

  const anchored = anchorBundledCommand(input.generationRoot, "plugin.json", symbolic, input.baseFingerprint, label, anchorIndexes);
  const resolved = [...anchored.command];
  for (const index of dataIndexes) {
    const token = symbolic[index]!;
    const suffix = token === "${PLUGIN_DATA}" ? "" : token.slice("${PLUGIN_DATA}/".length);
    resolved[index] = containedDataPath(input.dataDir, suffix, `${label} token ${index}`);
  }
  return { argv: Object.freeze(resolved), fingerprint: anchored.fingerprint };
}
