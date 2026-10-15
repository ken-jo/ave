// Type declarations for scripts/restore-node-pty-exec-bit.mjs (plain JS: it runs at postinstall).
/** Every spawn-helper under one node-pty package root. */
export function findSpawnHelpers(ptyRoot: string): string[];
/** Helpers under `ptyRoot` that the current user cannot execute. */
export function nonExecutableSpawnHelpers(ptyRoot: string): string[];
/** Add the execute bits to every helper; returns the helpers changed. */
export function restoreSpawnHelperExecBit(
  ptyRoot: string,
  options?: { platform?: NodeJS.Platform },
): string[];
