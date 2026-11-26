import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import { holdWindowsDirectory, type HeldWindowsDirectory } from "../shared/windows-path-facts.js";

export interface ShellWorkingDirectoryIdentity {
  readonly realpath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

// Capture the physical directory, refusing missing paths and inconsistent observations.
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
  return actual !== undefined && sameShellWorkingDirectoryIdentity(actual, expected);
}

export function sameShellWorkingDirectoryIdentity(actual: ShellWorkingDirectoryIdentity, expected: ShellWorkingDirectoryIdentity): boolean {
  return actual.realpath === expected.realpath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino;
}

/** Windows: hold the approved directory and its ancestors against rename and delete. The child still opens its cwd by path, so this proves nothing inside the child. */
export async function pinShellWorkingDirectory(identity: ShellWorkingDirectoryIdentity): Promise<HeldWindowsDirectory | undefined> {
  const held = await holdWindowsDirectory(identity.realpath);
  if (held === undefined) return undefined;
  const { facts } = held;
  if (!facts.directory || facts.volumeSerialNumber === null || facts.fileIndex === null ||
    BigInt(facts.volumeSerialNumber) !== identity.dev || BigInt(facts.fileIndex) !== identity.ino) {
    held.release();
    return undefined;
  }
  return held;
}

/** Keep the approved directory object alive until the invocation finishes its launch. */
export function holdShellWorkingDirectory(cwd: string, identity: ShellWorkingDirectoryIdentity): (() => void) | undefined {
  if (process.platform === "win32") {
    return matchesShellWorkingDirectoryIdentity(cwd, identity) ? () => {} : undefined;
  }
  let fd: number | undefined;
  try {
    fd = openSync(identity.realpath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (opened.isDirectory() && opened.dev === identity.dev && opened.ino === identity.ino &&
      matchesShellWorkingDirectoryIdentity(cwd, identity)) {
      const held = fd;
      fd = undefined;
      return () => closeSync(held);
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}
