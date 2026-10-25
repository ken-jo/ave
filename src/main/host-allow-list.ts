// Auth surfaces share dot-boundary suffix matching so cookie and navigation allowlists cannot drift. Reject registry suffixes and punycode labels to
// prevent broad grants and display-name spoofing; cap the list size.

const MAX_HOSTS = 16;

// Loopback exceptions match exact declared literals only, not subdomains; normalize IPv6 brackets before lookup.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Block bare registry suffixes — see PSL note in the file header.
const FORBIDDEN_TOP_LEVELS = new Set([
  "com",
  "net",
  "org",
  "kr",
  "co.kr",
  "or.kr",
  "go.kr",
  "io",
  "ai",
  "dev",
  "app",
]);

// Normalize leading cookie-domain dots and IPv6 brackets so URL hostnames and manifest entries compare consistently.
export function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const undotted = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
  return undotted.startsWith("[") && undotted.endsWith("]")
    ? undotted.slice(1, -1)
    : undotted;
}

// Recognize declared loopback literals, never names that happen to resolve locally; DNS rebinding belongs to the resolved-address guard.
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

// Loopback literal acceptance is per-surface opt-in and does not itself grant reachability; every other validation rule remains strict.
export function normalizeAllowedHosts(
  raw: readonly string[],
  options: { readonly allowLoopback?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const host = normalizeHost(entry);
    if (host.length === 0) continue;
    if (options.allowLoopback === true && LOOPBACK_HOSTS.has(host)) {
      if (!seen.has(host)) {
        seen.add(host);
        out.push(host);
      }
      continue;
    }
    if (host === "*" || host.includes("*")) {
      throw new Error(`host-allow-list: wildcard host '${entry}' is not allowed`);
    }
    if (host.includes("/")) {
      throw new Error(`host-allow-list: '${entry}' must be a hostname, not a URL`);
    }
    if (FORBIDDEN_TOP_LEVELS.has(host)) {
      throw new Error(
        `host-allow-list: '${entry}' is a public-suffix-style top level — refusing to allow blanket-match`,
      );
    }
    if (!host.includes(".")) {
      throw new Error(
        `host-allow-list: '${entry}' must contain at least one dot — single-label hosts blanket-match every site under that label`,
      );
    }
    if (host.startsWith("xn--") || host.includes(".xn--")) {
      throw new Error(
        `host-allow-list: '${entry}' contains an IDN-punycode label (xn--*) — homoglyph risk; declare the ASCII brand domain instead`,
      );
    }
    if (!seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  if (out.length > MAX_HOSTS) {
    throw new Error(
      `host-allow-list: at most ${MAX_HOSTS} entries permitted (got ${out.length})`,
    );
  }
  return out;
}

// Require pre-normalized allowlists and dot-boundary suffix matching; the hot path stays allocation-free.
export function urlHostMatchesAllowList(
  urlHost: string,
  normalizedAllowed: readonly string[],
): boolean {
  if (!urlHost) return false;
  const host = normalizeHost(urlHost);
  for (const allowed of normalizedAllowed) {
    if (host === allowed) return true;
    if (host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

// Convenience wrapper — parse `url`, return whether its host is allowed. Returns false for unparseable URLs, non-http(s) schemes, or empty hostnames.
export function urlMatchesAllowList(
  url: string,
  normalizedAllowed: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return urlHostMatchesAllowList(parsed.hostname, normalizedAllowed);
}
