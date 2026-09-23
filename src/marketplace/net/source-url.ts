/**
 * `normalizeSourceUrl` — the one spelling of a marketplace source URL
 * (design §7.1).
 *
 * Policy allow/block matching, reserved-name checks, token lookup and
 * duplicate detection all compare this form, so two spellings of one
 * repository can never be treated as two repositories, and a block rule
 * cannot be sidestepped by changing case, adding a trailing dot or `.git`,
 * or writing the host as an IDN or a numeric IPv4 variant.
 *
 * Accepted inputs:
 *   - `owner/repo`                → `https://github.com/owner/repo`
 *   - `user@host:path` (scp form) → `ssh://user@host/path`
 *   - `https://…`, `http://…`, `ssh://…`
 *
 * Rejected: every other scheme (`file:`, `git:`, `ext::`, …), credentials in
 * the URL (an ssh user name is not a credential), query and fragment, dot
 * and empty path segments, control characters and whitespace.
 */
import { MarketplaceError } from "../errors.js";

export type SourceUrlScheme = "https" | "http" | "ssh";

export interface NormalizedSourceUrl {
  scheme: SourceUrlScheme;
  /** ssh user name (`git` in `git@github.com:o/r`); always null for http(s). */
  user: string | null;
  /** Lowercase ASCII host; an IPv6 literal keeps its brackets. */
  host: string;
  /** Explicit port, or null when it is the scheme's default. */
  port: number | null;
  /** `/owner/repo`: no trailing `/`, no `.git`, canonical percent-encoding. */
  path: string;
  /** The stored string built from the fields above. */
  url: string;
}

const DEFAULT_PORT: Record<SourceUrlScheme, number> = { https: 443, http: 80, ssh: 22 };
const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+$/u;
const SCP_FORM = /^([A-Za-z0-9._~-]+)@(\[[0-9A-Fa-f:.]+\]|[^:/@[\]]+):(.+)$/u;
const SCHEME_FORM = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/su;
const SSH_USER = /^[A-Za-z0-9._~-]+$/u;
const UNRESERVED = /[A-Za-z0-9\-._~]/u;
/** RFC 3986 pchar minus `%`, which is handled separately. */
const PCHAR = /[A-Za-z0-9\-._~!$&'()*+,;=:@]/u;

function reject(input: string, reason: string): never {
  throw new MarketplaceError("SOURCE_URL_REJECTED", `source URL rejected (${reason}): ${input}`);
}

/**
 * Canonical host: WHATWG parsing gives IDNA to ASCII, lowercase, and one
 * spelling for IPv4 variants (`0x7f.1` → `127.0.0.1`) and IPv6 literals.
 * One trailing dot is removed so `github.com.` equals `github.com`.
 */
export function normalizeSourceHost(input: string, raw: string): string {
  if (!raw || raw.includes("%") || /[\s\\/?#@]/u.test(raw)) reject(input, "invalid host");
  let host: string;
  try {
    host = new URL(`http://${raw}/`).hostname;
  } catch {
    reject(input, "invalid host");
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.endsWith(".")) reject(input, "invalid host");
  return host;
}

function normalizeSegment(input: string, segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "%") {
      const hex = segment.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/u.test(hex)) reject(input, "invalid percent-encoding");
      const decoded = String.fromCharCode(Number.parseInt(hex, 16));
      out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
      i += 2;
    } else if (PCHAR.test(ch)) {
      out += ch;
    } else {
      out += encodeURIComponent(ch);
    }
  }
  return out;
}

function normalizePathSegments(input: string, rawPath: string, stripGitSuffix: boolean): string[] {
  if (!rawPath.startsWith("/")) rawPath = `/${rawPath}`;
  const body = rawPath.slice(1).replace(/\/$/u, "");
  if (!body) reject(input, "missing repository path");
  const segments = body.split("/").map((segment) => normalizeSegment(input, segment));
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") reject(input, "ambiguous path segment");
  }
  if (stripGitSuffix) {
    const last = segments[segments.length - 1]!;
    if (last.endsWith(".git")) {
      const trimmed = last.slice(0, -".git".length);
      if (!trimmed) reject(input, "missing repository name");
      segments[segments.length - 1] = trimmed;
    }
  }
  return segments;
}

interface ParsedParts {
  scheme: SourceUrlScheme;
  user: string | null;
  host: string;
  port: number | null;
  rawPath: string;
}

function parseParts(input: string, trimmed: string): ParsedParts {
  if (GITHUB_SHORTHAND.test(trimmed) && !trimmed.includes("://")) {
    return { scheme: "https", user: null, host: "github.com", port: null, rawPath: `/${trimmed}` };
  }
  const scp = !trimmed.includes("://") ? SCP_FORM.exec(trimmed) : null;
  if (scp) {
    const [, user, rawHost, path] = scp;
    return {
      scheme: "ssh",
      user: user!,
      host: normalizeSourceHost(input, rawHost!),
      port: null,
      rawPath: path!.startsWith("/") ? path! : `/${path!}`,
    };
  }
  const match = SCHEME_FORM.exec(trimmed);
  if (!match) reject(input, "not a URL");
  const scheme = match[1]!.toLowerCase();
  if (scheme !== "https" && scheme !== "http" && scheme !== "ssh") {
    reject(input, `scheme "${scheme}" is not allowed`);
  }
  const rest = match[2]!;
  if (rest.includes("?") || rest.includes("#")) reject(input, "query or fragment");
  const slash = rest.indexOf("/");
  if (slash < 0) reject(input, "missing repository path");
  const authority = rest.slice(0, slash);
  const rawPath = rest.slice(slash);

  let user: string | null = null;
  let hostPort = authority;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const userInfo = authority.slice(0, at);
    hostPort = authority.slice(at + 1);
    if (scheme !== "ssh" || userInfo.includes(":") || !SSH_USER.test(userInfo)) {
      reject(input, "credentials in URL");
    }
    user = userInfo;
  }

  let rawHost = hostPort;
  let port: number | null = null;
  const portMatch = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/u.exec(hostPort);
  if (!portMatch) reject(input, "invalid host");
  rawHost = portMatch[1]!;
  if (portMatch[2] !== undefined) {
    const value = Number(portMatch[2]);
    if (!portMatch[2] || !Number.isInteger(value) || value < 1 || value > 65535) {
      reject(input, "invalid port");
    }
    port = value === DEFAULT_PORT[scheme] ? null : value;
  }
  return { scheme, user, host: normalizeSourceHost(input, rawHost), port, rawPath };
}

function render(parts: Omit<NormalizedSourceUrl, "url">): string {
  const user = parts.user ? `${parts.user}@` : "";
  const port = parts.port === null ? "" : `:${parts.port}`;
  return `${parts.scheme}://${user}${parts.host}${port}${parts.path}`;
}

export function normalizeSourceUrl(input: string): NormalizedSourceUrl {
  const trimmed = input.trim();
  if (!trimmed) reject(input, "empty");
  if (/[\u0000- \u007f\\]/u.test(trimmed)) reject(input, "whitespace, control character or backslash");
  const parts = parseParts(input, trimmed);
  const path = `/${normalizePathSegments(input, parts.rawPath, true).join("/")}`;
  const normalized = { scheme: parts.scheme, user: parts.user, host: parts.host, port: parts.port, path };
  return { ...normalized, url: render(normalized) };
}

/**
 * Same repository? Compares scheme, host, port and path; the ssh user name
 * is how one connects, not which repository it is.
 */
export function sameSourceRepository(a: NormalizedSourceUrl, b: NormalizedSourceUrl): boolean {
  return a.scheme === b.scheme && a.host === b.host && a.port === b.port && a.path === b.path;
}

/**
 * A managed-policy pattern (design §12), parsed once when the policy loads.
 *
 *   - `host:<host>` matches the host on any scheme and port.
 *   - a URL matches scheme, host, port and path exactly;
 *   - a URL ending in `*` matches scheme, host and port exactly and any path
 *     that starts with the text before the `*`.
 */
export type SourcePattern =
  | { kind: "host"; host: string; text: string }
  | { kind: "exact"; url: NormalizedSourceUrl; text: string }
  | { kind: "prefix"; scheme: SourceUrlScheme; host: string; port: number | null; pathPrefix: string; text: string };

export function parseSourcePattern(text: string): SourcePattern {
  if (text.startsWith("host:")) {
    return { kind: "host", host: normalizeSourceHost(text, text.slice("host:".length)), text };
  }
  if (!text.endsWith("*")) {
    return { kind: "exact", url: normalizeSourceUrl(text), text };
  }
  const prefix = text.slice(0, -1);
  if (prefix.includes("*")) reject(text, "only a trailing * is allowed");
  const parts = parseParts(text, prefix);
  const raw = parts.rawPath.startsWith("/") ? parts.rawPath : `/${parts.rawPath}`;
  // Keep a trailing "/" so `…/acme/*` does not also match `…/acme-corp/x`.
  const trailingSlash = raw.endsWith("/");
  const body = raw.slice(1).replace(/\/$/u, "");
  const segments = body ? body.split("/").map((segment) => normalizeSegment(text, segment)) : [];
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    reject(text, "ambiguous path segment");
  }
  const joined = segments.length > 0 ? `/${segments.join("/")}` : "";
  const pathPrefix = trailingSlash || segments.length === 0 ? `${joined}/` : joined;
  return { kind: "prefix", scheme: parts.scheme, host: parts.host, port: parts.port, pathPrefix, text };
}

export function matchesSourcePattern(url: NormalizedSourceUrl, pattern: SourcePattern): boolean {
  switch (pattern.kind) {
    case "host":
      return url.host === pattern.host;
    case "exact":
      return sameSourceRepository(url, pattern.url);
    case "prefix":
      return (
        url.scheme === pattern.scheme
        && url.host === pattern.host
        && url.port === pattern.port
        && `${url.path}/`.startsWith(pattern.pathPrefix)
      );
  }
}
