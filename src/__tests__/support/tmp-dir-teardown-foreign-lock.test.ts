/**
 * The teardown helper against a REAL Windows lock, not an injected error code.
 *
 * `artifact-store-test-helpers.test.ts` already proves the retry rule by
 * mocking `rm` to reject. What it cannot show is that the rule is aimed at the
 * condition that actually occurs:
 *
 *   - a handle THIS process holds never produces the `EPERM` refusal, so "we
 *     forgot to await a write" cannot be the cause of the reported failures;
 *   - a foreign lock must prevent deletion for as long as it is held, even
 *     when the caller supplies a retry budget. The lock must outlive that
 *     budget rather than expire while a synchronous removal is waiting.
 *
 * The lock is taken by a separate process with `FileShare.None`, which is what
 * a scanner does and what Node's `fs` never does. Windows-only by nature: the
 * failure mode does not exist on the other platforms, so there is nothing to
 * assert there.
 */
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "./tmp-dir-teardown.js";

const isWindows = process.platform === "win32";

/** A scratch tree shaped like the audit fixtures: a file a few levels down. */
function makeTree(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "ave-teardown-lock-"));
  const inner = join(dir, ".ave", "audit");
  mkdirSync(inner, { recursive: true });
  const file = join(inner, "permission-audit.jsonl");
  writeFileSync(file, "line\n", "utf-8");
  return { dir, file };
}

/** Stop the lock owner and wait until its non-share-delete handle is gone. */
async function stopForeignLock(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

/**
 * Hold `file` from another process without sharing delete. Wait for its ready
 * message before probing access: polling with openSync can itself prevent the
 * child from acquiring its exclusive handle.
 */
async function holdForeignLock(file: string, holdMs?: number): Promise<ChildProcess> {
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; $f=[System.IO.File]::Open('${file}','Open','ReadWrite','None');`
        + " try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); "
        + (holdMs === undefined ? "$null=[Console]::In.ReadLine()" : `Start-Sleep -Milliseconds ${holdMs}`)
        + " } finally { $f.Dispose() }",
    ],
    // With no duration the parent owns the lock lifetime, including while
    // synchronous removal blocks its event loop. Teardown stops the owner.
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const readiness = new AbortController();
  const timeout = setTimeout(() => readiness.abort(), 10_000);
  try {
    if (!child.stdout) throw new Error("foreign lock owner has no readiness pipe");
    const [message] = await Promise.race([
      once(child.stdout, "data", { signal: readiness.signal }),
      once(child, "exit", { signal: readiness.signal }).then(() => {
        throw new Error(`foreign lock owner exited before locking: ${stderr}`);
      }),
    ]);
    if (String(message).trim() !== "locked") throw new Error("invalid foreign lock readiness message");
    try {
      closeSync(openSync(file, "r+"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") return child;
      throw error;
    }
    throw new Error("foreign lock did not deny access");
  } catch (error) {
    if (child.pid) await stopForeignLock(child);
    throw error;
  } finally {
    clearTimeout(timeout);
    readiness.abort();
  }
}

describe.skipIf(!isWindows)("scratch-directory teardown under a foreign lock", () => {
  it("refuses a foreign-locked tree even after its retry budget", async () => {
    const { dir, file } = makeTree();
    let child: ChildProcess | undefined;
    try {
      child = await holdForeignLock(file);
      // Intentional behavior probe; fixture teardown stays in the finally block.
      expect(() =>
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
      ).toThrow(/EPERM|EBUSY|EACCES/);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(child.exitCode).toBeNull();
      expect(() => closeSync(openSync(file, "r+"))).toThrow(/EPERM|EBUSY|EACCES/);
    } finally {
      if (child) await stopForeignLock(child);
      await cleanupTmpDir(dir);
    }
    expect(existsSync(dir)).toBe(false);
  });

  it("succeeds through the retry ladder once the lock clears", async () => {
    const { dir, file } = makeTree();
    // Long enough to outlast what the old teardown could wait for, short
    // enough to sit inside the ladder's budget.
    let child: ChildProcess | undefined;
    try {
      child = await holdForeignLock(file, 800);
      await cleanupTmpDir(dir);
      expect(existsSync(dir)).toBe(false);
    } finally {
      if (child) await stopForeignLock(child);
      await cleanupTmpDir(dir);
    }
  });

  it("is never the EPERM signature when the open handle is this process's own", async () => {
    // Node opens with FILE_SHARE_DELETE, so our own descriptor cannot produce
    // the refusal above. It can still leave the parent momentarily non-empty —
    // that is a DIFFERENT, retryable code, and one the old teardown's
    // `maxRetries` did cover. The distinction is the whole diagnosis: an
    // unawaited write of ours would have to show up as that code, not as EPERM,
    // so awaiting harder was never going to fix the reported failures.
    const { dir, file } = makeTree();
    const fd = openSync(file, "a");
    let code: string | undefined;
    try {
      try {
        // Intentional behavior probe; fixture teardown stays in the finally block.
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        code = (err as NodeJS.ErrnoException).code;
      }
    } finally {
      closeSync(fd);
      await cleanupTmpDir(dir);
    }

    expect(code).not.toBe("EPERM");
    expect(existsSync(dir)).toBe(false);
  });
});
