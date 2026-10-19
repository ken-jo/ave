import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Authenticated OSC 133 command markers for tests that feed a terminal block
 * tracker, as the shell integration emits them (main/terminal/shell-integration.ts).
 */

/** The marker nonce test trackers are built with. */
export const TERMINAL_TEST_NONCE = "0123456789abcdef0123456789abcdef";

/** The B-marker token test prompts announce in their P marker. */
const TERMINAL_TEST_PROMPT_TOKEN = "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf";

/**
 * One authenticated marker, as the shell emits it: `OSC 133 ; <fields> ;
 * <nonce> BEL`. A P marker also announces the prompt's B token, and B carries
 * that token instead of the nonce (the prompt string prints B).
 */
export function terminalMarker(fields: string): string {
  if (fields === "B") return `\u001b]133;B;${TERMINAL_TEST_PROMPT_TOKEN}\u0007`;
  let announced = fields;
  if (fields.startsWith("P;")) {
    // A shell that reports its line editor also says whether a not-found handler is defined.
    if (fields.includes(";Keys=") && !fields.includes(";NotFound=")) announced += ";NotFound=0";
    if (!fields.includes(";B=")) announced += `;B=${TERMINAL_TEST_PROMPT_TOKEN}`;
  }
  return `\u001b]133;${announced};${TERMINAL_TEST_NONCE}\u0007`;
}

/** A UTF-8 locale real-shell tests can give the shell: C.UTF-8 on Linux, en_US.UTF-8 on macOS (which has no C.UTF-8). */
export const TERMINAL_TEST_UTF8_LOCALE = process.platform === "linux" ? "C.UTF-8" : "en_US.UTF-8";

/** A bash with bracketed paste and PS0 (4.4 or later) on this machine, if any: real-shell tests run against it. */
export const TERMINAL_TEST_MODERN_BASH = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find((path) =>
  existsSync(path) && /version (?:4\.[4-9]|[5-9]\.)/u.test(spawnSync(path, ["--version"], { encoding: "utf-8" }).stdout));

/** zsh on this machine, if any. */
export const TERMINAL_TEST_ZSH = ["/bin/zsh", "/usr/bin/zsh"].find((path) => existsSync(path));

/** Poll until `condition` holds, as real-shell tests wait for a shell; throws at the timeout. */
export async function waitForTerminal(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(25);
  }
}

/**
 * A command-not-found handler as Ubuntu's /etc/bash.bashrc defines it for
 * bash (`command_not_found_handle`, calling /usr/lib/command-not-found), and
 * its zsh counterpart (`command_not_found_handler`), with `program` in place
 * of the system's helper. Prepended to a terminal's startup file, it stands
 * for the system file a login shell reads first, on any host.
 */
export function ubuntuLikeNotFoundHandler(shellName: string, program: string): string {
  const quoted = `'${program.replace(/'/gu, `'\\''`)}'`;
  const body = [
    `  if [ -x ${quoted} ]; then`,
    `    ${quoted} -- "$1"`,
    "    return $?",
    "  else",
    "    printf \"%s: command not found\\n\" \"$1\" >&2",
    "    return 127",
    "  fi",
  ];
  const name = shellName === "zsh" ? "command_not_found_handler" : "command_not_found_handle";
  return [`function ${name} {`, ...body, "}", ""].join("\n");
}
