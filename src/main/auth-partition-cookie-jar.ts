// Cookie values remain in the host partition; plugins receive names only. Scope manually because legacy portals require Secure cookies over HTTP, which
// Chromium cookies.get({ url }) withholds.
import type { Cookie, Session } from "electron";

// Minimal cookie shape shared by the scoping helpers. Matches Electron's `Cookie`.
export interface JarCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  // Unix seconds. Omitted for session cookies.
  expirationDate?: number;
}

// RFC 6265 cookies carry at most one leading dot; `.example.com` and `example.com` scope alike.
export function normalizeCookieDomain(domain?: string): string | undefined {
  if (!domain) return undefined;
  return domain.trim().replace(/^\./, "").toLowerCase();
}

// A host-only (domain-less) cookie matches any host; otherwise host === domain or a sub-domain.
export function domainMatches(hostname: string, cookieDomain?: string): boolean {
  const d = normalizeCookieDomain(cookieDomain);
  if (!d) return true;
  const h = hostname.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

// Cookie path "/" matches everything; otherwise request path === it or sits under it (RFC 6265 §5.1.4).
export function pathMatches(reqPath: string, cookiePath?: string): boolean {
  const p = cookiePath && cookiePath.trim().length > 0 ? cookiePath : "/";
  if (p === "/") return true;
  if (reqPath === p) return true;
  return reqPath.startsWith(p.endsWith("/") ? p : `${p}/`);
}

export function isCookieExpired(cookie: JarCookie): boolean {
  if (typeof cookie.expirationDate !== "number") return false;
  return cookie.expirationDate * 1000 < Date.now();
}

// Pick cookies applicable to the request URL and de-duplicate by name, keeping the most specific (domain+path) per name. Mirrors the plugin's former
// `selectCookiesForUrl`. NOTE the deliberate absence of a Secure check: see the module header.
export function selectCookiesForUrl(cookies: JarCookie[], url: URL): JarCookie[] {
  const hostname = url.hostname;
  const pathname = url.pathname || "/";
  const eligible = cookies.filter((cookie) => {
    if (!cookie.name) return false;
    if (isCookieExpired(cookie)) return false;
    if (!domainMatches(hostname, cookie.domain)) return false;
    if (!pathMatches(pathname, cookie.path)) return false;
    return true;
  });
  const bestByName = new Map<string, JarCookie>();
  for (const cookie of eligible) {
    const prev = bestByName.get(cookie.name);
    if (!prev) {
      bestByName.set(cookie.name, cookie);
      continue;
    }
    const prevScore =
      (normalizeCookieDomain(prev.domain)?.length ?? 0) + (prev.path?.length ?? 1);
    const curScore =
      (normalizeCookieDomain(cookie.domain)?.length ?? 0) + (cookie.path?.length ?? 1);
    if (curScore > prevScore) bestByName.set(cookie.name, cookie);
  }
  return [...bestByName.values()];
}

// Build a `Cookie` header string for a specific request URL, or "" if none apply.
export function cookieHeaderForUrl(cookies: JarCookie[], url: URL): string {
  return selectCookiesForUrl(cookies, url)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

// Read every cookie in a partition's jar. Enumerates the WHOLE jar (`get({})`) rather than `get({ url })` on purpose: the per-request scoping above
// applies the legacy-http Secure divergence Chromium's url filter cannot express.
export async function readPartitionJar(partitionSession: Session): Promise<JarCookie[]> {
  const cookies: Cookie[] = await partitionSession.cookies.get({});
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    ...(c.domain !== undefined ? { domain: c.domain } : {}),
    ...(c.path !== undefined ? { path: c.path } : {}),
    ...(typeof c.expirationDate === "number" ? { expirationDate: c.expirationDate } : {}),
  }));
}

// The `Cookie` header the host should attach for `url` from `partitionSession`, or `""` when nothing applies (caller leaves the header unset). Combines
// the whole-jar read with per-request scoping so the caller does neither.
export async function partitionCookieHeaderForUrl(
  partitionSession: Session,
  url: URL,
): Promise<string> {
  const jar = await readPartitionJar(partitionSession);
  return cookieHeaderForUrl(jar, url);
}

// Return URL-scoped cookies deduplicated by name for the gated cross-context session read.
export async function partitionCookiesForUrl(
  partitionSession: Session,
  url: URL,
): Promise<JarCookie[]> {
  const jar = await readPartitionJar(partitionSession);
  return selectCookiesForUrl(jar, url);
}
