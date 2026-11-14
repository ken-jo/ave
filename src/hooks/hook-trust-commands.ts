import { existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  buildAcceptedAtMap,
  defaultDisabledDir,
  defaultHooksDir,
  defaultLockfilePath,
  diffAgainstLockfile,
  disableHook,
  ensureHooksDirectory,
  hookMatcherError,
  persistLockfile,
  readLockfile,
  type DiscoveredHook,
  type HookDiff,
} from "./hook-discovery.js";
import {
  HOOKS_CONFIG_FILENAME,
  defaultHooksConfigPath,
  discoverHookTrustFiles,
  loadHookConfig,
} from "./hook-config-trust.js";
import type { HookConfigEntry } from "./hook-config.js";
import type { ScriptHookManager } from "./script-hook-manager.js";
import { collectHookMatcherDiagnostics } from "./hook-matcher-diagnostics.js";
import { clearHookDisableCause, disabledHookOriginalName, LEGACY_HOOK_DISABLE_NOTICE, readHookDisableCause, writeHookDisableCause } from "./hook-disable-state.js";
import type { HookSourceKind } from "./hook-source-policy.js";
import { createHookTrustValidator } from "./hook-trust-validator.js";

export interface HookTrustCommandOptions {
  sourceId?: string;
  hookSource?: HookSourceKind;
  expectedSha256?: string;
  hooksDir?: string;
  disabledDir?: string;
  lockfilePath?: string;
  manager?: ScriptHookManager;
}

export interface HookTrustRow {
  fileName: string;
  hookType: DiscoveredHook["hookType"];
  sha256: string;
  state: "trusted" | "new" | "changed" | "removed" | "disabled" | "managed";
  sourceId?: string;
  hookSource?: HookSourceKind;
  hashState?: "new" | "changed" | "trusted";
  projectTrusted?: boolean;
  previousSha256?: string;
  // Config trust rows expose command/event/matcher summaries; script rows omit them.
  source?: "sh" | "config";
  entryCount?: number;
  entries?: Array<{ id?: string; event: HookConfigEntry["event"]; matcher?: string; command: string }>;
  // Load rejections shown by the existing hook list, including matcher reasons.
  errors?: string[];
}

export type HookTrustCommandResult =
  | {
      ok: true;
      verb: "list";
      active: HookTrustRow[];
      disabled: HookTrustRow[];
    }
  | {
      ok: true;
      verb: "accept";
      accepted: HookTrustRow;
      trusted: HookTrustRow[];
    }
  | {
      ok: true;
      verb: "disable";
      disabled: HookTrustRow;
      trusted: HookTrustRow[];
    }
  | {
      ok: true;
      verb: "reject";
      rejected: HookTrustRow;
      trusted: HookTrustRow[];
    }
  | { ok: false; error: string };

function hooksDir(opts: HookTrustCommandOptions): string {
  return opts.hooksDir ?? defaultHooksDir();
}

function disabledDir(opts: HookTrustCommandOptions): string {
  return opts.disabledDir ?? defaultDisabledDir();
}

function lockfilePath(opts: HookTrustCommandOptions): string {
  return opts.lockfilePath ?? defaultLockfilePath();
}

function validateHookName(fileName: string): string | null {
  // Stored copies retain a recognized hook name; path separators are refused.
  if (disabledHookOriginalName(fileName)) return null;
  return "hook name must identify pre-*.sh, post-*.sh, perm-*.sh, or hooks.json (or a stored copy) without path separators";
}

function rowFromDiff(diff: HookDiff): HookTrustRow {
  return {
    ...rowFromHook(diff.hook, diff.state),
    ...(diff.previousSha256 ? { previousSha256: diff.previousSha256 } : {}),
  };
}

function rowFromHook(hook: DiscoveredHook, state: HookTrustRow["state"]): HookTrustRow {
  const invalid = hookMatcherError(hook.matcher);
  return {
    fileName: hook.fileName,
    hookType: hook.hookType,
    sha256: hook.sha256,
    state,
    ...(invalid === undefined ? {} : {
      errors: [`Matcher ${JSON.stringify(hook.matcher)} is not a valid regular expression (${invalid}) — hook not loaded`],
    }),
  };
}

function withConfigSummary(row: HookTrustRow, entries: HookConfigEntry[], errors: string[]): HookTrustRow {
  const runnable = entries.filter((entry) => entry.matcherError === undefined);
  return {
    ...row,
    source: "config",
    entryCount: runnable.length,
    ...(errors.length ? { errors } : {}),
    entries: runnable.map((e) => ({
      id: e.id,
      event: e.event,
      ...(e.matcher !== undefined ? { matcher: e.matcher } : {}),
      command: hookDefinitionSummary(e),
    })),
  };
}

export function hookDefinitionSummary(entry: HookConfigEntry): string {
  return entry.command.join(" ");
}

function configPath(opts: HookTrustCommandOptions): string {
  return defaultHooksConfigPath(hooksDir(opts));
}

// Show both active and disabled config copies when both exist.
function snapshot(opts: HookTrustCommandOptions): {
  active: DiscoveredHook[];
  disabled: DiscoveredHook[];
  lockfile: ReturnType<typeof readLockfile>;
  diff: HookDiff[];
} {
  ensureHooksDirectory(hooksDir(opts));
  const { hooks: active } = discoverHookTrustFiles(hooksDir(opts));
  const { hooks: disabled } = discoverHookTrustFiles(disabledDir(opts), true, hooksDir(opts));
  const lockfile = readLockfile(lockfilePath(opts));

  const diff = diffAgainstLockfile(active, lockfile, opts.sourceId);
  return { active, disabled, lockfile, diff };
}

async function persistTrustedHooks(
  trustedHooks: DiscoveredHook[],
  opts: HookTrustCommandOptions,
  previousAcceptedAt: ReturnType<typeof buildAcceptedAtMap>,
): Promise<HookTrustRow[]> {
  const byName = new Map<string, DiscoveredHook>();
  for (const hook of trustedHooks) byName.set(hook.fileName, hook);
  const trusted = [...byName.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));
  const current = snapshot(opts);
  const disabledNames = new Set(current.disabled.map((hook) => disabledHookOriginalName(hook.fileName)));
  const retainedDefinitions = current.lockfile?.hooks.filter((entry) => entry.sourceId === opts.sourceId && disabledNames.has(entry.fileName)
    && !byName.has(entry.fileName)).map((entry): DiscoveredHook => ({ fileName: entry.fileName, sha256: entry.sha256,
    path: "", size: 0, hookType: "pre" })) ?? [];
  await persistLockfile([...trusted, ...retainedDefinitions], lockfilePath(opts), previousAcceptedAt, opts.sourceId);
  // Rebuild the runtime registry: trusted `.sh` hooks + trusted `hooks.json` config entries (the latter only when the config trust unit is trusted).
  refreshManagerRegistry(trusted, opts);
  return trusted.map((hook) => rowFromHook(hook, "trusted"));
}

// Only trusted script and config entries reach the runtime; untrusted config contributes no commands.
function refreshManagerRegistry(trusted: DiscoveredHook[], opts: HookTrustCommandOptions): void {
  if (!opts.manager) return;
  const shHooks = trusted.filter((h) => h.fileName !== HOOKS_CONFIG_FILENAME);
  const configTrusted = trusted.some((h) => h.fileName === HOOKS_CONFIG_FILENAME);
  const configEntries = configTrusted ? loadHookConfig(configPath(opts)).entries : [];
  const validator = (fileName: string, expectedSha256: string) => createHookTrustValidator({ hooksDir: hooksDir(opts),
    fileName, expectedSha256, lockfilePath: lockfilePath(opts), sourceId: opts.sourceId });
  const configHash = trusted.find((hook) => hook.fileName === HOOKS_CONFIG_FILENAME)?.sha256 ?? "";
  opts.manager.setTrustedSourceRegistry(opts.sourceId ?? "user",
    shHooks.map((hook) => ({ ...hook, hookSource: opts.hookSource ?? "user", validateTrust: validator(hook.fileName, hook.sha256) })),
    configEntries.map((entry) => ({ ...entry, hookSource: opts.hookSource ?? "user", validateTrust: validator(HOOKS_CONFIG_FILENAME, configHash) })));
  opts.manager.setMatcherGuards(collectHookMatcherDiagnostics(hooksDir(opts), disabledDir(opts)).guards);
}

export function listHookTrustState(
  opts: HookTrustCommandOptions = {},
): Extract<HookTrustCommandResult, { verb: "list" }> {
  const { disabled, diff, lockfile } = snapshot(opts);
  const activeConfig = loadHookConfig(configPath(opts));
  return {
    ok: true,
    verb: "list",
    active: diff.filter((entry) => entry.state !== "removed" || !disabled.some((hook) => disabledHookOriginalName(hook.fileName) === entry.hook.fileName)).map((d) =>
      d.hook.fileName === HOOKS_CONFIG_FILENAME
        ? withConfigSummary(rowFromDiff(d), activeConfig.entries, activeConfig.errors)
        : rowFromDiff(d),
    ),
    disabled: disabled.map((hook) => {
      const config = disabledHookOriginalName(hook.fileName) === HOOKS_CONFIG_FILENAME ? loadHookConfig(hook.path, hooksDir(opts)) : undefined;
      const row = config
        ? withConfigSummary(rowFromHook(hook, "disabled"), config.entries, config.errors)
        : rowFromHook(hook, "disabled");
      if (readHookDisableCause(hook.path) === "legacy") row.errors = [...(row.errors ?? []), LEGACY_HOOK_DISABLE_NOTICE];
      const previous = lockfile?.hooks.find((entry) => entry.sourceId === opts.sourceId && entry.fileName === disabledHookOriginalName(hook.fileName));
      row.hashState = previous ? previous.sha256 === hook.sha256 ? "trusted" : "changed" : "new";
      if (previous && previous.sha256 !== hook.sha256) row.previousSha256 = previous.sha256;
      return row;
    }),
  };
}

export async function acceptHookTrust(
  fileName: string,
  opts: HookTrustCommandOptions = {},
): Promise<HookTrustCommandResult> {
  const invalid = validateHookName(fileName);
  if (invalid) return { ok: false, error: invalid };

  let state = snapshot(opts);
  let target = state.active.find((hook) => hook.fileName === fileName);
  const reviewed = target ?? state.disabled.find((hook) => hook.fileName === fileName);
  if (opts.expectedSha256 !== undefined && reviewed?.sha256 !== opts.expectedSha256) return { ok: false, error: "hook-review-stale" };
  if (!target) {
    const quarantined = state.disabled.find((hook) => hook.fileName === fileName);
    if (!quarantined) return { ok: false, error: `hook not found: ${fileName}` };
    const originalName = disabledHookOriginalName(fileName)!;
    const destination = join(hooksDir(opts), originalName);
    if (existsSync(destination)) {
      return { ok: false, error: `active hook already exists: ${fileName}` };
    }
    renameSync(quarantined.path, destination);
    clearHookDisableCause(quarantined.path);
    state = snapshot(opts);
    target = state.active.find((hook) => hook.fileName === originalName);
  }
  if (!target) return { ok: false, error: `hook not found after restore: ${fileName}` };
  if (opts.expectedSha256 !== undefined && target.sha256 !== opts.expectedSha256) return { ok: false, error: "hook-review-stale" };

  const acceptedAt = buildAcceptedAtMap(state.lockfile);
  const alreadyTrusted = state.diff
    .filter((entry) => entry.state === "trusted")
    .map((entry) => entry.hook);
  const trusted = await persistTrustedHooks(
    [...alreadyTrusted, target],
    opts,
    acceptedAt,
  );
  return {
    ok: true,
    verb: "accept",
    accepted: rowFromHook(target, "trusted"),
    trusted,
  };
}

export async function disableHookTrust(
  fileName: string,
  opts: HookTrustCommandOptions = {},
): Promise<HookTrustCommandResult> {
  const invalid = validateHookName(fileName);
  if (invalid) return { ok: false, error: invalid };

  const state = snapshot(opts);
  const active = state.active.find((hook) => hook.fileName === fileName);
  const reviewed = active ?? state.disabled.find((hook) => hook.fileName === fileName);
  if (opts.expectedSha256 !== undefined && reviewed?.sha256 !== opts.expectedSha256) return { ok: false, error: "hook-review-stale" };
  const acceptedAt = buildAcceptedAtMap(state.lockfile);
  if (!active) {
    const quarantined = state.disabled.find((hook) => hook.fileName === fileName);
    if (!quarantined) return { ok: false, error: `hook not found: ${fileName}` };
    writeHookDisableCause(quarantined.path, "user");
    const trusted = await persistTrustedHooks(
      state.diff.filter((entry) => entry.state === "trusted").map((entry) => entry.hook),
      opts,
      acceptedAt,
    );
    return {
      ok: true,
      verb: "disable",
      disabled: rowFromHook(quarantined, "disabled"),
      trusted,
    };
  }

  disableHook(active, disabledDir(opts), "user");
  const next = snapshot(opts);
  const trusted = await persistTrustedHooks(
    next.diff.filter((entry) => entry.state === "trusted").map((entry) => entry.hook),
    opts,
    acceptedAt,
  );
  return {
    ok: true,
    verb: "disable",
    disabled: rowFromHook(active, "disabled"),
    trusted,
  };
}

// Reject unlinks only disabled hooks; active hooks must be disabled first to avoid accidental deletion and record trust removal separately from expunging. Refresh the trusted snapshot after rejection.
export async function rejectHookTrust(
  fileName: string,
  opts: HookTrustCommandOptions = {},
): Promise<HookTrustCommandResult> {
  const invalid = validateHookName(fileName);
  if (invalid) return { ok: false, error: invalid };

  const state = snapshot(opts);
  const active = state.active.find((hook) => hook.fileName === fileName);
  if (active) {
    return {
      ok: false,
      error: `hook '${fileName}' is currently active — disable it first, then reject`,
    };
  }
  const quarantined = state.disabled.find((hook) => hook.fileName === fileName);
  if (!quarantined) return { ok: false, error: `hook not found: ${fileName}` };

  unlinkSync(quarantined.path);
  clearHookDisableCause(quarantined.path);

  const acceptedAt = buildAcceptedAtMap(state.lockfile);
  const trusted = await persistTrustedHooks(
    state.diff.filter((entry) => entry.state === "trusted").map((entry) => entry.hook),
    opts,
    acceptedAt,
  );
  return {
    ok: true,
    verb: "reject",
    rejected: rowFromHook(quarantined, "disabled"),
    trusted,
  };
}
