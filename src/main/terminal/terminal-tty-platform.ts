/**
 * Which terminal set-up the workspace terminal needs on this platform. Its own
 * module so pty-manager can decide without loading the platform's module
 * (terminal-tty-handoff.ts, terminal-inner-pty.ts), which is loaded on spawn
 * and only where it is needed.
 */

/** macOS is the only platform whose profile filters terminal ioctls by path. */
export function terminalNeedsOwnTtyGrant(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/**
 * Linux starts the sandbox in a new session (bubblewrap `--new-session`), so
 * the shell needs a pty of its own inside the sandbox (terminal-inner-pty.ts).
 */
export function terminalNeedsInnerPty(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux";
}
