// Boot quarantines every new or changed hook without prompting or silently allowing it; production enrollment requires a user-keyboard accept command (docs/architecture/permission-policy-design.md).
import { existsSync } from "node:fs";
import {
  buildAcceptedAtMap,
  diffAgainstLockfile,
  disableHook,
  discoverHooks,
  ensureHooksDirectory,
  persistLockfile,
  readLockfile,
  type DiscoveredHook,
  type HookDiff,
  type LockfileShape,
} from "./hook-discovery.js";
import {
  HOOKS_CONFIG_FILENAME,
  defaultHooksConfigPath,
  loadHookConfig,
  syntheticConfigHook,
} from "./hook-config-trust.js";
import type { HookConfigEntry } from "./hook-config.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("hook-trust");

export interface TrustPromptDecision {
  fileName: string;
  trust: boolean;
}

export interface TrustPromptDispatcher {
  // Surface the diff to the user. Returns the decision array. The orchestrator already filters `removed` entries (no UX needed).
  prompt(diff: HookDiff[]): Promise<TrustPromptDecision[]>;
}

export interface RunHookTrustOptions {
  hooksDir?: string;
  lockfilePath?: string;
  disabledDir?: string;
  // Test dispatcher. Production omits this so every untrusted hook is auto-disabled (strict-deny).
  promptDispatcher?: TrustPromptDispatcher;
}

export interface RunHookTrustResult {
  // Includes the synthetic config trust unit when trusted.
  trustedHooks: DiscoveredHook[];
  disabledHooks: DiscoveredHook[];
  lockfile: LockfileShape | null;
  diff: HookDiff[];
  // Config entries remain empty unless their whole trust unit is trusted; untrusted or changed commands never reach runtime.
  trustedConfigEntries: HookConfigEntry[];
}

// Call once at boot; atomic lockfile writes serialize concurrent boots.
export async function runHookTrustWorkflow(
  options: RunHookTrustOptions = {},
): Promise<RunHookTrustResult> {
  // Fresh installs require an empty hooks directory.
  ensureHooksDirectory(options.hooksDir);

  const shHooks = discoverHooks(options.hooksDir);
  // The composite config hash shares script quarantine; changed or untrusted config commands must not load.
  const configPath = defaultHooksConfigPath(options.hooksDir);
  const loadedConfig = loadHookConfig(configPath);
  const configHook = syntheticConfigHook(loadedConfig);
  const discovered = configHook ? [...shHooks, configHook] : shHooks;

  const lockfile = readLockfile(options.lockfilePath);
  const acceptedAtMap = buildAcceptedAtMap(lockfile);
  const diff = diffAgainstLockfile(discovered, lockfile);

  const newOrChanged = diff.filter(
    (d) => d.state === "new" || d.state === "changed",
  );
  const trusted = diff.filter((d) => d.state === "trusted").map((d) => d.hook);

  const configTrusted = (trustedSet: DiscoveredHook[]): HookConfigEntry[] =>
    trustedSet.some((h) => h.fileName === HOOKS_CONFIG_FILENAME)
      ? loadedConfig.entries
      : [];

  if (newOrChanged.length === 0) {
    // Refresh deleted entries out of the lockfile so removed hooks stop appearing in later diffs.
    const removed = diff.filter((d) => d.state === "removed");
    if (removed.length > 0 && lockfile) {
      const next = await persistLockfile(trusted, options.lockfilePath, acceptedAtMap);
      return {
        trustedHooks: trusted,
        disabledHooks: [],
        lockfile: next,
        diff,
        trustedConfigEntries: configTrusted(trusted),
      };
    }
    return {
      trustedHooks: trusted,
      disabledHooks: [],
      lockfile,
      diff,
      trustedConfigEntries: configTrusted(trusted),
    };
  }

  // Test dispatcher path; production omits it and strict-denies.
  let decisions: TrustPromptDecision[];
  let promptCompleted = false;
  if (options.promptDispatcher) {
    try {
      decisions = await options.promptDispatcher.prompt(newOrChanged);
      promptCompleted = true;
    } catch (err) {
      log.warn(
        "hook-trust: prompt dispatcher failed (%s) — strict-deny applied",
        (err as Error).message,
      );
      decisions = newOrChanged.map((d) => ({ fileName: d.hook.fileName, trust: false }));
    }
  } else {
    log.info(
      "hook-trust: no prompt dispatcher (headless) — auto-disabling %d untrusted hook(s)",
      newOrChanged.length,
    );
    decisions = newOrChanged.map((d) => ({ fileName: d.hook.fileName, trust: false }));
  }

  const newlyTrusted: DiscoveredHook[] = [];
  const disabled: DiscoveredHook[] = [];
  for (const d of newOrChanged) {
    const decision = decisions.find((x) => x.fileName === d.hook.fileName);
    if (decision?.trust) {
      newlyTrusted.push(d.hook);
    } else {
      // Skip if the file already vanished between diff and decision.
      if (existsSync(d.hook.path)) {
        try {
          disableHook(d.hook, options.disabledDir, promptCompleted && decision?.trust === false ? "user" : "system-quarantine");
          disabled.push(d.hook);
        } catch (err) {
          log.warn(
            "hook-trust: disable failed for %s: %s",
            d.hook.fileName,
            (err as Error).message,
          );
        }
      }
    }
  }

  const allTrusted = [...trusted, ...newlyTrusted];
  const next = await persistLockfile(allTrusted, options.lockfilePath, acceptedAtMap);
  return {
    trustedHooks: allTrusted,
    disabledHooks: disabled,
    lockfile: next,
    diff,
    trustedConfigEntries: configTrusted(allTrusted),
  };
}
