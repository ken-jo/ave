/**
 * The refreshed model catalog's on-disk cache (design §7).
 *
 * `<aveHome>/cache/model-catalog/` holds each refreshed catalog as an
 * immutable `<sha256>.json` and one mutable pointer, `current.json`, naming
 * the copy in force with the ETag and the time the origin last confirmed it.
 * Every file is written temp → fsync → rename, so a crash leaves the old
 * pointer or the new one, never half of either.
 *
 * Reads never trust the disk: a copy is used only after
 * `verifyModelCatalogDocument` accepts it and its hash is the name the pointer
 * gives it. A pointer or copy that fails either check reads as a fault, which
 * the boot selection answers with the bundled snapshot.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPathError, writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { aveHome } from "../../shared/ave-home.js";
import type { ModelCatalogDocument } from "../../shared/model-catalog/types.js";
import { formatCatalogJson, verifyModelCatalogDocument } from "./document.js";

/** Where the cache lives; resolved per call so `AVE_HOME` isolation is honoured. */
export function modelCatalogCacheDir(): string {
  return join(aveHome(), "cache", "model-catalog");
}

const POINTER_FILE = "current.json";
const POINTER_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
/** Same layout as the bundled snapshot: one line per model record. */
const ENTRY_COMPACT_DEPTH = 4;

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The pointer, or why there is none usable. An absent pointer is `reason: "absent"`. */
export async function readModelCatalogPointer(dir: string): Promise<CacheRead<ModelCatalogCachePointer>> {
  let text: string;
  try {
    text = await readFile(join(dir, POINTER_FILE), "utf-8");
  } catch (error) {
    return { ok: false, reason: isMissingPathError(error) ? "absent" : `pointer unreadable: ${errorText(error)}` };
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
    text = await readFile(path, "utf-8");
  } catch (error) {
    return { ok: false, reason: `${path} unreadable: ${errorText(error)}` };
  }
  let document: ModelCatalogDocument;
  try {
    document = verifyModelCatalogDocument(JSON.parse(text));
  } catch (error) {
    return { ok: false, reason: `${path}: ${errorText(error)}` };
  }
  if (expectedSha256 !== undefined && document.sha256 !== expectedSha256) {
    return { ok: false, reason: `${path} holds catalog ${document.sha256}, not ${expectedSha256}` };
  }
  return { ok: true, value: document };
}

/** The cached copy `<sha256>.json`, verified against its name. */
export function readCachedModelCatalog(dir: string, sha256: string): Promise<CacheRead<ModelCatalogDocument>> {
  if (!SHA256.test(sha256)) return Promise.resolve({ ok: false, reason: `${sha256} is not a sha256` });
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

/**
 * Store a verified catalog under its name. An entry already stored under that
 * name and still verifying is kept, not rewritten: the name is the content, so
 * a second download of unchanged data is the same entry (design §3.2).
 */
export async function storeModelCatalog(dir: string, document: ModelCatalogDocument): Promise<void> {
  const existing = await readCachedModelCatalog(dir, document.sha256);
  if (existing.ok) return;
  writeUtf8FileAtomicSync(join(dir, `${document.sha256}.json`), formatCatalogJson(document, ENTRY_COMPACT_DEPTH));
}

export function writeModelCatalogPointer(dir: string, pointer: ModelCatalogCachePointer): void {
  writeUtf8FileAtomicSync(join(dir, POINTER_FILE), `${JSON.stringify(pointer, null, 2)}\n`);
}
