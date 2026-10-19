/**
 * terminal-inner-pty.ts — give the workspace terminal's sandboxed shell a
 * terminal of its own on Linux.
 *
 * WHY: the sandbox runtime starts bubblewrap with `--new-session` (setsid),
 * bubblewrap's documented defense against TIOCSTI input injection
 * (CVE-2017-5226), and it stays on. Nothing inside the sandbox then has the
 * pty node-pty opened as its controlling terminal. Measured with the shell
 * exec'd straight onto that pty:
 *  - the pty's foreground process group was the outer bubblewrap, so Ctrl-C
 *    (SIGINT from the pty's line discipline) killed bubblewrap and, through
 *    `--die-with-parent`, the whole terminal;
 *  - the shell had no controlling terminal: no job control (bash: "cannot set
 *    terminal process group"), and nothing to interrupt a running command;
 *  - terminal_run found bubblewrap in the foreground and refused.
 *
 * WHAT: the shell runs under util-linux `script(1)` INSIDE the sandbox.
 * `script` opens a new pty in the sandbox's own devpts (bubblewrap `--dev`),
 * starts the shell as the leader of a new session with that pty as its
 * controlling terminal, and relays bytes between it and the outer pty, which
 * it switches to raw mode. The outer pty then turns no key into a signal, so
 * Ctrl-C reaches the inner pty as a byte, and the inner pty's line discipline
 * signals the shell's foreground job as any terminal does: a running command
 * is interrupted, the line editor clears its line and redraws, and job control
 * (Ctrl-Z, `fg`, `bg`, `jobs`) works. This is the answer util-linux gave the
 * same TIOCSTI problem for `su` (`su --pty`): a new session on a new pty.
 * TIOCSTI on the inner pty can only feed the shell's own input, read inside
 * the sandbox. `--new-session` is unchanged.
 *
 * RESIZE: the relay is in the sandbox's session, so the kernel's SIGWINCH for
 * the outer pty goes to bubblewrap, not to it. The host forwards it
 * (shell-process.ts `forwardResizeToSandboxedPtyRelay`), and the relay copies
 * the outer size to the inner pty.
 *
 * REQUIREMENT: util-linux `script` at {@link INNER_PTY_RELAY_PATH} (Debian and
 * Ubuntu: `bsdutils`, required priority; Fedora, Arch: `util-linux`). Without
 * it the terminal is refused with the reason: a shell on the outer pty is the
 * broken terminal described above, so there is no fallback to it. BusyBox
 * `script` has no `-e` and is refused too.
 */
import { execFile } from "node:child_process";
import { shellQuote } from "../../lib/shell-resolver.js";

/** util-linux `script(1)`, by absolute path: the sandbox mounts the host's `/usr` read-only. */
const INNER_PTY_RELAY_PATH = "/usr/bin/script";

/** The shell `script` runs its `-c` command with: fixed, so the user's `$SHELL` never parses it. */
const RELAY_COMMAND_SHELL = "/bin/sh";

const CHECK_TIMEOUT_MS = 5_000;

let relayVerified = false;

/**
 * Check, once per app run, that {@link INNER_PTY_RELAY_PATH} is util-linux
 * `script`. Throws the reason the terminal cannot start otherwise.
 */
export async function assertInnerPtyRelay(): Promise<void> {
  if (relayVerified) return;
  const version = await new Promise<string>((resolve, reject) => {
    execFile(INNER_PTY_RELAY_PATH, ["--version"], { timeout: CHECK_TIMEOUT_MS, encoding: "utf-8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  }).catch((error: unknown) => {
    throw new Error(
      `The terminal needs util-linux script(1) at ${INNER_PTY_RELAY_PATH} to give its sandboxed shell a terminal of its own `
        + `(package util-linux; bsdutils on Debian and Ubuntu): ${(error as Error).message.split("\n")[0]}`,
    );
  });
  if (!/\butil-linux\b/u.test(version)) {
    throw new Error(
      `The terminal needs util-linux script(1) at ${INNER_PTY_RELAY_PATH}; it reports ${JSON.stringify(version.split("\n")[0])}`,
    );
  }
  relayVerified = true;
}

/**
 * The command the sandbox runs for the terminal on Linux: `script` runs the
 * login shell launch (`launch`, an `env` launcher; sandboxTempEnvLaunch) on a
 * new pty. `-q` prints no start and end lines, `-e` exits with the shell's
 * status, and the typescript goes to `/dev/null`. `script` reads its command
 * through `$SHELL -c`, so `SHELL` is `/bin/sh` for `script` and the login
 * shell's own path again for the shell.
 */
export function innerPtyShellCommand(shell: string, launch: { readonly command: string; readonly args: readonly string[] }): string {
  const inner = `exec ${[launch.command, `SHELL=${shell}`, ...launch.args].map(shellQuote).join(" ")}`;
  const relay = ["/usr/bin/env", `SHELL=${RELAY_COMMAND_SHELL}`, INNER_PTY_RELAY_PATH, "-q", "-e", "-c", inner, "/dev/null"];
  return `exec ${relay.map(shellQuote).join(" ")}`;
}
