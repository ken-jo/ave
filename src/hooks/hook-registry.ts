/**
 * Permission policy — Layer 6 hook system: unified hook registry.
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §4.1 + issue #811.
 * This is the PURE, INERT foundation for the command-hooks milestone: it merges
 * the two hook origins — legacy `.sh` `DiscoveredHook`s and declarative
 * `HookConfigEntry`s (from `hook-config.ts`) — into ONE normalized entry shape so
 * every future downstream consumer (trust diff, runner, audit, trust-review UI)
 * sees a single representation regardless of origin.
 *
 * `ScriptHookManager` consumes this registry for both user/global Hooks and
 * exact-generation plugin-owned Hook projections. Plugin entries carry an
 * activation identity for leasing while durable trust remains tied to the
 * reviewed artifact version and fingerprint.
 *
 * Normalization rules (design §4.1):
 *   - A legacy `.sh` `DiscoveredHook` → `{ source: "sh", command: [<abs .sh
 *     path>], event: hookType, matcher }`. The `.sh` is itself the local script,
 *     so its command is a single-element argv of its absolute path.
 *   - A declarative `HookConfigEntry` is appended as-is (already normalized).
 *
 * Ordering mirrors the composition order in design §4.3: legacy `.sh`
 * (alphabetical, as `discoverHooks` already returns them) first, then config
 * entries (file order).
 */
import { compileHookMatcher, type DiscoveredHook } from "./hook-discovery.js";
import type { HookConfigEntry } from "./hook-config.js";
import type { HookEvent } from "./script-hook-types.js";

/**
 * The normalized entry shape both origins collapse into. The discriminated
 * `source` lets a consumer recover origin-specific fields (e.g. the `.sh`
 * sha256/fileName for the lockfile, or the config `timeoutMs`).
 */
export type HookRegistryEntry = ShHookRegistryEntry | ConfigHookRegistryEntry;

export interface PluginHookOwner {
  pluginId: string;
  pluginVersion: string;
  /** Unique runtime activation identity; excluded from durable trust keys. */
  activationId: string;
  generationId: string;
  localId: string;
  fingerprint: string;
}

interface BaseHookRegistryEntry {
  /** Stable identity for trust-review / audit. */
  id: string;
  /** Closed-set internal event (tool-use pre|post|perm OR a lifecycle event). */
  event: HookEvent;
  /** Optional matcher over the tool name or lifecycle subject; absent ⇒ matches all. */
  matcher?: string;
  /** Compiled once when this registry entry is built; never serialized. */
  matchesSubject: (subject: string) => boolean;
  /** argv form of the command to execute (always ≥1 element). */
  command: string[];
  env?: Record<string, string>;
  /** Exact plugin-owned trust identity; absent for user/global hooks. */
  owner?: PluginHookOwner;
  /** Package-owned hooks run with a bounded write grant. */
  confinement?: { kind: "bundled"; pluginId: string; dataDir: string; generationRoot: string };
}

/** A registry entry synthesized from a legacy `.sh` `DiscoveredHook`. */
export interface ShHookRegistryEntry extends BaseHookRegistryEntry {
  source: "sh";
  /** The originating discovered hook — carries sha256/fileName/size for trust. */
  discovered: DiscoveredHook;
}

/** A registry entry carried over from a declarative `hooks.json` config entry. */
export interface ConfigHookRegistryEntry extends BaseHookRegistryEntry {
  source: "config";
  /** Per-entry timeout (already clamped in `parseHookConfig`). */
  timeoutMs: number;
}

/**
 * Normalize one legacy `.sh` `DiscoveredHook` into a registry entry. The `.sh`
 * file IS the local script, so `command` is its absolute path as a single-element
 * argv. `event` is the prefix-derived `hookType`; `matcher` carries the optional
 * `# ave-hook-matcher:` frontmatter matcher unchanged.
 */
function fromDiscoveredHook(hook: DiscoveredHook): ShHookRegistryEntry {
  return {
    id: `sh:${hook.fileName}`,
    event: hook.hookType,
    matchesSubject: compileHookMatcher(hook.matcher),
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
    command: [hook.path],
    source: "sh",
    discovered: hook,
  };
}

/** Normalize one declarative config entry into a registry entry. */
function fromConfigEntry(entry: HookConfigEntry): ConfigHookRegistryEntry {
  return {
    id: `config:${entry.id}`,
    event: entry.event,
    matchesSubject: compileHookMatcher(entry.matcher),
    ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
    command: entry.command,
    ...(entry.env ? { env: entry.env } : {}),
    source: "config",
    timeoutMs: entry.timeoutMs,
  };
}

/**
 * Build the unified registry: legacy `.sh` hooks first (alphabetical — preserved
 * from `discoverHooks`), then declarative config entries (file order). An entry
 * whose matcher is an invalid regular expression is left out (`discoverHooks`
 * and `parseHookConfig` report it). Pure — does no I/O and does not mutate its
 * inputs.
 */
export function buildHookRegistry(
  shHooks: readonly DiscoveredHook[],
  configEntries: readonly HookConfigEntry[],
): HookRegistryEntry[] {
  const registry: HookRegistryEntry[] = [];
  for (const hook of shHooks) {
    try {
      registry.push(fromDiscoveredHook(hook));
    } catch {
      // Discovery retains invalid matchers for review, never for execution.
    }
  }
  for (const entry of configEntries) {
    try {
      registry.push(fromConfigEntry(entry));
    } catch {
      // Config parsing reports the rejected matcher to the review surface.
    }
  }
  return registry;
}

/**
 * Filter a registry down to the entries that apply to a given `event` +
 * `toolName`. Reuses the same compiled matcher as the `.sh` runtime so `.sh`
 * frontmatter and `hooks.json` matchers behave identically (decision (a)).
 * An entry with no `matcher` matches every tool. Order is preserved.
 */
export function filterRegistryByEventAndTool(
  registry: HookRegistryEntry[],
  event: HookEvent,
  toolName: string,
): HookRegistryEntry[] {
  return registry.filter(
    (entry) => entry.event === event && entry.matchesSubject(toolName),
  );
}

/**
 * Filter a registry to the entries that apply to a given lifecycle `event` +
 * `subject` (#811 milestone-2). The manager picks the subject per event (see
 * `lifecycleMatcherSubject`); the same compiled matcher is reused so a config
 * matcher behaves identically across tool-use and lifecycle surfaces.
 * An entry with no `matcher` matches every session. Order is preserved.
 */
export function filterRegistryByEventAndSubject(
  registry: HookRegistryEntry[],
  event: HookEvent,
  subject: string,
): HookRegistryEntry[] {
  return registry.filter(
    (entry) => entry.event === event && entry.matchesSubject(subject),
  );
}
