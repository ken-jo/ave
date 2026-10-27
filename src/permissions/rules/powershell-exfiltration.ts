// Shell floors use a bounded dialect-aware lexer because permission decisions are synchronous. Track file/secret data through assignments, pipelines, uploads, UNC writes and child/script dispatch; scan nested effects and canonical sensitive paths even after parse refusal.
// Unknown values stay opaque; unreadable transport bindings and retained sink/credential evidence require per-call consent, while unresolved non-transports ask ordinarily. Plain GETs, literal headers and local operations are not exfiltration; rules from another shell dialect never satisfy these asks.
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { expandLeadingTilde } from "../../shared/home-tilde.js";
import { SENSITIVE_PATH_ENTRIES } from "../sensitive-paths.js";
import {
  canonicalPowerShellName,
  POWERSHELL_ANALYSIS_LIMITS,
  POWERSHELL_COMMAND_POLICIES,
  PowerShellAnalysisBudget,
  PowerShellBudgetError,
  powerShellCommandsWithEffect,
  powerShellCommandSpellings,
  type PowerShellExpressionKind,
  type PowerShellPathBinding,
} from "./powershell-command-policy.js";
import { PowerShellFileProvenance } from "./powershell-file-provenance.js";
import { INTERPRETER_SET, RUNNER_SET, SHELL_SET, WRAPPER_SET, programName, runnerName } from "./shell-prefix-values.js";
import { hiddenCodeReason, isNetworkProgram, opaqueRunnerReason, runnerCodeContext, runnerCommandIndexes, wrapperCommand, type ShellCommandInput } from "./shell-prefix-policy.js";
import {
  MULTI_PURPOSE_NETWORK,
  sensitivePathInArgumentText,
  shellExfiltrationSignal,
  shellSensitivePathSignal,
} from "./shell-exfiltration.js";

// Lexer

interface PsWord {
  kind: "word";
  // Source text of the token.
  raw: string;
  // Dequoted text (quotes and backtick escapes removed).
  text: string;
  quoted: boolean;
  // `$(…)` bodies inside the word or an expandable string.
  nested: PsPipeline[][];
  reason?: string;
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
  // Lower-cased variable names this pipeline's output is assigned to.
  assign: string[];
  compound: boolean;
  // Original assignment targets and member accesses, before stripping assignments.
  references: string;
  // Hashtable entry key (`@{ InFile = 'x' }`), when this is one.
  key?: string;
  container?: PsGroup["open"];
}

class PsUnreadable extends Error {}

const GROUP_CLOSER: Record<PsGroup["open"], ")" | "}"> = { "(": ")", "$(": ")", "@(": ")", "{": "}", "@{": "}" };
const WORD_END = /[\s;|&(){},'"]/;
const MAX_DEPTH = 32;

// The tokenizer's complete IsDash set, including parameter and operator spellings.
function normalizeDashes(text: string): string {
  return text.replace(/[\u2013-\u2015]/g, "-");
}

const CONTROL_ESCAPES: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t" };

class Lexer {
  private index = 0;
  private depth = 0;
  // Complete command tokens remain usable for positive effects after refusal.
  readonly readable: PsCommand[] = [];
  constructor(private readonly source: string, private readonly budget: PowerShellAnalysisBudget) {}

  parseProgram(): PsPipeline[] {
    // Alternate quote delimiters are outside this lexer's supported grammar.
    if (/[\u2018-\u201e]/.test(this.source)) throw new PsUnreadable("unsupported quote delimiter");
    const body = this.parseBody(undefined);
    if (body.some((pipeline) => pipeline.key !== undefined)) throw new PsUnreadable("unsupported assignment target");
    if (this.index < this.source.length) throw new PsUnreadable("unbalanced group");
    return body;
  }

  // Statements up to `closer` (consumed) or the end of input.
  private parseBody(closer: ")" | "}" | undefined): PsPipeline[] {
    if (++this.depth > MAX_DEPTH) throw new PsUnreadable("nesting too deep");
    const pipelines: PsPipeline[] = [];
    let stages: PsCommand[] = [];
    let tokens: PsToken[] = [];
    const endCommand = (): void => {
      if (tokens.length > 0) { stages.push({ tokens }); this.readable.push({ tokens }); }
      tokens = [];
    };
    const endPipeline = (): void => {
      endCommand();
      if (stages.length > 0) pipelines.push(toPipeline(stages, this.budget));
      stages = [];
    };
    const src = this.source;
    while (this.index < src.length) {
      this.budget.spend();
      const char = src[this.index]!;
      const next = src[this.index + 1];
      if (char === " " || char === "\t") { this.index += 1; continue; }
      if (char === ",") { tokens.push(word(",", ",", false, [])); this.index += 1; continue; }
      if (char === "`" && (next === "\n" || next === "\r")) { this.index += next === "\r" && src[this.index + 2] === "\n" ? 3 : 2; continue; }
      if (char === "\n" || char === "\r" || char === ";") { endPipeline(); this.index += 1; continue; }
      if (char === "<" && next === "#") {
        const end = src.indexOf("#>", this.index + 2);
        if (end === -1) throw new PsUnreadable("unterminated comment");
        this.index = end + 2;
        continue;
      }
      if (char === "#") {
        while (this.index < src.length && src[this.index] !== "\n") { this.budget.spend(); this.index += 1; }
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
        if (tokens.length > 0) {
          const pending = toPipeline([{ tokens }], this.budget);
          if (stages.length !== 0 || pending.assign.length === 0 || pending.stages.length !== 0 || pending.compound || pending.key !== undefined) {
            endCommand();
            throw new PsUnreadable("unsupported background execution");
          }
        }
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
      if (char === "'" || char === "\"") {
        // Argument-mode quote concatenation must not split one runtime path or command name into independently bound operands.
        const previous = src[this.index - 1];
        if (previous && !/[\s;|&(){},:=+<>]/.test(previous)) throw new PsUnreadable("unsupported adjacent string fragment");
        const token = char === "'" ? this.parseSingleQuoted() : this.parseDoubleQuoted();
        const following = src[this.index];
        if (following && !/[\s;|&(){},=+\-<>]/.test(following)) throw new PsUnreadable("unsupported adjacent string fragment");
        tokens.push(token);
        continue;
      }
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
    const body = this.parseBody(GROUP_CLOSER[open]).map((pipeline) => ({ ...pipeline, container: open }));
    if (open !== "@{" && body.some((pipeline) => pipeline.key !== undefined)) throw new PsUnreadable("unsupported assignment target");
    return { kind: "group", raw: this.source.slice(start, this.index), open, body };
  }

  private parseSingleQuoted(): PsWord {
    const start = this.index;
    let text = "";
    this.index += 1;
    for (;;) {
      this.budget.spend();
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
      this.budget.spend();
      if (this.index >= this.source.length) throw new PsUnreadable("unterminated string");
      const char = this.source[this.index]!;
      if (char === "`") { text += this.readEscape(); continue; }
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
    const contentStart = this.source.indexOf("\n", this.index + 2) + 1;
    let text = this.source.slice(contentStart, end.index);
    this.index = end.index + end[0].length;
    const nested: PsPipeline[][] = [];
    let reason: string | undefined;
    if (quote === "\"") {
      for (const body of subexpressionBodies(text, this.budget)) nested.push(new Lexer(body, this.budget).parseProgram());
      text = text.replace(/`(.)/gs, (raw, char: string) => {
        this.budget.spend();
        if (/[0abefuv$]/.test(char)) { reason = "unsupported here-string escape"; return raw; }
        return CONTROL_ESCAPES[char] ?? char;
      });
    }
    return { ...word(this.source.slice(start, this.index), text, true, nested), reason };
  }

  private parseBareword(): PsWord {
    const start = this.index;
    let text = "";
    const nested: PsPipeline[][] = [];
    const src = this.source;
    // `--%` stops parsing: the rest of the line is passed verbatim.
    if (normalizeDashes(src.slice(this.index, this.index + 3)) === "--%") {
      let end = this.index;
      while (end < src.length && src[end] !== "\n") { this.budget.spend(); end += 1; }
      const raw = src.slice(this.index, end);
      this.index = end;
      return word(raw, raw, false, []);
    }
    while (this.index < src.length) {
      this.budget.spend();
      const char = src[this.index]!;
      if (char === "`") { text += this.readEscape(); continue; }
      if (char === "<" || char === ">") throw new PsUnreadable("unsupported redirection");
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
      if (char === "@" && (src[this.index + 1] === "{" || src[this.index + 1] === "(")) break;
      text += char;
      this.index += 1;
    }
    if (this.index === start) {
      throw new PsUnreadable("unsupported token");
    }
    return word(src.slice(start, this.index), normalizeDashes(text), false, nested);
  }

  private readEscape(): string {
    const next = this.source[this.index + 1];
    if (next === undefined || /[0abefuv]/.test(next)) throw new PsUnreadable("unsupported escape");
    this.index += 2;
    if (next === "\r" && this.source[this.index] === "\n") this.index += 1;
    return next === "\r" || next === "\n" ? "" : CONTROL_ESCAPES[next] ?? next;
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

// `$(…)` bodies of expandable text (here-strings).
function subexpressionBodies(text: string, budget: PowerShellAnalysisBudget): string[] {
  const bodies: string[] = [];
  for (let index = text.indexOf("$("); index !== -1; index = text.indexOf("$(", index + 2)) {
    let escaped = false;
    for (let prior = index - 1; prior >= 0 && text[prior] === "`"; prior -= 1) { budget.spend(); escaped = !escaped; }
    if (escaped) continue;
    let depth = 0;
    for (let end = index + 1; end < text.length; end += 1) {
      budget.spend();
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")" && --depth === 0) { bodies.push(text.slice(index + 2, end)); break; }
    }
    if (depth !== 0) throw new PsUnreadable("unterminated subexpression");
  }
  return bodies;
}

const VARIABLE = /^(?:\[[^\]]*\])*\$(?:\{([^}]+)\}|([\w:?]+))$/;

// `$k = …`, `[string]$k = …`, `$k=…`, `$a = $b = …`.
function toPipeline(stages: PsCommand[], budget: PowerShellAnalysisBudget): PsPipeline {
  budget.spend(stages.reduce((count, stage) => count + stage.tokens.length, 1));
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
    const cast = /^(?:\[[^\]]*\])+(?=\$)/.exec(head.text)?.[0];
    if (cast !== undefined && !/^\[(?:system\.)?string\]$/i.test(cast)) throw new PsUnreadable("unsupported variable conversion");
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

// Command facts

const HTTP_CMDLETS = new Set(["invoke-webrequest", "invoke-restmethod"]);
// Names that are also native programs (`curl.exe`, PowerShell 7's `curl`).
const NATIVE_ALIASED = new Set([...HTTP_CMDLETS].flatMap((name) => POWERSHELL_COMMAND_POLICIES[name]!.aliases)
  .filter((alias) => POWERSHELL_COMMAND_POLICIES[`${alias}.exe`]?.native));
const OTHER_NETWORK_CMDLETS = powerShellCommandsWithEffect("network");
const COPY_CMDLETS = new Set(["copy-item"]);
const FILE_READERS = new Set([
  ...powerShellCommandsWithEffect("read"), "cmdkey", "vaultcmd",
  "base64", "xxd", "od", "head", "tail", "tar", "openssl", "gpg",
]);
const ENV_LISTERS = new Set(["get-childitem", "get-item", "get-content"]);
const SET_VARIABLE = new Set(["set-variable", "new-variable"]);
const SCRIPT_BLOCK_RUNNERS = new Set(["foreach-object", "where-object"]);

function isReaderCommand(name: string): boolean {
  return FILE_READERS.has(name) || FILE_READERS.has(name.replace(/\.exe$/, ""));
}
// `.NET` reads of file or secret data, matched against the whole token text.
const DOTNET_READER = /\[(?:system\.)?io\.file\]::(?:read|open)|\.readallbytes|\.readalltext|\.readtoend|\[(?:system\.)?environment\]::getenvironmentvariables|passwordvault|getnetworkcredential|convertfrom-securestring/i;
// `.NET` upload methods; `uploadfile` sends a named file whatever its arguments.
const DOTNET_UPLOAD_FILE = /\.uploadfile(?:async|taskasync)?$/i;
const DOTNET_UPLOAD_DATA = /\.(?:upload(?:string|data|values)(?:async|taskasync)?|(?:post|put|patch|send)async)$/i;
const DOTNET_SEND = /\.(?:send|write|beginsend|sendto)$/i;
const DOTNET_NETWORK = /\b(?:(?:system\.)?net\.(?:webclient|http\.httpclient|webrequest|httpwebrequest|sockets\.\w+|mail\.smtpclient)|webclient|httpclient|tcpclient|udpclient|smtpclient|networkstream|clientwebsocket)\b/i;

// Regex-only diagnostics use the same command vocabulary as semantic analysis.
function commandNames(names: readonly string[]): string {
  return names.flatMap(powerShellCommandSpellings)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

// Code the floor cannot read statically.
const HIDDEN_CODE = new RegExp(String.raw`\b(?:${commandNames(["invoke-expression", "invoke-command", "add-type", "start-job"])}|frombase64string)\b|\[scriptblock\]::create|\$executioncontext\.invokecommand|(?:^|\s)-(?:enc|encodedcommand|e|ec)\s|&\s*[$(]|(?:^|[\s;])\.\s+\$|\.invoke\s*\(`, "i");
const UNREADABLE_FALLBACK = new RegExp(String.raw`\b(?:${commandNames([...HTTP_CMDLETS])})\b[^\n]*\s-inf|\b(?:${commandNames(["start-bitstransfer"])})\b[^\n]*-t\w*[\s:]+["']?upload|\b(?:${commandNames(["send-mailmessage"])})\b[^\n]*-at|\.uploadfile\s*\(`, "i");
const UNREADABLE_TRANSPORT_SPLAT = new RegExp(String.raw`(?:^|[;|&\n])\s*(?:${commandNames([...powerShellCommandsWithEffect("network")])})(?:\s+[^;|\n]*)?\s+@\w+\b`, "i");
const ARGUMENT_CODE_HINT = new RegExp(String.raw`(?:^|[\s;&|])(?:${commandNames([...powerShellCommandsWithEffect("network"), ...powerShellCommandsWithEffect("launcher"), "get-content"])}|pwsh|powershell)(?:\s|$)`, "i");

function canonicalName(text: string): string {
  return canonicalPowerShellName(text);
}

// Command name: the first token, or the one after a `&` / `.` call operator.
function headOf(cmd: PsCommand, ctx?: Context): { name: string | undefined; args: PsToken[]; label?: string } {
  ctx?.budget.spend();
  let index = 0;
  const first = cmd.tokens[0];
  if (first?.kind === "word" && !first.quoted && (first.text === "&" || first.text === ".")) index = 1;
  const head = cmd.tokens[index];
  if (index === 0 && head?.kind === "word" && head.quoted) return { name: undefined, args: cmd.tokens };
  if (index === 1 && head && ctx) {
    const value = evaluateValue([head], ctx);
    if (value.state === "known" && value.shape === "scalar") return { name: canonicalName(value.text), args: cmd.tokens.slice(index + 1), label: value.text };
  }
  if (head?.kind !== "word") return { name: undefined, args: cmd.tokens.slice(index) };
  return { name: canonicalName(head.text), args: cmd.tokens.slice(index + 1), label: (head.text.split(/[\\/]/).pop() ?? head.text).toLowerCase() };
}

// `-Name` / `-Name:` matches a parameter when it is a non-empty prefix of its full name (PowerShell resolves unambiguous prefixes; an ambiguous one is an error; the complete binder rejects ambiguity).
function parameterIs(token: PsToken | undefined, parameter: string): boolean {
  if (token?.kind !== "word" || token.quoted) return false;
  const match = /^-([A-Za-z][\w-]*):?/.exec(normalizeDashes(token.text));
  return match !== null && parameter.startsWith(match[1]!.toLowerCase());
}

function parameterIndex(args: readonly PsToken[], parameter: string): number {
  const binding = parameterBinding(args, parameter);
  return binding.state === "absent" ? -1 : binding.index;
}

type ParameterBinding = { state: "absent" } | { state: "opaque"; index: number }
  | { state: "bound"; index: number; value: PsToken; rest: PsToken[]; next: number };

// The only decoder for separated and colon-attached parameter values.
function parameterBinding(args: readonly PsToken[], parameter: string): ParameterBinding {
  const index = args.findIndex((token) => parameterIs(token, parameter));
  if (index === -1) return { state: "absent" };
  return argumentBinding(args, index);
}

function argumentBinding(args: readonly PsToken[], index: number): Exclude<ParameterBinding, { state: "absent" }> {
  const token = args[index] as PsWord;
  const inline = token.text.indexOf(":");
  if (inline !== -1 && inline < token.text.length - 1) {
    const rawColon = token.raw.indexOf(":");
    const raw = token.raw.slice(rawColon + 1);
    const value = word(raw, token.text.slice(inline + 1), raw.startsWith("'") || raw.startsWith('"'), token.nested);
    return { state: "bound", index, value, rest: [value, ...args.slice(index + 1)], next: index + 1 };
  }
  const value = args[index + 1];
  if (value === undefined || (value.kind === "word" && !value.quoted && /^-[a-z]/i.test(normalizeDashes(value.text)))) return { state: "opaque", index };
  return { state: "bound", index, value, rest: args.slice(index + 1), next: index + 2 };
}

// Absence is distinct from an unreadable binding.
function parameterValue(args: readonly PsToken[], parameter: string): string | undefined {
  const binding = parameterBinding(args, parameter);
  if (binding.state === "absent") return undefined;
  if (binding.state === "opaque") return DYNAMIC;
  const value = binding.value;
  if (value.kind === "word") return value.text;
  const only = value.body.length === 1 && value.body[0]!.stages.length === 1 ? value.body[0]!.stages[0]!.tokens : [];
  return only.length === 1 && only[0]!.kind === "word" ? only[0]!.text : DYNAMIC;
}

const COMMON_PARAMETERS = ["verbose?", "debug?", "erroraction|ea", "warningaction|wa", "informationaction|infa", "outvariable|ov", "errorvariable|ev", "warningvariable|wv", "informationvariable|iv", "outbuffer|ob", "pipelinevariable|pv", "whatif?", "confirm?"];
const SHELL_PARAMETERS = ["command|c*", "encodedcommand|e|ec|enc", "noprofile?", "noninteractive?", "nologo?", "noexit?", "executionpolicy|ep", "inputformat", "outputformat", "file", "windowstyle", "workingdirectory", "sta?", "mta?"];

interface BoundArguments {
  state: "known" | "opaque";
  named: Map<string, PsToken[]>;
  positional: PsToken[];
}

// Whole argument binding is closed: unknown, ambiguous, duplicate or missing options are opaque.
function bindArguments(args: readonly PsToken[], parameters: readonly string[], ctx: Context): BoundArguments {
  ctx.budget.spend(args.length + 1);
  const named = new Map<string, PsToken[]>();
  const positional: PsToken[] = [];
  const specs = [...parameters, ...COMMON_PARAMETERS].map((parameter) => ({
    names: parameter.replace(/[?*]$/, "").split("|"), switch: parameter.endsWith("?"), rest: parameter.endsWith("*"),
  }));
  const opaque = (): BoundArguments => ({ state: "opaque", named, positional });
  for (let index = 0; index < args.length;) {
    ctx.budget.spend();
    const token = args[index]!;
    if (token.kind !== "word" || token.quoted || !token.text.startsWith("-")) { positional.push(token); index += 1; continue; }
    const match = /^-([a-z][\w-]*)(?::.*)?$/is.exec(normalizeDashes(token.text));
    if (!match) return opaque();
    const name = match[1]!.toLowerCase();
    const exact = specs.filter((spec) => spec.names.includes(name));
    const matching = exact.length ? exact : specs.filter((spec) => spec.names[0]!.startsWith(name));
    if (matching.length !== 1) return opaque();
    const spec = matching[0]!;
    const canonical = spec.names[0]!;
    if (named.has(canonical)) return opaque();
    if (spec.switch && !token.text.includes(":")) { named.set(canonical, []); index += 1; continue; }
    const binding = argumentBinding(args, index);
    if (binding.state === "opaque") return opaque();
    if (spec.rest) {
      if (canonical === "command" && parameters === SHELL_PARAMETERS) {
        named.set(canonical, binding.rest);
        index = args.length;
        continue;
      }
      const values = [binding.value];
      index = binding.next;
      while (index < args.length) {
        ctx.budget.spend();
        const next = args[index]!;
        if (next.kind === "word" && !next.quoted && next.text.startsWith("-")) break;
        values.push(next);
        index += 1;
      }
      named.set(canonical, values);
    } else { named.set(canonical, [binding.value]); index = binding.next; }
  }
  return { state: "known", named, positional };
}

interface Context {
  cwd: string | undefined;
  // Lower-cased variables holding file or secret data.
  tainted: Set<string>;
  // Lower-cased variables assigned a hashtable literal, as `-Key (value)` arguments.
  splats: Map<string, PsToken[]>;
  values: Map<string, PsValue>;
  vocabularyOpaque: boolean;
  scopeOpaque: boolean;
  launched: boolean;
  literalBoundary: boolean;
  files: PowerShellFileProvenance;
  pathData: Set<string>;
  // Positively modeled property expressions inside a dispatch block.
  memberReads: Set<PsCommand>;
  ordinary: { reason?: string };
  budget: PowerShellAnalysisBudget;
}

interface PsValue {
  state: "known" | "opaque";
  text: string;
  computed: boolean;
  shape: "scalar" | "hashtable";
  reason?: string;
}

function valueOf(text: string, computed: boolean, ctx: Context): PsValue {
  ctx.budget.spend(1, text.length);
  return { state: text.includes(DYNAMIC) ? "opaque" : "known", text, computed, shape: "scalar" };
}

function opaqueValue(text = DYNAMIC, reason?: string): PsValue { return { state: "opaque", text, computed: true, shape: "scalar", reason }; }

type ProviderPath = { state: "opaque" } | { state: "known"; provider: "filesystem" | "variable" | "environment" | "alias" | "function"; path: string };

// Provider identity is part of a path's meaning, including qualified spellings.
function providerPath(value: PsValue, ctx: Context): ProviderPath {
  ctx.budget.spend(1, value.text.length);
  if (value.state === "opaque" || value.shape !== "scalar") return { state: "opaque" };
  const qualified = /^(?:microsoft\.powershell\.core\\)?(filesystem|variable|environment|alias|function)::(.*)$/is.exec(value.text);
  if (qualified) return { state: "known", provider: qualified[1]!.toLowerCase() as Exclude<ProviderPath, { state: "opaque" }>["provider"], path: qualified[2]! };
  const drive = /^([a-z][\w-]*):(.*)$/is.exec(value.text);
  if (!drive || /^[a-z]:[\\/]/i.test(value.text)) return { state: "known", provider: "filesystem", path: value.text };
  const path = drive[2]!;
  switch (drive[1]!.toLowerCase()) {
    case "variable": case "alias": case "function": return { state: "known", provider: drive[1]!.toLowerCase() as "variable" | "alias" | "function", path };
    case "env": return { state: "known", provider: "environment", path };
    default: return { state: "opaque" };
  }
}

// Only literal data and the explicitly modeled string/path operations are evaluated.
function evaluateValue(tokens: readonly PsToken[], ctx: Context, header = false): PsValue {
  return ctx.budget.expression(tokens.length, () => evaluateExpression(tokens, ctx, header));
}

function evaluateExpression(tokens: readonly PsToken[], ctx: Context, header: boolean): PsValue {
  if (tokens.length === 0) return opaqueValue();
  const unreadable = tokens.find((token) => token.kind === "word" && token.reason !== undefined);
  if (unreadable?.kind === "word") return opaqueValue(unreadable.text, unreadable.reason);
  // Token rewrites must never erase executable subexpressions.
  if (tokens.some((token) => token.kind === "word" && token.nested.length !== 0)) return opaqueValue();
  const first = tokens[0]!;
  if (tokens.length === 1 && first.kind === "word" && !first.quoted && first.text.startsWith("$") && first.text.includes("+")) {
    const parts = first.text.split(/(\+)/).filter(Boolean).map((text) => word(text, text, false, []));
    return evaluateValue(parts, ctx, header);
  }
  if (tokens.length === 1) {
    if (first.kind === "group") {
      if (first.open === "@{") {
        if (!ctx.budget.supports("hashtable")) return opaqueValue();
        const values: string[] = [];
        for (const entry of first.body) {
          ctx.budget.spend();
          if (entry.key === undefined || /[$`]/.test(entry.key) || entry.assign.length || entry.compound || entry.stages.length !== 1) return opaqueValue();
          const tokens = entry.stages[0]!.tokens;
          const head = tokens[0];
          if (head?.kind === "word" && !head.quoted && !/^[$\d]/.test(head.text) && canonicalName(head.text) !== "join-path") return opaqueValue();
          const value = evaluateValue(tokens, ctx, header);
          if (value.state === "opaque" || value.shape !== "scalar") return opaqueValue();
          values.push(value.text);
        }
        return { ...valueOf(values.join(" "), false, ctx), shape: "hashtable" };
      }
      if (!ctx.budget.supports("group") || first.open === "{" || first.body.length !== 1) return opaqueValue();
      const pipeline = first.body[0]!;
      if (pipeline.assign.length || pipeline.stages.length !== 1) return opaqueValue();
      const inner = pipeline.stages[0]!.tokens;
      if (inner.length === 1 && inner[0]?.kind === "word" && !inner[0].quoted && !inner[0].text.startsWith("$")) return opaqueValue();
      return evaluateValue(inner, ctx, header);
    }
    if (first.raw.startsWith("'") || first.raw.startsWith("@'")) return ctx.budget.supports("literal") ? valueOf(first.text, false, ctx) : opaqueValue();
    if (!first.quoted && (/^(?:\[|@|,|--%|[-+=&|])/.test(first.text)
      || /\$(?:\{[^}]+\}|[\w:]+)(?:[.\[\-*%]|::|\/\$)/.test(first.text))) return opaqueValue();
    if (!ctx.budget.supports("interpolation")) return opaqueValue();
    const variable = !first.quoted && VARIABLE.exec(first.text);
    const stored = variable ? ctx.values.get((variable[1] ?? variable[2]!).toLowerCase()) : undefined;
    if (stored) { ctx.budget.spend(1, stored.text.length); return stored; }
    let computed = false;
    const text = first.text.replace(/\$(?:\{([^}]+)\}|([\w:]+|[?$^]))/g, (_match, braced: string | undefined, plain: string | undefined) => {
      ctx.budget.spend();
      const name = (braced ?? plain!).toLowerCase();
      if (name === "true" || name === "false") return name;
      if (name === "null") return "";
      const known = ctx.values.get(name);
      if (known) {
        computed ||= known.computed;
        ctx.budget.spend(1, known.text.length);
        return known.shape === "hashtable" ? DYNAMIC : known.text;
      }
      if (name.startsWith("env:")) {
        const value = ctx.scopeOpaque ? DYNAMIC : envValue(name.slice(4));
        // Environment scalars are a modeled header source, never a known path or body.
        return value === DYNAMIC && header && !ctx.scopeOpaque ? "__ave_environment_scalar__" : value;
      }
      if (name === "home" && !ctx.scopeOpaque) return homedir();
      return DYNAMIC;
    });
    return valueOf(text, computed, ctx);
  }
  // A bare variable and its following '+' may share a lexer word.
  const parts = tokens.flatMap((token): PsToken[] => token.kind === "word" && !token.quoted && token.text.includes("+")
    ? token.text.split(/(\+)/).filter(Boolean).map((text) => word(text, text, false, [])) : [token]);
  const plus = parts.findIndex((token) => token.kind === "word" && !token.quoted && token.text === "+");
  if (plus !== -1) {
    if (!ctx.budget.supports("concatenation")) return opaqueValue();
    const left = evaluateValue(parts.slice(0, plus), ctx, header);
    const right = evaluateValue(parts.slice(plus + 1), ctx, header);
    return valueOf((left.shape === "scalar" ? left.text : DYNAMIC) + (right.shape === "scalar" ? right.text : DYNAMIC), true, ctx);
  }
  const format = tokens.findIndex((token) => token.kind === "word" && !token.quoted && normalizeDashes(token.text).toLowerCase() === "-f");
  if (format !== -1) {
    if (!ctx.budget.supports("format")) return opaqueValue();
    const template = evaluateValue(tokens.slice(0, format), ctx, header);
    const operands = tokens.slice(format + 1).filter((token) => !(token.kind === "word" && token.text === ","));
    const values = operands.map((token) => evaluateValue([token], ctx, header)).map((value) => value.shape === "scalar" ? value.text : DYNAMIC);
    return valueOf((template.shape === "scalar" ? template.text : DYNAMIC).replace(/\{\{|\}\}|\{(\d+)\}|[{}]/g, (match, index: string | undefined) => {
      const value = index !== undefined ? values[Number(index)] ?? DYNAMIC : match === "{{" ? "{" : match === "}}" ? "}" : DYNAMIC;
      ctx.budget.spend(1, value.length);
      return value;
    }), true, ctx);
  }
  if (first.kind === "word" && !first.quoted && canonicalName(first.text) === "join-path") {
    if (!ctx.budget.supports("join-path")) return opaqueValue();
    const bound = bindArguments(tokens.slice(1), POWERSHELL_COMMAND_POLICIES["join-path"]!.parameters, ctx);
    if (bound.state === "opaque" || bound.named.has("resolve")) return opaqueValue();
    const positional = [...bound.positional];
    const path = bound.named.get("path") ?? (positional[0] ? [positional.shift()!] : []);
    const child = bound.named.get("childpath") ?? (positional[0] ? [positional.shift()!] : []);
    const values = [evaluateValue(path, ctx, header), evaluateValue(child, ctx, header),
      ...(bound.named.get("additionalchildpath") ?? []).map((token) => evaluateValue([token], ctx, header)),
      ...positional.map((token) => evaluateValue([token], ctx, header))].map((value) => value.shape === "scalar" ? value.text : DYNAMIC);
    return valueOf(values.map((value, index) => index === 0 ? value.replace(/[\\/]+$/, "") : value.replace(/^[\\/]+/, "")).join("/"), true, ctx);
  }
  return opaqueValue();
}

function collectValues(pipelines: readonly PsPipeline[], ctx: Context): void {
  const assigned = new Set<string>();
  const forward = new Set<string>();
  for (const pipeline of allPipelines(pipelines, ctx.budget)) {
    const targets = new Set(pipeline.assign);
    for (const match of pipeline.references.matchAll(/\$(?:\{([^}]+)\}|([\w:]+))/g)) {
      const name = (match[1] ?? match[2]!).toLowerCase();
      if (targets.delete(name)) continue;
      if (!assigned.has(name)) forward.add(name);
    }
    if (pipeline.assign.length === 0) continue;
    const tokens = pipeline.stages.length === 1 ? pipeline.stages[0]!.tokens : [];
    const first = tokens[0];
    const expression = first?.kind === "group" || (first?.kind === "word" && (first.quoted || /^[$\d]/.test(first.text) || canonicalName(first.text) === "join-path"));
    const value = expression ? evaluateValue(tokens, ctx) : opaqueValue();
    for (const name of pipeline.assign) {
      ctx.values.set(name, !pipeline.compound && !assigned.has(name) && !forward.has(name) ? value : opaqueValue());
      assigned.add(name);
    }
  }
}

// A non-filesystem provider is distinct from an opaque filesystem operand.
function filePath(tokens: readonly PsToken[], ctx: Context): string | undefined | null {
  const path = providerPath(evaluateValue(tokens, ctx), ctx);
  // Typed values already have decoded escapes; literal backticks must survive.
  return path.state === "opaque" ? undefined : path.provider === "filesystem" ? path.path.replace(/\\/g, "/") : null;
}

// Associations require a literal operand, not a value inferred from runtime code.
function literalFilePath(token: PsToken, ctx: Context): string | undefined | null {
  if (token.kind !== "word" || token.nested.length !== 0
    || (!(token.raw.startsWith("'") || token.raw.startsWith("@'")) && /[$`]/.test(token.raw))) return undefined;
  const path = providerPath(valueOf(token.text, false, ctx), ctx);
  return path.state === "opaque" ? undefined : path.provider === "filesystem" ? path.path.replace(/\\/g, "/") : null;
}

const PATH_ARGUMENT: PowerShellPathBinding = { parameters: ["path", "literalpath"], position: 0 };

function pathBinding(bound: BoundArguments, role: PowerShellPathBinding | undefined, source: PowerShellPathBinding | undefined): PsToken[] {
  if (!role) return [];
  for (const parameter of role.parameters) {
    const value = bound.named.get(parameter);
    if (value) return value;
  }
  if (role.position === undefined) return [];
  const sourceNamed = role.position > 0 && source?.parameters.some((parameter) => bound.named.has(parameter));
  const token = bound.positional.at(role.position - Number(sourceNamed ?? false));
  return token ? [token] : [];
}

// A local writer's content is data; executable subexpressions are inspected separately.
function localContent(name: string | undefined, args: readonly PsToken[], ctx: Context, binding?: BoundArguments): PsToken[] {
  const policy = name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[name];
  if (!policy?.content) return [];
  const bound = binding ?? bindArguments(args, policy.parameters, ctx);
  const source = policy.materializes?.source ?? PATH_ARGUMENT;
  const destination = policy.materializes?.destination ?? policy.destination ?? source;
  const target = providerPath(evaluateValue(pathBinding(bound, destination, source), ctx), ctx);
  return bound.state === "known" && target.state === "known" && target.provider === "filesystem"
    && remoteWriteSignal(name!, args, ctx) === null ? pathBinding(bound, policy.content, source) : [];
}

function isNonFileBinding(bound: BoundArguments, role: PowerShellPathBinding): boolean {
  return bound.state === "known" && (role.variableParameters?.some((parameter) => bound.named.has(parameter)) ?? false)
    && pathBinding(bound, role, undefined).length === 0;
}

// Resolve path roles now; apply the write only after its arguments and command.
function materializationPlan(stage: PsCommand, ctx: Context): (() => void) | undefined {
  const { name, args } = headOf(stage, ctx);
  if (name === undefined) return;
  const policy = POWERSHELL_COMMAND_POLICIES[name];
  const effect = policy?.materializes;
  const destination = effect?.destination ?? (policy?.destination?.kind === undefined ? policy?.destination : undefined)
    ?? (policy?.effects.includes("provider-write") ? PATH_ARGUMENT : undefined);
  if (!effect && !destination && !/^export-/.test(name)) return;
  const expanded = expandSplats(args, ctx);
  if (expanded === null) return () => ctx.files.record(undefined);
  const bound = effect?.native ? { state: "known" as const, named: new Map<string, PsToken[]>(), positional: expanded }
    : bindArguments(expanded, policy?.parameters ?? [], ctx);
  if (bound.state === "opaque" || expanded.some((token) => token.kind === "word" && !token.quoted && token.text === ",")
    || (effect?.native && expanded.some((token) => token.kind === "word" && /^[-/][a-z]/i.test(token.text)))) {
    return () => ctx.files.record(undefined);
  }
  const sourceTokens = pathBinding(bound, effect?.source, undefined);
  const source = sourceTokens.length ? filePath(sourceTokens, ctx) : undefined;
  const targetTokens = pathBinding(bound, destination, effect?.source);
  if (destination && isNonFileBinding(bound, destination)) return;
  if (targetTokens.length === 0 && effect?.optional) return;
  let target = targetTokens.length ? filePath(targetTokens, ctx) : undefined;
  if (source) ctx.pathData.add(source);
  if (target) ctx.pathData.add(target);
  if (target === null) return;
  if (effect?.kind === "tree" && targetTokens.length === 0 && source) target = source.slice(0, source.length - posix.extname(source).length);
  if (effect?.kind === "rename" && target && source && !/^(?:[a-z]:|\/)/i.test(target)) target = posix.join(posix.dirname(source), target);
  if (effect?.kind === "new" && bound.named.has("name")) {
    const leaf = filePath(bound.named.get("name")!, ctx);
    if (leaf) ctx.pathData.add(leaf);
    target = target !== undefined && leaf ? posix.join(target, leaf) : undefined;
  }
  const itemType = bound.named.get("itemtype");
  const directory = effect?.kind === "new" && itemType !== undefined && /^directory$/i.test(evaluateValue(itemType, ctx).text);
  const tree = effect?.kind === "tree" || (effect?.kind === "copy" && (bound.named.has("recurse") || !source || !posix.extname(source)));
  return () => {
    ctx.files.record(target, { source: source ?? undefined, directory, tree });
    if (effect?.kind === "copy" && target && source) {
      // A literal destination can already be a directory; retain both bindings.
      ctx.files.record(posix.join(target, posix.basename(source)), { source });
    }
  };
}

function hiddenCode(reason: string): string {
  return `PowerShell hidden code (${reason})`;
}

// Opaque execution asks through normal permission rules; it is not an upload.
function ordinarySignal(ctx: Context, reason: string): null {
  ctx.ordinary.reason ??= reason;
  return null;
}

// File-backed execution cannot inherit the benign spelling of a newly written leaf.
function fileExecutionSignal(stage: PsCommand, feeder: PsCommand | undefined, ctx: Context, probe: boolean, pathData: boolean): string | null {
  const fileCode = hiddenCode;
  const { name, args, label } = headOf(stage, ctx);
  if (name === undefined) return null;
  if (probe && args.length === 0 && stage.tokens.length === 1
    && (pathData || /^[a-z][a-z\d+.-]*:\/\//i.test(name) || ctx.files.fileType(name) === "document")) return null;
  const materialized = (path: string) => {
    const file = ctx.files.executionTarget(path);
    return file ? fileCode(`materialized file${file.catalogue ? `, catalogue ${file.catalogue}` : ""}`) : null;
  };
  if (name === "invoke-item") {
    if (args.some((token) => token.kind === "word" && !token.quoted && /^@\w+$/.test(token.text))) return fileCode("nonliteral file association target");
    const expanded = expandSplats(args, ctx);
    const bound = expanded === null ? undefined : bindArguments(expanded, POWERSHELL_COMMAND_POLICIES[name]!.parameters, ctx);
    if (bound?.state !== "known") return fileCode("opaque file association binding");
    if (!knownAncillaryValues(bound, new Set(["path", "literalpath"]), ctx)) return fileCode("opaque file association option");
    const named = [...(bound.named.get("path") ?? []), ...(bound.named.get("literalpath") ?? [])];
    if (named.length && bound.positional.length) return fileCode("ambiguous file association binding");
    const paths = named.length ? named : bound.positional;
    if (!paths.length) return feeder ? fileCode("opaque associated pipeline item") : null;
    for (const token of paths) {
      const path = literalFilePath(token, ctx);
      if (!path || /[*?\[\]]/.test(path)) return fileCode("opaque file association target");
      const file = ctx.files.lookup(path);
      if (file?.catalogue) return materialized(path);
      if (ctx.files.isDirectory(path) || ctx.files.fileType(path) === "document"
        || (!probe && !ctx.launched && ctx.files.isExistingDirectory(path))) continue;
      return materialized(path) ?? fileCode("opaque associated file payload");
    }
    return null;
  }
  const first = stage.tokens[0];
  if (first?.kind !== "word" || first.quoted || /^[\[$@]/.test(first.text)) return null;
  const policy = POWERSHELL_COMMAND_POLICIES[name];
  if (policy?.executable) {
    const expanded = expandSplats(args, ctx);
    const bound = expanded === null ? undefined : bindArguments(expanded, policy.parameters, ctx);
    if (bound?.state !== "known") return fileCode("opaque executable binding");
    const target = filePath(pathBinding(bound, policy.executable, undefined), ctx);
    if (target) {
      const targetSignal = materialized(target);
      if (targetSignal) return targetSignal;
    }
  }
  // A spelling can resolve to a native executable on an edition without its cmdlet alias. Preserve the raw leaf before canonical command resolution.
  if (label && NATIVE_ALIASED.has(label)) {
    const aliasSignal = materialized(label);
    if (aliasSignal) return aliasSignal;
  }
  if (!policy || policy.native || policy.materializes?.native) {
    const signal = materialized(name);
    if (signal) return signal;
    // The interpreter's file operand executes even a document extension; other document operands retain their data role.
    const script = nativeInvocation(name, args, ctx).scriptPath;
    if (!script && policy?.argv && knownNativeData(name, args, ctx)
      && !policy.argv.info?.includes(nativeArguments(args, ctx)[0]!) && ctx.files.hasExecutableWrites())
      return fileCode("materialized task input");
    if (script) {
      const scriptSignal = materialized(script);
      if (scriptSignal) return scriptSignal;
    }
    // Untouched executable content remains opaque; matching earlier writes retain the more specific provenance reason above.
    const type = ctx.files.fileType(name);
    if (!policy && !isPowerShell(name) && opaqueRunnerReason([name]) === null
      && posix.extname(name) && (type === "opaque" || !probe)) return fileCode("opaque executable file payload");
    // An opaque consumer cannot prove that a materialized executable operand is data. Inert document operands do not acquire an execution role from argv.
    for (const token of args) {
      const path = filePath([token], ctx);
      if (!path) continue;
      const file = ctx.files.lookup(path);
      if (file && (file.catalogue || ctx.files.fileType(path) !== "document")) return materialized(path);
    }
  }
  return null;
}

function allPipelines(pipelines: readonly PsPipeline[], budget: PowerShellAnalysisBudget): PsPipeline[] {
  const out: PsPipeline[] = [];
  const visit = (list: readonly PsPipeline[]): void => {
    for (const pipeline of list) {
      budget.spend();
      out.push(pipeline);
      for (const stage of pipeline.stages) for (const token of stage.tokens) visitToken(token);
    }
  };
  const visitToken = (token: PsToken): void => {
    budget.spend();
    if (token.kind === "group") visit(token.body);
    else for (const body of token.nested) visit(body);
  };
  visit(pipelines);
  return out;
}

// Argument subexpressions precede their consumer; later writes cannot bless an earlier launch.
function* executionStages(pipelines: readonly PsPipeline[], budget: PowerShellAnalysisBudget, files: PowerShellFileProvenance): Generator<{ stage: PsCommand; feeder: PsCommand | undefined; mutatingBlocks: PsGroup[] }> {
  for (const pipeline of pipelines) for (const [index, stage] of pipeline.stages.entries()) {
    budget.spend();
    const mutatingBlocks: PsGroup[] = [];
    for (const token of stage.tokens) {
      budget.spend();
      const before = files.revision;
      if (token.kind === "group") {
        yield* executionStages(token.body, budget, files);
        if (token.open === "{" && files.revision !== before) mutatingBlocks.push(token);
      } else for (const body of token.nested) yield* executionStages(body, budget, files);
    }
    yield { stage, feeder: pipeline.stages[index - 1], mutatingBlocks };
  }
}

function referencesTainted(text: string, ctx: Context): boolean {
  ctx.budget.spend(1, text.length);
  if (ctx.tainted.size === 0) return false;
  for (const match of text.matchAll(/\$(?:\{([^}]+)\}|([\w:]+))/g)) {
    const name = (match[1] ?? match[2]!).toLowerCase();
    if (ctx.tainted.has(name) || ctx.tainted.has(name.replace(/^(?:script|global|local|private|using):/, ""))) return true;
  }
  return false;
}

// The command itself reads a file or secret.
function isReader(cmd: PsCommand, ctx: Context): boolean {
  const { name, args } = headOf(cmd, ctx);
  if (name !== undefined) {
    if (isReaderCommand(name)) return true;
    if (ENV_LISTERS.has(name) && args.some((token) => token.kind === "word" && /^env:/i.test(token.text))) return true;
  }
  return cmd.tokens.some((token) => token.kind === "word" && !token.quoted && DOTNET_READER.test(token.text));
}

// A token's value carries file or secret data.
function tokenCarriesData(token: PsToken, ctx: Context): boolean {
  ctx.budget.spend();
  if (token.kind === "group") return pipelinesCarryData(token.body, ctx);
  if (!token.quoted || token.raw.startsWith("\"") || token.raw.startsWith("@\"")) {
    if (referencesTainted(token.text, ctx)) return true;
  }
  if (!token.quoted && DOTNET_READER.test(token.text)) return true;
  return token.nested.some((body) => pipelinesCarryData(body, ctx));
}

function commandCarriesData(cmd: PsCommand, ctx: Context): boolean {
  if (isReader(cmd, ctx) || cmd.tokens.some((token) => tokenCarriesData(token, ctx))) return true;
  const { name, args } = headOf(cmd, ctx);
  if (name === undefined) return false;
  const argv = [name, ...nativeArguments(args, ctx)];
  return runnerCommandIndexes(argv).some((index) => {
    const target = argv[index];
    return target !== undefined && isReader({ tokens: [word(target, target, false, []), ...args.slice(index)] }, ctx);
  });
}

function pipelinesCarryData(pipelines: readonly PsPipeline[], ctx: Context): boolean {
  return pipelines.some((pipeline) => pipeline.stages.some((stage) => commandCarriesData(stage, ctx)));
}

// Variables assigned from file data anywhere in the command, to a fixed point (`$a = gc f; $b = $a`): assignments, `Set-Variable`, `-OutVariable` on a reader, and `foreach ($l in <reader>)`.
function collectTainted(pipelines: readonly PsPipeline[], ctx: Context): void {
  const every = allPipelines(pipelines, ctx.budget);
  for (let changed = true; changed;) {
    ctx.budget.spend();
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

// `foreach ($l in <source>)`: the source after `in` carries file data.
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

// Synthetic bash text for a native program's argv, for the bash sender rules.
function bashArgv(name: string, args: readonly PsToken[], ctx: Context): string {
  ctx.budget.spend(args.length + 1, args.reduce((length, token) => length + token.raw.length, name.length));
  const quote = (text: string): string => `'${normalizePaths(text).replace(/'/g, "'\\''")}'`;
  return [name, ...args.map((token) => quote(token.kind === "word" ? token.text : "__ave_dynamic__"))].join(" ");
}

// Arguments with `@p` splats replaced by the hashtable `p` was assigned in this command, or `null` when a splat's parameters cannot be seen.
function expandSplats(args: readonly PsToken[], ctx: Context): PsToken[] | null {
  ctx.budget.spend(args.length + 1);
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
  if (value.state === "opaque") return true;
  return token.kind === "group" && token.body.some((pipeline) => pipeline.stages.some((stage) => {
    const computed = evaluateValue(stage.tokens, ctx);
    return computed.state === "opaque" || stage.tokens.some((inner) => hasOpaqueComputedValue(inner, ctx));
  }));
}

// A forwarded native spelling cannot inherit a same-named cmdlet alias.
function nativeCommandView(target: string, args: PsToken[]): PsCommand {
  const leaf = (target.split(/[\\/]/).pop() ?? target).toLowerCase();
  const name = POWERSHELL_COMMAND_POLICIES[`${leaf}.exe`]?.native ? `${leaf}.exe` : target;
  return { tokens: [word(name, name, false, []), ...args] };
}

function wrappedCommand(cmd: PsCommand, ctx: Context): PsCommand | undefined {
  const { name, args: original } = headOf(cmd, ctx);
  if (name === undefined) return undefined;
  const args = expandSplats(original, ctx) ?? original;
  const argv = [name, ...nativeArguments(args, ctx)];
  const { index: length, code } = wrapperCommand(argv);
  if (code) {
    if (code.text === undefined) return undefined;
    // Native wrapper strings use shell syntax, never cmdlet/member meanings.
    return nativeCommandView("sh", [word("-c", "-c", false, []), word(`'${code.text.replace(/'/g, "''")}'`, code.text, true, [])]);
  }
  const target = argv[length];
  return length > 0 && target !== undefined ? nativeCommandView(target, args.slice(length)) : undefined;
}

// Uncertain positions widen only floor inspection, never language classification.
function* invocationViews(cmd: PsCommand, ctx: Context, floorCandidates = false): Generator<PsCommand> {
  ctx.budget.spend();
  yield cmd;
  const wrapped = wrappedCommand(cmd, ctx);
  if (wrapped) yield* invocationViews(wrapped, ctx, floorCandidates);
  const { name, args: original } = headOf(cmd, ctx);
  if (name === undefined) return;
  const args = expandSplats(original, ctx) ?? original;
  const argv = [name, ...nativeArguments(args, ctx)];
  for (const index of floorCandidates ? wrapperCommand(argv).candidates ?? [] : []) {
    const target = argv[index];
    if (target !== undefined) yield* invocationViews(nativeCommandView(target, args.slice(index)), ctx, floorCandidates);
  }
  const code = runnerCodeContext(argv);
  if (code) {
    yield* invocationViews(nativeCommandView(code.interpreter, args.slice(code.operandIndex - 1)), ctx, floorCandidates);
    return;
  }
  for (const index of runnerCommandIndexes(argv)) {
    const target = argv[index];
    if (target !== undefined) yield* invocationViews(nativeCommandView(target, args.slice(index)), ctx, floorCandidates);
  }
}

function unwrapCommand(cmd: PsCommand, ctx: Context): PsCommand {
  for (let child = wrappedCommand(cmd, ctx); child; child = wrappedCommand(cmd, ctx)) {
    ctx.budget.spend();
    cmd = child;
  }
  return cmd;
}

function credentialCommandSignal(cmd: PsCommand, ctx: Context): string | null {
  for (const view of invocationViews(cmd, ctx, true)) {
    const { name, args } = headOf(view, ctx);
    const credential = name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[name]?.credential;
    if (credential === true || credential?.test(nativeArguments(args, ctx).join(" "))) return `sensitive credential store (${name})`;
  }
  return null;
}

function senderSignal(cmd: PsCommand, fedByPipeline: boolean, ctx: Context, fileInput = false): string | null {
  for (const view of invocationViews(cmd, ctx, true)) {
    const signal = senderCommandSignal(view, fedByPipeline, ctx, fileInput);
    if (signal) return signal;
  }
  return null;
}

function senderCommandSignal(cmd: PsCommand, fedByPipeline: boolean, ctx: Context, fileInput: boolean): string | null {
  const head = headOf(cmd, ctx);
  // Qualified spellings cannot prove benign bindings, but a known sender leaf still retains its upload checks at an explicit invocation boundary.
  const name = head.name !== undefined && /[\\/]/.test(head.name) ? canonicalName(head.label ?? head.name) : head.name;
  const expanded = expandSplats(head.args, ctx);
  if (expanded === null && name !== undefined && isNetworkCommand(name, head.args)) return `${head.label ?? name} parameters splatted from a variable the floor cannot read`;
  if (expanded === null) ordinarySignal(ctx, `${head.label ?? name ?? "command"} parameters splatted from a variable the analyzer cannot read`);
  const args = expanded ?? head.args;
  const remoteWrite = name === undefined ? null : remoteWriteSignal(name, args, ctx);
  if (remoteWrite) return remoteWrite;
  const policy = name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[name];
  if (policy?.sink?.test(normalizeDashes(nativeArguments(args, ctx).join(" ")))) return `${head.label ?? name} catalogued transfer`;
  const carries = args.some((token) => tokenCarriesData(token, ctx));
  if (name !== undefined) {
    const bare = name.replace(/\.exe$/, "");
    if (bare === "ftp" && args.some((token) => token.kind === "word" && /^-s:/i.test(token.text))) return "ftp scripted file transfer";
    if (bare === "tftp" && args.some((token) => token.kind === "word" && /^put$/i.test(token.text))) return "tftp file upload";
    if (HTTP_CMDLETS.has(name)) {
      if (parameterIndex(args, "infile") !== -1) return `${head.label ?? name} upload of a file (-InFile)`;
      if (carries) return `${head.label ?? name} request built from file data`;
      if (fedByPipeline) return `${head.label ?? name} request body from the pipeline`;
    }
    const nativeName = head.label && NATIVE_ALIASED.has(head.label) ? head.label : bare;
    if (NATIVE_ALIASED.has(nativeName) || (isNetworkProgram([bare]) && !HTTP_CMDLETS.has(name))) {
      const argv = `${fileInput ? "cat '__ave_pipeline_input__' | " : ""}${bashArgv(nativeName, args, ctx)}`;
      // Only a short, entirely quoted argv reaches this parser; reserve its scan work.
      ctx.budget.spend(argv.length * 4, argv.length);
      const native = shellExfiltrationSignal(argv, ctx.cwd);
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
    // Multi-purpose programs routinely take local text that is not a request body (`git commit -m (Get-Content msg.txt -Raw)`), as in the bash floor.
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
    if (DOTNET_UPLOAD_DATA.test(method) && later.some((arg) => hasOpaqueComputedValue(arg, ctx))) ordinarySignal(ctx, ".NET upload value with hidden code");
  }
  return null;
}

// Preserve the leading pair of separators; path normalization would erase it.
function isUncPath(value: PsValue, ctx: Context): boolean {
  const path = providerPath(value, ctx);
  return path.state === "known" && path.provider === "filesystem" && /^\/{2,}(?:\?\/UNC\/)?[^/]+\/[^/]+/i.test(path.path.replace(/\\/g, "/"));
}

// Destination roles share the same colon/separated binder as every other parameter.
function remoteWriteSignal(name: string, args: readonly PsToken[], ctx: Context): string | null {
  ctx.budget.spend(args.length + 1);
  const policy = POWERSHELL_COMMAND_POLICIES[name];
  let destinations: PsToken[][] = [];
  let nativeWrite = false;
  let nativeBindingOpaque = false;
  if (policy?.destination) {
    const bound = bindArguments(args, policy.parameters, ctx);
    if (isNonFileBinding(bound, policy.destination)) return null;
    for (const parameter of policy.destination.parameters) {
      const tokens = bound.named.get(parameter);
      if (tokens) destinations.push(tokens);
    }
    if (destinations.length === 0 && policy.destination.position !== undefined) {
      const sourceNamed = policy.destination.position > 0 && (bound.named.has("path") || bound.named.has("literalpath"));
      const positional = bound.positional[policy.destination.position - Number(sourceNamed)];
      if (positional) destinations.push([positional]);
    }
    // A malformed binding cannot establish which operand is the destination.
    if (bound.state === "opaque" || args.some((token) => token.kind === "word" && !token.quoted && /^\/[a-z-]+(?::.*)?$/i.test(token.text))) destinations = args.map((token) => [token]);
    if (policy.destination.kind === "mail") {
      // Preserve file-source diagnostics; mail without a file still transmits output.
      if (parameterIndex(args, "attachments") !== -1 || args.some((token) => tokenCarriesData(token, ctx))) return null;
      return "Send-MailMessage output upload";
    }
  } else if (/^export-/.test(name)) {
    // Extension exporters have no trusted signature. Any share operand can be a sink.
    destinations = args.flatMap((token, index) => {
      if (token.kind !== "word" || token.quoted || !token.text.startsWith("-")) return [[token]];
      const binding = argumentBinding(args, index);
      return binding.state === "bound" ? [[binding.value]] : [];
    });
  } else {
    const bare = name.replace(/\.exe$/, "");
    if (["robocopy", "xcopy", "copy"].includes(bare)) {
      nativeWrite = true;
      nativeBindingOpaque = args.some((token) => token.kind === "word" && !token.quoted && /^[-/][a-z]/i.test(token.text));
      if (nativeBindingOpaque) {
        // Unknown native options can themselves name another output file.
        destinations = args.flatMap((token, index) => {
          const binding = token.kind === "word" && token.text.includes(":") ? argumentBinding(args, index) : undefined;
          return binding?.state === "bound" ? [[token], [binding.value]] : [[token]];
        });
      } else if (args[1]) destinations = [[args[1]]];
    } else if (bare === "net" && args[0]?.kind === "word" && args[0].text.toLowerCase() === "use") {
      nativeWrite = true;
      destinations = args.slice(1).map((token) => [token]);
    } else if (bare === "print" || bare === "mode") {
      // Printer ports may be rebound to remote queues outside this input.
      return `${name} printer port upload`;
    }
  }
  const values = destinations.map((tokens) => evaluateValue(tokens, ctx));
  if (values.some((value) => isUncPath(value, ctx))) return `${name} UNC file upload`;
  if (policy?.destination?.kind === "printer") return `${name} printer output upload`;
  if (values.some((value) => /(?:^|\/)(?:(?:lpt|com)(?:[1-9]\d*|[¹²³])|prn|aux)(?::|\.|$)/i.test(normalizePaths(value.text).replace(/^[a-z]:/i, "").trimEnd()))) {
    return `${name} printer port upload`;
  }
  if (nativeBindingOpaque || values.some((value) => providerPath(value, ctx).state === "opaque")
    || ((nativeWrite || policy?.destination || /^export-/.test(name)) && values.length === 0)) return ordinarySignal(ctx, hiddenCode(values.find((value) => value.reason)?.reason ?? "opaque upload destination"));
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
      const signal = senderSignal(stage, index > 0, stageCtx, fedByData);
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

// A network-capable command anywhere (any position, any depth).
function hasNetwork(pipelines: readonly PsPipeline[], ctx: Context): boolean {
  return allPipelines(pipelines, ctx.budget).some((pipeline) => pipeline.stages.some((stage) => {
    const { name, args } = headOf(stage, ctx);
    return name !== undefined && isNetworkCommand(name, args);
  }));
}

// `$p = @{ Key = value; … }` anywhere in the command, for `@p` splats.
function collectSplats(pipelines: readonly PsPipeline[], ctx: Context): void {
  const invalid = new Set<string>();
  const assigned = new Set<string>();
  for (const pipeline of allPipelines(pipelines, ctx.budget)) {
    const only = pipeline.stages.length === 1 && pipeline.stages[0]!.tokens.length === 1 ? pipeline.stages[0]!.tokens[0]! : undefined;
    for (const name of pipeline.assign) {
      if (!assigned.has(name) && !pipeline.compound && only?.kind === "group" && only.open === "@(" && only.body.length === 1 && only.body[0]!.stages.length === 1) {
        const elements = only.body[0]!.stages[0]!.tokens;
        const tokens = elements.filter((token) => token.kind !== "word" || token.quoted || token.text !== ",");
        if (literalArgumentList(elements, ctx) !== null) {
          ctx.splats.set(name, tokens);
          assigned.add(name);
          continue;
        }
      }
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
  for (const pipeline of allPipelines(pipelines, ctx.budget)) {
    const targets = new Set(pipeline.assign);
    for (const match of pipeline.references.matchAll(/\$(?:\{([^}]+)\}|([\w:]+))/g)) {
      const name = (match[1] ?? match[2]!).toLowerCase();
      if (targets.delete(name)) continue;
      // Member/index updates, mutator calls, aliases and opaque object uses all invalidate the literal snapshot. A later literal cannot restore it.
      if (ctx.splats.has(name)) invalid.add(name);
    }
    for (const stage of pipeline.stages) for (const token of stage.tokens) {
      ctx.budget.spend();
      if (token.kind !== "word" || !/variable:/i.test(token.text)) continue;
      for (const name of ctx.splats.keys()) if (token.text.toLowerCase().includes(`variable:${name}`)) invalid.add(name);
    }
  }
  for (const name of invalid) ctx.splats.delete(name);
}

// A snapshot survives only if every possible writer and reference escape is understood.
function invalidateVariableMutations(pipelines: readonly PsPipeline[], ctx: Context): void {
  const invalidate = (target?: PsValue): void => {
    const definite = target?.state === "known" && /^\+?(?:(?:global|script|local|private):)?\w+$/i.test(target.text)
      ? target.text.replace(/^\+/, "").replace(/^(?:global|script|local|private):/i, "").toLowerCase() : undefined;
    if (definite === undefined) ctx.scopeOpaque = true;
    if (definite?.startsWith("ps")) ctx.vocabularyOpaque = true;
    for (const key of new Set([...ctx.splats.keys(), ...ctx.values.keys()])) {
      ctx.budget.spend();
      if (definite !== undefined && key !== definite && key.replace(/^(?:global|script|local|private):/, "") !== definite) continue;
      ctx.splats.delete(key);
      ctx.values.set(key, opaqueValue());
    }
    if (definite !== undefined) ctx.values.set(definite, opaqueValue());
  };
  for (const pipeline of allPipelines(pipelines, ctx.budget)) for (const stage of pipeline.stages) {
    if (pipeline.assign.some((name) => /^(?:(?:alias|function):|ps)/i.test(name.replace(/^(?:global|script|local|private):/, "")))) ctx.vocabularyOpaque = true;
    const { name, args } = headOf(stage, ctx);
    const first = stage.tokens[0];
    const data = first?.kind === "group" || (first?.kind === "word" && (first.quoted || /^[\d$@[]/.test(first.text)));
    const script = name === "invoke-expression" || stage.tokens.some((token) => token.kind === "word"
      && !token.quoted && /(?:\.invoke|\[scriptblock\]::create)$/i.test(token.text));
    const policy = name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[name];
    if (!data && nativeCommandData(stage, ctx)) continue;
    if (first?.kind === "word" && first.text.toLowerCase() === "foreach" && args[0]?.kind === "group") {
      const variable = /^\(\s*\$(\w+)\s+in\s/i.exec(args[0].raw)?.[1];
      invalidate(variable === undefined ? undefined : valueOf(variable, false, ctx));
      continue;
    }
    if (script || (!data && !policy)) { invalidate(); continue; }
    if (!policy) {
      const effectsOpaque = first?.kind === "group" ? first.open === "@{" && evaluateValue([first], ctx).state === "opaque"
        : first?.kind === "word" && !first.quoted && /^(?:\[|\$(?:\{[^}]+\}|[\w:]+)(?:\.|\[|\+\+|--))/.test(first.text);
      if (data && effectsOpaque) {
        invalidate();
        if (first?.kind === "word" && /^\$/.test(first.text) && pipeline.references.includes("=")) ctx.vocabularyOpaque = true;
      }
      continue;
    }
    const expanded = expandSplats(args, ctx);
    const bound = expanded === null ? undefined : bindArguments(expanded, policy.parameters, ctx);
    if (bound?.state !== "known") { invalidate(); continue; }
    for (const parameter of policy.destination?.variableParameters ?? []) {
      const target = bound.named.get(parameter);
      if (target) invalidate(evaluateValue(target, ctx));
    }
    const operand = (...parameters: string[]): PsValue => {
      const tokens = parameters.map((parameter) => bound.named.get(parameter)).find((value) => value !== undefined);
      return evaluateValue(tokens ?? (bound.positional[0] ? [bound.positional[0]] : []), ctx);
    };
    // Common-parameter assignments are writes regardless of the command's effects.
    for (const parameter of ["outvariable", "errorvariable", "warningvariable", "informationvariable", "pipelinevariable"]) {
      const tokens = bound.named.get(parameter);
      if (tokens) {
        const target = evaluateValue(tokens, ctx);
        if (target.state === "opaque") ctx.vocabularyOpaque = true;
        invalidate(target);
      }
    }
    if (policy?.effects.includes("variable-read")) {
      const target = operand("name", "path", "literalpath");
      if (name === "get-variable") invalidate(target);
      else {
        const path = providerPath(target, ctx);
        if (path.state === "opaque") invalidate();
        else if (path.provider === "variable") invalidate(valueOf(path.path, false, ctx));
      }
    }
    if (policy?.effects.includes("variable-write")) {
      const target = operand("name");
      if (target.state === "opaque") ctx.vocabularyOpaque = true;
      invalidate(target);
    } else if (policy?.effects.includes("provider-write")) {
      const source = policy.materializes?.source ?? PATH_ARGUMENT;
      const destination = policy.materializes?.destination ?? policy.destination;
      const targets = [pathBinding(bound, source, undefined), pathBinding(bound, destination, source)]
        .filter((tokens) => tokens.length !== 0).map((tokens) => evaluateValue(tokens, ctx));
      for (const target of targets) {
        const path = providerPath(target, ctx);
        if (path.state === "opaque") { invalidate(); ctx.vocabularyOpaque = true; }
        else if (path.provider === "variable") invalidate();
        else if (path.provider === "environment") { invalidate(); ctx.values.set(`env:${path.path.toLowerCase()}`, opaqueValue()); }
        else if (path.provider === "alias" || path.provider === "function") ctx.vocabularyOpaque = true;
      }
    }
  }
}

// Embedded code

function isPowerShell(name: string): boolean {
  return /^(?:pwsh|powershell)(?:\.exe)?$/i.test(canonicalName(name));
}

// Literal script text, or null when runtime evaluation supplies any part.
function literalCode(tokens: readonly PsToken[], ctx: Context, sequence = false): string | null {
  ctx.budget.spend(tokens.length + 1);
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && tokens[0]?.kind === "group" && tokens[0].open === "{") return tokens[0].raw.slice(1, -1);
  const hasExpansion = (token: PsToken): boolean => token.kind === "word"
    ? !token.raw.startsWith("'") && !token.raw.startsWith("@'") && /\$(?:\{|[\w:(])/.test(token.raw.replace(/`./gs, ""))
    : token.open !== "{" && token.body.some((pipeline) => pipeline.stages.some((stage) => stage.tokens.some(hasExpansion)));
  if (tokens.some(hasExpansion)) return null;
  if (sequence && tokens.length > 1 && tokens.every((token) => token.kind === "word")) {
    // These are child-command tokens, so a parameter is literal code spelling, not an unsupported scalar operator. Preserve quoted argument boundaries.
    return tokens.map((token) => token.raw).join(" ");
  }
  const expression = tokens.length === 1 || tokens.some((token) => token.kind === "word" && !token.quoted && /(?:\+|^-f$)/i.test(token.text));
  if (expression) {
    const value = evaluateValue(tokens, ctx);
    return value.state === "known" && value.shape === "scalar" ? value.text : null;
  }
  if (!sequence) return null;
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
  const bound = bindArguments(args, SHELL_PARAMETERS, ctx);
  if (bound.state === "opaque" || bound.named.has("file") || bound.positional.length !== 0
    || (bound.named.has("encodedcommand") && bound.named.has("command"))) return null;
  if (!knownAncillaryValues(bound, new Set(["command", "encodedcommand"]), ctx)) return null;
  const encoded = bound.named.get("encodedcommand");
  if (encoded) return encoded.length === 1 ? decodeCommand(literalCode(encoded, ctx)) : null;
  const values = bound.named.get("command");
  if (!values || values.length === 0) return null;
  return joinedArguments && values.length > 1 ? values.map((token) => token.raw).join(" ") : literalCode(values, ctx, true);
}

type EmbeddedCode = { state: "none" } | { state: "opaque" } | { state: "literal"; text: string; opaque?: true; native?: string; data?: PsGroup[] };

// Native argument mode makes literal switches data, rather than scalar operators.
function nativeArguments(args: readonly PsToken[], ctx: Context): Array<string | undefined> {
  return (expandSplats(args, ctx) ?? args).map((token) => {
    ctx.budget.spend();
    if (token.kind === "word" && token.nested.length === 0 && !token.reason && (token.quoted || !/^(?:@|--%)/.test(token.text))
      && (token.raw.startsWith("'") || !/[$`]/.test(token.raw))) return ctx.budget.supports("literal") ? token.text : undefined;
    const value = evaluateValue([token], ctx);
    return value.state === "known" && value.shape === "scalar" ? value.text : undefined;
  });
}

// Complete native task forms share the command table with launchers and aliases.
function knownNativeData(name: string, args: readonly PsToken[], ctx: Context): boolean {
  ctx.budget.spend();
  const grammar = POWERSHELL_COMMAND_POLICIES[name]?.argv;
  if (!grammar) return false;
  const values = nativeArguments(args, ctx);
  if (values.some((value) => value === undefined)) return false;
  if ((values[0] === "-m" && grammar.modules?.includes(values[1]!))
    || nativeInvocation(name, args, ctx).scriptPath !== undefined) return true;
  if (values.some((value) => grammar.code?.some((option) => value === option || value!.startsWith(`${option}=`) || (option.length === 2 && value!.startsWith(option))))) return false;
  return !!((values.length === 1 && grammar.info?.includes(values[0]!))
    || grammar.verbs?.includes(values[0]!) || grammar.switches?.includes(values[0]!));
}

function nativeCode(name: string, args: readonly PsToken[], ctx: Context): EmbeddedCode {
  const policy = POWERSHELL_COMMAND_POLICIES[name]!;
  if (knownNativeData(name, args, ctx)) return { state: "none" };
  if (!policy.effects.includes("launcher") && nativeArguments(args, ctx).every((value) => value !== undefined)) return { state: "none" };
  const values = nativeArguments(args, ctx);
  if (values.some((value) => value === undefined)) return { state: "opaque" };
  let body: readonly PsToken[] | undefined;
  if (policy.native === "cmd") {
    const index = values.findIndex((value) => /^\/[ck]$/i.test(value!));
    if (index >= 0 && values.slice(0, index).every((value) => /^\/(?:d|q|a|u|s)$/i.test(value!))) body = args.slice(index + 1);
  } else if (policy.native === "wmic" && values.length === 4
    && values.slice(0, 3).join(" ").toLowerCase() === "process call create") body = args.slice(3);
  const text = body?.length ? literalCode(body, ctx, true) : null;
  if (policy.native === "cmd" && text !== null) {
    // Only a flat interpreter invocation or inert echo has understood native binding. Other literals are scanned, but cannot acquire cmdlet semantics.
    const { pipelines: parsed } = lex(text, ctx.budget);
    const child = parsed?.length === 1 && parsed[0]?.stages.length === 1 ? parsed[0].stages[0] : undefined;
    const first = child?.tokens[0];
    const known = first?.kind === "word" && !first.quoted && /^(?:powershell|pwsh|cmd)(?:\.exe)?$|^echo$/i.test(first.text)
      && child!.tokens.every((token) => token.kind === "word") && !/[%!^&|<>()\r\n]/.test(text);
    if (!known) return { state: "literal", text, opaque: true, native: first?.kind === "word" ? first.text : undefined };
  }
  return text === null ? { state: "opaque" } : { state: "literal", text };
}

function hasMemberInvocation(cmd: PsCommand): boolean {
  return cmd.tokens.some((token, index) => token.kind === "word" && !token.quoted
    && /(?:\]|::|\.)/.test(token.text) && (cmd.tokens[index + 1]?.kind === "group"
      || (/(?:\.|::)$/.test(token.text) && cmd.tokens[index + 1]?.kind === "word" && cmd.tokens[index + 2]?.kind === "group")));
}

function nativeInvocation(name: string, args: readonly PsToken[], ctx: Context) {
  const values = nativeArguments(args, ctx);
  const argv = [name, ...values];
  const informational = values.length === 1 && POWERSHELL_COMMAND_POLICIES[name]?.argv?.info?.includes(values[0]!);
  const reason = informational ? null : hiddenCodeReason(argv);
  // A literal script-file operand is ordinary native argv; explicit code options, shells, wrappers and command-running verbs retain their launcher identity.
  const script = INTERPRETER_SET.has(programName(name)) && !RUNNER_SET.has(runnerName(name)) && args.length > 0 && values.every((value) => value !== undefined)
    && argv[1] !== "-" && !argv[1]!.startsWith("-") && reason?.startsWith("code passed to ");
  return { reason, values, scriptPath: script ? argv[1] : undefined,
    ordinaryAsk: wrapperCommand(argv).ordinaryAsk ?? opaqueRunnerReason(argv) ?? undefined };
}

// Static native interpreter text has its own language, not cmdlet semantics.
function genericInterpreter(name: string): boolean {
  if (isPowerShell(name) || POWERSHELL_COMMAND_POLICIES[name]?.native === "cmd") return false;
  const program = programName(name);
  return (SHELL_SET.has(program) && !WRAPPER_SET.has(program)) || INTERPRETER_SET.has(program);
}

function genericTextSignals(text: string, ctx: Context): FloorSignals {
  ctx.budget.spend(text.length * 4 + 1, text.length);
  return { sensitive: shellSensitivePathSignal(text, ctx.cwd), exfiltration: shellExfiltrationSignal(text, ctx.cwd) };
}

function genericInvocation(cmd: PsCommand, ctx: Context): boolean {
  for (const view of invocationViews(cmd, ctx)) {
    const { name } = headOf(view, ctx);
    if (name !== undefined && genericInterpreter(name)) return true;
  }
  return false;
}

// Declared interpreter operands keep their language through wrappers and runners.
function genericArgumentSignals(cmd: PsCommand, ctx: Context, handled: Set<PsToken>): FloorSignals & { generic: boolean } {
  const signals = { sensitive: null, exfiltration: null, generic: false } as FloorSignals & { generic: boolean };
  for (const view of invocationViews(cmd, ctx)) {
    const head = headOf(view, ctx);
    if (head.name === undefined || !genericInterpreter(head.name)) continue;
    signals.generic = true;
    const args = expandSplats(head.args, ctx) ?? head.args;
    const invocation = genericTextSignals(bashArgv(head.name, args, ctx), ctx);
    signals.sensitive ??= invocation.sensitive;
    signals.exfiltration ??= invocation.exfiltration;
    for (const [index, text] of nativeArguments(args, ctx).entries()) {
      const token = args[index]!;
      if (handled.has(token)) continue;
      handled.add(token);
      if (text === undefined) { ordinarySignal(ctx, hiddenCode("opaque interpreter binding")); continue; }
      const option = token.kind === "word" && !token.quoted && text.startsWith("-");
      if (option && !text.includes("=")) continue;
      const nested = genericTextSignals(option ? text.slice(text.indexOf("=") + 1) : text, ctx);
      signals.sensitive ??= nested.sensitive;
      signals.exfiltration ??= nested.exfiltration;
    }
  }
  return signals;
}

function nativeTextView(text: string, target: string, ctx: Context): PsCommand | undefined {
  const stage = lex(text, ctx.budget).pipelines?.[0]?.stages[0];
  return stage ? nativeCommandView(target, headOf(stage, ctx).args) : undefined;
}

// A native child retains catalogue effects without interpreting its language as cmdlets.
function nativeTextSignals(text: string, target: string, ctx: Context): FloorSignals & { generic: boolean } {
  ctx.budget.enter(text);
  try {
    const signals = genericTextSignals(text, ctx);
    const view = nativeTextView(text, target, ctx);
    if (!view) return { ...signals, generic: genericInterpreter(canonicalName(target)) };
    const interpreted = genericArgumentSignals(view, ctx, new Set());
    signals.sensitive ??= interpreted.sensitive;
    signals.exfiltration ??= interpreted.exfiltration;
    signals.sensitive ??= credentialCommandSignal(view, ctx);
    signals.exfiltration ??= senderSignal(view, false, ctx);
    const { name, args } = headOf(view, ctx);
    if (name !== undefined) {
      const native = nativeInvocation(name, args, ctx);
      if (native.ordinaryAsk) ordinarySignal(ctx, native.ordinaryAsk);
      if (!interpreted.generic && POWERSHELL_COMMAND_POLICIES[name]?.native) {
        const code = nativeCode(name, args, ctx);
        if (code.state === "literal") {
          const child = code.native ? nativeTextSignals(code.text, code.native, ctx) : inspectPowerShell(code.text, ctx.cwd, ctx.budget, true, false, ctx.files);
          signals.sensitive ??= child.sensitive;
          signals.exfiltration ??= child.exfiltration;
          if (child.ordinaryAsk) ordinarySignal(ctx, child.ordinaryAsk);
        }
      }
    }
    return { ...signals, generic: interpreted.generic };
  } finally { ctx.budget.leave(); }
}

// Native wrappers and explicit interpreter options retain their code-carrying effects.
function hasNativeLauncher(cmd: PsCommand, ctx: Context): boolean {
  const { name, args } = headOf(cmd, ctx);
  if (name !== undefined && POWERSHELL_COMMAND_POLICIES[name]?.native) return !knownNativeData(name, args, ctx);
  if (name === undefined || isPowerShell(name) || POWERSHELL_COMMAND_POLICIES[name] || /^[\[$@]/.test(name)) return false;
  const { reason, scriptPath, ordinaryAsk, values } = nativeInvocation(name, args, ctx);
  if (ordinaryAsk) return false;
  return (programName(name) === "git" && values.every((value) => value !== undefined) && values[0]?.toLowerCase() === "config") || (reason !== null && scriptPath === undefined);
}

function nativeCommandData(stage: PsCommand, ctx: Context, args = headOf(stage, ctx).args): boolean {
  const { name } = headOf(stage, ctx);
  const policy = name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[name];
  return name !== undefined && (policy?.native ? (knownNativeData(name, args, ctx)
    || (!policy.effects.includes("launcher") && nativeArguments(args, ctx).every((value) => value !== undefined)))
    : (MULTI_PURPOSE_NETWORK.has(name.replace(/\.exe$/, "")) || opaqueRunnerReason([name]) !== null)
      && nativeArguments(args, ctx).every((value) => value !== undefined) && !hasNativeLauncher(stage, ctx));
}

// Literal script blocks are traversed in place; member dispatch needs a known target.
function dispatchSignal(name: string, args: readonly PsToken[], feeder: PsCommand | undefined, ctx: Context): string | null {
  const expanded = expandSplats(args, ctx);
  const policy = POWERSHELL_COMMAND_POLICIES[name]!;
  const bound = expanded === null ? undefined : bindArguments(expanded, policy.parameters, ctx);
  if (bound?.state !== "known") return "PowerShell hidden code (opaque dispatch binding)";
  const source = feeder ? headOf(feeder, ctx) : undefined;
  let members = source?.name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[source.name]?.members;
  // Providers and switches can change the output type of a listing.
  if (source?.name === "get-childitem") {
    const expandedSource = expandSplats(source.args, ctx);
    const sourceBound = expandedSource === null ? undefined : bindArguments(expandedSource, POWERSHELL_COMMAND_POLICIES[source.name]!.parameters, ctx);
    const paths = sourceBound ? [...sourceBound.positional.map((token) => [token]),
      ...["path", "literalpath"].flatMap((parameter) => sourceBound.named.has(parameter) ? [sourceBound.named.get(parameter)!] : [])] : [];
    if (sourceBound?.state !== "known" || sourceBound.named.has("name") || paths.some((tokens) => {
      const path = providerPath(evaluateValue(tokens, ctx), ctx);
      return path.state === "opaque" || path.provider !== "filesystem";
    })) members = undefined;
  }
  const input = bound.named.get("inputobject");
  if (input) members = evaluateValue(input, ctx).state === "known" ? ["length"] : undefined;
  const knownMember = (tokens: readonly PsToken[]): boolean => {
    const value = evaluateValue(tokens, ctx);
    return value.state === "known" && (members?.includes(value.text.toLowerCase()) ?? false);
  };
  if (name === "foreach-object") {
    if (bound.named.has("membername") || bound.named.has("argumentlist")) return "PowerShell hidden code (member dispatch)";
    const scripts = [...bound.positional, ...["process", "begin", "end", "remainingscripts", "parallel"].flatMap((parameter) => bound.named.get(parameter) ?? [])];
    if (scripts.length === 0 || scripts.some((token) => token.kind !== "group" || token.open !== "{")) return "PowerShell hidden code (opaque script dispatch)";
  } else if (name === "where-object") {
    const script = bound.named.get("filterscript") ?? (bound.named.has("property") ? undefined : bound.positional);
    if (script && (script.length !== 1 || script[0]?.kind !== "group" || script[0].open !== "{")) return "PowerShell hidden code (opaque filter dispatch)";
  }
  for (const token of [...bound.positional, ...bound.named.values()].flat()) {
    if (token.kind !== "group" || token.open !== "{") continue;
    for (const pipeline of token.body) for (const stage of pipeline.stages) {
      ctx.budget.spend();
      const first = stage.tokens[0];
      const member = stage.tokens.length === 1 && first?.kind === "word" && !first.quoted
        ? /^\$(?:_|psitem)\.([a-z_]\w*)$/i.exec(first.text)?.[1] : undefined;
      if (member !== undefined && members?.includes(member.toLowerCase())) ctx.memberReads.add(stage);
    }
  }
  for (const parameter of ["property", "expandproperty", "groupby"]) {
    const tokens = bound.named.get(parameter);
    if (tokens && !knownMember(tokens)) return "PowerShell hidden code (opaque member target)";
  }
  if (!SCRIPT_BLOCK_RUNNERS.has(name) && name !== "rename-item" && bound.positional.length && !knownMember(bound.positional)) return "PowerShell hidden code (opaque member target)";
  for (const [parameter, tokens] of bound.named) {
    if (["process", "begin", "end", "remainingscripts", "parallel", "filterscript"].includes(parameter)) continue;
    if (tokens.length && evaluateValue(tokens, ctx).state === "opaque") return "PowerShell hidden code (opaque dispatch argument)";
  }
  if (!SCRIPT_BLOCK_RUNNERS.has(name) && bound.positional.some((token) => evaluateValue([token], ctx).state === "opaque")) return "PowerShell hidden code (opaque member argument)";
  return null;
}

function knownAncillaryValues(bound: BoundArguments, operands: ReadonlySet<string>, ctx: Context): boolean {
  for (const [name, tokens] of bound.named) {
    ctx.budget.spend();
    if (operands.has(name) || tokens.length === 0) continue;
    if (evaluateValue(tokens, ctx).state === "opaque") return false;
  }
  return true;
}

// Commas separate scalar expressions; malformed or opaque array elements remain opaque.
function literalArgumentList(tokens: readonly PsToken[], ctx: Context): string | null {
  const parts: PsToken[][] = [[]];
  for (const token of tokens) {
    ctx.budget.spend();
    if (token.kind === "word" && !token.quoted && token.text === ",") parts.push([]);
    else parts[parts.length - 1]!.push(token);
  }
  const values = parts.map((part) => literalCode(part, ctx));
  return values.every((value) => value !== null) ? values.join(" ") : null;
}

// A non-launcher is distinct from an unsupported launcher or script operand.
function embeddedCode(cmd: PsCommand, feeder: PsCommand | undefined, ctx: Context): EmbeddedCode {
  ctx.budget.spend();
  const code = (text: string | null): EmbeddedCode => text === null ? { state: "opaque" } : { state: "literal", text };
  const call = cmd.tokens[0];
  if (call?.kind === "word" && call.quoted && !hasMemberInvocation(cmd)) return { state: "none" };
  const target = cmd.tokens[1];
  if (call?.kind === "word" && (call.text === "&" || call.text === ".") && target?.kind === "group" && target.open === "{") {
    return cmd.tokens.length === 2 ? code(target.raw.slice(1, -1)) : { state: "opaque" };
  }
  if (call?.kind === "word" && (call.text === "&" || call.text === ".")
    && !(target?.kind === "group" && target.open === "{")) {
    const value = target === undefined ? undefined : evaluateValue([target], ctx);
    if (value?.state !== "known" || value.shape !== "scalar") return { state: "opaque" };
  }
  const { name, args } = headOf(cmd, ctx);
  // Complete associated-file binding and the known inert default actions are owned by fileExecutionSignal; no file content is treated as known code.
  if (name === "invoke-item") return { state: "none" };
  if (name !== undefined && POWERSHELL_COMMAND_POLICIES[name]?.native) return nativeCode(name, args, ctx);
  if (hasNativeLauncher(cmd, ctx)) return { state: "opaque" };
  if (name !== undefined && /[\\/]/.test(name)) return { state: "opaque" };
  if (name !== undefined && isPowerShell(name)) return code(shellCode(args, ctx));
  if (name === "invoke-expression") {
    const bound = bindArguments(args, POWERSHELL_COMMAND_POLICIES[name]!.parameters, ctx);
    if (bound.state === "opaque" || !knownAncillaryValues(bound, new Set(["command"]), ctx)) return { state: "opaque" };
    if (args.length) return code(literalCode(bound.named.get("command") ?? bound.positional, ctx));
    if (!feeder) return { state: "opaque" };
    const head = headOf(feeder);
    return code(literalCode(head.name === "write-output" ? head.args : feeder.tokens, ctx));
  }
  if (name === "start-process") {
    const expanded = expandSplats(args, ctx);
    if (expanded === null) return { state: "opaque" };
    const bound = bindArguments(expanded, POWERSHELL_COMMAND_POLICIES[name]!.parameters, ctx);
    if (bound.state === "opaque" || !knownAncillaryValues(bound, new Set(["filepath", "argumentlist"]), ctx)) return { state: "opaque" };
    const positional = [...bound.positional];
    const target = bound.named.get("filepath") ?? (positional[0] ? [positional.shift()!] : []);
    const path = literalCode(target, ctx);
    if (path === null) return { state: "opaque" };
    let childArgs = bound.named.get("argumentlist") ?? positional;
    const data = childArgs.filter((token): token is PsGroup => token.kind === "group" && token.open === "@(");
    if (childArgs.length === 1 && childArgs[0]?.kind === "group" && childArgs[0].open === "@(") {
      const body = childArgs[0].body;
      if (body.length !== 1 || body[0]!.stages.length !== 1) return { state: "opaque" };
      childArgs = body[0]!.stages[0]!.tokens;
    }
    // The launcher joins its argument list before the child parses it.
    const text = literalArgumentList(childArgs, ctx);
    if (!isPowerShell(path)) return text === null ? { state: "opaque" } : { state: "literal", text: `${path} ${text}`, native: path, data };
    const child = text === null ? null : lex(`${path} ${text}`, ctx.budget).pipelines;
    const command = child?.length === 1 && child[0]!.stages.length === 1 ? child[0]!.stages[0] : undefined;
    return code(command ? shellCode(headOf(command).args, ctx, true) : null);
  }
  if (name === "new-scheduledtaskaction") {
    const expanded = expandSplats(args, ctx);
    const bound = expanded === null ? undefined : bindArguments(expanded, POWERSHELL_COMMAND_POLICIES[name]!.parameters, ctx);
    if (bound?.state !== "known" || bound.positional.length || !knownAncillaryValues(bound, new Set(["execute", "argument"]), ctx)) return { state: "opaque" };
    const target = literalCode(bound.named.get("execute") ?? [], ctx);
    const argument = bound.named.has("argument") ? literalCode(bound.named.get("argument")!, ctx) : "";
    return code(target && argument !== null ? `${target} ${argument}` : null);
  }
  if (name === "start-job" || name === "start-threadjob" || name === "invoke-command") {
    const expanded = expandSplats(args, ctx);
    const bound = expanded === null ? undefined : bindArguments(expanded, POWERSHELL_COMMAND_POLICIES[name]!.parameters, ctx);
    if (bound?.state !== "known" || bound.named.has("filepath") || bound.named.has("argumentlist")
      || !knownAncillaryValues(bound, new Set(["scriptblock"]), ctx)) return { state: "opaque" };
    const tokens = bound.named.get("scriptblock") ?? bound.positional;
    return code(tokens.length === 1 && tokens[0]?.kind === "group" && tokens[0].open === "{" ? tokens[0].raw.slice(1, -1) : null);
  }
  for (let index = 0; index < cmd.tokens.length; index += 1) {
    const token = cmd.tokens[index]!;
    if (token.kind === "word" && !token.quoted && /\[(?:system\.management\.automation\.)?scriptblock\]::create$/i.test(token.text)) {
      const body = cmd.tokens[index + 1];
      const suffix = cmd.tokens.slice(index + 2);
      const invocation = suffix.length === 2 && suffix[0]?.kind === "word" && !suffix[0].quoted && /^\.invoke$/i.test(suffix[0].text)
        && suffix[1]?.kind === "group" && suffix[1].open === "(" && suffix[1].body.length === 0;
      if (index !== 0 || (suffix.length !== 0 && !invocation)) return { state: "opaque" };
      return code(body?.kind === "group" && body.body.length === 1 && body.body[0]!.stages.length === 1
        ? literalCode(body.body[0]!.stages[0]!.tokens, ctx) : null);
    }
  }
  if (hasMemberInvocation(cmd) || cmd.tokens.some((token) => token.kind === "word" && !token.quoted
    && /\[(?:system\.management\.automation\.)?scriptblock\]/i.test(token.text))) return { state: "opaque" };
  if (name !== undefined && POWERSHELL_COMMAND_POLICIES[name]?.effects.includes("launcher")) return { state: "opaque" };
  return { state: "none" };
}

// Path normalization

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

// PowerShell path spellings in bash-scan form: backtick escapes dropped, `$env:USERPROFILE` / `${env:HOME}` / `$HOME` / `[Environment]::GetFolderPath('UserProfile')` expanded, provider prefixes removed and `\` turned into `/`.
function normalizePaths(text: string): string {
  return text
    .replace(/`(.)/gs, "$1")
    .replace(/\$\{env:([\w()]+)\}|\$env:(\w+)/gi, (_match, braced: string | undefined, plain: string | undefined) => envValue(braced ?? plain!))
    .replace(/\$\{home\}|\$home\b/gi, homedir())
    .replace(/\[(?:system\.)?environment\]::getfolderpath\(\s*['"]?(?:\[[^\]]*\]::)?userprofile['"]?\s*\)/gi, homedir())
    .replace(/(?:microsoft\.powershell\.core\\)?filesystem::/gi, "")
    .replace(/\\/g, "/");
}

// Components beneath an explicit or working-directory-relative profile anchor.
function homeSegments(text: string, cwd: string | undefined): string[] | undefined {
  const path = posix.normalize(normalizePaths(text));
  const normalized = normalizePaths(expandLeadingTilde(path));
  const home = normalizePaths(homedir()).replace(/\/$/, "");
  if (normalized.toLowerCase() === home.toLowerCase()) return [];
  if (normalized.toLowerCase().startsWith(`${home.toLowerCase()}/`)) return normalized.slice(home.length + 1).split("/");
  const profile = /^[a-z]:\/users\/[^/]+(?:\/|$)/i.exec(normalized);
  if (profile) return normalized.slice(profile[0].length).split("/").filter(Boolean);
  if (cwd && !/^(?:\/|[a-z]:|~)/i.test(normalized)) return homeSegments(`${normalizePaths(cwd)}/${normalized}`, undefined);
  return undefined;
}

// Short components and opaque suffixes are compared against the canonical table.
function sensitiveValue(value: PsValue, ctx: Context): string | null {
  const { cwd } = ctx;
  ctx.budget.spend(1, value.text.length);
  const normalized = normalizePaths(value.text);
  const direct = sensitivePathInArgumentText(normalized, cwd, (steps, chars) => ctx.budget.spend(steps, chars));
  if (direct) return direct;
  const opaque = value.computed && normalized.includes(DYNAMIC);
  if (!opaque && !/~\d/.test(normalized)) return null;
  const prefix = opaque ? normalized.slice(0, normalized.indexOf(DYNAMIC)) : normalized;
  const segments = homeSegments(prefix.replace(/\/$/, ""), cwd);
  if (!segments || segments.length === 0) return null;
  for (const row of SENSITIVE_PATH_ENTRIES) {
    ctx.budget.spend(row.segments.length + 1);
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
  for (const pipeline of allPipelines(pipelines, ctx.budget)) for (const stage of pipeline.stages) {
    const credential = credentialCommandSignal(stage, ctx);
    if (credential) return credential;
    const { name, args } = headOf(stage, ctx);
    const values = [evaluateValue(stage.tokens, ctx), ...stage.tokens.map((token) => evaluateValue([token], ctx))];
    // Argument-mode switches can contain attached file values even though they are not scalar expressions. Use the same candidate scan as other paths.
    if (name !== undefined && (!POWERSHELL_COMMAND_POLICIES[name] || POWERSHELL_COMMAND_POLICIES[name]?.native)) {
      const native = nativeInvocation(name, args, ctx);
      for (const text of native.values) if (text !== undefined) values.push(valueOf(text, false, ctx));
      const delimiter = native.values.indexOf("--");
      if (native.values.slice(0, delimiter === -1 ? undefined : delimiter).includes("--env-file")) values.push(valueOf(".env", false, ctx));
    }
    for (const value of values) {
      const hit = sensitiveValue(value, ctx);
      if (hit) return `sensitive path argument (${hit})`;
    }
  }
  return null;
}

// Signals

function lex(command: string, budget: PowerShellAnalysisBudget): { pipelines: PsPipeline[] | null; reason?: string; readable?: PsCommand[] } {
  const lexer = new Lexer(command, budget);
  try {
    return { pipelines: lexer.parseProgram() };
  } catch (error) {
    if (error instanceof PsUnreadable) return { pipelines: null, reason: error.message, readable: lexer.readable };
    throw error;
  }
}

// The sensitive-path floor shares the bounded analysis used for exfiltration.
export function powerShellSensitivePathSignal(input: ShellCommandInput, cwd?: string): string | null {
  return inspectPowerShellCommand(input, cwd).sensitive;
}

// The credential-exfiltration floor for a PowerShell command, or `null`.
export function powerShellExfiltrationSignal(input: ShellCommandInput, cwd?: string): string | null {
  return inspectPowerShellCommand(input, cwd).exfiltration;
}

interface FloorSignals {
  sensitive: string | null;
  exfiltration: string | null;
  // Opaque parsing, bindings and execution ask after explicit rules and grants.
  ordinaryAsk?: string;
}

// A literal argument is code only when its parsed program reaches an effect.
interface FrameSignals extends FloorSignals {
  boundary: boolean;
}

function executableBoundary(pipelines: readonly PsPipeline[], ctx: Context): boolean {
  return ctx.launched || ctx.literalBoundary || allPipelines(pipelines, ctx.budget).some((pipeline) => pipeline.stages.some((stage) => {
    const { name, args } = headOf(stage, ctx);
    return (name !== undefined && (isNetworkCommand(name, args) || isPowerShell(name)
        || (POWERSHELL_COMMAND_POLICIES[name]?.effects.includes("launcher") && !knownNativeData(name, args, ctx))))
      || hasMemberInvocation(stage) || hasNativeLauncher(stage, ctx)
      || stage.tokens.some((token) => token.kind === "word" && !token.quoted && (DOTNET_NETWORK.test(token.text)
        || /\[(?:system\.management\.automation\.)?scriptblock\](?!::)/i.test(token.text)));
  }));
}

// Each possible sink must have a positively modeled command, binding and value.
function closedWorldSignal(pipelines: readonly PsPipeline[], ctx: Context, sensitive: boolean): string | null {
  if (ctx.vocabularyOpaque) return hiddenCode("opaque command vocabulary");
  const every = allPipelines(pipelines, ctx.budget);
  const effectBoundary = executableBoundary(pipelines, ctx) || sensitive || every.some((pipeline) => pipeline.stages.some((stage) => {
    const { name } = headOf(stage, ctx);
    return (name !== undefined && POWERSHELL_COMMAND_POLICIES[name]?.effects.includes("dispatch"))
      || stage.tokens.some((token) => token.kind === "group" && token.open === "{");
  }));
  for (const pipeline of every) for (const [index, stage] of pipeline.stages.entries()) {
    ctx.budget.spend();
    const effective = unwrapCommand(stage, ctx);
    const { name, args } = headOf(effective, ctx);
    if (name !== undefined && genericInterpreter(name)) {
      if (nativeArguments(args, ctx).some((value) => value === undefined)) return hiddenCode("opaque interpreter binding");
      continue;
    }
    const first = effective.tokens[0];
    const expression = first?.kind === "group" || (first?.kind === "word" && (first.quoted || /^[\[$@]/.test(first.text)));
    const blockCall = first?.kind === "word" && (first.text === "&" || first.text === ".") && stage.tokens[1]?.kind === "group" && stage.tokens[1].open === "{";
    if (blockCall) continue;
    // Data expressions are checked at the argument or assignment that consumes them.
    if (expression) {
      if (pipeline.key !== undefined && evaluateValue(stage.tokens, ctx, true).state === "known") continue;
      if (pipeline.container === "@(" && literalArgumentList(stage.tokens, ctx) !== null) continue;
      if (embeddedCode(effective, undefined, ctx).state === "literal") continue;
      const methodRead = effective.tokens.some((token) => token.kind === "word" && !token.quoted && DOTNET_READER.test(token.text));
      if (methodRead || hasMemberInvocation(effective) || (effectBoundary && !ctx.memberReads.has(stage)
        && evaluateValue(effective.tokens, ctx).state === "opaque")) return hiddenCode("opaque expression");
      continue;
    }
    const policy = name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[name];
    const reader = name !== undefined && isReaderCommand(name);
    const network = name !== undefined && isNetworkCommand(name, args);
    const launcher = name !== undefined && (isPowerShell(name) || policy?.effects.includes("launcher"));
    const dispatch = policy?.effects.includes("dispatch") ?? false;
    const splatted = args.some((token) => token.kind === "word" && !token.quoted && token.text.startsWith("@"));
    if (!policy && !reader && !network && !launcher && effectBoundary && !nativeCommandData(effective, ctx)) {
      return hiddenCode("unknown command");
    }
    if (launcher) continue; // Embedded-code inspection owns the launcher's complete binding.
    const strict = effectBoundary || reader || network || splatted || (policy?.effects.includes("file-write") ?? false);
    const expanded = expandSplats(args, ctx);
    if (expanded === null) return hiddenCode("opaque splat");
    if (dispatch) {
      const signal = dispatchSignal(name!, expanded, pipeline.stages[index - 1], ctx);
      if (signal) return signal;
    }
    // The language loop is parsed as a program, including every nested command.
    if (first?.kind === "word" && first.text.toLowerCase() === "foreach" && args[0]?.kind === "group" && args[0].open === "(") continue;
    const bound = policy ? bindArguments(expanded, policy.parameters, ctx) : { state: "opaque" as const, named: new Map<string, PsToken[]>(), positional: expanded };
    // Native flags are argv data. Execution options and file-sourced arguments retain the separate launcher and sender checks above.
    if (nativeCommandData(effective, ctx, expanded)) continue;
    if (bound.state === "opaque" && strict) return hiddenCode("opaque parameter binding");
    const contents = new Set(localContent(name, expanded, ctx, bound));
    if (HTTP_CMDLETS.has(name!) && (bound.named.has("uri") ? bound.positional.length !== 0 : bound.positional.length !== 1)) return hiddenCode("opaque request binding");
    const required = name === "get-secret" ? ["name"] : name === "get-storedcredential" ? ["target"] : ["path", "literalpath", "inputobject"];
    if (reader && name !== "get-childitem" && name !== "select-string" && name !== "format-hex"
      && bound.positional.length === 0 && !required.some((parameter) => bound.named.has(parameter))) return hiddenCode("missing read operand");
    for (const [parameter, tokens] of bound.named) {
      if (tokens.length === 0) continue;
      if (tokens.every((token) => contents.has(token))) continue;
      if (dispatch && SCRIPT_BLOCK_RUNNERS.has(name!) && ["process", "begin", "end", "remainingscripts", "parallel", "filterscript"].includes(parameter)) continue;
      const value = evaluateValue(tokens, ctx, parameter === "headers");
      if (strict && (value.state === "opaque" || (value.shape === "hashtable" && !["headers", "body", "form"].includes(parameter))
        || (parameter === "headers" && value.shape !== "hashtable"))) return hiddenCode(value.reason ?? "opaque parameter value");
      if (strict && ["path", "literalpath"].includes(parameter) && providerPath(value, ctx).state === "opaque") return hiddenCode("opaque path provider");
    }
    for (const token of bound.positional) {
      if (contents.has(token)) continue;
      if (token.kind === "group" && token.open === "{" && SCRIPT_BLOCK_RUNNERS.has(name!)) continue;
      const value = evaluateValue([token], ctx);
      if (strict && (value.state === "opaque" || value.shape !== "scalar")) return hiddenCode(value.reason ?? "opaque argument value");
      if (reader && !["select-string", "get-secret", "get-storedcredential"].includes(name!) && providerPath(value, ctx).state === "opaque") return hiddenCode("opaque path provider");
    }
  }
  return null;
}

// The command is size-checked before parsing or value analysis.
export function inspectPowerShellCommand(input: ShellCommandInput, cwd?: string): FloorSignals {
  return runInspection(input, cwd, new PowerShellAnalysisBudget());
}

function runInspection(input: ShellCommandInput, cwd: string | undefined, budget: PowerShellAnalysisBudget): FloorSignals {
  try {
    const { sensitive, exfiltration, ordinaryAsk } = inspectPowerShell(input, cwd, budget);
    return { sensitive, exfiltration, ...(ordinaryAsk ? { ordinaryAsk } : {}) };
  }
  catch (error) {
    if (error instanceof PowerShellBudgetError) {
      const command = typeof input === "string" ? input : input.command;
      return visibleFallback(command, cwd, "PowerShell hidden code (analysis budget exceeded)", budget);
    }
    throw error;
  }
}

export function _inspectPowerShellForTest(input: ShellCommandInput, cwd?: string, disabled: readonly PowerShellExpressionKind[] = []) {
  const budget = new PowerShellAnalysisBudget(new Set(disabled));
  const signals = runInspection(input, cwd, budget);
  return { ...signals, steps: budget.steps, chars: budget.chars, exhausted: budget.exhausted, limits: POWERSHELL_ANALYSIS_LIMITS };
}

function inspectPowerShell(input: ShellCommandInput, cwd: string | undefined, budget: PowerShellAnalysisBudget, launched = false, probe = false, files = new PowerShellFileProvenance(budget, cwd), pathData = false): FrameSignals {
  const command = typeof input === "string" ? input : input.command;
  budget.enter(command);
  try { return inspectFrame(command, cwd, budget, launched, probe, files, pathData); } finally { budget.leave(); }
}

// Every literal argument is probed independently of the receiving command's policy.
function inspectArgumentCode(stage: PsCommand, ctx: Context, scanned: string | undefined, handled: ReadonlySet<PsToken>): FloorSignals {
  let sensitive: string | null = null;
  let exfiltration: string | null = null;
  const seen = new Set<string>();
  const { name, args } = headOf(stage, ctx);
  const contents = new Set(localContent(name, args, ctx));
  let candidates = args.filter((token) => !handled.has(token) && !contents.has(token) && (token.kind === "word" ? token.quoted : token.open !== "{" && token.open !== "@{")).map((token) => [token]);
  const first = stage.tokens[0];
  if (name === undefined && stage.tokens.length > 1 && (first?.kind === "group" || first?.quoted)) {
    const expression = evaluateValue(stage.tokens, ctx);
    // Resolved fragments are data within one value, not independent commands. Opaque expressions retain their literal pieces and their complete value.
    if (expression.state === "known" && expression.shape === "scalar") candidates = [stage.tokens];
    else candidates.push(stage.tokens);
  }
  for (const tokens of candidates) {
    ctx.budget.spend();
    const value = evaluateValue(tokens, ctx);
    // Literal fragments keep their effects even when interpolation is opaque. An unknown receiver cannot establish a data role for a computed argument.
    if (value.state === "opaque" && name !== undefined && !POWERSHELL_COMMAND_POLICIES[name]
      && !hasMemberInvocation(stage) && tokens.some((token) => token.kind === "group")) {
      ctx.literalBoundary = true;
      ordinarySignal(ctx, "PowerShell hidden code (opaque command argument)");
    }
    if (value.shape !== "scalar" || value.text === scanned || seen.has(value.text)) continue;
    seen.add(value.text);
    const nested = inspectPowerShell(value.text, ctx.cwd, ctx.budget, false, true, ctx.files.fork(), ctx.pathData.has(normalizePaths(value.text)));
    const visibleUpload = UNREADABLE_FALLBACK.test(normalizeDashes(value.text));
    if (!nested.boundary && !visibleUpload) continue;
    ctx.literalBoundary = true;
    sensitive ??= nested.sensitive;
    exfiltration ??= nested.exfiltration ?? (visibleUpload ? "PowerShell file upload (literal command text)" : null);
    if (nested.ordinaryAsk) ordinarySignal(ctx, nested.ordinaryAsk);
  }
  return { sensitive, exfiltration };
}

// Preserve visible credentials and uploads when structural analysis is opaque.
function visibleFallback(command: string, cwd: string | undefined, ordinaryAsk: string, budget: PowerShellAnalysisBudget): FloorSignals {
  const width = Math.min(POWERSHELL_ANALYSIS_LIMITS.inputChars, Math.floor((POWERSHELL_ANALYSIS_LIMITS.chars - budget.chars) / 4));
  const windows = width === 0 ? [] : command.length > width ? [command.slice(0, width), command.slice(-width)] : [command];
  let sensitive: string | null = null;
  let exfiltration: string | null = null;
  for (const text of windows) {
    try {
      budget.spend(1, text.length);
      if (UNREADABLE_FALLBACK.test(normalizeDashes(text))) exfiltration ??= "PowerShell file upload (unparsed)";
      if (UNREADABLE_TRANSPORT_SPLAT.test(text)) exfiltration ??= "PowerShell transport parameters splatted from an unreadable input";
      exfiltration ??= shellExfiltrationSignal(text, cwd);
    } catch (error) {
      if (!(error instanceof PowerShellBudgetError)) throw error;
      break;
    }
  }
  for (const text of windows) {
    try {
      budget.spend(1, text.length);
      const path = sensitivePathInArgumentText(normalizePaths(text), cwd, (steps, chars) => budget.spend(steps, chars));
      if (path) sensitive ??= `sensitive path argument (${path})`;
    } catch (error) {
      if (!(error instanceof PowerShellBudgetError)) throw error;
      break;
    }
  }
  return { sensitive, exfiltration, ordinaryAsk };
}

function inspectFrame(command: string, cwd: string | undefined, budget: PowerShellAnalysisBudget, launched: boolean, probe: boolean, files: PowerShellFileProvenance, pathData: boolean): FrameSignals {
  const { pipelines, reason, readable } = lex(command, budget);
  const ctx: Context = { cwd, tainted: new Set(), splats: new Map(), values: new Map(), vocabularyOpaque: false, scopeOpaque: false, launched, literalBoundary: false, files, pathData: new Set(), memberReads: new Set(), ordinary: {}, budget };
  let sensitive: string | null = null;
  const networkText = DOTNET_NETWORK.test(command);
  if (pipelines === null) {
    // A malformed data string has no parsed executable form. Code-looking strings retain an opaque boundary even when their dialect cannot be parsed here.
    budget.spend(1, command.length * 3);
    const hint = normalizeDashes(command).replace(/`\r?\n/g, "").replace(/`(.)/gs, "$1").replace(/["']/g, "");
    const first = hint.trim().split(/\s+/, 1)[0]!;
    const boundary = !probe || ARGUMENT_CODE_HINT.test(hint) || (!pathData && (files.executionTarget(first) !== undefined || files.fileType(first) === "opaque"));
    if (!boundary) return { sensitive: null, exfiltration: null, boundary: false };
    const signals = visibleFallback(command, cwd, `PowerShell hidden code (unparsed): ${reason}`, budget);
    for (const stage of readable ?? []) {
      signals.sensitive ??= credentialCommandSignal(stage, ctx);
      signals.exfiltration ??= senderSignal(stage, false, ctx);
    }
    return { ...signals, boundary };
  }
  collectSplats(pipelines, ctx);
  collectValues(pipelines, ctx);
  invalidateVariableMutations(pipelines, ctx);
  collectTainted(pipelines, ctx);
  let exfiltration: string | null = null;
  try {
    sensitive ??= sensitiveValues(pipelines, ctx);
    exfiltration = walk(pipelines, ctx, networkText);
    // Code-as-data can target a native shell even when a spelling is also a cmdlet alias. Slash options cannot inherit that cmdlet's positional binding.
    if (probe && allPipelines(pipelines, ctx.budget).some((pipeline) => pipeline.stages.some((stage) => {
      const { name, args } = headOf(stage, ctx);
      return name !== undefined && POWERSHELL_COMMAND_POLICIES[name]?.effects.includes("file-write")
        && args.some((token) => token.kind === "word" && !token.quoted && /^\/[a-z-]+(?::.*)?$/i.test(token.text));
    }))) ordinarySignal(ctx, "PowerShell hidden code (opaque native output binding)");
    const incomingBoundary = sensitive !== null || exfiltration !== null || executableBoundary(pipelines, ctx);
    const candidate = incomingBoundary || allPipelines(pipelines, ctx.budget).some((pipeline) => pipeline.stages.some((stage) => {
      const { name } = headOf(stage, ctx);
      const policy = name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[name];
      return (name !== undefined && isReaderCommand(name)) || policy?.effects.includes("dispatch");
    }));
    const nativeData = new Set<PsCommand>();
    for (const pipeline of allPipelines(pipelines, budget)) for (const stage of pipeline.stages) {
      const { name } = headOf(stage, ctx);
      if (name === undefined || !POWERSHELL_COMMAND_POLICIES[name]?.executable) continue;
      const code = embeddedCode(stage, undefined, ctx);
      if (code.state !== "literal" || !code.native) continue;
      const view = nativeTextView(code.text, code.native, ctx);
      if (!genericInterpreter(canonicalName(code.native)) && (!view || !genericInvocation(view, ctx))) continue;
      for (const group of code.data ?? []) for (const body of allPipelines(group.body, budget)) {
        for (const data of body.stages) nativeData.add(data);
      }
    }
    let argumentExfiltration: string | null = null;
    for (const { stage, feeder, mutatingBlocks } of executionStages(pipelines, budget, ctx.files)) {
      if (nativeData.has(stage)) continue;
      const materialize = materializationPlan(stage, ctx);
      const effective = unwrapCommand(stage, ctx);
      const fileSignal = fileExecutionSignal(effective, feeder, ctx, probe, pathData);
      if (fileSignal) ordinarySignal(ctx, fileSignal);
      const { name, args } = headOf(stage, ctx);
      if (name !== undefined) {
        const native = nativeInvocation(name, args, ctx);
        if (native.ordinaryAsk) ordinarySignal(ctx, native.ordinaryAsk);
        const catalogue = ctx.files.executionTarget(name)?.catalogue;
        if (catalogue) {
          const signal = senderSignal({ tokens: [word(catalogue, catalogue, false, []), ...args] }, feeder !== undefined, ctx);
          exfiltration ??= signal;
        }
      }
      if (name !== undefined && POWERSHELL_COMMAND_POLICIES[name]?.effects.includes("dispatch")) {
        // Repeated dispatch can execute an earlier command after this body's writes. Literal destinations saturate in one pass; opaque destinations taint all.
        for (const block of mutatingBlocks) {
          const repeated = inspectPowerShell(block.raw.slice(1, -1), cwd, budget, true, false, ctx.files);
          sensitive ??= repeated.sensitive;
          exfiltration ??= repeated.exfiltration;
          if (repeated.ordinaryAsk) ordinarySignal(ctx, repeated.ordinaryAsk);
        }
      }
      let scanned: string | undefined;
      let nativePayload = false;
      const handled = new Set<PsToken>();
      const interpreted = genericArgumentSignals(effective, ctx, handled);
      const generic = interpreted.generic;
      sensitive ??= interpreted.sensitive;
      exfiltration ??= interpreted.exfiltration;
      if (!generic && (!probe || candidate || fileSignal !== null)) {
        const code = embeddedCode(effective, feeder, ctx);
        if (code.state === "opaque") {
          const reason = stage.tokens.map((token) => evaluateValue([token], ctx)).find((value) => value.reason)?.reason ?? "runtime script";
          ordinarySignal(ctx, `PowerShell hidden code (${reason})`);
        } else if (code.state === "literal") {
          scanned = code.text;
          const nested = code.native ? nativeTextSignals(code.text, code.native, ctx) : inspectPowerShell(code.text, cwd, budget, true, false, ctx.files);
          nativePayload = "generic" in nested && nested.generic;
          sensitive ??= nested.sensitive;
          exfiltration ??= nested.exfiltration;
          if (nested.ordinaryAsk) ordinarySignal(ctx, nested.ordinaryAsk);
          if (code.opaque) ordinarySignal(ctx, "PowerShell hidden code (opaque native command grammar)");
        }
      }
      const argumentsCode = nativePayload ? { sensitive: null, exfiltration: null } : inspectArgumentCode(stage, ctx, scanned, handled);
      sensitive ??= argumentsCode.sensitive;
      argumentExfiltration ??= argumentsCode.exfiltration;
      materialize?.();
      const first = stage.tokens[0];
      if (name !== undefined && (!POWERSHELL_COMMAND_POLICIES[name] || POWERSHELL_COMMAND_POLICIES[name]?.native) && !isPowerShell(name)
        && first?.kind === "word" && !first.quoted && !/^[\[$@]/.test(first.text)) ctx.files.observeOpaqueEffects();
    }
    exfiltration ??= argumentExfiltration;
    const boundary = candidate || sensitive !== null || exfiltration !== null || ctx.literalBoundary;
    if (probe && !candidate && !boundary) return { sensitive: null, exfiltration: null, boundary: false };
    const opaque = closedWorldSignal(pipelines, ctx, sensitive !== null);
    if (opaque) ordinarySignal(ctx, opaque);
    if (sensitive && !exfiltration) {
      const detail = sensitive.replace(/^sensitive path argument/, "sensitive path");
      if (networkText || hasNetwork(pipelines, ctx)) exfiltration = `${detail} with a network transport`;
      else if (HIDDEN_CODE.test(normalizeDashes(command))) exfiltration = `${detail} with hidden code`;
    }
    const ordinaryAsk = ctx.ordinary.reason;
    return { sensitive, exfiltration, ...(ordinaryAsk ? { ordinaryAsk } : {}), boundary: boundary || sensitive !== null || exfiltration !== null };
  } catch (error) {
    // Later analysis cannot erase a credential or transport floor already established.
    if (!(error instanceof PowerShellBudgetError) || (sensitive === null && exfiltration === null)) throw error;
    return { sensitive, exfiltration, ordinaryAsk: "PowerShell hidden code (analysis budget exceeded)", boundary: true };
  }
}
