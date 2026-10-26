// Authenticated loopback HTTP and SSE transport over an injected dispatcher.
// Every route authenticates; shutdown closes streams and removes their subscriptions.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP, type AddressInfo } from "node:net";
import type { A2AHttpRouter } from "./a2a-router.js";
import type { LocalApi } from "./local-api.js";
import type { StreamEventSource } from "./stream-broadcaster.js";
import { errorMessage } from "../shared/error-message.js";
import { FETCH_BAD_PORTS } from "../shared/fetch-loopback-listener.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
// Over-cap bodies return 413; each surface may supply a tighter readBody cap.
export const MAX_BODY_BYTES = 1024 * 1024;
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const HTTP_ORIGIN = "local-api" as const;
export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_RETRY_MS = 3_000;
const EPHEMERAL_PORT_RETRY_LIMIT = 20;

export interface LoopbackRouteFamilies {
  localApi: boolean;
  a2a: boolean;
}

export interface LocalApiHttpServerOptions {
  api: LocalApi;
  secret: string;
  broadcaster: StreamEventSource;
  // A2A routes exist only when the wire feature is enabled.
  a2aRouter?: A2AHttpRouter;
  routeFamilies?: Readonly<LoopbackRouteFamilies>;
  // Bind only literal IPv4 or IPv6 loopback addresses; reject hostnames.
  host?: string;
  port?: number;
  // Logs must never receive the bearer secret or Authorization header.
  log?: (message: string) => void;
}

export interface LocalApiHttpServer {
  port: number;
  /** Close the server and destroy idle keep-alive sockets so close never hangs. */
  close(): Promise<void>;
}

// Extra headers may extend the response but cannot replace its JSON content type.
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...headers, "content-type": JSON_CONTENT_TYPE });
  res.end(payload);
}

function isFetchForbiddenPort(port: number): boolean {
  return FETCH_BAD_PORTS.includes(port);
}

// Literal-only validation prevents DNS changes from moving the bind off loopback.
function isLoopbackBindHost(host: string): boolean {
  const family = isIP(host);
  if (family === 4) {
    // 127.0.0.0/8 is the IPv4 loopback block, not merely 127.0.0.1.
    return Number(host.split(".", 1)[0]) === 127;
  }
  if (family !== 6) return false;

  // Expand validated IPv6 syntax to accept loopback variants while rejecting unspecified and mapped addresses.
  const halves = host.toLowerCase().split("::");
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  const groups = halves.length === 1
    ? left
    : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.length === 8
    && groups.slice(0, -1).every((group) => Number.parseInt(group, 16) === 0)
    && Number.parseInt(groups[groups.length - 1] ?? "", 16) === 1;
}

// Check lengths before timingSafeEqual, which throws on unequal buffers.
function isAuthorized(header: string | undefined, secret: string): boolean {
  if (typeof header !== "string") return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function isRouteFamilyPath(path: string, root: "/v1" | "/a2a"): boolean {
  return path === root || path.startsWith(`${root}/`);
}

// Pause at the byte cap; callers choose whether to destroy the socket.
export function readBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overCap = false;
    req.on("data", (chunk: Buffer) => {
      if (overCap) return;
      total += chunk.length;
      if (total > maxBytes) {
        overCap = true;
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overCap) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function parseDispatchBody(raw: string): { channel: string; args?: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.channel !== "string") {
    return null;
  }
  return "args" in body ? { channel: body.channel, args: body.args } : { channel: body.channel };
}

async function handleDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  api: LocalApi,
  log?: (message: string) => void,
): Promise<void> {
  const raw = await readBody(req);
  if (raw === null) {
    // Reply before destroying over-cap sockets so streaming clients cannot hold connections open.
    sendJson(res, 413, { ok: false, error: "payload-too-large" });
    req.socket.destroy();
    return;
  }
  const parsed = parseDispatchBody(raw.toString("utf8"));
  if (parsed === null) {
    sendJson(res, 400, { ok: false, error: "invalid-request" });
    return;
  }
  try {
    const result = await api.dispatch({
      channel: parsed.channel,
      ...("args" in parsed ? { args: parsed.args } : {}),
      origin: HTTP_ORIGIN,
    });
    sendJson(res, result.ok ? 200 : 403, result);
  } catch (err) {
    log?.(`dispatch handler threw: ${errorMessage(err)}`);
    sendJson(res, 500, { ok: false, error: "internal-error" });
  }
}

// Close slow SSE clients at backpressure instead of queuing frames or blocking synchronous fan-out.
// Stream shutdown must run cleanup even when the socket never re-emits close.
export function createSseFrameWriter(
  res: ServerResponse,
  cleanup: () => void,
  isCleaned: () => boolean,
): { writeOrClose: (frame: string) => boolean; endStream: () => void } {
  const writeOrClose = (frame: string): boolean => {
    if (isCleaned() || res.destroyed || res.writableEnded) {
      cleanup();
      return false;
    }
    try {
      if (res.write(frame)) return true;
    } catch {
    }
    cleanup();
    if (!res.destroyed) res.destroy();
    return false;
  };
  const endStream = (): void => {
    cleanup();
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  return { writeOrClose, endStream };
}

// Track each SSE connection's cleanup so server shutdown removes subscriptions and heartbeat timers.
function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  broadcaster: StreamEventSource,
  liveStreams: Set<() => void>,
): void {
  let cleaned = false;
  let subscription: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Initialize the cleanup reference before writing the preamble; the peer can close during the write.
  let endStream: () => void = () => {};

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    subscription?.();
    subscription = undefined;
    liveStreams.delete(endStream);
    req.off("close", cleanup);
    res.off("close", cleanup);
  };

  const writer = createSseFrameWriter(res, cleanup, () => cleaned);
  const writeOrClose = writer.writeOrClose;
  endStream = writer.endStream;

  req.on("close", cleanup);
  res.on("close", cleanup);

  liveStreams.add(endStream);

  try {
    res.writeHead(200, {
      "content-type": SSE_CONTENT_TYPE,
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    // Disable Nagle so each frame flushes immediately (SSE is latency-sensitive).
    res.socket?.setNoDelay(true);
    if (!writeOrClose(`retry: ${SSE_RETRY_MS}\n: connected\n\n`)) return;
  } catch {
    cleanup();
    if (!res.destroyed) res.destroy();
    return;
  }

  const unsubscribe = broadcaster.subscribe((channel, payload) => {
    // JSON escaping keeps payload newlines on one data line; serialization failures must not reach the producer.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return;
    }
    writeOrClose(`event: ${channel}\ndata: ${serialized}\n\n`);
  });
  // Subscribe may replay synchronously, so cleanup must handle that race.
  if (cleaned) {
    unsubscribe();
    return;
  }
  subscription = unsubscribe;

  heartbeat = setInterval(() => {
    writeOrClose(": ping\n\n");
  }, SSE_HEARTBEAT_MS);
  // Never let the heartbeat hold the process open.
  heartbeat.unref();
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  api: LocalApi,
  broadcaster: StreamEventSource,
  liveStreams: Set<() => void>,
  a2aRouter: A2AHttpRouter | undefined,
  log?: (message: string) => void,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0].split("#")[0];
  const method = req.method ?? "GET";

  if (a2aRouter && (await a2aRouter.tryHandle(req, res, path, method))) {
    return;
  }

  if (path === "/v1/dispatch") {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method-not-allowed" });
      return;
    }
    await handleDispatch(req, res, api, log);
    return;
  }

  if (path === "/v1/events") {
    if (method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method-not-allowed" });
      return;
    }
    handleEvents(req, res, broadcaster, liveStreams);
    return;
  }

  if (path === "/v1/health") {
    if (method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method-not-allowed" });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not-found" });
}

export function startLocalApiHttpServer(
  opts: LocalApiHttpServerOptions,
): Promise<LocalApiHttpServer> {
  const { api, secret, broadcaster, a2aRouter, host = DEFAULT_HOST, port = DEFAULT_PORT, log } =
    opts;
  const requestedRouteFamilies = opts.routeFamilies ?? {
    localApi: true,
    a2a: Boolean(a2aRouter),
  };
  const routeFamilies: Readonly<LoopbackRouteFamilies> = Object.freeze({
    localApi: requestedRouteFamilies.localApi,
    a2a: requestedRouteFamilies.a2a,
  });
  if (!routeFamilies.localApi && !routeFamilies.a2a) {
    return Promise.reject(new Error("loopback http server requires an enabled route family"));
  }
  if (routeFamilies.a2a && !a2aRouter) {
    return Promise.reject(new Error("loopback http server A2A route family requires a router"));
  }
  if (!isLoopbackBindHost(host)) {
    return Promise.reject(new Error("local-api http server host must be a literal loopback address"));
  }
  const enabledA2ARouter = routeFamilies.a2a ? a2aRouter : undefined;
  if (port !== DEFAULT_PORT && isFetchForbiddenPort(port)) {
    return Promise.reject(
      new Error(`local-api http server port ${port} is blocked by Fetch clients`),
    );
  }

  const liveStreams = new Set<() => void>();

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0].split("#")[0];
    const method = req.method ?? "GET";
    if (
      (!routeFamilies.localApi && isRouteFamilyPath(path, "/v1"))
      || (!routeFamilies.a2a && isRouteFamilyPath(path, "/a2a"))
    ) {
      sendJson(res, 404, { ok: false, error: "not-found" });
      return;
    }
    // Only Agent Card discovery is public; all operations and local API routes authenticate.
    const isPublicAgentCard = enabledA2ARouter?.isPublicAgentCardRequest(path, method) === true;
    if (!isPublicAgentCard && !isAuthorized(req.headers.authorization, secret)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    void route(req, res, api, broadcaster, liveStreams, enabledA2ARouter, log).catch((err) => {
      log?.(`request routing error: ${errorMessage(err)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "internal-error" });
      } else {
        res.end();
      }
    });
  });

  return new Promise<LocalApiHttpServer>((resolve, reject) => {
    let attempts = 0;
    let settled = false;
    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      server.removeListener("error", onError);
      reject(err);
    };
    const onError = (err: Error) => {
      rejectOnce(err);
    };
    server.on("error", onError);
    const listen = () => {
      attempts += 1;
      server.listen(port, host, () => {
        const address = server.address() as AddressInfo | null;
        const boundPort = address?.port ?? 0;
        if (port === DEFAULT_PORT && isFetchForbiddenPort(boundPort)) {
          if (attempts >= EPHEMERAL_PORT_RETRY_LIMIT) {
            server.close(() => {
              rejectOnce(
                new Error(
                  `local-api http server received ${attempts} Fetch-blocked ephemeral ports`,
                ),
              );
            });
            return;
          }
          log?.(
            `local-api http server received Fetch-blocked ephemeral port ${boundPort}; retrying`,
          );
          server.close((closeErr) => {
            if (closeErr) {
              rejectOnce(closeErr);
              return;
            }
            listen();
          });
          return;
        }

        if (settled) return;
        settled = true;
        server.removeListener("error", onError);
        log?.(`local-api http server listening on ${host}:${boundPort}`);
        resolve({
          port: boundPort,
          close: () =>
            new Promise<void>((res, rej) => {
              // End SSE streams before server.close() or open event streams prevent shutdown.
              for (const endStream of [...liveStreams]) {
                endStream();
              }
              server.closeAllConnections();
              server.close((closeErr) => {
                if (!closeErr || (closeErr as { code?: string }).code === "ERR_SERVER_NOT_RUNNING") {
                  res();
                  return;
                }
                rej(closeErr);
              });
            }),
        });
      });
    };
    listen();
  });
}
