/** Cache publication coordination, kept apart from read-only boot access. */
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { withFileLock, withInProcessFileQueue } from "../../lib/with-file-lock.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { checkCacheDirectory, prepareModelCatalogCache, readRegularFile } from "./cache.js";
import { MODEL_CATALOG_CACHE_MAX_ENTRIES } from "./limits.js";

const LOCK_FILE = ".refresh-lock";
const MAX_LOCK_BYTES = 64 * 1024;

/** Called under the cache lock before publishing a new pointer. */
export async function pruneModelCatalogCache(dir: string, nextSha256: string, currentSha256?: string): Promise<void> {
  await checkCacheDirectory(dir);
  const entries: Array<{ name: string; modifiedAt: number }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
    const stat = await lstat(join(dir, entry.name));
    if (stat.isFile()) entries.push({ name: entry.name, modifiedAt: stat.mtimeMs });
  }
  entries.sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name));
  const keep = new Set([`${nextSha256}.json`, ...(currentSha256 ? [`${currentSha256}.json`] : [])]);
  for (const entry of entries) {
    if (keep.size < MODEL_CATALOG_CACHE_MAX_ENTRIES) keep.add(entry.name);
  }
  for (const entry of entries) {
    if (!keep.has(entry.name)) await unlink(join(dir, entry.name));
  }
}

/** Serialize the complete check and publication across processes sharing this cache. */
export async function withModelCatalogCacheLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  await prepareModelCatalogCache(dir);
  const path = join(dir, LOCK_FILE);
  return withInProcessFileQueue(path, async () => {
    try {
      await readRegularFile(path, MAX_LOCK_BYTES);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      await writeFileAtomicAtPath(path, "");
    }
    try {
      const lock = await lstat(`${path}.lock`);
      if (!lock.isDirectory() || lock.isSymbolicLink()) throw new Error("model catalog cache lock is not a regular directory");
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    return withFileLock(path, work);
  });
}
