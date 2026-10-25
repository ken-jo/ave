import { maskSensitiveData } from "../../audit/dlp-filter.js";
import type { ShellRuleApproval } from "../../shared/permissions-events.js";
import { analyzeShellForRules, evaluateShellRules } from "./shell-rule-matcher.js";
import { formatRuleSpecifier, parseRuleSpecifier } from "./rule-specifier.js";
import { parseShellCommand, suggestShellPrefix } from "./shell-prefix-policy.js";
import { isDestructiveShellText } from "../reviewer/risk-classifier.js";
import { shellExfiltrationSignal, shellSensitivePathSignal } from "./shell-exfiltration.js";
import { validatePermissionRule } from "./rule-files.js";
import { isDestructiveShellArgv, noReusableRuleReason } from "./shell-prefix-values.js";
import { projectRuleRoot } from "./project-rule-files.js";

// Derive display suggestions only from the host's original shell input.
export function buildShellRuleApproval(command: string, projectCwd: string, rememberAllowed: boolean, sessionId?: string, runsSandboxed = false): ShellRuleApproval {
  const parsed = parseShellCommand(command);
  const shape = analyzeShellForRules(parsed, projectCwd);
  const floor = isDestructiveShellText(command)
    || (shape.ok && shape.commands.some((cmd) => isDestructiveShellArgv(cmd.argv) || noReusableRuleReason(cmd.argv) !== null))
    || shellExfiltrationSignal(parsed, projectCwd) !== null || shellSensitivePathSignal(parsed, projectCwd) !== null;
  const reusable = rememberAllowed && !floor;
  // Irreversible or otherwise unreusable commands keep once and session choices but never become rules.
  const irreversible = shape.ok && shape.commands.some((cmd) => noReusableRuleReason(cmd.argv) !== null);
  let suggestedPattern: string | null = null;
  if (reusable && !irreversible && shape.ok && shape.commands[0]) {
    // Default consent names this complete argv; wider prefixes require an edit.
    const argv = shape.commands[0].argv;
    const tokens = shape.commands.length === 1 ? suggestShellPrefix(argv, false) : null;
    const candidate = tokens ? { tokens, wildcard: false } : null;
    if (candidate) {
      const pattern = formatRuleSpecifier({ kind: "bash", ...candidate });
      // A suggested rule must cover this whole invocation and disclose no secret.
      if (maskSensitiveData(pattern).masked === pattern && suggestionCovers(pattern, command, projectCwd)) suggestedPattern = pattern;
    }
  }
  return {
    suggestedPattern,
    projectCwd,
    projectRoot: projectRuleRoot(projectCwd),
    sessionAllowed: reusable && Boolean(sessionId) && runsSandboxed,
    persistentAllowed: reusable && suggestedPattern !== null,
  };
}

function suggestionCovers(pattern: string, command: string, cwd: string): boolean {
  try {
    return shellRuleCoversCommand(pattern, "allow", command, cwd);
  } catch {
    // A candidate the store would refuse is simply not offered.
    return false;
  }
}

// Reuse the strict store validator and matcher for edited dock values.
export function shellRuleCoversCommand(pattern: string, action: "allow" | "deny", command: string, cwd: string): boolean {
  if (maskSensitiveData(pattern).masked !== pattern) return false;
  validatePermissionRule({ pattern, action });
  const spec = parseRuleSpecifier(pattern);
  if (spec.kind !== "bash") return false;
  const input = { pattern, spec };
  const result = evaluateShellRules(command, { allow: action === "allow" ? [input] : [], deny: action === "deny" ? [input] : [], ask: [] }, cwd);
  return result.decision === action;
}
