import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as nodePty from "node-pty";
import { prepareHostShellIntegration, type HostShellIntegration } from "../host-shell-integration.js";
import { aveHome, ensureAveHomePrivate, readWindowsDirectoryDacls } from "../../../shared/ave-home.js";
import { configureHostResources } from "../../host-resources.js";
import { isOwnerOnlyDacl } from "../../../shared/windows-path-facts.js";
import { TerminalBlockTracker } from "../terminal-blocks.js";
import { generatePwshHostHooks, powerShellQuote, pwshNoncePrologue, TERMINAL_EDIT_LINE_QUERY } from "../shell-integration.js";
import { TERMINAL_TEST_MODERN_BASH, TERMINAL_TEST_PWSH, TERMINAL_TEST_UTF8_LOCALE, TERMINAL_TEST_ZSH, waitForTerminal } from "../../../__tests__/support/terminal-markers.js";

const { argsToCommandLine } = createRequire(import.meta.url)("node-pty/lib/windowsPtyAgent.js") as {
  argsToCommandLine: (file: string, args: string[]) => string;
};

/** Decode argument quotes and backslash runs using the native C runtime rules. */
function parseWindowsArguments(commandLine: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/[ \t]/u.test(commandLine[index] ?? "")) index++;
    if (index === commandLine.length) break;
    let arg = "";
    let quoted = false;
    while (index < commandLine.length && (quoted || !/[ \t]/u.test(commandLine[index]!))) {
      let backslashes = 0;
      while (commandLine[index] === "\\") { backslashes++; index++; }
      if (commandLine[index] === '"') {
        arg += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) arg += '"';
        else if (quoted && commandLine[index + 1] === '"') { arg += '"'; index++; }
        else quoted = !quoted;
        index++;
      } else {
        arg += "\\".repeat(backslashes);
        if (index < commandLine.length && (quoted || !/[ \t]/u.test(commandLine[index]!))) arg += commandLine[index++]!;
      }
    }
    args.push(arg);
  }
  return args;
}

const directories: string[] = [];
const integrations: HostShellIntegration[] = [];
const editors: Array<{ pty: nodePty.IPty; exited: Promise<void> }> = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "ave-host-integration-test-"));
  directories.push(path);
  return path;
}
function prepare(command: string, home: string, args = ["-l", "-i"], extra: Record<string, string> = {}) {
  const integration = prepareHostShellIntegration({ command, args }, {
    ...process.env, HOME: home, ZDOTDIR: undefined, LANG: TERMINAL_TEST_UTF8_LOCALE, ...extra,
  });
  integrations.push(integration);
  return integration;
}
function execute(integration: HostShellIntegration, script: string) {
  const result = spawnSync(integration.command, integration.args, {
    env: integration.env, input: script + "\nexit\n", encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout + result.stderr;
}
/** Only the current user can read the nonce: POSIX mode bits, or on Windows the directory's real DACL (mode bits do not reflect ACLs there). */
function expectOwnerOnly(dir: string, file: string): void {
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o077).toBe(0);
    return;
  }
  const [descriptor] = readWindowsDirectoryDacls([dir]);
  expect(descriptor?.error).toBeUndefined();
  expect(descriptor?.protected).toBe(true);
  expect(isOwnerOnlyDacl(descriptor!, descriptor!.currentUserSid!)).toBe(true);
}
// Boot supplies host resources (on Windows, the DACL helper) and makes the Ave home private before any terminal starts; a Windows pwsh
// terminal's owned directory is a protected child of that home, so these tests compose the same way. The home is a fresh path so the
// helper creates it owner-only, as boot does on first run.
beforeAll(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  process.env.AVE_HOME = join(process.env.AVE_HOME!, "home");
  expect(ensureAveHomePrivate().enforcement).not.toBe("none");
});
afterEach(async () => {
  for (const { pty, exited } of editors.splice(0)) { pty.kill(); await exited; }
  for (const integration of integrations.splice(0)) integration.cleanup();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

// zsh and bash startup, run against the real interpreters: POSIX only (Windows host terminals start COMSPEC or pwsh).
describe.runIf(process.platform !== "win32")("host shell startup", () => {
  it("sources real login files in order with the original startup directory and leaves HOME untouched", () => {
    expect(TERMINAL_TEST_ZSH).toBeDefined();
    const home = directory();
    const dotdir = directory();
    const trace = join(home, "startup-trace");
    const originals = new Map<string, string>();
    for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"]) {
      const text = `printf '%s:%s:%s\\n' '${name}' "$HOME" "$ZDOTDIR" >> "$STARTUP_TRACE"\n`;
      writeFileSync(join(dotdir, name), text);
      originals.set(name, text);
    }
    const integration = prepare(TERMINAL_TEST_ZSH!, home, ["-l", "-i"], { ZDOTDIR: dotdir, STARTUP_TRACE: trace });
    expect(integration.env.HOME).toBe(home);
    expect(integration.marksPromptEnd).toBe(true);
    const temporary = integration.env.ZDOTDIR!;
    expect(statSync(temporary).mode & 0o777).toBe(0o700);
    expect(execute(integration, "printf 'alive\\n'")).toContain("alive");
    expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual(
      [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"].map((name) => `${name}:${home}:${dotdir}`),
    );
    for (const [name, text] of originals) expect(readFileSync(join(dotdir, name), "utf8")).toBe(text);
    // A global zshrc's compinit runs while ZDOTDIR is the temporary directory and leaves its dump there; cleanup removes it with the directory.
    writeFileSync(join(temporary, ".zcompdump"), "#files: 0\n");
    expect(existsSync(join(dotdir, ".zcompdump"))).toBe(false);
    integration.cleanup();
    integration.cleanup();
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(dotdir)).toBe(true);
  });

  it("honors startup-directory changes made by the real environment file", () => {
    const home = directory();
    const dotdir = directory();
    writeFileSync(join(home, ".zshenv"), 'export ZDOTDIR="$NEXT_DOTDIR"\n');
    writeFileSync(join(dotdir, ".zshrc"), 'export STARTUP_RESULT="$ZDOTDIR"\n');
    const integration = prepare(TERMINAL_TEST_ZSH!, home, ["-i"], { NEXT_DOTDIR: dotdir });
    expect(execute(integration, 'printf "RESULT:%s:%s\\n" "$STARTUP_RESULT" "$ZDOTDIR"')).toContain(`RESULT:${dotdir}:${dotdir}`);
  });

  it("replays the first readable login profile and retains its prompt callback", () => {
    expect(TERMINAL_TEST_MODERN_BASH).toBeDefined();
    const home = directory();
    writeFileSync(join(home, ".bash_profile"), 'export STARTUP_RESULT=profile\nPROMPT_COMMAND=\'printf "USER-PROMPT\\n"\'\n');
    writeFileSync(join(home, ".bash_login"), "export STARTUP_RESULT=wrong\n");
    writeFileSync(join(home, ".bashrc"), "export STARTUP_RESULT=wrong\n");
    const integration = prepare(TERMINAL_TEST_MODERN_BASH!, home);
    expect(integration.args.slice(0, 1)).toEqual(["--rcfile"]);
    const raw = execute(integration, 'printf "RESULT:%s:%s\\n" "$STARTUP_RESULT" "$HOME"');
    expect(raw).toContain(`RESULT:profile:${home}`);
    expect(raw).toContain("USER-PROMPT");
    expect(raw).toContain(`;${integration.nonce}\u0007`);
    expect(existsSync(join(dirname(integration.args[1]!), ".ave-terminal-nonce"))).toBe(false);
  });

  it("attests a real interactive editor and reports the actual pending line", async () => {
    const home = directory();
    const integration = prepare(TERMINAL_TEST_MODERN_BASH!, home, ["-i"]);
    const tracker = new TerminalBlockTracker({ nonce: integration.nonce, marksPromptEnd: integration.marksPromptEnd });
    const pty = nodePty.spawn(integration.command, integration.args, {
      cwd: home, cols: 100, rows: 24, env: { ...integration.env, TERM: "xterm-256color" },
    });
    let raw = "";
    pty.onData((data) => { raw += data; tracker.recordOutput(data); });
    const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
    editors.push({ pty, exited });
    await waitForTerminal(() => tracker.promptEndCount() > 0);
    expect(raw).toMatch(/;Edit=1;/u);
    pty.write("pending-line" + TERMINAL_EDIT_LINE_QUERY);
    await waitForTerminal(() => raw.includes("133;E;Line=pending-line;"));
    expect(raw).toContain(`;${integration.nonce}\u0007`);
  });

});

describe("host shell integration choice", () => {
  it("preserves unsupported native interpreters and reports why integration is unavailable", () => {
    for (const command of ["/bin/fish", "/bin/nu", "/bin/cmd.exe", "/bin/powershell.exe"]) {
      const integration = prepare(command, directory(), ["-i"]);
      expect(integration.command).toBe(command);
      expect(integration.args).toEqual(["-i"]);
      expect(integration.marksPromptEnd).toBe(false);
      expect(integration.integrationUnavailableReason).toBe("unsupported-shell");
    }
  });

  it("preserves custom startup arguments without claiming authenticated hooks", () => {
    const integration = prepare("/bin/zsh", directory(), ["-f", "-i"]);
    expect(integration.args).toEqual(["-f", "-i"]);
    expect(integration.marksPromptEnd).toBe(false);
    expect(integration.integrationUnavailableReason).toBe("custom-launch");
  });
});

describe.runIf(process.platform !== "win32")("host shell prompt callbacks and startup secrecy", () => {
it.each([
  { shell: TERMINAL_TEST_MODERN_BASH, rc: ".bashrc", startup: 'PROMPT_COMMAND=true\nPS0="USER-PS0"\n' },
  { shell: TERMINAL_TEST_ZSH, rc: ".zshrc", startup: 'precmd() { true; }\nprecmd_functions=(user_prompt_callback)\nuser_prompt_callback() { true; }\n' },
])("retains failed command status when $rc prompt callbacks succeed", async ({ shell, rc, startup }) => {
  expect(shell).toBeDefined();
  const home = directory();
  writeFileSync(join(home, rc), startup);
  // Ubuntu's global zshrc runs compinit, which stops at an interactive y/n question when the runner's completion directories are group-writable.
  // That question is the native shell's behavior; this user opts out as a real user would, so the test measures only the prompt callbacks.
  if (rc === ".zshrc") writeFileSync(join(home, ".zshenv"), "skip_global_compinit=1\n");
  const integration = prepare(shell!, home, ["-i"]);
  const tracker = new TerminalBlockTracker({ nonce: integration.nonce, marksPromptEnd: true });
  const pty = nodePty.spawn(integration.command, integration.args, {
    cwd: home, cols: 100, rows: 24, env: { ...integration.env, TERM: "xterm-256color" },
  });
  let raw = "";
  pty.onData((data) => { raw += data; tracker.recordOutput(data); });
  const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
  editors.push({ pty, exited });
  await waitForTerminal(() => tracker.promptEndCount() > 0)
    .catch((error: Error) => { throw new Error(`${error.message}; terminal output: ${JSON.stringify(raw.slice(-600).replaceAll(integration.nonce, "<nonce>"))}`); });
  pty.write("false\r");
  await waitForTerminal(() => tracker.list().some((block) => block.command === "false" && block.exitCode !== null));
  expect(tracker.list().find((block) => block.command === "false")?.exitCode).toBe(1);
  if (rc === ".bashrc") expect(raw).toContain("USER-PS0");
});

// A user startup file (or a loader it runs) must not find the nonce that authenticates the host markers.
it.each([
  { shell: TERMINAL_TEST_MODERN_BASH, files: [".bashrc"] },
  { shell: TERMINAL_TEST_ZSH, files: [".zshenv", ".zprofile", ".zshrc", ".zlogin"] },
])("hides the nonce file from every $files user startup file", ({ shell, files }) => {
  expect(shell).toBeDefined();
  const home = directory();
  const probe = [
    files[0] === ".bashrc"
      ? 'for ave_probe in "$LEAK_DIR"/ave-host-terminal-*/.ave-terminal-nonce; do'
      : 'for ave_probe in "$LEAK_DIR"/ave-host-terminal-*/.ave-terminal-nonce(N); do',
    '  [ -r "$ave_probe" ] && printf "LEAK:%s\\n" "$(cat "$ave_probe")"',
    "done",
    ...(files[0] === ".bashrc" ? ['[ -r "$(dirname "${BASH_SOURCE[1]}")/.ave-terminal-nonce" ] && printf "LEAK-SOURCE\\n"'] : []),
    'printf "PROBED\\n"',
    "",
  ].join("\n");
  for (const name of files) writeFileSync(join(home, name), (name === ".zshenv" ? "skip_global_compinit=1\n" : "") + probe);
  const integration = prepare(shell!, home, files[0] === ".bashrc" ? ["-i"] : ["-l", "-i"], { LEAK_DIR: tmpdir() });
  expect(integration.marksPromptEnd).toBe(true);
  const raw = execute(integration, "printf 'alive\\n'");
  expect(raw).toContain("PROBED");
  expect(raw).toContain("alive");
  expect(raw).not.toContain("LEAK");
  expect(raw.split(integration.nonce).length - 1, "the hooks still authenticate their markers").toBeGreaterThan(0);
});

it("retains the configured debug trap without replacing it on an older interpreter", () => {
  const home = directory();
  writeFileSync(join(home, ".bashrc"), "trap ': USER-DEBUG-TRAP' DEBUG\n");
  const integration = prepare("/bin/bash", home, ["-i"]);
  const raw = execute(integration, "trap -p DEBUG\nprintf 'NATIVE-ALIVE\\n'");
  expect(raw).toContain("USER-DEBUG-TRAP");
  expect(raw).toContain("NATIVE-ALIVE");
  expect(raw).not.toContain("trap -- '__ave_preexec' DEBUG");
});
});

function pwshNoncePath(integration: Pick<HostShellIntegration, "args">): string {
  return /ReadAllText\('((?:[^']|'')*)'\)/u.exec(integration.args.at(-1)!)![1]!.replace(/(['‘’‚‛])\1/gu, "$1");
}

describe("pwsh host startup (inline command)", () => {
  it("inlines startup so the nonce is taken before any profile and hooks install after them", () => {
    for (const [args, login] of [[["-l", "-i"], true], [[], false], [["-Interactive"], false]] as const) {
      const integration = prepare("/usr/local/bin/pwsh", directory(), [...args]);
      expect(integration.integrationUnavailableReason).toBeUndefined();
      expect(integration.marksPromptEnd).toBe(true);
      expect(integration.args.slice(0, -1)).toEqual([...(login ? ["-Login"] : []), "-NoProfile", "-NoExit", "-Command"]);
      const noncePath = pwshNoncePath(integration);
      const startup = integration.args.at(-1)!;
      expect(startup.startsWith(pwshNoncePrologue(noncePath) + "\n")).toBe(true);
      expect(startup).not.toMatch(/^\s*#/mu);
      const nonceRead = startup.indexOf("ReadAllText");
      const nonceDelete = startup.indexOf("Remove-Item -LiteralPath");
      const profiles = startup.indexOf("$PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost");
      const hooks = startup.indexOf(generatePwshHostHooks());
      expect(nonceRead).toBeGreaterThan(-1);
      expect(nonceRead).toBeLessThan(nonceDelete);
      expect(nonceDelete).toBeLessThan(profiles);
      expect(profiles).toBeLessThan(hooks);
      // The nonce is in an owner-only file, never in the launch arguments or environment.
      expect(readFileSync(noncePath, "utf8")).toBe(integration.nonce);
      expectOwnerOnly(dirname(noncePath), noncePath);
      // On Windows the owned directory is a protected child of the Ave home, never a temporary directory inheriting its parent's DACL.
      if (process.platform === "win32") expect(dirname(dirname(noncePath))).toBe(aveHome());
      expect(JSON.stringify([integration.args, integration.env])).not.toContain(integration.nonce);
      const hookText = startup.slice(hooks);
      // No documented bracketed paste in PSReadLine: every prompt says so, and agent typing refuses it.
      expect(hookText).toContain(";Paste=0;");
      expect(hookText).toContain(";Edit=0;");
    }
  });

  it("leaves only the nonce file and dot-sources only user profiles", () => {
    const integration = prepare("/usr/local/bin/pwsh", directory(), []);
    const startup = integration.args.at(-1)!;
    expect(readdirSync(dirname(pwshNoncePath(integration)))).toEqual([".ave-terminal-nonce"]);
    expect(startup).not.toMatch(/\.\s+['"]/u);
    expect(startup.match(/\{ \. [^}]+\}/gu)).toEqual(["{ . $__ave_profile }"]);
    expect(startup).not.toContain(".ps1");
  });

  it("quotes nonce paths containing apostrophes and shell metacharacters literally", () => {
    const noncePath = "C:\\Users\\alice's ‘home’‚‛ $home` directory\\.ave\\host-terminal-example\\.ave-terminal-nonce";
    const quoted = "'C:\\Users\\alice''s ‘‘home’’‚‚‛‛ $home` directory\\.ave\\host-terminal-example\\.ave-terminal-nonce'";
    expect(powerShellQuote(noncePath)).toBe(quoted);
    const prologue = pwshNoncePrologue(noncePath);
    expect(prologue).toContain(`Test-Path -LiteralPath ${quoted} -PathType Leaf`);
    expect(prologue).toContain(`[System.IO.File]::ReadAllText(${quoted})`);
    expect(prologue).toContain(`Remove-Item -LiteralPath ${quoted} -Force`);
    expect(pwshNoncePath({ args: [prologue] })).toBe(noncePath);
  });

  it("keeps inline argv well below the command-line limit with a long home path", () => {
    const home = join("C:\\Users\\alice", ...Array<string>(12).fill("example directory with spaces"));
    const integration = prepare("/usr/local/bin/pwsh", home, ["-Login"]);
    // Model an owned nonce directory under the long home on every test platform.
    const noncePath = home + "\\.ave\\host-terminal-example\\alice's \"%$`‘’‚‛ nonce\\";
    const args = integration.args.map((arg) => arg.replaceAll(powerShellQuote(pwshNoncePath(integration)), () => powerShellQuote(noncePath)));
    const commandLine = argsToCommandLine(integration.command, args);
    expect(commandLine.length).toBeLessThan(16_000);
    expect(parseWindowsArguments(commandLine)).toEqual([integration.command, ...args]);
    expect(pwshNoncePath({ args: parseWindowsArguments(commandLine).slice(1) })).toBe(noncePath);
  });

  it("keeps a pwsh launch with other arguments native", () => {
    const integration = prepare("/usr/local/bin/pwsh", directory(), ["-NoLogo", "-i"]);
    expect(integration.args).toEqual(["-NoLogo", "-i"]);
    expect(integration.integrationUnavailableReason).toBe("custom-launch");
  });

  it("parses the generated prompt markers as an attested prompt that refuses agent typing", () => {
    const integration = prepare("/usr/local/bin/pwsh", directory(), []);
    const tracker = new TerminalBlockTracker({ nonce: integration.nonce, marksPromptEnd: true });
    const n = integration.nonce;
    tracker.recordOutput(`\u001b]133;D;0;${n}\u0007\u001b]133;P;Cwd=C:\\Users\\me;Keys=emacs;Paste=0;NotFound=0;Edit=0;B=${"ab".repeat(16)};Pid=4242;${n}\u0007\u001b]133;A;${n}\u0007PS C:\\Users\\me> \u001b]133;B;${"ab".repeat(16)}\u0007`);
    expect(tracker.isIntegrated()).toBe(true);
    expect(tracker.currentCwd()).toBe("C:\\Users\\me");
    expect(tracker.promptState()).toBe("no-bracketed-paste");
    expect(tracker.supportsEditLineQuery()).toBe(false);
  });
});

// A named interpreter that cannot be found fails here instead of silently skipping the native suite. A Store (MSIX) install's
// `pwsh.exe` alias cannot be opened by path; name the real executable under C:\\Program Files\\WindowsApps\\… instead.
it.runIf(process.env.AVE_TEST_PWSH !== undefined && process.env.AVE_TEST_PWSH.length > 0)("finds the pwsh that AVE_TEST_PWSH names", () => {
  expect(TERMINAL_TEST_PWSH, `AVE_TEST_PWSH=${process.env.AVE_TEST_PWSH} is not a readable file`).toBe(process.env.AVE_TEST_PWSH);
});

/** Native pwsh (PowerShell 7). Runs wherever pwsh is installed (the Linux CI image has /usr/bin/pwsh) or `AVE_TEST_PWSH` names it. */
describe.runIf(TERMINAL_TEST_PWSH !== undefined)("pwsh host startup (native)", () => {
  async function start(home: string, args: string[], extra: Record<string, string> = {}) {
    const integration = prepare(TERMINAL_TEST_PWSH!, home, args, extra);
    const tracker = new TerminalBlockTracker({ nonce: integration.nonce, marksPromptEnd: integration.marksPromptEnd });
    const pty = nodePty.spawn(integration.command, integration.args, {
      cwd: home, cols: 120, rows: 30, env: { ...integration.env, TERM: "xterm-256color" },
    });
    let raw = "";
    pty.onData((data) => {
      raw += data;
      tracker.recordOutput(data);
      // Answer as a terminal emulator does (xterm.js in the app). .NET asks for the cursor position as PSReadLine starts and reads its
      // input until the reply comes, so with nobody answering, the keys typed at the first prompt are consumed by that wait.
      for (const _query of data.matchAll(/\u001b\[6n/gu)) pty.write("\u001b[1;1R");
    });
    const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
    editors.push({ pty, exited });
    await waitForTerminal(() => tracker.promptEndCount() > 0, 30_000);
    return { integration, tracker, pty, raw: () => raw };
  }

  it("attests prompts and directories with the terminal's nonce, deletes the nonce file, and refuses agent typing", async () => {
    const home = directory();
    const { integration, tracker } = await start(home, process.platform === "win32" ? [] : ["-l", "-i"]);
    expect(tracker.isIntegrated()).toBe(true);
    expect(tracker.currentCwd()).not.toBeNull();
    expect(tracker.reportedShellPid()).not.toBeNull();
    expect(tracker.promptState()).toBe("no-bracketed-paste");
    expect(existsSync(pwshNoncePath(integration))).toBe(false);
  }, 60_000);

  it("records the user's command block with its exit status", async () => {
    const home = directory();
    const { tracker, pty } = await start(home, process.platform === "win32" ? [] : ["-l", "-i"]);
    const before = tracker.promptEndCount();
    pty.write("Write-Output ave-block; exit-not-a-command\r");
    await waitForTerminal(() => tracker.promptEndCount() > before, 30_000);
    const block = tracker.list().find((summary) => summary.command.includes("ave-block"));
    expect(block?.source).toBe("osc133");
    expect(block?.exitCode).not.toBe(0);
  }, 60_000);

  it.runIf(process.platform === "win32")("attests inline startup under a restrictive execution policy and deletes the nonce file", async () => {
    // Restricted blocks script files without the interactive publisher prompt that AllSigned can trigger.
    const { integration, tracker } = await start(directory(), [], { PSExecutionPolicyPreference: "Restricted" });
    expect(tracker.isIntegrated()).toBe(true);
    expect(existsSync(pwshNoncePath(integration))).toBe(false);
  }, 60_000);

  it.runIf(process.platform !== "win32")("dot-sources the user's profiles after the nonce is taken and before the hooks", async () => {
    const home = directory();
    const config = join(home, ".config", "powershell");
    mkdirSync(config, { recursive: true });
    const trace = join(home, "profile-trace");
    for (const name of ["profile.ps1", "Microsoft.PowerShell_profile.ps1"]) {
      // A profile sees the nonce variable (it shares the shell) but never its file, and runs before the prompt hook replaces `prompt`.
      writeFileSync(join(config, name), `Add-Content -LiteralPath '${trace}' -Value ("${name}:" + [bool]$global:__ave_nonce + ":" + [bool](Get-Command __ave_encode -ErrorAction SilentlyContinue))\n`);
    }
    await start(home, ["-l", "-i"], { XDG_CONFIG_HOME: join(home, ".config") });
    expect(readFileSync(trace, "utf8").trim().split(/\r?\n/u)).toEqual(["profile.ps1:True:False", "Microsoft.PowerShell_profile.ps1:True:False"]);
  }, 60_000);
});
