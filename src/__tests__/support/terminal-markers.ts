/**
 * Authenticated OSC 133 command markers for tests that feed a terminal block
 * tracker, as the shell integration emits them (main/terminal/shell-integration.ts).
 */

/** The marker nonce test trackers are built with. */
export const TERMINAL_TEST_NONCE = "0123456789abcdef0123456789abcdef";

/** One authenticated marker: `OSC 133 ; <fields> ; <nonce> BEL`. */
export function terminalMarker(fields: string): string {
  return `\u001b]133;${fields};${TERMINAL_TEST_NONCE}\u0007`;
}
