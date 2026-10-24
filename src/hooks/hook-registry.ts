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
import { compileHookMatcher, HookMatcherError, type DiscoveredHook } from "./hook-discovery.js";
import { hookEventSupportsMatcher } from "./hook-contract.js";
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
  /** Inert guard: refuses the event without executing a command. */
  matcherError?: string;
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

/** Compile a bounded predicate, retaining only expected matcher failures. */
function matcherFields(event: HookEvent, matcher: string | undefined, file: string, invalid?: string): Pick<BaseHookRegistryEntry, "matchesSubject" | "matcherError"> {
  if (!hookEventSupportsMatcher(event)) return { matchesSubject: () => true };
  try {
    if (invalid !== undefined) throw new HookMatcherError(invalid);
    const predicate = compileHookMatcher(matcher);
    return { matchesSubject: (subject) => {
      try {
        return predicate(subject);
      } catch (error) {
        if (!(error instanceof HookMatcherError)) throw error;
        throw new HookMatcherError(`${file}: matcher ${JSON.stringify(matcher)}: ${error.message}`);
      }
    } };
  } catch (error) {
    if (!(error instanceof HookMatcherError)) throw error;
    return { matchesSubject: () => false, matcherError: `${file}: matcher ${JSON.stringify(matcher)}: ${error.message}` };
  }
}

/** Normalize a legacy script, preserving its path and trust identity. */
function fromDiscoveredHook(hook: DiscoveredHook): ShHookRegistryEntry {
  return {
    id: `sh:${hook.fileName}`,
    event: hook.hookType,
    ...matcherFields(hook.hookType, hook.matcher, hook.path),
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
    ...matcherFields(entry.event, entry.matcher, entry.configPath ?? `hooks.json:${entry.id}`, entry.matcherError),
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
 * with an invalid matcher becomes an inert denial guard for pre/perm; other
 * events refuse it. Pure — does no I/O and does not mutate its
 * inputs.
 */
export function buildHookRegistry(
  shHooks: readonly DiscoveredHook[],
  configEntries: readonly HookConfigEntry[],
): HookRegistryEntry[] {
  const registry: HookRegistryEntry[] = [];
  for (const hook of shHooks) {
    const entry = fromDiscoveredHook(hook);
    if (!entry.matcherError || entry.event === "pre" || entry.event === "perm") registry.push(entry);
  }
  for (const entry of configEntries) {
    const normalized = fromConfigEntry(entry);
    if (!normalized.matcherError || normalized.event === "pre" || normalized.event === "perm") registry.push(normalized);
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
  return filterRegistryByEventAndSubject(registry, event, toolName);
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
  return registry.filter((entry) => {
    if (entry.event !== event) return false;
    try {
      return entry.matchesSubject(subject);
    } catch (error) {
      if (!(error instanceof HookMatcherError) || event === "pre" || event === "perm") throw error;
      return false;
    }
  });
}
