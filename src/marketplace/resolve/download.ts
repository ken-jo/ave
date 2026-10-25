/** Gate and pin every download hop; strip cross-origin credentials and bound body size and stalls. */
import { MarketplaceError, isMarketplaceError } from "../errors.js";
import type { CatalogSource, NetworkGate } from "../net/network-gate.js";
import { stallGuarded } from "../net/stall-guard.js";

const DOWNLOAD_STALL_MS = 60_000;

export interface DownloadOptions {
  gate: NetworkGate;
  catalog: CatalogSource;
  official: boolean;
  maxBytes: number;
  headers?: Record<string, string>;
  stallMs?: number;
  signal?: AbortSignal;
  /** Token-authenticated sources without a stored token may receive a concealed-private 404. */
  tokenMissing?: boolean;
  onHop?: (hop: string) => void;
}

function statusError(url: string, status: number, tokenMissing: boolean): MarketplaceError {
  const where = new URL(url).host;
  if (status === 401 || status === 403) {
    // No host in the detail: the token belongs to the source's host, which a download host (a CDN, the API) need not be.
    return new MarketplaceError("SOURCE_AUTH_REQUIRED", `${where} refused the download (HTTP ${status})`);
  }
  if (status === 404 && tokenMissing) {
    return new MarketplaceError("SOURCE_AUTH_REQUIRED", `${where} answered HTTP 404 and no token is stored for this source's host`);
  }
  return new MarketplaceError("SOURCE_UNREACHABLE", `${where} answered HTTP ${status}`, { detail: { reason: "http-status", host: where, status } });
}

/** Map non-success HTTP status to a marketplace error. */
async function gatedGet(url: string, options: Omit<DownloadOptions, "maxBytes" | "stallMs">): Promise<Response> {
  const response = await options.gate.fetch(url, {
    catalog: options.catalog,
    official: options.official,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onHop ? { onHop: options.onHop } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw statusError(url, response.status, options.tokenMissing === true);
  }
  return response;
}

export async function downloadBounded(url: string, options: DownloadOptions): Promise<Buffer> {
  const response = await gatedGet(url, options);
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${new URL(url).host}: the artifact is ${declared} bytes, over ${options.maxBytes}`);
  }
  if (!response.body) return Buffer.alloc(0);
  const stallMs = options.stallMs ?? DOWNLOAD_STALL_MS;
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    const stalled = () => new MarketplaceError("SOURCE_UNREACHABLE", `download stalled: no data for ${stallMs} ms`, { detail: { reason: "timeout", host: new URL(url).host } });
    for await (const chunk of stallGuarded(response.body, stallMs, stalled)) {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${new URL(url).host}: the artifact is over ${options.maxBytes} bytes`);
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (isMarketplaceError(error)) throw error;
    throw new MarketplaceError("SOURCE_UNREACHABLE", `download interrupted after ${bytes} bytes: ${(error as Error).message}`, { cause: error });
  }
  return Buffer.concat(chunks, bytes);
}
