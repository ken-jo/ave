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
 *    anything a floor catches (destructive, credential exfiltration, a
 *    sensitive path anywhere in the command).
 *  - When the tree hides code from deny/ask (unparseable, unsupported,
 *    dynamic program name, a shell/interpreter fed code by any route — `-c`,
 *    stdin pipe, here-string, here-document, `-s`, `-`, a script file — or a
 *    code carrier / code-executing option from `shell-prefix-policy.ts`) and
 *    the user has any deny/ask Bash rule, the result is `ask` unless a deny
 *    rule already matched a visible command: a deny rule the matcher could not
 *    evaluate must not be bypassed by the mode. Hidden code is never allowed.
 */
import {
  analyzeShell,
  staticShellWord,
  type ShellStatement,
  type ShellWord,
} from "../../shared/shell-analysis.js";
import { isDestructiveShellText } from "../reviewer/risk-classifier.js";
import { errorMessage } from "../../shared/error-message.js";
import type { RuleSpecifier } from "./rule-specifier.js";
import { shellExfiltrationSignal, shellSensitivePathSignal } from "./shell-exfiltration.js";
import {
  codeCarryingVariable,
  hiddenCodeReason,
  isShellWrapperProgram,
  shellOptionEffect,
  stripGlobalOptions,
} from "./shell-prefix-policy.js";

type BashRuleSpecifier = Extract<RuleSpecifier, { kind: "bash" }>;

interface ShellRuleCommand {
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

function baseProgram(token: string): string {
  return (token.split(/[\\/]/).pop() ?? token).replace(/\.exe$/i, "").replace(/^(python[23]?)\.\d+$/, "$1");
}

export function analyzeShellForRules(command: string): ShellRuleShape {
  let analysis: ReturnType<typeof analyzeShell>;
  try {
    analysis = analyzeShell(command, "bash");
  } catch (error) {
    // A broken parser runtime is an internal failure the matcher cannot
    // reason around; report it as unparseable (asks, never allows).
    return { ok: false, reason: `shell parser failed: ${errorMessage(error)}` };
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
        for (const assignment of statement.assignments) {
          // `GIT_SSH_COMMAND='rm x' git fetch`, `PATH=/tmp/x; git status`.
          if (codeCarryingVariable(assignment.name)) hidden.push(`code-carrying variable ${assignment.name}`);
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
          // `bash -c "rm …"`, `echo … | bash`, `bash <<<…`, `node x.js`,
          // `eval "…"`, `find -exec rm`, `sed 'e …'`: the code is a string,
          // a file or stdin the matcher does not read, so deny/ask cannot
          // see inside it and no allow rule covers it.
          const hiddenCode = hiddenCodeReason(argv);
          if (hiddenCode) {
            hidden.push(hiddenCode);
            blockers.push(hiddenCode);
          }
          const effect = shellOptionEffect(argv);
          if (effect) blockers.push(effect.reason);
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
function matchesBashRuleExact(spec: BashRuleSpecifier, argv: readonly (string | undefined)[]): boolean {
  if (argv.length < spec.tokens.length) return false;
  if (!spec.wildcard && argv.length !== spec.tokens.length) return false;
  return spec.tokens.every((token, index) => argv[index] === token);
}

/**
 * Deny/ask semantics: argv0 compares by program basename (`/bin/rm`); when
 * argv0 is a wrapper program (`sudo -u root rm`, `env A=1 rm`, `timeout 5 rm`,
 * `xargs rm`, `busybox rm`) the rule may start at ANY later word — wrapper
 * option grammars differ too much to skip them exactly; and a multi-verb
 * tool's global options are also tried stripped (`git -C . push` matches
 * `Bash(git push *)`). This only ever widens what a deny/ask rule sees; allow
 * matching never strips wrappers or options.
 */
function matchesBashRuleForRestriction(spec: BashRuleSpecifier, argv: readonly (string | undefined)[]): boolean {
  const head = argv[0];
  const starts = head !== undefined && isShellWrapperProgram(head)
    ? argv.map((_, index) => index)
    : [0];
  const matchesWindow = (window: readonly (string | undefined)[]): boolean => {
    if (window.length < spec.tokens.length) return false;
    if (!spec.wildcard && window.length !== spec.tokens.length) return false;
    return spec.tokens.every((token, offset) => {
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

export function evaluateShellRules(command: string, rules: ShellRuleSet, cwd?: string): ShellRuleEvaluation {
  const hasRestrictions = rules.deny.length > 0 || rules.ask.length > 0;
  if (!hasRestrictions && rules.allow.length === 0) return { decision: null, reason: "no shell rules" };
  const shape = analyzeShellForRules(command);

  if (hasRestrictions) {
    // deny > ask: a deny rule that matches a visible command wins even when
    // another part of the input is hidden; hidden code then asks, because a
    // deny rule the matcher could not evaluate must not be bypassed.
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
  if (isDestructiveShellText(command) || shape.commands.some((cmd) => isDestructiveShellText(cmd.raw))) {
    return { decision: null, reason: "destructive command (floor)" };
  }
  const exfiltration = shellExfiltrationSignal(command, cwd);
  if (exfiltration) return { decision: null, reason: `credential exfiltration (floor): ${exfiltration}` };
  const sensitive = shellSensitivePathSignal(command, cwd);
  if (sensitive) return { decision: null, reason: `sensitive path (floor): ${sensitive}` };
  const patterns: string[] = [];
  for (const cmd of shape.commands) {
    if (cmd.allowBlockers.length > 0) return { decision: null, reason: cmd.allowBlockers[0]! };
    const rule = rules.allow.find((candidate) => matchesBashRuleExact(candidate.spec, cmd.argv));
    if (!rule) return { decision: null, reason: "a subcommand is not covered by any allow rule" };
    if (!patterns.includes(rule.pattern)) patterns.push(rule.pattern);
  }
  return { decision: "allow", patterns, reason: `allow rules ${patterns.join(", ")}` };
}
