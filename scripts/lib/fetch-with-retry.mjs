// Download bytes for the postinstall fetchers (fetch-uv, fetch-mxc) with a small bounded retry.
// One gateway hiccup (HTTP 504 from the GitHub release CDN) used to fail the whole `bun install`.
// Retries hit the same URL only; callers verify the returned bytes against their pinned hashes.

const BACKOFF_MS = [1000, 3000];
export const DOWNLOAD_ATTEMPTS = BACKOFF_MS.length + 1;

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function isTransientNetworkError(error) {
  // undici reports connection failures as `TypeError: fetch failed` and mid-body drops as `TypeError: terminated`.
  // Other TypeErrors (e.g. `Invalid URL`) are deterministic and fail on the first attempt.
  if (error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated")) return true;
  for (let current = error; current && typeof current === "object"; current = current.cause) {
    if (TRANSIENT_NETWORK_CODES.has(current.code)) return true;
    if (typeof current.message === "string" && current.message.includes("socket hang up")) return true;
  }
  return false;
}

/**
 * Fetch `url` and return its body as a Buffer. HTTP 5xx, 429 and network errors are retried
 * up to DOWNLOAD_ATTEMPTS in total; any other non-OK status fails at once with `httpError(response)`.
 */
export async function fetchBytesWithRetry(url, { httpError, log = () => {}, fetchImpl = fetch, sleep = defaultSleep, env = process.env }) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const endpoint = new URL(url);
  const authenticated = token && endpoint.protocol === "https:"
    && (endpoint.hostname === "github.com" || endpoint.hostname === "api.github.com");
  for (let attempt = 1; ; attempt += 1) {
    let response;
    let failure;
    try {
      // Fetch strips Authorization when a redirect changes origin.
      response = authenticated
        ? await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } })
        : await fetchImpl(url);
      if (response.ok) return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (!isTransientNetworkError(error)) throw error;
      failure = error;
    }
    if (failure === undefined) {
      const message = httpError(response);
      if (!isTransientStatus(response.status)) throw new Error(message);
      failure = new Error(message);
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    if (attempt >= DOWNLOAD_ATTEMPTS) {
      throw new Error(`${message} (failed after ${DOWNLOAD_ATTEMPTS} attempts)`, { cause: failure });
    }
    const delay = BACKOFF_MS[attempt - 1];
    log(`attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed (${message}); retrying in ${delay / 1000}s`);
    await sleep(delay);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
