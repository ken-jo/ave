/**
 * Read-only access to the refreshed model catalog's on-disk cache (design §7).
 *
 * `<aveHome>/cache/model-catalog/` holds each refreshed catalog as an
 * immutable `<sha256>.json` and one mutable pointer, `current.json`, naming
 * the copy in force with the ETag and the time the origin last confirmed it.
 * Publication and attempt-state writes live in `refresh-cache.ts`; reads do
 * not create directories or load those writer helpers.
 *
 * Reads never trust the disk: a copy is used only after
 * `verifyModelCatalogDocument` accepts it and its hash is the name the pointer
 * gives it. A pointer or copy that fails either check reads as a fault, which
 * the boot selection answers with the bundled snapshot.
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { errorMessage } from "../../shared/error-message.js";
import { aveHome } from "../../shared/ave-home.js";
import type { ModelCatalogDocument } from "../../shared/model-catalog/types.js";
import { verifyModelCatalogDocument } from "./document.js";
import { MODEL_CATALOG_MAX_BYTES, MODEL_CATALOG_POINTER_MAX_BYTES } from "./limits.js";

/** Where the cache lives; resolved per call so `AVE_HOME` isolation is honoured. */
export function modelCatalogCacheDir(): string {
  return join(aveHome(), "cache", "model-catalog");
}

const POINTER_FILE = "current.json";
const POINTER_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
export { MODEL_CATALOG_CACHE_MAX_ENTRIES } from "./limits.js";

/** Cache-owned directories must be directories, never links into another tree. */
export async function checkCacheDirectory(dir: string, allowAbsent = false): Promise<void> {
  for (const path of [dirname(resolve(dir)), resolve(dir)]) {
    try {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("model catalog cache directory is not a regular directory");
    } catch (error) {
      if (allowAbsent && isMissingPathError(error)) continue;
      throw error;
    }
  }
}

/** Read one regular inode, capped even if its size changes during the read. */
export async function readRegularFile(path: string, maxBytes: number): Promise<string> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("model catalog file is not a regular file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error("model catalog file changed while opening");
    if (opened.size > maxBytes) throw new Error(`model catalog file exceeds the ${maxBytes}-byte cap`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`model catalog file exceeds the ${maxBytes}-byte cap`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString("utf-8");
  } finally {
    await handle.close();
  }
}

/** `current.json`: which cached copy is in force, and when the origin last confirmed it. */
export interface ModelCatalogCachePointer {
  version: typeof POINTER_VERSION;
  sha256: string;
  /** The ETag the origin sent with that copy, for the next conditional request. */
  etag?: string;
  /** When the origin last answered with this copy (200) or confirmed it (304); ISO-8601. */
  checkedAt: string;
}

export type CacheRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The pointer, or why there is none usable. An absent pointer is `reason: "absent"`. */
export async function readModelCatalogPointer(dir: string): Promise<CacheRead<ModelCatalogCachePointer>> {
  let text: string;
  try {
    await checkCacheDirectory(dir);
    text = await readRegularFile(join(dir, POINTER_FILE), MODEL_CATALOG_POINTER_MAX_BYTES);
  } catch (error) {
    return { ok: false, reason: isMissingPathError(error) ? "absent" : `pointer unreadable: ${errorMessage(error)}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "pointer is not JSON" };
  }
  const pointer = value as Partial<ModelCatalogCachePointer> | null;
  if (
    pointer === null || typeof pointer !== "object"
    || pointer.version !== POINTER_VERSION
    || typeof pointer.sha256 !== "string" || !SHA256.test(pointer.sha256)
    || (pointer.etag !== undefined && typeof pointer.etag !== "string")
    || typeof pointer.checkedAt !== "string" || Number.isNaN(Date.parse(pointer.checkedAt))
  ) {
    return { ok: false, reason: "pointer is malformed" };
  }
  return {
    ok: true,
    value: {
      version: POINTER_VERSION,
      sha256: pointer.sha256,
      ...(pointer.etag !== undefined ? { etag: pointer.etag } : {}),
      checkedAt: pointer.checkedAt,
    },
  };
}

/** A catalog file, verified, or why it cannot be used. `expectedSha256` is the name it must hash to. */
export async function readModelCatalogFile(path: string, expectedSha256?: string): Promise<CacheRead<ModelCatalogDocument>> {
  let text: string;
  try {
    text = await readRegularFile(path, MODEL_CATALOG_MAX_BYTES);
  } catch (error) {
    return { ok: false, reason: `${path} unreadable: ${errorMessage(error)}` };
  }
  let document: ModelCatalogDocument;
  try {
    document = verifyModelCatalogDocument(JSON.parse(text));
  } catch (error) {
    return { ok: false, reason: `${path}: ${errorMessage(error)}` };
  }
  if (expectedSha256 !== undefined && document.sha256 !== expectedSha256) {
    return { ok: false, reason: `${path} holds catalog ${document.sha256}, not ${expectedSha256}` };
  }
  return { ok: true, value: document };
}

/** The cached copy `<sha256>.json`, verified against its name. */
export async function readCachedModelCatalog(dir: string, sha256: string): Promise<CacheRead<ModelCatalogDocument>> {
  if (!SHA256.test(sha256)) return { ok: false, reason: `${sha256} is not a sha256` };
  try {
    await checkCacheDirectory(dir);
  } catch (error) {
    return { ok: false, reason: `cache directory unusable: ${errorMessage(error)}` };
  }
  return readModelCatalogFile(join(dir, `${sha256}.json`), sha256);
}

/** The copy the pointer names, verified; any fault in either reads as `ok: false`. */
export async function readCurrentModelCatalog(dir: string): Promise<CacheRead<{ pointer: ModelCatalogCachePointer; document: ModelCatalogDocument }>> {
  const pointer = await readModelCatalogPointer(dir);
  if (!pointer.ok) return pointer;
  const document = await readCachedModelCatalog(dir, pointer.value.sha256);
  if (!document.ok) return document;
  return { ok: true, value: { pointer: pointer.value, document: document.value } };
}
