/** Cache publication coordination, kept apart from read-only boot access. */
import { lstat, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { withFileLock, withInProcessFileQueue } from "../../lib/with-file-lock.js";
import { openFeatureNamespace, writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import type { ModelCatalogDocument } from "../../shared/model-catalog/types.js";
import { checkCacheDirectory, modelCatalogCacheDir, readCachedModelCatalog, readRegularFile, type ModelCatalogCachePointer } from "./cache.js";
import { verifyModelCatalogDocument } from "./document.js";
import { formatCatalogJson } from "./document-builder.js";
import { MODEL_CATALOG_CACHE_MAX_ENTRIES, MODEL_CATALOG_MAX_BYTES, MODEL_CATALOG_POINTER_MAX_BYTES } from "./limits.js";

const LOCK_FILE = ".refresh-lock";
const MAX_LOCK_BYTES = 64 * 1024;
const CHECK_FILE = ".refresh-check.json";
const POINTER_FILE = "current.json";
/** Same layout as the bundled snapshot: one line per model record. */
const ENTRY_COMPACT_DEPTH = 4;
const cacheNamespace = openFeatureNamespace("cache");

/** The namespace helper owns directory creation and private modes. */
async function prepareModelCatalogCache(dir: string): Promise<void> {
  await checkCacheDirectory(dir, true);
  if (resolve(dir) === modelCatalogCacheDir()) {
    await cacheNamespace.childDir(".");
    await cacheNamespace.childDir("model-catalog");
  }
  await checkCacheDirectory(dir);
}

/** Last attempted check, including failures; separate from successful confirmation. */
export async function readModelCatalogCheck(dir: string): Promise<string | undefined> {
  try {
    await checkCacheDirectory(dir);
    const value = JSON.parse(await readRegularFile(join(dir, CHECK_FILE), MODEL_CATALOG_POINTER_MAX_BYTES)) as { version?: unknown; checkedAt?: unknown } | null;
    if (value?.version === 1 && typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt))) return value.checkedAt;
  } catch {
    // Missing or damaged scheduling state must not replace a usable catalog.
  }
  return undefined;
}

export async function writeModelCatalogCheck(dir: string, checkedAt: string): Promise<void> {
  await prepareModelCatalogCache(dir);
  await writeFileAtomicAtPath(join(dir, CHECK_FILE), `${JSON.stringify({ version: 1, checkedAt })}\n`);
}

/** Publication must never create bytes the corresponding reader will refuse. */
async function writeCappedCacheFile(path: string, text: string, maxBytes: number): Promise<void> {
  if (Buffer.byteLength(text, "utf-8") > maxBytes) throw new Error(`model catalog file exceeds the ${maxBytes}-byte cap`);
  await writeFileAtomicAtPath(path, text);
}

/**
 * Store a verified catalog under its name. An entry already stored under that
 * name and still verifying is kept, not rewritten: the name is the content, so
 * a second download of unchanged data is the same entry (design §3.2).
 */
export async function storeModelCatalog(dir: string, document: ModelCatalogDocument): Promise<void> {
  await prepareModelCatalogCache(dir);
  verifyModelCatalogDocument(document);
  const existing = await readCachedModelCatalog(dir, document.sha256);
  if (existing.ok) return;
  await writeCappedCacheFile(join(dir, `${document.sha256}.json`), formatCatalogJson(document, ENTRY_COMPACT_DEPTH), MODEL_CATALOG_MAX_BYTES);
}

export async function writeModelCatalogPointer(dir: string, pointer: ModelCatalogCachePointer): Promise<void> {
  await prepareModelCatalogCache(dir);
  await writeCappedCacheFile(join(dir, POINTER_FILE), `${JSON.stringify(pointer, null, 2)}\n`, MODEL_CATALOG_POINTER_MAX_BYTES);
}

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
