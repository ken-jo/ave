/**
 * Per-invocation proxy listener: the port a confined process may reach IS
 * the identity of the invocation it belongs to.
 *
 * The ASRT proxy names an invocation by the proxy username (`srt.<id>`), which
 * the confined client presents. That is attribution, not a boundary: a
 * process that learns another live id can present it
 * (`egress-invocations.ts`). Where the OS can pin a confined process to one
 * loopback port — Windows MXC's per-container WFP filter permits exactly the
 * configured `runtimeConfig.networkProxy` endpoint — each invocation gets its
 * own listener here, and the host, not the client, says who is asking:
 *
 * - every request the listener accepts is forwarded to the ASRT proxy with
 *   THIS invocation's `Proxy-Authorization`; whatever the client sent in that
 *   header is dropped, so a stolen id buys nothing;
 * - Node's HTTP parser frames every request, pipelined ones included, so each
 *   one is re-stamped; CONNECT gets one stamp for its tunnel;
 * - a destination on the loopback interface (or the unspecified address) is
 *   refused here, before ASRT sees it: from inside the container, asking the
 *   proxy to dial `127.0.0.1:<another listener>` would otherwise reach another
 *   invocation's port from the host side and wear that invocation's identity.
 *   ASRT already refuses NAMES that resolve to loopback (its resolved-address
 *   guard); this covers the literals and the reserved loopback names an
 *   allow-list entry or an approved prompt could otherwise open.
 *
 * SOCKS is not served: MXC only sets `HTTP_PROXY`/`HTTPS_PROXY`, and a client
 * that speaks SOCKS to this port fails the HTTP parse and is disconnected.
 *
 * This module holds no policy of its own beyond that refusal. Which hosts are
 * allowed is still ASRT's decision, under the identity stamped here. It
 * excludes the shared extension proxy's reachable ports from its bind choices.
 */
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { getWindowsProxyPortRange } from "./asrt-sandbox.js";

/** Where the listener forwards, and as whom. Read once per forwarded request. */
interface InvocationProxyUpstream {
  readonly host: string;
  readonly port: number;
  /** The complete `Proxy-Authorization` header value naming this invocation. */
  readonly proxyAuthorization: string;
}

export interface InvocationProxyListener {
  /** The loopback port the confined process is pinned to. */
  readonly port: number;
  /** The proxy URL to hand to the confinement layer (no userinfo). */
  readonly url: string;
  /** Stop accepting and drop every open connection. Idempotent. */
  close(): Promise<void>;
}

export interface OpenInvocationProxyListenerOptions {
  /**
   * The upstream for the next request, or undefined when the proxy is gone
   * (the request is then refused with 502 rather than sent anywhere else).
   */
  readonly upstream: () => InvocationProxyUpstream | undefined;
  /** Called for each destination refused here, with the reason. Never throws into the listener. */
  readonly onRefused?: (destination: string, reason: string) => void;
  /** Upper bound on the CONNECT response head read back from the upstream. */
  readonly maxUpstreamHeadBytes?: number;
}

/** Why a destination is refused at the listener, or undefined to forward it. */
export function refusedInvocationProxyDestination(hostname: string): string | undefined {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0) return "empty destination host";
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback destination";
  const family = net.isIP(host);
  if (family === 4) return refusedIPv4(host);
  if (family === 6) return refusedIPv6(host);
  return undefined;
}

function refusedIPv4(address: string): string | undefined {
  const first = Number(address.split(".")[0]);
  if (first === 127) return "loopback destination";
  if (first === 0) return "unspecified destination";
  return undefined;
}

function refusedIPv6(address: string): string | undefined {
  const blocked = new net.BlockList();
  blocked.addAddress("::1", "ipv6");
  blocked.addAddress("::", "ipv6");
  if (blocked.check(address, "ipv6")) return address === "::" ? "unspecified destination" : "loopback destination";
  // An IPv4-mapped or IPv4-compatible spelling reaches the IPv4 address it
  // carries; judge that address too.
  const embedded = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (embedded !== null) return refusedIPv4(embedded[1]!);
  // The same in hex (`::ffff:7f00:1`, `::7f00:1`), as WHATWG URL parsing
  // serializes `[::127.0.0.1]` and `[::ffff:127.0.0.1]`.
  const embeddedHex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (embeddedHex !== null) {
    const high = parseInt(embeddedHex[1]!, 16);
    const low = parseInt(embeddedHex[2]!, 16);
    return refusedIPv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  return undefined;
}

/**
 * The hostname a client asked for, in the WHATWG spelling a resolver would
 * act on (`2130706433` and `0x7f.1` become `127.0.0.1`), or undefined when the
 * authority does not parse.
 */
export function canonicalDestinationHost(authorityOrUrl: string): string | undefined {
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(authorityOrUrl)
      ? new URL(authorityOrUrl)
      : new URL(`http://${authorityOrUrl}`);
    return url.hostname;
  } catch {
    return undefined;
  }
}

/** Hop-by-hop and identity headers never forwarded from the client. */
const STRIPPED_REQUEST_HEADERS = new Set(["proxy-authorization", "proxy-connection", "proxy-authenticate"]);

function forwardedHeaders(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (STRIPPED_REQUEST_HEADERS.has(raw[i]!.toLowerCase())) continue;
    out.push(raw[i]!, raw[i + 1]!);
  }
  return out;
}

function refuse(socketOrResponse: http.ServerResponse | Duplex, status: number, reason: string): void {
  const phrase = http.STATUS_CODES[status] ?? "Refused";
  if (socketOrResponse instanceof http.ServerResponse) {
    if (!socketOrResponse.headersSent) {
      socketOrResponse.writeHead(status, { "content-type": "text/plain", connection: "close", "x-ave-egress-refused": reason });
    }
    socketOrResponse.end(`${reason}\n`);
    return;
  }
  socketOrResponse.end(`HTTP/1.1 ${status} ${phrase}\r\nx-ave-egress-refused: ${reason}\r\nconnection: close\r\n\r\n`);
}

const DEFAULT_MAX_UPSTREAM_HEAD_BYTES = 16 * 1024;
const MAX_LISTENER_BIND_ATTEMPTS = 16;

export async function openInvocationProxyListener(
  options: OpenInvocationProxyListenerOptions,
): Promise<InvocationProxyListener> {
  const [excludedStart, excludedEnd] = getWindowsProxyPortRange();
  if (!Number.isInteger(excludedStart) || !Number.isInteger(excludedEnd) ||
      excludedStart < 1 || excludedEnd > 65535 || excludedStart > excludedEnd) {
    throw new Error("invalid shared proxy port range");
  }
  const sockets = new Set<Duplex>();
  let accepting = false;
  const maxHead = options.maxUpstreamHeadBytes ?? DEFAULT_MAX_UPSTREAM_HEAD_BYTES;
  const report = (destination: string, reason: string): void => {
    try {
      options.onRefused?.(destination, reason);
    } catch {
      // A reporting failure must not change the refusal.
    }
  };

  const server = http.createServer((req, res) => {
    const target = req.url ?? "";
    const hostname = canonicalDestinationHost(target);
    if (hostname === undefined || !/^https?:\/\//i.test(target)) {
      refuse(res, 400, "absolute http URL required");
      return;
    }
    const refused = refusedInvocationProxyDestination(hostname);
    if (refused !== undefined) {
      report(hostname, refused);
      refuse(res, 403, refused);
      return;
    }
    const upstream = options.upstream();
    if (upstream === undefined) {
      refuse(res, 502, "proxy unavailable");
      return;
    }
    const headers = forwardedHeaders(req.rawHeaders);
    headers.push("Proxy-Authorization", upstream.proxyAuthorization);
    const forward = http.request({
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: target,
      headers,
      setHost: false,
    });
    forward.on("response", (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.rawHeaders);
      upRes.pipe(res);
    });
    forward.on("error", () => refuse(res, 502, "proxy unavailable"));
    req.pipe(forward);
  });

  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const authority = req.url ?? "";
    const hostname = canonicalDestinationHost(authority);
    if (hostname === undefined || !/:\d+$/.test(authority)) {
      refuse(client, 400, "CONNECT needs host:port");
      return;
    }
    const refused = refusedInvocationProxyDestination(hostname);
    if (refused !== undefined) {
      report(hostname, refused);
      refuse(client, 403, refused);
      return;
    }
    const upstream = options.upstream();
    if (upstream === undefined) {
      refuse(client, 502, "proxy unavailable");
      return;
    }
    const up = net.connect(upstream.port, upstream.host);
    sockets.add(up);
    up.on("close", () => {
      sockets.delete(up);
      client.destroy();
    });
    client.on("close", () => up.destroy());
    up.on("error", () => {
      if (!client.destroyed) refuse(client, 502, "proxy unavailable");
    });
    up.once("connect", () => {
      up.write(
        `CONNECT ${authority} HTTP/1.1\r\n` +
          `Host: ${authority}\r\n` +
          `Proxy-Authorization: ${upstream.proxyAuthorization}\r\n\r\n`,
      );
    });
    // Read the upstream's response head, relay it verbatim, then splice.
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > maxHead) {
          up.destroy();
          refuse(client, 502, "proxy response too large");
        }
        return;
      }
      up.off("data", onData);
      const responseHead = buffered.subarray(0, end + 4);
      const rest = buffered.subarray(end + 4);
      const ok = /^HTTP\/1\.[01] 200\b/.test(responseHead.toString("latin1"));
      client.write(responseHead);
      if (!ok) {
        // The upstream refused (403, 407, 502…): relay its answer and close.
        client.end();
        up.destroy();
        return;
      }
      if (rest.length > 0) client.write(rest);
      if (head.length > 0) up.write(head);
      up.pipe(client);
      client.pipe(up);
    };
    up.on("data", onData);
  });

  server.on("connection", (socket: net.Socket) => {
    // A tentative bind inside the shared range must never accept a request.
    if (!accepting) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_err, socket) => socket.destroy());

  let port: number | undefined;
  for (let attempt = 0; attempt < MAX_LISTENER_BIND_ATTEMPTS; attempt++) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("invocation proxy listener has no TCP address");
    }
    if (address.port < excludedStart || address.port > excludedEnd) {
      port = address.port;
      break;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (port === undefined) throw new Error("invocation proxy listener could not bind outside shared proxy port range");
  accepting = true;
  let closing: Promise<void> | undefined;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      });
      return closing;
    },
  };
}
