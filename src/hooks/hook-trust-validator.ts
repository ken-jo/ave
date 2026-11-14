import { discoverHookTrustFiles } from "./hook-config-trust.js";
import { readLockfile } from "./hook-discovery.js";

/** Recheck the reviewed definition after approval waits and immediately before execution. */
export function createHookTrustValidator(options: {
  hooksDir: string; fileName: string; expectedSha256: string; lockfilePath: string; sourceId?: string; projectRoot?: string;
}): () => boolean {
  return () => {
    try {
      const lockfile = readLockfile(options.lockfilePath);
      if (options.projectRoot && !lockfile?.trustedProjects?.includes(options.projectRoot)) return false;
      if (!lockfile?.hooks.some((entry) => entry.sourceId === options.sourceId
        && entry.fileName === options.fileName && entry.sha256 === options.expectedSha256)) return false;
      return discoverHookTrustFiles(options.hooksDir).hooks.some((hook) =>
        hook.fileName === options.fileName && hook.sha256 === options.expectedSha256);
    } catch { return false; }
  };
}
