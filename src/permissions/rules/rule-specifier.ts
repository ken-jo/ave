// Settings, dock and persistence share strict Bash/PowerShell/Edit/WebFetch/Network/Mcp rule grammar; malformed rules throw rather than broaden. Legacy tool/path globs contain no parenthesis and retain their separate semantics.
import { POWERSHELL_COMMAND_POLICIES } from "./powershell-command-policy.js";

export type RuleSpecifier =
  | {
      kind: "bash";
      // Static argv prefix, one entry per token. Never empty.
      tokens: readonly string[];
      // True for `Bash(<prefix> *)`: the prefix plus any further arguments (or none).
      wildcard: boolean;
    }
  | {
      kind: "powershell";
      // Quoted dash-leading arguments retain their value role for every command identity.
      literalParameters?: readonly number[];
      // Canonical argv prefix: the command name lower-cased with its alias resolved, `-Parameter` names lower-cased, every other token verbatim. Never empty.
      tokens: readonly string[];
      // True for `PowerShell(<prefix> *)`: the prefix plus any further arguments (or none).
      wildcard: boolean;
    }
  | {
      kind: "edit";
      // Normalized absolute path or project-relative glob, without trailing separator.
      path: string;
      // True for `Edit(<dir>/**)`: the path itself and everything under it.
      recursive: boolean;
    }
  | {
      kind: "webfetch";
      // Lower-case host without the `*.` marker.
      host: string;
      // True for `WebFetch(domain:*.<host>)`: strict subdomains of host only.
      subdomains: boolean;
      // Omitted means every port on this host.
      port?: number;
    }
  | {
      // A network destination a shell's sandboxed egress may reach (`Network(<host>[:port])`), the host rule kind of the network approval card.
      kind: "network";
      // Lower-case host without the `*.` marker.
      host: string;
      // True for `Network(*.<host>)`: strict subdomains of host only.
      subdomains: boolean;
      // Omitted means every port on this host.
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

const SPECIFIER_RE = /^(Bash|PowerShell|Edit|WebFetch|Network|Mcp)\(([\s\S]*)\)$/;
const SPECIFIER_HEAD_RE = /^[A-Za-z]+\(/;
// Characters that would make a prefix token shell syntax rather than a word.
const SHELL_META_RE = /[\s;&|<>()$`'"\\*?[\]{}#~!]/;
// Characters that would make a PowerShell token an expression, expansion, quote, separator or wildcard rather than literal text.
const POWERSHELL_META_RE = /[\s;&|<>(){}$@`'"\u2018-\u201e,#*?[\]~]/;
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MCP_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const MAX_SPECIFIER_LENGTH = 2048;

// Read one argument without performing expansion or escape interpretation.
export function literalRuleWord(raw: string, dialect: "bash" | "powershell"): string | undefined {
  if (raw.length === 0 || raw.includes("\0")) return undefined;
  const meta = dialect === "bash" ? SHELL_META_RE : POWERSHELL_META_RE;
  let quote: "'" | '"' | undefined;
  let value = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote !== undefined) {
      if (char === quote) {
        if (dialect === "powershell" && raw[index + 1] === quote) return undefined;
        quote = undefined;
      } else {
        if (quote === '"' && (char === "$" || char === "`" || (dialect === "bash" && char === "\\"))) return undefined;
        value += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else {
      if (meta.test(char)) return undefined;
      value += char;
    }
  }
  return quote === undefined ? value : undefined;
}

function shellRuleWords(text: string, body: string, dialect: "bash" | "powershell"): { tokens: string[]; wildcard: boolean; quoted: number[] } {
  if (body.length === 0) throw new RuleSpecifierError(text, "empty command");
  const words: string[] = [];
  let start = 0;
  let quote: string | undefined;
  for (let index = 0; index <= body.length; index += 1) {
    const char = body[index];
    if (char !== undefined && /[\t\r\n]/.test(char) && quote === undefined) throw new RuleSpecifierError(text, "tokens must be separated by single spaces");
    if (char === undefined || (char === " " && quote === undefined)) {
      const raw = body.slice(start, index);
      if (raw.length === 0) throw new RuleSpecifierError(text, "tokens must be separated by single spaces");
      words.push(raw);
      start = index + 1;
    } else if (char === "'" || char === '"') {
      if (quote === char) quote = undefined;
      else if (quote === undefined) quote = char;
    }
  }
  const wildcard = words.at(-1) === "*";
  if (wildcard) words.pop();
  if (words.length === 0) throw new RuleSpecifierError(text, "a bare * is not a command");
  const tokens = words.map((raw) => {
    const value = literalRuleWord(raw, dialect);
    if (value === undefined) throw new RuleSpecifierError(text, `argument contains ${dialect === "bash" ? "shell" : "PowerShell"} syntax or a wildcard; arguments must be literal`);
    return value;
  });
  return { tokens, wildcard, quoted: words.flatMap((raw, index) => /^["']/.test(raw) ? [index] : []) };
}

function formatShellRuleWord(token: string, dialect: "bash" | "powershell", quoted = false): string {
  const meta = dialect === "bash" ? SHELL_META_RE : POWERSHELL_META_RE;
  if (!quoted && token.length > 0 && !meta.test(token)) return token;
  if (!token.includes("'") && !token.includes("\0")) return `'${token}'`;
  if (dialect === "bash" && !token.includes("\0")) return token.split("'").map((part) => `'${part}'`).join('"\'"');
  const doubleQuoted = `"${token}"`;
  if (!token.includes('"') && literalRuleWord(doubleQuoted, dialect) === token) return doubleQuoted;
  throw new RuleSpecifierError(token, "argument has no supported literal quoted spelling");
}

// Shape test only: true when the pattern is written in the specifier language (`Name(...)`). It does not validate the body; use parseRuleSpecifier.
export function isRuleSpecifier(pattern: string): boolean {
  return SPECIFIER_HEAD_RE.test(pattern);
}

export function parseRuleSpecifier(text: string): RuleSpecifier {
  if (typeof text !== "string") throw new RuleSpecifierError(String(text), "not a string");
  if (text.length > MAX_SPECIFIER_LENGTH) throw new RuleSpecifierError(text.slice(0, 64), "too long");
  const match = SPECIFIER_RE.exec(text);
  if (!match) throw new RuleSpecifierError(text, "expected Bash(...), PowerShell(...), Edit(...), WebFetch(domain:...), Network(...) or Mcp(...)");
  const [, kind, body] = match as unknown as [string, string, string];
  switch (kind) {
    case "Bash": return parseBash(text, body);
    case "PowerShell": return parsePowerShell(text, body);
    case "Edit": return parseEdit(text, body);
    case "WebFetch": return parseWebFetch(text, body);
    case "Network": return parseNetwork(text, body);
    case "Mcp": return parseMcp(text, body);
    default: throw new RuleSpecifierError(text, `unknown rule kind ${kind}`);
  }
}

function parseBash(text: string, body: string): RuleSpecifier {
  const { tokens, wildcard } = shellRuleWords(text, body, "bash");
  return { kind: "bash", tokens: Object.freeze([...tokens]), wildcard };
}

// True for a built-in cmdlet (Verb-Noun) the command catalogue knows. Its name and parameter names bind case-insensitively on every edition.
function isKnownCmdlet(name: string): boolean {
  const lower = name.toLowerCase();
  if (!/^[a-z]+-[a-z0-9]+$/.test(lower)) return false;
  const policy = POWERSHELL_COMMAND_POLICIES[lower];
  return policy !== undefined && policy.native === undefined;
}

// The canonical spelling of a PowerShell rule argv (a literal argv, or a stored rule's tokens; `null` marks a non-literal token and stays null). Rule
// identity compares the literal command name: aliases differ between editions and platforms (`sc` is Set-Content in Windows PowerShell 5.1 but
// sc.exe in PowerShell 7; `ls`, `rm`, `cat`, `curl` and `wget` are native programs on macOS and Linux), so they are resolved only for floor
// classification, never here. Only a known cmdlet is case-folded: its name, and the NAME of each `-Parameter` (never a value after `:`). A native
// program's arguments are case-sensitive data (`git branch -d` is not `git branch -D`) and stay verbatim, as does an unknown command's.
export function canonicalPowerShellRuleTokens<T extends string | null>(tokens: readonly T[], literalParameters: readonly number[] = []): T[] {
  const head = tokens[0];
  const cmdlet = typeof head === "string" && isKnownCmdlet(head);
  if (!cmdlet) return [...tokens];
  return tokens.map((token, index) => {
    if (token === null) return token;
    if (index === 0) return token.toLowerCase() as T;
    if (literalParameters.includes(index)) return token;
    const parameter = /^(-[A-Za-z][A-Za-z0-9]*)(:[\s\S]*)?$/.exec(token);
    return (parameter ? parameter[1]!.toLowerCase() + (parameter[2] ?? "") : token) as T;
  });
}

export function literalPowerShellParameterIndexes(tokens: readonly (string | null)[], quoted: readonly number[]): number[] {
  return quoted.filter((index) => index > 0 && /^[-\u2013-\u2015]/.test(tokens[index] ?? ""));
}

function parsePowerShell(text: string, body: string): RuleSpecifier {
  const { tokens, wildcard, quoted } = shellRuleWords(text, body, "powershell");
  if (tokens[0] === ".") throw new RuleSpecifierError(text, "the dot-source operator is not a command");
  const literalParameters = literalPowerShellParameterIndexes(tokens, quoted);
  return { kind: "powershell", tokens: Object.freeze(canonicalPowerShellRuleTokens(tokens, literalParameters)), wildcard,
    ...(literalParameters.length > 0 ? { literalParameters: Object.freeze(literalParameters) } : {}) };
}

function parseEdit(text: string, body: string): RuleSpecifier {
  let path = body.replace(/\\/g, "/").normalize("NFC");
  if (path.split("/").some((segment) => segment.includes("**") && segment !== "**")) {
    throw new RuleSpecifierError(text, "** must be a whole path segment");
  }
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
  return { kind: "webfetch", ...parseHostPattern(text, body.slice("domain:".length)) };
}

// A connection is decided by its canonical host name; an address literal never reaches a host rule (the card offers none), so a rule naming one would
// parse, save and never match — a deny that is silently inert. Every spelling a resolver reads as an address is refused: dotted decimal, and any name
// whose last label is a number (`0x7f000001`, `2130706433`, `127.1`), since no host name ends in a numeric label.
function parseNetwork(text: string, body: string): RuleSpecifier {
  const spec = parseHostPattern(text, body);
  const last = spec.host.split(".").pop()!;
  if (/^(?:0x[0-9a-f]*|[0-9]+)$/.test(last)) {
    throw new RuleSpecifierError(text, "an IP address is not a host name; a Network(...) rule names a host (an address literal is never matched by one)");
  }
  return { kind: "network", ...spec };
}

// `<host>`, `*.<host>`, either with `:<port>`.
function parseHostPattern(text: string, pattern: string): { host: string; subdomains: boolean; port?: number } {
  let host = pattern;
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
    throw new RuleSpecifierError(text, "a *. wildcard needs at least two labels after *. (e.g. *.example.com)");
  }
  return { host, subdomains, ...(port === undefined ? {} : { port }) };
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
    case "bash": return `Bash(${[...spec.tokens.map((token) => formatShellRuleWord(token, "bash")), ...(spec.wildcard ? ["*"] : [])].join(" ")})`;
    case "powershell": return `PowerShell(${[...spec.tokens.map((token, index) => formatShellRuleWord(token, "powershell", spec.literalParameters?.includes(index))), ...(spec.wildcard ? ["*"] : [])].join(" ")})`;
    case "edit": return `Edit(${spec.recursive ? `${spec.path === "/" ? "" : spec.path}/**` : spec.path})`;
    case "webfetch": return `WebFetch(domain:${spec.subdomains ? "*." : ""}${spec.host}${spec.port === undefined ? "" : `:${spec.port}`})`;
    case "network": return `Network(${spec.subdomains ? "*." : ""}${spec.host}${spec.port === undefined ? "" : `:${spec.port}`})`;
    case "mcp": return `Mcp(${spec.server}${spec.tool === undefined ? "" : `:${spec.tool}`})`;
  }
}

// Parse, then re-format: the canonical spelling used for storage and dedup.
export function canonicalRuleSpecifier(text: string): string {
  return formatRuleSpecifier(parseRuleSpecifier(text));
}

// Trim and canonicalize edited shell rules while preserving whitespace inside quotes. The approval dock and host save path share this spelling; the store still refuses non-canonical input from other paths.
export function normalizeRuleSpecifierInput(text: string): string {
  const trimmed = text.trim();
  const shell = /^(Bash|PowerShell)\((.*)\)$/s.exec(trimmed);
  if (!shell) return trimmed;
  let body = "";
  let quote: string | undefined;
  for (const char of shell[2]!.trim()) {
    if ((char === " " || char === "\t") && quote === undefined) {
      if (!body.endsWith(" ")) body += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = undefined;
      else if (quote === undefined) quote = char;
    }
    body += char;
  }
  const normalized = `${shell[1]}(${body})`;
  try { return canonicalRuleSpecifier(normalized); } catch { return normalized; }
}

// Storage admits only rule kinds wired into the host decision path.
export const ENFORCED_RULE_KINDS: ReadonlySet<RuleSpecifierKind> = new Set(["bash", "powershell", "edit", "webfetch", "network", "mcp"]);

// Match a destination hostname and its effective transport port.
export function matchesWebFetchHost(spec: Extract<RuleSpecifier, { kind: "webfetch" | "network" }>, host: string, port?: number): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (spec.port !== undefined && spec.port !== port) return false;
  if (!normalized.split(".").every((label) => HOST_LABEL_RE.test(label))) return false;
  return spec.subdomains ? normalized.endsWith(`.${spec.host}`) : normalized === spec.host;
}

// Match the original server/tool pair, without decoding a namespaced tool name.
export function matchesMcpTool(spec: Extract<RuleSpecifier, { kind: "mcp" }>, server: string, tool: string): boolean {
  return spec.server === server && (spec.tool === undefined || spec.tool === tool);
}
