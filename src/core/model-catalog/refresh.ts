/** Use one credential-free guarded GET with a streaming cap and no redirects. Refresh writes only next-boot cache; failures preserve usable data and share the request interval. */
import { createHash } from "node:crypto";
import { pruneModelsDevDocument, type CatalogDiagnostic } from "../../shared/model-catalog/normalize.js";
import { catalogProviderIds } from "../../shared/model-catalog/provider-map.js";
import type { ModelCatalogDocument } from "../../shared/model-catalog/types.js";
import { errorMessage } from "../../shared/error-message.js";
import { runWithAbortableDeadline } from "../../shared/abortable-deadline.js";
import { fetchPublicHttpResponse } from "../network-guard.js";
import { readCurrentModelCatalog } from "./cache.js";
import { verifyModelCatalogDocument } from "./document.js";
import { buildModelCatalogDocument } from "./document-builder.js";
import { MODEL_CATALOG_MAX_BYTES } from "./limits.js";
import { pruneModelCatalogCache, readModelCatalogCheck, storeModelCatalog, withModelCatalogCacheLock, writeModelCatalogCheck, writeModelCatalogPointer } from "./refresh-cache.js";

export { MODEL_CATALOG_MAX_BYTES } from "./limits.js";

export const MODEL_CATALOG_REFRESH_URL = "https://models.dev/api.json";
const MODEL_CATALOG_FETCH_TIMEOUT_MS = 15_000;
export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type ModelCatalogRefreshResult =
  | { status: "fresh"; sha256: string }
  | { status: "not-modified"; sha256: string }
  | { status: "updated"; sha256: string; diagnostics: CatalogDiagnostic[] }
  | { status: "throttled" }
  | { status: "failed"; reason: string };

export interface ModelCatalogRefreshOptions {
  /** Use the host single-hop transport; redirects must not widen source authority. */
  fetchImpl: typeof fetch;
  /** Injected cache directories must already exist. */
  dir: string;
  /** Reuse the reference license and require every reference provider to retain a model before replacement. */
  reference: ModelCatalogDocument;
  now?: () => Date;
  signal?: AbortSignal;
  force?: boolean;
  timeoutMs?: number;
}

class RefreshError extends Error {}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Enforce both declared and streamed size under one deadline; cancel on the first excess chunk. */
async function readCappedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MODEL_CATALOG_MAX_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new RefreshError(`response declares ${declared} bytes, over the ${MODEL_CATALOG_MAX_BYTES}-byte cap`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RefreshError("response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Request cleanup without awaiting it; cleanup itself may stall.
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
        throw new RefreshError(`response exceeds the ${MODEL_CATALOG_MAX_BYTES}-byte cap`);
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

function coverageFault(refreshed: ModelCatalogDocument, reference: ModelCatalogDocument): string | undefined {
  const missing = Object.keys(reference.providers)
    .filter((id) => Object.keys(refreshed.providers[id]?.models ?? {}).length === 0)
    .sort();
  return missing.length > 0 ? `refreshed catalog lists no models for ${missing.join(", ")}` : undefined;
}

/** Return refresh failures as results and preserve the last usable catalog. */
export async function refreshModelCatalogCache(options: ModelCatalogRefreshOptions): Promise<ModelCatalogRefreshResult> {
  try {
    return await withModelCatalogCacheLock(options.dir, () => refreshLockedModelCatalogCache(options));
  } catch (error) {
    return { status: "failed", reason: errorMessage(error) };
  }
}

async function refreshLockedModelCatalogCache(options: ModelCatalogRefreshOptions): Promise<ModelCatalogRefreshResult> {
  const now = options.now ?? (() => new Date());
  try {
    options.signal?.throwIfAborted();
    const current = await readCurrentModelCatalog(options.dir);
    // A damaged pointed copy is unusable; do not reuse its ETag.
    const pointer = current.ok ? current.value.pointer : undefined;
    const checkedAt = now();
    const withinInterval = (at: string): boolean => {
      const age = checkedAt.getTime() - Date.parse(at);
      return age >= 0 && age < MODEL_CATALOG_REFRESH_INTERVAL_MS;
    };
    if (pointer && !options.force && withinInterval(pointer.checkedAt)) {
      return { status: "fresh", sha256: pointer.sha256 };
    }
    const lastCheck = await readModelCatalogCheck(options.dir);
    if (lastCheck && !options.force && withinInterval(lastCheck)) return { status: "throttled" };
    // Persist attempt state before requesting so failure or exit still counts toward cadence.
    await writeModelCatalogCheck(options.dir, checkedAt.toISOString());

    const timeoutMs = options.timeoutMs ?? MODEL_CATALOG_FETCH_TIMEOUT_MS;
    const download = await runWithAbortableDeadline(async (signal) => {
      const response = await fetchPublicHttpResponse(MODEL_CATALOG_REFRESH_URL, {
        fetchImpl: options.fetchImpl,
        method: "GET",
        credentials: "omit",
        // The source grant covers one exact HTTPS URL, never redirects.
        maxRedirects: 0,
        headers: { accept: "application/json", ...(pointer?.etag ? { "if-none-match": pointer.etag } : {}) },
        timeoutMs,
        signal,
      });
      signal.throwIfAborted();
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 304 && pointer?.etag) return { response, raw: undefined };
        throw new RefreshError(`${MODEL_CATALOG_REFRESH_URL} answered ${response.status}`);
      }
      return { response, raw: await readCappedBody(response, signal) };
    }, {
      deadlineMs: timeoutMs,
      callerAbortSignal: options.signal,
      createDeadlineError: () => new RefreshError(`headers and body did not arrive within ${timeoutMs} ms`),
    });
    if (!download.ok) {
      throw new RefreshError(download.reason === "caller-abort" ? "aborted" : `request failed: ${errorMessage(download.error)}`);
    }
    const { response, raw } = download.value;
    if (!raw && pointer) {
      await writeModelCatalogPointer(options.dir, { ...pointer, checkedAt: isoSeconds(now()) });
      return { status: "not-modified", sha256: pointer.sha256 };
    }
    if (!raw) throw new RefreshError("response has no body");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf-8"));
    } catch {
      throw new RefreshError("response is not JSON");
    }
    let pruned: ReturnType<typeof pruneModelsDevDocument>;
    try {
      pruned = pruneModelsDevDocument(parsed, catalogProviderIds());
    } catch (error) {
      throw new RefreshError(errorMessage(error));
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
      throw new RefreshError(`refreshed catalog rejected: ${errorMessage(error)}`);
    }
    const coverage = coverageFault(document, options.reference);
    if (coverage) throw new RefreshError(coverage);

    await storeModelCatalog(options.dir, document);
    await pruneModelCatalogCache(options.dir, document.sha256, pointer?.sha256);
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
