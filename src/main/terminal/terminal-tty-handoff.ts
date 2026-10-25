// macOS must grant terminal ioctls to exactly this shell’s slave device.
// Spawn blocks on a fixed FIFO trampoline until ptsName is known, then exec the confined shell without changing PID or session.
// The trampoline is initially unsandboxed: keep its FIFO under the host-only handoff root and never send commands through the PTY.
import { execFile } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { shellQuote } from "../../lib/shell-resolver.js";
import {
  appOwnedTerminalHandoffRoot,
  ensureSandboxPrivateRoot,
} from "../../permissions/asrt-sandbox.js";

const execFileAsync = promisify(execFile);

// What ASRT accepts in `ttys`; checked here too so a bad value never reaches a wrap.
const PTY_SLAVE_PATH = /^\/dev\/ttys[0-9]{3,}$/;

// The trampoline's own environment: it runs one fixed `sh` and execs.
export const TRAMPOLINE_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: "/usr/bin:/bin" });

const DELIVER_TIMEOUT_MS = 10_000;

// The pty slave node-pty allocated for `pty`. node-pty's UnixTerminal exposes it as `ptsName` (not in its typings). Anything that is not a pty slave
// path fails the spawn: granting a guessed device would grant someone else's.
export function ownPtySlavePath(pty: unknown): string {
  const name = typeof pty === "object" && pty !== null ? (pty as { ptsName?: unknown }).ptsName : undefined;
  if (typeof name !== "string" || !PTY_SLAVE_PATH.test(name)) {
    throw new Error(`terminal: node-pty reported no pty slave device (got ${JSON.stringify(name)})`);
  }
  return name;
}

// A portable environment name: what env(1) reads as an assignment and never as an option.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// exec under env -i to prevent trampoline environment leaks; require portable names and -- so entries cannot become env options.
export function renderHandoffScript(argv: readonly string[], env: Readonly<Record<string, string>>): string {
  const [file] = argv;
  if (file === undefined || !file.startsWith("/") || file.includes("=")) {
    throw new Error(`terminal: wrapped argv must start with an absolute program path (got ${JSON.stringify(file)})`);
  }
  const assignments: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key) || value.includes("\0")) {
      throw new Error(`terminal: environment entry ${JSON.stringify(key)} cannot be passed to env(1)`);
    }
    assignments.push(shellQuote(`${key}=${value}`));
  }
  for (const arg of argv) {
    if (arg.includes("\0")) throw new Error("terminal: wrapped argv contains a NUL byte");
  }
  return `exec /usr/bin/env -i -- ${assignments.join(" ")} ${argv.map(shellQuote).join(" ")}\n`;
}

export interface TerminalTtyHandoff {
  // Spawn this on the pty: `/bin/sh <fifo>`.
  readonly trampoline: { readonly file: string; readonly args: readonly string[] };
  // Hand the trampoline its script. Rejects if it does not take it within `timeoutMs`, or as soon as `signal` aborts (the trampoline exited). Once it has
  // rejected, nothing is written to the fifo.
  deliver(script: string, options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<void>;
  dispose(): void;
}

export async function createTerminalTtyHandoff(): Promise<TerminalTtyHandoff> {
  const root = ensureSandboxPrivateRoot(appOwnedTerminalHandoffRoot());
  const dir = mkdtempSync(join(root, "t-"));
  const fifo = join(dir, "exec");
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await execFileAsync("/usr/bin/mkfifo", ["-m", "600", fifo]);
  } catch (err) {
    dispose();
    throw err;
  }

  const deliver = async (
    script: string,
    { timeoutMs = DELIVER_TIMEOUT_MS, signal }: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<void> => {
    signal?.throwIfAborted();
    // Set once deliver has given up: a write that would land after that is never started, so the shell cannot start behind a failed spawn.
    let givenUp = false;
    // Opening a fifo for writing blocks until the trampoline opens it.
    const opening = open(fifo, "w");
    const giveUp = (): void => {
      if (givenUp) return;
      givenUp = true;
      // Unblock the pending open before cancellation can unlink the fifo. Its late handle is closed by the delivery's finally below.
      try {
        closeSync(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK));
      } catch {
        // already gone or already open: nothing is waiting on it
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`terminal: the shell trampoline did not take its command within ${timeoutMs} ms`)),
        timeoutMs,
      );
      onAbort = () => {
        giveUp();
        reject(new Error("terminal: the shell trampoline exited before taking its command"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([
        (async () => {
          const handle = await opening;
          try {
            if (!givenUp) await handle.writeFile(script);
          } finally {
            await handle.close();
          }
        })(),
        stopped,
      ]);
    } catch (err) {
      giveUp();
      throw err;
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  };

  return { trampoline: { file: "/bin/sh", args: [fifo] }, deliver, dispose };
}
