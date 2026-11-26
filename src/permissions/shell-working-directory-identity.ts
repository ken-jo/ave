import { realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../shared/shell-analysis-limits.js";
import { inspectShellExecution, ShellExecutionError, type ShellExecutionFacts } from "../shared/shell-execution.js";
import { admitWindowsLookupPaths, observeWindowsShellDirectories, windowsObligationsApply } from "./admitted-obligation.js";

export interface ShellWorkingDirectoryIdentity {
  readonly realpath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

// Capture the physical directory, refusing missing paths and inconsistent observations.
export function captureShellWorkingDirectoryIdentity(
  cwd: string,
  batch?: ReturnType<typeof admitWindowsLookupPaths>,
): ShellWorkingDirectoryIdentity | undefined {
  try {
    if (windowsObligationsApply()) {
      const directory = (batch ?? admitWindowsLookupPaths([cwd], "pm-cwd-identity")).get(cwd);
      if (directory?.kind !== "dir" || !directory.followCapable || directory.identity === null) return undefined;
      return Object.freeze({
        realpath: directory.target,
        dev: BigInt(directory.identity.volumeSerial),
        ino: BigInt(directory.identity.fileId),
      });
    }
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

export function batchWindowsShellWorkingDirectories(command: string, cwd: string, facts: ShellExecutionFacts) {
  const paths = new Set([cwd]);
  try {
    inspectShellExecution(command, cwd, facts, {
      path() {},
      command() {},
      observeDirectory(original, destination) {
        if (!original.split(/[\\/]/u).includes("..")) {
          paths.add(win32.normalize(original));
          paths.add(win32.normalize(destination));
        }
        return "unknown";
      },
    }, MAX_SHELL_ANALYSIS_TOKENS);
  } catch (error) {
    if (!(error instanceof ShellExecutionError)) throw error;
  }
  const batch = admitWindowsLookupPaths([...paths], "shell-cwd");
  return {
    identity: captureShellWorkingDirectoryIdentity(cwd, batch),
    observeDirectory: (original: string, destination: string) => observeWindowsShellDirectories(original, destination, batch),
  };
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
