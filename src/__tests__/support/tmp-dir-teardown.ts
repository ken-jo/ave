/** Use shared async lock retries; foreign non-share-delete handles cause Windows EPERM, while Node handles allow deletion. */
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { retryOnTransientFsLock } from "../../lib/transient-fs-lock-retry.js";

export async function cleanupTmpDir(dir: string): Promise<void> {
  await retryOnTransientFsLock(() => rm(dir, { recursive: true, force: true }));
}

/** Remove links non-recursively; unlink or non-recursive rmdir must never traverse junction targets. */
export function removeLinkOnly(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code !== "EPERM" && code !== "EISDIR") throw error;
    rmdirSync(path);
  }
}

/** Use lstat to remove every link before recursively deleting the fixture tree. */
export function removeLinksUnder(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) removeLinkOnly(path);
    else if (entry.isDirectory()) removeLinksUnder(path);
  }
}

/** Track children per suite so failed awaits cannot leak lock owners or reap another suite's children. */
export function createChildTracker(): ChildTracker {
  const tracked: ChildProcess[] = [];
  return {
    track(child) {
      tracked.push(child);
      return child;
    },
    async reap() {
      const pending = tracked.splice(0);
      await Promise.all(pending.map(stopChild));
    },
  };
}

export interface ChildTracker {
  track: <T extends ChildProcess>(child: T) => T;
  /** Safe to call twice; wait until every tracked child has exited. */
  reap: () => Promise<void>;
}

/** Escalate to SIGKILL so a blocked child cannot hang teardown. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const escalation = setTimeout(() => child.kill("SIGKILL"), CHILD_TERM_GRACE_MS);
  try {
    await exited;
  } finally {
    clearTimeout(escalation);
  }
}

const CHILD_TERM_GRACE_MS = 2_000;

/** Track scratch directories per suite to avoid sweeping another suite's tree. */
export function createTmpDirTracker(): TmpDirTracker {
  const dirs = new Set<string>();
  return {
    track(dir) {
      dirs.add(dir);
      return dir;
    },
    async cleanup() {
      const pending = [...dirs];
      dirs.clear();
      for (const dir of pending) await cleanupTmpDir(dir);
    },
  };
}

export interface TmpDirTracker {
  track: (dir: string) => string;
  /** Safe to call twice; transient lock failures are retried. */
  cleanup: () => Promise<void>;
}
