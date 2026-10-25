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

// Derive the one exact rule a bash card may save from the host's original shell input: the complete argv of a single simple command, never a prefix or wildcard (owner 2026-10-25, D3).
export function buildShellRuleApproval(command: string, projectCwd: string, rememberAllowed: boolean, sessionId?: string): ShellRuleApproval {
  const parsed = parseShellCommand(command);
  const shape = analyzeShellForRules(parsed, projectCwd);
  const floor = isDestructiveShellText(command)
    || (shape.ok && shape.commands.some((cmd) => isDestructiveShellArgv(cmd.argv) || noReusableRuleReason(cmd.argv) !== null))
    || shellExfiltrationSignal(parsed, projectCwd) !== null || shellSensitivePathSignal(parsed, projectCwd) !== null;
  let exactRule: string | null = null;
  if (rememberAllowed && !floor && shape.ok && shape.commands.length === 1 && shape.commands[0]) {
    const tokens = suggestShellPrefix(shape.commands[0].argv, false);
    if (tokens) {
      const pattern = formatRuleSpecifier({ kind: "bash", tokens, wildcard: false });
      // The rule must cover this whole invocation and disclose no secret.
      if (maskSensitiveData(pattern).masked === pattern && suggestionCovers(pattern, command, projectCwd)) exactRule = pattern;
    }
  }
  return {
    exactRule,
    projectCwd,
    projectRoot: projectRuleRoot(projectCwd),
    sessionAllowed: exactRule !== null && Boolean(sessionId),
    persistentAllowed: exactRule !== null,
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
