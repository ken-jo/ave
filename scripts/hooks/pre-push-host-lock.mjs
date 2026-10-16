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
// Ownership is prepared in a private directory, then published by renaming
// that nonempty directory into place atomically. The owner filename carries
// its unique generation. Release and stale recovery unlink only that filename
// and use non-recursive rmdir: a delayed remover cannot delete a successor's
// owner file or its nonempty directory. No separate reaper lock is needed.
//
// Settings (environment):
//   AVE_PREPUSH_LOCK_DIR        directory for the lock files (default: /tmp,
//                               or the OS temp directory on Windows)
//   AVE_PREPUSH_LOCK_TIMEOUT_S  seconds to wait for a turn before the push
//                               fails (default 3600)
//   AVE_PREPUSH_FAST_SLOTS      concurrent fast-tier runs per host (default 4)

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ownerFilename = (token) => `owner-${token}.json`;
const OWNER_FILENAME = /^owner-([A-Za-z0-9-]{1,128})\.json$/;
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
  let token;
  try {
    const files = readdirSync(lockPath);
    if (files.length === 0) return { state: "absent" };
    if (files.length !== 1) return { state: "malformed" };
    token = OWNER_FILENAME.exec(files[0])?.[1];
    if (!token) return { state: "malformed" };
    const owner = JSON.parse(readFileSync(join(lockPath, ownerFilename(token)), "utf8"));
    if (Number.isInteger(owner?.pid) && owner.pid > 0 && owner.token === token && SAFE_TOKEN.test(owner.token)) {
      return { state: "valid", pid: owner.pid, token: owner.token };
    }
    return { state: "malformed", token };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    if (error instanceof SyntaxError) return { state: "malformed", token };
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

// A lock is stale when its recorded owner is gone. Malformed metadata gets a
// grace period; recovery can only remove its generation-specific filename.
function isStale(owner, ageMs) {
  if (owner.state === "valid") return !isProcessAlive(owner.pid);
  // Published generations are never empty. rmdir can safely recover an empty
  // path even if a contender has already replaced it with a nonempty holder.
  if (owner.state === "absent") return true;
  return ageMs !== null && ageMs >= ORPHANED_LOCK_GRACE_MS;
}

function createOwnedDirectory(path, token, now) {
  const pending = `${path}.pending-${token}`;
  mkdirSync(pending);
  try {
    writeFileSync(join(pending, ownerFilename(token)), JSON.stringify({
      pid: process.pid,
      token,
      createdAt: new Date(now()).toISOString(),
    }), { encoding: "utf8", flag: "wx" });
    try {
      renameSync(pending, path);
      return { published: true };
    } catch (error) {
      // An existing destination can reject directory publication with any of
      // these errnos. Inspect ownership before retrying or taking another slot.
      if (["EPERM", "EEXIST", "ENOTEMPTY"].includes(error?.code)) return { published: false };
      throw error;
    }
  } finally {
    // Only the private, unpublished generation is ever recursively removed.
    rmSync(pending, { recursive: true, force: true });
  }
}

// The filename is a generation-specific removal capability. Even if this
// process pauses after unlink, rmdir refuses a nonempty successor directory.
function removeGeneration(lockPath, token) {
  if (token !== undefined) {
    try {
      unlinkSync(join(lockPath, ownerFilename(token)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    rmdirSync(lockPath);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
  }
}

// One non-blocking attempt on one lock path: a release function, or the
// holder seen ({ pid } or { pid: null } for unknown ownership).
function tryAcquire(lockPath, now) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    const { published } = createOwnedDirectory(lockPath, token, now);
    if (published) {
      return {
        release() {
          const owner = readOwner(lockPath);
          if (owner.state === "valid" && owner.token === token) removeGeneration(lockPath, token);
        },
      };
    }
    const owner = readOwner(lockPath);
    const ageMs = lockAgeMs(lockPath, now);
    // The destination may disappear before inspection. Retry admission, and
    // still refuse at the timeout if publication keeps failing without an owner.
    if (ageMs === null) continue;
    if (!isStale(owner, ageMs)) return { holderPid: owner.state === "valid" ? owner.pid : null };
    console.log(
      `[checks] reclaiming stale host lock ${lockPath} ` +
        (owner.state === "valid" ? `(owner PID ${owner.pid} is not running)` : "(no owner was recorded)")
    );
    removeGeneration(lockPath, owner.token);
  }
  return { holderPid: null };
}

/**
 * Run synchronous `callback` while holding one of `slots` host-wide locks named `name`
 * (omitting slots uses one exclusive lock; specifying slots uses indexed
 * pool paths even for one slot). Waits, printing who holds the lock, and
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
  const paths = options.slots === undefined
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
