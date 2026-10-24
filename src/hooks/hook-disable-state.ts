import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";

export type HookDisableCause = "system-quarantine" | "user";

/** Sidecars follow the stored filename, including collision suffixes. */
export function hookDisableCausePath(path: string): string {
  return `${path}.disable-cause`;
}

/**
 * Missing, unreadable or non-regular records fail closed, including older
 * disabled files. A link is never followed: the opened file must be the one
 * lstat saw.
 */
export function readHookDisableCause(path: string): HookDisableCause | "legacy" {
  const sidecar = hookDisableCausePath(path);
  try {
    const seen = lstatSync(sidecar);
    if (!seen.isFile()) return "legacy";
    const fd = openSync(sidecar, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== seen.ino || opened.dev !== seen.dev) return "legacy";
      const cause = readFileSync(fd, "utf8").trim();
      if (cause === "system-quarantine" || cause === "user") return cause;
    } finally {
      closeSync(fd);
    }
  } catch { /* An unproven user disable must retain its guard. */ }
  return "legacy";
}

/**
 * Writes a private temp file and renames it over the sidecar. The rename
 * replaces whatever sits at the sidecar path, a planted link included,
 * without following it.
 */
export function writeHookDisableCause(path: string, cause: HookDisableCause): void {
  const sidecar = hookDisableCausePath(path);
  const tmp = `${sidecar}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${cause}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, sidecar);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function clearHookDisableCause(path: string): void {
  rmSync(hookDisableCausePath(path), { force: true });
}

/** Review stored copies by their original name, regardless of the rename suffix. */
export function disabledHookOriginalName(fileName: string): string | undefined {
  if (fileName.includes(".disable-cause") || /[/\\]/u.test(fileName)) return undefined;
  return /^((?:pre|post|perm)-[A-Za-z0-9._-]+\.sh|hooks\.json)(?:\..+)?$/u.exec(fileName)?.[1];
}

export const LEGACY_HOOK_DISABLE_NOTICE = "Disable cause is missing or invalid; treated as system-quarantined to retain matcher guards";
