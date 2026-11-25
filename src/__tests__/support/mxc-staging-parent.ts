import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The staging parent of suites that lay out synthetic Windows paths and touch no disk. */
export const SYNTHETIC_MXC_STAGING_PARENT = "C:\\runtime\\staging";

let parent: string | undefined;

/**
 * A real, empty staging parent that belongs to the calling suite alone. A suite that counts staging entries mocks
 * `mxcStagingParent` with it: the runtime root's own staging parent is shared by every suite of a run.
 */
export function suiteMxcStagingParent(): string {
  parent ??= realpathSync.native(mkdtempSync(join(tmpdir(), "mxc-staging-")));
  return parent;
}

const host = process.platform;

/** The staging parent a suite mocks `mxcStagingParent` with: its own real one on a Windows host, the synthetic drive
 * path on another kernel, which no disk call reaches. The host is bound here: the returned function ignores the
 * platform production passes. */
export function mxcStagingParentFor(
  nativeHost: NodeJS.Platform = host,
  suiteParent: () => string = suiteMxcStagingParent,
): () => string {
  return nativeHost === "win32" ? () => suiteParent() : () => SYNTHETIC_MXC_STAGING_PARENT;
}
