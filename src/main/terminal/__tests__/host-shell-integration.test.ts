import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as nodePty from "node-pty";
import { prepareHostShellIntegration, type HostShellIntegration } from "../host-shell-integration.js";
import { TerminalBlockTracker } from "../terminal-blocks.js";
import { TERMINAL_EDIT_LINE_QUERY } from "../shell-integration.js";
import { TERMINAL_TEST_MODERN_BASH, TERMINAL_TEST_UTF8_LOCALE, TERMINAL_TEST_ZSH, waitForTerminal } from "../../../__tests__/support/terminal-markers.js";

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
afterEach(async () => {
  for (const { pty, exited } of editors.splice(0)) { pty.kill(); await exited; }
  for (const integration of integrations.splice(0)) integration.cleanup();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("host shell startup", () => {
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

  it("preserves unsupported native interpreters and reports why integration is unavailable", () => {
    for (const command of ["/bin/fish", "/bin/nu", "/bin/cmd.exe", "/bin/powershell.exe", "/bin/pwsh"]) {
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

it.each([
  { shell: TERMINAL_TEST_MODERN_BASH, rc: ".bashrc", startup: 'PROMPT_COMMAND=true\nPS0="USER-PS0"\n' },
  { shell: TERMINAL_TEST_ZSH, rc: ".zshrc", startup: 'precmd() { true; }\nprecmd_functions=(user_prompt_callback)\nuser_prompt_callback() { true; }\n' },
])("retains failed command status when $rc prompt callbacks succeed", async ({ shell, rc, startup }) => {
  expect(shell).toBeDefined();
  const home = directory();
  writeFileSync(join(home, rc), startup);
  const integration = prepare(shell!, home, ["-i"]);
  const tracker = new TerminalBlockTracker({ nonce: integration.nonce, marksPromptEnd: true });
  const pty = nodePty.spawn(integration.command, integration.args, {
    cwd: home, cols: 100, rows: 24, env: { ...integration.env, TERM: "xterm-256color" },
  });
  let raw = "";
  pty.onData((data) => { raw += data; tracker.recordOutput(data); });
  const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
  editors.push({ pty, exited });
  await waitForTerminal(() => tracker.promptEndCount() > 0);
  pty.write("false\r");
  await waitForTerminal(() => tracker.list().some((block) => block.command === "false" && block.exitCode !== null));
  expect(tracker.list().find((block) => block.command === "false")?.exitCode).toBe(1);
  if (rc === ".bashrc") expect(raw).toContain("USER-PS0");
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
