/**
 * Whether the workspace terminal needs the own-tty handoff
 * (terminal-tty-handoff.ts). Its own module so pty-manager can decide without
 * loading the handoff, which is loaded on spawn and only where it is needed.
 */

/** macOS is the only platform whose profile filters terminal ioctls by path. */
export function terminalNeedsOwnTtyGrant(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}
