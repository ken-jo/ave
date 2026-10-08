import https from "node:https";
import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher, type Dispatcher } from "undici";
import { createNodeSecretEncryption } from "../data/node-secret-encryption.js";
import { createSafeLlmFetch } from "../main/safe-llm-fetch.js";
import type { HostFetchTransport } from "../main/host-fetch-guard.js";
import { ensureCorporateCaInjected } from "../main/corp-ca-runtime.js";
import { readPersistedCorpCaConfigSync } from "../main/persisted-corp-ca.js";
import { getRuntimeSensitiveKeyPaths } from "../permissions/sensitive-paths.js";
import { WIRE_BYTES_MAX } from "../plugins/isolation/host-api-wire.js";
import type { BootHost } from "./host-runtime.js";

export interface NodeBootHostOptions {
  userDataPath: string;
  resourcePath: string;
  keyFilePath?: string;
  isPackaged: boolean;
}

async function prepareBufferedBody(input: string, init: RequestInit): Promise<RequestInit> {
  if (init.body === null || init.body === undefined) return init;
  // The HTTP dispatcher can await a stream after its request-start hook. Turn
  // every body into bounded bytes before dispatch so that hook and the first
  // header write execute in one synchronous stack.
  const request = new Request(input, { ...init, duplex: "half" } as RequestInit);
  if (!request.body) return { ...init, headers: request.headers, body: null };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  const onAbort = () => { void reader.cancel(init.signal?.reason).catch(() => {}); };
  init.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (init.signal?.aborted) throw init.signal.reason;
      const next = await reader.read();
      if (init.signal?.aborted) throw init.signal.reason;
      if (next.done) { completed = true; break; }
      total += next.value.byteLength;
      if (total > WIRE_BYTES_MAX) throw new TypeError("hostFetch body exceeds 16 MiB");
      chunks.push(next.value);
    }
  } finally {
    init.signal?.removeEventListener("abort", onAbort);
    if (!completed) void reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { ...init, headers: request.headers, body };
}

/** A single-hop transport whose hook runs when the HTTP stack starts a send. */
export function createNodeHostFetchTransport(dispatcher: Dispatcher): HostFetchTransport {
  const transport = ((input, init) =>
    fetch(input, { ...init, redirect: "manual" })) as HostFetchTransport;
  transport.sendWithHandoff = async (input, init, beforeSend) => {
    const bufferedInit = await prepareBufferedBody(input, init);
    // This callback runs at the HTTP stack's request-start point, after any
    // connection wait and before it constructs or writes the header block.
    // A retry invokes it again. The same proxy/CA dispatcher remains in use.
    const guardedDispatcher = dispatcher.compose((dispatch) => (options, handler) => {
      const guardedHandler = new Proxy(handler, {
        get(target, property) {
          if (property === "onRequestStart") return (controller: Parameters<NonNullable<typeof handler.onRequestStart>>[0], context: unknown) => {
            try { beforeSend(); } catch (error) {
              controller.abort(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            target.onRequestStart?.(controller, context);
          };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return dispatch(options, guardedHandler);
    });
    return undiciFetch(input, { ...bufferedInit, dispatcher: guardedDispatcher, redirect: "manual" } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  };
  return transport;
}

/** Owns server egress and credentials for the lifetime of one host process. */
export async function createNodeBootHost(options: NodeBootHostOptions): Promise<BootHost> {
  const encryption = createNodeSecretEncryption(options.keyFilePath);
  getRuntimeSensitiveKeyPaths();
  await ensureCorporateCaInjected(readPersistedCorpCaConfigSync(options.userDataPath));
  const ca = https.globalAgent.options.ca;
  const dispatcher = new EnvHttpProxyAgent({
    ...(ca ? { connect: { ca }, requestTls: { ca }, proxyTls: { ca } } : {}),
  });
  // Providers and host fetches share the configured server route. A failed
  // proxy connection remains a failure; there is no direct retry path.
  setGlobalDispatcher(dispatcher);
  const networkFetch: typeof fetch = (input, init) => fetch(input, init);
  const singleHopNetworkFetch = createNodeHostFetchTransport(dispatcher);
  return {
    userDataPath: options.userDataPath,
    resourcePath: options.resourcePath,
    isPackaged: options.isPackaged,
    systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    encryption,
    networkFetch,
    singleHopNetworkFetch,
    llmFetch: createSafeLlmFetch(networkFetch),
    exit: (code) => process.exit(code),
    close: () => dispatcher.destroy(),
  };
}
