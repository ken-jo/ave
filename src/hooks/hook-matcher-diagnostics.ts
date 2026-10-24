import { join } from "node:path";
import { defaultHooksDir, hookMatcherError } from "./hook-discovery.js";
import { discoverHookTrustFiles } from "./hook-config-trust.js";
import { buildHookRegistry, type HookRegistryEntry } from "./hook-registry.js";

/** Quarantine must not erase a broken guard. Repair or remove its file to clear it. */
export function collectHookMatcherDiagnostics(
  hooksDir = defaultHooksDir(),
  disabledDir = join(hooksDir, ".disabled"),
): { notices: string[]; guards: HookRegistryEntry[] } {
  const notices: string[] = [];
  const guards: HookRegistryEntry[] = [];
  for (const dir of [hooksDir, disabledDir]) {
    const { scripts, config } = discoverHookTrustFiles(dir);
    for (const hook of scripts) {
      const invalid = hookMatcherError(hook.matcher);
      if (invalid) notices.push(`${hook.path}: matcher ${JSON.stringify(hook.matcher)} refused: ${invalid}${hook.hookType === "pre" || hook.hookType === "perm" ? "; all tool calls for this event are denied" : "; observation hook will not run"}`);
    }
    guards.push(...buildHookRegistry(scripts, []).filter((entry) => entry.matcherError));
    notices.push(...[...config.errors, ...config.warnings].map((notice) => `${config.path}: ${notice}`));
    guards.push(...buildHookRegistry([], config.entries).filter((entry) => entry.matcherError));
  }
  return { notices, guards };
}
