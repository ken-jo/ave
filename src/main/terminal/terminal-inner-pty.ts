// Keep --new-session for input-injection isolation; run the shell under util-linux script on an inner PTY for signals and job control. Forward resize to
// the relay because the outer PTY signals the wrapper; refuse missing or incompatible script instead of using the broken outer PTY.
import { execFile } from "node:child_process";
import { shellQuote } from "../../lib/shell-resolver.js";

// util-linux `script(1)`, by absolute path: the sandbox mounts the host's `/usr` read-only.
const INNER_PTY_RELAY_PATH = "/usr/bin/script";

// The shell `script` runs its `-c` command with: fixed, so the user's `$SHELL` never parses it.
const RELAY_COMMAND_SHELL = "/bin/sh";

const CHECK_TIMEOUT_MS = 5_000;

let relayVerified = false;

// Check, once per app run, that {@link INNER_PTY_RELAY_PATH} is util-linux `script`. Throws the reason the terminal cannot start otherwise.
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

// Run the shell on an inner PTY with quiet exit-status-preserving script and no typescript file.
// script needs /bin/sh for its own -c launch, then restore SHELL to the login shell.
export function innerPtyShellCommand(shell: string, launch: { readonly command: string; readonly args: readonly string[] }): string {
  const inner = `exec ${[launch.command, `SHELL=${shell}`, ...launch.args].map(shellQuote).join(" ")}`;
  const relay = ["/usr/bin/env", `SHELL=${RELAY_COMMAND_SHELL}`, INNER_PTY_RELAY_PATH, "-q", "-e", "-c", inner, "/dev/null"];
  return `exec ${relay.map(shellQuote).join(" ")}`;
}
