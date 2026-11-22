/** Parse URLs structurally: allow HTTP(S) only and reject embedded credentials before any external-navigation sink. */
export type ExternalUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: "invalid-url" }
  | { ok: false; error: "malformed-url" }
  | { ok: false; error: "invalid-host" }
  | { ok: false; error: "embedded-credentials" }
  | { ok: false; error: "disallowed-protocol"; protocol: string };

const DNS_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;

/**
 * Whether a parsed hostname names something a network stack can reach: DNS labels, an IPv4 literal (a DNS-shaped string
 * of digits) or a bracketed IPv6 literal. URL parsers disagree about hosts outside this set — one percent-encodes a space
 * where another throws — so the rule is applied to the parsed result, which makes the verdict the same in every runtime.
 */
export function isNavigableHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  if (hostname.startsWith("[")) return /^\[[0-9a-f:.]+\]$/i.test(hostname);
  const labels = (hostname.endsWith(".") ? hostname.slice(0, -1) : hostname).split(".");
  return labels.every((label) => DNS_LABEL.test(label));
}

export function validateExternalUrl(input: unknown): ExternalUrlValidation {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "invalid-url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: "malformed-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "disallowed-protocol", protocol: parsed.protocol };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "embedded-credentials" };
  }
  if (!isNavigableHostname(parsed.hostname)) {
    return { ok: false, error: "invalid-host" };
  }
  return { ok: true, url: parsed.toString() };
}
