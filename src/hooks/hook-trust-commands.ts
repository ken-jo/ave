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

export interface HookTrustCommandOptions {
  hooksDir?: string;
  disabledDir?: string;
  lockfilePath?: string;
  manager?: ScriptHookManager;
}

export interface HookTrustRow {
  fileName: string;
  hookType: DiscoveredHook["hookType"];
  sha256: string;
  state: "trusted" | "new" | "changed" | "removed" | "disabled";
  previousSha256?: string;
  /**
   * #811 trust-review additive fields (STEP 6 — additive, renderer-optional).
   * `source` distinguishes a legacy `.sh` hook from the declarative `hooks.json`
   * trust unit. For the config row we summarize its declared entries so the
   * `/permission hooks list` text surface shows command/event/matcher without a
   * renderer change. Absent on `.sh` rows (back-compat).
   */
  source?: "sh" | "config";
  /** Number of declared command entries (config row only). */
  entryCount?: number;
  /** Per-entry summaries (config row only): event + matcher + command. */
  entries?: Array<{ event: HookConfigEntry["event"]; matcher?: string; command: string }>;
  /** Load rejections shown by the existing hook list, including matcher reasons. */
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

/** Summarize parsed config entries onto a trust row (STEP 6 additive fields). */
function withConfigSummary(row: HookTrustRow, entries: HookConfigEntry[], errors: string[]): HookTrustRow {
  const runnable = entries.filter((entry) => entry.matcherError === undefined);
  return {
    ...row,
    source: "config",
    entryCount: runnable.length,
    ...(errors.length ? { errors } : {}),
    entries: runnable.map((e) => ({
      event: e.event,
      ...(e.matcher !== undefined ? { matcher: e.matcher } : {}),
      command: e.command.join(" "),
    })),
  };
}

function configPath(opts: HookTrustCommandOptions): string {
  return defaultHooksConfigPath(hooksDir(opts));
}

/**
 * Snapshot the `.sh` + `hooks.json` trust surface. The config trust unit rides
 * the same `DiscoveredHook` flow: when `hooks.json` exists in the hooks dir it
 * is folded into `active` (and the diff); when it only exists under `.disabled/`
 * it is folded into `disabled`. Both copies remain visible when present.
 */
function snapshot(opts: HookTrustCommandOptions): {
  active: DiscoveredHook[];
  disabled: DiscoveredHook[];
  lockfile: ReturnType<typeof readLockfile>;
  diff: HookDiff[];
} {
  ensureHooksDirectory(hooksDir(opts));
  const { hooks: active } = discoverHookTrustFiles(hooksDir(opts));
  const { hooks: disabled } = discoverHookTrustFiles(disabledDir(opts), true);
  const lockfile = readLockfile(lockfilePath(opts));

  const diff = diffAgainstLockfile(active, lockfile);
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
  await persistLockfile(trusted, lockfilePath(opts), previousAcceptedAt);
  // Rebuild the runtime registry: trusted `.sh` hooks + trusted `hooks.json`
  // config entries (the latter only when the config trust unit is trusted).
  refreshManagerRegistry(trusted, opts);
  return trusted.map((hook) => rowFromHook(hook, "trusted"));
}

/**
 * Feed the runtime manager the unified registry derived from the trusted set.
 * Trusted `.sh` hooks become `sh` registry entries; if the `hooks.json` trust
 * unit is in the trusted set, its parsed entries become `config` registry
 * entries. An untrusted `hooks.json` contributes NOTHING — its commands never
 * reach the runtime.
 */
function refreshManagerRegistry(trusted: DiscoveredHook[], opts: HookTrustCommandOptions): void {
  if (!opts.manager) return;
  const shHooks = trusted.filter((h) => h.fileName !== HOOKS_CONFIG_FILENAME);
  const configTrusted = trusted.some((h) => h.fileName === HOOKS_CONFIG_FILENAME);
  const configEntries = configTrusted ? loadHookConfig(configPath(opts)).entries : [];
  opts.manager.setTrustedRegistry(shHooks, configEntries);
  opts.manager.setMatcherGuards(collectHookMatcherDiagnostics(hooksDir(opts), disabledDir(opts)).guards);
}

export function listHookTrustState(
  opts: HookTrustCommandOptions = {},
): Extract<HookTrustCommandResult, { verb: "list" }> {
  const { disabled, diff } = snapshot(opts);
  const activeConfig = loadHookConfig(configPath(opts));
  return {
    ok: true,
    verb: "list",
    active: diff.map((d) =>
      d.hook.fileName === HOOKS_CONFIG_FILENAME
        ? withConfigSummary(rowFromDiff(d), activeConfig.entries, activeConfig.errors)
        : rowFromDiff(d),
    ),
    disabled: disabled.map((hook) => {
      const config = disabledHookOriginalName(hook.fileName) === HOOKS_CONFIG_FILENAME ? loadHookConfig(hook.path) : undefined;
      const row = config
        ? withConfigSummary(rowFromHook(hook, "disabled"), config.entries, config.errors)
        : rowFromHook(hook, "disabled");
      if (readHookDisableCause(hook.path) === "legacy") row.errors = [...(row.errors ?? []), LEGACY_HOOK_DISABLE_NOTICE];
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

/**
 * Permission policy architect round-4 ③ — `permission hooks reject <name>` permanently
 * removes a quarantined hook from `~/.config/ave/hooks/.disabled/`.
 *
 * Two-step contract: an active (trusted) hook MUST be `disable`d first;
 * `reject` only operates on `.disabled/` entries. Rationale:
 *   - destructive (unlink) — guard against single-typo data loss
 *   - audit clarity — the `disable → reject` pair is two distinct events,
 *     so the trail records "user removed trust, then user expunged file"
 *   - mirrors filesystem ergonomics — you don't `rm` a running script
 *
 * No lockfile mutation is required: the rejected file was already in
 * `.disabled/`, so it was already absent from `lockfile.hooks`. We
 * still re-persist the trusted set to refresh `acceptedAt` timestamps
 * for an audit-friendly snapshot.
 */
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
