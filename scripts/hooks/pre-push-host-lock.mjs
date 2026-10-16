// Host-wide admission for pre-push checks.
//
// Several checkouts of this repository on one machine push at once (parallel
// writers, each in its own clone). Each full tier runs the whole suite and the
// build; two or more of them together pushed the load average past 190 and
// load-sensitive tests timed out, which then failed pushes that were correct.
// The full tier therefore takes one exclusive host lock, and the fast tier
// takes one of a few shared slots. The lock only orders runs: it never skips
// or shortens a check, and a run that cannot get its turn before the timeout
// fails the push instead of passing it.
//
// A lock is a directory created with mkdir (atomic on every platform) holding
// owner.json ({ pid, token, createdAt }). A lock whose owner PID is no longer
// running, or that never recorded an owner within ORPHANED_LOCK_GRACE_MS, is
// stale and reclaimed. Reclaiming runs under a short-lived `<lock>.reaper`
// directory and re-reads the owner token inside it, so two waiters that both
// saw the same dead owner cannot remove the lock the first of them acquired.
//
// Settings (environment):
//   AVE_PREPUSH_LOCK_DIR        directory for the lock files (default: /tmp,
//                               or the OS temp directory on Windows)
//   AVE_PREPUSH_LOCK_TIMEOUT_S  seconds to wait for a turn before the push
//                               fails (default 3600)
//   AVE_PREPUSH_FAST_SLOTS      concurrent fast-tier runs per host (default 4)

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER_FILE = "owner.json";
const ORPHANED_LOCK_GRACE_MS = 10_000;
const DEFAULT_TIMEOUT_S = 3600;
const DEFAULT_FAST_SLOTS = 4;
const WAIT_NOTICE_INTERVAL_MS = 60_000;
const SAFE_TOKEN = /^[A-Za-z0-9-]{1,128}$/;

function positiveWholeNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) {
    throw new Error(`[PRE_PUSH_HOST_LOCK] ${name} must be a positive whole number (got ${JSON.stringify(raw)})`);
  }
  return Number(raw);
}

export function resolveHostLockSettings(env = process.env) {
  const directory = env.AVE_PREPUSH_LOCK_DIR || (process.platform === "win32" ? tmpdir() : "/tmp");
  return {
    directory,
    timeoutMs: positiveWholeNumber(env, "AVE_PREPUSH_LOCK_TIMEOUT_S", DEFAULT_TIMEOUT_S) * 1000,
    fastSlots: positiveWholeNumber(env, "AVE_PREPUSH_FAST_SLOTS", DEFAULT_FAST_SLOTS),
  };
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the PID exists but belongs to another user.
    return error?.code !== "ESRCH";
  }
}

function readOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, OWNER_FILE), "utf8"));
    if (Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner.token === "string" && SAFE_TOKEN.test(owner.token)) {
      return { state: "valid", pid: owner.pid, token: owner.token };
    }
    return { state: "malformed" };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    if (error instanceof SyntaxError) return { state: "malformed" };
    throw error;
  }
}

function lockAgeMs(lockPath, now) {
  try {
    return Math.max(0, now() - statSync(lockPath).mtimeMs);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// A lock is stale when its recorded owner is gone, or when it recorded no
// readable owner long after it was created (the creator died in between).
function isStale(owner, ageMs) {
  if (owner.state === "valid") return !isProcessAlive(owner.pid);
  return ageMs !== null && ageMs >= ORPHANED_LOCK_GRACE_MS;
}

function createOwnedDirectory(path, token, now) {
  mkdirSync(path);
  try {
    writeFileSync(join(path, OWNER_FILE), JSON.stringify({
      pid: process.pid,
      token,
      createdAt: new Date(now()).toISOString(),
    }), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

// Remove a stale lock whose owner token (or absent owner) the caller saw.
// Returns true when the caller should retry acquiring at once.
function reclaimStaleLock(lockPath, seen, now) {
  const reaperPath = `${lockPath}.reaper`;
  const token = randomUUID();
  try {
    createOwnedDirectory(reaperPath, token, now);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    // Another waiter is reclaiming. A reaper whose owner died mid-reclaim is
    // moved aside under a unique name first, so only one waiter removes it.
    const reaperOwner = readOwner(reaperPath);
    if (isStale(reaperOwner, lockAgeMs(reaperPath, now))) {
      const aside = `${reaperPath}.stale-${token}`;
      try {
        renameSync(reaperPath, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
    return false;
  }
  try {
    const current = readOwner(lockPath);
    const sameOwner = seen.state === "valid"
      ? current.state === "valid" && current.token === seen.token
      : current.state !== "valid";
    if (!sameOwner || !isStale(current, lockAgeMs(lockPath, now))) return true;
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } finally {
    const reaperOwner = readOwner(reaperPath);
    if (reaperOwner.state === "valid" && reaperOwner.token === token) {
      rmSync(reaperPath, { recursive: true, force: true });
    }
  }
}

// One non-blocking attempt on one lock path: a release function, or the
// holder seen ({ pid } or { pid: null } while the holder is still writing).
function tryAcquire(lockPath, now) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    try {
      createOwnedDirectory(lockPath, token, now);
      return {
        release() {
          const owner = readOwner(lockPath);
          if (owner.state === "valid" && owner.token === token) rmSync(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const owner = readOwner(lockPath);
    const ageMs = lockAgeMs(lockPath, now);
    if (ageMs === null) continue;
    if (!isStale(owner, ageMs)) return { holderPid: owner.state === "valid" ? owner.pid : null };
    console.log(
      `[checks] reclaiming stale host lock ${lockPath} ` +
        (owner.state === "valid" ? `(owner PID ${owner.pid} is not running)` : "(no owner was recorded)")
    );
    if (!reclaimStaleLock(lockPath, owner, now)) return { holderPid: null };
  }
  return { holderPid: null };
}

/**
 * Run `callback` while holding one of `slots` host-wide locks named `name`
 * (slots = 1 is an exclusive lock). Waits, printing who holds the lock, and
 * throws once `timeoutMs` passes without a turn. The lock is released when
 * the callback returns or throws; a killed process leaves a lock that the
 * next waiter reclaims by PID liveness.
 */
export function withHostLock(options, callback) {
  const {
    name,
    label,
    directory,
    timeoutMs,
    slots = 1,
    pollMs = 1000,
    now = Date.now,
    sleep = sleepSync,
    log = console.log,
  } = options;
  if (!/^[a-z][a-z0-9-]*$/.test(name ?? "")) throw new Error(`[PRE_PUSH_HOST_LOCK] invalid lock name ${name}`);
  if (!directory) throw new Error("[PRE_PUSH_HOST_LOCK] lock directory is required");
  if (!Number.isSafeInteger(slots) || slots < 1) throw new Error(`[PRE_PUSH_HOST_LOCK] invalid slot count ${slots}`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error(`[PRE_PUSH_HOST_LOCK] invalid timeout ${timeoutMs}`);
  mkdirSync(directory, { recursive: true });
  const paths = slots === 1
    ? [join(directory, `ave-prepush-${name}.lock`)]
    : Array.from({ length: slots }, (_, slot) => join(directory, `ave-prepush-${name}-${slot}.lock`));

  const startedAt = now();
  let lastNoticeAt = null;
  let held = null;
  while (held === null) {
    const holders = [];
    for (const path of paths) {
      const result = tryAcquire(path, now);
      if (result.release) {
        held = result;
        break;
      }
      holders.push(result.holderPid === null ? "unknown PID" : `PID ${result.holderPid}`);
    }
    if (held !== null) break;
    const waitedMs = now() - startedAt;
    if (waitedMs >= timeoutMs) {
      throw new Error(
        `[PRE_PUSH_HOST_LOCK_TIMEOUT] waited ${Math.round(waitedMs / 1000)}s for the ${label} host lock ` +
          `(held by ${holders.join(", ")}: ${paths.join(", ")}); no checks ran and the push is refused. ` +
          "Push again when that run finishes, or raise AVE_PREPUSH_LOCK_TIMEOUT_S.",
      );
    }
    if (lastNoticeAt === null || now() - lastNoticeAt >= WAIT_NOTICE_INTERVAL_MS) {
      log(
        `[checks] waiting for the ${label} host lock held by ${holders.join(", ")} ` +
          `(${Math.round(waitedMs / 1000)}s of ${Math.round(timeoutMs / 1000)}s; AVE_PREPUSH_LOCK_TIMEOUT_S sets the limit)`,
      );
      lastNoticeAt = now();
    }
    sleep(pollMs);
  }
  if (lastNoticeAt !== null) {
    log(`[checks] acquired the ${label} host lock after ${Math.round((now() - startedAt) / 1000)}s`);
  }
  try {
    return callback();
  } finally {
    held.release();
  }
}
