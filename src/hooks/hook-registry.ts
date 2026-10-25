// Trusted scripts precede config entries in file order; plugin hooks lease exact activation identities while durable trust keys use reviewed version and fingerprint (docs/architecture/hook-runtime-expansion-design.md).
import { compileHookMatcher, HookMatcherError, type DiscoveredHook } from "./hook-discovery.js";
import { hookEventSupportsMatcher } from "./hook-contract.js";
import type { HookConfigEntry } from "./hook-config.js";
import type { HookEvent } from "./script-hook-types.js";

export type HookRegistryEntry = ShHookRegistryEntry | ConfigHookRegistryEntry;

export interface PluginHookOwner {
  pluginId: string;
  pluginVersion: string;
  // Unique runtime activation identity; excluded from durable trust keys.
  activationId: string;
  generationId: string;
  localId: string;
  fingerprint: string;
}

interface BaseHookRegistryEntry {
  id: string;
  event: HookEvent;
  // Optional matcher over the tool name or lifecycle subject; absent ⇒ matches all.
  matcher?: string;
  // Compiled once when this registry entry is built; never serialized.
  matchesSubject: (subject: string) => boolean;
  // Inert guard: refuses the event without executing a command.
  matcherError?: string;
  // Nonempty argv.
  command: string[];
  env?: Record<string, string>;
  // Exact plugin-owned trust identity; absent for user/global hooks.
  owner?: PluginHookOwner;
  // Package-owned hooks run with a bounded write grant.
  confinement?: { kind: "bundled"; pluginId: string; dataDir: string; generationRoot: string };
}

export interface ShHookRegistryEntry extends BaseHookRegistryEntry {
  source: "sh";
  // The originating discovered hook — carries sha256/fileName/size for trust.
  discovered: DiscoveredHook;
}

interface ConfigHookRegistryEntry extends BaseHookRegistryEntry {
  source: "config";
  // Per-entry timeout (already clamped in `parseHookConfig`).
  timeoutMs: number;
}

// Compile a bounded predicate, retaining only expected matcher failures.
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

// Invalid matchers become inert denial guards for pre/perm and are refused for other events; registry construction performs no I/O or input mutation.
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

// Reuse the compiled matcher, preserving order; absent matchers match all tools.
export function filterRegistryByEventAndTool(
  registry: HookRegistryEntry[],
  event: HookEvent,
  toolName: string,
): HookRegistryEntry[] {
  return filterRegistryByEventAndSubject(registry, event, toolName);
}

// Lifecycle filtering reuses the same matcher and preserves order; the manager chooses the bounded subject.
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
