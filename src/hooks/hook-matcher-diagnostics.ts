import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defaultHooksDir, discoverHooks, hookMatcherError } from "./hook-discovery.js";
import { loadHookConfig } from "./hook-config-trust.js";
import { buildHookRegistry, type HookRegistryEntry } from "./hook-registry.js";

/** Quarantine must not erase a broken guard. Repair or remove its file to clear it. */
export function collectHookMatcherDiagnostics(
  hooksDir = defaultHooksDir(),
  disabledDir = join(hooksDir, ".disabled"),
): { notices: string[]; guards: HookRegistryEntry[] } {
  const notices: string[] = [];
  const guards: HookRegistryEntry[] = [];
  for (const [dir, quarantined] of [[hooksDir, false], [disabledDir, true]] as const) {
    const scripts = discoverHooks(dir, quarantined);
    for (const hook of scripts) {
      const invalid = hookMatcherError(hook.matcher);
      if (invalid) notices.push(`${hook.path}: matcher ${JSON.stringify(hook.matcher)} refused: ${invalid}${hook.hookType === "pre" || hook.hookType === "perm" ? "; all tool calls for this event are denied" : "; observation hook will not run"}`);
    }
    guards.push(...buildHookRegistry(scripts, []).filter((entry) => entry.matcherError));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name !== "hooks.json" && !(quarantined && name.startsWith("hooks.json."))) continue;
      const config = loadHookConfig(join(dir, name));
      notices.push(...[...config.errors, ...config.warnings].map((notice) => `${config.path}: ${notice}`));
      guards.push(...buildHookRegistry([], config.entries).filter((entry) => entry.matcherError));
    }
  }
  return { notices, guards };
}
