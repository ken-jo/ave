import { fetchPublicHttpResponse } from "../../core/network-guard.js";
import { BROWSER_FAVICON_LIMITS, isBrowserFaviconDataUrl } from "../../shared/browser-surface.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { prepareImageBytes } from "../../tools/image-preparation.js";

let activeLoads = 0;

/** Fetch public icon bytes on the host transport and decode them in the existing isolated worker. */
export async function loadBrowserFavicon(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string | null> {
  if (activeLoads >= BROWSER_FAVICON_LIMITS.concurrentLoads || url.length > BROWSER_FAVICON_LIMITS.sourceBytes * 2 || signal.aborted) return null;
  const request = new AbortController();
  const deadline = AbortSignal.any([signal, request.signal, AbortSignal.timeout(TOOL_TIMEOUT_POLICY.networkFetchDefaultMs)]);
  activeLoads++;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  try {
    let bytes: Buffer;
    if (url.startsWith("data:")) {
      const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
      if (!match) return null;
      bytes = Buffer.from(match[1]!, "base64");
      if (bytes.length > BROWSER_FAVICON_LIMITS.sourceBytes) return null;
    } else {
      if (url.length > 8192) return null;
      const response = await fetchPublicHttpResponse(url, { fetchImpl, signal: deadline, credentials: "omit", headers: { Accept: "image/png,image/jpeg,image/webp,image/gif,image/x-icon" } });
      if (!response.ok || !response.body) { await response.body?.cancel(); return null; }
      reader = response.body.getReader();
      deadline.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        deadline.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BROWSER_FAVICON_LIMITS.sourceBytes) return null;
        chunks.push(value);
      }
      bytes = Buffer.concat(chunks);
    }
    const prepared = await prepareImageBytes(bytes, {
      maxBytes: Math.floor((BROWSER_FAVICON_LIMITS.dataUrlBytes - "data:image/png;base64,".length) / 4) * 3,
      maxDimension: BROWSER_FAVICON_LIMITS.dimension,
    }, deadline);
    deadline.throwIfAborted();
    const result = `data:image/png;base64,${prepared.data}`;
    return isBrowserFaviconDataUrl(result) ? result : null;
  } catch { return null; }
  finally {
    deadline.removeEventListener("abort", cancel);
    request.abort();
    cancel();
    activeLoads--;
  }
}
