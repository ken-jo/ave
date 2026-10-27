import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { maskSensitiveData } from "../../audit/dlp-filter.js";
import type { ShellRuleApproval, ShellRuleDialect } from "../../shared/permissions-events.js";
import { analyzeShellForRules, evaluateShellRules, proveLiteralShell } from "./shell-rule-matcher.js";
import { canonicalRuleSpecifier, formatRuleSpecifier, parseRuleSpecifier } from "./rule-specifier.js";
import { inspectPowerShellCommand, parsePowerShellCommand, powerShellRuleShape, proveLiteralPowerShell, type ParsedPowerShellCommand } from "./powershell-exfiltration.js";
import { evaluatePowerShellSubject } from "./rule-scopes.js";
import { parseShellCommand, type ParsedShellCommand } from "./shell-prefix-policy.js";
import { isDestructiveShellText } from "../reviewer/risk-classifier.js";
import { inspectShellCommand } from "./shell-exfiltration.js";
import { validatePermissionRule } from "./rule-files.js";
import { isDestructiveShellArgv, noReusableRuleReason, MAX_LITERAL_COMMAND_LENGTH } from "./shell-prefix-values.js";
import { projectRuleRoot } from "./project-rule-files.js";
import { decodePowerShellEncodedCommands } from "./powershell-encoded-command.js";

interface CommandSyntax { bash?: ParsedShellCommand; powershell?: ParsedPowerShellCommand }

function commandSyntax(dialect: ShellRuleDialect, command: string): CommandSyntax {
  if (command.length > MAX_LITERAL_COMMAND_LENGTH) return {};
  return dialect === "bash" ? { bash: parseShellCommand(command) } : { powershell: parsePowerShellCommand(command) };
}

// Derive the one exact rule a shell card may save from the host's original shell input: the complete argv of a single simple command, never a prefix or wildcard (owner 2026-10-25). `Bash(...)` for bash and `PowerShell(...)` for PowerShell, each in the canonical form its matcher compares.
export function buildShellRuleApproval(
  dialect: ShellRuleDialect,
  command: string,
  projectCwd: string,
  saves: { allow: boolean; deny: boolean },
  sessionId?: string,
): ShellRuleApproval {
  const decodedCommands = decodePowerShellEncodedCommands(command, dialect);
  const syntax = commandSyntax(dialect, command);
  const candidate = saves.allow && command.length <= MAX_LITERAL_COMMAND_LENGTH
    ? dialect === "bash" ? exactBashRule(syntax.bash!, projectCwd) : exactPowerShellRule(syntax.powershell!, projectCwd)
    : null;
  // The rule must cover this whole invocation and disclose no secret.
  const exactRule = candidate !== null && maskSensitiveData(candidate).masked === candidate && suggestionCovers(dialect, candidate, "allow", command, projectCwd, syntax)
    ? candidate : null;
  const denyCandidate = saves.deny ? literalCommandRule(dialect, command, syntax) : null;
  const denyRule = denyCandidate !== null && maskSensitiveData(denyCandidate).masked === denyCandidate && suggestionCovers(dialect, denyCandidate, "deny", command, projectCwd, syntax)
    ? denyCandidate : null;
  return {
    dialect,
    exactRule,
    denyRule,
    denyAllowed: saves.deny,
    projectCwd,
    projectRoot: projectRuleRoot(projectCwd),
    ...(decodedCommands.length === 0 ? {} : { decodedCommands }),
    sessionAllowed: exactRule !== null && Boolean(sessionId),
    persistentAllowed: exactRule !== null,
  };
}

function exactBashRule(parsed: ParsedShellCommand, projectCwd: string): string | null {
  const command = parsed.command;
  const shape = analyzeShellForRules(parsed, projectCwd);
  const signals = inspectShellCommand(parsed, projectCwd);
  const proof = proveLiteralShell(parsed, projectCwd);
  if (!parsed.analysis.ok || parsed.analysis.program.kind !== "sequence" || parsed.analysis.program.statements.length !== 1
    || parsed.analysis.program.statements[0]?.kind !== "command") return null;
  const floor = (signals.exactLiteralEvaluation !== true && isDestructiveShellText(command))
    || (shape.ok && shape.commands.some((cmd) => isDestructiveShellArgv(cmd.argv) || noReusableRuleReason(cmd.argv) !== null))
    || signals.exfiltration !== null || signals.sensitive !== null || signals.analysisLimited
    || (signals.outcome === "unproven" && signals.exactLiteralEvaluation !== true);
  if (floor || !proof.proven || proof.commands.length !== 1 || !proof.commands[0]) return null;
  const tokens = literalTokens(proof.commands[0].rawWords);
  try {
    return tokens ? canonicalRuleSpecifier(formatRuleSpecifier({ kind: "bash", tokens, wildcard: false })) : null;
  } catch { return null; }
}

function exactPowerShellRule(parsed: ParsedPowerShellCommand, projectCwd: string): string | null {
  const command = parsed.command;
  const signals = inspectPowerShellCommand(parsed, projectCwd);
  if (signals.exfiltration !== null || signals.sensitive !== null || signals.analysisLimited
    || (signals.exactLiteralEvaluation !== true && isDestructiveShellText(command))
    || (signals.outcome === "unproven" && signals.exactLiteralEvaluation !== true)) return null;
  const proof = proveLiteralPowerShell(parsed);
  if (!proof.proven || proof.commands.length !== 1) return null;
  const tokens = literalTokens(proof.commands[0]!);
  if (tokens === null) return null;
  try {
    const pattern = formatRuleSpecifier({ kind: "powershell", tokens, wildcard: false });
    // The literal argv must also be a storable rule (no syntax the grammar refuses).
    return canonicalRuleSpecifier(pattern) === pattern ? pattern : null;
  } catch {
    return null;
  }
}

// The argv when every word is literal text, else null.
function literalTokens(argv: readonly (string | null | undefined)[]): string[] | null {
  return argv.every((word): word is string => typeof word === "string") ? [...argv] as string[] : null;
}

// The literal argv of a single simple command as a rule, whatever its floors: the suggestion "Always deny" stores.
function literalCommandRule(dialect: ShellRuleDialect, command: string, syntax: CommandSyntax): string | null {
  if (command.length > MAX_LITERAL_COMMAND_LENGTH) return null;
  let tokens: string[] | null = null;
  if (dialect === "bash") {
    const shape = analyzeShellForRules(syntax.bash!);
    if (shape.ok && shape.hidden.length === 0 && shape.commands.length === 1) tokens = literalTokens(shape.commands[0]!.rawWords);
  } else {
    const shape = powerShellRuleShape(syntax.powershell!);
    if (shape.ok && shape.opaque === null && shape.commands.length === 1) {
      tokens = literalTokens(shape.commands[0]!);
    }
  }
  if (tokens === null || tokens.length === 0) return null;
  try {
    const pattern = formatRuleSpecifier({ kind: dialect, tokens: [...tokens], wildcard: false });
    return canonicalRuleSpecifier(pattern) === pattern ? pattern : null;
  } catch {
    return null;
  }
}

function suggestionCovers(dialect: ShellRuleDialect, pattern: string, action: "allow" | "deny", command: string, cwd: string, syntax: CommandSyntax): boolean {
  try {
    return shellRuleCoversParsedCommand(dialect, pattern, action, command, cwd, syntax);
  } catch {
    // A candidate the store would refuse is simply not offered.
    return false;
  }
}

// Reuse the strict store validator and matcher for a rule a card saves: true when `pattern` is a storable rule of the call's own shell dialect and, as `action`, decides this command (an allow covers it, a deny refuses it). Throws RuleSpecifierError for text outside the rule language.
export function shellRuleCoversCommand(dialect: ShellRuleDialect, pattern: string, action: "allow" | "deny", command: string, cwd: string): boolean {
  return shellRuleCoversParsedCommand(dialect, pattern, action, command, cwd, commandSyntax(dialect, command));
}

function shellRuleCoversParsedCommand(dialect: ShellRuleDialect, pattern: string, action: "allow" | "deny", command: string, cwd: string, syntax: CommandSyntax): boolean {
  if (maskSensitiveData(pattern).masked !== pattern) return false;
  const rule = validatePermissionRule(withCurrentShellRuleVersion({ pattern, action }));
  const spec = parseRuleSpecifier(pattern);
  if (dialect === "bash") {
    if (spec.kind !== "bash") return false;
    const input = { pattern, spec };
    const result = evaluateShellRules(syntax.bash ?? command, { allow: action === "allow" ? [input] : [], deny: action === "deny" ? [input] : [], ask: [] }, cwd);
    return result.decision === action;
  }
  if (spec.kind !== "powershell") return false;
  const parsed = syntax.powershell ?? parsePowerShellCommand(command);
  const signals = inspectPowerShellCommand(parsed, cwd);
  const result = evaluatePowerShellSubject({
    command: parsed,
    cwd,
    exactAllowOnly: false,
    floorSignal: signals.exfiltration ?? signals.sensitive ?? (signals.analysisLimited ? "PowerShell analysis budget exceeded" : null),
  }, [rule]);
  return result.decision === action;
}

// The wildcard allow warning a card shows for an edited rule (owner 2026-10-25): a wildcard allow applies only to sandboxed runs, because a shell without a sandbox runs unasked only on an exact rule.
export function isWildcardShellRule(pattern: string): boolean {
  const spec = parseRuleSpecifier(pattern);
  return (spec.kind === "bash" || spec.kind === "powershell") && spec.wildcard;
}
