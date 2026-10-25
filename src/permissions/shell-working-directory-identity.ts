import { realpathSync, statSync } from "node:fs";

export interface ShellWorkingDirectoryIdentity {
  readonly realpath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Capture the physical directory, refusing missing paths and inconsistent observations. */
export function captureShellWorkingDirectoryIdentity(
  cwd: string,
): ShellWorkingDirectoryIdentity | undefined {
  try {
    const realpath = realpathSync.native(cwd);
    const physical = statSync(realpath, { bigint: true });
    const requested = statSync(cwd, { bigint: true });
    if (
      !physical.isDirectory() ||
      !requested.isDirectory() ||
      physical.dev !== requested.dev ||
      physical.ino !== requested.ino ||
      realpathSync.native(cwd) !== realpath
    ) return undefined;
    return Object.freeze({ realpath, dev: physical.dev, ino: physical.ino });
  } catch {
    return undefined;
  }
}

export function matchesShellWorkingDirectoryIdentity(
  cwd: string,
  expected: ShellWorkingDirectoryIdentity,
): boolean {
  const actual = captureShellWorkingDirectoryIdentity(cwd);
  return actual !== undefined &&
    actual.realpath === expected.realpath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino;
}
