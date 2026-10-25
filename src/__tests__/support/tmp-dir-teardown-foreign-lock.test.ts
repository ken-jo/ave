/** A foreign process holds a non-share-delete Windows handle beyond the retry budget. */
import { describe, it, expect } from "vitest";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
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

function makeTree(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "ave-teardown-lock-"));
  const inner = join(dir, ".ave", "audit");
  mkdirSync(inner, { recursive: true });
  const file = join(inner, "permission-audit.jsonl");
  writeFileSync(file, "line\n", "utf-8");
  return { dir, file };
}

async function stopForeignLock(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

/** Wait for the lock owner's ready message; polling openSync can block its exclusive open. */
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
    // The parent owns lock lifetime even while synchronous removal blocks its event loop.
    { stdio: ["pipe", "pipe", "pipe"], env: windowsPowerShellEnv() },
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
    // Node opens with FILE_SHARE_DELETE; its own handles cannot reproduce a foreign EPERM lock.
    const { dir, file } = makeTree();
    const fd = openSync(file, "a");
    let code: string | undefined;
    try {
      try {
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
