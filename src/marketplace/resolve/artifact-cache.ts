/**
 * Kept plugin artifacts (design §7.5, §16.2: `offlineCacheEnabled` means
 * "keep downloaded artifacts").
 *
 * A release or archive zip is pinned by its sha256 in git, so the pin names
 * the bytes: a kept zip is stored under its digest and read back only when it
 * still hashes to it. A reinstall of a version already fetched — Doctor's
 * repair, a switch back, an install while the host is offline — then needs no
 * download. The tree rung is not kept: it is built from git objects the
 * snapshot already holds.
 *
 * The cache is an optimization at a filesystem boundary. A file that cannot
 * be read or written is a miss, never an install failure; a file that does
 * not hash to its name is deleted and missed.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { errorMessage } from "../../shared/error-message.js";
import { resolveEnvBackedBoolean } from "../../shared/env-backed-settings.js";

/** The oldest-used zips go first once the kept total passes this. */
const KEPT_ARTIFACTS_MAX_BYTES = 500 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * `marketplace.offlineCacheEnabled` combined with `AVE_MARKETPLACE_USE_CACHE`:
 * the environment decides in both directions when set, the setting when not,
 * and unset means keep.
 */
export function resolveKeepArtifacts(settingEnabled: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnvBackedBoolean("marketplace.offlineCacheEnabled", settingEnabled, env);
}

export interface ArtifactCache {
  /** The kept zip for this digest, or `null` when keeping is off or none is kept. */
  read(sha256: string): Promise<Buffer | null>;
  /** Keep a zip that hashed to `sha256`; nothing when keeping is off. */
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

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createArtifactCache(options: ArtifactCacheOptions): ArtifactCache {
  const maxTotal = options.maxTotalBytes ?? KEPT_ARTIFACTS_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const pathOf = (sha256: string): string => {
    const digest = sha256.toLowerCase();
    if (!SHA256.test(digest)) throw new Error(`artifact cache key is not a sha256: ${sha256}`);
    return join(options.dir, `${digest}.zip`);
  };

  /** Drop the least recently used zips until the rest fit. */
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
      if (!options.enabled()) return null;
      const path = pathOf(sha256);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > options.maxFileBytes) {
          await rm(path, { force: true });
          return null;
        }
        const zip = await readFile(path);
        if (digestOf(zip) !== sha256.toLowerCase()) {
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
      if (digestOf(zip) !== sha256.toLowerCase()) throw new Error(`artifact ${sha256} kept with bytes of another digest`);
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

/** Keeping off: every read misses and nothing is written. */
export const NO_ARTIFACT_CACHE: ArtifactCache = {
  read: async () => null,
  keep: async () => undefined,
};
