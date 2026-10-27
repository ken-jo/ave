import { t } from "../i18n/index.js";
import { errorMessage } from "./error-message.js";

export interface DlpResult {
  masked: string;
  detections: string[];
}

/** Read PII policy per call; credential scrubbing always applies regardless of the privacy preference. */
let readPiiRedactionEnabled: () => boolean = () => false;

export function initPiiRedactionPolicy(read: () => boolean): void {
  readPiiRedactionEnabled = read;
}

export function isPiiRedactionEnabled(): boolean {
  return readPiiRedactionEnabled();
}

export interface MaskSensitiveDataOptions {
  /** PII detection defaults on for structural checks; privacy-governed surfaces pass the live setting. */
  pii?: boolean;
}

/** Credential-scrub and cap external errors before logs, status, or model output. */
export function scrubShortError(text: string): string {
  return scrubSecretsForLLM(text).slice(0, 120);
}

/** Userinfo a diagnostic may keep: an ssh account name. Anything else (`:`, `@`, …) may hide a secret. */
const SSH_ACCOUNT = /^[A-Za-z0-9._~][A-Za-z0-9._~-]*$/u;

/** Keep only decoded SSH account names; HTTP userinfo and undecodable escapes may contain credentials. */
function userinfoHidesCredential(userinfo: string, scheme: string | undefined): boolean {
  if (scheme !== undefined && overHttp(scheme)) return true;
  try {
    return !SSH_ACCOUNT.test(decodeURIComponent(userinfo));
  } catch {
    return true;
  }
}

function overHttp(scheme: string): boolean {
  return scheme.toLowerCase().split("+").some((part) => part === "http" || part === "https");
}

const CREDENTIAL_WORDS = [
  "token", "secret", "password", "passwd", "pwd", "apikey", "api_key", "api-key", "accesskey", "access_key", "access-key",
  "privatekey", "private_key", "private-key", "credential", "bearer",
] as const;

/** Match credential words or whole auth/pat segments, never incidental substrings such as author or path. */
function isCredentialKey(key: string): boolean {
  // Markers inside keys are not key material; marker-only keys fail closed as credential names.
  const stripped = key.replace(/\[REDACTED:[A-Z_]+\]/gu, "");
  if (stripped !== key && stripped.trim() === "") return true;
  const lower = stripped.toLowerCase();
  const segments = lower.split(/[^a-z0-9]/u);
  return CREDENTIAL_WORDS.some((word) => lower.includes(word)) || segments.includes("auth") || segments.includes("pat");
}

const JSON_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Decode quoted-key escapes; return null when any escape is invalid. */
function decodeQuotedKey(body: string, quote: string): string | null {
  let decoded = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      decoded += body[i];
      continue;
    }
    const escape = body[++i];
    if (escape === "u") {
      const hex = body.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/u.test(hex)) return null;
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
    } else if (escape === quote) {
      decoded += quote;
    } else {
      const char = escape === undefined ? undefined : JSON_ESCAPES[escape];
      if (char === undefined) return null;
      decoded += char;
    }
  }
  return decoded;
}

function isKeyChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 46 || code === 45;
}

const isBlank = (char: string | undefined): boolean => char === " " || char === "\t";
const isWhitespace = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char);
/** HTTP auth schemes: a bare value that starts with one goes on through the credentials after it (`Basic dXNl…`). */
const AUTH_SCHEMES: ReadonlySet<string> = new Set(["basic", "bearer", "digest", "negotiate", "token"]);
const REDACTION_MARKER = /\[REDACTED:[A-Z_]+\]/y;
const isJsonWhitespace = (char: string | undefined): boolean => char === " " || char === "\t" || char === "\r" || char === "\n";

/** Find the matching quote within this line and limit; return -1 when unclosed. */
function closingQuoteOnLine(text: string, start: number, limit: number): number {
  const quote = text[start];
  for (let i = start + 1; i < limit && text[i] !== "\n"; i++) {
    // An escape never carries the string past its line's end.
    if (text[i] === "\\" && text[i + 1] !== "\n") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** Read nested JSON-string quotes one escape level at a time; a bare outer quote ends the carrier. */
function escapedStringScan(text: string, start: number, limit: number): { close: number; scanned: number } {
  let escape = false;
  let i = start + 2;
  while (i < limit && text[i] !== "\n") {
    const at = i;
    if (text[i] === '"') break;
    let char = text[i]!;
    if (char === "\\") {
      if (i + 1 >= limit || text[i + 1] === "\n") break;
      char = text[i + 1]!;
      i += 2;
    } else {
      i += 1;
    }
    if (escape) escape = false;
    else if (char === "\\") escape = true;
    else if (char === '"') return { close: at, scanned: i };
  }
  return { close: -1, scanned: i };
}

/** Scan assignments and credential flags linearly, including quoted and nested keys; malformed internal state must fail closed. Preserve the key separator when masking nested values. */
function redactCredentialAssignments(text: string): string {
  let out = "";
  let copied = 0;
  let floor = 0;
  let lineFirst = -1;
  let backslashes = 0;
  /** No `\"` string opens before this: one already scanned there. */
  let escapedScanned = 0;
  const redact = (valueStart: number, valueEnd: number): number => {
    out += `${text.slice(copied, valueStart)}[REDACTED:TOKEN]`;
    copied = valueEnd;
    floor = valueEnd;
    if (text.slice(valueStart, valueEnd).includes("\n")) lineFirst = valueStart;
    return valueEnd - 1;
  };
  /** Track nested quoted keys so each separator consumes its whole key, never an inner separator. */
  const pending: Array<{ close: number; separator: number; keyStart: number; key: string | null }> = [];
  /** Bound nested value reads by the enclosing key’s closing quote. */
  const limitAt = (at: number): number => {
    const key = pending[pending.length - 1];
    return key !== undefined && at < key.close ? key.close : text.length;
  };
  // Authorization values are already consumed whole by the preceding header pass.
  const valueEnd = (start: number, toLineEnd: boolean, limit: number): number => {
    if (start >= limit) return start;
    if (text[start] === '"' || text[start] === "'") {
      const close = closingQuoteOnLine(text, start, limit);
      return close === -1 ? limit : close + 1;
    }
    if (text[start] === "\\" && text[start + 1] === '"') {
      const { close } = escapedStringScan(text, start, limit);
      return close === -1 ? limit : close + 2;
    }
    let end = start;
    if (toLineEnd) {
      while (end < limit && text[end] !== "\n" && text[end] !== "\r") end++;
      return end;
    }
    while (end < limit && !isWhitespace(text[end])) end++;
    if (AUTH_SCHEMES.has(text.slice(start, end).toLowerCase())) {
      let word = end;
      while (word < limit && isBlank(text[word])) word++;
      let wordEnd = word;
      while (wordEnd < limit && !isWhitespace(text[wordEnd])) wordEnd++;
      if (wordEnd > word) end = wordEnd;
    }
    return end;
  };
  /** Quoted-key values may cross JSON whitespace; bare keys skip blanks only and cannot consume the next line. */
  const assignment = (separator: number, keyStart: number, key: string | null, quoted: boolean): number => {
    floor = separator + 1;
    if (key !== null && !isCredentialKey(key)) return separator;
    const limit = limitAt(separator);
    let at = separator;
    let resumeAt = separator;
    // A value that a separator follows was the next key, read as this one's value: its value goes too.
    for (let first = true; ; first = false) {
      let start = at + 1;
      while (start < limit && (quoted || !first ? isJsonWhitespace(text[start]) : isBlank(text[start]))) start++;
      // A marker alone is already redacted; any value continuing past it still needs masking.
      REDACTION_MARKER.lastIndex = Math.min(skipSeparatorSpace(text, start), limit);
      if (REDACTION_MARKER.test(text) && (REDACTION_MARKER.lastIndex >= limit || isWhitespace(text[REDACTION_MARKER.lastIndex]))) return resumeAt;
      let stop = valueEnd(start, first && text[at] === "=" && keyStart === lineFirst, limit);
      if (text.slice(at + 1, start).includes("\n")) {
        let lineEnd = start;
        while (lineEnd < limit && text[lineEnd] !== "\n") lineEnd++;
        stop = Math.max(stop, lineEnd);
      }
      if (stop <= start) return resumeAt;
      resumeAt = redact(start, stop);
      let next = stop;
      while (next < limit && isJsonWhitespace(text[next])) next++;
      if (next >= limit || (text[next] !== ":" && text[next] !== "=")) return resumeAt;
      at = next;
      floor = at + 1;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const escaped = backslashes % 2 === 1;
    backslashes = char === "\\" ? backslashes + 1 : 0;
    const ahead = pending[pending.length - 1];
    if (ahead !== undefined && ahead.separator < i) throw new Error(`credential scan passed the separator of the key at ${ahead.keyStart}`);
    if (ahead?.separator === i) {
      pending.pop();
      i = assignment(i, ahead.keyStart, ahead.key, true);
      backslashes = 0;
      continue;
    }
    if (char === "\n") {
      lineFirst = -1;
      floor = i + 1;
      continue;
    }
    if (lineFirst === -1 && !isBlank(char) && char !== "\r") lineFirst = i;
    // A pending key's closing quote ends that key; it never opens another string.
    if (ahead !== undefined && i === ahead.close) continue;

    if ((char === '"' || char === "'") && !escaped) {
      const close = closingQuoteOnLine(text, i, limitAt(i));
      if (close === -1) continue;
      let separator = close + 1;
      while (isJsonWhitespace(text[separator])) separator++;
      if (text[separator] === ":" || text[separator] === "=") pending.push({ close, separator, keyStart: i, key: decodeQuotedKey(text.slice(i + 1, close), char) });
      continue;
    }

    if (char === "\\" && text[i + 1] === '"' && !escaped && i >= escapedScanned) {
      const { close, scanned } = escapedStringScan(text, i, limitAt(i));
      // A scanned string cannot open another escaped quote; its closing quote may expose the next key.
      escapedScanned = close === -1 ? scanned : close;
      if (close === -1) continue;
      let separator = close + 2;
      while (isJsonWhitespace(text[separator])) separator++;
      if (text[separator] !== ":" && text[separator] !== "=") continue;
      // One level unescaped gives the inner JSON's key; its own escapes are decoded when they decode.
      const inner = decodeQuotedKey(text.slice(i + 2, close), '"');
      pending.push({ close, separator, keyStart: i, key: inner === null ? null : (decodeQuotedKey(inner, '"') ?? inner) });
      continue;
    }

    if (char === "-" && text[i + 1] === "-" && (i === 0 || isWhitespace(text[i - 1]))) {
      const limit = limitAt(i);
      const keyStart = i + 2;
      let end = keyStart;
      while (end < limit && isKeyChar(text.charCodeAt(end))) end++;
      i = end - 1;
      if (end > keyStart && isBlank(text[end]) && isCredentialKey(text.slice(keyStart, end))) {
        let start = end;
        while (start < limit && isBlank(text[start])) start++;
        const stop = start < limit && text[start] !== "-" && !isWhitespace(text[start]) ? valueEnd(start, false, limit) : start;
        if (stop > start) i = redact(start, stop);
      }
      backslashes = 0;
      continue;
    }

    if (char !== "=" && char !== ":") continue;
    let keyEnd = i;
    while (keyEnd > floor && isBlank(text[keyEnd - 1])) keyEnd--;
    // A key whose opening quote went unrecognized (`token":`) still names what it names.
    if (keyEnd > floor && (text[keyEnd - 1] === '"' || text[keyEnd - 1] === "'")) keyEnd--;
    let keyStart = keyEnd;
    while (keyStart > floor && isKeyChar(text.charCodeAt(keyStart - 1))) keyStart--;
    if (keyStart === keyEnd) {
      floor = i + 1;
      continue;
    }
    i = assignment(i, keyStart, text.slice(keyStart, keyEnd), false);
  }
  return out + text.slice(copied);
}

/** Redact diagnostic userinfo and assignments; throw only on internal contract violations. */
export function scrubDiagnosticSecretsStrict(text: string): string {
  // Process Authorization headers before other credential shapes.
  return scrubCredentialShapes(redactCredentialAssignments(
    maskAuthorizationValues(text)
      // Start schemes only at a left boundary so repeated scheme characters are scanned once.
      .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*)(:\/\/)([^\s/?#]*)@/gi, (match: string, scheme: string, slashes: string, userinfo: string): string =>
        userinfoHidesCredential(userinfo, scheme) ? `${scheme}${slashes}[REDACTED:CREDENTIALS]@` : match,
      )
      .replace(/(^|[\s'"(<=,;])([^\s'"()<>/?#=,;]+)@(?=[A-Za-z0-9[])/gm, (match: string, before: string, userinfo: string): string =>
        userinfoHidesCredential(userinfo, undefined) ? `${before}[REDACTED:CREDENTIALS]@` : match,
      ),
  ), "precise");
}

/** Scrub diagnostic userinfo and assignments; on internal failure redact everything and log only error and length. */
export function scrubDiagnosticSecrets(text: string): string {
  try {
    return scrubDiagnosticSecretsStrict(text);
  } catch (error) {
    console.warn(`[dlp] diagnostic scrubber failed closed (${typeof text === "string" ? `${text.length} chars` : typeof text}): ${errorMessage(error)}`);
    return "[REDACTED:DIAGNOSTIC]";
  }
}

export function hasRedaction(text: string): boolean {
  return /\[REDACTED:[A-Z_]+\]/u.test(text);
}

/** Detect credentials by format or context, not generic entropy, so artifact hashes remain useful. Model-bound text uses broader prefix rules. */
export function scrubSecretsForLLM(text: string): string {
  return scrubCredentialShapes(maskAuthorizationValues(text), "broad");
}

/** Credential formats require a non-alphanumeric left boundary, a case-sensitive prefix, and sufficient greedy body length. Prefixless secrets require credential context. */
const FORMAT_ROWS: ReadonlyArray<{ issuer: CredentialIssuer; prefixes: readonly string[]; pattern: RegExp }> = [
  { issuer: "github", prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/g },
  // Installation-token structured bodies must match their real shape; a loose prefix can consume ordinary filenames.
  { issuer: "github", prefixes: ["ghs_"], pattern: /(?<![A-Za-z0-9])ghs_[A-Za-z0-9]+_eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { issuer: "github", prefixes: ["github_pat_"], pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59,}/g },
  { issuer: "gitlab", prefixes: ["glpat-", "gldt-", "glrt-", "glptt-", "glcbt-", "glsoat-"], pattern: /(?<![A-Za-z0-9])gl(?:pat|dt|rt|ptt|cbt|soat)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g },
  { issuer: "npm", prefixes: ["npm_"], pattern: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36,}/g },
  { issuer: "slack", prefixes: ["xoxa-", "xoxb-", "xoxp-", "xoxo-", "xoxs-", "xoxr-", "xoxe-"], pattern: /(?<![A-Za-z0-9])xox[abposre]-\d{6,}-[0-9A-Za-z-]{8,}/g },
  { issuer: "slack", prefixes: ["xapp-"], pattern: /(?<![A-Za-z0-9])xapp-\d-[A-Z0-9]+-\d+-[A-Za-z0-9]+/g },
  { issuer: "aws", prefixes: ["AKIA", "ASIA"], pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16,}/g },
  { issuer: "google", prefixes: ["AIza"], pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35,}/g },
  // Order extending key prefixes before general prefixes so issuer selection stays specific.
  { issuer: "anthropic", prefixes: ["sk-ant-"], pattern: /(?<![A-Za-z0-9])sk-ant-(?:api|admin|sid|oat|ort)\d{2}-[A-Za-z0-9_-]{32,}/g },
  { issuer: "openai", prefixes: ["sk-proj-", "sk-svcacct-", "sk-admin-"], pattern: /(?<![A-Za-z0-9])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g },
  { issuer: "openai", prefixes: ["sk-"], pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{48,}/g },
  { issuer: "openai", prefixes: ["sk-"], pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]*T3BlbkFJ[A-Za-z0-9_-]*/g },
  { issuer: "stripe", prefixes: ["sk_live_", "sk_test_", "pk_live_", "pk_test_", "rk_live_", "rk_test_"], pattern: /(?<![A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}/g },
  // JWTs require three base64url segments and a JSON-object header prefix.
  { issuer: "jwt", prefixes: ["eyJ"], pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
];

/** Build a sticky literal-prefix matcher for each credential-format row. */
const CREDENTIAL_FORMATS = FORMAT_ROWS.map((row) => ({
  ...row,
  lead: new RegExp(row.prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "y"),
}));

/** Preserve row order when deriving literal prefixes; the contract requires specific prefixes first. */
export const CREDENTIAL_FORMAT_PREFIXES: ReadonlyArray<readonly string[]> = FORMAT_ROWS.map((row) => row.prefixes);

/** Reserved prefixes name the credential issuer defined by the scanning contract. */
export const CREDENTIAL_ISSUERS = ["github", "gitlab", "npm", "slack", "aws", "google", "openai", "anthropic", "stripe", "jwt"] as const;
export type CredentialIssuer = (typeof CREDENTIAL_ISSUERS)[number];

/** Main uses these English issuer labels; renderers use localized catalog messages. */
export const CREDENTIAL_ISSUER_NAMES: Readonly<Record<CredentialIssuer, string>> = {
  github: "a GitHub token",
  gitlab: "a GitLab token",
  npm: "an npm token",
  slack: "a Slack token",
  aws: "an AWS access key",
  google: "a Google API key",
  openai: "an OpenAI API key",
  anthropic: "an Anthropic API key",
  stripe: "a Stripe key",
  jwt: "a JSON Web Token",
};

export interface ReservedPrefix {
  prefix: string;
  issuer: CredentialIssuer;
}

/** Report the earliest complete credential format; equal starts use table order so longer specific prefixes win. */
export function reservedPrefixIn(text: string): ReservedPrefix | null {
  let found: (ReservedPrefix & { at: number }) | null = null;
  for (const format of CREDENTIAL_FORMATS) {
    format.pattern.lastIndex = 0;
    const match = format.pattern.exec(text);
    format.pattern.lastIndex = 0;
    if (!match) continue;
    format.lead.lastIndex = match.index;
    const prefix = format.lead.exec(text)?.[0];
    if (prefix === undefined) throw new Error(`credential format of ${format.issuer} matched without its prefix`);
    if (found === null || match.index < found.at) {
      found = { at: match.index, prefix, issuer: format.issuer };
    }
  }
  return found === null ? null : { prefix: found.prefix, issuer: found.issuer };
}

/** Report any diagnostic credential shape, including userinfo and assignments. */
export function holdsCredential(text: string): boolean {
  return scrubDiagnosticSecrets(text) !== text;
}

/** Authorization values extend through folded continuation lines; quotes never terminate them early. */
function authorizationValueEnd(text: string, start: number): number {
  let end = start;
  for (;;) {
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
    let next = end;
    if (text[next] === "\r") next++;
    if (text[next] === "\n") next++;
    if (next === end || next >= text.length || !isBlank(text[next])) return end;
    end = next;
  }
}

/** Match header names case-insensitively, including Unicode escapes at any backslash depth. */
function escapedNamePattern(name: string): string {
  return [...name].map((char) => {
    const codes = [...new Set([char.toLowerCase(), char.toUpperCase()])].map((form) => form.charCodeAt(0).toString(16).padStart(4, "0"));
    // Consume backslash runs once so escaped-key scanning stays linear.
    return `(?:${char}|(?<!\\\\)\\\\+u(?:${codes.join("|")}))`;
  }).join("");
}

/** Classify raw and decoded separator whitespace with the same language-defined predicate. */
function isSeparatorSpace(char: string): boolean {
  return /^\s$/u.test(char);
}

const LETTER_ESCAPES: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v", b: "\b" };

/** Skip raw or escaped separator whitespace forward only, at every backslash depth. */
function skipSeparatorSpace(text: string, start: number): number {
  let at = start;
  while (at < text.length) {
    if (isSeparatorSpace(text[at]!)) {
      at++;
      continue;
    }
    if (text[at] !== "\\") return at;
    let letter = at;
    while (text[letter] === "\\") letter++;
    const code = text[letter];
    let decoded: string | undefined;
    let next = letter + 1;
    if (code === "u" && /^[0-9A-Fa-f]{4}$/u.test(text.slice(letter + 1, letter + 5))) {
      decoded = String.fromCharCode(Number.parseInt(text.slice(letter + 1, letter + 5), 16));
      next = letter + 5;
    } else if (code !== undefined) {
      decoded = LETTER_ESCAPES[code];
    }
    if (decoded === undefined || !isSeparatorSpace(decoded)) return at;
    at = next;
  }
  return at;
}

const isAlphanumeric = (char: string): boolean => /^[A-Za-z0-9]$/u.test(char);

/** Decode Unicode key escapes; consume invalid backslash runs as one character. */
function keyCharAt(text: string, at: number): { char: string; next: number } | undefined {
  if (at >= text.length) return undefined;
  if (text[at] !== "\\") return { char: text[at]!, next: at + 1 };
  let letter = at;
  while (text[letter] === "\\") letter++;
  const hex = text.slice(letter + 1, letter + 5);
  if (text[letter] === "u" && /^[0-9A-Fa-f]{4}$/u.test(hex)) return { char: String.fromCharCode(Number.parseInt(hex, 16)), next: letter + 5 };
  return { char: "\\", next: letter };
}

/** Match authorization as a delimited key word or long flag, including escaped letters and punctuation. */
const AUTHORIZATION_NAME = new RegExp(
  String.raw`(?<!\S)--(?:proxy-)?authorization[ \t]+` +
    String.raw`|(?:(?<![A-Za-z0-9])|(?<=\\[nrtbfv])|(?<=\\u[0-9A-Fa-f]{4}))` +
    escapedNamePattern("authorization"),
  "giu",
);

/** Bound key-tail reads, including the separator read. */
const KEY_WINDOW = 256;

/** Read to the first raw or escaped separator without pairing quotes; allow one line crossing and a bounded number of UTF-16 or escape reads. */
function separatorAfterName(text: string, nameEnd: number): number | undefined {
  const first = keyCharAt(text, nameEnd);
  if (first !== undefined && isAlphanumeric(first.char)) return undefined;
  let at = nameEnd;
  let lineBreaks = 0;
  for (let read = 0; read < KEY_WINDOW && at < text.length; read++) {
    if (text[at] === "\n" || text[at] === "\r") {
      // A raw line break and its surrounding raw or escaped whitespace count as one crossing.
      if (++lineBreaks > 1) return undefined;
      at = skipSeparatorSpace(text, at);
      continue;
    }
    const next = keyCharAt(text, at)!;
    if (next.char === ":" || next.char === "=") return next.next;
    at = next.next;
  }
  return undefined;
}

/** Authorization-key masking takes precedence in refusal reasons; other credential shapes report credential. */
export function modelBoundCredentialKind(text: string): "authorization-key" | "credential" | null {
  if (maskAuthorizationValues(text) !== text) return "authorization-key";
  return scrubSecretsForLLM(text) !== text ? "credential" : null;
}

/** Mask each Authorization value whole before other stages; existing markers cannot hide trailing secrets. */
function maskAuthorizationValues(text: string): string {
  let out = "";
  let copied = 0;
  AUTHORIZATION_NAME.lastIndex = 0;
  for (let match = AUTHORIZATION_NAME.exec(text); match !== null; match = AUTHORIZATION_NAME.exec(text)) {
    const nameEnd = match.index + match[0].length;
    const flag = match[0].startsWith("--");
    const separatorEnd = flag ? nameEnd : separatorAfterName(text, nameEnd);
    if (separatorEnd === undefined) continue;
    const start = flag ? nameEnd : skipSeparatorSpace(text, separatorEnd);
    const end = authorizationValueEnd(text, start);
    if (end === start) continue;
    out += `${text.slice(copied, start)}[REDACTED:TOKEN]`;
    copied = end;
    AUTHORIZATION_NAME.lastIndex = end;
  }
  return out + text.slice(copied);
}

/** Both modes detect real formats and contexts; broad model-bound mode also masks bare vendor prefixes. */
function scrubCredentialShapes(text: string, mode: "broad" | "precise"): string {
  let out = text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED:PRIVATE_KEY]")
    .replace(
      /((?:x-api-key|x-auth-token)\s*:\s*)[A-Za-z0-9._\-~+/=]+/gi,
      "$1[REDACTED:TOKEN]",
    )
    .replace(/\bbearer\s+[A-Za-z0-9._\-~+/=]+/gi, "Bearer [REDACTED:TOKEN]")
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token))=([^&\s]+)/gi,
      "$1=[REDACTED:TOKEN]",
    )
    .replace(
      /(["'](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|x-api-key|x-auth-token|aws[_-]?secret[_-]?access[_-]?key)["']\s*:\s*["'])[^"']+(["'])/gi,
      "$1[REDACTED:TOKEN]$2",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED:JWT]")
    // Mask adjacent access-key secrets before standalone key-id passes so the secret cannot remain visible.
    .replace(
      /\bAKIA[0-9A-Z]{16}([\s:=,]+)[A-Za-z0-9/+=]{40}(?=$|[^A-Za-z0-9/+=])/gi,
      "[REDACTED:TOKEN]$1[REDACTED:TOKEN]",
    )
    .replace(/\b(AWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(["']?)/gi, "$1[REDACTED:TOKEN]$2");
  for (const format of CREDENTIAL_FORMATS) out = out.replace(format.pattern, "[REDACTED:TOKEN]");
  if (mode === "precise") return out;
  return out
    // Broad model-bound mode also matches reserved prefixes without complete token formats.
    .replace(/\bgh[opsru]_[A-Za-z0-9_]{20,}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bxox[bp]-[A-Za-z0-9-]{10,}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bxapp-[A-Za-z0-9-]{10,}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\b(?:sk|pk|rk|proj|test|live)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED:TOKEN]");
}

/** Luhn is a detection gate shared by both consumers; failed candidates remain unchanged. */
function luhnValid(num: string): boolean {
  const digits = num.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

type PiiKind = "SSN_KR" | "EMAIL" | "PHONE_KR" | "PHONE_US" | "PHONE_INTL" | "CREDIT_CARD";

/** Share detection and order; display preserves silhouettes while model-bound replacement fully redacts. */
export interface PiiPattern {
  kind: PiiKind;
  nameKey: string;
  pattern: RegExp;
  /** Rejected validity candidates remain intact for both replacement modes. */
  valid?: (match: string) => boolean;
  /** Display-shape-preserving replacement (audit / display / agent-egress masking). */
  maskShape: (match: string, ...groups: string[]) => string;
  /** Full-redaction token (text handed to a model). */
  redactToken: string;
}

function internationalPhonePattern(): RegExp {
  const separator = String.raw`[ \t().-]{0,3}`;
  const nationalNumber = (leadingDigits: readonly string[], remainingDigits: string): string =>
    `${leadingDigits.join(separator)}(?:${separator}\\d){${remainingDigits}}`;
  // Use country-specific lengths and grouping so adjacent numeric fields cannot extend complete phone matches.
  const nationalForms: readonly (readonly [string, string])[] = [
    ["1", nationalNumber(["[2-9]", "\\d", "\\d", "[2-9]"], "6")],
    ["44", nationalNumber(["[1-9]"], "9")],
    ["82", `(?:${[
      nationalNumber(["1", "0"], "8"),
      `(?:1${separator}[16789]|2|[3-6]${separator}\\d)${separator}\\d{3,4}${separator}\\d{4}`,
    ].join("|")})`],
    ["81", `(?:${[
      nationalNumber(["[789]", "0"], "8"),
      nationalNumber(["5", "0"], "8"),
      nationalNumber([`(?!5${separator}0)[1-6]`], "8"),
    ].join("|")})`],
    ...["33", "420", "351"].map((countryCode): readonly [string, string] =>
      [countryCode, nationalNumber(["[1-9]"], "8")]),
  ];
  const forms = nationalForms.map(([countryCode, national]) =>
    `${countryCode}${separator}${national}`).join("|");
  // Allow trailing letters but reject prefixes of longer uninterrupted digit runs.
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}_+.-])\+(?:${forms})(?!\p{N}|[_+]|[.-][\p{L}\p{N}_]|[().-]{0,3}\d)`,
    "gu",
  );
}

/** Detection order matters: email before phone/card, and IDs before cards; bound numeric identities and validate cards with Luhn. */
export const PII_PATTERNS: PiiPattern[] = [
  {
    kind: "SSN_KR",
    nameKey: "be_dlp.patternResidentId",
    pattern: /\b\d{6}-[1-4]\d{6}\b/g,
    maskShape: (m) => m.replace(/\d/g, "*"),
    redactToken: "[REDACTED:SSN]",
  },
  {
    kind: "EMAIL",
    nameKey: "be_dlp.patternEmail",
    pattern: /[a-zA-Z0-9._%+-]+@([\w.-]+\.\w+)/g,
    maskShape: (_m, domain) => `***@${domain}`,
    redactToken: "[REDACTED:EMAIL]",
  },
  {
    kind: "PHONE_INTL",
    nameKey: "be_dlp.patternPhoneNumber",
    pattern: internationalPhonePattern(),
    valid: (m) => !(/^\+(?:\d{1,3}\.){3}\d{1,3}$/.test(m)
        && m.slice(1).split(".").every((octet) => Number(octet) <= 255)),
    maskShape: (m) => m.replace(/\d/g, "*"),
    redactToken: "[REDACTED:PHONE]",
  },
  {
    kind: "PHONE_KR",
    nameKey: "be_dlp.patternPhoneNumber",
    pattern: /01[016789]-?\d{3,4}-?\d{4}/g,
    // Keep carrier prefixes and separators while masking the remaining phone digits.
    maskShape: (m) => m.slice(0, 3) + m.slice(3).replace(/\d/g, "*"),
    redactToken: "[REDACTED:PHONE]",
  },
  {
    kind: "PHONE_US",
    nameKey: "be_dlp.patternPhoneNumber",
    pattern: /(?:\(\d{3}\)\s?|\b\d{3}[-.])\d{3}[-.\s]\d{4}\b/g,
    maskShape: (m) => m.replace(/\d/g, "*"),
    redactToken: "[REDACTED:PHONE]",
  },
  {
    kind: "CREDIT_CARD",
    nameKey: "be_dlp.patternCreditCard",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    valid: luhnValid,
    // Keep the final four card digits and original grouping.
    maskShape: (m) => {
      const total = (m.match(/\d/g) ?? []).length;
      let seen = 0;
      return m.replace(/\d/g, (d) => (++seen > total - 4 ? d : "*"));
    },
    redactToken: "[REDACTED:CC]",
  },
];

/** Scrub credentials first; with PII disabled, preserve all PII and report only credential detections. */
export function maskSensitiveData(
  text: string,
  options?: MaskSensitiveDataOptions,
): DlpResult {
  const detections: string[] = [];
  let masked = scrubSecretsForLLM(text);
  if (masked !== text) {
    detections.push(t("be_dlp.patternCredential"));
  }

  if (options?.pii === false) return { masked, detections };

  for (const spec of PII_PATTERNS) {
    spec.pattern.lastIndex = 0;
    const before = masked;
    masked = masked.replace(spec.pattern, (match: string, ...rest: unknown[]): string => {
      if (spec.valid && !spec.valid(match)) return match;
      // Replace callbacks append numeric offsets after captures; pass only string groups to shape maskers.
      const offsetIdx = rest.findIndex((a) => typeof a === "number");
      const groups = (offsetIdx === -1 ? [] : rest.slice(0, offsetIdx)) as string[];
      return spec.maskShape(match, ...groups);
    });
    if (masked !== before) {
      const label = t(spec.nameKey);
      if (!detections.includes(label)) detections.push(label);
    }
  }

  return { masked, detections };
}
