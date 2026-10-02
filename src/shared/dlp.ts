import { t } from "../i18n/index.js";
import { errorMessage } from "./error-message.js";

export interface DlpResult {
  masked: string;
  detections: string[];
}

/**
 * Reads the user's `privacy.piiRedactEnabled` setting. Injected rather than
 * imported so this leaf keeps no dependency on the settings store, and read at
 * each call rather than captured once so flipping the toggle takes effect
 * without a restart. Installed where the DLP audit logger is (IPC
 * registration); until then this mirrors the shipped default,
 * `privacy.piiRedactEnabled: false`.
 *
 * The setting governs PII only. Credential scrubbing is a security control, not
 * a privacy preference — a leaked bearer token in a log line is a defect
 * whatever the user asked for — so {@link scrubSecretsForLLM} runs on every
 * masking path regardless of this value.
 */
let readPiiRedactionEnabled: () => boolean = () => false;

export function initPiiRedactionPolicy(read: () => boolean): void {
  readPiiRedactionEnabled = read;
}

export function isPiiRedactionEnabled(): boolean {
  return readPiiRedactionEnabled();
}

export interface MaskSensitiveDataOptions {
  /**
   * Mask PII spans in addition to credentials. Defaults to `true`, so a caller
   * asking "does this host-generated identifier look like PII?" keeps a fixed
   * answer that a user setting cannot flip. The privacy-governed surfaces —
   * tool-output display and audit text — pass {@link isPiiRedactionEnabled}
   * explicitly.
   */
  pii?: boolean;
}

/**
 * Short, scrubbed form for an error surface — a log line, a status string, a
 * message handed to the model. Credential-scrubbed by {@link scrubSecretsForLLM}
 * and hard-capped, because the text is usually authored by something the host does
 * not control (an MCP server's JSON-RPC error, a transport failure) and neither
 * its length nor its content is bounded at the source.
 *
 * Lives HERE, beside the scrubber it wraps, rather than in one consumer: a caller
 * needing a bounded error string should not have to import a transport module to
 * get one.
 */
export function scrubShortError(text: string): string {
  return scrubSecretsForLLM(text).slice(0, 120);
}

/** Userinfo a diagnostic may keep: an ssh account name. Anything else (`:`, `@`, …) may hide a secret. */
const SSH_ACCOUNT = /^[A-Za-z0-9._~][A-Za-z0-9._~-]*$/u;

/**
 * Whether the userinfo of an address (`scheme` is undefined for the scp form
 * `user@host:path`) may hide a credential. Over http(s) any userinfo may: a
 * lone name there is a token. Otherwise only an ssh account name is kept,
 * judged percent-decoded, so `%3A` is the `:` that separates a password and
 * an escape that does not decode is not a name.
 */
function userinfoHidesCredential(userinfo: string, scheme: string | undefined): boolean {
  if (scheme !== undefined && overHttp(scheme)) return true;
  try {
    return !SSH_ACCOUNT.test(decodeURIComponent(userinfo));
  } catch {
    return true;
  }
}

/** `https`, `http`, or a scheme that rides on one (`git+https`, `svn+http`). */
function overHttp(scheme: string): boolean {
  return scheme.toLowerCase().split("+").some((part) => part === "http" || part === "https");
}

/** Words that make a key a credential's, matched in the lowercased key. */
const CREDENTIAL_WORDS = [
  "token", "secret", "password", "passwd", "pwd", "apikey", "api_key", "api-key", "accesskey", "access_key", "access-key",
  "privatekey", "private_key", "private-key", "credential", "bearer", "authorization",
] as const;

/**
 * Whether `key` names a credential: it holds a credential word in any case
 * (`api_key`, `GH_TOKEN`, `db.password`, `X-Api-Key`), or has `auth` as a
 * whole segment (`x-auth`, `auth_header`; not `author` or `oauth`).
 */
function isCredentialKey(key: string): boolean {
  // A redaction marker another pass left in the key (`[REDACTED:CREDENTIALS]`) is never key material,
  // and a key that was nothing but markers hid what it named: it counts as a credential's.
  const stripped = key.replace(/\[REDACTED:[A-Z_]+\]/gu, "");
  if (stripped !== key && stripped.trim() === "") return true;
  const lower = stripped.toLowerCase();
  return CREDENTIAL_WORDS.some((word) => lower.includes(word)) || lower.split(/[^a-z0-9]/u).includes("auth");
}

const JSON_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** A quoted key's body with its JSON escapes (and an escaped `quote`) decoded; null when an escape is not one. */
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

/** Whether `key` names an Authorization header (`Authorization`, `Proxy-Authorization`, `x-authorization`). */
function isAuthorizationKey(key: string | null): boolean {
  return key !== null && key.toLowerCase().includes("authorization");
}

function isKeyChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 46 || code === 45;
}

const isBlank = (char: string | undefined): boolean => char === " " || char === "\t";
const isWhitespace = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char);
/** HTTP auth schemes: a bare value that starts with one goes on through the credentials after it (`Basic dXNl…`). */
const AUTH_SCHEMES: ReadonlySet<string> = new Set(["basic", "bearer", "digest", "negotiate", "token"]);
/** A redaction marker, matched where a value starts. */
const REDACTION_MARKER = /\[REDACTED:[A-Z_]+\]/y;
/** JSON's whitespace, which may stand around the separator after a quoted key. */
const isJsonWhitespace = (char: string | undefined): boolean => char === " " || char === "\t" || char === "\r" || char === "\n";

/** The closing quote of the quoted string opening at `start`, escapes skipped, on the same line and before `limit`; -1 when there is none. */
function closingQuoteOnLine(text: string, start: number, limit: number): number {
  const quote = text[start];
  for (let i = start + 1; i < limit && text[i] !== "\n"; i++) {
    // An escape never carries the string past its line's end.
    if (text[i] === "\\" && text[i + 1] !== "\n") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/**
 * A `\"`-delimited string, JSON text carried inside a JSON string (an error
 * that was stringified, an HTTP body), opening at `start` (its `\`). It is
 * read one level unescaped (`\\` is `\`, `\"` is `"`) and closes at a `"` so
 * read that its own escape does not escape.
 */
function escapedStringScan(text: string, start: number, limit: number): { close: number; scanned: number } {
  let escape = false;
  let i = start + 2;
  while (i < limit && text[i] !== "\n") {
    const at = i;
    // A bare `"` ends the JSON string that carries this one, so this one never closes.
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

/**
 * `text` with the value of every credential assignment redacted, in one pass
 * left to right. Internal contract violations throw; {@link scrubDiagnosticSecrets}
 * turns a throw into a fully redacted diagnostic. A key is the token just
 * before a `=` or `:`:
 *   - a quoted string (`"…"`, `'…'`, or `\"…\"`, which inside another key
 *     ends at that key's closing quote),
 *     recognized as it opens, JSON whitespace allowed before the separator:
 *     the separator takes it whole, so a `:` or `=` inside it is never its
 *     separator, while an assignment inside it is redacted too, its value
 *     ending at the key's closing quote. Its closing quote never opens
 *     another string. It is decoded, and an escape that does not decode
 *     makes it a credential's (failing closed). A quoted string that no
 *     separator follows is read on as ordinary text;
 *   - a run of `[A-Za-z0-9_.-]`, blanks (and one stray quote, `token":`)
 *     allowed before the separator, read back no further than the previous
 *     separator, value or line.
 * Each string is scanned once, so the whole pass is linear. A credential
 * key's value is redacted whole:
 *   - quoted (`"…"`, `'…'`, `\"…\"`): up to its closing quote on the same
 *     line; one that crosses a line unclosed runs to the end of the text (or
 *     of the key it stands in);
 *   - bare: up to the next whitespace, punctuation included, and through
 *     the next word too when it starts with an HTTP auth scheme
 *     (`Basic dXNl…`), or through the line's end when an Authorization key
 *     holds it (a header's value is its line: Digest's `response=…`); or to
 *     the line's end when the key opens a line with `=` (the git credential
 *     protocol's `password=…`);
 *   - one that starts on a later line than its separator takes that whole
 *     line at least.
 * `--<credential key> value` is redacted the same way (`--password=…` is an
 * assignment already). `-p value` is not: a short flag says nothing of what
 * it takes.
 */
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
  /**
   * Quoted keys whose separator lies ahead, innermost last, each strictly
   * inside the one below it. The scan reads on inside each (an assignment
   * inside a key is redacted too), and its separator takes the whole key.
   */
  const pending: Array<{ close: number; separator: number; keyStart: number; key: string | null }> = [];
  /** Where anything read at `at` must end: the closing quote of the key it stands in, so the key's separator always survives. */
  const limitAt = (at: number): number => {
    const key = pending[pending.length - 1];
    return key !== undefined && at < key.close ? key.close : text.length;
  };
  /** `authorization` keys a header (`Authorization`, `Proxy-Authorization`), whose value is the rest of its line. */
  const valueEnd = (start: number, toLineEnd: boolean, limit: number, header = false): number => {
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
    if (toLineEnd) while (end < limit && text[end] !== "\n" && text[end] !== "\r") end++;
    else while (end < limit && !isWhitespace(text[end])) end++;
    if (!toLineEnd && AUTH_SCHEMES.has(text.slice(start, end).toLowerCase())) {
      // A header's scheme takes the whole line, every parameter included (Digest's `response=…`).
      if (header) {
        while (end < limit && text[end] !== "\n" && text[end] !== "\r") end++;
        return end;
      }
      let word = end;
      while (word < limit && isBlank(text[word])) word++;
      let wordEnd = word;
      while (wordEnd < limit && !isWhitespace(text[wordEnd])) wordEnd++;
      if (wordEnd > word) end = wordEnd;
    }
    return end;
  };
  /**
   * The separator at `separator` closes `key` (null: undecodable), which opens
   * at `keyStart`; where the scan goes on from. After a quoted key the value
   * may stand past JSON whitespace, newlines included; after a bare one only
   * past blanks, so a bare `token:` ending a line never takes the next.
   */
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
      REDACTION_MARKER.lastIndex = start;
      // A value that is a marker alone was redacted already; one that goes on past a marker is not.
      if (REDACTION_MARKER.test(text) && (REDACTION_MARKER.lastIndex >= limit || isWhitespace(text[REDACTION_MARKER.lastIndex]))) return resumeAt;
      let stop = valueEnd(start, first && text[at] === "=" && keyStart === lineFirst, limit, first && isAuthorizationKey(key));
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
      // Inside a scanned string no `\"` opens another; its closing `\"` may, as a plain closing quote may,
      // so a stray `\"` earlier on the line never hides the key after it.
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
        const stop = start < limit && text[start] !== "-" && !isWhitespace(text[start]) ? valueEnd(start, false, limit, isAuthorizationKey(text.slice(keyStart, end))) : start;
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

/** Every userinfo and assignment shape {@link scrubDiagnosticSecrets} redacts; throws on an internal contract violation. */
export function scrubDiagnosticSecretsStrict(text: string): string {
  return scrubCredentialShapes(redactCredentialAssignments(
    text
      // A scheme starts after a character no scheme holds, so `a.a.a…` is read once, not from every `a`.
      .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*)(:\/\/)([^\s/?#]*)@/gi, (match: string, scheme: string, slashes: string, userinfo: string): string =>
        userinfoHidesCredential(userinfo, scheme) ? `${scheme}${slashes}[REDACTED:CREDENTIALS]@` : match,
      )
      .replace(/(^|[\s'"(<=,;])([^\s'"()<>/?#=,;]+)@(?=[A-Za-z0-9[])/gm, (match: string, before: string, userinfo: string): string =>
        userinfoHidesCredential(userinfo, undefined) ? `${before}[REDACTED:CREDENTIALS]@` : match,
      ),
  ), "precise");
}

/**
 * A diagnostic about a remote or a download, scrubbed before it is shown,
 * copied, sent to the renderer or stored: {@link scrubSecretsForLLM}, plus
 * the credential shapes such text carries and that scrubber leaves alone
 * because chat text is full of URLs:
 *   - the userinfo of an address, with a scheme (up to the authority's last
 *     `@`) or in scp form (`user@host:path`), unless it is an ssh account
 *     name (`userinfoHidesCredential`);
 *   - the value of a credential assignment (`token=…`, JSON's `"api_key": "…"`,
 *     `password=…` lines of the git credential protocol, `--password …`),
 *     read by {@link redactCredentialAssignments} in linear time.
 * It fails closed and never throws: every caller (an IPC answer, a stored
 * sync state, a render) must still say what happened. When the scrubber
 * breaks its own contract the whole text becomes `[REDACTED:DIAGNOSTIC]`,
 * and only the error and the text's length are logged, never the text.
 */
export function scrubDiagnosticSecrets(text: string): string {
  try {
    return scrubDiagnosticSecretsStrict(text);
  } catch (error) {
    console.warn(`[dlp] diagnostic scrubber failed closed (${typeof text === "string" ? `${text.length} chars` : typeof text}): ${errorMessage(error)}`);
    return "[REDACTED:DIAGNOSTIC]";
  }
}

/** Whether a scrubber pass replaced part of `text` with a `[REDACTED:…]` marker. */
export function hasRedaction(text: string): boolean {
  return /\[REDACTED:[A-Z]+\]/u.test(text);
}

/**
 * Whether `text` holds a key's random run: one segment between `-`/`_` of at
 * least 12 characters mixing letters and digits. A name's segments are words
 * (`captions`, `server01`); a key's are not.
 */
function hasKeyRun(text: string): boolean {
  return text.split(/[-_]/u).some((segment) => segment.length >= 12 && /[A-Za-z]/u.test(segment) && /\d/u.test(segment));
}

/** Whether `text` holds a run of 8 or more digits, as a Slack token's workspace and user ids. */
function hasDigitRun(text: string): boolean {
  return /\d{8,}/u.test(text);
}

/**
 * Slice-free credential scrubber shared by diagnostics bundles, log-tail IPC,
 * audit/display masking, and MCP error surfacing.
 *
 * This covers credential-shaped spans that the PII patterns below intentionally
 * do not model: bearer tokens, API-key fields, JWTs, vendor-prefixed tokens,
 * and context-labeled cloud secrets. It stays prefix/context driven rather than
 * redacting every high-entropy blob, because diagnostics often contain commit
 * SHAs and artifact hashes.
 *
 * Text bound for a model keeps the broad prefix rules: there a name masked by
 * mistake costs nothing, and a key missed costs a leak.
 */
export function scrubSecretsForLLM(text: string): string {
  return scrubCredentialShapes(text, "broad");
}

/**
 * The credential shapes of {@link scrubSecretsForLLM}. `precise` (the
 * diagnostic scrubber's mode, for text shown to a person: paths, hosts, ids
 * and package names in the marketplace) counts a vendor prefix only with the
 * token's own random run after it, so real names pass unchanged; `broad`
 * counts the prefix alone.
 */
function scrubCredentialShapes(text: string, mode: "broad" | "precise"): string {
  const tokenUnless = (keep: (match: string) => boolean) => (match: string): string => (mode === "precise" && keep(match) ? match : "[REDACTED:TOKEN]");
  return text
    .replace(
      /(authorization\s*:\s*)digest\s+[A-Za-z][A-Za-z0-9_-]*=(?:\\"[^"]*\\"|"[^"]*"|[^,\s"]+)(?:,\s*[A-Za-z][A-Za-z0-9_-]*=(?:\\"[^"]*\\"|"[^"]*"|[^,\s"]+))*/gi,
      "$1[REDACTED:TOKEN]",
    )
    .replace(
      /(authorization\s*:\s*)(?:basic|bearer|digest|negotiate|token)\s+[A-Za-z0-9._\-~+/=]+/gi,
      "$1[REDACTED:TOKEN]",
    )
    .replace(
      /(authorization\s*:\s*)(?!(?:basic|bearer|digest|negotiate|token)\s)[A-Za-z0-9._\-~+/=]+/gi,
      "$1[REDACTED:TOKEN]",
    )
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
      /(["'](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|authorization|x-api-key|x-auth-token|aws[_-]?secret[_-]?access[_-]?key)["']\s*:\s*["'])[^"']+(["'])/gi,
      "$1[REDACTED:TOKEN]$2",
    )
    // JSON Web Tokens: three base64url segments separated by dots (header.payload.sig).
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED:JWT]")
    // AWS access-key + adjacent 40-char secret pair. Do this before the
    // standalone AKIA pass so the paired secret does not remain visible.
    .replace(
      /\bAKIA[0-9A-Z]{16}([\s:=,]+)[A-Za-z0-9/+=]{40}(?=$|[^A-Za-z0-9/+=])/gi,
      "[REDACTED:TOKEN]$1[REDACTED:TOKEN]",
    )
    .replace(/\b(AWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(["']?)/gi, "$1[REDACTED:TOKEN]$2")
    // Vendor-prefixed tokens observed in diagnostics probes (#1511).
    .replace(/\bgh[opsru]_[A-Za-z0-9_]{20,}\b/gi, "[REDACTED:TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi, "[REDACTED:TOKEN]")
    // A prefix alone also starts ordinary names (`xapp-launcher`, `aizawa-…`, `test-server01`,
    // `live-captions`, `sk-learn-utils`): precisely, each of these needs the token's own random run too.
    // Slack tokens carry numeric workspace and user ids.
    .replace(/\bxox[bp]-[A-Za-z0-9-]{10,}\b/gi, tokenUnless((match) => !hasDigitRun(match)))
    .replace(/\bxapp-[A-Za-z0-9-]{10,}\b/gi, tokenUnless((match) => !hasDigitRun(match)))
    // AWS key ids are base32: a run of 16 with no digit is a word.
    .replace(/\bAKIA[0-9A-Z]{16}\b/gi, tokenUnless((match) => !/\d/u.test(match.slice(4))))
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gi, tokenUnless((match) => !hasKeyRun(match.slice(4))))
    // Prefixed API keys: sk-/pk-/rk-/proj-/test-/live- followed by >=8 key chars (precisely: a random run among them).
    .replace(/\b(?:sk|pk|rk|proj|test|live)-[A-Za-z0-9_-]{8,}\b/gi, tokenUnless((match) => !hasKeyRun(match.slice(match.indexOf("-") + 1))));
}

/**
 * Luhn checksum gate for credit-card candidates. This is part of DETECTION, not
 * replacement: a digit run that fails Luhn is not treated as a card by either
 * consumer, so a 16-digit order or ticket number is left intact rather than
 * masked. Lives here in the leaf module so the display masker and the
 * LLM-egress redactor apply the identical card test rather than diverging.
 */
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

type PiiKind = "SSN_KR" | "EMAIL" | "PHONE_KR" | "PHONE_US" | "CREDIT_CARD";

/**
 * One shared PII detector. DETECTION (the pattern plus an optional validity
 * gate) is the single converged set that both entry points consume; REPLACEMENT
 * is deliberately per-consumer: {@link PiiPattern.maskShape} preserves the
 * display silhouette (prefix, length, separators) for audit/display surfaces,
 * while {@link PiiPattern.redactToken} fully removes the span for text bound to
 * a model. Neither consumer re-implements detection.
 */
export interface PiiPattern {
  kind: PiiKind;
  /** i18n key for the human-facing detection label used by {@link maskSensitiveData}. */
  nameKey: string;
  /** Shared, global detection pattern. */
  pattern: RegExp;
  /**
   * Extra detection gate (Luhn for cards). A span the gate rejects is left
   * intact by BOTH consumers — it is decided not to be PII, not merely styled
   * differently.
   */
  valid?: (match: string) => boolean;
  /** Display-shape-preserving replacement (audit / display / agent-egress masking). */
  maskShape: (match: string, ...groups: string[]) => string;
  /** Full-redaction token (text handed to a model). */
  redactToken: string;
}

/**
 * The single converged detection set — the union of what each former copy
 * caught correctly, not a whole-file pick:
 *  - IDs are anchored on word boundaries, so a six-then-seven digit run sitting
 *    inside a longer digit string is not misread as a resident-registration
 *    number;
 *  - both the dashed and the dashless mobile form are matched, across the wider
 *    carrier-prefix range, plus the US phone shape;
 *  - card candidates span the wider digit-length range and are gated by Luhn, so
 *    a non-card digit run of card length is left intact.
 *
 * Order is significant and identical for both consumers: an address-shaped span
 * is claimed as an email before the phone or card patterns can see its digits,
 * and an ID is claimed before the card candidate can absorb its digits.
 */
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
    kind: "PHONE_KR",
    nameKey: "be_dlp.patternPhoneNumber",
    pattern: /01[016789]-?\d{3,4}-?\d{4}/g,
    // Keep the carrier prefix visible, mask every remaining digit, and keep any
    // separators so the silhouette (e.g. 010-****-****, or a dashless run) survives.
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
    // Reveal the last four digits, mask the rest, and keep the original
    // separators so a 15- or 16-digit card keeps its grouping.
    maskShape: (m) => {
      const total = (m.match(/\d/g) ?? []).length;
      let seen = 0;
      return m.replace(/\d/g, (d) => (++seen > total - 4 ? d : "*"));
    },
    redactToken: "[REDACTED:CC]",
  },
];

/**
 * 텍스트에서 민감 데이터 패턴을 검사하고 마스킹한다. Detection is the shared
 * {@link PII_PATTERNS} set; this entry point applies the display-shape-preserving
 * replacement. The credential scrubber runs first, then each PII pattern in the
 * shared order.
 *
 * With `pii: false` only the credential scrubber runs: the returned text keeps
 * every email, phone number, ID and card intact, and `detections` names at most
 * the credential class. A surface governed by the privacy toggle therefore
 * produces no PII detection — and so no warning and no audit note — when the
 * user has the toggle off.
 *
 * @param text 검사할 원본 텍스트
 * @returns masked: 마스킹된 텍스트, detections: 탐지된 패턴명 목록
 */
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
      // In a replace callback the capture groups precede the numeric offset;
      // slice them off so maskShape receives only the string groups it declares.
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
