/** Sweep only the host tombstone namespace at boot; report persistent failures through the audit sink. */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { TOMBSTONE_SUBDIR, removeOwnedPluginTree } from "./installed-entry-fs.js";
import { createLogger } from "../lib/logger.js";
import { assertNoConfinedProcessMayRun } from "../lib/confined-process-phase.js";

const log = createLogger("plugins/orphan-uninstall-sweeper");

export interface SweepResult {
  swept: string[];
  /** Failed tombstones may still have open external handles. */
  failed: Array<{ name: string; error: string }>;
}

export async function sweepOrphanUninstallDirs(
  pluginsRoot: string,
  options: {
    auditFailures?: (failures: SweepResult["failed"]) => void;
  } = {},
): Promise<SweepResult> {
  const tombstoneDir = join(pluginsRoot, TOMBSTONE_SUBDIR);

  let entries: string[];
  try {
    entries = await readdir(tombstoneDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { swept: [], failed: [] };
    }
    throw err;
  }

  if (entries.length === 0) return { swept: [], failed: [] };

  // Sweep independent tombstones concurrently.
  const results = await Promise.allSettled(
    entries.map(async (name) => {
      const path = join(tombstoneDir, name);
      // Remove nondirectory entries as entries, never follow links.
      const st = await lstat(path);
      if (!st.isDirectory() && !st.isSymbolicLink()) return null;
      // Delete recursively only at boot before confined processes can retain writable mounts.
      assertNoConfinedProcessMayRun(path);
      // Reclaim child-removed access and macOS immutable flags before retrying cleanup.
      await removeOwnedPluginTree(path);
      return name;
    }),
  );

  const result: SweepResult = { swept: [], failed: [] };
  results.forEach((r, idx) => {
    const name = entries[idx];
    if (r.status === "fulfilled") {
      if (r.value) {
        result.swept.push(r.value);
        log.debug(`swept tombstone: ${r.value}`);
      }
    } else {
      const msg = (r.reason as Error).message;
      result.failed.push({ name, error: msg });
      log.warn(`sweep failed for ${name}: ${msg}`);
    }
  });

  if (result.swept.length > 0) {
    log.info(`swept ${result.swept.length} orphan uninstall tombstone(s)`);
  }
  // Escalate persistent cleanup failures for operator diagnosis.
  if (result.failed.length > 0 && options.auditFailures) {
    try {
      options.auditFailures(result.failed);
    } catch (err) {
      log.warn(`auditFailures hook threw: ${(err as Error).message}`);
    }
  }
  return result;
}
