/**
 * The model catalog refresh (issue #2501 slice 6, design §7).
 *
 * One plain GET of `https://models.dev/api.json` — no cookie, no credential,
 * nothing about the user or the conversation — through the host's guarded
 * public-HTTP path (`fetchPublicHttpResponse`: redirects refused,
 * private and loopback addresses refused) on the host's own transport. No
 * plugin path is involved. The download is capped at 16 MB while it streams,
 * pruned and normalized by the same code that builds the bundled snapshot,
 * verified, and stored in the cache (`cache.ts`).
 *
 * A refresh only WRITES the cache. The catalog a process resolves against is
 * chosen once, at boot (`bundled.ts`), so a refreshed copy takes effect at the
 * next launch and one run never sees two catalogs. Any failure — network,
 * status, size, JSON, verification, coverage — leaves the cache exactly as it
 * was: the last good copy, or none and therefore the bundled snapshot.
 *
 * Cadence: at most one request per {@link MODEL_CATALOG_REFRESH_INTERVAL_MS}.
 * models.dev is a static document rebuilt when its TOML sources change, a
 * handful of times a week; a day keeps a new model's window at most a day
 * behind while a conditional request (ETag) makes most checks a 304 with no
 * body. A launch inside that day sends nothing.
 */
import { createHash } from "node:crypto";
import { pruneModelsDevDocument, type CatalogDiagnostic } from "../../shared/model-catalog/normalize.js";
import { catalogProviderIds } from "../../shared/model-catalog/provider-map.js";
import type { ModelCatalogDocument } from "../../shared/model-catalog/types.js";
import { errorMessage } from "../../shared/error-message.js";
import { runWithAbortableDeadline } from "../../shared/abortable-deadline.js";
import { fetchPublicHttpResponse } from "../network-guard.js";
import {
  readCurrentModelCatalog,
  storeModelCatalog,
  writeModelCatalogPointer,
} from "./cache.js";
import { buildModelCatalogDocument, verifyModelCatalogDocument } from "./document.js";
import { MODEL_CATALOG_MAX_BYTES } from "./limits.js";

export { MODEL_CATALOG_MAX_BYTES } from "./limits.js";

export const MODEL_CATALOG_REFRESH_URL = "https://models.dev/api.json";
/** Headers and body together must arrive within this (design §7). */
const MODEL_CATALOG_FETCH_TIMEOUT_MS = 15_000;
/** One request a day at most; see the module comment for why. */
export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type ModelCatalogRefreshResult =
  | { status: "fresh"; sha256: string }
  | { status: "not-modified"; sha256: string }
  | { status: "updated"; sha256: string; diagnostics: CatalogDiagnostic[] }
  | { status: "failed"; reason: string };

export interface ModelCatalogRefreshOptions {
  /** The host's single-hop transport; redirects cannot widen the fixed source. */
  fetchImpl: typeof fetch;
  /** The cache directory (`modelCatalogCacheDir()` in the app). */
  dir: string;
  /**
   * The catalog in force (the bundled snapshot or a verified cached copy):
   * its license is the one a refreshed copy carries — the same MIT text, so
   * the refresh fetches nothing but the data — and every catalog provider it
   * lists must still list a model in a refreshed copy, so a source that
   * changed shape cannot replace a working catalog with an empty one.
   */
  reference: ModelCatalogDocument;
  now?: () => Date;
  signal?: AbortSignal;
  /** Bypass the interval: a stale or missing copy is always refreshed, a fresh one only when this is set. */
  force?: boolean;
  /** Headers and body together; {@link MODEL_CATALOG_FETCH_TIMEOUT_MS} unless a test shortens it. */
  timeoutMs?: number;
}

class RefreshFault extends Error {}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The body, read under the cap and the deadline. A declared length over the
 * cap is refused before reading; a body that grows past it is cancelled at the
 * chunk that crosses it, so the cap bounds memory, not just the result.
 */
async function readCappedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MODEL_CATALOG_MAX_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new RefreshFault(`response declares ${declared} bytes, over the ${MODEL_CATALOG_MAX_BYTES}-byte cap`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RefreshFault("response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Cleanup may itself stall. Request it without making it part of the deadline.
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let completed = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MODEL_CATALOG_MAX_BYTES) {
        throw new RefreshFault(`response exceeds the ${MODEL_CATALOG_MAX_BYTES}-byte cap`);
      }
      chunks.push(next.value);
    }
    completed = true;
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!completed) cancel();
    reader.releaseLock();
  }
}

/** Every catalog provider the reference lists must still list a model. */
function coverageFault(refreshed: ModelCatalogDocument, reference: ModelCatalogDocument): string | undefined {
  const missing = Object.keys(reference.providers)
    .filter((id) => Object.keys(refreshed.providers[id]?.models ?? {}).length === 0)
    .sort();
  return missing.length > 0 ? `refreshed catalog lists no models for ${missing.join(", ")}` : undefined;
}

/**
 * Bring the cache up to date: nothing when the copy in force was confirmed
 * within the interval, a conditional request otherwise. Never throws; a
 * failure is a result, and the cache is left as it was.
 */
export async function refreshModelCatalogCache(options: ModelCatalogRefreshOptions): Promise<ModelCatalogRefreshResult> {
  const now = options.now ?? (() => new Date());
  try {
    const current = await readCurrentModelCatalog(options.dir);
    // A pointer whose copy is damaged is not "in force": refresh without its ETag.
    const pointer = current.ok ? current.value.pointer : undefined;
    if (pointer && !options.force && now().getTime() - Date.parse(pointer.checkedAt) < MODEL_CATALOG_REFRESH_INTERVAL_MS) {
      return { status: "fresh", sha256: pointer.sha256 };
    }

    const timeoutMs = options.timeoutMs ?? MODEL_CATALOG_FETCH_TIMEOUT_MS;
    const download = await runWithAbortableDeadline(async (signal) => {
      const response = await fetchPublicHttpResponse(MODEL_CATALOG_REFRESH_URL, {
        fetchImpl: options.fetchImpl,
        method: "GET",
        credentials: "omit",
        // This source is one exact HTTPS URL; a redirect is not another source grant.
        maxRedirects: 0,
        headers: { accept: "application/json", ...(pointer?.etag ? { "if-none-match": pointer.etag } : {}) },
        timeoutMs,
        signal,
      });
      signal.throwIfAborted();
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 304 && pointer) return { response, raw: undefined };
        throw new RefreshFault(`${MODEL_CATALOG_REFRESH_URL} answered ${response.status}`);
      }
      return { response, raw: await readCappedBody(response, signal) };
    }, {
      deadlineMs: timeoutMs,
      callerAbortSignal: options.signal,
      createDeadlineError: () => new RefreshFault(`headers and body did not arrive within ${timeoutMs} ms`),
    });
    if (!download.ok) {
      throw new RefreshFault(download.reason === "caller-abort" ? "aborted" : `request failed: ${errorMessage(download.error)}`);
    }
    const { response, raw } = download.value;
    if (!raw && pointer) {
      await writeModelCatalogPointer(options.dir, { ...pointer, checkedAt: isoSeconds(now()) });
      return { status: "not-modified", sha256: pointer.sha256 };
    }
    if (!raw) throw new RefreshFault("response has no body");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf-8"));
    } catch {
      throw new RefreshFault("response is not JSON");
    }
    let pruned: ReturnType<typeof pruneModelsDevDocument>;
    try {
      pruned = pruneModelsDevDocument(parsed, catalogProviderIds());
    } catch (error) {
      throw new RefreshFault(errorMessage(error));
    }
    const etag = response.headers.get("etag") ?? undefined;
    const fetchedAt = isoSeconds(now());
    const { document: built, diagnostics } = buildModelCatalogDocument({
      input: pruned,
      providerIds: catalogProviderIds(),
      source: {
        url: MODEL_CATALOG_REFRESH_URL,
        fetchedAt,
        ...(etag ? { etag } : {}),
        rawSha256: createHash("sha256").update(raw).digest("hex"),
      },
      license: options.reference.license,
    });
    let document: ModelCatalogDocument;
    try {
      document = verifyModelCatalogDocument(built);
    } catch (error) {
      throw new RefreshFault(`refreshed catalog rejected: ${errorMessage(error)}`);
    }
    const coverage = coverageFault(document, options.reference);
    if (coverage) throw new RefreshFault(coverage);

    await storeModelCatalog(options.dir, document);
    await writeModelCatalogPointer(options.dir, {
      version: 1,
      sha256: document.sha256,
      ...(etag ? { etag } : {}),
      checkedAt: fetchedAt,
    });
    return { status: "updated", sha256: document.sha256, diagnostics };
  } catch (error) {
    return { status: "failed", reason: errorMessage(error) };
  }
}
