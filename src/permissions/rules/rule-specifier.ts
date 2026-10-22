/**
 * Permission rules language (issue #28, P1a).
 *
 * One grammar shared by Settings, the approval dock and the rule files:
 *
 *   Bash(<prefix> *)          every command whose static argv starts with <prefix>
 *   Bash(<exact command>)     exactly that static argv
 *   Edit(<path-glob>)         absolute or project-relative, using *, ** and ?
 *   WebFetch(domain:<host>)   exact host, optional port; only a leading `*.` wildcard
 *   Mcp(<server>)             every tool of one MCP server
 *   Mcp(<server>:<tool>)      one MCP tool
 *
 * Parsing is strict: anything outside the grammar throws
 * {@link RuleSpecifierError}. There is no lenient path, so a malformed rule can
 * never be silently re-read as a broader one.
 *
 * Legacy Store A patterns (plain tool-name globs such as `web_fetch`, or the
 * `write_file:path:/abs` grant form) are a separate shape. They never contain
 * `(`, so {@link isRuleSpecifier} classifies them by shape and they keep their
 * existing glob semantics unchanged.
 */

export type RuleSpecifier =
  | {
      kind: "bash";
      /** Static argv prefix, one entry per token. Never empty. */
      tokens: readonly string[];
      /** True for `Bash(<prefix> *)`: the prefix plus any further arguments (or none). */
      wildcard: boolean;
    }
  | {
      kind: "edit";
      /** Normalized absolute path or project-relative glob, without trailing separator. */
      path: string;
      /** True for `Edit(<dir>/**)`: the path itself and everything under it. */
      recursive: boolean;
    }
  | {
      kind: "webfetch";
      /** Lower-case host without the `*.` marker. */
      host: string;
      /** True for `WebFetch(domain:*.<host>)`: strict subdomains of host only. */
      subdomains: boolean;
      /** Omitted means every port on this host. */
      port?: number;
    }
  | { kind: "mcp"; server: string; tool?: string };

export type RuleSpecifierKind = RuleSpecifier["kind"];

export class RuleSpecifierError extends Error {
  constructor(readonly specifier: string, detail: string) {
    super(`Invalid permission rule "${specifier}": ${detail}`);
    this.name = "RuleSpecifierError";
  }
}

const SPECIFIER_RE = /^(Bash|Edit|WebFetch|Mcp)\(([\s\S]*)\)$/;
const SPECIFIER_HEAD_RE = /^[A-Za-z]+\(/;
/** Characters that would make a prefix token shell syntax rather than a word. */
const SHELL_META_RE = /[\s;&|<>()$`'"\\*?[\]{}#~!]/;
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MCP_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const MAX_SPECIFIER_LENGTH = 2048;

/**
 * Shape test only: true when the pattern is written in the specifier language
 * (`Name(...)`). It does not validate the body; use {@link parseRuleSpecifier}.
 */
export function isRuleSpecifier(pattern: string): boolean {
  return SPECIFIER_HEAD_RE.test(pattern);
}

export function parseRuleSpecifier(text: string): RuleSpecifier {
  if (typeof text !== "string") throw new RuleSpecifierError(String(text), "not a string");
  if (text.length > MAX_SPECIFIER_LENGTH) throw new RuleSpecifierError(text.slice(0, 64), "too long");
  const match = SPECIFIER_RE.exec(text);
  if (!match) throw new RuleSpecifierError(text, "expected Bash(...), Edit(...), WebFetch(domain:...) or Mcp(...)");
  const [, kind, body] = match as unknown as [string, string, string];
  switch (kind) {
    case "Bash": return parseBash(text, body);
    case "Edit": return parseEdit(text, body);
    case "WebFetch": return parseWebFetch(text, body);
    case "Mcp": return parseMcp(text, body);
    default: throw new RuleSpecifierError(text, `unknown rule kind ${kind}`);
  }
}

function parseBash(text: string, body: string): RuleSpecifier {
  if (body !== body.trim() || /\s{2,}/.test(body) || /[\t\r\n]/.test(body)) {
    throw new RuleSpecifierError(text, "tokens must be separated by single spaces");
  }
  const parts = body.split(" ").filter((part) => part.length > 0);
  if (parts.length === 0) throw new RuleSpecifierError(text, "empty command");
  const wildcard = parts[parts.length - 1] === "*";
  const tokens = wildcard ? parts.slice(0, -1) : parts;
  if (tokens.length === 0) throw new RuleSpecifierError(text, "a bare * matches every command and is never a valid rule");
  for (const token of tokens) {
    if (SHELL_META_RE.test(token)) {
      throw new RuleSpecifierError(text, `token "${token}" contains shell syntax or a wildcard; only a single trailing " *" is supported`);
    }
  }
  return { kind: "bash", tokens: Object.freeze([...tokens]), wildcard };
}

function parseEdit(text: string, body: string): RuleSpecifier {
  let path = body.replace(/\\/g, "/").normalize("NFC");
  let recursive = false;
  if (path.endsWith("/**")) {
    recursive = true;
    path = path.slice(0, -3);
    if (path === "") path = "/";
  }
  const windowsDrive = /^[A-Za-z]:[\\/]/.test(path);
  if (!path || path.startsWith("~") || (!windowsDrive && path.includes(":"))) throw new RuleSpecifierError(text, "invalid path");
  if (/[\[\]{}\r\n\0]/.test(path)) throw new RuleSpecifierError(text, "unsupported path syntax");
  if (path.includes("//")) throw new RuleSpecifierError(text, "path must be normalized");
  const segments = path.split(/[\\/]/);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new RuleSpecifierError(text, "path must be normalized (no . or .. segments)");
  }
  if (path.length > 1 && /[\\/]$/.test(path)) throw new RuleSpecifierError(text, "path must not end with a separator");
  if (path.includes("\0")) throw new RuleSpecifierError(text, "path contains NUL");
  return { kind: "edit", path, recursive };
}

function parseWebFetch(text: string, body: string): RuleSpecifier {
  if (!body.startsWith("domain:")) throw new RuleSpecifierError(text, "expected WebFetch(domain:<host>)");
  let host = body.slice("domain:".length);
  let port: number | undefined;
  const separator = host.indexOf(":");
  if (separator !== -1) {
    const value = host.slice(separator + 1);
    if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw new RuleSpecifierError(text, "invalid port");
    port = Number(value);
    host = host.slice(0, separator);
  }
  const subdomains = host.startsWith("*.");
  if (subdomains) host = host.slice(2);
  if (host !== host.toLowerCase()) throw new RuleSpecifierError(text, "host must be lower case");
  const labels = host.split(".");
  if (host.length === 0 || host.length > 253 || !labels.every((label) => HOST_LABEL_RE.test(label))) {
    throw new RuleSpecifierError(text, "invalid host (only a leading *. wildcard is supported)");
  }
  if (subdomains && labels.length < 2) {
    throw new RuleSpecifierError(text, "a *. wildcard needs at least a registrable domain (e.g. *.example.com)");
  }
  return { kind: "webfetch", host, subdomains, ...(port === undefined ? {} : { port }) };
}

function parseMcp(text: string, body: string): RuleSpecifier {
  const separator = body.indexOf(":");
  const server = separator === -1 ? body : body.slice(0, separator);
  const tool = separator === -1 ? undefined : body.slice(separator + 1);
  if (!MCP_NAME_RE.test(server)) throw new RuleSpecifierError(text, "invalid MCP server id");
  if (tool !== undefined && !MCP_NAME_RE.test(tool)) throw new RuleSpecifierError(text, "invalid MCP tool name");
  return tool === undefined ? { kind: "mcp", server } : { kind: "mcp", server, tool };
}

export function formatRuleSpecifier(spec: RuleSpecifier): string {
  switch (spec.kind) {
    case "bash": return `Bash(${[...spec.tokens, ...(spec.wildcard ? ["*"] : [])].join(" ")})`;
    case "edit": return `Edit(${spec.recursive ? `${spec.path === "/" ? "" : spec.path}/**` : spec.path})`;
    case "webfetch": return `WebFetch(domain:${spec.subdomains ? "*." : ""}${spec.host}${spec.port === undefined ? "" : `:${spec.port}`})`;
    case "mcp": return `Mcp(${spec.server}${spec.tool === undefined ? "" : `:${spec.tool}`})`;
  }
}

/** Parse, then re-format: the canonical spelling used for storage and dedup. */
export function canonicalRuleSpecifier(text: string): string {
  return formatRuleSpecifier(parseRuleSpecifier(text));
}

/**
 * Tidies hand-edited rule text before it is parsed: trims the outside and, in
 * a `Bash(...)` body, trims the inside and collapses runs of spaces and tabs
 * to one space. The approval dock preview and the host save path both call
 * this, so what the user sees is what is saved. It never makes invalid input
 * valid in any other way, and {@link parseRuleSpecifier} stays strict, so the
 * rule store still rejects non-canonical text written by any other path.
 */
export function normalizeRuleSpecifierInput(text: string): string {
  const trimmed = text.trim();
  const bash = /^Bash\((.*)\)$/s.exec(trimmed);
  if (!bash) return trimmed;
  return `Bash(${bash[1]!.replace(/[ \t]+/g, " ").replace(/^ | $/g, "")})`;
}

/** Storage admits only rule kinds wired into the host decision path. */
export const ENFORCED_RULE_KINDS: ReadonlySet<RuleSpecifierKind> = new Set(["bash", "edit", "webfetch", "mcp"]);

/** Match a destination hostname and its effective transport port. */
export function matchesWebFetchHost(spec: Extract<RuleSpecifier, { kind: "webfetch" }>, host: string, port?: number): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (spec.port !== undefined && spec.port !== port) return false;
  if (!normalized.split(".").every((label) => HOST_LABEL_RE.test(label))) return false;
  return spec.subdomains ? normalized.endsWith(`.${spec.host}`) : normalized === spec.host;
}

/** Match the original server/tool pair, without decoding a namespaced tool name. */
export function matchesMcpTool(spec: Extract<RuleSpecifier, { kind: "mcp" }>, server: string, tool: string): boolean {
  return spec.server === server && (spec.tool === undefined || spec.tool === tool);
}
