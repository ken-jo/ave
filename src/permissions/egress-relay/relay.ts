// One loopback HTTP proxy listener per invocation. The listener is the identity: every decision is attributed to the invocation it was opened for.
// A destination is decided by name first (allow list, then the ask callback), resolved once, vetted, confirmed, and dialed at exactly what was vetted.
// Anything that does not parse, exceeds a limit or cannot be decided is refused; nothing is forwarded on a guess.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { InvocationProxyAdmission } from "../egress-invocation-listener.js";
import {
  canonicalRelayHost,
  isLoopbackAddress,
  isLoopbackName,
  isReservedAddress,
  isThisHostAddress,
  isValidRelayHost,
  localInterfaceAddresses,
  parseRelayAllowEntry,
  relayAllowEntryMatches,
  resolvedAddressPermitted,
  type RelayAllowEntry,
} from "./destination.js";

interface AskIdentity {
  readonly attributionKey: string;
  readonly identity: "listener";
}
type EgressRelayAskContext =
  | (AskIdentity & { readonly phase: "name" })
  | (AskIdentity & { readonly phase: "resolved"; readonly addresses: readonly string[]; readonly resolution: "pinned" | "upstream" });

// Only `true` allows.
export type EgressRelayAsk = (
  destination: { host: string; port: number },
  context: EgressRelayAskContext,
) => Promise<boolean | { allow: false; reason: string; unattributed?: true }>;

type EgressRelayRoute =
  | { kind: "direct" }
  | { kind: "http" | "https"; host: string; port: number; auth?: { username: string; password: string }; resolvesNames?: boolean };

export type EgressRelayRouter = ((destination: { host: string; port: number; scheme: "http" | "https" }) => Promise<{
  routes: readonly EgressRelayRoute[];
  reason?: string;
}>) & {
  generation?: () => number;
  decisionClass?: (host: string, addresses: readonly string[], resolution: "pinned" | "upstream") => string;
};

type EgressRelayResolver = (name: string) => Promise<readonly { address: string; family?: number }[]>;

export interface EgressRelayViolation {
  readonly line: string;
  readonly encodedCommand?: string;
  readonly timestamp: Date;
}

export interface EgressRelayServiceOptions {
  readonly ask: EgressRelayAsk;
  readonly router?: EgressRelayRouter;
  // `host:port` entries reachable without the ask callback.
  readonly allow?: readonly string[];
  readonly resolve?: EgressRelayResolver;
  readonly maxRelays?: number;
  // Tests shorten the hold-back; production uses ENDED_PORT_HOLD.
  readonly endedPortHold?: EndedPortHold;
}

interface EndedPortHold {
  readonly ms: number;
  readonly maxMs: number;
  readonly groupAlive?: (group: number) => boolean;
}

export interface EgressRelay {
  readonly port: number;
  // The complete `Proxy-Authorization` value this relay accepts.
  readonly proxyAuthorization: string;
  // A loopback port that forwards to this relay; it is never a destination.
  registerPort(port: number): void;
  recordRefusal(host: string, port: number | undefined, reason: string): void;
  // The relay stops at once. Its ports stay bound and refused as destinations for the hold-back, longer while `processGroup` has a process.
  close(options?: { readonly processGroup?: number }): Promise<void>;
}

// How long an ended relay's ports are held back, and the bound on extending that for a live process group.
const ENDED_PORT_HOLD = { ms: 30 * 60 * 1000, maxMs: 24 * 60 * 60 * 1000 } as const;
const MAX_RELAYS = 4096;
const MIN_TOKEN_LENGTH = 22;
const MAX_ROUTING_ATTEMPTS = 32;
const MAX_RETAINED_VIOLATIONS = 100;
const MAX_REASON_LENGTH = 500;
const MAX_UPSTREAM_HEAD_BYTES = 16 * 1024;
const DIAL_TIMEOUT_MS = 30_000;
const CLIENT_ERROR_LINGER_MS = 1000;
const LOCAL_UPSTREAM_REASON = "the upstream proxy on this host resolves names itself, so a name this host cannot resolve is not forwarded";
const LOCAL_PLAIN_HTTP_REASON = "the upstream proxy on this host resolves names itself, so a plain-HTTP request by name is not forwarded to it";

type ProxyRoute = { kind: "proxy"; tls: boolean; host: string; port: number; authorization?: string; resolvesNames: boolean };
type Route = { kind: "direct" } | ProxyRoute;
interface RoutingStamp {
  readonly installs: number;
  readonly router: EgressRelayRouter | undefined;
  readonly revision: number | undefined;
}
interface Pin {
  readonly addresses: readonly string[];
  readonly viaUpstream: boolean;
  readonly routes: readonly Route[];
  readonly stamp: RoutingStamp;
  readonly byName: "config" | "ask";
  readonly approvedClass: string | undefined;
}
interface Lane {
  readonly key: string;
  readonly encodedKey: string;
  readonly secret: string;
  readonly ports: Set<number>;
  readonly sockets: Set<Duplex>;
  ended: boolean;
}
interface Service {
  readonly ask: EgressRelayAsk;
  readonly allow: readonly RelayAllowEntry[];
  readonly resolve: EgressRelayResolver;
  readonly maxRelays: number;
  readonly endedPortHold: EndedPortHold;
  router: EgressRelayRouter | undefined;
  routerInstalls: number;
}

// A policy refusal, already recorded: the client gets 403 with the reason.
class Refusal extends Error {}
// A failed lookup or dial: never an allow and never a policy claim.
class TransportFailure extends Error {
  constructor(readonly kind: "dns" | "connect" | "timeout" | "routing", message: string) {
    super(message);
  }
}
class UpstreamStatus extends Error {
  constructor(readonly status: number) {
    super(`upstream proxy answered HTTP ${status}`);
  }
}
class StaleRoute extends Error {}

let service: Service | undefined;
const lanes = new Map<string, Lane & { close(): Promise<void> }>();
const retiredKeys = new Set<string>();
const heldBack = new Set<{ readonly ports: ReadonlySet<number>; release(): Promise<void> }>();
const liveConnections = new Map<string, Set<Duplex>>();
let violations: EgressRelayViolation[] = [];
const violationListeners = new Set<(violations: readonly EgressRelayViolation[]) => void>();

function oneLine(text: string): string {
  return text.replace(/[^\x20-\x7e]+/gu, " ").slice(0, MAX_REASON_LENGTH).trim();
}

function addViolation(line: string, encodedCommand: string | undefined): void {
  violations = [...violations, { line: oneLine(line), ...(encodedCommand !== undefined ? { encodedCommand } : {}), timestamp: new Date() }]
    .slice(-MAX_RETAINED_VIOLATIONS);
  for (const listener of violationListeners) {
    try {
      listener(violations);
    } catch {
      // A subscriber failure never changes a refusal.
    }
  }
}

// The listener receives the retained tail at once and on every change; a record keeps its identity while retained.
export function subscribeEgressRelayViolations(listener: (violations: readonly EgressRelayViolation[]) => void): () => void {
  violationListeners.add(listener);
  listener(violations);
  return () => {
    violationListeners.delete(listener);
  };
}

function deny(lane: Lane, host: string, port: number, reason: string, unattributed = false): Refusal {
  addViolation(`deny network-outbound ${host}:${port} (${oneLine(reason)})`, unattributed ? undefined : lane.encodedKey);
  return new Refusal(oneLine(reason));
}

export function startEgressRelayService(options: EgressRelayServiceOptions): void {
  if (service !== undefined) throw new Error("egress relay: the service is already started");
  if (typeof options.ask !== "function") throw new Error("egress relay: an ask callback is required");
  const maxRelays = options.maxRelays ?? MAX_RELAYS;
  if (!Number.isInteger(maxRelays) || maxRelays < 1 || maxRelays > MAX_RELAYS) throw new Error("egress relay: invalid relay limit");
  service = {
    ask: options.ask,
    allow: (options.allow ?? []).map(parseRelayAllowEntry),
    resolve: options.resolve ?? ((name) => lookup(name, { all: true, verbatim: true })),
    maxRelays,
    endedPortHold: options.endedPortHold ?? ENDED_PORT_HOLD,
    router: options.router,
    routerInstalls: 0,
  };
}

export async function stopEgressRelayService(): Promise<void> {
  service = undefined;
  const results = await Promise.allSettled([...lanes.values()].map((lane) => lane.close()));
  await Promise.allSettled([...heldBack].map((held) => held.release()));
  retiredKeys.clear();
  violations = [];
  const failed = results.find((result) => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

export function setEgressRelayRouter(router: EgressRelayRouter | undefined): void {
  if (service === undefined) throw new Error("egress relay: the service is not started");
  if (router !== undefined && typeof router !== "function") throw new TypeError("egress relay: the router must be a function");
  service.routerInstalls += 1;
  service.router = router;
}

function routingStamp(current: Service): RoutingStamp {
  return { installs: current.routerInstalls, router: current.router, revision: current.router?.generation?.() };
}

function routingIsCurrent(current: Service, stamp: RoutingStamp): boolean {
  return service === current && stamp.installs === current.routerInstalls && stamp.router === current.router
    && stamp.revision === current.router?.generation?.();
}

function relayPorts(): Set<number> {
  const ports = new Set<number>();
  for (const owner of [...lanes.values(), ...heldBack]) for (const port of owner.ports) ports.add(port);
  return ports;
}

function isRelayListener(canonical: string, port: number): boolean {
  if (!relayPorts().has(port)) return false;
  return isLoopbackName(canonical) || (net.isIP(canonical) !== 0 && isThisHostAddress(canonical, localInterfaceAddresses()));
}

function connectionKey(key: string, host: string, port: number): string {
  return `${key}\n${canonicalRelayHost(host) ?? host}\n${port}`;
}

function trackConnection(lane: Lane, host: string, port: number, socket: Duplex): void {
  const id = connectionKey(lane.key, host, port);
  const set = liveConnections.get(id) ?? new Set<Duplex>();
  liveConnections.set(id, set);
  set.add(socket);
  socket.once("close", () => {
    set.delete(socket);
    if (set.size === 0 && liveConnections.get(id) === set) liveConnections.delete(id);
  });
}

// Close every connection these invocations were allowed to `host:port`. Returns how many were closed.
export function closeEgressRelayConnections(tokens: readonly string[], host: string, port: number): number {
  let closed = 0;
  for (const token of tokens) {
    if (typeof token !== "string") continue;
    const id = connectionKey(token, host, port);
    for (const socket of liveConnections.get(id) ?? []) {
      socket.destroy();
      closed++;
    }
    liveConnections.delete(id);
  }
  return closed;
}

// Close every allowed connection of every invocation. Returns how many were closed.
export function closeAllEgressRelayConnections(): number {
  let closed = 0;
  for (const sockets of liveConnections.values()) {
    for (const socket of sockets) {
      socket.destroy();
      closed++;
    }
  }
  liveConnections.clear();
  return closed;
}

async function askCallback(current: Service, lane: Lane, host: string, port: number, context: EgressRelayAskContext): Promise<void> {
  // Read as unknown: a caller is not bound by the declared type, and only `true` allows.
  const answer: unknown = await Promise.resolve().then(() => current.ask({ host, port }, context)).catch(() => {
    throw deny(lane, host, port, "permission prompt failed");
  });
  if (answer === true) return;
  const declared = typeof answer === "object" && answer !== null && (answer as { allow?: unknown }).allow === false
    ? answer as { reason?: unknown; unattributed?: unknown }
    : undefined;
  const reason = typeof declared?.reason === "string" ? oneLine(declared.reason) : "";
  throw deny(lane, host, port, reason === "" ? "user denied" : reason, declared?.unattributed === true);
}

function normalizeRoute(entry: EgressRelayRoute): Route | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  if (entry.kind === "direct") return { kind: "direct" };
  if (entry.kind !== "http" && entry.kind !== "https") return undefined;
  if (typeof entry.host !== "string" || !isValidRelayHost(entry.host)) return undefined;
  if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) return undefined;
  const host = canonicalRelayHost(entry.host);
  if (host === undefined) return undefined;
  let authorization: string | undefined;
  if (entry.auth !== undefined) {
    if (typeof entry.auth?.username !== "string" || typeof entry.auth.password !== "string") return undefined;
    authorization = `Basic ${Buffer.from(`${entry.auth.username}:${entry.auth.password}`).toString("base64")}`;
  }
  return { kind: "proxy", tls: entry.kind === "https", host, port: entry.port, resolvesNames: entry.resolvesNames === true, ...(authorization !== undefined ? { authorization } : {}) };
}

function timedOut(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT";
}

async function routesFor(current: Service, canonical: string, port: number, scheme: "http" | "https"): Promise<{ routes: Route[] } | { reason: string }> {
  // This host's own loopback is never chained through an upstream.
  if (canonical === "localhost" || isLoopbackAddress(canonical) || current.router === undefined) return { routes: [{ kind: "direct" }] };
  let answer: Awaited<ReturnType<EgressRelayRouter>>;
  try {
    answer = await current.router({ host: canonical, port, scheme });
  } catch (error) {
    throw timedOut(error)
      ? new TransportFailure("timeout", "upstream proxy lookup timed out")
      : new TransportFailure("routing", "upstream proxy lookup failed");
  }
  if (typeof answer !== "object" || answer === null || !Array.isArray(answer.routes)) return { reason: "upstream proxy lookup answered no route list" };
  const routes: Route[] = [];
  for (const entry of answer.routes) {
    const route = normalizeRoute(entry);
    if (route === undefined) return { reason: "upstream proxy lookup answered a malformed route" };
    routes.push(route);
  }
  if (routes.length > 0) return { routes };
  const reason = typeof answer.reason === "string" ? oneLine(answer.reason) : "";
  return { reason: reason === "" ? "no usable route to the destination" : reason };
}

async function resolveAddresses(current: Service, name: string): Promise<{ addresses: string[]; failure?: TransportFailure }> {
  try {
    const answer = await current.resolve(name);
    return { addresses: (Array.isArray(answer) ? answer : []).map((entry) => entry?.address).filter((a): a is string => typeof a === "string" && net.isIP(a) !== 0) };
  } catch (error) {
    return {
      addresses: [],
      failure: timedOut(error) ? new TransportFailure("timeout", "destination lookup timed out") : new TransportFailure("dns", "destination name did not resolve"),
    };
  }
}

// A proxy whose name cannot be resolved counts as this host.
async function proxyOnThisHost(current: Service, route: ProxyRoute): Promise<boolean> {
  if (isLoopbackName(route.host)) return true;
  const local = localInterfaceAddresses();
  if (net.isIP(route.host) !== 0) return isThisHostAddress(route.host, local);
  const { addresses } = await resolveAddresses(current, route.host);
  return addresses.length === 0 || addresses.some((address) => isThisHostAddress(address, local));
}

type Plan = { addresses: string[]; viaUpstream: boolean; routes: Route[] } | { reason: string };

async function planDestination(current: Service, canonical: string, port: number, plainHttp: boolean): Promise<Plan> {
  const routed = await routesFor(current, canonical, port, plainHttp ? "http" : "https");
  if ("reason" in routed) return routed;
  const candidates = routed.routes.filter((route) => route.kind === "direct" || !isRelayListener(route.host, route.port));
  if (candidates.length === 0) return { reason: "sandbox proxy listener" };
  const literal = net.isIP(canonical) !== 0;
  const resolution = literal ? { addresses: [canonical] } : await resolveAddresses(current, canonical);
  const addresses = resolution.addresses;
  const dropLocal = async (routes: readonly Route[], keepDirect: boolean): Promise<{ kept: Route[]; localDropped: boolean; forwarded: boolean }> => {
    const kept: Route[] = [];
    let localDropped = false;
    let forwarded = false;
    for (const route of routes) {
      if (route.kind === "direct") {
        if (keepDirect) kept.push(route);
        continue;
      }
      if (!route.resolvesNames && await proxyOnThisHost(current, route)) {
        localDropped = true;
        continue;
      }
      forwarded = true;
      kept.push(route);
    }
    return { kept, localDropped, forwarded };
  };
  if (addresses.length > 0) {
    if (!literal) {
      const local = localInterfaceAddresses();
      for (const address of addresses) {
        if (!resolvedAddressPermitted(canonical, address, port, current.allow, local)) {
          return { reason: "destination resolves to this host or a reserved address" };
        }
        if (isRelayListener(address, port)) return { reason: "sandbox proxy listener" };
      }
    }
    if (!plainHttp || literal) return { addresses, viaUpstream: false, routes: candidates };
    // A plain-HTTP request names its host in the request target, which an upstream resolves itself: only a direct route stays pinned.
    const { kept, localDropped, forwarded } = await dropLocal(candidates, true);
    if (kept.length === 0) return { reason: localDropped ? LOCAL_PLAIN_HTTP_REASON : "plain HTTP by name cannot be pinned through the parent proxy" };
    return { addresses, viaUpstream: forwarded, routes: kept };
  }
  // A name this host cannot resolve goes only through an upstream that is elsewhere or trusted to resolve names.
  const { kept, localDropped } = await dropLocal(candidates, false);
  if (kept.length > 0) return { addresses: [], viaUpstream: true, routes: kept };
  if (localDropped) return { reason: LOCAL_UPSTREAM_REASON };
  throw resolution.failure ?? new TransportFailure("dns", "destination name did not resolve");
}

async function decideDestination(lane: Lane, host: string, port: number, plainHttp: boolean, previous?: Pin): Promise<Pin> {
  const current = service;
  if (current === undefined || lane.ended) throw deny(lane, host, port, "invocation ended");
  if (!isValidRelayHost(host)) throw deny(lane, host, port, "malformed host");
  const canonical = canonicalRelayHost(host);
  if (canonical === undefined) throw deny(lane, host, port, "malformed host");
  if (isRelayListener(canonical, port)) throw deny(lane, host, port, "sandbox proxy listener");
  // Refused in any spelling, before any ask or dial.
  if (net.isIP(canonical) !== 0 && isReservedAddress(canonical)) throw deny(lane, host, port, "destination is a reserved address");
  const identity = { attributionKey: lane.key, identity: "listener" } as const;
  let byName = previous?.byName;
  if (byName === undefined) {
    // Nothing is resolved and no route is asked for until the name is allowed.
    byName = current.allow.some((entry) => relayAllowEntryMatches(entry, canonical, port)) ? "config" : "ask";
    if (byName === "ask") await askCallback(current, lane, host, port, { ...identity, phase: "name" });
  }
  let approvedClass = previous?.approvedClass;
  for (let attempt = 0; attempt < MAX_ROUTING_ATTEMPTS; attempt++) {
    const stamp = routingStamp(current);
    const plan = await planDestination(current, canonical, port, plainHttp);
    if (!routingIsCurrent(current, stamp)) continue;
    if ("reason" in plan) throw deny(lane, host, port, plan.reason);
    const resolution = plan.viaUpstream ? "upstream" : "pinned";
    const decisionClass = stamp.router?.decisionClass?.(canonical, plan.addresses, resolution)
      ?? JSON.stringify([plan.viaUpstream, [...plan.addresses].sort()]);
    if (byName === "ask" && decisionClass !== approvedClass) {
      await askCallback(current, lane, host, port, { ...identity, phase: "resolved", addresses: plan.addresses, resolution });
      approvedClass = decisionClass;
    }
    if (!routingIsCurrent(current, stamp)) continue;
    if (lane.ended) throw deny(lane, host, port, "invocation ended");
    return { ...plan, stamp, byName, approvedClass };
  }
  throw deny(lane, host, port, "upstream routing changed too often during the connection decision");
}

function own(lane: Lane, socket: Duplex): void {
  if (lane.ended) {
    socket.destroy();
    return;
  }
  lane.sockets.add(socket);
  socket.once("close", () => lane.sockets.delete(socket));
}

function dial(lane: Lane, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    own(lane, socket);
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(DIAL_TIMEOUT_MS, () => fail(Object.assign(new Error("dial timed out"), { code: "ETIMEDOUT" })));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.off("error", fail);
      socket.on("error", () => socket.destroy());
      resolve(socket);
    });
  });
}

// A connected socket to the proxy of `route`, vetted: never a relay listener, and never this host for a name it would resolve itself.
async function dialProxy(current: Service, lane: Lane, route: ProxyRoute, pin: Pin, host: string, port: number): Promise<Duplex> {
  let addresses = [route.host];
  if (net.isIP(route.host) === 0) {
    const resolved = await resolveAddresses(current, route.host);
    if (resolved.addresses.length === 0) throw resolved.failure ?? new TransportFailure("dns", "upstream proxy name did not resolve");
    addresses = resolved.addresses;
  }
  let last: unknown = new Error("no upstream proxy address");
  for (const address of addresses) {
    let socket: net.Socket;
    try {
      socket = await dial(lane, address, route.port);
    } catch (error) {
      last = error;
      continue;
    }
    const onThisHost = socket.remoteAddress === undefined || isThisHostAddress(socket.remoteAddress, localInterfaceAddresses());
    const refusal = onThisHost && socket.remotePort !== undefined && relayPorts().has(socket.remotePort)
      ? "sandbox proxy listener"
      : onThisHost && pin.viaUpstream && !route.resolvesNames ? LOCAL_UPSTREAM_REASON : undefined;
    if (refusal !== undefined) {
      socket.destroy();
      throw deny(lane, host, port, refusal);
    }
    if (!route.tls) return socket;
    const secured = tls.connect({ socket, servername: net.isIP(route.host) === 0 ? route.host : undefined });
    own(lane, secured);
    try {
      await new Promise<void>((resolve, reject) => {
        secured.once("secureConnect", resolve);
        secured.once("error", reject);
      });
    } catch (error) {
      secured.destroy();
      last = error;
      continue;
    }
    secured.on("error", () => secured.destroy());
    return secured;
  }
  throw last;
}

function authority(host: string, port: number): string {
  return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

// CONNECT through an already vetted proxy socket. Resolves with the tunnel and any bytes that followed the reply head.
function connectThrough(proxy: Duplex, route: ProxyRoute, destination: string, port: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => finish(Object.assign(new Error("upstream proxy timed out"), { code: "ETIMEDOUT" })), DIAL_TIMEOUT_MS);
    const finish = (error: Error | undefined, rest?: Buffer): void => {
      clearTimeout(timer);
      proxy.off("data", onData);
      proxy.off("close", onClose);
      if (error !== undefined) {
        proxy.destroy();
        reject(error);
      } else {
        resolve(rest ?? Buffer.alloc(0));
      }
    };
    const onClose = (): void => finish(new Error("upstream proxy closed the connection"));
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_UPSTREAM_HEAD_BYTES) finish(new Error("upstream proxy reply too large"));
        return;
      }
      const status = /^HTTP\/1\.[01] (\d{3})(?: |\r)/u.exec(buffered.subarray(0, end + 2).toString("latin1"));
      if (status === null) {
        finish(new Error("upstream proxy reply malformed"));
        return;
      }
      const code = Number(status[1]);
      if (code < 200 || code > 299) {
        finish(new UpstreamStatus(code));
        return;
      }
      // Paused until the tunnel is piped, so no byte is read in between.
      proxy.pause();
      finish(undefined, buffered.subarray(end + 4));
    };
    proxy.on("data", onData);
    proxy.once("close", onClose);
    const target = authority(destination, port);
    proxy.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${route.authorization !== undefined ? `Proxy-Authorization: ${route.authorization}\r\n` : ""}\r\n`);
  });
}

// The addresses a dial may use now: the pinned ones, vetted again.
function pinnedAddresses(current: Service, canonical: string, port: number, pin: Pin): string[] {
  const local = localInterfaceAddresses();
  return pin.addresses.filter((address) => resolvedAddressPermitted(canonical, address, port, current.allow, local));
}

function upstreamRefusal(lane: Lane, host: string, port: number, error: UpstreamStatus): Error {
  if (error.status === 407) return deny(lane, host, port, "upstream proxy requires authentication");
  if (error.status === 502 || error.status === 504) {
    return new TransportFailure(error.status === 504 ? "timeout" : "connect", `upstream proxy returned HTTP ${error.status}`);
  }
  return deny(lane, host, port, `upstream proxy refused the connection (HTTP ${error.status})`);
}

interface Opened {
  readonly socket: Duplex;
  readonly rest: Buffer;
  // The proxy route a plain-HTTP request is sent through in absolute form.
  readonly proxy?: ProxyRoute;
}

// Dial an allowed destination over its pinned routes, in order. Only a route that fails to connect hands over to the next.
async function openRoute(lane: Lane, host: string, port: number, plainHttp: boolean, decided: Pin): Promise<Opened> {
  const canonical = canonicalRelayHost(host) ?? host;
  let pin = decided;
  for (let attempt = 0; attempt < MAX_ROUTING_ATTEMPTS; attempt++) {
    const current = service;
    if (current === undefined || lane.ended) throw deny(lane, host, port, "invocation ended");
    if (!routingIsCurrent(current, pin.stamp)) pin = await decideDestination(lane, host, port, plainHttp, pin);
    let last: unknown = new Error("no route");
    try {
      for (const route of pin.routes) {
        if (!routingIsCurrent(current, pin.stamp)) throw new StaleRoute();
        try {
          if (route.kind === "direct") {
            const targets = net.isIP(canonical) !== 0 ? [canonical] : pinnedAddresses(current, canonical, port, pin);
            if (targets.length === 0) throw deny(lane, host, port, "resolved to a refused address");
            let socket: net.Socket | undefined;
            for (const target of targets) {
              try {
                socket = await dial(lane, target, port);
                break;
              } catch (error) {
                last = error;
              }
            }
            if (socket === undefined) continue;
            if (!routingIsCurrent(current, pin.stamp)) {
              socket.destroy();
              throw new StaleRoute();
            }
            return { socket, rest: Buffer.alloc(0) };
          }
          if (plainHttp) {
            if (net.isIP(canonical) === 0 && !pin.viaUpstream) throw deny(lane, host, port, "plain HTTP by name cannot be pinned through the parent proxy");
            return { socket: await dialProxy(current, lane, route, pin, host, port), rest: Buffer.alloc(0), proxy: route };
          }
          const kept = pinnedAddresses(current, canonical, port, pin);
          const destinations = net.isIP(canonical) !== 0 || pin.viaUpstream
            ? [canonical]
            : [...kept.filter((a) => net.isIP(a) === 4), ...kept.filter((a) => net.isIP(a) !== 4)];
          if (destinations.length === 0) throw deny(lane, host, port, "destination was not resolved before the parent proxy");
          for (const destination of destinations) {
            const proxy = await dialProxy(current, lane, route, pin, host, port);
            try {
              const rest = await connectThrough(proxy, route, destination, port);
              if (!routingIsCurrent(current, pin.stamp)) {
                proxy.destroy();
                throw new StaleRoute();
              }
              return { socket: proxy, rest };
            } catch (error) {
              // An answered CONNECT is final: nothing an upstream refused goes out by a later route.
              if (error instanceof UpstreamStatus) throw upstreamRefusal(lane, host, port, error);
              if (error instanceof StaleRoute) throw error;
              last = error;
            }
          }
        } catch (error) {
          if (error instanceof Refusal || error instanceof TransportFailure || error instanceof StaleRoute) throw error;
          last = error;
        }
      }
    } catch (error) {
      if (error instanceof StaleRoute) continue;
      throw error;
    }
    if (!routingIsCurrent(current, pin.stamp)) continue;
    throw timedOut(last) ? new TransportFailure("timeout", "upstream connection timed out") : new TransportFailure("connect", "upstream connection failed");
  }
  throw new TransportFailure("routing", "upstream routing changed during the connection decision");
}

function refusalHead(status: number, phrase: string, mark: string): string {
  return `HTTP/1.1 ${status} ${phrase}\r\nContent-Type: text/plain\r\nX-Proxy-Error: ${mark}\r\nConnection: close\r\n\r\n`;
}

// The reply for a failed decision or dial; a transport failure is recorded here.
function failureReply(lane: Lane, host: string, port: number, error: unknown): { status: number; phrase: string; mark: string; body: string } {
  if (error instanceof Refusal) return { status: 403, phrase: error.message, mark: "blocked-by-allowlist", body: "Connection blocked by network allowlist" };
  const failure = error instanceof TransportFailure ? error : new TransportFailure("connect", "upstream connection failed");
  addViolation(`fail network-outbound ${host}:${port} (${failure.kind}: ${failure.message})`, lane.encodedKey);
  const status = failure.kind === "timeout" ? 504 : 502;
  return { status, phrase: status === 504 ? "Gateway Timeout" : "Bad Gateway", mark: `transport-${failure.kind}`, body: failure.message };
}

type Credential = "ok" | "missing" | "foreign";

function checkCredential(lane: Lane, header: string | undefined): Credential {
  const match = /^basic\s+(?<blob>[a-z0-9+/=]+)\s*$/iu.exec(header ?? "");
  if (match?.groups?.blob === undefined) return "missing";
  const decoded = Buffer.from(match.groups.blob, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) return "missing";
  const secret = Buffer.from(decoded.slice(separator + 1));
  const expected = Buffer.from(lane.secret);
  if (secret.length !== expected.length || !timingSafeEqual(secret, expected)) return "missing";
  return decoded.slice(0, separator) === lane.encodedKey ? "ok" : "foreign";
}

const PROXY_AUTH_REQUIRED = "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"egress relay\"\r\nConnection: close\r\n\r\n";

function parseAuthority(target: string): { host: string; port: number } | undefined {
  const match = /^(?:\[(?<v6>[^\]]+)\]|(?<name>[^:[\]]+)):(?<port>[1-9]\d{0,4})$/u.exec(target);
  const host = match?.groups?.v6 ?? match?.groups?.name;
  if (host === undefined || Number(match?.groups?.port) > 65535) return undefined;
  return { host, port: Number(match?.groups?.port) };
}

async function handleConnect(lane: Lane, req: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
  client.on("error", () => client.destroy());
  const end = (payload: string): void => {
    if (client.destroyed || !client.writable) client.destroy();
    else client.end(payload);
  };
  const credential = checkCredential(lane, req.headers["proxy-authorization"]);
  if (credential === "missing") return end(PROXY_AUTH_REQUIRED);
  const target = parseAuthority(req.url ?? "");
  if (target === undefined) return end(refusalHead(400, "Bad Request", "bad-request"));
  const { host, port } = target;
  let opened: Opened;
  try {
    if (credential === "foreign") throw deny(lane, host, port, "proxy username does not match the listener");
    const pin = await decideDestination(lane, host, port, false);
    if (client.destroyed) return;
    trackConnection(lane, host, port, client);
    opened = await openRoute(lane, host, port, false, pin);
  } catch (error) {
    const reply = failureReply(lane, host, port, error);
    return end(`${refusalHead(reply.status, reply.phrase, reply.mark)}${reply.body}`);
  }
  const upstream = opened.socket;
  if (client.destroyed || lane.ended) {
    upstream.destroy();
    client.destroy();
    return;
  }
  upstream.once("close", () => client.destroy());
  client.once("close", () => upstream.destroy());
  // HTTP/1.0 on purpose: a client that reads only a 1.0 status line must still get its tunnel.
  client.write("HTTP/1.0 200 Connection Established\r\n\r\n");
  if (opened.rest.length > 0) client.write(opened.rest);
  if (head.length > 0) upstream.write(head);
  upstream.pipe(client);
  client.pipe(upstream);
}

const HOP_BY_HOP = new Set(["connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "te", "trailer", "upgrade"]);

function forwardedHeaders(raw: readonly string[], connection: string | undefined): string[] {
  const named = new Set((connection ?? "").split(",").map((name) => name.trim().toLowerCase()).filter((name) => name !== ""));
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? "";
    if (HOP_BY_HOP.has(name.toLowerCase()) || named.has(name.toLowerCase())) continue;
    out.push(name, raw[i + 1] ?? "");
  }
  return out;
}

async function handleRequest(lane: Lane, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const respond = (status: number, phrase: string, mark: string, body: string, extra: Record<string, string> = {}): void => {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.writeHead(status, phrase, { "Content-Type": "text/plain", "X-Proxy-Error": mark, Connection: "close", ...extra });
    res.end(`${body}\n`);
  };
  const credential = checkCredential(lane, req.headers["proxy-authorization"]);
  if (credential === "missing") {
    return respond(407, "Proxy Authentication Required", "proxy-auth", "proxy authentication required", { "Proxy-Authenticate": "Basic realm=\"egress relay\"" });
  }
  let url: URL | undefined;
  try {
    url = /^http:\/\//iu.test(req.url ?? "") ? new URL(req.url ?? "") : undefined;
  } catch {
    url = undefined;
  }
  if (url === undefined || url.username !== "" || url.password !== "") return respond(400, "Bad Request", "bad-request", "absolute http URL required");
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port === "" ? 80 : Number(url.port);
  let opened: Opened;
  try {
    if (credential === "foreign") throw deny(lane, host, port, "proxy username does not match the listener");
    const pin = await decideDestination(lane, host, port, true);
    if (res.destroyed) return;
    trackConnection(lane, host, port, req.socket);
    opened = await openRoute(lane, host, port, true, pin);
  } catch (error) {
    const reply = failureReply(lane, host, port, error);
    return respond(reply.status, error instanceof Refusal ? "Forbidden" : reply.phrase, reply.mark, error instanceof Refusal ? error.message : reply.body);
  }
  const headers = forwardedHeaders(req.rawHeaders, req.headers.connection);
  headers.push("Connection", "close");
  if (opened.proxy?.authorization !== undefined) headers.push("Proxy-Authorization", opened.proxy.authorization);
  const forward = http.request({
    createConnection: () => opened.socket as net.Socket,
    method: req.method,
    path: opened.proxy !== undefined ? url.href : `${url.pathname}${url.search}`,
    headers,
    setHost: false,
  });
  res.once("close", () => forward.destroy());
  forward.on("response", (upstream) => {
    if (opened.proxy !== undefined && upstream.statusCode === 407) {
      upstream.resume();
      forward.destroy();
      return respond(403, "Forbidden", "blocked-by-allowlist", deny(lane, host, port, "upstream proxy requires authentication").message);
    }
    res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, forwardedHeaders(upstream.rawHeaders, upstream.headers.connection));
    // A response cut short is never left looking like one still in progress.
    upstream.once("error", () => res.destroy());
    upstream.once("close", () => {
      if (!upstream.complete) res.destroy();
    });
    upstream.pipe(res);
  });
  forward.on("error", () => {
    const reply = failureReply(lane, host, port, new TransportFailure("connect", "upstream connection failed"));
    respond(reply.status, reply.phrase, reply.mark, reply.body);
  });
  req.pipe(forward);
}

// Whether any process is left in the group; only "no such process" means none.
function processGroupAlive(group: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// Open the invocation's relay. Throws unless the service is started (which requires the ask callback); a token has one relay for the session.
export async function openEgressRelay(token: string, admission?: InvocationProxyAdmission): Promise<EgressRelay> {
  const current = service;
  if (current === undefined) throw new Error("egress relay: the service is not started");
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH || token.length > 100 || !/^[\x21-\x7e]+$/u.test(token)) {
    throw new Error("egress relay: the invocation token is not usable");
  }
  admission?.assertCanBind();
  if (lanes.size >= current.maxRelays) throw new Error("egress relay: too many invocation relays");
  if (retiredKeys.has(token) || lanes.has(token)) throw new Error("egress relay: the invocation already had a relay");
  const state: Lane = {
    key: token,
    encodedKey: Buffer.from(token).toString("base64"),
    secret: randomBytes(32).toString("hex"),
    ports: new Set(),
    sockets: new Set(),
    ended: false,
  };
  let accepting = false;
  const server = http.createServer((req, res) => {
    void handleRequest(state, req, res).catch(() => res.destroy());
  });
  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    void handleConnect(state, req, client, head).catch(() => client.destroy());
  });
  // No protocol switch is relayed: an upgrade request gets no tunnel.
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const status = error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request";
    // The reply is flushed before the close; a client that never reads it is dropped.
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    setTimeout(() => socket.destroy(), CLIENT_ERROR_LINGER_MS).unref();
  });
  server.prependListener("connection", (socket: net.Socket) => {
    if (!accepting || state.ended || admission?.acceptsConnections() === false) {
      socket.destroy();
      return;
    }
    own(state, socket);
  });
  // Ending the admission stops every forward at once; the port stays bound until close, and the key attributes nothing again.
  const revoke = (): void => {
    state.ended = true;
    retiredKeys.add(token);
    for (const socket of state.sockets) socket.destroy();
    state.sockets.clear();
  };
  let binding: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const unbind = (): Promise<void> => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => (error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING" ? resolve() : reject(error)));
  });
  // The ended relay keeps its port bound, answering nothing, so no later listener gets it and it stays refused as a destination.
  const holdBack = (hold: EndedPortHold, processGroup: number | undefined): void => {
    const endedAt = Date.now();
    let timer: NodeJS.Timeout;
    const held = {
      ports: state.ports,
      release: async (): Promise<void> => {
        clearTimeout(timer);
        heldBack.delete(held);
        await unbind();
      },
    };
    const arm = (): void => {
      timer = setTimeout(() => {
        const alive = processGroup !== undefined && (hold.groupAlive ?? processGroupAlive)(processGroup);
        if (alive && Date.now() - endedAt + hold.ms <= hold.maxMs) arm();
        else void held.release().catch(() => {});
      }, hold.ms);
      timer.unref();
    };
    heldBack.add(held);
    arm();
  };
  const close = (options?: { readonly processGroup?: number }): Promise<void> => {
    revoke();
    admission?.signal.removeEventListener("abort", revoke);
    closing ??= (async () => {
      await binding?.catch(() => {});
      const hold = service === current ? current.endedPortHold : undefined;
      if (server.listening && hold !== undefined && hold.ms > 0) {
        const group = options?.processGroup;
        holdBack(hold, Number.isInteger(group) && (group as number) > 1 ? group : undefined);
      } else {
        await unbind();
      }
      if (lanes.get(token) === lane) lanes.delete(token);
    })().catch((error: unknown) => {
      // The port may still be bound: a later close tries again.
      closing = undefined;
      throw error;
    });
    return closing;
  };
  const lane = Object.assign(state, { close });
  lanes.set(token, lane);
  // From here the admission's owner closes the relay, whatever happens while it opens.
  admission?.adopt(() => close());
  admission?.signal.addEventListener("abort", revoke, { once: true });
  let port: number;
  try {
    binding = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    await binding;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("egress relay: the listener has no TCP address");
    port = address.port;
    state.ports.add(port);
    // A listener error after this point ends the relay instead of reaching the process.
    server.on("error", () => void close().catch(() => {}));
    server.unref();
    admission?.assertCanBind();
    if (state.ended) throw new Error("egress relay: invocation ended while opening");
  } catch (error) {
    if (admission === undefined) {
      try {
        await close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "egress relay: opening and closing failed");
      }
    }
    throw error;
  }
  accepting = true;
  return {
    port,
    proxyAuthorization: `Basic ${Buffer.from(`${state.encodedKey}:${state.secret}`).toString("base64")}`,
    registerPort(listenerPort: number): void {
      if (state.ended || !Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65535) {
        throw new Error("egress relay: invalid listener port");
      }
      state.ports.add(listenerPort);
    },
    recordRefusal(host: string, refusedPort: number | undefined, reason: string): void {
      if (refusedPort === undefined) addViolation(`deny http-request CONNECT ${host} (${oneLine(reason)})`, state.encodedKey);
      else addViolation(`deny network-outbound ${host}:${refusedPort} (${oneLine(reason)})`, state.encodedKey);
    },
    close,
  };
}
