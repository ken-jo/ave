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
