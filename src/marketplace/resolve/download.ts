/**
 * Artifact downloads for the release and archive rungs (design §6.2, §7.4).
 *
 * Every request goes through the network gate, so policy, the address guard
 * and the redirect rule apply to each hop, and `Authorization` never follows
 * a redirect to another origin. The body is read into memory under a byte
 * ceiling and a stall timeout; the ladder hashes the bytes before anything
 * else reads them.
 */
import { MarketplaceError, isMarketplaceError } from "../errors.js";
import type { NetworkGate } from "../net/network-gate.js";
import { stallGuarded } from "../net/stall-guard.js";

export const DOWNLOAD_STALL_MS = 60_000;

export interface DownloadOptions {
  gate: NetworkGate;
  fetchImpl: typeof fetch;
  official: boolean;
  maxBytes: number;
  headers?: Record<string, string>;
  stallMs?: number;
  signal?: AbortSignal;
}

function statusError(url: string, status: number): MarketplaceError {
  const where = new URL(url).host;
  if (status === 401 || status === 403) {
    return new MarketplaceError("SOURCE_AUTH_REQUIRED", `${where} refused the download (HTTP ${status})`);
  }
  return new MarketplaceError("SOURCE_UNREACHABLE", `${where} answered HTTP ${status}`);
}

/** The gated response for `url`; a non-2xx status becomes the matching error code. */
export async function gatedGet(url: string, options: Omit<DownloadOptions, "maxBytes" | "stallMs">): Promise<Response> {
  const response = await options.gate.fetch(url, {
    fetchImpl: options.fetchImpl,
    official: options.official,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw statusError(url, response.status);
  }
  return response;
}

/** The whole body of `url`, at most `maxBytes`. */
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
    for await (const chunk of stallGuarded(response.body, stallMs, () => new MarketplaceError("SOURCE_UNREACHABLE", `download stalled: no data for ${stallMs} ms`))) {
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
