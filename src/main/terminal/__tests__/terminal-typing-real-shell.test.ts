/**
 * terminal_run's typing protocol against REAL interactive shells on a real
 * pseudo-terminal (node-pty): the line editor only exists on a tty, so a pipe
 * would not show any of this.
 *
 * A line editor can sit in a state no output shows — an ESC prefix waiting for
 * its next key, a Ctrl-X prefix, vi command mode. Text typed then is read as
 * editing keys and the shell runs something other than the approved line. The
 * protocol (pty-manager `typeLineAtPrompt`) resets with Ctrl-C, waits for the
 * fresh prompt, and pastes the line in bracketed-paste mode; it refuses a
 * prompt the user touched, and vi bindings. These tests drive the user's keys
 * and the shell, then read what the shell itself recorded as the command it
 * ran (its C marker).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as nodePty from "node-pty";
import { installShellIntegration } from "../shell-integration.js";
import { TerminalBlockTracker, USER_INPUT_QUIET_MS } from "../terminal-blocks.js";
import { foregroundVerdict, typeLineAtPrompt, type TypeTerminalCommandResult } from "../pty-manager.js";
import { readTerminalForeground } from "../shell-process.js";
import { TERMINAL_TEST_MODERN_BASH, TERMINAL_TEST_UTF8_LOCALE, TERMINAL_TEST_ZSH } from "../../../__tests__/support/terminal-markers.js";

const NONCE = "fedcba9876543210fedcba9876543210";

interface LiveShell {
  pty: nodePty.IPty;
  tracker: TerminalBlockTracker;
  home: string;
  /** A key the user presses: the terminal records it, the shell reads it. */
  press(keys: string): void;
  /** The protocol under test. */
  type(line: string): Promise<TypeTerminalCommandResult>;
}

const opened: Array<{ pty: nodePty.IPty; home: string; exited: Promise<void> }> = [];
afterEach(async () => {
  for (const { pty, home, exited } of opened.splice(0)) {
    try { pty.kill(); } catch { /* gone */ }
    // The shell writes its history as it exits; remove its HOME after that.
    await Promise.race([exited, sleep(3_000)]);
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

async function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(25);
  }
}

async function startShell(shellPath: string): Promise<LiveShell> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ave-typing-")));
  const { env } = installShellIntegration(home, shellPath, { nonce: NONCE, sandboxEnv: { HOME: home, XDG_CONFIG_HOME: join(home, "config") } });
  const pty = nodePty.spawn(shellPath, ["-l", "-i"], {
    cwd: home,
    cols: 120,
    rows: 30,
    env: { PATH: "/usr/bin:/bin", HOME: home, TERM: "xterm-256color", LANG: TERMINAL_TEST_UTF8_LOCALE, ...env },
  });
  const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
  pty.onData((data) => { tracker.recordOutput(data); });
  const exited = new Promise<void>((resolve) => pty.onExit(() => { tracker.recordExit(); resolve(); }));
  opened.push({ pty, home, exited });
  await until(() => tracker.promptEndCount() > 0);
  await sleep(USER_INPUT_QUIET_MS);
  const shellName = basename(shellPath);
  return {
    pty,
    tracker,
    home,
    press: (keys) => {
      tracker.recordInput(keys);
      pty.write(keys);
    },
    type: (line) => typeLineAtPrompt({
      blocks: tracker,
      isLive: () => !tracker.hasExited(),
      write: (data) => pty.write(data),
      verify: async () => foregroundVerdict(await readTerminalForeground(pty.pid), pty.pid, shellName, tracker.currentCwd() ?? ""),
      missing: "no terminal",
    }, line),
  };
}

/** The command text the shell recorded for the block typing produced. */
async function ranCommand(shell: LiveShell, result: TypeTerminalCommandResult): Promise<string> {
  if (!result.ok) throw new Error(`not typed: ${result.message}`);
  await until(() => shell.tracker.get(result.firstBlockId)?.status === "done");
  return shell.tracker.get(result.firstBlockId)!.command;
}

const BASH = TERMINAL_TEST_MODERN_BASH;

/** Each shell's way to print its prompt string expanded (which prints B). */
/** Each shell's way to have pasted text rewritten, or not taken as a paste at all. */
const SHELLS: Array<{ path: string | undefined; enableVi: string; expandPrompt: string; rewritePaste: string }> = [
  {
    path: TERMINAL_TEST_ZSH,
    enableVi: "bindkey -v",
    expandPrompt: "print -rP -- \"$PS1\"",
    rewritePaste: "autoload -Uz bracketed-paste-magic && zle -N bracketed-paste bracketed-paste-magic",
  },
  { path: BASH, enableVi: "set -o vi", expandPrompt: "echo \"${PS1@P}\"", rewritePaste: "bind 'set enable-bracketed-paste off'" },
];

for (const { path, enableVi, expandPrompt, rewritePaste } of SHELLS) {
  describe.runIf(path !== undefined)(`${path}: typing an approved command`, () => {
    it("runs exactly the approved line, and the operating system confirms the shell and its directory", async () => {
      const shell = await startShell(path!);
      const result = await shell.type("echo approved 'a b' && pwd");
      expect(await ranCommand(shell, result)).toBe("echo approved 'a b' && pwd");
      const block = shell.tracker.get((result as { firstBlockId: number }).firstBlockId)!;
      expect(block.output).toBe(`approved a b\n${shell.home}\n`);
    }, 30_000);

    it("refuses a prompt the user pressed ESC at, however long ago", async () => {
      const shell = await startShell(path!);
      shell.press("\u001b");
      await sleep(USER_INPUT_QUIET_MS + 200);
      await expect(shell.type("echo hi")).resolves.toMatchObject({ ok: false, reason: "pending-input" });
    }, 30_000);

    it.each([["an ESC", "\u001b"], ["a Ctrl-X", "\u0018"]])("clears %s prefix typed ahead during the last command, so the line still runs as approved", async (_label, prefix) => {
      const shell = await startShell(path!);
      const running = await shell.type("sleep 1");
      await until(() => shell.tracker.promptState() === "command-running");
      // A key pressed while the command runs reaches the line editor at the next prompt.
      shell.press(prefix);
      await ranCommand(shell, running);
      await sleep(USER_INPUT_QUIET_MS + 200);
      const result = await shell.type("echo SAFE-RUN");
      expect(await ranCommand(shell, result)).toBe("echo SAFE-RUN");
      expect(shell.tracker.get((result as { firstBlockId: number }).firstBlockId)!.output).toBe("SAFE-RUN\n");
    }, 30_000);

    it("does not take a B marker a command prints by expanding the prompt, now or from the background later", async () => {
      const shell = await startShell(path!);
      // Typed raw, as a user could: terminal_run's validator refuses these.
      const before = shell.tracker.promptEndCount();
      shell.pty.write(`${expandPrompt} | od -c | head -1; ${expandPrompt}\r`);
      await until(() => shell.tracker.promptEndCount() > before);
      await sleep(500);
      expect(shell.tracker.promptEndCount()).toBe(before + 1);
      const ready = shell.tracker.promptEndCount();
      shell.pty.write(`(sleep 1; ${expandPrompt}) &\r`);
      await until(() => shell.tracker.promptEndCount() > ready);
      await sleep(2_000);
      // The background job printed a stale token after the next prompt was up.
      expect(shell.tracker.promptEndCount()).toBe(ready + 1);
    }, 30_000);

    it("stays ready when the line editor redraws its prompt (resize, Ctrl-L)", async () => {
      const shell = await startShell(path!);
      shell.pty.resize(100, 30);
      await sleep(500);
      expect(shell.tracker.promptState()).toBe("ready");
      // Ctrl-L is the user's key: it counts as typing until it goes quiet.
      shell.press("\u000c");
      await sleep(USER_INPUT_QUIET_MS + 300);
      expect(shell.tracker.promptState()).toBe("pending-input");
    }, 30_000);

    it("runs a line longer than the terminal is wide exactly as approved (the edit line wraps)", async () => {
      const shell = await startShell(path!);
      const line = `echo ${"w".repeat(150)} ${"v".repeat(130)}`;
      const result = await shell.type(line);
      expect(await ranCommand(shell, result)).toBe(line);
    }, 30_000);

    it("refuses a line editor that would rewrite pasted text or not take it as a paste", async () => {
      const shell = await startShell(path!);
      await ranCommand(shell, await shell.type(rewritePaste));
      await sleep(100);
      await expect(shell.type("echo hi")).resolves.toMatchObject({ ok: false, reason: "no-bracketed-paste" });
    }, 30_000);

    it("refuses vi key bindings", async () => {
      const shell = await startShell(path!);
      const enable = await shell.type(enableVi);
      await ranCommand(shell, enable);
      await sleep(100);
      await expect(shell.type("echo hi")).resolves.toMatchObject({ ok: false, reason: "vi-editing-mode" });
    }, 30_000);

    it("finds a program, not the shell, in the foreground while a command runs", async () => {
      const shell = await startShell(path!);
      const reading = await readTerminalForeground(shell.pty.pid);
      expect(reading).toMatchObject({ ok: true, foreground: { command: basename(path!), cwd: shell.home } });
      expect(await shell.type("sleep 3")).toMatchObject({ ok: true });
      await until(() => shell.tracker.promptState() === "command-running");
      await sleep(300);
      const during = await readTerminalForeground(shell.pty.pid);
      expect(foregroundVerdict(during, shell.pty.pid, basename(path!), shell.home)).toMatchObject({ ok: false, reason: "foreground-not-shell" });
    }, 30_000);
  });
}

const MACOS_BASH_3 = process.platform === "darwin" && existsSync("/bin/bash")
  && /version 3\./u.test(spawnSync("/bin/bash", ["--version"], { encoding: "utf-8" }).stdout);

describe.runIf(MACOS_BASH_3)("a bash without bracketed paste", () => {
  it("macOS /bin/bash 3.2 reports Paste=0 and is refused before any key is sent", async () => {
    const shell = await startShell("/bin/bash");
    const written: string[] = [];
    const original = shell.pty.write.bind(shell.pty);
    shell.pty.write = (data: string | Buffer) => { written.push(String(data)); original(data); };
    await expect(shell.type("echo hi")).resolves.toMatchObject({ ok: false, reason: "no-bracketed-paste" });
    expect(written).toEqual([]);
  }, 30_000);
});
