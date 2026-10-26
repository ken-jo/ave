// Route only after destination-name approval: off is direct, manual honors bypass, and system mode prefers proxy env before OS resolution, then direct only when no resolver exists. Environment proxy selection is scheme-specific with lowercase precedence; unusable/SOCKS-only routes deny and proxy routes must never reach internal listeners.
// Build resolver URLs only from canonical host/port, never client bytes. Upstream credentials go only to proxy authentication, never child env, logs, audit or renderer; confined processes see only their invocation proxy.
import { BlockList, isIP } from "node:net";
import {
  canonicalizeHost,
  formatAuthority,
  isValidHost,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import { isLoopbackAddress } from "@anthropic-ai/sandbox-runtime/dist/sandbox/address.js";
import type { ParentProxyRoute, ParentProxyRouter } from "@anthropic-ai/sandbox-runtime";
import { parsePacAnswer } from "../shared/pac-proxy.js";
import { egressDestinationNetwork } from "./egress-grants.js";
import {
  UPSTREAM_PROXY_CREDENTIALS_SECRET,
  type UpstreamProxyDiagnostic,
  type UpstreamProxyRouteView,
  type UpstreamProxySettings,
  type UpstreamProxySource,
} from "../shared/upstream-proxy.js";

// A proxy URL from the environment or Settings, parsed; `auth` only when the URL carries one.
export type ParsedProxyUrl =
  | { ok: true; scheme: "http" | "https"; host: string; port: number; auth?: { username: string; password: string } }
  | { ok: false; reason: "socks" | "unsupported-scheme" | "malformed" };

// curl's default ports: 1080 for an `http://` proxy without one, 443 for `https://`.
const DEFAULT_PROXY_PORT = { http: 1080, https: 443 } as const;

// Parse a proxy URL the way curl reads `*_proxy`: a scheme-less `host:port` is HTTP; `http://` and `https://` are proxies Ave can dial; `socks*://` is recognised and refused. User name and password are percent-decoded.
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
  // URL removes an explicitly written default port; retain the authority so credentials remain bound to the service the person actually named.
  const authority = (scheme === undefined ? text : text.slice(text.indexOf("://") + 3)).split(/[/?#\\]/u)[0]!;
  const endpoint = authority.slice(authority.lastIndexOf("@") + 1);
  if (endpoint.length === 0) return { ok: false, reason: "malformed" };
  const explicitPort = endpoint.startsWith("[")
    ? /^\[[^\]]+\]:(.*)$/u.exec(endpoint)?.[1]
    : /:([^:]*)$/u.exec(endpoint)?.[1];
  if (explicitPort !== undefined && !/^\d+$/u.test(explicitPort)) return { ok: false, reason: "malformed" };
  const port = explicitPort === undefined ? DEFAULT_PROXY_PORT[kind] : Number(explicitPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "malformed" };
  if (url.username === "" && url.password === "") return { ok: true, scheme: kind, host, port };
  try {
    return { ok: true, scheme: kind, host, port, auth: { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

// `host:port` of a proxy as Settings and logs show it (IPv6 bracketed).
function endpointOf(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

// A parsed proxy's origin, `scheme://host:port` (IPv6 bracketed, the port always written): the form Settings stores the manual URL in, and what stored credentials are bound to.
export function proxyOrigin(proxy: { scheme: "http" | "https"; host: string; port: number }): string {
  return `${proxy.scheme}://${endpointOf(proxy.host, proxy.port)}`;
}

// The manual proxy's stored credentials, bound to the origin they were entered for.
export interface StoredProxyCredentials {
  username: string;
  password: string;
  // `scheme://host:port` of the manual proxy they were saved with; sent only to that proxy.
  origin: string;
}

// The variable names that make "Use system settings" mean the environment.
const ENV_PROXY_VARS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"] as const;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

// Whether the app process was started with a proxy environment (any of the six variables set and non-empty).
export function environmentProxyConfigured(env: NodeJS.ProcessEnv): boolean {
  return ENV_PROXY_VARS.some((name) => envValue(env, name) !== undefined);
}

// The environment proxy for a scheme, curl's order (lower case first): `https_proxy`/`HTTPS_PROXY` or `http_proxy`/`HTTP_PROXY`, then `all_proxy`/`ALL_PROXY`. (curl itself ignores upper-case HTTP_PROXY, a CGI safeguard that does not apply to a desktop app's own environment; Ave reads both, as Settings promises.)
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

// The environment's NO_PROXY list (`no_proxy` first).
function environmentNoProxy(env: NodeJS.ProcessEnv): string {
  return env.no_proxy !== undefined && env.no_proxy.length > 0 ? env.no_proxy : env.NO_PROXY ?? "";
}

// Match a literal address or CIDR entry without crossing address families.
function bypassAddressMatches(token: string, host: string, family: 4 | 6): boolean {
  if (token.length >= 128) return false;
  const slash = token.indexOf("/");
  const address = slash === -1 ? token : token.slice(0, slash);
  if (address.includes("%") || isIP(address) !== family) return false;
  const prefix = slash === -1 ? undefined : token.slice(slash + 1);
  if (prefix !== undefined && !/^\d+$/u.test(prefix)) return false;
  const max = family === 4 ? 32 : 128;
  let bits = prefix === undefined ? max : Number(prefix);
  if (!Number.isSafeInteger(bits) || bits > max) return false;
  // A zero IPv4 prefix bypasses all only when its network is also zero.
  if (family === 4 && bits === 0 && address !== "0.0.0.0") bits = 32;
  const type = family === 4 ? "ipv4" : "ipv6";
  const block = new BlockList();
  block.addSubnet(address, bits, type);
  return block.check(host, type);
}

// Match a NO_PROXY list: only a raw singleton `*` bypasses everything. Commas separate tokens; spaces and tabs surround them but do not separate entries. A domain matches itself and subdomains, ignoring one leading and trailing dot. Address entries use their own family, with optional CIDR. Ports and wildcard-domain syntax have no special meaning.
export function bypassesProxy(list: string, host: string): boolean {
  if (host.length === 0) return false;
  if (list === "*") return true;
  const family = host.includes("%") ? 0 : isIP(host);
  const name = host.toLowerCase().replace(/\.$/u, "");
  let offset = 0;
  while (offset < list.length) {
    while (list[offset] === " " || list[offset] === "\t") offset += 1;
    const start = offset;
    while (offset < list.length && list[offset] !== " " && list[offset] !== "\t" && list[offset] !== ",") offset += 1;
    const token = list.slice(start, offset);
    if (token.length > 0) {
      if (family === 4 || family === 6) {
        if (bypassAddressMatches(token, host, family)) return true;
      } else {
        const domain = token.toLowerCase().replace(/\.$/u, "").replace(/^\./u, "");
        if (name === domain || name.endsWith(`.${domain}`)) return true;
      }
    }
    while (list[offset] === " " || list[offset] === "\t") offset += 1;
    if (list[offset] !== ",") break;
    while (list[offset] === ",") offset += 1;
  }
  return false;
}

// One destination's routes, with what Settings shows about them.
export interface UpstreamRouteAnswer {
  routes: ParentProxyRoute[];
  reason?: string;
  source: UpstreamProxySource;
  envVar?: string;
  views: UpstreamProxyRouteView[];
  skipped: string[];
  // A failure worth asking again for (the resolver threw); never cached.
  transient?: boolean;
}

export interface UpstreamProxyRouterDeps {
  // The live `upstreamProxy` setting (read per decision, so a change applies without restart).
  settings: () => UpstreamProxySettings;
  // The manual proxy's stored credentials, or null. Sent only when their origin is the manual proxy's.
  manualCredentials: () => StoredProxyCredentials | null;
  // The app process's environment.
  env: () => NodeJS.ProcessEnv;
  // Chromium's PAC resolution (`session.resolveProxy`); absent on a host without one.
  resolveProxy?: (url: string) => Promise<string>;
  // Called when entries were passed over for a destination (for the audit row).
  onSkipped?: (event: { host: string; port: number; source: UpstreamProxySource; skipped: string[] }) => void;
  now?: () => number;
  // How long one destination's answer is reused. Default 45 s.
  ttlMs?: number;
  // At most this many destinations are cached. Default 512.
  maxEntries?: number;
  // At most this many `resolveProxy` calls run at once; more wait. Default 4.
  maxConcurrentResolves?: number;
  // At most this many wait; beyond that a lookup fails (transient, not cached). Default 256.
  maxQueuedResolves?: number;
}

// `fn` with at most `max` calls in flight and at most `maxQueued` waiting; a call beyond that rejects at once. Each PAC evaluation can run the script's own DNS lookups, so a burst of new destinations must not fan out into as many concurrent evaluations.
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

// The routes for one destination under the current settings. `host` must be canonical (ASRT hands the hook its canonical spelling); anything else is refused rather than handed to the resolver.
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
  // Local destinations stay on this host independently of the bypass syntax.
  const localDestination = host === "localhost" || isLoopbackAddress(host);

  if (settings.mode === "manual") {
    if (localDestination || bypassesProxy(settings.bypass, host)) return answer("manual-bypass", [DIRECT]);
    const parsed = parseProxyUrl(settings.manualUrl);
    if (!parsed.ok) {
      return answer("manual", [], {
        reason: parsed.reason === "socks"
          ? `the upstream proxy in Settings is ${SOCKS_SKIP}`
          : "the upstream proxy URL in Settings is not usable",
      });
    }
    // Credentials go only to the proxy they were entered for: a changed host, port or scheme never receives the old one's password.
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
    if (localDestination || bypassesProxy(environmentNoProxy(env), host)) return answer("environment-bypass", [DIRECT], { envVar: chosen.name });
    const parsed = parseProxyUrl(chosen.value);
    if (!parsed.ok) {
      const what = parsed.reason === "socks" ? SOCKS_SKIP : "not a usable proxy URL";
      return answer("environment", [], { envVar: chosen.name, skipped: [`${chosen.name} (${what})`], reason: `the proxy in ${chosen.name} is ${what}` });
    }
    return answer("environment", [proxyRoute(parsed.scheme, parsed.host, parsed.port, parsed.auth, settings.resolvesNames)], { envVar: chosen.name });
  }

  if (!deps.resolveProxy) return answer("system-unavailable", [DIRECT]);
  // Built from the canonical host and port only: Chromium evaluates its PAC or system configuration for this URL and fetches nothing from it.
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
    // Never trusted to resolve names: a PAC or WPAD answer is network input (any host on the network can serve WPAD), and the opt-in is for a proxy the person named, in Settings or in the environment.
    else if (entry.kind === "proxy") entries.push(proxyRoute(entry.scheme, entry.host, entry.port, undefined, false));
    else skipped.push(`${entry.entry} (${entry.reason === "socks" ? SOCKS_SKIP : entry.reason === "malformed" ? "not a usable entry" : "a kind the sandbox cannot use"})`);
  }
  if (entries.length === 0) {
    return answer("system", [], { skipped, reason: "the system proxy settings offer no route the sandbox can use (SOCKS proxies are not supported)" });
  }
  return answer("system", entries, { skipped });
}

// The route hook for ASRT, with a short per-destination cache (the OS configuration does not change between two connections a second apart, and a PAC evaluation is not free). Electron has no proxy-change event, so the TTL bounds how long an OS change takes to apply; a Settings change clears the cache at once (UpstreamProxyRouter.invalidate).
export interface UpstreamProxyRouter {
  router: ParentProxyRouter;
  invalidate(): void;
  // What the routes for `url` would be now (uncached), for the Settings diagnostic line.
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

  const lookupOnce = (destination: { host: string; port: number; scheme: "http" | "https" }): Promise<UpstreamRouteAnswer> => {
    const key = `${destination.scheme}\n${destination.host}\n${destination.port}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const started = generation;
    const value = upstreamRoutesFor(deps, destination).then((result) => {
      if (generation === started && result.skipped.length > 0) {
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

  const lookup = async (destination: Parameters<ParentProxyRouter>[0]): Promise<UpstreamRouteAnswer> => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const started = generation;
      const result = await lookupOnce(destination);
      if (generation === started) return result;
    }
    return answer("off", [], { reason: "the upstream proxy configuration changed too often", transient: true });
  };
  const router: ParentProxyRouter = Object.assign(
    async (destination: Parameters<ParentProxyRouter>[0]) => {
      const result = await lookup(destination);
      return result.reason !== undefined ? { routes: result.routes, reason: result.reason } : { routes: result.routes };
    },
    {
      generation: () => generation,
      decisionClass: (host: string, addresses: readonly string[], resolution: "pinned" | "upstream") => {
        const network = egressDestinationNetwork(host, addresses);
        return resolution === "upstream" && network === "public" ? "unverified" : network;
      },
    },
  );

  return {
    router,
    invalidate: () => {
      generation += 1;
      cache.clear();
    },
    describe: (url) => describeUpstreamProxy(deps, url),
  };
}

// What the routes for `url` would be now (uncached), for the Settings diagnostic line.
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

// The settings reads the router needs, structurally (no dependency on the store module).
export interface UpstreamProxySettingsSource {
  get(key: "upstreamProxy"): UpstreamProxySettings;
  getSecret(key: string): string | null;
}

// Router deps over the live settings, the app's environment and Chromium's resolver.
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

// Parse the stored manual credentials (`{ username, password, origin }` JSON), or null. An entry without its origin is treated as absent: it is never sent anywhere.
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
