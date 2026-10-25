/** Use the desktop network stack for OS proxy resolution and trust-store support. */
import { net } from "electron";
import { Readable } from "node:stream";
import { createSafeLlmFetch } from "../../main/safe-llm-fetch.js";
import type { BootHost } from "../host-runtime.js";
import { REDIRECT_STATUSES, type HostFetchTransport } from "../../main/host-fetch-guard.js";

export function createDesktopNetworkFetch(): Pick<BootHost, "networkFetch" | "singleHopNetworkFetch" | "llmFetch"> {
  const electronNetFetch = net.fetch.bind(net);
  const createElectronFetch = (fetchImpl: typeof electronNetFetch): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const normalizedInput = input instanceof URL ? input.toString() : input;
      return fetchImpl(normalizedInput as string | Request, {
        ...(init ?? {}),
        bypassCustomProtocolHandlers: true,
      });
    }) as typeof fetch;
  const networkFetch = createElectronFetch(electronNetFetch);
  const llmFetch = createSafeLlmFetch(electronNetFetch);

  return { networkFetch, singleHopNetworkFetch: createSingleHopFetch(), llmFetch };
}

/** Return redirects without following them, regardless of init.redirect; callers recheck policy on every hop. */
function createSingleHopFetch(): HostFetchTransport {
  const send = async (input: Parameters<typeof fetch>[0], init: RequestInit = {}, beforeSend: () => void = () => {}): Promise<Response> => {
    const url =
      input instanceof URL ? input.toString()
      : typeof input === "string" ? input
      : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    return await new Promise<Response>((resolve, reject) => {
      // Settle once; aborting after a redirect can emit a later error.
      let settled = false;
      const settle = <T>(fn: (v: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const request = net.request({
        url, method, redirect: "manual", bypassCustomProtocolHandlers: true,
        // Public data downloads must not inherit cached session authentication.
        ...(init.credentials === "omit" ? { credentials: "omit" as const } : {}),
      });
      let handoffStarted = false;
      const handoff = (sendHeaders: () => void): void => {
        try {
          if (!handoffStarted) { beforeSend(); handoffStarted = true; }
          sendHeaders();
        } catch (error) {
          request.abort();
          throw error;
        }
      };
      const requestHeaders = new Headers((init?.headers as HeadersInit | undefined) ?? {});
      requestHeaders.forEach((value, key) => request.setHeader(key, value));
      const signal = init?.signal ?? undefined;
      const onAbort = (): void => {
        request.abort();
        settle(reject, new DOMException("This operation was aborted", "AbortError"));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      request.on("redirect", (statusCode, _method, redirectUrl, responseHeaders) => {
        // Expose the resolved redirect location and original headers, then cancel the hop.
        request.abort();
        const headers = new Headers();
        for (const [key, value] of Object.entries(responseHeaders)) {
          for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
        }
        headers.set("location", redirectUrl);
        settle(resolve, new Response(null, { status: statusCode, headers }));
      });
      request.on("response", (response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
        }
        const status = response.statusCode;
        // HEAD and null-body statuses carry no body; some 3xx responses arrive without a redirect event.
        const bodyless =
          status === 204 || status === 205 || status === 304 || method === "HEAD"
          || REDIRECT_STATUSES.has(status);
        const body = bodyless
          ? null
          : (Readable.toWeb(response as unknown as Readable) as ReadableStream<Uint8Array>);
        settle(
          resolve,
          new Response(body, {
            status,
            statusText: response.statusMessage ?? "",
            headers,
          }),
        );
      });
      request.on("error", (error) => settle(reject, error));
      const body = init?.body ?? null;
      if (body === null) {
        handoff(() => request.end());
      } else if (typeof body === "string") {
        handoff(() => request.end(Buffer.from(body)));
      } else if (body instanceof Uint8Array) {
        handoff(() => request.end(Buffer.from(body)));
      } else if (body instanceof ArrayBuffer) {
        handoff(() => request.end(Buffer.from(body)));
      } else if (body instanceof URLSearchParams) {
        requestHeaders.has("content-type")
          || request.setHeader("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
        handoff(() => request.end(Buffer.from(body.toString())));
      } else if (typeof (body as ReadableStream).getReader === "function") {
        void (async () => {
          const reader = (body as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            handoff(() => request.write(Buffer.from(value)));
          }
          handoff(() => request.end());
        })().catch((error: unknown) => {
          request.abort();
          settle(reject, error instanceof Error ? error : new Error(String(error)));
        });
      } else {
        // Reject FormData and Blob bodies because this transport does not assemble multipart data.
        request.abort();
        settle(
          reject,
          new TypeError("hostFetch transport: unsupported body type (use string/bytes/stream)"),
        );
      }
    });
  };
  const fetchImpl = ((input, init) => send(input, init)) as HostFetchTransport;
  fetchImpl.sendWithHandoff = (input, init, beforeSend) => send(input, init, beforeSend);
  return fetchImpl;
}
