/**
 * The model catalog refresh (issue #2501 slice 6, design §7).
 *
 * One plain GET of `https://models.dev/api.json` — no cookie, no credential,
 * nothing about the user or the conversation — through the host's guarded
 * public-HTTP path (`fetchPublicHttpResponse`: each redirect hop re-checked,
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
import { fetchPublicHttpResponse } from "../network-guard.js";
import {
  readCurrentModelCatalog,
  storeModelCatalog,
  writeModelCatalogPointer,
} from "./cache.js";
import { buildModelCatalogDocument, verifyModelCatalogDocument } from "./document.js";

export const MODEL_CATALOG_REFRESH_URL = "https://models.dev/api.json";
/** The download cap (design §7). The full document is about 2 MB today. */
export const MODEL_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
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
  /** The host's single-hop transport; `fetchPublicHttpResponse` follows and checks each hop. */
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
async function readCappedBody(response: Response, deadline: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MODEL_CATALOG_MAX_BYTES) {
    throw new RefreshFault(`response declares ${declared} bytes, over the ${MODEL_CATALOG_MAX_BYTES}-byte cap`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RefreshFault("response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Shutdown aborts the read too, not only the request: a quit mid-download
  // must not wait out the deadline.
  const aborted = signal
    ? new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    })
    : new Promise<never>(() => {});
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await reader.cancel().catch(() => undefined);
      throw new RefreshFault(`body did not arrive within ${timeoutMs} ms`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), remaining);
    });
    const next = await Promise.race([reader.read(), timedOut, aborted]).finally(() => clearTimeout(timer));
    if (next === "aborted") {
      await reader.cancel().catch(() => undefined);
      throw new RefreshFault("aborted");
    }
    if (next === "timeout") {
      await reader.cancel().catch(() => undefined);
      throw new RefreshFault(`body did not arrive within ${timeoutMs} ms`);
    }
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MODEL_CATALOG_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RefreshFault(`response exceeds the ${MODEL_CATALOG_MAX_BYTES}-byte cap`);
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
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
    const deadline = Date.now() + timeoutMs;
    let response: Response;
    try {
      response = await fetchPublicHttpResponse(MODEL_CATALOG_REFRESH_URL, {
        fetchImpl: options.fetchImpl,
        method: "GET",
        headers: { accept: "application/json", ...(pointer?.etag ? { "if-none-match": pointer.etag } : {}) },
        // `timeoutMs` is per hop; the signal bounds a redirect chain as a whole,
        // and the body read below keeps the same deadline.
        timeoutMs,
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]),
      });
    } catch (error) {
      throw new RefreshFault(`request failed: ${errorMessage(error)}`);
    }

    if (response.status === 304 && pointer) {
      await response.body?.cancel().catch(() => undefined);
      writeModelCatalogPointer(options.dir, { ...pointer, checkedAt: isoSeconds(now()) });
      return { status: "not-modified", sha256: pointer.sha256 };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new RefreshFault(`${MODEL_CATALOG_REFRESH_URL} answered ${response.status}`);
    }

    const raw = await readCappedBody(response, deadline, timeoutMs, options.signal);
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
    writeModelCatalogPointer(options.dir, {
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
