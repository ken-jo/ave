/** Canonical source URLs are shared by policy, credentials and duplicate detection.
 * Reject helper transports, credentials and ambiguous paths before they can select another target. */
import { scrubDiagnosticSecrets } from "../../shared/dlp.js";
import { MarketplaceError, type MarketplaceErrorDetail } from "../errors.js";

type SourceUrlScheme = "https" | "http" | "ssh";

export interface NormalizedSourceUrl {
  scheme: SourceUrlScheme;
  user: string | null;
  host: string;
  port: number | null;
  /** Canonical repository path has no trailing slash or .git suffix. */
  path: string;
  url: string;
}

const DEFAULT_PORT: Record<SourceUrlScheme, number> = { https: 443, http: 80, ssh: 22 };
const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+$/u;
const SCP_FORM = /^([A-Za-z0-9._~-]+)@(\[[0-9A-Fa-f:.]+\]|[^:/@[\]]+):(.+)$/u;
const SCHEME_FORM = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/su;
/** Never starts with `-`, so ssh cannot read it as an option. */
const SSH_USER = /^[A-Za-z0-9._~][A-Za-z0-9._~-]*$/u;
const HOST_NAME = /^(?!-)[a-z0-9_-]+(?<!-)(?:\.(?!-)[a-z0-9_-]+(?<!-))*$/u;
const UNRESERVED = /[A-Za-z0-9\-._~]/u;
const PCHAR = /[A-Za-z0-9\-._~!$&'()*+,;=:@]/u;

/** Scrub input echoed in diagnostic details, including URL credentials. */
function reject(input: string, reason: string, detail?: MarketplaceErrorDetail<"SOURCE_URL_REJECTED">): never {
  throw new MarketplaceError("SOURCE_URL_REJECTED", `source URL rejected (${reason}): ${scrubDiagnosticSecrets(input)}`, detail ? { detail } : undefined);
}

/** Canonicalize host aliases and trailing dots; reject ports in host-only policy fields. */
export function normalizeSourceHost(input: string, raw: string): string {
  if (!raw || raw.includes("%") || /[\s\\/?#@]/u.test(raw)) reject(input, "invalid host");
  if (!raw.startsWith("[") && raw.includes(":")) reject(input, "a host takes no port");
  let host: string;
  try {
    host = new URL(`http://${raw}/`).hostname;
  } catch {
    reject(input, "invalid host");
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || (!host.startsWith("[") && !HOST_NAME.test(host))) reject(input, "invalid host");
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
    if (!SSH_USER.test(user!)) reject(input, "invalid ssh user");
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
    reject(input, `scheme "${scheme}" is not allowed`, { reason: "scheme-unsupported", scheme });
  }
  const rest = match[2]!;
  if (rest.includes("?") || rest.includes("#")) reject(input, "query or fragment", { reason: "format" });
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
    if (scheme !== "ssh" || userInfo.includes(":")) reject(input, "credentials in URL", { reason: "credentials-in-url" });
    if (!SSH_USER.test(userInfo)) reject(input, "invalid ssh user");
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

/** Decode and normalize download paths before policy matching; retain / for root endpoints. */
export function normalizeDownloadPath(input: string, rawPath: string): string {
  if (rawPath === "" || rawPath === "/") return "/";
  return `/${normalizePathSegments(input, rawPath, false).join("/")}`;
}

/** Helper transport syntax launches arbitrary programs and must be rejected. */
const HELPER_TRANSPORT = /^([A-Za-z][A-Za-z0-9+.-]*)::/u;

/** Folder input is lexical only and is forbidden in deep links. */
export function isFolderPathInput(input: string): boolean {
  const text = input.trim();
  return /^file:/iu.test(text)
    || /^[/~\\]/u.test(text)
    || /^[A-Za-z]:/u.test(text)
    || /^\.\.?(?:[/\\]|$)/u.test(text);
}

export function normalizeSourceUrl(input: string): NormalizedSourceUrl {
  const trimmed = input.trim();
  if (!trimmed) reject(input, "empty");
  const helper = HELPER_TRANSPORT.exec(trimmed);
  if (helper) reject(input, `the ${helper[1]}:: transport runs a program`, { reason: "helper-transport", scheme: helper[1]!.toLowerCase() });
  if (/[\u0000- \u007f\\]/u.test(trimmed)) reject(input, "whitespace, control character or backslash", { reason: "format" });
  const parts = parseParts(input, trimmed);
  const path = `/${normalizePathSegments(input, parts.rawPath, true).join("/")}`;
  const normalized = { scheme: parts.scheme, user: parts.user, host: parts.host, port: parts.port, path };
  return { ...normalized, url: render(normalized) };
}

/** Repository identity ignores case, scheme, port and SSH user to prevent policy bypass.
 * Case-sensitive repositories differing only in case are conservatively treated as one. */
function repositoryPath(url: NormalizedSourceUrl): string {
  return url.path.toLowerCase();
}

export function sameSourceRepository(a: NormalizedSourceUrl, b: NormalizedSourceUrl): boolean {
  return a.host === b.host && repositoryPath(a) === repositoryPath(b);
}

/** Host and repository patterns ignore scheme and port; only trailing * enables prefix matching.
 * Folder path patterns and git patterns never cross-match. */
export type SourcePattern =
  | { kind: "host"; host: string; text: string }
  | { kind: "exact"; url: NormalizedSourceUrl; text: string }
  | { kind: "prefix"; host: string; pathPrefix: string; text: string }
  | FolderPattern;

/** path: patterns match one folder, a trailing-* prefix, or all folders with path:*. */
export interface FolderPattern {
  kind: "path";
  folder: string;
  prefix: boolean;
  text: string;
}

/** Path matching normalizes separators and uppercases the drive letter. */
export function folderPatternKey(path: string): string {
  const slashed = path.replace(/\\/gu, "/");
  return /^[a-z]:/u.test(slashed) ? `${slashed[0]!.toUpperCase()}${slashed.slice(1)}` : slashed;
}

function parseFolderPattern(text: string): FolderPattern {
  const body = text.slice("path:".length);
  if (body.slice(0, -1).includes("*")) reject(text, "only a trailing * is allowed");
  const prefix = body.endsWith("*");
  const folder = folderPatternKey(prefix ? body.slice(0, -1) : body);
  if (prefix && folder === "") return { kind: "path", folder, prefix, text };
  if (!/^(?:\/|[A-Za-z]:\/)/u.test(folder)) reject(text, "a path: pattern names an absolute folder");
  const rest = folder.replace(/^(?:\/\/|[A-Za-z]:\/|\/)/u, "");
  const segments = rest === "" ? [] : rest.split("/");
  // A prefix may end in a separator (`/opt/a/*` is everything under `/opt/a`); nothing else is empty, `.` or `..`.
  const named = prefix && segments[segments.length - 1] === "" ? segments.slice(0, -1) : segments;
  if (named.some((segment) => segment === "" || segment === "." || segment === "..")) reject(text, "ambiguous path segment");
  return { kind: "path", folder, prefix, text };
}

/** Allow requires exact case; block ignores case because volume sensitivity is unknown. */
export function matchesFolderPattern(path: string, pattern: FolderPattern, list: "allow" | "block"): boolean {
  const fold = (text: string) => (list === "block" ? text.normalize("NFC").toLowerCase() : text.normalize("NFC"));
  const folder = fold(folderPatternKey(path));
  const wanted = fold(pattern.folder);
  return pattern.prefix ? folder.startsWith(wanted) : folder === wanted;
}

export function parseSourcePattern(text: string): SourcePattern {
  if (text.startsWith("path:")) return parseFolderPattern(text);
  if (text.startsWith("host:")) {
    return { kind: "host", host: normalizeSourceHost(text, text.slice("host:".length)), text };
  }
  // Reject internal wildcards rather than silently treating intended policy patterns as literal paths.
  if (text.slice(0, -1).includes("*")) reject(text, "only a trailing * is allowed");
  if (!text.endsWith("*")) {
    return { kind: "exact", url: normalizeSourceUrl(text), text };
  }
  const prefix = text.slice(0, -1);
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
  return { kind: "prefix", host: parts.host, pathPrefix: pathPrefix.toLowerCase(), text };
}

/** Exact repository patterns also govern artifact downloads beneath that repository path. */
export type PatternTarget = "repository" | "download";

export function matchesSourcePattern(url: NormalizedSourceUrl, pattern: SourcePattern, target: PatternTarget = "repository"): boolean {
  switch (pattern.kind) {
    case "path":
      return false;
    case "host":
      return url.host === pattern.host;
    case "exact":
      return sameSourceRepository(url, pattern.url)
        || (target === "download" && url.host === pattern.url.host && repositoryPath(url).startsWith(`${repositoryPath(pattern.url)}/`));
    case "prefix":
      return url.host === pattern.host && `${repositoryPath(url)}/`.startsWith(pattern.pathPrefix);
  }
}
