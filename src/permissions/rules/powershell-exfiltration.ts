import { effectiveShellWords } from "../../shared/shell-effective-command.js";
import { literalWord } from "../../shared/shell-analysis.js";
import { literalShellBodies, literalShellFlow, recordLiteralShellFlow, type LiteralShellArgument, type LiteralBodyBudget } from "../../shared/shell-literal-bodies.js";
// One bounded parse supplies both exact raw identity and a single static floor pass.
// Runtime values, generated code, callbacks and file mutation are never simulated.
import {
  canonicalPowerShellName,
  POWERSHELL_COMMAND_POLICIES,
  POWERSHELL_ANALYSIS_LIMITS,
  PowerShellAnalysisContext,
  PowerShellStructuralLimitError,
} from "./powershell-command-policy.js";
import { literalRuleWord } from "./rule-specifier.js";
import { MAX_LITERAL_COMMAND_LENGTH } from "./shell-prefix-values.js";
import { type ShellCommandInput } from "./shell-prefix-policy.js";
import { encodedPowerShellExecutionReason } from "./powershell-encoded-command.js";
import { inspectPosixShellCommand, inspectLiteralShellArgvFacts, literalNativeBoundary, sensitivePathInArgumentText, sensitivePathInLiteralArgumentText } from "./shell-exfiltration.js";
import type { VerifiedArgvResolver } from "./verified-argv-authority.js";
import { proveStaticArgv, type StaticArgvProof } from "./shell-argument-grammar.js";
import { shellFloorBudgetSignals, type ShellFloorSignals, ShellFloorContext } from "./shell-floor-policy.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";
import { isPowerShellStartupPinned, POWERSHELL_STARTUP_UNPROVEN_REASON } from "../../shared/powershell-startup-policy.js";
import {
  classifyPowerShellArchiveTraversal,
  isDefinitePowerShellRecursion,
  mayCarryNativeRecursionSwitch,
  isPowerShellRecursionParameter,
  type PowerShellTraversalArgument,
  type PowerShellTraversalValue,
} from "../../shared/powershell-recursive-traversal.js";

import { createPermissionPathEvidence, type PermissionPathEvidence } from "../sensitive-paths.js";
import { modelShellPath } from "../../shared/shell-native-path.js";
import { resolveShellFilesystemPath } from "../../shared/shell-filesystem-path.js";
import { inspectImplicitGitWriteTargets, inspectPosixShellPermissionPaths, inspectUnknownNativeWriteArguments, inspectUnknownNativeWriteLocation } from "../../tools/shell-path-policy.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { homedir } from "node:os";

class SharedPowerShellContext extends PowerShellAnalysisContext {
  readonly floor = new ShellFloorContext("powershell");
}

function sharedWork(context: PowerShellAnalysisContext): ShellFloorContext {
  if (!(context instanceof SharedPowerShellContext)) throw new Error("Missing shell analysis context");
  return context.floor;
}

const VISIBLE_SENDER = /\s*(?:[\w.]+\\)?(?:iwr|irm|invoke-webrequest|invoke-restmethod)(?=\s)/iy;

// A sender at a statement or pipeline-stage start of the direct program, optionally module-qualified. Text in quotes or
// nested bodies is not simulated here; inspectParsed binds a nested body's literal -InFile operand.
function directVisibleSender(visible: string): boolean {
  let depth = 0, quote: string | null = null, start = true;
  for (let index = 0; index < visible.length; index += 1) {
    const char = visible[index]!;
    if (quote !== null) {
      if (char === "`" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (start && depth === 0) {
      VISIBLE_SENDER.lastIndex = index;
      if (VISIBLE_SENDER.test(visible)) return true;
    }
    start = false;
    if (char === "`") index += 1;
    else if (char === "'" || char === '"') quote = char;
    else if (char === "{" || char === "(") depth += 1;
    else if (char === "}" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" || char === "|" || char === "\n" || char === "\r") start = true;
  }
  return false;
}

// Publish visible upload evidence before syntax or structural refusal can discard a frame.
// This adds a floor only; it never proves a computed command's launch identity.
function retainVisibleUpload(command: string, context: PowerShellAnalysisContext): void {
  const visible = normalizeDashes(command.slice(0, POWERSHELL_ANALYSIS_LIMITS.inputChars));
  let sender = directVisibleSender(visible);
  // Literal fragments can identify a sender for a floor without proving its launch.
  for (const expression of visible.matchAll(/&\s*\((\s*(?:'[^']*'|"[^"$`]*")\s*(?:\+\s*(?:'[^']*'|"[^"$`]*")\s*)*)\)/g)) {
    const name = [...expression[1]!.matchAll(/'([^']*)'|"([^"$`]*)"/g)].map(part => part[1] ?? part[2]).join("");
    sender ||= HTTP_CMDLETS.has(canonicalName(name));
  }
  // PowerShell binds any prefix of -InFile on these cmdlets (common -Information* lose), even -I.
  if (sender && /(?:^|[\s"'])-i(?:n(?:f(?:i(?:le?)?)?)?)?(?::|\s)/i.test(visible) && /https?:\/\//i.test(visible)) {
    sharedWork(context).retained.exfiltration ??= "PowerShell upload of a file (visible -InFile)";
  }
}

// Lexer

interface PsWord {
  kind: "word";
  // Source text of the token.
  raw: string;
  // Dequoted text (quotes and backtick escapes removed).
  text: string;
  quoted: boolean;
  // Adjacent bare/quoted fragments are retained for floor inspection, but their argv identity is not modeled.
  adjacent?: true;
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

interface PsRedirection {
  target: PsToken;
  commandTokens: readonly PsToken[];
}

interface PsPipeline {
  stages: PsCommand[];
  // Lower-cased variable names this pipeline's output is assigned to.
  assign: string[];
  compound: boolean;
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
  private grammarRecords = 0;
  // Complete command tokens remain usable for positive effects after refusal.
  readonly readable: PsCommand[] = [];
  private rootPartial: PsToken[] = [];
  constructor(private readonly source: string, private readonly analysis: PowerShellAnalysisContext) {}

  parseProgram(): PsPipeline[] {
    // Alternate quote delimiters are outside this lexer's supported grammar.
    if (/[\u2018-\u201e]/.test(this.source)) this.analysis.facts.set("unproven-quote-delimiter", true);
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
    const chargeToken = (token: PsToken): void => {
      const records = originalRecordCount(token, this.analysis);
      this.grammarRecords += records;
      this.analysis.visits.grammarRecords += records;
      if (this.grammarRecords > MAX_SHELL_ANALYSIS_TOKENS) throw new PowerShellStructuralLimitError("PowerShell total token limit exceeded");
    };
    const pushToken = (token: PsToken): void => {
      chargeToken(token);
      tokens.push(token);
      if (this.depth === 1) this.rootPartial = tokens;
    };
    const endCommand = (): void => {
      if (tokens.length > 0) { stages.push({ tokens }); this.readable.push({ tokens }); }
      tokens = [];
      if (this.depth === 1) this.rootPartial = [];
    };
    const endPipeline = (): void => {
      endCommand();
      if (stages.length > 0) pipelines.push(toPipeline(stages, this.analysis));
      stages = [];
    };
    const src = this.source;
    while (this.index < src.length) {

      const char = src[this.index]!;
      const next = src[this.index + 1];
      if (char === " " || char === "\t") { this.index += 1; continue; }
      if (char === ",") { pushToken(word(",", ",", false, [])); this.index += 1; continue; }
      if (char === "`" && (next === "\n" || next === "\r")) { this.index += next === "\r" && src[this.index + 2] === "\n" ? 3 : 2; continue; }
      if (char === "\n" || char === "\r" || char === ";") { endPipeline(); this.index += 1; continue; }
      if (char === "<" && next === "#") {
        this.analysis.facts.set("unproven-comment", true);
        const end = src.indexOf("#>", this.index + 2);
        if (end === -1) throw new PsUnreadable("unterminated comment");
        this.index = end + 2;
        continue;
      }
      if (char === "#") {
        this.analysis.facts.set("unproven-comment", true);
        while (this.index < src.length && src[this.index] !== "\n" && src[this.index] !== "\r") { this.index += 1; }
        continue;
      }
      if (char === ">") {
        this.analysis.facts.set("unproven-redirection", true);
        this.index += next === ">" ? 2 : 1;
        // Stream merges name another stream, not a filesystem target.
        if (src[this.index] === "&" && /^[1-6](?:$|[\s;|)}])/.test(src.slice(this.index + 1))) {
          this.index += 2;
          continue;
        }
        while (src[this.index] === " " || src[this.index] === "\t") this.index += 1;
        const targetStart = src[this.index];
        if (targetStart === undefined || /[\n\r;|&<>]/.test(targetStart)) throw new PsUnreadable("missing redirection target");
        const targetOpen = groupOpenAt(src, this.index);
        const target = targetOpen ? this.parseGroup(targetOpen) : targetStart === "'" ? this.parseSingleQuoted()
          : targetStart === '"' ? this.parseDoubleQuoted() : this.parseBareword();
        chargeToken(target);
        const redirects = this.analysis.facts.get("filesystem-redirections") as PsRedirection[] | undefined;
        if (redirects) redirects.push({ target, commandTokens: tokens });
        else this.analysis.facts.set("filesystem-redirections", [{ target, commandTokens: tokens }]);
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
          this.analysis.facts.set("unproven-background", true);
          endPipeline();
          this.index += 1;
          continue;
        }
        pushToken(word("&", "&", false, []));
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
        pushToken(this.parseGroup(open));
        continue;
      }
      if ((char === "@") && (next === "'" || next === "\"") && /^[ \t]*\r?\n/.test(src.slice(this.index + 2))) {
        pushToken(this.parseHereString(next));
        continue;
      }
      if (char === "'" || char === "\"") {
        // Argument-mode quote concatenation must not split one runtime path or command name into independently bound operands.
        const previous = src[this.index - 1];
        if (previous && !/[\s;|&(){},:=+<>]/.test(previous)) throw new PsUnreadable("unsupported adjacent string fragment");
        const token = char === "'" ? this.parseSingleQuoted() : this.parseDoubleQuoted();
        if (previous && /[:=+]/.test(previous)) token.adjacent = true;
        const following = src[this.index];
        if (following && !/[\s;|&(){},=+\-<>]/.test(following)) throw new PsUnreadable("unsupported adjacent string fragment");
        if (following && /[=+\-]/.test(following)) token.adjacent = true;
        pushToken(token);
        continue;
      }
      pushToken(this.parseBareword());
    }
    if (closer !== undefined) throw new PsUnreadable("unterminated group");
    endPipeline();
    this.depth -= 1;
    return pipelines;
  }

  partialCommand(): PsCommand | undefined {
    return this.rootPartial.length === 0 ? undefined : { tokens: [...this.rootPartial] };
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
      if (subexpressionBodies(text).length > 0) reason = "runtime here-string expansion";
      text = text.replace(/`(.)/gs, (raw, char: string) => {

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
      while (end < src.length && src[end] !== "\n") {  end += 1; }
      const raw = src.slice(this.index, end);
      this.index = end;
      return word(raw, raw, false, []);
    }
    while (this.index < src.length) {

      const char = src[this.index]!;
      if (char === "`") { text += this.readEscape(); continue; }
      if (char === "<") throw new PsUnreadable("unsupported redirection");
      if (char === ">") break;
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

function originalRecordCount(token: PsToken, analysis: PowerShellAnalysisContext): number {
  if (token.kind !== "word" || token.quoted) return 1;
  if (/^[+\-*/]?=$/.test(token.text)) return 0;
  const text = token.text;
  let cursor = 0;
  const visit = (): string | undefined => {
    analysis.visits.recordScanChars += 1;
    return text[cursor];
  };
  while (visit() === "[") {
    cursor += 1;
    while (cursor < text.length && visit() !== "]") cursor += 1;
    if (cursor >= text.length) return 1;
    cursor += 1;
  }
  if (visit() !== "$") return 1;
  cursor += 1;
  if (visit() === "{") {
    cursor += 1;
    const start = cursor;
    while (cursor < text.length && visit() !== "}") cursor += 1;
    if (cursor === start || cursor >= text.length) return 1;
    cursor += 1;
  } else {
    const start = cursor;
    while (cursor < text.length && /[\w:?]/.test(visit()!)) cursor += 1;
    if (cursor === start) return 1;
  }
  let assignments = 0;
  let lastEquals = -1;
  for (let index = cursor; index < text.length; index += 1) {
    analysis.visits.recordScanChars += 1;
    if (text[index] !== "=") continue;
    assignments += 1;
    lastEquals = index;
  }
  if (assignments === 0) return 1;
  return assignments + Number(lastEquals + 1 < text.length);
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
function subexpressionBodies(text: string): string[] {
  const bodies: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "`") { index += 1; continue; }
    if (text[index] !== "$" || text[index + 1] !== "(") continue;
    const start = index + 2;
    let depth = 1;
    for (index = start; index < text.length; index += 1) {
      if (text[index] === "(") {
        if (++depth > MAX_DEPTH) throw new PsUnreadable("nesting too deep");
      } else if (text[index] === ")" && --depth === 0) break;
    }
    if (depth !== 0) throw new PsUnreadable("unterminated subexpression");
    // The body lexer owns nested groups. Recording them again duplicates both
    // their analysis and their semantic word count.
    bodies.push(text.slice(start, index));
  }
  return bodies;
}

const VARIABLE = /^(?:\[[^\]]*\])*\$(?:\{([^}]+)\}|([\w:?]+))$/;

// Assignments are structural refusal markers. Their tokens stay untouched;
// no value is rewritten, evaluated or reparsed.
function toPipeline(stages: PsCommand[], _budget: PowerShellAnalysisContext): PsPipeline {
  const assign: string[] = [];
  let compound = false;
  let key: string | undefined;
  const first = stages[0]!;
  const head = first.tokens[0];
  const second = first.tokens[1];
  if (head?.kind === "word" && !head.quoted) {
    const inline = /^((?:\[[^\]]*\])*\$(?:\{[^}]+\}|[\w:]+))([+\-*/]?=)/.exec(head.text);
    const name = inline === null ? VARIABLE.exec(head.text) : VARIABLE.exec(inline[1]!);
    if (inline !== null && name !== null) {
      assign.push((name[1] ?? name[2]!).toLowerCase());
      compound = inline[2] !== "=";
    } else if (second?.kind === "word" && !second.quoted && /^[+\-*/]?=$/.test(second.text)) {
      if (name !== null) assign.push((name[1] ?? name[2]!).toLowerCase());
      else key = head.text;
      compound = second.text !== "=";
    } else if (/^[A-Za-z_][\w-]*=/.test(head.text)) key = head.text.slice(0, head.text.indexOf("="));
  }
  return { stages, assign, compound, ...(key === undefined ? {} : { key }) };
}

// Static command facts

const RUNTIME_EVALUATION_REASON = "Shell command requires runtime evaluation";
const HTTP_CMDLETS = new Set(["invoke-webrequest", "invoke-restmethod"]);
const literalWordValues = new WeakMap<PsWord, string | null>();

function literalWordValue(token: PsToken): string | undefined {
  if (token.kind !== "word") return undefined;
  const cached = literalWordValues.get(token);
  if (cached !== undefined) return cached ?? undefined;
  let value = token.nested.length === 0 && token.reason === undefined && !token.adjacent
    ? literalRuleWord(token.raw, "powershell") : undefined;
  // In argument mode an embedded `@` is ordinary text (`user@host`); only a
  // leading `@` can introduce splatting or a collection literal.
  if (value === undefined && !token.quoted && token.raw[0] !== "@" && token.raw.includes("@")
    && literalRuleWord(token.raw.replaceAll("@", "a"), "powershell") !== undefined) value = token.text;
  literalWordValues.set(token, value ?? null);
  return value;
}

function commandArgv(command: PsCommand): (string | null)[] | null {
  return command.tokens.length === 0 ? null : command.tokens.map((token) => literalWordValue(token) ?? null);
}

function ruleArgv(command: PsCommand): (string | null)[] | null {
  if (command.tokens[0]?.kind !== "word" || command.tokens[0].quoted) return null;
  const argv = command.tokens.map((token) => literalWordValue(token) === undefined ? null : token.raw);
  return argv.length === 0 || argv[0] === null || argv[0] === "." ? null : argv;
}

function canonicalName(text: string): string { return canonicalPowerShellName(text); }

interface StaticStage {
  command: PsCommand;
  argv: readonly (string | undefined)[];
  visible: readonly (string | undefined)[];
  raw: readonly string[];
  name: string | undefined;
  fedByPipeline: boolean;
  pipelineId: number;
  proof: StaticArgvProof;
}

/** A literal call target retains its effects without acquiring reusable argv proof. */
function permissionEffectStage(stage: StaticStage): StaticStage {
  const first = stage.command.tokens[0];
  if (first?.kind !== "word" || first.raw !== "&" || first.quoted || stage.argv[1] === undefined) return stage;
  return { ...stage, command: { tokens: stage.command.tokens.slice(1) }, argv: stage.argv.slice(1),
    visible: stage.visible.slice(1), raw: stage.raw.slice(1), name: canonicalName(stage.argv[1]),
    proof: stage.proof.kind === "literal-evaluation"
      ? { ...stage.proof, payloadIndexes: stage.proof.payloadIndexes.filter(index => index > 0).map(index => index - 1) }
      : stage.proof };
}

interface StaticProgram {
  stages: StaticStage[];
  /** An HTTP upload in a nested body; its stage is not part of the direct program. */
  nestedUpload: string | null;
  dynamic: boolean;
  literalEvaluation: StaticStage | null;
  encodedReason: string | null;
}

function optionName(text: string): string { return normalizeDashes(text).toLowerCase(); }

function staticProgram(pipelines: readonly PsPipeline[], analysis: PowerShellAnalysisContext): StaticProgram {
  const only = pipelines.length === 1 ? pipelines[0] : undefined;
  const verified = only !== undefined && only.stages.length === 1 && only.assign.length === 0
    && !only.compound && only.key === undefined && only.container === undefined
    && analysis.facts.get("unproven-comment") !== true
    ? analysis.facts.get("verified-argv-resolver") as VerifiedArgvResolver | undefined : undefined;
  const stages: StaticStage[] = [];
  // Comments may carry directives processed before the startup prelude.
  // They remain visible to the lexer, but never supply positive argv proof.
  let dynamic = analysis.facts.get("unproven-comment") === true || analysis.facts.get("unproven-background") === true;
  let maximumDepth = 1;
  let nestedUpload: string | null = null;
  // `inline`: every enclosing body is a control-statement body; `switchBody`: the pipelines are switch clauses.
  const pending: { pipeline: PsPipeline; depth: number; direct: boolean; inline: boolean; switchBody: boolean; pipelineId: number }[] = [];
  for (let index = pipelines.length - 1; index >= 0; index -= 1) {
    pending.push({ pipeline: pipelines[index]!, depth: 1, direct: true, inline: true, switchBody: false, pipelineId: index });
  }
  while (pending.length > 0) {
    const { pipeline, depth, direct, inline, switchBody, pipelineId } = pending.pop()!;
    maximumDepth = Math.max(maximumDepth, depth);
    analysis.visits.staticNodes += 1;
    if (pipeline.assign.length > 0 || pipeline.compound || pipeline.key !== undefined || pipeline.container !== undefined) dynamic = true;
    for (let stageIndex = 0; stageIndex < pipeline.stages.length; stageIndex += 1) {
      const command = pipeline.stages[stageIndex]!;
      analysis.visits.stages += 1;
      analysis.visits.staticNodes += 1;
      analysis.visits.staticTokens += command.tokens.length;
      const argv = command.tokens.map(literalWordValue);
      analysis.visits.staticArguments += Math.max(0, argv.length - 1);
      const statement = stageIndex === 0 ? controlStatement(command, switchBody) : undefined;
      for (const token of command.tokens) {
        // Nested/group spans include descendant source; charge only work actually
        // performed here so the counter cannot double-count overlapping ranges.
        analysis.visits.staticChars += token.kind === "word" && token.nested.length === 0 ? token.raw.length : 1;
        if (token.kind === "group") {
          dynamic = true;
          const body = statement !== undefined && token.open === "{";
          for (let index = token.body.length - 1; index >= 0; index -= 1) {
            pending.push({ pipeline: token.body[index]!, depth: depth + 1, direct: false, inline: inline && body,
              switchBody: body && statement === "switch", pipelineId });
          }
        } else if (token.nested.length > 0) {
          dynamic = true;
          for (let bodyIndex = token.nested.length - 1; bodyIndex >= 0; bodyIndex -= 1) {
            const body = token.nested[bodyIndex]!;
            for (let index = body.length - 1; index >= 0; index -= 1) {
              pending.push({ pipeline: body[index]!, depth: depth + 1, direct: false, inline: false, switchBody: false, pipelineId });
            }
          }
        }
      }
      if (argv.some((value) => value === undefined) || argv.length === 0) dynamic = true;
      if (!direct && inline && argv[0] !== undefined && HTTP_CMDLETS.has(canonicalName(argv[0])) && inFileValue(argv) !== undefined) {
        nestedUpload ??= `PowerShell upload sink (${canonicalName(argv[0])} -InFile)`;
      }
      if (direct && argv.length > 0) {
        if (ruleArgv(command) === null) dynamic = true;
        const raw = command.tokens.map((token) => token.raw);
        const stage: StaticStage = { command, argv, visible: command.tokens.map((token) => token.kind === "word" ? token.text : undefined), raw,
          name: argv[0] === undefined ? undefined : canonicalName(argv[0]), fedByPipeline: stageIndex > 0, pipelineId,
          proof: verified?.(argv, raw) ?? proveStaticArgv(argv, "powershell", raw, analysis.visits) };
        if (stage.proof.kind === "unproven") dynamic = true;
        stages.push(stage);
      }
    }
  }
  analysis.requireAdditionalFrameDepth(maximumDepth - 1);
  const literalEvaluation = !dynamic && stages.length === 1 && stages[0]!.proof.kind === "literal-evaluation" ? stages[0]! : null;
  if (stages.some((stage) => stage.proof.kind === "literal-evaluation")) dynamic = true;
  if (literalEvaluation !== null) dynamic = true;
  if (stages.length > 1 && stages.some((stage) => stage.proof.kind === "static-complete" && stage.proof.changesState)) dynamic = true;
  const encodedReason = encodedPowerShellExecutionReason(stages.flatMap((stage) => stage.argv), stages.flatMap((stage) => stage.raw));
  return { stages, nestedUpload, dynamic, literalEvaluation, encodedReason };
}

// Control statements run their `{}` bodies inline in the same scope. Script blocks and callbacks do not prove
// reusable argv; separately bound executable bodies may still contribute floor evidence.
const CONTROL_KEYWORDS = new Set(["if", "elseif", "else", "switch", "foreach", "for", "while", "do", "until", "try", "catch", "finally"]);

/** The control keyword heading this statement, `"clause"` for a switch clause, or undefined for any other command. */
function controlStatement(command: PsCommand, switchBody: boolean): string | undefined {
  if (switchBody) return "clause";
  const head = command.tokens[0];
  if (head?.kind !== "word" || head.quoted || head.nested.length > 0) return undefined;
  const keyword = head.text.toLowerCase();
  return CONTROL_KEYWORDS.has(keyword) ? keyword : undefined;
}

function parameterValue(argv: readonly (string | undefined)[], name: string): string | undefined {
  const expected = `-${name.toLowerCase()}`;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === undefined) continue;
    const value = optionName(argv[index]!);
    if (value === expected) return argv[index + 1];
    if (value.startsWith(`${expected}:`)) {
      const inline = argv[index]!.slice(argv[index]!.indexOf(":") + 1);
      return inline.length > 0 ? inline : argv[index + 1];
    }
  }
  return undefined;
}

// Invoke-WebRequest/Invoke-RestMethod bind every prefix of -InFile (-I through -InFile); ambiguity fails closed.
const IN_FILE_PREFIX = /^-i(?:n(?:f(?:i(?:le?)?)?)?)?(?::|$)/;
function inFileValue(argv: readonly (string | undefined)[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !IN_FILE_PREFIX.test(optionName(token))) continue;
    const separator = token.indexOf(":");
    return separator >= 0 && separator + 1 < token.length ? token.slice(separator + 1) : argv[index + 1];
  }
  return undefined;
}

function hasSwitch(argv: readonly (string | undefined)[], name: string): boolean {
  const expected = `-${name.toLowerCase()}`;
  return argv.slice(1).some((value) => value !== undefined && (optionName(value) === expected || optionName(value).startsWith(`${expected}:`)));
}

function positionalValues(stage: StaticStage): string[] {
  const policy = stage.name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[stage.name];
  const switches = new Set((policy?.parameters ?? []).filter((name) => name.endsWith("?")).map((name) => name.slice(0, -1).toLowerCase()));
  const parameters = new Set((policy?.parameters ?? []).map((name) => name.replace(/[?*]$/, "").toLowerCase()));
  const values: string[] = [];
  for (let index = 1; index < stage.visible.length; index += 1) {
    const value = stage.visible[index];
    if (value === undefined) continue;
    const option = optionName(value);
    if (option.startsWith("-") && parameters.has(option.slice(1).split(":", 1)[0]!)) {
      const name = option.slice(1).split(":", 1)[0]!;
      if (!switches.has(name) && !option.includes(":")) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

// Filesystem evidence resolves parameter prefixes before selecting positional paths.
// An ambiguous binding retains candidates and uncertainty instead of hiding later targets.
interface FilesystemArgumentBinding { value: string; dynamic: boolean }

function permissionArgumentBinding(token: PsToken | undefined, environment: Readonly<Record<string, string | undefined>>): FilesystemArgumentBinding | undefined {
  if (token === undefined) return undefined;
  if (token.kind === "word" && !token.raw.startsWith("'") && /[\u2018-\u201e]/.test(token.raw)) return { value: token.raw, dynamic: true };
  const literal = literalWordValue(token) ?? wildcardWordValue(token);
  if (literal !== undefined) return { value: literal, dynamic: false };
  if (token.kind !== "word" || token.nested.length > 0 || token.adjacent || token.reason !== undefined) return { value: token.raw, dynamic: true };
  const expression = /\$\{env:([A-Za-z_][A-Za-z0-9_()]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)(?=[\\/]|$)/gi;
  let cursor = 0, value = "", dynamic = false, matched = false;
  for (const match of token.text.matchAll(expression)) {
    matched = true;
    const before = token.text.slice(cursor, match.index);
    dynamic ||= before.includes("$");
    const name = match[1] ?? match[2]!;
    const key = process.platform === "win32" ? Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase()) : name;
    const replacement = key !== undefined && Object.hasOwn(environment, key) ? environment[key] : undefined;
    if (replacement === undefined || replacement.includes("\0")) dynamic = true;
    value += before + (replacement ?? match[0]);
    cursor = match.index! + match[0].length;
  }
  const tail = token.text.slice(cursor);
  dynamic ||= !matched || tail.includes("$");
  return { value: value + tail, dynamic };
}

function filesystemArgumentBindings(stage: StaticStage, environment: Readonly<Record<string, string | undefined>>): {
  named: Map<string, FilesystemArgumentBinding[]>;
  positional: FilesystemArgumentBinding[];
  unproven: boolean;
  ambiguous: boolean;
  splat: boolean;
} {
  const policy = stage.name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[stage.name];
  const parameters = (policy?.parameters ?? []).map((specification) => ({
    name: specification.replace(/[?*]$/, "").toLowerCase(),
    switch: specification.endsWith("?"),
  }));
  const named = new Map<string, FilesystemArgumentBinding[]>();
  const positional: FilesystemArgumentBinding[] = [];
  let unproven = false, ambiguous = false, splat = false;
  const bind = (index: number) => permissionArgumentBinding(stage.command.tokens[index], environment);
  for (let index = 1; index < stage.visible.length; index += 1) {
    const token = stage.command.tokens[index];
    splat ||= token?.kind === "word" && !token.quoted && /^@[A-Za-z_][A-Za-z0-9_]*$/.test(token.raw);
    const value = stage.visible[index];
    if (value === undefined) { unproven = true; const binding = bind(index); if (binding) positional.push(binding); continue; }
    const option = optionName(value);
    if (!option.startsWith("-") || /^["']/.test(stage.raw[index] ?? "")) {
      const binding = bind(index); if (binding) { positional.push(binding); unproven ||= binding.dynamic; }
      continue;
    }
    const spelling = option.slice(1).split(":", 1)[0]!;
    const exact = parameters.find((parameter) => parameter.name === spelling);
    const aliasesRecurse = stage.name === "get-childitem" && spelling === "s";
    const matches = exact ? [exact] : aliasesRecurse ? parameters.filter((parameter) => parameter.name === "recurse")
      : parameters.filter((parameter) => parameter.name.startsWith(spelling));
    const colon = value.indexOf(":");
    if (matches.length !== 1) {
      unproven = true;
      ambiguous = true;
      if (colon >= 0 && colon + 1 < value.length) positional.push({ value: value.slice(colon + 1), dynamic: true });
      continue;
    }
    const parameter = matches[0]!;
    if (parameter.switch) continue;
    const argument = colon >= 0 && colon + 1 < value.length
      ? permissionArgumentBinding(token?.kind === "word" ? { ...token, raw: token.raw.slice(token.raw.indexOf(":") + 1), text: value.slice(colon + 1) } : token, environment)
      : bind(++index);
    if (argument === undefined) { unproven = true; continue; }
    unproven ||= argument.dynamic;
    const values = named.get(parameter.name) ?? [];
    values.push(argument);
    named.set(parameter.name, values);
  }
  return { named, positional, unproven, ambiguous, splat };
}

function nativeCredentialStore(stage: StaticStage, work: ShellFloorContext): string | null {
  const boundary = literalNativeBoundary(stage.argv, work);
  for (let index = 0; index < stage.argv.length; index += 1) {
    if (!boundary.headIndexes.has(index)) continue;
    const name = stage.argv[index];
    if (name === undefined) continue;
    const credential = POWERSHELL_COMMAND_POLICIES[canonicalName(name)]?.credential;
    if (credential === true || credential instanceof RegExp && credential.test(stage.visible.slice(index).filter(value => value !== undefined).join(" "))) {
      return "Host credential store access";
    }
  }
  return null;
}

function isUncPath(text: string): boolean {
  const path = text.replace(/^[^:]+::/, "");
  return /^(?:\\\\|\/\/)(?:\?\\UNC\\)?[^\\/]+[\\/][^\\/]+/i.test(path);
}

function containsVisibleUncPath(text: string): boolean {
  const candidates = [text];
  const equals = text.indexOf("=");
  if (equals >= 0) candidates.push(text.slice(equals + 1));
  const optionValue = /^[-/][^:]*:(.*)$/s.exec(text)?.[1];
  if (optionValue !== undefined) candidates.push(optionValue);
  return candidates.some(isUncPath);
}

function visiblePowerShellExfiltration(stage: StaticStage, fedByPipeline: boolean, skipped: ReadonlySet<number>): string | null {
  const { name, argv } = stage;
  if (name === undefined) return null;
  const policy = POWERSHELL_COMMAND_POLICIES[name];
  const visibleArgs = stage.visible.map((value, index) => skipped.has(index) ? undefined : value);
  if (visibleArgs.slice(1).some((value) => value !== undefined && containsVisibleUncPath(value))) return "PowerShell visible UNC upload";
  const visibleText = normalizeDashes(visibleArgs.filter((value): value is string => value !== undefined).join(" "));
  if (policy?.sink?.test(visibleText)) return `${name} catalogued transfer`;
  const bare = name.replace(/\.exe$/, "");
  if (bare === "ftp" && visibleArgs.some((value) => value !== undefined && /^-s:/i.test(value))) return "ftp scripted file transfer";
  if (bare === "tftp" && visibleArgs.some((value) => value !== undefined && /^put$/i.test(value))) return "tftp file upload";
  if (HTTP_CMDLETS.has(name)) {
    if (inFileValue(argv) !== undefined) return `PowerShell upload sink (${name} -InFile)`;
    if (fedByPipeline && (parameterValue(argv, "body") !== undefined || parameterValue(argv, "method") !== undefined)) return `PowerShell upload sink (${name} pipeline)`;
  }
  if (name === "start-bitstransfer" && optionName(parameterValue(argv, "transfertype") ?? "") === "upload") return "PowerShell upload sink (start-bitstransfer)";
  if (name === "send-mailmessage" && parameterValue(argv, "attachments") !== undefined) return "PowerShell upload sink (send-mailmessage attachments)";
  if (name === "copy-item" && hasSwitch(argv, "tosession")) return "PowerShell upload sink (copy-item tosession)";
  if (policy?.destination?.kind === "mail") return `${name} output upload`;
  if (policy?.destination?.kind === "printer") return `${name} printer output upload`;
  if (policy?.destination !== undefined) {
    const named = policy.destination.parameters.map((parameter) => parameterValue(visibleArgs, parameter)).filter((value): value is string => value !== undefined);
    const positional = positionalValues({ ...stage, visible: visibleArgs });
    const destination = named.length > 0 ? named : policy.destination.position === undefined ? [] : [positional[policy.destination.position]];
    if (destination.some((value) => value !== undefined && isUncPath(value))) return `${name} UNC file upload`;
  }
  return null;
}

function visibleSensitive(stage: StaticStage, cwd: string | undefined, work: ShellFloorContext, skipped: ReadonlySet<number>): string | null {
  const credential = stage.name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[stage.name]?.credential;
  if (credential === true) return `sensitive credential store (${stage.name})`;
  if (credential instanceof RegExp && credential.test(stage.visible.filter((value): value is string => value !== undefined).join(" "))) return `sensitive credential store (${stage.name})`;
  for (let index = 1; index < stage.argv.length; index += 1) {
    if (skipped.has(index)) continue;
    const value = stage.visible[index];
    if (value === undefined) continue;
    const profilePath = value.replace(/\//g, "\\");
    const profileRoot = /^(?:\$env:(?:userprofile|appdata|localappdata)|\$home|~|[a-z]:\\users\\[^\\]+)(?:\\|$)/i.test(profilePath);
    const shortSensitiveStore = /(?:^|\\)(?:micros~\d|microsoft)(?:\\(?:creden~\d|credentials|protec~\d|protect|vault~\d|vault|crypto~\d|crypto))(?:\\|$)/i.test(profilePath);
    if (profileRoot && shortSensitiveStore) return "sensitive PowerShell profile store";
    const hit = stage.argv[index] === undefined
      ? sensitivePathInArgumentText(value, cwd, work)
      : sensitivePathInLiteralArgumentText(stage.argv[index]!, cwd, work);
    if (hit !== null) return hit;
  }
  return null;
}

function finalizeSignals(sensitive: string | null, exfiltration: string | null, dynamic: boolean, exactLiteralEvaluation: boolean): ShellFloorSignals {
  if (sensitive !== null || exfiltration !== null) return { outcome: "visible-floor", sensitive, exfiltration };
  if (dynamic) return { outcome: "unproven", sensitive: null, exfiltration: null, ordinaryAsk: RUNTIME_EVALUATION_REASON,
    ...(exactLiteralEvaluation ? { exactLiteralEvaluation: true as const } : {}) };
  return { outcome: "static-complete", sensitive: null, exfiltration: null };
}

// Parsing and reusable exact identity

type LexedPowerShell = { pipelines: PsPipeline[] | null; reason?: string; readable?: PsCommand[]; permissionPipelines?: PsPipeline[] };
let powerShellLexObserver: ((command: string) => void) | undefined;

function lex(command: string, context: PowerShellAnalysisContext): LexedPowerShell {
  context.visits.lexes += 1;
  powerShellLexObserver?.(command);
  const lexer = new Lexer(command, context);
  try {
    const pipelines = lexer.parseProgram();
    if (context.facts.get("unproven-quote-delimiter") === true) {
      return { pipelines: null, reason: "unsupported quote delimiter", readable: lexer.readable, permissionPipelines: pipelines };
    }
    if (context.facts.get("unproven-redirection") === true) {
      return { pipelines: null, reason: "unsupported redirection", readable: lexer.readable, permissionPipelines: pipelines };
    }
    return { pipelines };
  }
  catch (error) {
    if (error instanceof PowerShellStructuralLimitError) throw error;
    if (error instanceof PsUnreadable) {
      const partial = lexer.partialCommand();
      return { pipelines: null, reason: error.message, readable: partial === undefined ? lexer.readable : [...lexer.readable, partial] };
    }
    throw error;
  }
}

export interface ParsedPowerShellCommand {
  readonly command: string;
  readonly syntax: LexedPowerShell;
  readonly analysisLimited: boolean;
  readonly facts: Map<string, unknown>;
  readonly context: PowerShellAnalysisContext;
}
export type PowerShellCommandInput = ShellCommandInput | ParsedPowerShellCommand;

export function parsePowerShellCommand(command: string, resolver?: VerifiedArgvResolver): ParsedPowerShellCommand {
  const context = new SharedPowerShellContext();
  if (resolver !== undefined) context.facts.set("verified-argv-resolver", resolver);
  retainVisibleUpload(command, context);
  let syntax: LexedPowerShell;
  let analysisLimited = false;
  try {
    context.enter(command);
    syntax = lex(command, context);
    if (syntax.pipelines !== null) context.facts.set("static-program", staticProgram(syntax.pipelines, context));
  } catch (error) {
    if (!(error instanceof PowerShellStructuralLimitError)) throw error;
    syntax = { pipelines: null, reason: error.message };
    analysisLimited = true;
  } finally { if (context.currentFrameDepth() > 0) context.leave(); }
  return { command, syntax, analysisLimited: analysisLimited || context.limited, facts: context.facts, context };
}

function asPowerShellCommand(input: PowerShellCommandInput): ParsedPowerShellCommand {
  if (typeof input === "string") return parsePowerShellCommand(input);
  if ("syntax" in input) return input;
  const key = "powershell-parsed";
  const cached = input.facts.get(key) as ParsedPowerShellCommand | undefined;
  if (cached !== undefined) return cached;
  const parsed = parsePowerShellCommand(input.command);
  input.facts.set(key, parsed);
  return parsed;
}

function staticProgramFor(parsed: ParsedPowerShellCommand): StaticProgram {
  const cached = parsed.facts.get("static-program") as StaticProgram | undefined;
  if (cached !== undefined) return cached;
  if (parsed.syntax.pipelines === null) throw new Error("PowerShell static program requires readable syntax");
  const program = staticProgram(parsed.syntax.pipelines, parsed.context);
  parsed.facts.set("static-program", program);
  return program;
}

export function _recordPowerShellLexesForTest(): { readonly lexed: readonly string[]; stop(): void } {
  const lexed: string[] = [];
  const previous = powerShellLexObserver;
  powerShellLexObserver = (command) => { previous?.(command); lexed.push(command); };
  return { lexed, stop: () => { powerShellLexObserver = previous; } };
}

export type PowerShellRuleShape =
  | { ok: true; commands: (string | null)[][]; opaque: string | null; exactLiteralEvaluation?: true }
  | { ok: false; reason: string; visible: (string | null)[][] };

export function powerShellRuleShape(input: PowerShellCommandInput): PowerShellRuleShape {
  const command = typeof input === "string" ? input : input.command;
  if (command.length > MAX_LITERAL_COMMAND_LENGTH) return { ok: false, reason: "literal command length limit exceeded", visible: [] };
  const parsed = asPowerShellCommand(input);
  if (parsed.analysisLimited) return { ok: false, reason: "PowerShell structural limit exceeded", visible: [] };
  const cached = parsed.facts.get("rule-shape") as PowerShellRuleShape | undefined;
  if (cached !== undefined) return cached;
  if (parsed.syntax.pipelines === null) {
    const visible = (parsed.syntax.readable ?? []).map(commandArgv).filter((argv): argv is (string | null)[] => argv !== null);
    const shape = { ok: false as const, reason: parsed.syntax.reason ?? "unreadable", visible };
    parsed.facts.set("rule-shape", shape);
    return shape;
  }
  const program = staticProgramFor(parsed);
  const commands = program.stages.map((stage) => ruleArgv(stage.command)).filter((argv): argv is (string | null)[] => argv !== null);
  const encoded = program.encodedReason;
  const exactLiteralEvaluation = program.literalEvaluation !== null && encoded === null;
  const opaque = encoded ?? (program.dynamic && !exactLiteralEvaluation ? RUNTIME_EVALUATION_REASON : null);
  const shape: PowerShellRuleShape = { ok: true, commands, opaque, ...(exactLiteralEvaluation ? { exactLiteralEvaluation: true } : {}) };
  parsed.facts.set("rule-shape", shape);
  return shape;
}

export function proveLiteralPowerShell(input: PowerShellCommandInput): { proven: true; commands: readonly (readonly string[])[] } | { proven: false; reason: string } {
  const shape = powerShellRuleShape(input);
  if (!shape.ok) return { proven: false, reason: shape.reason };
  if (shape.opaque !== null) return { proven: false, reason: shape.opaque };
  if (shape.commands.length === 0) return { proven: false, reason: "no command" };
  return { proven: true, commands: shape.commands as readonly (readonly string[])[] };
}

function literalStageBodies(stage: StaticStage) {
  const call = stage.command.tokens[0]?.raw === "&";
  const constructedCall = ["&", "."].includes(stage.command.tokens[0]?.raw ?? "")
    && /^\[scriptblock\]::Create$/iu.test(stage.command.tokens[1]?.raw ?? "");
  if (!constructedCall) stage = permissionEffectStage(stage);
  if (!call && stage.command.tokens[0]?.kind === "word" && stage.command.tokens[0].quoted) return [];
  const argument = (token: PsToken): LiteralShellArgument => {
    if (token.kind === "word") {
      if (!token.quoted && ["&", "."].includes(token.raw)) return token.raw;
      if (!token.quoted && /^(?:\$ExecutionContext\.InvokeCommand\.InvokeScript|\[scriptblock\]::Create)$/iu.test(token.raw)) return token.raw;
      return token.raw === "," ? "," : literalWordValue(token);
    }
    if (token.open === "{") return { kind: "scriptblock", text: token.raw.slice(1, -1) };
    if (!["@(", "("].includes(token.open) || token.body.length !== 1) return undefined;
    const pipeline = token.body[0]!;
    if (pipeline.assign.length || pipeline.stages.length !== 1) return undefined;
    if (token.open === "(" && /^\[scriptblock\]::Create$/iu.test(pipeline.stages[0]!.tokens[0]?.raw ?? "")) {
      return { kind: "expression", argv: pipeline.stages[0]!.tokens.map(argument) };
    }
    const values: string[] = [];
    for (const [index, element] of pipeline.stages[0]!.tokens.entries()) {
      const value = element.kind === "word" && element.raw === "," ? "," : literalWordValue(element);
      if (value === undefined || (index % 2 === 1 ? value !== "," : value === ",")) return undefined;
      if (index % 2 === 0) values.push(value);
    }
    return token.open === "(" ? { kind: "parenthesized", values } : values;
  };
  const argv = stage.command.tokens.map(argument);
  if (argv.every((value): value is string => typeof value === "string")) {
    const words = argv.map((value, index) => literalWord(value, { raw: stage.raw[index]!, start: index, end: index + 1 }));
    const effective = effectiveShellWords(words);
    if (!effective.unsupported && effective.words.length < words.length) {
      const from = words.indexOf(effective.words[0]!);
      if (from >= 0) return literalShellBodies(argv.slice(from), "powershell", stage.raw.slice(from));
    }
  }
  return literalShellBodies(argv, "powershell", stage.raw);
}

function inspectParsed(parsed: ParsedPowerShellCommand, cwd: string | undefined, budget: LiteralBodyBudget): ShellFloorSignals {
  budget.tokens.count += parsed.context.visits.grammarRecords;
  if (budget.depth >= POWERSHELL_ANALYSIS_LIMITS.depth || budget.tokens.count > MAX_SHELL_ANALYSIS_TOKENS) return shellFloorBudgetSignals();
  const retained = sharedWork(parsed.context).retained;
  if (parsed.analysisLimited) return { ...shellFloorBudgetSignals(), ...retained,
    ...(retained.sensitive !== null || retained.exfiltration !== null ? { outcome: "visible-floor" as const } : {}) };
  const { pipelines, reason, readable } = parsed.syntax;
  const work = sharedWork(parsed.context);
  if (pipelines === null) {
    let sensitive: string | null = retained.sensitive, exfiltration: string | null = retained.exfiltration;
    for (const command of readable ?? []) {
      const argv = command.tokens.map(literalWordValue);
      if (argv.length === 0 || argv.some((value) => value === undefined)) continue;
      const values = argv as string[];
      const raw = command.tokens.map((token) => token.raw);
      const stage = permissionEffectStage({ command, argv: values, visible: values, raw, name: canonicalName(values[0]!), fedByPipeline: false, pipelineId: 0,
        proof: { kind: "unproven" } });
      sensitive ??= visibleSensitive(stage, cwd, work, new Set());
      const native = inspectLiteralShellArgvFacts(values, cwd, work);
      sensitive ??= native.sensitive;
      exfiltration ??= native.exfiltration ?? visiblePowerShellExfiltration(stage, false, new Set());
    }
    if (sensitive !== null || exfiltration !== null) return { outcome: "visible-floor", sensitive, exfiltration };
    return { outcome: "unproven", sensitive: null, exfiltration: null, ordinaryAsk: `PowerShell syntax is not statically provable (${reason ?? "unreadable"})` };
  }
  const program = staticProgramFor(parsed);
  let sensitive: string | null = retained.sensitive, exfiltration: string | null = retained.exfiltration;
  let pipelineId = -1;
  let pipelineReadsPath = false;
  let readsPath = false, network = false;
  const childFlows = new Map<PsCommand, { readsPath: boolean; network: boolean; limited: boolean }>();
  const inspectStageBodies = (stage: StaticStage) => {
    const cached = childFlows.get(stage.command);
    if (cached) return cached;
    const childFlow = { readsPath: false, network: false, limited: false };
    for (const body of literalStageBodies(stage)) {
      const childBudget = { tokens: budget.tokens, depth: budget.depth + 1 };
      const child = body.dialect === "powershell" ? inspectPowerShellCommand(body.text, cwd, childBudget)
        : inspectPosixShellCommand(body.text, cwd, undefined, childBudget, inspectPowerShellCommand);
      sensitive ??= child.sensitive;
      exfiltration ??= child.exfiltration;
      const flow = literalShellFlow(child);
      childFlow.readsPath ||= flow?.readsPath === true;
      childFlow.network ||= flow?.network === true;
      childFlow.limited ||= child.analysisLimited === true;
    }
    readsPath ||= childFlow.readsPath;
    network ||= childFlow.network;
    childFlows.set(stage.command, childFlow);
    return childFlow;
  };
  for (let index = 0; index < program.stages.length; index += 1) {
    const originalStage = program.stages[index]!;
    const stage = permissionEffectStage(originalStage);
    if (stage.pipelineId !== pipelineId) { pipelineId = stage.pipelineId; pipelineReadsPath = false; }
    const skipped = new Set(stage.proof.kind === "literal-evaluation" ? stage.proof.payloadIndexes : []);
    const unresolvedPath = work.unresolvedPath;
    sensitive ??= visibleSensitive(stage, cwd, work, skipped);
    const native = inspectLiteralShellArgvFacts(originalStage.argv, cwd, work, new Set(originalStage.proof.kind === "literal-evaluation" ? originalStage.proof.payloadIndexes : []));
    sensitive ??= native.sensitive;
    exfiltration ??= native.exfiltration ?? visiblePowerShellExfiltration(stage, stage.fedByPipeline, skipped);
    const childFlow = inspectStageBodies(originalStage);
    if (childFlow.limited) return { ...shellFloorBudgetSignals(), sensitive, exfiltration };
    const stageNetwork = native.network || childFlow.network;
    const stageReadsPath = native.readsPath || childFlow.readsPath;
    if (stage.fedByPipeline && pipelineReadsPath && stageNetwork) exfiltration ??= "PowerShell pipeline sends file data to a network command";
    pipelineReadsPath ||= stageReadsPath;
    readsPath ||= stageReadsPath || POWERSHELL_COMMAND_POLICIES[stage.name ?? ""]?.effects.includes("read") === true;
    network ||= stageNetwork || POWERSHELL_COMMAND_POLICIES[stage.name ?? ""]?.effects.includes("network") === true;
    if (stage.proof.kind === "static-complete" && stage.proof.dataOnly) work.unresolvedPath = unresolvedPath;
  }
  for (const { stage } of permissionStages(pipelines, program)) {
    if (inspectStageBodies(stage).limited) return { ...shellFloorBudgetSignals(), sensitive, exfiltration };
  }
  exfiltration ??= program.nestedUpload;
  return recordLiteralShellFlow(finalizeSignals(sensitive, exfiltration, program.dynamic || program.encodedReason !== null || work.unresolvedPath,
    !work.unresolvedPath && program.literalEvaluation !== null && program.encodedReason === null), { readsPath, network });
}

function applyStartupPolicy(signals: ShellFloorSignals): ShellFloorSignals {
  if (signals.outcome === "visible-floor" || signals.analysisLimited
    || (signals.outcome === "unproven" && signals.exactLiteralEvaluation !== true)) return signals;
  if (isPowerShellStartupPinned()) return signals;
  const result: ShellFloorSignals = { outcome: "unproven", sensitive: null, exfiltration: null, ordinaryAsk: POWERSHELL_STARTUP_UNPROVEN_REASON };
  const flow = literalShellFlow(signals);
  return flow ? recordLiteralShellFlow(result, flow) : result;
}

interface PermissionStage { stage: StaticStage; conditional: boolean; uncertainLocation?: true }

function permissionCallKey(name: string): string {
  let value = name.toLowerCase();
  if (value.startsWith("${") && value.endsWith("}")) value = "$" + value.slice(2, -1);
  return value.startsWith("$") ? "$" + value.slice(1).replace(/^(?:global|script|local|private):/, "")
    : value.replace(/^(?:global|script|local|private):/, "");
}

// Nested code contributes only path evidence; it never joins the reusable command proof.
function permissionStages(pipelines: readonly PsPipeline[], program: StaticProgram): PermissionStage[] {
  const direct = new Map(program.stages.map((stage) => [stage.command, stage]));
  const stages: PermissionStage[] = [];
  const calls = new Set<string>();
  const unresolvedCalls = new Set<string>();
  let unknownCall = false;
  const definitions = new Map<PsGroup, { keys: readonly string[]; expanded: boolean }>();
  const gatherCalls = (body: readonly PsPipeline[]): void => {
    for (const pipeline of body) for (const command of pipeline.stages) {
      const head = command.tokens[0];
      const literal = head === undefined ? undefined : literalWordValue(head);
      const name = literal === undefined ? undefined : canonicalName(literal);
      if (head?.kind === "word" && !head.quoted && ["&", "."].includes(head.raw)) {
        const target = command.tokens[1];
        if (target?.kind === "word") {
          const key = permissionCallKey(target.text);
          calls.add(key);
          if (literalWordValue(target) === undefined) unresolvedCalls.add(key);
        } else unknownCall = true;
      } else if (literal !== undefined) calls.add(permissionCallKey(literal));
      for (const [index, token] of command.tokens.entries()) {
        if (token.kind === "group") {
          if (token.open === "{" && name === "write-output") continue;
          const declaration = token.open === "{" && ["function", "filter"].includes(name ?? "");
          const assignedCode = token.open === "{" && pipeline.assign.length > 0 && !command.tokens.slice(0, index).some((token) => token.kind === "word" && ["&", "."].includes(token.text));
          if (declaration || assignedCode) {
            if (!definitions.has(token)) definitions.set(token, { keys: declaration
              ? [permissionCallKey(literalWordValue(command.tokens[1]!) ?? "")] : pipeline.assign.map((name) => permissionCallKey("$" + name)), expanded: false });
          } else gatherCalls(token.body);
        } else for (const nested of token.nested) gatherCalls(nested);
      }
    }
  };
  gatherCalls(pipelines);
  let expanded: boolean;
  do {
    expanded = false;
    const unknownInvocation = unknownCall || unresolvedCalls.size > 0;
    for (const [group, definition] of definitions) {
      if (definition.expanded || !unknownInvocation && !definition.keys.some((name) => calls.has(name))) continue;
      for (const key of definition.keys) calls.add(key);
      definition.expanded = true;
      expanded = true;
      gatherCalls(group.body);
    }
  } while (expanded);
  const visit = (body: readonly PsPipeline[], conditional: boolean, uncertainLocation = false): void => {
    for (const pipeline of body) for (const command of pipeline.stages) {
      const argv = command.tokens.map(literalWordValue);
      const name = argv[0] === undefined ? undefined : canonicalName(argv[0]);
      const branch = controlStatement(command, false) !== undefined;
      for (const [index, token] of command.tokens.entries()) {
        if (token.kind === "group") {
          // Code values and definitions do not execute merely because they are constructed.
          if (token.open === "{" && name === "write-output") continue;
          const declaration = token.open === "{" && ["function", "filter"].includes(name ?? "");
          const assignedCode = token.open === "{" && pipeline.assign.length > 0 && !command.tokens.slice(0, index).some((token) => token.kind === "word" && ["&", "."].includes(token.text));
          if (declaration && !calls.has(permissionCallKey(argv[1] ?? ""))) continue;
          if (assignedCode && !pipeline.assign.some((name) => calls.has(permissionCallKey("$" + name)))) continue;
          visit(token.body, conditional || branch, uncertainLocation || declaration || assignedCode);
        } else for (const nested of token.nested) visit(nested, conditional, uncertainLocation);
      }
      const stage = direct.get(command) ?? { command, argv, visible: command.tokens.map((token) => token.kind === "word" ? token.text : undefined),
        raw: command.tokens.map((token) => token.raw), name, fedByPipeline: false, pipelineId: -1, proof: { kind: "unproven" as const } };
      stages.push({ stage, conditional, ...(uncertainLocation ? { uncertainLocation: true as const } : {}) });
    }
  };
  visit(pipelines, false);
  return stages;
}

/** Report parsed filesystem bindings, retaining repeated targets and their individual effects.
 * When unproven is true, paths may be partial; route uncertainty through the pipeline. */
export function inspectPowerShellPermissionPaths(input: PowerShellCommandInput, cwd: string, environment: Readonly<Record<string, string | undefined>> = {}, budget: LiteralBodyBudget = { tokens: { count: 0 }, depth: 0 }): {
  paths: readonly PermissionPathEvidence[];
  unproven: boolean;
  credentialStore: string | null;
  unknownProtectedWrite?: string;
  evidenceLimitExceeded?: true;
} {
  const parsed = asPowerShellCommand(input);
  budget.tokens.count += parsed.context.visits.grammarRecords;
  if (parsed.analysisLimited || budget.depth >= POWERSHELL_ANALYSIS_LIMITS.depth || budget.tokens.count > MAX_SHELL_ANALYSIS_TOKENS) return { paths: [], unproven: true, credentialStore: null, evidenceLimitExceeded: true };
  const paths: PermissionPathEvidence[] = [];
  const evidenceForPath = createPermissionPathEvidence(cwd);
  const redirectFacts = parsed.facts.get("filesystem-redirections") as readonly PsRedirection[] | undefined;
  const evidencePipelines = parsed.syntax.pipelines ?? parsed.syntax.permissionPipelines;
  const fallback = parsed.syntax.pipelines === null && evidencePipelines === undefined ? inspectPosixShellPermissionPaths(parsed.command, cwd, { dialect: "bash", environment: {} }, undefined, budget, inspectPowerShellPermissionPaths) : undefined;
  if (fallback && (parsed.syntax.readable ?? []).length === 0) {
    return { paths: fallback.paths, unproven: true, credentialStore: null,
      ...(fallback.unknownProtectedWrite ? { unknownProtectedWrite: fallback.unknownProtectedWrite } : {}),
      ...(fallback.unproven?.kind === "analysis-limit" ? { evidenceLimitExceeded: true as const } : {}) };
  }
  if (fallback) paths.push(...fallback.paths);
  // Evidence-only redirection lexing never creates a reusable argv or read-only proof.
  const program: StaticProgram = parsed.syntax.pipelines === null
    ? { stages: (parsed.syntax.readable ?? []).map((command, pipelineId) => {
      const argv = command.tokens.map(literalWordValue);
      return { command, argv, visible: command.tokens.map((token) => token.kind === "word" ? token.text : undefined),
        raw: command.tokens.map((token) => token.raw), name: argv[0] === undefined ? undefined : canonicalName(argv[0]),
        fedByPipeline: false, pipelineId, proof: { kind: "unproven" as const } };
    }), nestedUpload: null, dynamic: true, literalEvaluation: null, encodedReason: null }
    : staticProgramFor(parsed);
  let unproven = parsed.analysisLimited || parsed.syntax.pipelines === null || program.dynamic || program.encodedReason !== null;
  let credentialStore: string | null = null;
  let unknownProtectedWrite: string | undefined = fallback?.unknownProtectedWrite;
  let evidenceLimitExceeded = fallback?.unproven?.kind === "analysis-limit";
  // Earlier stages may change environment or location; only an isolated stage can use the launch snapshot.
  const stages: PermissionStage[] = evidencePipelines ? permissionStages(evidencePipelines, program) : program.stages.map(stage => ({ stage, conditional: false }));
  const stageEnvironment = stages.length === 1 ? environment : {};
  let currentDirectory: string | null = cwd;
  const add = (binding: FilesystemArgumentBinding, effect: "read" | "write", deleting = false, literalPath = false, directory = currentDirectory) => {
    let value = binding.value;
    if (effect === "write" && (binding.dynamic || !literalPath && /[*?\[\]]/.test(value))) {
      unknownProtectedWrite ??= "The shell write target may resolve to a protected path.";
    }
    unproven ||= binding.dynamic;
    value = value.replace(/^(?:~|\$HOME|\$env:USERPROFILE)(?=[\\/]|$)/i, homedir());
    if (!literalPath && /[*?\[\]]/.test(value)) unproven = true;
    const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(value);
    if (!absolute && directory === null && effect === "write") unknownProtectedWrite ??= "The shell write location may be a protected directory.";
    const base = directory ?? cwd;
    const modeled = modelShellPath(value, { dialect: "powershell", location: base });
    let canonical = modeled.normalizedPath;
    if (modeled.nativePath !== undefined) {
      try { canonical = resolveShellFilesystemPath(modeled.nativePath, base); }
      catch { unproven = true; if (effect === "write") unknownProtectedWrite ??= "The shell write target cannot be resolved away from protected paths."; }
    } else { unproven = true; if (effect === "write") unknownProtectedWrite ??= "The shell write target cannot be resolved away from protected paths."; }
    const lexical = absolute ? value : base + "/" + value;
    paths.push({ ...evidenceForPath({ lexical, canonical, effect }), ...(deleting ? { deleteIntent: true as const } : {}) });
  };
  if (evidencePipelines === undefined) for (const redirect of redirectFacts ?? []) {
    const binding = permissionArgumentBinding(redirect.target, {});
    if (binding) add(binding, "write", false, false, null);
  }
  for (const { stage: parsedStage, conditional, uncertainLocation } of stages) {
    if (uncertainLocation) currentDirectory = null;
    for (const redirect of redirectFacts ?? []) {
      if (redirect.commandTokens !== parsedStage.command.tokens) continue;
      const binding = permissionArgumentBinding(redirect.target, stageEnvironment);
      if (binding) add(binding, "write");
      else unknownProtectedWrite ??= "The shell redirection target may resolve to a protected path.";
    }
    // A literal call target has the same filesystem and credential effects as
    // direct invocation. Keep the original program and rule proof untouched.
    const stage = permissionEffectStage(parsedStage);
    const literalBodies = literalStageBodies(parsedStage);
    for (const body of literalBodies) {
      const childBudget = { tokens: budget.tokens, depth: budget.depth + 1 };
      if (body.dialect === "powershell") {
        const nested = inspectPowerShellPermissionPaths(body.text, currentDirectory ?? cwd, stageEnvironment, childBudget);
        paths.push(...nested.paths);
        unproven ||= nested.unproven;
        credentialStore ??= nested.credentialStore;
        unknownProtectedWrite ??= nested.unknownProtectedWrite;
        evidenceLimitExceeded ||= nested.evidenceLimitExceeded === true;
      } else {
        const nested = inspectPosixShellPermissionPaths(body.text, currentDirectory ?? cwd, { dialect: "bash", environment: stageEnvironment }, undefined, childBudget, inspectPowerShellPermissionPaths);
        paths.push(...nested.paths);
        unproven ||= nested.unproven !== null;
        unknownProtectedWrite ??= nested.unknownProtectedWrite;
        evidenceLimitExceeded ||= nested.unproven?.kind === "analysis-limit";
      }
    }
    const policy = stage.name === undefined ? undefined : POWERSHELL_COMMAND_POLICIES[stage.name];
    const credential = policy?.credential;
    if (credential === true || (credential instanceof RegExp && credential.test(stage.visible.filter((value): value is string => value !== undefined).join(" ")))) {
      credentialStore ??= "Host credential store access";
    }
    const implicitWrite = inspectImplicitGitWriteTargets(stage.argv, currentDirectory, stageEnvironment, (path, _label, directory, effect) => add({ value: path, dynamic: false }, effect, false, false, directory));
    unknownProtectedWrite ??= implicitWrite;
    if (stage.proof.kind === "static-complete" && stage.proof.dataOnly) continue;
    if (policy === undefined || policy.native) {
      credentialStore ??= nativeCredentialStore(stage, sharedWork(parsed.context));
      const values = stage.command.tokens.map((token, index) => stage.argv[index] === undefined ? permissionArgumentBinding(token, stageEnvironment) : { value: stage.argv[index]!, dynamic: false });
      const source = values.map((binding, index) => binding && !binding.dynamic ? shellQuote(binding.value) : stage.raw[index]!).join(" ");
      unknownProtectedWrite ??= inspectUnknownNativeWriteArguments(values.map((binding) => binding && !binding.dynamic ? binding.value : undefined), stage.raw);
      const native = inspectPosixShellPermissionPaths(source, currentDirectory ?? cwd, { dialect: "bash", environment: {} }, undefined, budget, inspectPowerShellPermissionPaths, { rootAlreadyParsed: true, literalBodiesAlreadyInspected: literalBodies.length > 0 });
      paths.push(...native.paths);
      unproven ||= native.unproven !== null;
      evidenceLimitExceeded ||= native.unproven?.kind === "analysis-limit";
      unknownProtectedWrite ??= native.unknownProtectedWrite;
      if (currentDirectory === null) unknownProtectedWrite ??= inspectUnknownNativeWriteLocation(values.map((binding) => binding && !binding.dynamic ? binding.value : undefined), stage.raw);
      continue;
    }
    const effects = policy.effects;
    const destination = policy.destination;
    if (destination?.kind !== undefined) continue;
    const writes = effects.some((effect) => ["file-write", "provider-write"].includes(effect)) || destination !== undefined;
    if (!writes && !effects.some((effect) => ["read", "cwd-write", "network"].includes(effect))) continue;
    const effect = writes ? "write" : "read";
    const sourceEffect = policy.sourceEffect ?? effect;
    const bindings = filesystemArgumentBindings(stage, stageEnvironment);
    unproven ||= bindings.unproven;
    if (writes && bindings.splat) unknownProtectedWrite ??= "Runtime splatting may replace the shell write destination.";
    const pathParameters = new Set(["path", "literalpath", "filepath", "destination", "destinationpath", "newname", "workingdirectory", ...(stage.name === "new-item" ? ["name"] : []), ...(destination?.parameters ?? [])]);
    for (const name of pathParameters) {
      for (const binding of bindings.named.get(name) ?? []) add(binding, ["path", "literalpath"].includes(name) ? sourceEffect : effect, stage.name === "remove-item", name === "literalpath");
    }
    for (const binding of bindings.named.get("outfile") ?? []) add(binding, "write");
    if (!writes && !effects.some((effect) => ["read", "cwd-write"].includes(effect))) continue;
    if (destination?.variableParameters?.some((name) => bindings.named.has(name))) continue;
    const values = stage.name === "select-string" ? bindings.positional.slice(1) : bindings.positional;
    if (["copy-item", "expand-archive"].includes(stage.name!)) {
      const slots = [
        { parameters: ["path", "literalpath"], effect: sourceEffect },
        { parameters: stage.name === "expand-archive" ? ["destinationpath"] : ["destination"], effect: "write" as const },
      ].filter(slot => !slot.parameters.some(name => bindings.named.has(name)));
      for (const [index, binding] of values.slice(0, slots.length).entries()) add(binding, slots[index]!.effect);
    } else {
      const count = ["move-item", "rename-item"].includes(stage.name!) ? 2 : 1;
      const candidates = bindings.ambiguous ? values : values.slice(0, count);
      for (const [index, binding] of candidates.entries()) add(binding, index === 0 ? sourceEffect : effect, stage.name === "remove-item");
    }
    if (effects.includes("cwd-write")) {
      const target = bindings.named.get("path")?.[0] ?? bindings.named.get("literalpath")?.[0] ?? bindings.positional[0];
      if (conditional || !target || target.dynamic || /[*?\[\]]/.test(target.value) || currentDirectory === null) currentDirectory = null;
      else {
        try { currentDirectory = resolveShellFilesystemPath(target.value, currentDirectory); }
        catch { currentDirectory = null; }
      }
    }
    if (stage.argv.some((value) => value === undefined)) unproven = true;
  }
  return { paths, unproven, credentialStore, ...(unknownProtectedWrite ? { unknownProtectedWrite } : {}), ...(evidenceLimitExceeded ? { evidenceLimitExceeded: true as const } : {}) };
}

export function inspectPowerShellCommand(input: PowerShellCommandInput, cwd?: string, budget: LiteralBodyBudget = { tokens: { count: 0 }, depth: 0 }): ShellFloorSignals { return applyStartupPolicy(inspectParsed(asPowerShellCommand(input), cwd, budget)); }
export function inspectPowerShellVisibleText(command: string, cwd?: string): ShellFloorSignals { return inspectPowerShellCommand(command, cwd); }
export function powerShellSensitivePathSignal(input: ShellCommandInput, cwd?: string): string | null { return inspectPowerShellCommand(input, cwd).sensitive; }
export function powerShellExfiltrationSignal(input: ShellCommandInput, cwd?: string): string | null { return inspectPowerShellCommand(input, cwd).exfiltration; }

export function _inspectPowerShellForTest(input: ShellCommandInput, cwd?: string) {
  const command = typeof input === "string" ? input : input.command;
  const context = new SharedPowerShellContext();
  retainVisibleUpload(command, context);
  let syntax: LexedPowerShell, limited = false;
  try {
    context.enter(command);
    syntax = lex(command, context);
    if (syntax.pipelines !== null) context.facts.set("static-program", staticProgram(syntax.pipelines, context));
  } catch (error) {
    if (!(error instanceof PowerShellStructuralLimitError)) throw error;
    syntax = { pipelines: null, reason: error.message };
    limited = true;
  } finally { if (context.currentFrameDepth() > 0) context.leave(); }
  const parsed: ParsedPowerShellCommand = { command, syntax, analysisLimited: limited || context.limited, facts: context.facts, context };
  const result = applyStartupPolicy(inspectParsed(parsed, cwd, { tokens: { count: 0 }, depth: 0 }));
  return { ...result, limited: parsed.analysisLimited, visits: context.visits, shellVisits: context.floor.visits, limits: POWERSHELL_ANALYSIS_LIMITS };
}

// Recursive traversal

const POWERSHELL_KEYWORDS = new Set(["begin", "break", "catch", "continue", "data", "do", "dynamicparam", "else", "elseif", "end", "exit",
  "filter", "finally", "for", "foreach", "function", "if", "param", "process", "return", "switch", "throw", "trap", "try", "until", "while", "workflow"]);
// A parameter token, optionally colon-bound (`-Recurse:$x`, or `-Recurse: $x` with the value in the next token).
const PARAMETER_TOKEN = /^-([A-Za-z_?][\w-]*)(:?)([\s\S]*)$/;

function traversalValue(token: PsToken | undefined): PowerShellTraversalValue {
  const value = token === undefined ? undefined : literalWordValue(token) ?? wildcardWordValue(token);
  return value === undefined ? { kind: "dynamic" } : { kind: "literal", value };
}

// The host AST passes an unquoted wildcard word as a literal; keep the same view so both layers agree.
function wildcardWordValue(token: PsToken): string | undefined {
  if (token.kind !== "word" || token.quoted || token.nested.length > 0 || token.adjacent) return undefined;
  return wildcardText(token.raw);
}

function wildcardText(text: string): string | undefined {
  if (!/[*?[]/.test(text)) return undefined;
  return literalRuleWord(text.replace(/[*?[\]]/g, "a"), "powershell") === undefined ? undefined : text;
}

function boundTraversalValue(token: PsWord, text: string): PowerShellTraversalValue {
  if (token.nested.length > 0 || token.adjacent) return { kind: "dynamic" };
  const constant = /^\$(true|false)$/i.exec(text);
  if (constant !== null) return { kind: "literal", value: constant[1]!.toLowerCase() };
  if (token.reason !== undefined) return { kind: "dynamic" };
  const value = literalRuleWord(text, "powershell") ?? wildcardText(text);
  return value === undefined ? { kind: "dynamic" } : { kind: "literal", value };
}

function traversalArguments(tokens: readonly PsToken[]): PowerShellTraversalArgument[] {
  const result: PowerShellTraversalArgument[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const match = token.kind === "word" && !token.quoted ? PARAMETER_TOKEN.exec(normalizeDashes(token.raw)) : null;
    if (match === null) { result.push(traversalValue(token)); continue; }
    const [, name, colon, rest] = match as unknown as [string, string, string, string];
    if (colon === "") result.push({ kind: "parameter", name });
    else if (rest === "") {
      const next = tokens[++index];
      result.push({ kind: "parameter", name, argument: next?.kind === "word" ? boundTraversalValue(next, next.raw) : traversalValue(next) });
    }
    else result.push({ kind: "parameter", name, argument: boundTraversalValue(token as PsWord, rest) });
  }
  return result;
}

interface TraversalStage { name: string | undefined; args: readonly PowerShellTraversalArgument[] }

// null: an expression-mode element, which is a value; its nested bodies are walked separately.
function traversalStage(pipeline: PsPipeline, stageIndex: number): TraversalStage | null {
  let tokens = pipeline.stages[stageIndex]!.tokens;
  if (stageIndex === 0 && (pipeline.assign.length > 0 || pipeline.key !== undefined)) {
    const operator = tokens.findIndex((token) => token.kind === "word" && !token.quoted && /^[+\-*/]?=$/.test(token.text));
    tokens = tokens.slice(operator >= 0 ? operator + 1 : 1);
  }
  const head = tokens[0];
  if (head?.kind === "word" && !head.quoted && (head.text === "&" || head.text === ".")) {
    const target = tokens[1] === undefined ? undefined : literalWordValue(tokens[1]);
    return { name: target === undefined ? undefined : canonicalName(target), args: traversalArguments(tokens.slice(2)) };
  }
  // A digit-led word is a number unless it names a known command (`7z`).
  if (head === undefined || head.kind === "group" || head.quoted || /^[$@\[(-]/.test(head.text)
    || (/^\d/.test(head.text) && POWERSHELL_COMMAND_POLICIES[canonicalName(head.text)] === undefined)) return null;
  const literal = literalWordValue(head);
  const name = literal === undefined ? undefined : canonicalName(literal);
  if (name !== undefined && POWERSHELL_KEYWORDS.has(name)) return null;
  return { name, args: traversalArguments(tokens.slice(1)) };
}

function stageDefinitelyTraverses(stage: TraversalStage): boolean {
  return stage.name !== undefined && isDefinitePowerShellRecursion(stage.name, stage.args);
}

// Fail-closed: unknown, launcher and dynamic command names, an archiver with an unresolved mode or operand, and
// Get-ChildItem with any unresolved operand may walk.
function stageMayTraverse(stage: TraversalStage): boolean {
  if (stage.name === undefined || classifyPowerShellArchiveTraversal(stage.name, stage.args) === "undecidable") return true;
  const policy = POWERSHELL_COMMAND_POLICIES[stage.name];
  if (policy === undefined || policy.effects.includes("launcher") || stageDefinitelyTraverses(stage)) return true;
  if (mayCarryNativeRecursionSwitch(stage.name, stage.args)) return true;
  // A wildcard operand stays unresolved here, as it was before wildcards were read as literals.
  if (stage.name === "get-childitem" && stage.args.some((argument) => unresolvedOperand(argument)
    || (argument.kind === "parameter" && argument.argument !== undefined && unresolvedOperand(argument.argument)))) return true;
  return stage.args.some((argument) => argument.kind === "parameter" && isPowerShellRecursionParameter(stage.name!, argument));
}

function unresolvedOperand(argument: PowerShellTraversalArgument): boolean {
  return argument.kind === "dynamic" || (argument.kind === "literal" && /[*?[]/.test(argument.value));
}

function someTraversalStage(parsed: ParsedPowerShellCommand, predicate: (stage: TraversalStage) => boolean): boolean {
  const pending = [...parsed.syntax.pipelines!];
  while (pending.length > 0) {
    const pipeline = pending.pop()!;
    for (let stageIndex = 0; stageIndex < pipeline.stages.length; stageIndex += 1) {
      const stage = traversalStage(pipeline, stageIndex);
      if (stage !== null && predicate(stage)) return true;
      for (const token of pipeline.stages[stageIndex]!.tokens) {
        if (token.kind === "group") pending.push(...token.body);
        else for (const body of token.nested) pending.push(...body);
      }
    }
  }
  return false;
}

/** Definite: some command element certainly walks a tree (the host block's rule). Unparsed input is undecided, not definite. */
export function definitelyTraversesPowerShellRecursively(input: PowerShellCommandInput): boolean {
  const parsed = asPowerShellCommand(input);
  if (parsed.analysisLimited || parsed.syntax.pipelines === null) return false;
  return someTraversalStage(parsed, stageDefinitelyTraverses);
}

/** May: true unless every PowerShell command element is known not to walk a tree; unparsed input counts as walking. */
export function mayTraversePowerShellRecursively(input: PowerShellCommandInput): boolean {
  const parsed = asPowerShellCommand(input);
  if (parsed.analysisLimited || parsed.syntax.pipelines === null) return true;
  return someTraversalStage(parsed, stageMayTraverse);
}
