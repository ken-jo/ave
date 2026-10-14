/**
 * Shell rule matcher (issue #28, P1a).
 *
 * Matches `Bash(...)` rules against the host's typed shell AST
 * (`shared/shell-analysis.ts`, mvdan/sh grammar). Contract:
 *
 *  - deny > ask > allow, regardless of specificity; first match within a class.
 *  - Deny/ask look at EVERY simple command in the tree, including `$()` /
 *    backtick / process-substitution bodies, subshells, loop and conditional
 *    bodies, function bodies, and through wrapper programs (`sudo rm …`).
 *  - Allow requires EVERY simple command to be covered by some allow rule
 *    (different rules may cover different subcommands), and refuses whole
 *    inputs it cannot reason about: parse failure, unsupported syntax, opaque
 *    word expansions, substitutions, command-scoped assignments, write
 *    redirections, function definitions, assignment-only statements, and
 *    anything the rule classifier grades destructive (floor).
 *  - When the tree hides commands from deny/ask (unparseable, unsupported,
 *    dynamic program name, or code passed as a string to a shell/interpreter/
 *    eval) and the user has any deny/ask Bash rule, the result is `ask`: a
 *    deny rule the matcher could not evaluate must not be bypassed by the mode.
 */
import {
  analyzeShell,
  staticShellWord,
  type ShellStatement,
  type ShellWord,
} from "../../shared/shell-analysis.js";
import { isDestructiveShellText } from "../reviewer/risk-classifier.js";
import type { RuleSpecifier } from "./rule-specifier.js";
import { SHELL_PREFIX_POLICY, isShellWrapperProgram } from "./shell-prefix-policy.js";

export type BashRuleSpecifier = Extract<RuleSpecifier, { kind: "bash" }>;

export interface ShellRuleCommand {
  /** One entry per word; `undefined` where the word is not a static literal. */
  argv: readonly (string | undefined)[];
  raw: string;
  /** Reasons this simple command can never be covered by an allow rule. */
  allowBlockers: readonly string[];
}

export type ShellRuleShape =
  | {
      ok: true;
      commands: readonly ShellRuleCommand[];
      /** Reasons commands may be invisible to deny/ask matching. */
      hidden: readonly string[];
      /** Whole-input reasons no allow rule can apply. */
      allowBlockers: readonly string[];
    }
  | { ok: false; reason: string };

const SHELL_PROGRAMS = new Set(SHELL_PREFIX_POLICY.shells);
const INTERPRETER_PROGRAMS = new Set(SHELL_PREFIX_POLICY.interpreters);
const AWK_PROGRAMS = new Set(["awk", "gawk", "mawk", "nawk"]);
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "-E", "-p", "-r", "--eval", "--print", "--command", "eval"]);

function baseProgram(token: string): string {
  return (token.split(/[\\/]/).pop() ?? token).replace(/\.exe$/i, "").replace(/^(python[23]?)\.\d+$/, "$1");
}

/** Reason when this argv carries code the matcher cannot see into, else null. */
function codeStringCarrier(argv: readonly (string | undefined)[]): string | null {
  const program = baseProgram(argv[0]!);
  const args = argv.slice(1);
  if (args.length === 0) return null;
  if (program === "eval") return "code passed to eval";
  if (AWK_PROGRAMS.has(program)) return `program passed to ${program}`;
  if (SHELL_PROGRAMS.has(program)) {
    // `-c`, and combined short flags such as `-lc` / `-ec`.
    if (args.some((arg) => arg === undefined || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg) || arg === "-Command" || arg === "/c")) {
      return `code passed to ${program}`;
    }
    return null;
  }
  if (INTERPRETER_PROGRAMS.has(program)) {
    if (args.some((arg) => arg === undefined || INLINE_CODE_FLAGS.has(arg))) return `code passed to ${program}`;
    return null;
  }
  if (program === "find" && args.some((arg) => arg === undefined || /^-(?:exec|execdir|ok|okdir)$/.test(arg))) {
    return "command passed to find -exec";
  }
  return null;
}

export function analyzeShellForRules(command: string): ShellRuleShape {
  let analysis: ReturnType<typeof analyzeShell>;
  try {
    analysis = analyzeShell(command, "bash");
  } catch (error) {
    // A broken parser runtime is an internal failure the matcher cannot
    // reason around; report it as unparseable (asks, never allows).
    return { ok: false, reason: `shell parser failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!analysis.ok) return { ok: false, reason: analysis.reason };

  const commands: ShellRuleCommand[] = [];
  const hidden: string[] = [];
  const globalBlockers: string[] = [];

  const scanWord = (word: ShellWord, blockers: string[] | null): void => {
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
        if (statement.words.length === 0) {
          // Assignment-only statements change the environment of every later
          // command (`PATH=/tmp/x; git status`). They are not a command a rule
          // can name, so they block allow for the whole input.
          if (statement.assignments.length > 0) globalBlockers.push("environment assignment");
          return;
        }
        if (statement.assignments.length > 0) blockers.push("command-scoped environment assignment");
        const argv = statement.words.map((word) => staticShellWord(word));
        if (argv[0] === undefined) {
          hidden.push("dynamic program name");
          blockers.push("dynamic program name");
        } else {
          // `bash -c "rm …"` / `eval "…"` / `find -exec rm`: the code is a
          // string or argv the matcher does not re-parse, so deny/ask cannot
          // see inside it.
          const hiddenCode = codeStringCarrier(argv);
          if (hiddenCode) hidden.push(hiddenCode);
        }
        commands.push({ argv, raw: statement.source.raw, allowBlockers: blockers });
        return;
      }
      case "sequence":
      case "pipeline":
        for (const child of statement.statements) visit(child);
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
        globalBlockers.push(statement.reason);
        return;
      default: {
        const exhaustive: never = statement;
        void exhaustive;
        hidden.push("unknown shell statement");
        globalBlockers.push("unknown shell statement");
      }
    }
  };

  visit(analysis.program);
  return { ok: true, commands, hidden, allowBlockers: globalBlockers };
}

/** Exact/prefix match on static argv (allow semantics: no wrapper stripping, no basename folding). */
export function matchesBashRuleExact(spec: BashRuleSpecifier, argv: readonly (string | undefined)[]): boolean {
  if (argv.length < spec.tokens.length) return false;
  if (!spec.wildcard && argv.length !== spec.tokens.length) return false;
  return spec.tokens.every((token, index) => argv[index] === token);
}

/**
 * Deny/ask semantics: argv0 compares by program basename (`/bin/rm`), and when
 * argv0 is a wrapper program (`sudo -u root rm`, `env A=1 rm`, `timeout 5 rm`,
 * `xargs rm`) the rule may start at ANY later word — wrapper option grammars
 * differ too much to skip them exactly. This only ever widens what a deny/ask
 * rule sees; allow matching never strips wrappers.
 */
export function matchesBashRuleForRestriction(spec: BashRuleSpecifier, argv: readonly (string | undefined)[]): boolean {
  const head = argv[0];
  const starts = head !== undefined && isShellWrapperProgram(head)
    ? argv.map((_, index) => index)
    : [0];
  return starts.some((start) => {
    const window = argv.slice(start);
    if (window.length < spec.tokens.length) return false;
    if (!spec.wildcard && window.length !== spec.tokens.length) return false;
    return spec.tokens.every((token, offset) => {
      const actual = window[offset];
      if (actual === undefined) return false;
      return offset === 0 ? actual === token || baseProgram(actual) === token : actual === token;
    });
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

export function evaluateShellRules(command: string, rules: ShellRuleSet): ShellRuleEvaluation {
  const hasRestrictions = rules.deny.length > 0 || rules.ask.length > 0;
  if (!hasRestrictions && rules.allow.length === 0) return { decision: null, reason: "no shell rules" };
  const shape = analyzeShellForRules(command);

  if (hasRestrictions) {
    if (!shape.ok || shape.hidden.length > 0) {
      return {
        decision: "ask",
        pattern: null,
        reason: `shell rules could not inspect every command (${shape.ok ? shape.hidden[0] : shape.reason})`,
      };
    }
    for (const [decision, list] of [["deny", rules.deny], ["ask", rules.ask]] as const) {
      for (const rule of list) {
        if (shape.commands.some((cmd) => matchesBashRuleForRestriction(rule.spec, cmd.argv))) {
          return { decision, pattern: rule.pattern, reason: `${decision} rule ${rule.pattern}` };
        }
      }
    }
  }

  if (rules.allow.length === 0) return { decision: null, reason: "no allow rule" };
  if (!shape.ok) return { decision: null, reason: `unparseable: ${shape.reason}` };
  if (shape.hidden.length > 0) return { decision: null, reason: shape.hidden[0]! };
  if (shape.allowBlockers.length > 0) return { decision: null, reason: shape.allowBlockers[0]! };
  if (shape.commands.length === 0) return { decision: null, reason: "no command" };
  // Floor: destructive text anywhere is never covered by an allow rule.
  if (isDestructiveShellText(command) || shape.commands.some((cmd) => isDestructiveShellText(cmd.raw))) {
    return { decision: null, reason: "destructive command (floor)" };
  }
  const patterns: string[] = [];
  for (const cmd of shape.commands) {
    if (cmd.allowBlockers.length > 0) return { decision: null, reason: cmd.allowBlockers[0]! };
    const rule = rules.allow.find((candidate) => matchesBashRuleExact(candidate.spec, cmd.argv));
    if (!rule) return { decision: null, reason: "a subcommand is not covered by any allow rule" };
    if (!patterns.includes(rule.pattern)) patterns.push(rule.pattern);
  }
  return { decision: "allow", patterns, reason: `allow rules ${patterns.join(", ")}` };
}
