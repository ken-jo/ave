/** Revalidate cached artifacts against their digest; corrupt or unreadable entries are misses.
 * Cache failures never fail installation, and tree delivery uses git objects instead. */
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { mkdir, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { errorMessage } from "../../shared/error-message.js";
import { resolveEnvBackedBoolean } from "../../shared/env-backed-settings.js";

const KEPT_ARTIFACTS_MAX_BYTES = 500 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/u;

/** An explicit environment setting overrides the stored cache setting in either direction. */
export function resolveKeepArtifacts(settingEnabled: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnvBackedBoolean("marketplace.offlineCacheEnabled", settingEnabled, env);
}

export interface ArtifactCache {
  read(sha256: string): Promise<Buffer | null>;
  keep(sha256: string, zip: Buffer): Promise<void>;
}

export interface ArtifactCacheOptions {
  dir: string;
  /** Read at each use, so a changed setting applies to the next install. */
  enabled(): boolean;
  /** A kept file larger than this is not read (the ladder's download limit). */
  maxFileBytes: number;
  maxTotalBytes?: number;
  log: { warn(message: string): void };
  now?: () => Date;
}

export function createArtifactCache(options: ArtifactCacheOptions): ArtifactCache {
  const maxTotal = options.maxTotalBytes ?? KEPT_ARTIFACTS_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const pathOf = (sha256: string): string => {
    const digest = sha256.toLowerCase();
    if (!SHA256.test(digest)) throw new Error(`artifact cache key is not a sha256: ${sha256}`);
    return join(options.dir, `${digest}.zip`);
  };

  const evict = async (): Promise<void> => {
    const files: Array<{ path: string; size: number; used: number }> = [];
    for (const name of await readdir(options.dir)) {
      if (!name.endsWith(".zip")) continue;
      const path = join(options.dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) files.push({ path, size: info.size, used: info.mtimeMs });
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.used - b.used)) {
      if (total <= maxTotal) break;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  };

  return {
    async read(sha256) {
      // Invalid digest keys miss so the download rung reports the same bad-pin failure.
      if (!options.enabled() || !SHA256.test(sha256.toLowerCase())) return null;
      const path = pathOf(sha256);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > options.maxFileBytes) {
          await rm(path, { force: true });
          return null;
        }
        const zip = await readFile(path);
        if (sha256Hex(zip) !== sha256.toLowerCase()) {
          options.log.warn(`kept artifact ${sha256} no longer matches its digest; removed`);
          await rm(path, { force: true });
          return null;
        }
        const at = now();
        await utimes(path, at, at).catch(() => undefined);
        return zip;
      } catch (error) {
        if (!isMissingPathError(error)) options.log.warn(`kept artifact ${sha256} unreadable; downloading: ${errorMessage(error)}`);
        return null;
      }
    },
    async keep(sha256, zip) {
      if (!options.enabled()) return;
      const path = pathOf(sha256);
      if (sha256Hex(zip) !== sha256.toLowerCase()) throw new Error(`artifact ${sha256} kept with bytes of another digest`);
      try {
        await mkdir(options.dir, { recursive: true });
        await writeFileAtomicAtPath(path, zip);
        // Uses are ordered by one clock: the write's own mtime is the file system's.
        const at = now();
        await utimes(path, at, at);
        await evict();
      } catch (error) {
        options.log.warn(`could not keep artifact ${sha256}: ${errorMessage(error)}`);
      }
    },
  };
}

export async function clearKeptArtifacts(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export const NO_ARTIFACT_CACHE: ArtifactCache = {
  read: async () => null,
  keep: async () => undefined,
};
