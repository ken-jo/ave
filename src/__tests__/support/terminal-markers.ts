import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

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
  const announced = fields.startsWith("P;") && !fields.includes(";B=") ? `${fields};B=${TERMINAL_TEST_PROMPT_TOKEN}` : fields;
  return `\u001b]133;${announced};${TERMINAL_TEST_NONCE}\u0007`;
}

/** A UTF-8 locale real-shell tests can give the shell: C.UTF-8 on Linux, en_US.UTF-8 on macOS (which has no C.UTF-8). */
export const TERMINAL_TEST_UTF8_LOCALE = process.platform === "linux" ? "C.UTF-8" : "en_US.UTF-8";

/** A bash with bracketed paste and PS0 (4.4 or later) on this machine, if any: real-shell tests run against it. */
export const TERMINAL_TEST_MODERN_BASH = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find((path) =>
  existsSync(path) && /version (?:4\.[4-9]|[5-9]\.)/u.test(spawnSync(path, ["--version"], { encoding: "utf-8" }).stdout));

/** zsh on this machine, if any. */
export const TERMINAL_TEST_ZSH = ["/bin/zsh", "/usr/bin/zsh"].find((path) => existsSync(path));
