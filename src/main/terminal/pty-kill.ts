import type { IPty } from "node-pty";

// The Windows terminal backend rejects signals, including deferred calls before readiness.
export function killPty(
  pty: Pick<IPty, "kill">,
  signal?: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32" || signal === undefined) pty.kill();
  else pty.kill(signal);
}
