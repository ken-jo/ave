import { maskSensitiveData } from "../../audit/dlp-filter.js";
import type { ShellRuleApproval, ShellRuleDialect } from "../../shared/permissions-events.js";
import { analyzeShellForRules, evaluateShellRules, proveLiteralShell } from "./shell-rule-matcher.js";
import { canonicalRuleSpecifier, formatRuleSpecifier, parseRuleSpecifier } from "./rule-specifier.js";
import { inspectPowerShellCommand, powerShellRuleShape, proveLiteralPowerShell } from "./powershell-exfiltration.js";
import { evaluatePowerShellSubject } from "./rule-scopes.js";
import { parseShellCommand } from "./shell-prefix-policy.js";
import { isDestructiveShellText } from "../reviewer/risk-classifier.js";
import { shellExfiltrationSignal, shellSensitivePathSignal } from "./shell-exfiltration.js";
import { validatePermissionRule } from "./rule-files.js";
import { isDestructiveShellArgv, noReusableRuleReason, MAX_LITERAL_COMMAND_LENGTH } from "./shell-prefix-values.js";
import { projectRuleRoot } from "./project-rule-files.js";
import { decodePowerShellEncodedCommands } from "./powershell-encoded-command.js";

// Derive the one exact rule a shell card may save from the host's original shell input: the complete argv of a single simple command, never a prefix or wildcard (owner 2026-10-25). `Bash(...)` for bash and `PowerShell(...)` for PowerShell, each in the canonical form its matcher compares.
export function buildShellRuleApproval(
  dialect: ShellRuleDialect,
  command: string,
  projectCwd: string,
  saves: { allow: boolean; deny: boolean },
  sessionId?: string,
): ShellRuleApproval {
  const decodedCommands = decodePowerShellEncodedCommands(command, dialect);
  const candidate = saves.allow && command.length <= MAX_LITERAL_COMMAND_LENGTH
    ? dialect === "bash" ? exactBashRule(command, projectCwd) : exactPowerShellRule(command, projectCwd)
    : null;
  // The rule must cover this whole invocation and disclose no secret.
  const exactRule = candidate !== null && maskSensitiveData(candidate).masked === candidate && suggestionCovers(dialect, candidate, "allow", command, projectCwd)
    ? candidate : null;
  const denyCandidate = saves.deny ? literalCommandRule(dialect, command) : null;
  const denyRule = denyCandidate !== null && maskSensitiveData(denyCandidate).masked === denyCandidate && suggestionCovers(dialect, denyCandidate, "deny", command, projectCwd)
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

function exactBashRule(command: string, projectCwd: string): string | null {
  const parsed = parseShellCommand(command);
  const shape = analyzeShellForRules(parsed, projectCwd);
  const proof = proveLiteralShell(parsed, projectCwd);
  if (!parsed.analysis.ok || parsed.analysis.program.kind !== "sequence" || parsed.analysis.program.statements.length !== 1
    || parsed.analysis.program.statements[0]?.kind !== "command") return null;
  const floor = isDestructiveShellText(command)
    || (shape.ok && shape.commands.some((cmd) => isDestructiveShellArgv(cmd.argv) || noReusableRuleReason(cmd.argv) !== null))
    || shellExfiltrationSignal(parsed, projectCwd) !== null || shellSensitivePathSignal(parsed, projectCwd) !== null;
  if (floor || !proof.proven || proof.commands.length !== 1 || !proof.commands[0]) return null;
  const tokens = literalTokens(proof.commands[0].argv);
  try {
    return tokens ? canonicalRuleSpecifier(formatRuleSpecifier({ kind: "bash", tokens, wildcard: false })) : null;
  } catch { return null; }
}

function exactPowerShellRule(command: string, projectCwd: string): string | null {
  const signals = inspectPowerShellCommand(command, projectCwd);
  if (signals.exfiltration !== null || signals.sensitive !== null || signals.analysisLimited || isDestructiveShellText(command)) return null;
  const proof = proveLiteralPowerShell(command);
  if (!proof.proven || proof.commands.length !== 1) return null;
  const tokens = literalTokens(proof.commands[0]!);
  if (tokens === null) return null;
  try {
    const pattern = formatRuleSpecifier({ kind: "powershell", tokens, wildcard: false, ...(proof.literalParameters?.[0] ? { literalParameters: proof.literalParameters[0] } : {}) });
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
function literalCommandRule(dialect: ShellRuleDialect, command: string): string | null {
  if (command.length > MAX_LITERAL_COMMAND_LENGTH) return null;
  let tokens: string[] | null = null;
  let literalParameters: readonly number[] | undefined;
  if (dialect === "bash") {
    const shape = analyzeShellForRules(parseShellCommand(command));
    if (shape.ok && shape.hidden.length === 0 && shape.commands.length === 1) tokens = literalTokens(shape.commands[0]!.argv);
  } else {
    const shape = powerShellRuleShape(command);
    if (shape.ok && shape.opaque === null && shape.commands.length === 1) {
      tokens = literalTokens(shape.commands[0]!);
      literalParameters = shape.literalParameters?.[0];
    }
  }
  if (tokens === null || tokens.length === 0) return null;
  try {
    const pattern = formatRuleSpecifier({ kind: dialect, tokens: [...tokens], wildcard: false, ...(literalParameters ? { literalParameters } : {}) });
    return canonicalRuleSpecifier(pattern) === pattern ? pattern : null;
  } catch {
    return null;
  }
}

function suggestionCovers(dialect: ShellRuleDialect, pattern: string, action: "allow" | "deny", command: string, cwd: string): boolean {
  try {
    return shellRuleCoversCommand(dialect, pattern, action, command, cwd);
  } catch {
    // A candidate the store would refuse is simply not offered.
    return false;
  }
}

// Reuse the strict store validator and matcher for a rule a card saves: true when `pattern` is a storable rule of the call's own shell dialect and, as `action`, decides this command (an allow covers it, a deny refuses it). Throws RuleSpecifierError for text outside the rule language.
export function shellRuleCoversCommand(dialect: ShellRuleDialect, pattern: string, action: "allow" | "deny", command: string, cwd: string): boolean {
  if (maskSensitiveData(pattern).masked !== pattern) return false;
  const rule = validatePermissionRule({ pattern, action });
  const spec = parseRuleSpecifier(pattern);
  if (dialect === "bash") {
    if (spec.kind !== "bash") return false;
    const input = { pattern, spec };
    const result = evaluateShellRules(command, { allow: action === "allow" ? [input] : [], deny: action === "deny" ? [input] : [], ask: [] }, cwd);
    return result.decision === action;
  }
  if (spec.kind !== "powershell") return false;
  const signals = inspectPowerShellCommand(command, cwd);
  const result = evaluatePowerShellSubject({
    command,
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
