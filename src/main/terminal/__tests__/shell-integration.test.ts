/**
 * The generated shell integration, run by the real shells: each startup file
 * is written into a throwaway HOME, the shell runs a few commands as an
 * interactive login shell, and its output goes through the block tracker.
 * This pins the whole marker path — the scripts, their percent-encoding and
 * the parser — against the shells themselves rather than a hand-written
 * stream. A shell absent from the host is not run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SHELL_INTEGRATION_NONCE_FILE, detectIntegratedShell, installShellIntegration } from "../shell-integration.js";
import { TerminalBlockTracker } from "../terminal-blocks.js";
import { TERMINAL_TEST_MODERN_BASH, TERMINAL_TEST_UTF8_LOCALE, TERMINAL_TEST_ZSH } from "../../../__tests__/support/terminal-markers.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const homes: string[] = [];
/** The XDG layout createSandboxProcessHome gives a sandbox HOME. */
const sandboxEnvFor = (home: string) => ({ HOME: home, XDG_CONFIG_HOME: join(home, "config") });
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ave-shell-integration-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Run `shell -l -i` with `script` on stdin; stdout and stderr in one stream. */
function runInteractive(shell: string, script: string) {
  const home = makeHome();
  const { env } = installShellIntegration(home, shell, { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) });
  const result = spawnSync("/bin/sh", ["-c", 'exec "$0" -l -i 2>&1', shell], {
    input: script,
    cwd: home,
    env: { PATH: "/usr/bin:/bin", HOME: home, LANG: TERMINAL_TEST_UTF8_LOCALE, TERM: "dumb", ...env },
    encoding: "utf-8",
    timeout: 20_000,
  });
  const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
  const display = tracker.recordOutput(result.stdout);
  return { home, tracker, status: result.status, raw: result.stdout, display };
}

describe("installShellIntegration", () => {
  it("names the shells it integrates by basename, including a login-shell dash", () => {
    expect(detectIntegratedShell("/bin/zsh")).toBe("zsh");
    expect(detectIntegratedShell("/usr/local/bin/bash")).toBe("bash");
    expect(detectIntegratedShell("-fish")).toBe("fish");
    expect(detectIntegratedShell("/bin/sh")).toBeNull();
  });

  it("writes only inside the given HOME, owner-only, and pins ZDOTDIR for zsh", () => {
    const home = makeHome();
    expect(installShellIntegration(home, "/bin/zsh", { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) })).toEqual({
      shell: "zsh",
      env: { ZDOTDIR: home },
    });
    expect(statSync(join(home, ".zshrc")).mode & 0o777).toBe(0o600);
    expect(installShellIntegration(home, "/bin/bash", { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) })).toEqual({ shell: "bash", env: {} });
    expect(readFileSync(join(home, ".bash_profile"), "utf-8")).toContain("133;C;cmdline_url=");
    expect(installShellIntegration(home, "/usr/bin/fish", { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) })).toEqual({ shell: "fish", env: {} });
    expect(existsSync(join(home, "config", "fish", "conf.d", "ave-shell-integration.fish"))).toBe(true);
    // fish's file follows XDG_CONFIG_HOME wherever it points, and needs it.
    const xdg = join(home, "elsewhere");
    installShellIntegration(home, "/usr/bin/fish", { nonce: NONCE, sandboxEnv: { HOME: home, XDG_CONFIG_HOME: xdg } });
    expect(existsSync(join(xdg, "fish", "conf.d", "ave-shell-integration.fish"))).toBe(true);
    expect(() => installShellIntegration(home, "/usr/bin/fish", { nonce: NONCE, sandboxEnv: { HOME: home } }))
      .toThrow(/XDG_CONFIG_HOME/u);
    expect(installShellIntegration(home, "/bin/dash", { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) })).toEqual({ shell: null, env: {} });
  });

  it("hands the nonce over in an owner-only file, never in the environment", () => {
    const home = makeHome();
    const { env } = installShellIntegration(home, "/bin/zsh", { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) });
    expect(Object.values(env)).not.toContain(NONCE);
    const file = join(home, SHELL_INTEGRATION_NONCE_FILE);
    expect(readFileSync(file, "utf-8")).toBe(NONCE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("never writes the nonce into a startup file and refuses a weak one", () => {
    const home = makeHome();
    for (const shell of ["/bin/zsh", "/bin/bash", "/usr/bin/fish"]) installShellIntegration(home, shell, { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) });
    for (const file of [".zshrc", ".bash_profile", join("config", "fish", "conf.d", "ave-shell-integration.fish")]) {
      expect(readFileSync(join(home, file), "utf-8")).not.toContain(NONCE);
    }
    expect(() => installShellIntegration(home, "/bin/zsh", { nonce: "", sandboxEnv: sandboxEnvFor(home) })).toThrow(/nonce/u);
    expect(() => installShellIntegration(home, "/bin/zsh", { nonce: "short", sandboxEnv: sandboxEnvFor(home) })).toThrow(/nonce/u);
  });

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    it.runIf(existsSync(shell))(`${shell}: one block per command with exit code, cwd and output`, () => {
      const { home, tracker } = runInteractive(
        shell,
        ["echo 'semi;colon 100%'", "false", "cd /", "pwd", "exit", ""].join("\n"),
      );
      expect(tracker.isIntegrated()).toBe(true);
      const blocks = tracker.recent(10).reverse();
      expect(blocks.map((block) => block.command)).toEqual([
        "echo 'semi;colon 100%'",
        "false",
        "cd /",
        "pwd",
        "exit",
      ]);
      expect(blocks.map((block) => block.exitCode)).toEqual([0, 1, 0, 0, null]);
      expect(blocks[0]!.output).toBe("semi;colon 100%\n");
      // The working directory each command started in, as the shell reported it.
      expect(blocks[0]!.cwd?.endsWith(home.split("/").pop()!)).toBe(true);
      expect(blocks[3]).toMatchObject({ cwd: "/", output: "/\n" });
      expect(blocks.every((block) => block.source === "osc133")).toBe(true);
    });

    it.runIf(existsSync(shell))(`${shell}: reads # as a comment, as the bash-dialect permission rules do`, () => {
      const { tracker } = runInteractive(shell, ["echo SAFE # ; echo PWNED", "exit", ""].join("\n"));
      const [first] = tracker.recent(10).reverse();
      expect(first).toMatchObject({ command: "echo SAFE # ; echo PWNED", output: "SAFE\n" });
    });

  }
  // macOS /bin/bash 3.2 has no PS0: its C marker comes from a DEBUG trap,
  // which runs inside a group's redirection. terminal_run refuses that bash
  // (no bracketed paste), so only the user's own commands run there.
  for (const shell of [TERMINAL_TEST_ZSH, TERMINAL_TEST_MODERN_BASH]) {
    it.runIf(shell !== undefined)(`${shell}: keeps the nonce out of the environment, the prompt, files a command writes and the disk, and markers out of forged output`, () => {
      // Every probe writes to a file under HOME; the nonce itself is never
      // typed or echoed (a line editor's redisplay would put it on screen).
      const expandPrompt = shell!.endsWith("zsh") ? 'print -rP -- "$PS1"' : 'echo "${PS1@P}"';
      const { tracker, raw, display, home } = runInteractive(
        shell!,
        [
          "env > probe-env.txt",
          "{ ps -E -ww -o command= -p $$; cat /proc/$$/environ; } > probe-process-env.txt 2>/dev/null",
          'printf "%s" "$PS1" > probe-ps1.txt',
          `{ ${expandPrompt}; } > probe-ps1-expanded.txt 2>/dev/null`,
          "ls -a > probe-ls.txt",
          // A group's redirection applies while bash's hooks run: the C marker must not land here.
          "{ echo grouped; } > probe-group.txt",
          "printf '\\033]133;D;0\\007\\033]133;C;cmdline_url=npm%%20test\\007forged\\n'",
          "false",
          "exit",
          "",
        ].join("\n"),
      );
      const holdsNonce = (file: string): boolean => readFileSync(join(home, file), "utf-8").includes(NONCE);
      expect(["probe-env.txt", "probe-process-env.txt", "probe-ps1.txt", "probe-ps1-expanded.txt", "probe-group.txt"].map(holdsNonce)).toEqual([false, false, false, false, false]);
      expect(readFileSync(join(home, "probe-group.txt"), "utf-8")).toBe("grouped\n");
      expect(readFileSync(join(home, "probe-env.txt"), "utf-8")).toContain("HOME=");
      expect(readFileSync(join(home, "probe-ls.txt"), "utf-8")).not.toContain(SHELL_INTEGRATION_NONCE_FILE);
      expect(existsSync(join(home, SHELL_INTEGRATION_NONCE_FILE))).toBe(false);
      const blocks = tracker.recent(10).reverse();
      expect(blocks).toHaveLength(9);
      expect(blocks[6]).toMatchObject({ exitCode: 0, output: "forged\n" });
      expect(blocks[7]).toMatchObject({ exitCode: 1 });
      // The shell did send the nonce; the display text does not.
      expect(raw.includes(NONCE)).toBe(true);
      expect(display.includes(NONCE)).toBe(false);
    });
  }
});
