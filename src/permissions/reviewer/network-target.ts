// Category and verdict consumers share endpoint extraction. Explicit url/endpoint/host/uri fields outrank incidental URLs, then scan every top-level string so hidden endpoints still escalate.

// Argument selectors that DECLARE a network endpoint. Order is significant.
export const NETWORK_TARGET_FIELDS: readonly string[] = ["url", "endpoint", "host", "uri"];

export interface NetworkTarget {
  // Which shape the argument had. `"url"` is a parseable http(s)/ws(s) URL; `"hostname"` is a bare host taken from a `host` field or a hostname-shaped string. A consumer that grades the REQUEST rather than only the destination needs this: a bare hostname carries no path, query or fragment to grade, and an ABSENT tail must not be read as a clean one.
  kind: "url" | "hostname";
  // Lowercased hostname. Empty string for a network URL with no authority.
  host: string;
  // URL pathname, or "" when the value was a bare hostname.
  path: string;
  // URL search string including the leading `?`, or "" when there is none.
  query: string;
  // URL fragment including the leading `#`, or "" when there is none.
  fragment: string;
  // True when the URL carried userinfo in front of the authority.
  hasUserInfo: boolean;
}

// A destination named without a request around it.
function hostnameTarget(host: string): NetworkTarget {
  return {
    kind: "hostname",
    host: host.toLowerCase(),
    path: "",
    query: "",
    fragment: "",
    hasUserInfo: false,
  };
}

// Parse a value as a network URL. Restricted to the schemes that actually reach a network peer — the inspector has always required this, and the classifier rated a non-network scheme HIGH "untrusted host" anyway, so requiring it in one place changes neither. An empty hostname is still returned as a target rather than a miss. WHATWG parsing makes that shape hard to reach (`https:///x` promotes `x` to the authority), but if it ever is reached the call stays in the network domain and rates HIGH, because an empty host matches no trusted entry — the safe direction.
function parseNetworkUrl(value: string): NetworkTarget | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") {
      return null;
    }
    return {
      kind: "url",
      host: u.hostname.toLowerCase(),
      path: u.pathname,
      query: u.search,
      fragment: u.hash,
      hasUserInfo: u.username.length > 0 || u.password.length > 0,
    };
  } catch {
    return null;
  }
}

// Bare hostname shape — letters, digits, dots and hyphens only.
function parseBareHost(value: string): NetworkTarget | null {
  return /^[a-zA-Z0-9.-]+$/.test(value) ? hostnameTarget(value) : null;
}

// The endpoint this call is aimed at, or `null` when no argument names one.
export function extractNetworkTarget(input: Record<string, unknown>): NetworkTarget | null {
  for (const field of NETWORK_TARGET_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const url = parseNetworkUrl(value);
    if (url) return url;
    // A field literally named `host` declares a hostname; take it as one even when it is not well-formed, so a junk value cannot demote the call out of the network domain. It matches no trusted entry, so it rates HIGH.
    if (field === "host") return hostnameTarget(value);
    const bare = parseBareHost(value);
    if (bare) return bare;
  }
  // Default-strict: a network URL under any other key is still a network target.
  for (const [key, value] of Object.entries(input)) {
    if (NETWORK_TARGET_FIELDS.includes(key)) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    const url = parseNetworkUrl(value);
    if (url) return url;
  }
  return null;
}

// True when any argument names a network endpoint.
export function hasNetworkTarget(input: Record<string, unknown>): boolean {
  return extractNetworkTarget(input) !== null;
}
