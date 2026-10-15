/**
 * terminal-tty-handoff.ts — let the workspace terminal's sandboxed shell own
 * its terminal on macOS, and no other terminal.
 *
 * WHY: the macOS profile denies `file-ioctl` on `/dev/ttys*`, so a shell
 * under it cannot turn off ECHO (TIOCSETA) or give a foreground job the
 * terminal (TIOCSPGRP). zsh's line editor then redraws what the kernel already
 * echoed (every command shows twice) and job control is off. ASRT's
 * `allowPty: true` grants every pty of the user; the patched ASRT `ttys` wrap
 * option (anthropics/sandbox-runtime#722) grants one literal device.
 *
 * ORDER PROBLEM: node-pty allocates the pty and spawns in ONE native call, so
 * the slave path (`ptsName`) exists only after the spawn, while the profile is
 * an argument of the process being spawned. So the pty is spawned on a fixed
 * trampoline, `/bin/sh <fifo>`, which blocks reading its script from a fifo.
 * The host then reads `ptsName`, wraps the shell with that one device, and
 * writes `exec /usr/bin/env -i <env> <wrapped argv>` into the fifo. The
 * trampoline execs it: same pid, same session, same controlling terminal.
 *
 * TRUST: the trampoline runs unsandboxed until that exec, so the fifo is the
 * host's alone: a `mkdtemp` directory (0700) under the app-owned handoff root,
 * which no wrap grants write to and the read floor denies
 * (`appOwnedTerminalHandoffRoot`). Nothing is sent through the pty itself, so
 * there is no echo of the command and no canonical-mode line limit.
 */
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

/** What ASRT accepts in `ttys`; checked here too so a bad value never reaches a wrap. */
const PTY_SLAVE_PATH = /^\/dev\/ttys[0-9]{3,}$/;

/** The trampoline's own environment: it runs one fixed `sh` and execs. */
export const TRAMPOLINE_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: "/usr/bin:/bin" });

const DELIVER_TIMEOUT_MS = 10_000;

/**
 * The pty slave node-pty allocated for `pty`. node-pty's UnixTerminal exposes
 * it as `ptsName` (not in its typings). Anything that is not a pty slave path
 * fails the spawn: granting a guessed device would grant someone else's.
 */
export function ownPtySlavePath(pty: unknown): string {
  const name = typeof pty === "object" && pty !== null ? (pty as { ptsName?: unknown }).ptsName : undefined;
  if (typeof name !== "string" || !PTY_SLAVE_PATH.test(name)) {
    throw new Error(`terminal: node-pty reported no pty slave device (got ${JSON.stringify(name)})`);
  }
  return name;
}

/**
 * The one line the trampoline runs: replace itself with the wrapped shell,
 * under exactly `env` (`env -i`, so nothing of the trampoline's leaks in).
 */
export function renderHandoffScript(argv: readonly string[], env: Readonly<Record<string, string>>): string {
  const [file] = argv;
  if (file === undefined || !file.startsWith("/") || file.includes("=")) {
    throw new Error(`terminal: wrapped argv must start with an absolute program path (got ${JSON.stringify(file)})`);
  }
  const assignments: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0") || value.includes("\0")) {
      throw new Error(`terminal: environment entry ${JSON.stringify(key)} cannot be passed to env(1)`);
    }
    assignments.push(shellQuote(`${key}=${value}`));
  }
  for (const arg of argv) {
    if (arg.includes("\0")) throw new Error("terminal: wrapped argv contains a NUL byte");
  }
  return `exec /usr/bin/env -i ${assignments.join(" ")} ${argv.map(shellQuote).join(" ")}\n`;
}

export interface TerminalTtyHandoff {
  /** Spawn this on the pty: `/bin/sh <fifo>`. */
  readonly trampoline: { readonly file: string; readonly args: readonly string[] };
  /** Hand the trampoline its script. Rejects if it does not take it in time. */
  deliver(script: string, timeoutMs?: number): Promise<void>;
  /** Remove the fifo and its directory. Idempotent. */
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

  const deliver = async (script: string, timeoutMs = DELIVER_TIMEOUT_MS): Promise<void> => {
    // Opening a fifo for writing blocks until the trampoline opens it.
    const opening = open(fifo, "w");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`terminal: the shell trampoline did not take its command within ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([
        (async () => {
          const handle = await opening;
          try {
            await handle.writeFile(script);
          } finally {
            await handle.close();
          }
        })(),
        timedOut,
      ]);
    } catch (err) {
      // A pending open holds a thread-pool thread until a reader appears: be
      // that reader once, so it returns, and close what it opened.
      try {
        closeSync(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK));
      } catch {
        // already gone or already open: nothing is waiting on it
      }
      opening.then(
        (handle) => handle.close().catch(() => {}),
        () => {},
      );
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return { trampoline: { file: "/bin/sh", args: [fifo] }, deliver, dispose };
}
