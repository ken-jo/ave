// Config bytes and referenced script hashes form one trust unit; edits re-quarantine it. Commands enter the registry only after explicit trust (docs/architecture/hook-runtime-expansion-design.md).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
import { createLogger } from "../lib/logger.js";
import {
  parseHookConfig,
  type HookConfigEntry,
} from "./hook-config.js";
import { defaultHooksDir, discoverHooks, type DiscoveredHook } from "./hook-discovery.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { disabledHookOriginalName } from "./hook-disable-state.js";

const log = createLogger("hook-config-trust");

// The config uses the script trust workflow but admits only this exact non-script filename.
export const HOOKS_CONFIG_FILENAME = "hooks.json";

export function defaultHooksConfigPath(dir: string = defaultHooksDir()): string {
  return pathResolve(dir, HOOKS_CONFIG_FILENAME);
}

// Disabled review includes every stored copy; active discovery keeps exact names.
export function discoverHookTrustFiles(dir: string, includeDisabledCopies = false, configBaseDir = dir): {
  scripts: DiscoveredHook[];
  config: LoadedHookConfig;
  configs: LoadedHookConfig[];
  hooks: DiscoveredHook[];
} {
  const scripts = discoverHooks(dir, includeDisabledCopies);
  const config = loadHookConfig(defaultHooksConfigPath(dir), configBaseDir);
  const configs = includeDisabledCopies && existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && disabledHookOriginalName(entry.name) === HOOKS_CONFIG_FILENAME)
      .map((entry) => loadHookConfig(join(dir, entry.name), configBaseDir))
    : [config];
  const synthetic = configs.flatMap((loaded) => {
    const hook = syntheticConfigHook(loaded);
    return hook ? [{ ...hook, fileName: basename(loaded.path) }] : [];
  });
  return { scripts, config, configs, hooks: [...scripts, ...synthetic] };
}

// Materialized configs use explicit paths; symbolic package arguments are resolved by their own loader.
function isScriptAnchor(token: string): boolean {
  if (token.startsWith("-")) return false;
  const path = expandLeadingTilde(token);
  return isAbsolute(path) || path.startsWith("./") || path.startsWith("../");
}

// Every explicit non-option path is an anchor, including interpreter and additional script operands.
export function resolveScriptAnchors(command: readonly string[]): string[] {
  return command.filter(isScriptAnchor).map(expandLeadingTilde);
}

export interface LoadedHookConfig {
  path: string;
  exists: boolean;
  // Empty when config is absent or unparsable.
  entries: HookConfigEntry[];
  // Non-fatal parser warnings.
  warnings: string[];
  // Fatal handler or binary-only rejections.
  errors: string[];
  // Hash config bytes and every referenced script; null when config is absent.
  trustHash: string | null;
}

// Reads config and referenced scripts for hashing; never executes them. Missing config yields no entries.
export function loadHookConfig(
  configPath: string = defaultHooksConfigPath(),
  scriptBaseDir = dirname(configPath),
): LoadedHookConfig {
  if (!existsSync(configPath)) {
    return { path: configPath, exists: false, entries: [], warnings: [], errors: [], trustHash: null };
  }

  let raw: Buffer;
  try {
    raw = readFileSync(configPath);
  } catch (err) {
    log.warn("hook-config-trust: read failed %s: %s", configPath, (err as Error).message);
    return { path: configPath, exists: false, entries: [], warnings: [], errors: [], trustHash: null };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString("utf-8"));
  } catch {
    // Malformed config yields an audited fatal error and no runnable entries; hashing its bytes detects later repairs.
    log.warn("hook-config-trust: JSON parse failed %s", configPath);
    return {
      path: configPath,
      exists: true,
      entries: [],
      warnings: [],
      errors: ["hooks.json: not valid JSON"],
      trustHash: hashBytesOnly(raw),
    };
  }

  const parsed = parseHookConfig(parsedJson);
  bindHookConfigPaths(parsed.entries, scriptBaseDir);
  const { trustHash, errors: anchorErrors } = hashHookConfigDefinition(raw, parsed.entries);

  return {
    path: configPath,
    exists: true,
    // Refused anchors supply no runnable commands; invalid matchers retain their inert denial guards.
    entries: (anchorErrors.length ? parsed.entries.filter((entry) => entry.matcherError) : parsed.entries)
      .map((entry) => ({ ...entry, configPath, reviewedHash: trustHash })),
    warnings: parsed.warnings,
    errors: [...parsed.errors, ...anchorErrors],
    trustHash,
  };
}

export function hashHookConfigDefinition(raw: Buffer, entries: readonly HookConfigEntry[]): { trustHash: string; errors: string[] } {
  const hasher = createHash("sha256");
  hasher.update(raw);
  const errors: string[] = [];
  const anchors = [...new Set(entries.flatMap((entry) => {
    const paths = resolveScriptAnchors(entry.command);
    if (entry.handlerType !== "http" && paths.length === 0) {
      errors.push(`hooks.json: ${entry.id} requires an absolute, ./ or ../ script anchor`);
    }
    return paths;
  }))].sort();
  for (const anchorPath of anchors) {
    hasher.update("\0");
    hasher.update(trustAnchorKey(anchorPath));
    hasher.update("\0");
    try {
      hasher.update(readFileSync(anchorPath));
    } catch {
      errors.push(`hooks.json: script anchor ${JSON.stringify(anchorPath)} cannot be resolved or read`);
      hasher.update("<unreadable-script-anchor>");
    }
  }

  return { trustHash: hasher.digest("hex"), errors };
}

export function bindHookConfigPaths(entries: HookConfigEntry[], baseDirectory: string): void {
  for (const entry of entries) {
    entry.command = entry.command.map((token) => {
      if (!isScriptAnchor(token)) return token;
      const anchor = expandLeadingTilde(token);
      return isAbsolute(anchor) ? anchor : pathResolve(baseDirectory, anchor);
    });
  }
}

// Normalize path separators before hashing so platform spelling changes do not re-quarantine the same script.
export function trustAnchorKey(anchorPath: string): string {
  return anchorPath.replaceAll("\\", "/");
}

function hashBytesOnly(raw: Buffer): string {
  return sha256Hex(raw);
}

// The synthetic pre event anchors trust only; dispatch uses each config entry's event.
export function syntheticConfigHook(loaded: LoadedHookConfig): DiscoveredHook | null {
  if (!loaded.exists || loaded.trustHash === null) return null;
  return {
    path: loaded.path,
    fileName: HOOKS_CONFIG_FILENAME,
    hookType: "pre",
    sha256: loaded.trustHash,
    size: 0,
  };
}
