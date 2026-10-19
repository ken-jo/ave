/**
 * Upstream proxy routing for the sandbox egress proxy (owner decision
 * 2026-10-20: environment variables + OS proxy settings including PAC +
 * an explicit Settings URL).
 *
 * The carried ASRT patch (part 4) asks a route hook once per destination
 * decision, only after the ask callback allowed the destination by name (part
 * 5: a destination refused by name is never looked up here), and dials the
 * allowed connection over the answered routes in order. This module is that hook. Per destination:
 *
 *   - Settings "Off": DIRECT.
 *   - Settings "Manual": the configured proxy, or DIRECT for a host on its
 *     bypass list.
 *   - Settings "Use system settings" (default):
 *       1. the app process's own proxy environment, when any of
 *          HTTPS_PROXY/HTTP_PROXY/ALL_PROXY is set (either case; the lower
 *          case wins, curl's order: `<scheme>_proxy`, then `all_proxy`;
 *          NO_PROXY bypasses). Only the environment then decides: a scheme
 *          with no variable goes DIRECT, as in curl.
 *       2. otherwise the OS configuration as Chromium resolves it for the
 *          destination (`session.resolveProxy`: macOS system settings,
 *          Windows WinINET/WinHTTP, Linux environment/GNOME/KDE, PAC and
 *          WPAD), which can answer differently per destination and a list to
 *          fall back through. Chromium applies the OS bypass list itself.
 *       3. without a resolver (headless host), DIRECT.
 *
 * SOCKS proxies (environment `socks5://…`, PAC `SOCKS`/`SOCKS5`) are passed
 * over with a reason: ASRT has no SOCKS client to dial an upstream with. An
 * answer with nothing usable left refuses the destination with a reason,
 * never DIRECT. A PAC answer is network input (WPAD), so ASRT also refuses a
 * route that reaches one of its own listeners.
 *
 * Ave never fetches a PAC file or the destination here: `resolveProxy`
 * evaluates the configuration Chromium already holds (Chromium fetches the
 * PAC/WPAD script itself). The URL handed to it is built from the canonical
 * host and port only, never from client bytes.
 *
 * Credentials (a `user:pass@` in an environment or manual URL) go to the
 * proxy as Basic and nowhere else: not to the sandboxed process (it sees only
 * Ave's per-invocation proxy), not to logs or audit rows, not to the renderer
 * (Settings sees whether credentials are sent, never the values).
 */
import { BlockList, isIP } from "node:net";
import {
  canonicalizeHost,
  formatAuthority,
  isValidHost,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import { isLoopbackAddress } from "@anthropic-ai/sandbox-runtime/dist/sandbox/address.js";
import type { ParentProxyRoute, ParentProxyRouter } from "@anthropic-ai/sandbox-runtime";
import { parsePacAnswer } from "../shared/pac-proxy.js";
import {
  UPSTREAM_PROXY_CREDENTIALS_SECRET,
  type UpstreamProxyDiagnostic,
  type UpstreamProxyRouteView,
  type UpstreamProxySettings,
  type UpstreamProxySource,
} from "../shared/upstream-proxy.js";

/** A proxy URL from the environment or Settings, parsed; `auth` only when the URL carries one. */
export type ParsedProxyUrl =
  | { ok: true; scheme: "http" | "https"; host: string; port: number; auth?: { username: string; password: string } }
  | { ok: false; reason: "socks" | "unsupported-scheme" | "malformed" };

/** curl's default ports: 1080 for an `http://` proxy without one, 443 for `https://`. */
const DEFAULT_PROXY_PORT = { http: 1080, https: 443 } as const;

/**
 * Parse a proxy URL the way curl reads `*_proxy`: a scheme-less `host:port`
 * is HTTP; `http://` and `https://` are proxies Ave can dial; `socks*://` is
 * recognised and refused. User name and password are percent-decoded.
 */
export function parseProxyUrl(raw: string): ParsedProxyUrl {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "malformed" };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme.startsWith("socks")) return { ok: false, reason: "socks" };
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") return { ok: false, reason: "unsupported-scheme" };
  let url: URL;
  try {
    url = new URL(scheme === undefined ? `http://${text}` : text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const kind = url.protocol === "https:" ? "https" : "http";
  const bare = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const host = canonicalizeHost(bare);
  if (host === undefined || !isValidHost(host)) return { ok: false, reason: "malformed" };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") return { ok: false, reason: "malformed" };
  const port = url.port === "" ? DEFAULT_PROXY_PORT[kind] : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "malformed" };
  if (url.username === "" && url.password === "") return { ok: true, scheme: kind, host, port };
  try {
    return { ok: true, scheme: kind, host, port, auth: { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** `host:port` of a proxy as Settings and logs show it (IPv6 bracketed). */
function endpointOf(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * A parsed proxy's origin, `scheme://host:port` (IPv6 bracketed, the port
 * always written): the form Settings stores the manual URL in, and what
 * stored credentials are bound to.
 */
export function proxyOrigin(proxy: { scheme: "http" | "https"; host: string; port: number }): string {
  return `${proxy.scheme}://${endpointOf(proxy.host, proxy.port)}`;
}

/** The manual proxy's stored credentials, bound to the origin they were entered for. */
export interface StoredProxyCredentials {
  username: string;
  password: string;
  /** `scheme://host:port` of the manual proxy they were saved with; sent only to that proxy. */
  origin: string;
}

/** The variable names that make "Use system settings" mean the environment. */
const ENV_PROXY_VARS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"] as const;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/** Whether the app process was started with a proxy environment (any of the six variables set and non-empty). */
export function environmentProxyConfigured(env: NodeJS.ProcessEnv): boolean {
  return ENV_PROXY_VARS.some((name) => envValue(env, name) !== undefined);
}

/**
 * The environment proxy for a scheme, curl's order (lower case first):
 * `https_proxy`/`HTTPS_PROXY` or `http_proxy`/`HTTP_PROXY`, then
 * `all_proxy`/`ALL_PROXY`. (curl itself ignores upper-case HTTP_PROXY, a CGI
 * safeguard that does not apply to a desktop app's own environment; Ave reads
 * both, as Settings promises.)
 */
export function environmentProxyFor(env: NodeJS.ProcessEnv, scheme: "http" | "https"): { name: string; value: string } | undefined {
  const order = scheme === "https"
    ? ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]
    : ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"];
  for (const name of order) {
    const value = envValue(env, name);
    if (value !== undefined) return { name, value };
  }
  return undefined;
}

/** The environment's NO_PROXY list (`no_proxy` first). */
function environmentNoProxy(env: NodeJS.ProcessEnv): string {
  return envValue(env, "no_proxy") ?? envValue(env, "NO_PROXY") ?? "";
}

/** One NO_PROXY entry, parsed. */
type BypassEntry =
  | { kind: "all" }
  | { kind: "name"; name: string; port?: number }
  | { kind: "address"; block: BlockList; port?: number };

function addressBlock(address: string, prefix?: number): BlockList | undefined {
  const family = isIP(address);
  if (family === 0) return undefined;
  const type = family === 4 ? "ipv4" : "ipv6";
  const max = family === 4 ? 32 : 128;
  const bits = prefix ?? max;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return undefined;
  const block = new BlockList();
  block.addSubnet(address, bits, type);
  return block;
}

function parseBypassEntry(raw: string): BypassEntry | undefined {
  let entry = raw.toLowerCase();
  if (entry === "*") return { kind: "all" };
  // CIDR (curl 7.86+): `10.0.0.0/8`, `2001:db8::/32`, never with a port.
  const slash = entry.indexOf("/");
  if (slash !== -1) {
    const prefix = entry.slice(slash + 1);
    if (!/^\d{1,3}$/u.test(prefix)) return undefined;
    const block = addressBlock(entry.slice(0, slash).replace(/^\[|\]$/gu, ""), Number(prefix));
    return block === undefined ? undefined : { kind: "address", block };
  }
  // A port narrows the entry to that port (`host:8080`, `[v6]:8080`,
  // `192.0.2.1:8080`); curl has no port form and would never match such an
  // entry, Go and Python match it on that port only, which is what it says.
  let port: number | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(entry);
  if (bracketed) {
    entry = bracketed[1]!;
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
  } else if (isIP(entry) === 0) {
    const withPort = /^(.*):(\d{1,5})$/u.exec(entry);
    if (withPort) {
      entry = withPort[1]!;
      port = Number(withPort[2]);
    }
  }
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  const block = addressBlock(entry);
  if (block !== undefined) return { kind: "address", block, ...(port !== undefined ? { port } : {}) };
  // A name: curl ignores a leading and a trailing dot (`*.` is the same as a
  // leading dot here); it then matches the name and every name under it.
  const name = entry.replace(/^\*\./u, ".").replace(/^\./u, "").replace(/\.$/u, "");
  if (name.length === 0 || !isValidHost(name)) return undefined;
  return { kind: "name", name, ...(port !== undefined ? { port } : {}) };
}

/**
 * Whether `host:port` is on a NO_PROXY-style list, in curl's semantics:
 * entries separated by commas or blanks; `*` matches everything; a name
 * matches itself and every name under it at a dot boundary (a leading dot,
 * `*.` and a trailing dot on either side are ignored); an IP address matches
 * that address and a CIDR range its addresses, for an address destination
 * only. An entry with a port (`example.com:8080`) matches only that port.
 * This host's loopback always bypasses.
 */
export function bypassesProxy(list: string, host: string, port: number): boolean {
  const bare = host.replace(/^\[|\]$/gu, "").toLowerCase().replace(/\.$/u, "");
  if (bare === "localhost" || isLoopbackAddress(bare)) return true;
  const family = isIP(bare);
  for (const raw of list.split(/[\s,]+/u)) {
    if (raw.length === 0) continue;
    const entry = parseBypassEntry(raw);
    if (entry === undefined) continue;
    if (entry.kind === "all") return true;
    if (entry.port !== undefined && entry.port !== port) continue;
    if (entry.kind === "address") {
      if (family !== 0 && entry.block.check(bare, family === 4 ? "ipv4" : "ipv6")) return true;
    } else if (family === 0 && (bare === entry.name || bare.endsWith(`.${entry.name}`))) {
      return true;
    }
  }
  return false;
}

/** One destination's routes, with what Settings shows about them. */
export interface UpstreamRouteAnswer {
  routes: ParentProxyRoute[];
  reason?: string;
  source: UpstreamProxySource;
  envVar?: string;
  views: UpstreamProxyRouteView[];
  skipped: string[];
  /** A failure worth asking again for (the resolver threw); never cached. */
  transient?: boolean;
}

export interface UpstreamProxyRouterDeps {
  /** The live `upstreamProxy` setting (read per decision, so a change applies without restart). */
  settings: () => UpstreamProxySettings;
  /** The manual proxy's stored credentials, or null. Sent only when their origin is the manual proxy's. */
  manualCredentials: () => StoredProxyCredentials | null;
  /** The app process's environment. */
  env: () => NodeJS.ProcessEnv;
  /** Chromium's PAC resolution (`session.resolveProxy`); absent on a host without one. */
  resolveProxy?: (url: string) => Promise<string>;
  /** Called when entries were passed over for a destination (for the audit row). */
  onSkipped?: (event: { host: string; port: number; source: UpstreamProxySource; skipped: string[] }) => void;
  now?: () => number;
  /** How long one destination's answer is reused. Default 45 s. */
  ttlMs?: number;
  /** At most this many destinations are cached. Default 512. */
  maxEntries?: number;
  /** At most this many `resolveProxy` calls run at once; more wait. Default 4. */
  maxConcurrentResolves?: number;
  /** At most this many wait; beyond that a lookup fails (transient, not cached). Default 256. */
  maxQueuedResolves?: number;
}

/**
 * `fn` with at most `max` calls in flight and at most `maxQueued` waiting;
 * a call beyond that rejects at once. Each PAC evaluation can run the
 * script's own DNS lookups, so a burst of new destinations must not fan out
 * into as many concurrent evaluations.
 */
export function limitConcurrency<A, R>(fn: (arg: A) => Promise<R>, max: number, maxQueued: number): (arg: A) => Promise<R> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    while (active < max && queue.length > 0) {
      active += 1;
      queue.shift()!();
    }
  };
  return (arg) => new Promise<R>((resolve, reject) => {
    if (queue.length >= maxQueued) {
      reject(new Error("too many proxy lookups waiting"));
      return;
    }
    queue.push(() => {
      let pending: Promise<R>;
      try {
        pending = fn(arg);
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(resolve, reject).finally(() => {
        active -= 1;
        next();
      });
    });
    next();
  });
}

const SOCKS_SKIP = "a SOCKS proxy, which the sandbox cannot use as an upstream";

function proxyRoute(
  scheme: "http" | "https",
  host: string,
  port: number,
  auth: { username: string; password: string } | undefined,
  resolvesNames: boolean,
): { route: ParentProxyRoute; view: UpstreamProxyRouteView } {
  return {
    route: { kind: scheme, host, port, ...(auth ? { auth } : {}), ...(resolvesNames ? { resolvesNames: true } : {}) },
    view: { kind: scheme, endpoint: endpointOf(host, port), ...(auth ? { credentials: true } : {}) },
  };
}

const DIRECT: { route: ParentProxyRoute; view: UpstreamProxyRouteView } = { route: { kind: "direct" }, view: { kind: "direct" } };

function answer(source: UpstreamProxySource, entries: Array<{ route: ParentProxyRoute; view: UpstreamProxyRouteView }>, extra: Partial<UpstreamRouteAnswer> = {}): UpstreamRouteAnswer {
  return {
    routes: entries.map((entry) => entry.route),
    views: entries.map((entry) => entry.view),
    skipped: [],
    source,
    ...extra,
  };
}

/**
 * The routes for one destination under the current settings. `host` must be
 * canonical (ASRT hands the hook its canonical spelling); anything else is
 * refused rather than handed to the resolver.
 */
export async function upstreamRoutesFor(
  deps: UpstreamProxyRouterDeps,
  destination: { host: string; port: number; scheme: "http" | "https" },
): Promise<UpstreamRouteAnswer> {
  const settings = deps.settings();
  const host = canonicalizeHost(destination.host);
  const { port, scheme } = destination;
  if (host === undefined || host !== destination.host || !isValidHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return answer("off", [], { reason: "the destination is not a canonical host and port" });
  }
  if (settings.mode === "off") return answer("off", [DIRECT]);

  if (settings.mode === "manual") {
    if (bypassesProxy(settings.bypass, host, port)) return answer("manual-bypass", [DIRECT]);
    const parsed = parseProxyUrl(settings.manualUrl);
    if (!parsed.ok) {
      return answer("manual", [], {
        reason: parsed.reason === "socks"
          ? `the upstream proxy in Settings is ${SOCKS_SKIP}`
          : "the upstream proxy URL in Settings is not usable",
      });
    }
    // Credentials go only to the proxy they were entered for: a changed host,
    // port or scheme never receives the old one's password.
    const stored = deps.manualCredentials();
    const auth = stored !== null && stored.origin === proxyOrigin(parsed)
      ? { username: stored.username, password: stored.password }
      : undefined;
    return answer("manual", [proxyRoute(parsed.scheme, parsed.host, parsed.port, auth, settings.resolvesNames)]);
  }

  const env = deps.env();
  if (environmentProxyConfigured(env)) {
    const chosen = environmentProxyFor(env, scheme);
    if (chosen === undefined) return answer("environment", [DIRECT]);
    if (bypassesProxy(environmentNoProxy(env), host, port)) return answer("environment-bypass", [DIRECT], { envVar: chosen.name });
    const parsed = parseProxyUrl(chosen.value);
    if (!parsed.ok) {
      const what = parsed.reason === "socks" ? SOCKS_SKIP : "not a usable proxy URL";
      return answer("environment", [], { envVar: chosen.name, skipped: [`${chosen.name} (${what})`], reason: `the proxy in ${chosen.name} is ${what}` });
    }
    return answer("environment", [proxyRoute(parsed.scheme, parsed.host, parsed.port, parsed.auth, settings.resolvesNames)], { envVar: chosen.name });
  }

  if (!deps.resolveProxy) return answer("system-unavailable", [DIRECT]);
  // Built from the canonical host and port only: Chromium evaluates its PAC
  // or system configuration for this URL and fetches nothing from it.
  const url = `${scheme}://${formatAuthority(host, port, scheme === "https" ? 443 : 80)}/`;
  let pac: string;
  try {
    pac = await deps.resolveProxy(url);
  } catch {
    return answer("system", [], { reason: "the system proxy configuration could not be read", transient: true });
  }
  const entries: Array<{ route: ParentProxyRoute; view: UpstreamProxyRouteView }> = [];
  const skipped: string[] = [];
  for (const entry of parsePacAnswer(typeof pac === "string" ? pac : "")) {
    if (entry.kind === "direct") entries.push(DIRECT);
    // Never trusted to resolve names: a PAC or WPAD answer is network input
    // (any host on the network can serve WPAD), and the opt-in is for a proxy
    // the person named, in Settings or in the environment.
    else if (entry.kind === "proxy") entries.push(proxyRoute(entry.scheme, entry.host, entry.port, undefined, false));
    else skipped.push(`${entry.entry} (${entry.reason === "socks" ? SOCKS_SKIP : entry.reason === "malformed" ? "not a usable entry" : "a kind the sandbox cannot use"})`);
  }
  if (entries.length === 0) {
    return answer("system", [], { skipped, reason: "the system proxy settings offer no route the sandbox can use (SOCKS proxies are not supported)" });
  }
  return answer("system", entries, { skipped });
}

/**
 * The route hook for ASRT, with a short per-destination cache (the OS
 * configuration does not change between two connections a second apart, and
 * a PAC evaluation is not free). Electron has no proxy-change event, so the
 * TTL bounds how long an OS change takes to apply; a Settings change clears
 * the cache at once ({@link UpstreamProxyRouter.invalidate}).
 */
export interface UpstreamProxyRouter {
  router: ParentProxyRouter;
  invalidate(): void;
  /** What the routes for `url` would be now (uncached), for the Settings diagnostic line. */
  describe(url: string): Promise<UpstreamProxyDiagnostic>;
}

export function createUpstreamProxyRouter(input: UpstreamProxyRouterDeps): UpstreamProxyRouter {
  const deps: UpstreamProxyRouterDeps = input.resolveProxy === undefined
    ? input
    : { ...input, resolveProxy: limitConcurrency(input.resolveProxy, input.maxConcurrentResolves ?? 4, input.maxQueuedResolves ?? 256) };
  const ttlMs = deps.ttlMs ?? 45_000;
  const maxEntries = deps.maxEntries ?? 512;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<UpstreamRouteAnswer> }>();
  let generation = 0;

  const lookup = (destination: { host: string; port: number; scheme: "http" | "https" }): Promise<UpstreamRouteAnswer> => {
    const key = `${destination.scheme}\n${destination.host}\n${destination.port}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const started = generation;
    const value = upstreamRoutesFor(deps, destination).then((result) => {
      if (result.skipped.length > 0) {
        deps.onSkipped?.({ host: destination.host, port: destination.port, source: result.source, skipped: result.skipped });
      }
      return result;
    });
    cache.delete(key);
    cache.set(key, { at: now(), value });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    // A failed or superseded lookup is not reused.
    value.then((result) => {
      if (generation !== started || result.transient === true) {
        if (cache.get(key)?.value === value) cache.delete(key);
      }
    }, () => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  };

  return {
    router: async (destination) => {
      const result = await lookup(destination);
      return result.reason !== undefined ? { routes: result.routes, reason: result.reason } : { routes: result.routes };
    },
    invalidate: () => {
      generation += 1;
      cache.clear();
    },
    describe: (url) => describeUpstreamProxy(deps, url),
  };
}

/** What the routes for `url` would be now (uncached), for the Settings diagnostic line. */
export async function describeUpstreamProxy(deps: UpstreamProxyRouterDeps, url: string): Promise<UpstreamProxyDiagnostic> {
  const parsed = new URL(url);
  const scheme = parsed.protocol === "http:" ? "http" : "https";
  const bare = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const host = canonicalizeHost(bare) ?? bare;
  const defaultPort = scheme === "https" ? 443 : 80;
  const port = parsed.port === "" ? defaultPort : Number(parsed.port);
  const result = await upstreamRoutesFor(deps, { host, port, scheme });
  return {
    url: `${scheme}://${formatAuthority(host, port, defaultPort)}/`,
    source: result.source,
    ...(result.envVar !== undefined ? { envVar: result.envVar } : {}),
    routes: result.views,
    skipped: result.skipped,
    ...(result.reason !== undefined ? { refusal: result.reason } : {}),
  };
}

/** The settings reads the router needs, structurally (no dependency on the store module). */
export interface UpstreamProxySettingsSource {
  get(key: "upstreamProxy"): UpstreamProxySettings;
  getSecret(key: string): string | null;
}

/** Router deps over the live settings, the app's environment and Chromium's resolver. */
export function upstreamProxyDeps(
  settings: UpstreamProxySettingsSource,
  resolveProxy: ((url: string) => Promise<string>) | undefined,
  onSkipped?: UpstreamProxyRouterDeps["onSkipped"],
): UpstreamProxyRouterDeps {
  return {
    settings: () => settings.get("upstreamProxy"),
    manualCredentials: () => parseStoredProxyCredentials(settings.getSecret(UPSTREAM_PROXY_CREDENTIALS_SECRET)),
    env: () => process.env,
    ...(resolveProxy ? { resolveProxy } : {}),
    ...(onSkipped ? { onSkipped } : {}),
  };
}

/**
 * Parse the stored manual credentials (`{ username, password, origin }`
 * JSON), or null. An entry without its origin is treated as absent: it is
 * never sent anywhere.
 */
export function parseStoredProxyCredentials(stored: string | null): StoredProxyCredentials | null {
  if (stored === null) return null;
  try {
    const value = JSON.parse(stored) as Partial<Record<keyof StoredProxyCredentials, unknown>> | null;
    if (value && typeof value === "object" && typeof value.username === "string"
      && typeof value.password === "string" && typeof value.origin === "string" && value.origin.length > 0) {
      return { username: value.username, password: value.password, origin: value.origin };
    }
  } catch {
    // A corrupt entry is treated as absent; Settings shows no stored credentials.
  }
  return null;
}
