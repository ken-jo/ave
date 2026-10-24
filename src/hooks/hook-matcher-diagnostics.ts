import { join } from "node:path";
import { defaultHooksDir, hookMatcherError } from "./hook-discovery.js";
import { discoverHookTrustFiles } from "./hook-config-trust.js";
import { buildHookRegistry, type HookRegistryEntry } from "./hook-registry.js";
import { LEGACY_HOOK_DISABLE_NOTICE, readHookDisableCause } from "./hook-disable-state.js";

/** Quarantine must not erase a broken guard. Repair or remove its file to clear it. */
export function collectHookMatcherDiagnostics(
  hooksDir = defaultHooksDir(),
  disabledDir = join(hooksDir, ".disabled"),
): { notices: string[]; guards: HookRegistryEntry[] } {
  const notices: string[] = [];
  const guards: HookRegistryEntry[] = [];
  for (const [dir, disabled] of [[hooksDir, false], [disabledDir, true]] as const) {
    const { scripts, configs } = discoverHookTrustFiles(dir, disabled);
    const guardedScripts = scripts.filter((hook) => !disabled || readHookDisableCause(hook.path) !== "user");
    for (const hook of guardedScripts) {
      const invalid = hookMatcherError(hook.matcher);
      if (invalid) notices.push(`${hook.path}: matcher ${JSON.stringify(hook.matcher)} refused: ${invalid}${hook.hookType === "pre" || hook.hookType === "perm" ? "; all tool calls for this event are denied" : "; observation hook will not run"}`);
      if (invalid && disabled && readHookDisableCause(hook.path) === "legacy") notices.push(`${hook.path}: ${LEGACY_HOOK_DISABLE_NOTICE}`);
    }
    guards.push(...buildHookRegistry(guardedScripts, []).filter((entry) => entry.matcherError));
    for (const config of configs) {
      if (disabled && readHookDisableCause(config.path) === "user") continue;
      notices.push(...[...config.errors, ...config.warnings].map((notice) => `${config.path}: ${notice}`));
      if (config.errors.length && disabled && readHookDisableCause(config.path) === "legacy") notices.push(`${config.path}: ${LEGACY_HOOK_DISABLE_NOTICE}`);
      guards.push(...buildHookRegistry([], config.entries).filter((entry) => entry.matcherError));
    }
  }
  return { notices, guards };
}
