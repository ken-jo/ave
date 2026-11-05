import { describe, expect, it } from "vitest";

import { DOWNLOAD_ATTEMPTS, fetchBytesWithRetry } from "../../scripts/lib/fetch-with-retry.mjs";

const URL = "https://github.com/astral-sh/uv/releases/download/0.7.3/uv-aarch64-unknown-linux-gnu.tar.gz";

const STATUS_TEXT: Record<number, string> = { 200: "OK", 404: "Not Found", 503: "Service Unavailable", 504: "Gateway Time-out" };

function respond(status: number, body = ""): Response {
  return new Response(status === 200 ? body : null, { status, statusText: STATUS_TEXT[status] });
}

function harness(outcomes: Array<Response | Error>) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url);
    const next = outcomes.shift();
    if (next === undefined) throw new Error("test: unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  };
  const options = {
    httpError: (response: Response) => `HTTP ${response.status} ${response.statusText} — ${URL}`,
    fetchImpl,
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
  return { calls, sleeps, options };
}

describe("postinstall downloads survive one transient gateway failure without loosening anything else", () => {
  it("retries a 504 and returns the bytes of the following 200 from the same URL", async () => {
    const { calls, sleeps, options } = harness([respond(504), respond(200, "archive-bytes")]);
    const bytes = await fetchBytesWithRetry(URL, options);
    expect(bytes.toString("utf8")).toBe("archive-bytes");
    expect(calls).toEqual([URL, URL]);
    expect(sleeps).toEqual([1000]);
  });

  it("retries a network TypeError carrying ECONNRESET", async () => {
    const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    const { calls, options } = harness([reset, respond(200, "ok")]);
    await expect(fetchBytesWithRetry(URL, options)).resolves.toEqual(Buffer.from("ok"));
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 404", async () => {
    const { calls, sleeps, options } = harness([respond(404), respond(200, "never")]);
    await expect(fetchBytesWithRetry(URL, options)).rejects.toThrow(`HTTP 404 Not Found — ${URL}`);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("fails after three 503s with the original message and the attempt count", async () => {
    const { calls, sleeps, options } = harness([respond(503), respond(503), respond(503)]);
    const failure = fetchBytesWithRetry(URL, options);
    await expect(failure).rejects.toThrow(`HTTP 503 Service Unavailable — ${URL} (failed after 3 attempts)`);
    expect(DOWNLOAD_ATTEMPTS).toBe(3);
    expect(calls).toEqual([URL, URL, URL]);
    expect(sleeps).toEqual([1000, 3000]);
  });
});
