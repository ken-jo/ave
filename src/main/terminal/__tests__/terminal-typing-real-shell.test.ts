// Real PTYs expose hidden line-editor states; reset, fresh-prompt, and bracketed-paste behavior cannot be tested with pipes.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as nodePty from "node-pty";
import { installShellIntegration } from "../shell-integration.js";
import { TerminalBlockTracker, USER_INPUT_QUIET_MS } from "../terminal-blocks.js";
import { foregroundVerdict, typeLineAtPrompt, type TypeTerminalCommandResult } from "../pty-manager.js";
import { readTerminalForeground } from "../shell-process.js";
import { TERMINAL_TEST_MODERN_BASH, TERMINAL_TEST_UTF8_LOCALE, TERMINAL_TEST_ZSH, ubuntuLikeNotFoundHandler } from "../../../__tests__/support/terminal-markers.js";

const NONCE = "fedcba9876543210fedcba9876543210";

interface LiveShell {
  pty: nodePty.IPty;
  tracker: TerminalBlockTracker;
  home: string;
  output(): string;
  // Advance only the tracker's quiet-input clock; the PTY stays real.
  elapse(ms: number): void;
  // A key the user presses: the terminal records it, the shell reads it.
  press(keys: string): void;
  // The protocol under test.
  type(line: string): Promise<TypeTerminalCommandResult>;
}

const opened: Array<{ pty: nodePty.IPty; exited: Promise<void> }> = [];
// Every shell HOME, tracked from creation: a start that throws before the spawn still owns one.
const homes: string[] = [];
afterEach(async () => {
  for (const { pty, exited } of opened.splice(0)) {
    try { pty.kill("SIGKILL"); } catch { /* gone */ }
    // Reap the isolated shell before removing its HOME.
    await exited;
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

const shellEvents = new EventEmitter();

function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const timeout = new Error("timed out");
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      shellEvents.off("output", check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      try { if (condition()) finish(); } catch (error) { finish(error as Error); }
    };
    const timer = setTimeout(() => finish(timeout), timeoutMs);
    shellEvents.on("output", check);
    check();
  });
}

// Install a command-not-found handler before integration to match the ordering of system startup files.
async function startShell(shellPath: string, options: { notFoundProgram?: string; startup?: string; profile?: string } = {}): Promise<LiveShell> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ave-typing-")));
  homes.push(home);
  const { env } = installShellIntegration(home, shellPath, { nonce: NONCE, sandboxEnv: { HOME: home, XDG_CONFIG_HOME: join(home, "config") } });
  if (options.profile !== undefined) writeFileSync(join(home, ".zprofile"), options.profile);
  // The host distro's command-not-found handler is removed (Ubuntu's /etc/bash.bashrc, read before this file, defines one for bash), so a case has one
  // only when it installs it: the same on every host.
  const rc = join(home, basename(shellPath) === "zsh" ? ".zshrc" : ".bash_profile");
  const removeDistroHandler = basename(shellPath) === "zsh"
    ? "unfunction command_not_found_handler 2>/dev/null\n"
    : "unset -f command_not_found_handle\n";
  writeFileSync(rc, (options.notFoundProgram === undefined
    ? removeDistroHandler
    : ubuntuLikeNotFoundHandler(basename(shellPath), options.notFoundProgram)) + readFileSync(rc, "utf-8") + `\n${options.startup ?? ""}\n`);
  const pty = nodePty.spawn(shellPath, ["-l", "-i"], {
    cwd: home,
    cols: 120,
    rows: 30,
    env: { PATH: "/usr/bin:/bin", HOME: home, TERM: "xterm-256color", LANG: TERMINAL_TEST_UTF8_LOCALE, ...env },
  });
  let clockOffset = 0;
  const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true, now: () => Date.now() + clockOffset });
  let output = "";
  pty.onData((data) => { output += data; tracker.recordOutput(data); shellEvents.emit("output"); });
  const exited = new Promise<void>((resolve) => pty.onExit(() => { tracker.recordExit(); resolve(); }));
  opened.push({ pty, exited });
  try { await until(() => tracker.promptEndCount() > 0); }
  catch (cause) { throw new Error(`${basename(shellPath)} did not start: ${JSON.stringify(output.slice(-4096))}`, { cause }); }
  // No user input has been recorded yet: the authenticated prompt is the readiness barrier, not an elapsed quiet-input window.
  const shellName = basename(shellPath);
  return {
    pty,
    tracker,
    home,
    output: () => output,
    elapse: (ms) => { clockOffset += ms; },
    press: (keys) => {
      tracker.recordInput(keys);
      pty.write(keys);
    },
    type: async (line) => {
      const nextBlockId = tracker.nextBlockId();
      let reread = false;
      return typeLineAtPrompt({
        blocks: tracker,
        isLive: () => !tracker.hasExited(),
        write: (data) => pty.write(data),
        verify: async (options) => {
          let reading = await readTerminalForeground(pty.pid, options);
          // Permit one real reread when the process-table command fails; semantic refusals and persistent unreadability still fail closed.
          if (!reread && !reading.ok && reading.reason ===
            "the terminal's process could not be read (Command failed: /bin/ps -axo pid=,ppid=,tty=,comm=)") {
            expect(tracker.nextBlockId()).toBe(nextBlockId);
            expect(tracker.hasExited()).toBe(false);
            reread = true;
            process.stderr.write("[terminal typing fixture] rereading the failed process table\n");
            reading = await readTerminalForeground(pty.pid, options);
            expect(tracker.nextBlockId()).toBe(nextBlockId);
            expect(tracker.hasExited()).toBe(false);
          }
          return foregroundVerdict(reading, pty.pid, shellName, tracker.currentCwd() ?? "");
        },
        missing: "no terminal",
      }, line);
    },
  };
}

// The command text the shell recorded for the block typing produced.
async function ranCommand(shell: LiveShell, result: TypeTerminalCommandResult): Promise<string> {
  if (!result.ok) throw new Error(`not typed (${result.reason}): ${result.message}`);
  await until(() => shell.tracker.get(result.firstBlockId)?.status === "done"
    && ["ready", "pending-input", "no-bracketed-paste", "vi-editing-mode", "not-found-handler"].includes(shell.tracker.promptState()));
  return shell.tracker.get(result.firstBlockId)!.command;
}

// Hold a native command until the test has observed the event it needs.
function createGate(home: string, name: string) {
  const path = join(home, name);
  expect(spawnSync("mkfifo", [path]).status).toBe(0);
  const readFd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let writeFd: number;
  try { writeFd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK); }
  catch (error) { closeSync(readFd); throw error; }
  return {
    path,
    release: () => { writeSync(writeFd, "\n"); },
    close: () => { closeSync(writeFd); closeSync(readFd); },
  };
}

const BASH = TERMINAL_TEST_MODERN_BASH;

// Each shell's way to print its prompt string expanded (which prints B).
// Each shell's way to have pasted text rewritten, or not taken as a paste at all.
const SHELLS: Array<{ path: string | undefined; enableVi: string; expandPrompt: string; rewritePaste: string; removeNotFoundHandler: string }> = [
  {
    path: TERMINAL_TEST_ZSH,
    enableVi: "bindkey -v",
    expandPrompt: "print -rP -- \"$PS1\"",
    rewritePaste: "autoload -Uz bracketed-paste-magic && zle -N bracketed-paste bracketed-paste-magic",
    removeNotFoundHandler: "unfunction command_not_found_handler",
  },
  {
    path: BASH,
    enableVi: "set -o vi",
    expandPrompt: "echo \"${PS1@P}\"",
    rewritePaste: "bind 'set enable-bracketed-paste off'",
    removeNotFoundHandler: "unset -f command_not_found_handle",
  },
];

for (const { path, enableVi, expandPrompt, rewritePaste, removeNotFoundHandler } of SHELLS) {
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
      shell.elapse(USER_INPUT_QUIET_MS + 200);
      await expect(shell.type("echo hi")).resolves.toMatchObject({ ok: false, reason: "pending-input" });
    }, 30_000);

    it.each([
      { label: "an ESC", prefix: "\u001b", state: "pending" },
      { label: "a Ctrl-X", prefix: "\u0018", state: "pending" },
      { label: "an ESC", prefix: "\u001b", state: "consumed" },
      { label: "a Ctrl-X", prefix: "\u0018", state: "consumed" },
    ])("clears $label prefix typed ahead during the last command ($state), so the line still runs as approved", async ({ prefix, state }) => {
      const zsh = basename(path!) === "zsh";
      const key = prefix === "\u001b" ? "^[" : "^X";
      const readlineKey = prefix === "\u001b" ? "\\e" : "\\C-x";
      const longerKey = prefix === "\u001b" ? "^[[200~" : "^X^X";
      // The completion bell wakes the output wait after the native binding has written its evidence. Neither the bell nor the probe edits text.
      const observe = ': > "$HOME/prefix-consumed"; printf "\\a"';
      // The shorter binding keeps longer sequences, including bracketed paste. Its evidence, rather than a delay, proves it was consumed.
      const setup = state === "consumed"
        ? zsh
          ? `observe_prefix() { ${observe}; }; zle -N observe-prefix observe_prefix; bindkey '${key}' observe-prefix`
          : `bind -x '"${readlineKey}": ${observe}'`
        : `{ ${zsh ? `bindkey '${key}'; bindkey '${longerKey}'` : "bind -p; bind -s; bind -X"}; } > "$HOME/prefix-bindings"`;
      const shell = await startShell(path!, { startup: setup });
      const consumed = join(shell.home, "prefix-consumed");
      if (state === "pending") {
        // An unbound shorter key has no ambiguous-binding timeout. Verify the native keymap so this case keeps the prefix pending until the reset.
        const output = readFileSync(join(shell.home, "prefix-bindings"), "utf8");
        if (zsh) {
          const action = prefix === "\u001b" ? "bracketed-paste" : "exchange-point-and-mark";
          expect(output).toBe(`"${key}" undefined-key\n"${longerKey}" ${action}\n`);
        } else {
          expect(output.split("\n").some((line) => line.startsWith(`"${readlineKey}":`))).toBe(false);
          expect(output).toContain(prefix === "\u001b" ? '"\\e[200~": bracketed-paste-begin' : '"\\C-x\\C-x": exchange-point-and-mark');
        }
      }
      await until(() => shell.tracker.promptState() === "ready");
      const gate = createGate(shell.home, "release-typeahead");
      try {
        const running = await shell.type(`printf '\\nTYPEAHEAD_WAITING\\n'; read -r < '${gate.path}'`);
        await until(() => shell.tracker.promptState() === "command-running" && /\r?\nTYPEAHEAD_WAITING\r?\n/u.test(shell.output()));
        const beforeInput = shell.output().length;
        shell.press(prefix);
        // The tty's echo proves the kernel received typeahead while the command was held, before the line editor can consume it.
        await until(() => shell.output().slice(beforeInput).includes(prefix === "\u001b" ? "^[" : "^X"));
        gate.release();
        await ranCommand(shell, running);
        if (state === "consumed") await until(() => existsSync(consumed));
        shell.elapse(USER_INPUT_QUIET_MS + 200);
        await until(() => shell.tracker.promptState() === "ready");
        const result = await shell.type("echo SAFE-RUN");
        expect(await ranCommand(shell, result)).toBe("echo SAFE-RUN");
        expect(shell.tracker.get((result as { firstBlockId: number }).firstBlockId)!.output).toBe("SAFE-RUN\n");
      } finally { gate.close(); }
    }, 30_000);

    it("does not take a B marker a command prints by expanding the prompt, now or from the background later", async () => {
      const shell = await startShell(path!);
      // Typed raw, as a user could: terminal_run's validator refuses these.
      const before = shell.tracker.promptEndCount();
      shell.pty.write(`${expandPrompt} | od -c | head -1; ${expandPrompt}\r`);
      await until(() => shell.tracker.promptEndCount() > before && shell.tracker.promptState() === "ready");
      expect(shell.tracker.promptEndCount()).toBe(before + 1);
      const ready = shell.tracker.promptEndCount();
      const release = join(shell.home, "release-background");
      expect(spawnSync("mkfifo", [release]).status).toBe(0);
      // Hold both ends so opening the gate cannot block on a missing reader.
      const readFd = openSync(release, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const writeFd = openSync(release, constants.O_WRONLY | constants.O_NONBLOCK);
        try {
          // Release only after the next real prompt, then observe completion. Elapsed time alone cannot prove that the stale marker arrived later.
          shell.pty.write(`(read -r < '${release}'; ${expandPrompt}; printf '\\nBACKGROUND_DONE\\n') &\r`);
          await until(() => shell.tracker.promptEndCount() > ready);
          writeSync(writeFd, "\n");
          await until(() => /\r?\nBACKGROUND_DONE\r?\n/.test(shell.output()));
        } finally { closeSync(writeFd); }
      } finally { closeSync(readFd); }
      // The background job printed a stale token after the next prompt was up.
      expect(shell.tracker.promptEndCount()).toBe(ready + 1);
    }, 30_000);

    it("keeps resize ready and Ctrl-L redraw pending after user input goes quiet", async () => {
      const shell = await startShell(path!);
      const promptEnd = /\u001b\]133;B;[0-9a-f]{32}\u0007/u;
      const beforeResize = shell.output().length;
      shell.pty.resize(100, 30);
      await until(() => promptEnd.test(shell.output().slice(beforeResize)));
      expect(shell.tracker.promptState()).toBe("ready");
      // Ctrl-L is the user's key: it counts as typing until it goes quiet.
      const beforeClear = shell.output().length;
      shell.press("\u000c");
      await until(() => promptEnd.test(shell.output().slice(beforeClear)));
      shell.elapse(USER_INPUT_QUIET_MS + 300);
      expect(shell.tracker.promptState()).toBe("pending-input");
    }, 30_000);

    it("runs a line longer than the terminal is wide exactly as approved (the edit line wraps)", async () => {
      const shell = await startShell(path!);
      const line = `echo ${"w".repeat(150)} ${"v".repeat(130)}`;
      const result = await shell.type(line);
      expect(await ranCommand(shell, result)).toBe(line);
    }, 30_000);

    it("runs a line that ends exactly at the right margin (the line editor echoes a wrap placeholder, \" \" CR)", async () => {
      const shell = await startShell(path!);
      // The prompt as drawn on its row: between its A and B markers, after any CR.
      const prompt = (shell.output().split("\u0007").at(-2) ?? "").replace(/\u001b\]133;B;[0-9a-f]+$/u, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "").split("\r").at(-1)!;
      // One column per character, so its length is its width.
      expect(prompt).toMatch(/^[ -~]+$/u);
      const line = "echo margin-reached";
      // Prompt and line fill the row: bash readline and zsh ZLE then write a blank on the next row and return to its start (" " CR).
      shell.pty.resize(prompt.length + line.length, 30);
      // Let the shell take the resize (and redraw) before typing.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await shell.type(line);
      expect(result, JSON.stringify({ result, prompt, shown: shell.output().slice(-400) })).toMatchObject({ ok: true });
      expect(await ranCommand(shell, result)).toBe(line);
    }, 30_000);

    it("refuses a line editor that would rewrite pasted text or not take it as a paste", async () => {
      const shell = await startShell(path!);
      const prompt = shell.tracker.promptEndCount();
      await ranCommand(shell, await shell.type(rewritePaste));
      await until(() => shell.tracker.promptEndCount() > prompt && shell.tracker.promptState() === "no-bracketed-paste");
      const nextBlockId = shell.tracker.nextBlockId();
      await expect(shell.type("echo hi")).resolves.toMatchObject({ ok: false, reason: "no-bracketed-paste" });
      expect(shell.tracker.nextBlockId()).toBe(nextBlockId);
    }, 30_000);

    it("types nothing while a command-not-found handler is defined (Ubuntu's /etc/bash.bashrc), and types once the user removes it", async () => {
      const program = join(realpathSync(tmpdir()), `ave-not-found-${process.pid}-${basename(path!)}`);
      const ran = `${program}.log`;
      writeFileSync(program, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ran}'\nexit 127\n`, { mode: 0o755 });
      try {
        const shell = await startShell(path!, { notFoundProgram: program });
        // The handler is live: a word that is not a command runs it.
        const before = shell.tracker.promptEndCount();
        shell.pty.write("'x'=1\r");
        await until(() => shell.tracker.promptEndCount() > before);
        expect(existsSync(ran)).toBe(true);
        rmSync(ran);
        await expect(shell.type("'x'=1")).resolves.toMatchObject({ ok: false, reason: "not-found-handler" });
        // The user removes it for this terminal; then terminal_run types, and the same word runs nothing the rules did not see.
        const removed = shell.tracker.promptEndCount();
        shell.pty.write(`${removeNotFoundHandler}\r`);
        await until(() => shell.tracker.promptEndCount() > removed);
        expect(await ranCommand(shell, await shell.type("'x'=1"))).toBe("'x'=1");
        expect(existsSync(ran)).toBe(false);
      } finally {
        rmSync(program, { force: true });
        rmSync(ran, { force: true });
      }
    }, 30_000);

    it("refuses vi key bindings", async () => {
      const shell = await startShell(path!);
      const enable = await shell.type(enableVi);
      await ranCommand(shell, enable);
      await expect(shell.type("echo hi")).resolves.toMatchObject({ ok: false, reason: "vi-editing-mode" });
    }, 30_000);

    it("reports its own pid at every prompt, which terminal_run matches against the process it finds", async () => {
      const shell = await startShell(path!);
      expect(shell.tracker.reportedShellPid()).toBe(shell.pty.pid);
      await ranCommand(shell, await shell.type("true"));
      await until(() => shell.tracker.promptState() === "ready", 4_000);
      expect(shell.tracker.reportedShellPid()).toBe(shell.pty.pid);
    }, 30_000);

    it("finds a program, not the shell, in the foreground while a command runs", async () => {
      const shell = await startShell(path!);
      const reading = await readTerminalForeground(shell.pty.pid);
      expect(reading).toMatchObject({ ok: true, foreground: { command: basename(path!), cwd: shell.home } });
      const gate = createGate(shell.home, "release-foreground");
      try {
        const running = await shell.type(`sh -c 'exec 3< "$1"; printf "\\nFOREGROUND_READY\\n"; IFS= read -r released <&3' sh '${gate.path}'`);
        expect(running).toMatchObject({ ok: true });
        await until(() => shell.tracker.promptState() === "command-running" && /\r?\nFOREGROUND_READY\r?\n/u.test(shell.output()));
        const during = await readTerminalForeground(shell.pty.pid);
        expect(foregroundVerdict(during, shell.pty.pid, basename(path!), shell.home), JSON.stringify(during)).toMatchObject({ ok: false, reason: "foreground-not-shell" });
        gate.release();
        await ranCommand(shell, running);
      } finally { gate.close(); }
    }, 30_000);

    it("counts an OSC-shaped write as the user's input, because the line editor runs the keys inside it", async () => {
      const shell = await startShell(path!);
      shell.press("\u001b]1;x\rprintf 'RAN_%s\\n' HIDDEN\r\u0007");
      await until(() => shell.output().includes("RAN_HIDDEN"));
      expect(shell.tracker.userInputGeneration()).toBeGreaterThan(0);
    }, 30_000);

    it("refuses to press Enter while an orphaned background job still holds the terminal", async () => {
      const shell = await startShell(path!);
      const gate = createGate(shell.home, "release-orphan");
      try {
        // The user's job outlives the `sh` that started it: it is no longer the shell's child, but it keeps the terminal and writes to it later.
        await ranCommand(shell, await shell.type(`sh -c '(read -r released < "$1"; printf "ORPHAN_WROTE\\n") &' sh '${gate.path}'`));
        await until(() => shell.tracker.promptState() === "ready", 4_000);
        const reading = await readTerminalForeground(shell.pty.pid);
        expect(reading, JSON.stringify(reading)).toMatchObject({ ok: false, busy: true });
        expect(foregroundVerdict(reading, shell.pty.pid, basename(path!), shell.home)).toMatchObject({ ok: false, reason: "shell-busy" });
        const blocks = shell.tracker.nextBlockId();
        await expect(shell.type("true")).resolves.toMatchObject({ ok: false, reason: "shell-busy" });
        expect(shell.tracker.nextBlockId()).toBe(blocks);
        gate.release();
        await until(() => shell.output().includes("ORPHAN_WROTE"));
        // Once it is gone the terminal is the shell's alone again (its late line now sits at the prompt, which typing would refuse as pending input).
        let after = await readTerminalForeground(shell.pty.pid, { exclusive: true });
        for (let attempt = 0; attempt < 50 && !after.ok; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          after = await readTerminalForeground(shell.pty.pid, { exclusive: true });
        }
        expect(after, JSON.stringify(after)).toMatchObject({ ok: true });
      } finally { gate.close(); }
    }, 30_000);

    it.runIf(process.platform === "darwin")("refuses to press Enter while a process that left the terminal's session still holds it open", async () => {
      const shell = await startShell(path!);
      const gate = createGate(shell.home, "release-detached");
      try {
        // setsid drops the controlling terminal but keeps the inherited descriptors, so only the device's open files show it.
        const detach = `sh -c '(perl -MPOSIX -e "POSIX::setsid() or die; open(my \\$g, q(<), \\$ARGV[0]) or die; <\\$g>; print qq(DETACHED_WROTE\\n)" "$1") &' sh '${gate.path}'`;
        await ranCommand(shell, await shell.type(detach));
        await until(() => shell.tracker.promptState() === "ready", 4_000);
        let exclusive = await readTerminalForeground(shell.pty.pid, { exclusive: true });
        for (let attempt = 0; attempt < 50 && exclusive.ok; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          exclusive = await readTerminalForeground(shell.pty.pid, { exclusive: true });
        }
        expect(await readTerminalForeground(shell.pty.pid)).toMatchObject({ ok: true });
        expect(exclusive, JSON.stringify(exclusive)).toMatchObject({ ok: false, busy: true });
        const blocks = shell.tracker.nextBlockId();
        await expect(shell.type("true")).resolves.toMatchObject({ ok: false, reason: "shell-busy" });
        expect(shell.tracker.nextBlockId()).toBe(blocks);
        gate.release();
        await until(() => shell.output().includes("DETACHED_WROTE"));
      } finally { gate.close(); }
    }, 30_000);
  });
}

describe.runIf(TERMINAL_TEST_ZSH !== undefined)("zsh startup", () => {
  it("starts without a system completion audit asking for input", async () => {
    const shell = await startShell(TERMINAL_TEST_ZSH!, { profile: [
      // The global interactive startup file runs this before our .zshrc. A native audit of a writable completion directory must never block it.
      'mkdir -m 777 "$HOME/completions"',
      'printf "#compdef fixture\\n" > "$HOME/completions/_fixture"',
      'if [[ -z "$skip_global_compinit" ]]; then',
      '  fpath=("$HOME/completions" $fpath)',
      "  autoload -Uz compinit",
      "  compinit -D",
      "fi",
    ].join("\n") });
    expect(shell.output()).not.toContain("Ignore insecure");
    expect(await ranCommand(shell, await shell.type("true"))).toBe("true");
  }, 30_000);
});

describe.runIf(TERMINAL_TEST_ZSH !== undefined)("zsh with a right-hand prompt", () => {
  it("is refused as taking no paste, not left looking like the user is typing", async () => {
    const shell = await startShell(TERMINAL_TEST_ZSH!);
    await ranCommand(shell, await shell.type("RPROMPT='[right]'"));
    await until(() => shell.tracker.editLineText().includes("[right]"));
    shell.elapse(USER_INPUT_QUIET_MS + 200);
    // zle drew the right-hand prompt after B: without Paste=0 this would read as typing forever.
    expect(shell.tracker.editLineText()).toContain("[right]");
    await expect(shell.type("echo hi")).resolves.toMatchObject({ ok: false, reason: "no-bracketed-paste" });
  }, 30_000);
});

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
