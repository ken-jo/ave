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
    env: { PATH: "/usr/bin:/bin", HOME: home, TERM: "xterm-256color", LANG: "en_US.UTF-8", ...env },
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
      verify: async () => foregroundVerdict(await readTerminalForeground(pty.pid), shellName, tracker.currentCwd() ?? ""),
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

/** A bash with bracketed paste (4.4 or later), if this machine has one. */
const BASH = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find((path) =>
  existsSync(path) && /version (?:4\.[4-9]|[5-9]\.)/u.test(spawnSync(path, ["--version"], { encoding: "utf-8" }).stdout));

const SHELLS: Array<{ path: string | undefined; enableVi: string }> = [
  { path: existsSync("/bin/zsh") ? "/bin/zsh" : undefined, enableVi: "bindkey -v" },
  { path: BASH, enableVi: "set -o vi" },
];

for (const { path, enableVi } of SHELLS) {
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
      expect(foregroundVerdict(during, basename(path!), shell.home)).toMatchObject({ ok: false, reason: "foreground-not-shell" });
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
