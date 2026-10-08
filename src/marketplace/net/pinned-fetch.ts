/**
 * The marketplace's download transport (design §18.2.4): the address that is
 * checked is the address that is connected to.
 *
 * Chromium's stack, which downloads used before, resolves a host on its own
 * after Ave checked it, so a name that answers a public address to the check
 * and a loopback or metadata address to the connection passed. This transport
 * resolves each hop once, hands every answer to the caller's `select`
 * (`selectAnswers` under the gate's address policy), and opens the socket to
 * a kept answer by its address, never by name. The host name stays the TLS
 * server name and the certificate identity.
 *
 * The route is the session's PAC answer for the URL, first entry only (a
 * fallback to DIRECT is never taken silently):
 *
 *   DIRECT          target resolved here, checked, pinned
 *   PROXY h:p       TCP to the checked proxy address; CONNECT for https,
 *                   an absolute-form request for http; the proxy resolves
 *                   the target (trusted beyond its socket)
 *   HTTPS h:p       TLS to the checked proxy address, then as PROXY inside it
 *   SOCKS5 h:p      SOCKS5 CONNECT with the domain-name address type
 *   SOCKS/SOCKS4    SOCKS4 CONNECT carrying the target's checked IPv4 answer
 *
 * A proxy's own address is checked with a fixed rule: metadata and
 * unroutable addresses are refused, internal and this-computer accepted,
 * because the system configuration chose them. Any other PAC kind fails
 * SOURCE_UNREACHABLE `proxy`. Trust: Node's bundled roots plus the OS store,
 * so a company root installed there keeps working.
 */
import { promises as dns } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as netConnect, isIP, isIPv4, type Socket } from "node:net";
import { Readable } from "node:stream";
import { connect as tlsConnect, getCACertificates } from "node:tls";
import { NetworkGuardError, classifyAddress, type AddressCheckedFetch } from "../../core/network-guard.js";
import { MarketplaceError } from "../errors.js";

type ProxyKind = "DIRECT" | "PROXY" | "HTTPS" | "SOCKS5" | "SOCKS4";

export interface ProxyRoute {
  kind: ProxyKind;
  /** The proxy's host and port; null for DIRECT. */
  proxy: { host: string; port: number } | null;
}

export interface PinnedFetchOptions {
  /** The one lookup a connection makes; tests substitute a resolver fake. */
  lookup?: (host: string) => Promise<readonly string[]>;
  /** The session's PAC answer for a URL (`session.resolveProxy`); absent → DIRECT. */
  resolveProxy?: (url: string) => Promise<string>;
  /** Trust anchors (PEM). Default: Node's bundled roots plus the OS store. */
  ca?: () => readonly string[];
}

async function defaultLookup(host: string): Promise<readonly string[]> {
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

let defaultCa: readonly string[] | null = null;
function systemTrust(): readonly string[] {
  defaultCa ??= [...getCACertificates("default"), ...getCACertificates("system")];
  return defaultCa;
}

function bare(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function proxyFailure(host: string, entry: string, message: string): MarketplaceError {
  return new MarketplaceError("SOURCE_UNREACHABLE", `${message} (${entry})`, { detail: { reason: "proxy", host, proxy: entry } });
}

/** The first entry of a PAC answer as a route; a kind this transport cannot speak fails `proxy`. */
export function routeFromPac(pac: string, targetHost: string): ProxyRoute {
  const entry = (pac.split(";")[0] ?? "").trim();
  const [kindText, endpoint] = entry.split(/\s+/u, 2);
  const kind = (kindText ?? "").toUpperCase();
  if (!kind || kind === "DIRECT") return { kind: "DIRECT", proxy: null };
  const mapped: ProxyKind | null = kind === "PROXY" ? "PROXY" : kind === "HTTPS" ? "HTTPS" : kind === "SOCKS5" ? "SOCKS5" : kind === "SOCKS" || kind === "SOCKS4" ? "SOCKS4" : null;
  if (!mapped) throw proxyFailure(targetHost, entry, `the system proxy for ${targetHost} is a kind Ave cannot use`);
  const match = endpoint ? /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(endpoint) : null;
  const port = match ? Number(match[2]) : NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) throw proxyFailure(targetHost, entry, `the system proxy for ${targetHost} has no usable host and port`);
  return { kind: mapped, proxy: { host: bare(match[1]!), port } };
}

/**
 * A proxy's own addresses, on every transport that connects to one (this
 * one and git over http, §18.2.4): the configuration chose the proxy, so
 * only metadata and unroutable answers are refused. A literal proxy is its
 * own one answer and is judged the same way. No answer left fails with the
 * most restrictive refusal, metadata before unroutable.
 */
export function proxyAnswers(host: string, answers: readonly string[]): string[] {
  const kept = answers.filter((address) => {
    const kind = classifyAddress(address);
    return kind !== "metadata" && kind !== "unroutable";
  });
  if (kept.length > 0) return kept;
  const refused = answers.find((address) => classifyAddress(address) === "metadata") ?? answers[0];
  if (refused === undefined) throw new MarketplaceError("SOURCE_UNREACHABLE", `the proxy ${host} has no address`, { detail: { reason: "dns", host } });
  const reason = classifyAddress(refused) === "metadata" ? "address-metadata" : "address-unroutable";
  throw new MarketplaceError("SOURCE_URL_REJECTED", `the proxy ${host} is ${refused}, a refused address`, { detail: { reason, host, address: refused } });
}

function abortError(): Error {
  return new DOMException("This operation was aborted", "AbortError");
}

/** Bytes read off a socket during a proxy handshake; what follows them stays in the socket. */
function readBytes(socket: Socket, count: number | "head", signal: AbortSignal | undefined): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const done = (error: Error | null, value?: Buffer) => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value!);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = count === "head" ? buffered.indexOf("\r\n\r\n") : buffered.length >= count ? count : -1;
      if (end < 0) {
        if (buffered.length > 64 * 1024) done(new Error("the proxy's answer is too long"));
        return;
      }
      const take = count === "head" ? end + 4 : end;
      socket.pause();
      if (buffered.length > take) socket.unshift(buffered.subarray(take));
      done(null, buffered.subarray(0, take));
    };
    const onError = (error: Error) => done(error);
    const onEnd = () => done(new Error("the proxy closed the connection during the handshake"));
    const onAbort = () => done(abortError());
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.resume();
  });
}

function tcp(address: string, port: number, signal: AbortSignal | undefined): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    // By address: no lookup happens here.
    const socket = netConnect({ host: address, port });
    const onAbort = () => socket.destroy(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      signal?.removeEventListener("abort", onAbort);
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function tls(socket: Socket, host: string, ca: readonly string[], signal: AbortSignal | undefined): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const name = bare(host);
    const secure = tlsConnect({
      socket,
      host: name,
      // SNI carries names only; an IP literal is checked against the certificate's IP entries.
      ...(isIP(name) === 0 ? { servername: name } : {}),
      ca: [...ca],
      // Explicit, so an inherited process-wide override that disables certificate verification has no effect here.
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
    });
    const onAbort = () => secure.destroy(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    secure.once("secureConnect", () => {
      signal?.removeEventListener("abort", onAbort);
      secure.off("error", reject);
      resolve(secure);
    });
    secure.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function authority(host: string, port: number): string {
  const name = isIP(bare(host)) === 6 ? `[${bare(host)}]` : bare(host);
  return `${name}:${port}`;
}

async function connectTunnel(socket: Socket, host: string, port: number, entry: string, signal: AbortSignal | undefined): Promise<void> {
  const target = authority(host, port);
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const head = (await readBytes(socket, "head", signal)).toString("latin1");
  const status = /^HTTP\/1\.[01] (\d{3})/u.exec(head);
  if (!status || status[1] !== "200") throw proxyFailure(host, entry, `the proxy refused the tunnel to ${target}: ${head.split("\r\n")[0] ?? ""}`);
}

async function socks5(socket: Socket, host: string, port: number, entry: string, signal: AbortSignal | undefined): Promise<void> {
  socket.write(Buffer.from([5, 1, 0]));
  const greeting = await readBytes(socket, 2, signal);
  if (greeting[0] !== 5 || greeting[1] !== 0) throw proxyFailure(host, entry, "the SOCKS5 proxy wants a sign-in Ave does not have");
  const name = Buffer.from(bare(host), "utf8");
  if (name.length > 255) throw proxyFailure(host, entry, "the host name is too long for SOCKS5");
  // The domain-name address type: the proxy resolves the target (trusted beyond its socket).
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]));
  const head = await readBytes(socket, 4, signal);
  if (head[0] !== 5 || head[1] !== 0) throw proxyFailure(host, entry, `the SOCKS5 proxy refused the connection (code ${head[1]})`);
  const length = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? (await readBytes(socket, 1, signal))[0]! : -1;
  if (length < 0) throw proxyFailure(host, entry, "the SOCKS5 proxy sent an unknown address type");
  await readBytes(socket, length + 2, signal);
}

async function socks4(socket: Socket, address: string, port: number, host: string, entry: string, signal: AbortSignal | undefined): Promise<void> {
  // SOCKS4 carries only an IPv4 address: the checked, pinned answer.
  const octets = address.split(".").map(Number);
  socket.write(Buffer.from([4, 1, port >> 8, port & 0xff, ...octets, 0]));
  const reply = await readBytes(socket, 8, signal);
  if (reply[1] !== 0x5a) throw proxyFailure(host, entry, `the SOCKS4 proxy refused the connection (code ${reply[1]})`);
}

function toResponse(response: IncomingMessage, method: string): Response {
  const headers = new Headers();
  const raw = response.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) headers.append(raw[index]!, raw[index + 1]!);
  const status = response.statusCode ?? 0;
  const redirect = status >= 300 && status < 400 && status !== 304;
  const bodyless = method === "HEAD" || status === 204 || status === 205 || status === 304 || redirect;
  if (bodyless) response.resume();
  return new Response(bodyless ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
    status,
    statusText: response.statusMessage ?? "",
    headers,
  });
}

/** One HTTP/1.1 exchange over a socket already connected to where the request goes. */
function exchange(socket: Socket, url: URL, absoluteForm: boolean, init: RequestInit): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  headers.set("host", url.port && url.port !== defaultPort ? `${url.hostname}:${url.port}` : url.hostname);
  headers.set("connection", "close");
  const outgoing: Record<string, string> = {};
  headers.forEach((value, key) => {
    outgoing[key] = value;
  });
  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined;
    const request = httpRequest({
      method,
      path: absoluteForm ? url.href : `${url.pathname}${url.search}`,
      headers: outgoing,
      setHost: false,
      // A proxy handshake left the socket paused (`readBytes`); nothing arrives before this request is sent.
      createConnection: () => socket.resume(),
    });
    const onAbort = () => request.destroy(abortError());
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    request.once("response", (response) => {
      signal?.removeEventListener("abort", onAbort);
      // A later abort still stops the body.
      signal?.addEventListener("abort", () => response.destroy(abortError()), { once: true });
      resolve(toResponse(response, method));
    });
    request.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    request.end();
  });
}

/**
 * The pinned transport. `select` (the gate's address rule through
 * `selectAnswers`) sees every answer of the target's one lookup; the socket
 * goes to a kept answer by address, trying the next when one refuses the
 * connection.
 */
export function createPinnedFetch(options: PinnedFetchOptions = {}): AddressCheckedFetch {
  const lookup = options.lookup ?? defaultLookup;
  const trust = options.ca ?? systemTrust;

  const resolve = async (host: string): Promise<readonly string[]> => {
    const name = bare(host);
    return isIP(name) !== 0 ? [name] : lookup(name);
  };

  /** Try each address in order until one accepts the TCP connection. */
  const connectFirst = async (addresses: readonly string[], port: number, signal: AbortSignal | undefined): Promise<Socket> => {
    let last: unknown = new NetworkGuardError("no address to connect to");
    for (const address of addresses) {
      try {
        return await tcp(address, port, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        last = error;
      }
    }
    throw last;
  };

  return async (rawUrl, init, select) => {
    const url = new URL(rawUrl);
    const https = url.protocol === "https:";
    const port = url.port ? Number(url.port) : https ? 443 : 80;
    const signal = init.signal ?? undefined;
    const pac = options.resolveProxy ? await options.resolveProxy(url.href) : "DIRECT";
    const entry = (pac.split(";")[0] ?? "").trim();
    const route = routeFromPac(pac, url.hostname);

    let socket: Socket;
    let absoluteForm = false;
    if (route.kind === "DIRECT") {
      socket = await connectFirst(select(await resolve(url.hostname)), port, signal);
    } else {
      const proxy = route.proxy!;
      // The target of SOCKS4 is resolved here and checked like a direct one; the others resolve it beyond the proxy.
      const target = route.kind === "SOCKS4" ? select(await resolve(url.hostname)).filter((address) => isIPv4(address)) : null;
      if (target !== null && target.length === 0) {
        throw new MarketplaceError("SOURCE_UNREACHABLE", `${url.hostname} has no IPv4 address for the SOCKS4 proxy`, { detail: { reason: "dns", host: url.hostname } });
      }
      socket = await connectFirst(proxyAnswers(proxy.host, await resolve(proxy.host)), proxy.port, signal);
      try {
        if (route.kind === "HTTPS") socket = await tls(socket, proxy.host, trust(), signal);
        if (route.kind === "SOCKS5") await socks5(socket, url.hostname, port, entry, signal);
        else if (route.kind === "SOCKS4") await socks4(socket, target![0]!, port, url.hostname, entry, signal);
        else if (https) await connectTunnel(socket, url.hostname, port, entry, signal);
        else absoluteForm = true;
      } catch (error) {
        socket.destroy();
        throw error;
      }
    }
    try {
      if (https) socket = await tls(socket, url.hostname, trust(), signal);
    } catch (error) {
      socket.destroy();
      throw error;
    }
    return exchange(socket, url, absoluteForm, init);
  };
}
