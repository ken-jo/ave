// Config bytes and referenced script hashes form one trust unit; edits re-quarantine it. Commands enter the registry only after explicit trust (docs/architecture/hook-runtime-expansion-design.md).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep, resolve as pathResolve } from "node:path";
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
  try { bindHookConfigPaths(parsed.entries, scriptBaseDir); }
  catch {
    return { path: configPath, exists: true, entries: [], warnings: parsed.warnings,
      errors: [...parsed.errors, "hooks.json: configuration directory cannot be resolved"], trustHash: hashBytesOnly(raw) };
  }
  const { trustHash, errors: anchorErrors, fileDependencies } = hashHookConfigDefinition(raw, parsed.entries);

  return {
    path: configPath,
    exists: true,
    // Refused anchors supply no runnable commands; invalid matchers retain their inert denial guards.
    entries: (anchorErrors.length ? parsed.entries.filter((entry) => entry.matcherError) : parsed.entries)
      .map((entry) => ({ ...entry, configPath, reviewedHash: trustHash, fileDependencies: fileDependencies.get(entry.id) })),
    warnings: parsed.warnings,
    errors: [...parsed.errors, ...anchorErrors],
    trustHash,
  };
}

export function hashHookCommandFiles(command: readonly string[], configDir: string): { hash: string; files: string[]; errors: string[] } {
  const hasher = createHash("sha256");
  hasher.update(JSON.stringify(command));
  const errors: string[] = [];
  const files = new Set<string>();
  let cwd: string;
  try {
    cwd = realpathSync(configDir);
    if (!statSync(cwd).isDirectory()) throw new Error("Not a directory");
  } catch {
    return { hash: hasher.digest("hex"), files: [], errors: ["configuration directory cannot be resolved"] };
  }
  hasher.update("\0cwd\0").update(trustAnchorKey(cwd));
  for (const [index, raw] of command.entries()) {
    if (raw.startsWith("-")) continue;
    const token = expandLeadingTilde(raw);
    const executable = index === 0;
    // A bare executable is PATH-resolved; operands are always resolved against the bound cwd.
    if (executable && !isAbsolute(token) && !token.includes("/") && !token.includes(sep)) continue;
    const candidate = pathResolve(cwd, token);
    try {
      const target = realpathSync(candidate);
      if (!statSync(target).isFile()) {
        if (executable) errors.push("hook executable is not a regular file");
        continue;
      }
      const bytes = readFileSync(target);
      hasher.update(`\0file:${index}\0`).update(trustAnchorKey(candidate)).update("\0").update(trustAnchorKey(target)).update("\0").update(createHash("sha256").update(bytes).digest());
      files.add(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!executable && (code === "ENOENT" || code === "ENOTDIR")) continue;
      errors.push(`file operand ${index} cannot be resolved or read`);
      hasher.update(`\0unreadable:${index}\0`);
    }
  }
  if (files.size === 0) errors.push("command has no regular-file trust anchor");
  return { hash: hasher.digest("hex"), files: [...files], errors };
}

export function hashHookConfigDefinition(raw: Buffer, entries: readonly HookConfigEntry[]): {
  trustHash: string; errors: string[]; fileDependencies: ReadonlyMap<string, readonly string[]>;
} {
  const hasher = createHash("sha256").update(raw);
  const errors: string[] = [];
  const fileDependencies = new Map<string, readonly string[]>();
  for (const entry of entries) {
    if (entry.handlerType === "http") continue;
    if (!entry.configDir) {
      errors.push(`hooks.json: ${entry.id} configuration directory is missing`);
      continue;
    }
    const result = hashHookCommandFiles(entry.command, entry.configDir);
    hasher.update("\0").update(entry.id).update("\0").update(result.hash);
    errors.push(...result.errors.map((error) => `hooks.json: ${entry.id} ${error}`));
    fileDependencies.set(entry.id, result.files);
  }
  return { trustHash: hasher.digest("hex"), errors, fileDependencies };
}

export function bindHookConfigPaths(entries: HookConfigEntry[], baseDirectory: string): void {
  const configDir = realpathSync(baseDirectory);
  if (!statSync(configDir).isDirectory()) throw new Error("Hook configuration directory is unavailable");
  for (const entry of entries) {
    entry.configDir = configDir;
    const executable = entry.command[0];
    if (executable === undefined) continue;
    const expanded = expandLeadingTilde(executable);
    if (isAbsolute(expanded) || expanded.includes("/") || expanded.includes(sep)) {
      entry.command = [pathResolve(configDir, expanded), ...entry.command.slice(1)];
    }
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
