// Keep platform selection separate so spawn loads only the needed PTY implementation.

// macOS is the only platform whose profile filters terminal ioctls by path.
export function terminalNeedsOwnTtyGrant(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

// Linux starts the sandbox in a new session (bubblewrap `--new-session`), so the shell needs a pty of its own inside the sandbox (terminal-inner-pty.ts).
export function terminalNeedsInnerPty(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux";
}
