import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

export type HookDisableCause = "system-quarantine" | "user";

/** Sidecars follow the stored filename, including collision suffixes. */
export function hookDisableCausePath(path: string): string {
  return `${path}.disable-cause`;
}

/** Missing or unreadable records fail closed, including older disabled files. */
export function readHookDisableCause(path: string): HookDisableCause | "legacy" {
  try {
    const cause = readFileSync(hookDisableCausePath(path), "utf8").trim();
    if (cause === "system-quarantine" || cause === "user") return cause;
  } catch { /* An unproven user disable must retain its guard. */ }
  return "legacy";
}

/** Replaces any old record; exclusive create never writes through a link at the sidecar path. */
export function writeHookDisableCause(path: string, cause: HookDisableCause): void {
  clearHookDisableCause(path);
  const fd = openSync(hookDisableCausePath(path), "wx", 0o600);
  try {
    writeSync(fd, `${cause}\n`);
  } finally {
    closeSync(fd);
  }
}

export function clearHookDisableCause(path: string): void {
  rmSync(hookDisableCausePath(path), { force: true });
}

/** Review stored copies by their original name, regardless of the rename suffix. */
export function disabledHookOriginalName(fileName: string): string | undefined {
  if (fileName.endsWith(".disable-cause") || /[/\\]/u.test(fileName)) return undefined;
  return /^((?:pre|post|perm)-[A-Za-z0-9._-]+\.sh|hooks\.json)(?:\..+)?$/u.exec(fileName)?.[1];
}

export const LEGACY_HOOK_DISABLE_NOTICE = "Disable cause is missing or invalid; treated as system-quarantined to retain matcher guards";
