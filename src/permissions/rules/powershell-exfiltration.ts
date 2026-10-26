// One bounded parse supplies both exact raw identity and a single static floor pass.
// Runtime values, generated code, callbacks and file mutation are never simulated.
import {
  canonicalPowerShellName,
  POWERSHELL_COMMAND_POLICIES,
  POWERSHELL_ANALYSIS_LIMITS,
  PowerShellAnalysisContext,
  PowerShellStructuralLimitError,
  powerShellCommandsWithEffect,
} from "./powershell-command-policy.js";
import { literalRuleWord } from "./rule-specifier.js";
import { INTERPRETER_SET, SHELL_SET, isPowerShellLauncher, programName, MAX_LITERAL_COMMAND_LENGTH } from "./shell-prefix-values.js";
import { type ShellCommandInput } from "./shell-prefix-policy.js";
import { encodedPowerShellExecutionReason } from "./powershell-encoded-command.js";
import { inspectLiteralShellArgvFacts, sensitivePathInArgumentText, sensitivePathInLiteralArgumentText } from "./shell-exfiltration.js";
import { shellFloorBudgetSignals, type ShellFloorSignals, ShellFloorContext } from "./shell-floor-policy.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";

class SharedPowerShellContext extends PowerShellAnalysisContext {
  readonly floor = new ShellFloorContext();
}

function sharedWork(context: PowerShellAnalysisContext): ShellFloorContext {
  if (!(context instanceof SharedPowerShellContext)) throw new Error("Missing shell analysis context");
  return context.floor;
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
    const pushToken = (token: PsToken): void => {
      const records = originalRecordCount(token, this.analysis);
      this.grammarRecords += records;
      this.analysis.visits.grammarRecords += records;
      if (this.grammarRecords > MAX_SHELL_ANALYSIS_TOKENS) throw new PowerShellStructuralLimitError("PowerShell total token limit exceeded");
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
        const end = src.indexOf("#>", this.index + 2);
        if (end === -1) throw new PsUnreadable("unterminated comment");
        this.index = end + 2;
        continue;
      }
      if (char === "#") {
        while (this.index < src.length && src[this.index] !== "\n") {  this.index += 1; }
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
          endCommand();
          throw new PsUnreadable("unsupported background execution");
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
const FILE_WRITE_EFFECT = powerShellCommandsWithEffect("file-write");
const PROVIDER_WRITE_EFFECT = powerShellCommandsWithEffect("provider-write");
const CWD_WRITE_EFFECT = powerShellCommandsWithEffect("cwd-write");
const SHELL_CODE_OPTIONS = new Set(["-c", "-command"]);
const INTERPRETER_CODE_OPTIONS = new Set(["-c", "-e", "--eval"]);
const RUNTIME_COMMAND_MUTATORS = new Set(["set-alias", "new-alias", "import-alias", "import-module", "remove-module"]);
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
  payloadIndex: number | null;
  opaquePayloadIndexes: Set<number>;
}

interface StaticProgram {
  stages: StaticStage[];
  dynamic: boolean;
  literalEvaluation: StaticStage | null;
  encodedReason: string | null;
}

function optionName(text: string): string { return normalizeDashes(text).toLowerCase(); }

function literalEvaluationPayload(stage: StaticStage): number | null {
  if (stage.name === "start-process" && stage.visible.length > 5
    && isPowerShellLauncher(stage.visible[1] ?? "")
    && optionName(stage.visible[2] ?? "") === "-argumentlist"
    && SHELL_CODE_OPTIONS.has(optionName(stage.visible[3] ?? ""))
    && stage.visible[4] === "," && stage.argv[5] !== undefined) return 5;
  if (stage.argv.some((value) => value === undefined)) return null;
  const argv = stage.argv as readonly string[];
  if (stage.name === "invoke-expression") {
    if (argv.length === 2) return 1;
    return argv.length === 3 && optionName(argv[1]!) === "-command" ? 2 : null;
  }
  const executable = programName(argv[0]!) ?? argv[0]!.toLowerCase();
  if (argv.length < 2) return null;
  if ((executable === "deno" || executable === "deno.exe") && optionName(argv[1]!) === "eval") return argv.length === 3 ? 2 : null;
  if ((executable === "deno" || executable === "deno.exe") && optionName(argv[1]!) === "repl") {
    const at = argv.findIndex((value, index) => index > 1 && optionName(value) === "--eval");
    return at > 0 && at + 1 < argv.length ? at + 1 : null;
  }
  for (let index = 1; index + 1 < argv.length; index += 1) {
    const option = optionName(argv[index]!);
    if (SHELL_SET.has(executable) && SHELL_CODE_OPTIONS.has(option)) return index + 1;
    if (INTERPRETER_SET.has(executable) && INTERPRETER_CODE_OPTIONS.has(option)) return index + 1;
    if (isPowerShellLauncher(executable) && index === 1 && SHELL_CODE_OPTIONS.has(option)) return index + 1;
    // An operand selects a module, script or file; later flags belong to it.
    if (!option.startsWith("-") || option === "-m" || option === "-file") return null;
  }
  return null;
}

function hasUnsupportedFloorBinding(stage: StaticStage): boolean {
  if (stage.name === undefined || stage.name.endsWith(".exe")) return false;
  const policy = POWERSHELL_COMMAND_POLICIES[stage.name];
  const floorRelevant = HTTP_CMDLETS.has(stage.name) || policy?.destination !== undefined
    || policy?.credential !== undefined || policy?.sink !== undefined;
  if (!floorRelevant) return false;
  const parameters = new Set((policy?.parameters ?? []).map((name) => name.replace(/[?*]$/, "").toLowerCase()));
  for (let index = 1; index < stage.command.tokens.length; index += 1) {
    const token = stage.command.tokens[index];
    if (token?.kind !== "word" || token.quoted) continue;
    const option = optionName(token.text);
    if (!option.startsWith("-")) continue;
    if (!parameters.has(option.slice(1).split(":", 1)[0]!)) return true;
  }
  return false;
}

function hasAmbiguousPowerShellLauncherArguments(stage: StaticStage): boolean {
  if (stage.argv.some((value) => value === undefined) || stage.argv.length === 0) return false;
  const argv = stage.argv as readonly string[];
  const executable = programName(argv[0]!) ?? argv[0]!.toLowerCase();
  if (!isPowerShellLauncher(executable)) return false;
  if (argv.length < 2) return false;
  const firstOption = optionName(argv[1]!);
  const directCode = argv.length > 2 && SHELL_CODE_OPTIONS.has(firstOption);
  const directFile = argv.length > 2 && firstOption === "-file" && argv[2] !== "-";
  if (directCode || directFile) return false;
  return argv.slice(1).some((value) => /^[-/\u2013-\u2015]|^[\p{Z}\p{C}]|[\p{Z}\p{C}]$/u.test(value));
}

function mutatesFiles(stage: StaticStage): boolean {
  if (stage.name === undefined) return false;
  if (FILE_WRITE_EFFECT.has(stage.name) || PROVIDER_WRITE_EFFECT.has(stage.name)) return true;
  if (HTTP_CMDLETS.has(stage.name)) return parameterValue(stage.argv, "outfile") !== undefined;
  return stage.name === "expand-archive" || stage.name === "start-bitstransfer";
}

function staticProgram(pipelines: readonly PsPipeline[], analysis: PowerShellAnalysisContext): StaticProgram {
  const stages: StaticStage[] = [];
  let dynamic = false;
  let maximumDepth = 1;
  const pending: { pipeline: PsPipeline; depth: number; direct: boolean; pipelineId: number }[] = [];
  for (let index = pipelines.length - 1; index >= 0; index -= 1) pending.push({ pipeline: pipelines[index]!, depth: 1, direct: true, pipelineId: index });
  while (pending.length > 0) {
    const { pipeline, depth, direct, pipelineId } = pending.pop()!;
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
      for (const token of command.tokens) {
        // Nested/group spans include descendant source; charge only work actually
        // performed here so the counter cannot double-count overlapping ranges.
        analysis.visits.staticChars += token.kind === "word" && token.nested.length === 0 ? token.raw.length : 1;
        if (token.kind === "group") {
          dynamic = true;
          for (let index = token.body.length - 1; index >= 0; index -= 1) pending.push({ pipeline: token.body[index]!, depth: depth + 1, direct: false, pipelineId });
        } else if (token.nested.length > 0) {
          dynamic = true;
          for (let bodyIndex = token.nested.length - 1; bodyIndex >= 0; bodyIndex -= 1) {
            const body = token.nested[bodyIndex]!;
            for (let index = body.length - 1; index >= 0; index -= 1) pending.push({ pipeline: body[index]!, depth: depth + 1, direct: false, pipelineId });
          }
        }
      }
      if (argv.some((value) => value === undefined) || argv.length === 0) dynamic = true;
      if (direct && argv.length > 0) {
        if (ruleArgv(command) === null) dynamic = true;
        const stage: StaticStage = { command, argv, visible: command.tokens.map((token) => token.kind === "word" ? token.text : undefined),
          raw: command.tokens.map((token) => token.raw),
          name: argv[0] === undefined ? undefined : canonicalName(argv[0]), fedByPipeline: stageIndex > 0, pipelineId,
          payloadIndex: null, opaquePayloadIndexes: new Set() };
        stage.payloadIndex = literalEvaluationPayload(stage);
        if (hasUnsupportedFloorBinding(stage)) dynamic = true;
        if (hasAmbiguousPowerShellLauncherArguments(stage)) dynamic = true;
        stages.push(stage);
      }
    }
  }
  analysis.requireAdditionalFrameDepth(maximumDepth - 1);
  for (let index = 0; index + 1 < stages.length; index += 1) {
    const source = stages[index]!, evaluator = stages[index + 1]!;
    const literalPipelinePayload = source.pipelineId === evaluator.pipelineId && evaluator.fedByPipeline
      && evaluator.name === "invoke-expression" && evaluator.argv.length === 1
      && source.argv.length === 1 && source.argv[0] !== undefined && source.command.tokens[0]?.kind === "word"
      && source.command.tokens[0].quoted;
    if (literalPipelinePayload) { source.opaquePayloadIndexes.add(0); dynamic = true; }
  }
  const literalEvaluation = !dynamic && stages.length === 1 && stages[0]!.payloadIndex !== null ? stages[0]! : null;
  if (stages.some((stage) => stage.payloadIndex !== null)) dynamic = true;
  if (literalEvaluation !== null) dynamic = true;
  if (stages.length > 1 && stages.some(mutatesFiles)) dynamic = true;
  if (stages.length > 1 && stages.some((stage) => stage.name !== undefined && CWD_WRITE_EFFECT.has(stage.name))) dynamic = true;
  if (stages.length > 1 && stages.some((stage) => stage.name !== undefined && RUNTIME_COMMAND_MUTATORS.has(stage.name))) dynamic = true;
  const encodedReason = encodedPowerShellExecutionReason(stages.flatMap((stage) => stage.argv), stages.flatMap((stage) => stage.raw));
  return { stages, dynamic, literalEvaluation, encodedReason };
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
    if (parameterValue(argv, "infile") !== undefined) return `PowerShell upload sink (${name} -InFile)`;
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

type LexedPowerShell = { pipelines: PsPipeline[] | null; reason?: string; readable?: PsCommand[] };
let powerShellLexObserver: ((command: string) => void) | undefined;

function lex(command: string, context: PowerShellAnalysisContext): LexedPowerShell {
  context.visits.lexes += 1;
  powerShellLexObserver?.(command);
  const lexer = new Lexer(command, context);
  try { return { pipelines: lexer.parseProgram() }; }
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

export function parsePowerShellCommand(command: string): ParsedPowerShellCommand {
  const context = new SharedPowerShellContext();
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

function inspectParsed(parsed: ParsedPowerShellCommand, cwd: string | undefined): ShellFloorSignals {
  if (parsed.analysisLimited) return shellFloorBudgetSignals();
  const { pipelines, reason, readable } = parsed.syntax;
  const work = sharedWork(parsed.context);
  if (pipelines === null) {
    let sensitive: string | null = null, exfiltration: string | null = null;
    for (const command of readable ?? []) {
      const argv = command.tokens.map(literalWordValue);
      if (argv.length === 0 || argv.some((value) => value === undefined)) continue;
      const values = argv as string[];
      const stage: StaticStage = { command, argv: values, visible: values, raw: command.tokens.map((token) => token.raw), name: canonicalName(values[0]!), fedByPipeline: false, pipelineId: 0, payloadIndex: null, opaquePayloadIndexes: new Set() };
      stage.payloadIndex = literalEvaluationPayload(stage);
      sensitive ??= visibleSensitive(stage, cwd, work, new Set());
      const native = inspectLiteralShellArgvFacts(values, cwd, work);
      sensitive ??= native.sensitive;
      exfiltration ??= native.exfiltration ?? visiblePowerShellExfiltration(stage, false, new Set());
    }
    if (sensitive !== null || exfiltration !== null) return { outcome: "visible-floor", sensitive, exfiltration };
    return { outcome: "unproven", sensitive: null, exfiltration: null, ordinaryAsk: `PowerShell syntax is not statically provable (${reason ?? "unreadable"})` };
  }
  const program = staticProgramFor(parsed);
  let sensitive: string | null = null, exfiltration: string | null = null;
  let pipelineId = -1;
  let pipelineReadsPath = false;
  for (let index = 0; index < program.stages.length; index += 1) {
    const stage = program.stages[index]!;
    if (stage.pipelineId !== pipelineId) { pipelineId = stage.pipelineId; pipelineReadsPath = false; }
    const payload = stage.payloadIndex;
    const skipped = new Set(stage.opaquePayloadIndexes);
    if (payload !== null) skipped.add(payload);
    sensitive ??= visibleSensitive(stage, cwd, work, skipped);
    const native = inspectLiteralShellArgvFacts(stage.argv, cwd, work, skipped);
    sensitive ??= native.sensitive;
    exfiltration ??= native.exfiltration ?? visiblePowerShellExfiltration(stage, stage.fedByPipeline, skipped);
    if (stage.fedByPipeline && pipelineReadsPath && native.network) exfiltration ??= "PowerShell pipeline sends file data to a network command";
    pipelineReadsPath ||= native.readsPath;
  }
  return finalizeSignals(sensitive, exfiltration, program.dynamic || program.encodedReason !== null,
    program.literalEvaluation !== null && program.encodedReason === null);
}

export function inspectPowerShellCommand(input: PowerShellCommandInput, cwd?: string): ShellFloorSignals { return inspectParsed(asPowerShellCommand(input), cwd); }
export function inspectPowerShellVisibleText(command: string, cwd?: string): ShellFloorSignals { return inspectPowerShellCommand(command, cwd); }
export function powerShellSensitivePathSignal(input: ShellCommandInput, cwd?: string): string | null { return inspectPowerShellCommand(input, cwd).sensitive; }
export function powerShellExfiltrationSignal(input: ShellCommandInput, cwd?: string): string | null { return inspectPowerShellCommand(input, cwd).exfiltration; }

export function _inspectPowerShellForTest(input: ShellCommandInput, cwd?: string) {
  const command = typeof input === "string" ? input : input.command;
  const context = new SharedPowerShellContext();
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
  const result = inspectParsed(parsed, cwd);
  return { ...result, limited: parsed.analysisLimited, visits: context.visits, shellVisits: context.floor.visits, limits: POWERSHELL_ANALYSIS_LIMITS };
}
