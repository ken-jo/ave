// Deny outranks ask then allow, regardless of specificity; deny/ask inspect every command and nested body through wrappers. Allow requires every static command to be covered and rejects opaque syntax, substitutions, assignments, write redirects, functions and all floors.
// Literal code arguments retain exact argv identity; syntactically unreadable commands never satisfy allow rules.
import {
  staticShellWord,
  type ShellStatement,
  type ShellWord,
} from "../../shared/shell-analysis.js";
import { isDestructiveShellText } from "../reviewer/risk-classifier.js";
import { isDestructiveShellArgv, noReusableRuleReason, MAX_LITERAL_COMMAND_LENGTH } from "./shell-prefix-values.js";
import { errorMessage } from "../../shared/error-message.js";
import { literalRuleWord, type RuleSpecifier } from "./rule-specifier.js";
import { shellExfiltrationSignal, shellSensitivePathSignal, shellScanOrdinaryAsk, shellScanProofBlocker } from "./shell-exfiltration.js";
import { encodedPowerShellExecutionReason } from "./powershell-encoded-command.js";
import {
  arithmeticEvaluationReason,
  asParsedShellCommand,
  shellFact,
  type ParsedShellCommand,
  type ShellCommandInput,
  opaqueRunnerReason,
  isShellWrapperProgram,
  stripGlobalOptions,
  wrapperCommand,
  wrapperPrefixLength,
} from "./shell-prefix-policy.js";

type BashRuleSpecifier = Extract<RuleSpecifier, { kind: "bash" }>;

interface ShellRuleCommand {
  // One entry per word; `undefined` where the word is not a static literal.
  argv: readonly (string | undefined)[];
  // Exact identity preserves each original literal word, including its quote spelling.
  rawWords: readonly (string | undefined)[];
  raw: string;
  // Reasons this simple command can never be covered by an allow rule.
  allowBlockers: readonly string[];
  // Set when the command sits after a `|` and so can read the previous stage's output on stdin.
  piped?: true;
}

export type ShellRuleShape =
  | {
      ok: true;
      commands: readonly ShellRuleCommand[];
      // Reasons commands may be invisible to deny/ask matching.
      hidden: readonly string[];
      // Caller applies this at category fallback; matching rules or saved grants may satisfy it.
      ordinaryAsk?: string;
      // Whole-input reasons no allow rule can apply.
      allowBlockers: readonly string[];
    }
  | { ok: false; reason: string };

function baseProgram(token: string): string {
  return (token.split(/[\\/]/).pop() ?? token).replace(/\.exe$/i, "").replace(/^(python[23]?)\.\d+$/, "$1");
}

export function analyzeShellForRules(input: ShellCommandInput, cwd?: string): ShellRuleShape {
  if ((typeof input === "string" ? input : input.command).length > MAX_LITERAL_COMMAND_LENGTH) return { ok: false, reason: "literal command length limit exceeded" };
  const parsed = asParsedShellCommand(input);
  return shellFact(parsed, `rule-shape\0${cwd ?? ""}`, () => shapeOf(parsed, cwd));
}

function shapeOf(parsed: ParsedShellCommand, cwd: string | undefined): ShellRuleShape {
  // A broken parser runtime is an internal failure the matcher cannot reason around; report it as unparseable (asks, never allows).
  if (parsed.parserError !== undefined) return { ok: false, reason: `shell parser failed: ${errorMessage(parsed.parserError)}` };
  const analysis = parsed.analysis;
  if (!analysis.ok) return { ok: false, reason: analysis.reason };

  const commands: ShellRuleCommand[] = [];
  const hidden: string[] = [];
  let ordinaryAsk: string | undefined;
  const globalBlockers: string[] = [];
  // Depth of `|` stages (after the first) being visited.
  let downstream = 0;

  const scanWord = (word: ShellWord, blockers: string[] | null): void => {
    if (literalRuleWord(word.source.raw, "bash") === undefined) (blockers ?? globalBlockers).push("non-literal argument");
    for (const part of word.parts) {
      switch (part.kind) {
        case "substitution":
          (blockers ?? globalBlockers).push("command substitution");
          visit(part.body);
          break;
        case "parameter-choice":
          scanWord(part.operand, blockers);
          break;
        case "unknown":
          hidden.push(part.reason);
          ordinaryAsk ??= part.reason;
          globalBlockers.push(part.reason);
          break;
        default:
          break;
      }
    }
  };

  const visit = (statement: ShellStatement): void => {
    switch (statement.kind) {
      case "command": {
        const blockers: string[] = [];
        if (statement.redirects.length > 0) blockers.push("redirection is outside literal argv identity");
        for (const word of statement.words) scanWord(word, blockers);
        for (const assignment of statement.assignments) {
          scanWord(assignment.value, blockers);
          for (const element of assignment.elements ?? []) scanWord(element, blockers);
        }
        for (const redirect of statement.redirects) {
          if (redirect.target) scanWord(redirect.target, blockers);
          if (redirect.data) scanWord(redirect.data, blockers);
          if (redirect.effect === "write" && !redirect.descriptor) {
            const target = redirect.target ? staticShellWord(redirect.target) : undefined;
            if (target !== "/dev/null") blockers.push("write redirection");
          }
        }
        const arithmetic = arithmeticEvaluationReason(statement);
        if (arithmetic) {
          hidden.push(arithmetic);
          ordinaryAsk ??= arithmetic;
          blockers.push(arithmetic);
        }
        if (statement.words.length === 0) {
          // Assignment-only statements change the environment of every later command (`PATH=/tmp/x; git status`). They are not a command a rule can name, so they block allow for the whole input.
          if (statement.assignments.length > 0) globalBlockers.push("environment assignment");
          return;
        }
        if (statement.assignments.length > 0) blockers.push("command-scoped environment assignment");
        const argv = statement.words.map((word) => staticShellWord(word));
        const encoded = encodedPowerShellExecutionReason(argv);
        if (encoded !== null) blockers.push(encoded);
        ordinaryAsk ??= wrapperCommand(argv).ordinaryAsk ?? opaqueRunnerReason(argv) ?? undefined;
        if (argv[0] === undefined) {
          hidden.push("dynamic program name");
          ordinaryAsk ??= "dynamic program name";
          blockers.push("dynamic program name");
        } else {
          const inner = wrapperPrefixLength(argv);
          if (inner > 0 && inner < argv.length && argv[inner] === undefined) ordinaryAsk ??= "dynamic program name behind a wrapper";
        }
        const rawWords = statement.words.map((word) => literalRuleWord(word.source.raw, "bash") === undefined ? undefined : word.source.raw);
        commands.push({ argv, rawWords, raw: statement.source.raw, allowBlockers: blockers, ...(downstream > 0 ? { piped: true as const } : {}) });
        return;
      }
      case "sequence":
        for (const child of statement.statements) visit(child);
        return;
      case "pipeline":
        for (const [index, child] of statement.statements.entries()) {
          if (index > 0) downstream += 1;
          visit(child);
          if (index > 0) downstream -= 1;
        }
        return;
      case "and":
      case "or":
        visit(statement.left);
        visit(statement.right);
        return;
      case "subshell":
      case "background":
      case "negate":
        visit(statement.body);
        return;
      case "redirected":
        if (statement.redirects.length > 0) globalBlockers.push("redirection is outside literal argv identity");
        for (const redirect of statement.redirects) {
          if (redirect.target) scanWord(redirect.target, null);
          if (redirect.effect === "write" && !redirect.descriptor) {
            const target = redirect.target ? staticShellWord(redirect.target) : undefined;
            if (target !== "/dev/null") globalBlockers.push("write redirection");
          }
        }
        visit(statement.body);
        return;
      case "for":
        for (const value of statement.values ?? []) scanWord(value, null);
        visit(statement.body);
        return;
      case "if":
        visit(statement.condition);
        visit(statement.consequent);
        visit(statement.alternate);
        return;
      case "while":
        visit(statement.condition);
        visit(statement.body);
        return;
      case "function":
        // A definition can shadow a program name an allow rule trusts.
        globalBlockers.push("function definition");
        visit(statement.body);
        return;
      case "unsupported":
        hidden.push(statement.reason);
        ordinaryAsk ??= statement.reason;
        globalBlockers.push(statement.reason);
        return;
      default: {
        const exhaustive: never = statement;
        void exhaustive;
        hidden.push("unknown shell statement");
        ordinaryAsk ??= "unknown shell statement";
        globalBlockers.push("unknown shell statement");
      }
    }
  };

  visit(analysis.program);
  ordinaryAsk ??= shellScanOrdinaryAsk(parsed, cwd) ?? undefined;
  return { ok: true, commands, hidden, ...(ordinaryAsk ? { ordinaryAsk } : {}), allowBlockers: globalBlockers };
}

export function proveLiteralShell(input: ShellCommandInput, cwd?: string): { proven: true; commands: readonly ShellRuleCommand[] } | { proven: false; reason: string } {
  const parsed = asParsedShellCommand(input);
  const shape = analyzeShellForRules(parsed, cwd);
  if (!shape.ok) return { proven: false, reason: shape.reason };
  const reason = shape.hidden[0] ?? shape.allowBlockers[0] ?? shape.commands.flatMap((cmd) => cmd.allowBlockers)[0];
  if (reason !== undefined) return { proven: false, reason };
  if (shape.commands.length === 0 || shape.commands.some((cmd) => cmd.argv.includes(undefined))) return { proven: false, reason: "non-literal command" };
  const incomplete = shellScanProofBlocker(parsed, cwd);
  if (incomplete !== null) return { proven: false, reason: incomplete };
  return { proven: true, commands: shape.commands };
}

// Exact/prefix match on static argv (allow semantics: no wrapper stripping, no basename folding).
function matchesBashRuleExact(spec: BashRuleSpecifier, argv: readonly (string | undefined)[]): boolean {
  if (argv.length < spec.tokens.length) return false;
  if (!spec.wildcard && argv.length !== spec.tokens.length) return false;
  return spec.tokens.every((token, index) => argv[index] === token);
}

// Deny/ask semantics: argv0 compares by program basename (`/bin/rm`); when argv0 is a wrapper program (`sudo -u root rm`, `env A=1 rm`, `timeout 5 rm`, `xargs rm`, `busybox rm`) the rule may start at ANY later word — wrapper option grammars differ too much to skip them exactly; and a multi-verb tool's global options are also tried stripped (`git -C. push` matches `Bash(git push *)`). This only ever widens what a deny/ask rule sees; allow matching never strips wrappers or options.
function matchesBashRuleForRestriction(spec: BashRuleSpecifier, argv: readonly (string | undefined)[]): boolean {
  const head = argv[0];
  const starts = head !== undefined && isShellWrapperProgram(head)
    ? argv.map((_, index) => index)
    : [0];
  const matchesWindow = (window: readonly (string | undefined)[]): boolean => {
    if (window.length < spec.tokens.length) return false;
    if (!spec.wildcard && window.length !== spec.tokens.length) return false;
    return spec.tokens.every((rawToken, offset) => {
      const token = literalRuleWord(rawToken, "bash");
      if (token === undefined) return false;
      const actual = window[offset];
      if (actual === undefined) return false;
      return offset === 0 ? actual === token || baseProgram(actual) === token : actual === token;
    });
  };
  return starts.some((start) => {
    const window = argv.slice(start);
    return matchesWindow(window) || matchesWindow(stripGlobalOptions(window));
  });
}

export interface ShellRuleInput {
  pattern: string;
  spec: BashRuleSpecifier;
}

export interface ShellRuleSet {
  deny: readonly ShellRuleInput[];
  ask: readonly ShellRuleInput[];
  allow: readonly ShellRuleInput[];
}

export type ShellRuleEvaluation =
  | { decision: "deny" | "ask"; pattern: string; reason: string }
  | { decision: "ask"; pattern: null; reason: string }
  | { decision: "allow"; patterns: readonly string[]; reason: string }
  | { decision: null; reason: string };

export function evaluateShellRules(input: ShellCommandInput, rules: ShellRuleSet, cwd?: string): ShellRuleEvaluation {
  const parsed = asParsedShellCommand(input);
  const command = parsed.command;
  const hasRestrictions = rules.deny.length > 0 || rules.ask.length > 0;
  if (!hasRestrictions && rules.allow.length === 0) return { decision: null, reason: "no shell rules" };
  const shape = analyzeShellForRules(parsed, cwd);

  if (hasRestrictions) {
    // deny > ask: a deny rule that matches a visible command wins even when another part of the input is hidden; hidden code then asks, because a deny rule the matcher could not evaluate must not be bypassed.
    const visible = shape.ok ? shape.commands : [];
    const matching = (list: readonly ShellRuleInput[]): ShellRuleInput | undefined =>
      list.find((rule) => visible.some((cmd) => matchesBashRuleForRestriction(rule.spec, cmd.argv)));
    const deny = matching(rules.deny);
    if (deny) return { decision: "deny", pattern: deny.pattern, reason: `deny rule ${deny.pattern}` };
    if (!shape.ok || shape.hidden.length > 0) {
      return {
        decision: "ask",
        pattern: null,
        reason: `shell rules could not inspect every command (${shape.ok ? shape.hidden[0] : shape.reason})`,
      };
    }
    const ask = matching(rules.ask);
    if (ask) return { decision: "ask", pattern: ask.pattern, reason: `ask rule ${ask.pattern}` };
  }

  if (rules.allow.length === 0) return { decision: null, reason: "no allow rule" };
  if (!shape.ok) return { decision: null, reason: `unparseable: ${shape.reason}` };
  if (shape.hidden.length > 0) return { decision: null, reason: shape.hidden[0]! };
  if (shape.allowBlockers.length > 0) return { decision: null, reason: shape.allowBlockers[0]! };
  if (shape.commands.length === 0) return { decision: null, reason: "no command" };
  // Floor: destructive text anywhere is never covered by an allow rule.
  if (isDestructiveShellText(command)
    || shape.commands.some((cmd) => isDestructiveShellText(cmd.raw) || isDestructiveShellArgv(cmd.argv))) {
    return { decision: null, reason: "destructive command (floor)" };
  }
  // Irreversible forms remain outside reusable command permission.
  for (const cmd of shape.commands) {
    const unreusable = noReusableRuleReason(cmd.argv);
    if (unreusable) return { decision: null, reason: `${unreusable} (no allow rule covers it)` };
  }
  const exfiltration = shellExfiltrationSignal(parsed, cwd);
  if (exfiltration) return { decision: null, reason: `credential exfiltration (floor): ${exfiltration}` };
  const sensitive = shellSensitivePathSignal(parsed, cwd);
  if (sensitive) return { decision: null, reason: `sensitive path (floor): ${sensitive}` };
  const incomplete = shellScanProofBlocker(parsed, cwd);
  if (incomplete) return { decision: null, reason: incomplete };
  const patterns: string[] = [];
  for (const cmd of shape.commands) {
    if (cmd.allowBlockers.length > 0) return { decision: null, reason: cmd.allowBlockers[0]! };
    const rule = rules.allow.find((candidate) => matchesBashRuleExact(candidate.spec, cmd.rawWords));
    if (!rule) return { decision: null, reason: "a subcommand is not covered by any allow rule" };
    if (!patterns.includes(rule.pattern)) patterns.push(rule.pattern);
  }
  return { decision: "allow", patterns, reason: `allow rules ${patterns.join(", ")}` };
}
