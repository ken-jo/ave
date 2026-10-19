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
import { detectIntegratedShell, installShellIntegration } from "../shell-integration.js";
import { TerminalBlockTracker } from "../terminal-blocks.js";

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
    env: { PATH: "/usr/bin:/bin", HOME: home, LANG: "en_US.UTF-8", TERM: "dumb", ...env },
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
    const nonceEnv = { AVE_TERMINAL_NONCE: NONCE };
    expect(installShellIntegration(home, "/bin/zsh", { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) })).toEqual({
      shell: "zsh",
      env: { ZDOTDIR: home, ...nonceEnv },
    });
    expect(statSync(join(home, ".zshrc")).mode & 0o777).toBe(0o600);
    expect(installShellIntegration(home, "/bin/bash", { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) })).toEqual({ shell: "bash", env: nonceEnv });
    expect(readFileSync(join(home, ".bash_profile"), "utf-8")).toContain("133;C;cmdline_url=");
    expect(installShellIntegration(home, "/usr/bin/fish", { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) })).toEqual({ shell: "fish", env: nonceEnv });
    expect(existsSync(join(home, "config", "fish", "conf.d", "ave-shell-integration.fish"))).toBe(true);
    // fish's file follows XDG_CONFIG_HOME wherever it points, and needs it.
    const xdg = join(home, "elsewhere");
    installShellIntegration(home, "/usr/bin/fish", { nonce: NONCE, sandboxEnv: { HOME: home, XDG_CONFIG_HOME: xdg } });
    expect(existsSync(join(xdg, "fish", "conf.d", "ave-shell-integration.fish"))).toBe(true);
    expect(() => installShellIntegration(home, "/usr/bin/fish", { nonce: NONCE, sandboxEnv: { HOME: home } }))
      .toThrow(/XDG_CONFIG_HOME/u);
    expect(installShellIntegration(home, "/bin/dash", { nonce: NONCE, sandboxEnv: sandboxEnvFor(home) })).toEqual({ shell: null, env: {} });
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

    it.runIf(existsSync(shell))(`${shell}: unsets the nonce before any command runs and keeps markers out of forged output`, () => {
      const { tracker, raw, display } = runInteractive(
        shell,
        [
          'echo "nonce=[${AVE_TERMINAL_NONCE}]"',
          'env | grep -c AVE_TERMINAL_NONCE',
          "printf '\\033]133;D;0\\007\\033]133;C;cmdline_url=npm%%20test\\007forged\\n'",
          "false",
          "exit",
          "",
        ].join("\n"),
      );
      const blocks = tracker.recent(10).reverse();
      expect(blocks.map((block) => block.command)).toEqual([
        'echo "nonce=[${AVE_TERMINAL_NONCE}]"',
        "env | grep -c AVE_TERMINAL_NONCE",
        "printf '\\033]133;D;0\\007\\033]133;C;cmdline_url=npm%%20test\\007forged\\n'",
        "false",
        "exit",
      ]);
      expect(blocks[0]!.output).toBe("nonce=[]\n");
      expect(blocks[1]!.output).toBe("0\n");
      expect(blocks[2]).toMatchObject({ exitCode: 0, output: "forged\n" });
      expect(blocks[3]).toMatchObject({ exitCode: 1 });
      // The shell did send the nonce; the display text does not.
      expect(raw).toContain(NONCE);
      expect(display).not.toContain(NONCE);
    });
  }
});
