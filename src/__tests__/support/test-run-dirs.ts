/**
 * The per-run directories `vitest.globalSetup.ts` makes under
 * `~/.ave/test-tmp`: the run's Ave homes (`h-*`) and its sandbox base
 * (`sbx-*`).
 *
 * A run removes its own at teardown, and on a failed setup before returning.
 * One that was killed cannot, so each run also removes those a run left behind
 * long enough ago that no run still owns them. Age is the directory's
 * modification time, which a live run keeps moving: every test file adds its
 * home to the run's `h-*`, and every confined process its HOME under `sbx-*`.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Run directory names: `mkdtemp` adds six characters after the prefix. */
const RUN_DIR_RE = /^(?:h|sbx)-[A-Za-z0-9]{6}$/;

/** Older than any run: a whole suite takes minutes. */
export const STALE_RUN_DIR_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove the run directories in `testTmp` last modified more than `maxAgeMs`
 * before `now`. Only real directories with a run directory's name: a link is
 * never followed, and nothing else in `test-tmp` is touched. Returns what it
 * removed.
 */
export async function sweepStaleRunDirs(
  testTmp: string,
  remove: (path: string) => Promise<void>,
  now: number = Date.now(),
  maxAgeMs: number = STALE_RUN_DIR_AGE_MS,
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of readdirSync(testTmp)) {
    if (!RUN_DIR_RE.test(name)) continue;
    const path = join(testTmp, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      // Another run's teardown may remove it between the listing and here.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory() || now - stat.mtimeMs <= maxAgeMs) continue;
    try {
      await remove(path);
    } catch (error) {
      // Two runs starting together sweep the same leftovers.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    removed.push(path);
  }
  return removed;
}
