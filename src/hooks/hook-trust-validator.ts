import { discoverHookTrustFiles, HOOKS_CONFIG_FILENAME } from "./hook-config-trust.js";
import { readLockfile } from "./hook-discovery.js";
import { disableHook } from "./hook-discovery.js";
import { join } from "node:path";

/** Recheck the reviewed definition after approval waits and immediately before execution. */
export function createHookTrustValidator(options: {
  hooksDir: string; disabledDir?: string; fileName: string; expectedSha256: string; lockfilePath: string; sourceId?: string; projectRoot?: string;
}): () => boolean {
  return () => {
    try {
      const lockfile = readLockfile(options.lockfilePath);
      if (options.projectRoot && !lockfile?.trustedProjects?.includes(options.projectRoot)) return false;
      if (!lockfile?.hooks.some((entry) => entry.sourceId === options.sourceId
        && entry.fileName === options.fileName && entry.sha256 === options.expectedSha256)) return false;
      const discovered = discoverHookTrustFiles(options.hooksDir);
      const current = discovered.hooks.find((hook) => hook.fileName === options.fileName);
      if (!current) return false;
      if (current.sha256 !== options.expectedSha256
        || options.fileName === HOOKS_CONFIG_FILENAME && discovered.config.errors.length > 0) {
        try { disableHook(current, options.disabledDir ?? join(options.hooksDir, ".disabled"), "system-quarantine"); }
        catch { /* A refused quarantine still denies execution. */ }
        return false;
      }
      return true;
    } catch { return false; }
  };
}
