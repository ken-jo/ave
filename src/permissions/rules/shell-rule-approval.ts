import { maskSensitiveData } from "../../audit/dlp-filter.js";
import type { ShellRuleApproval } from "../../shared/permissions-events.js";
import { analyzeShellForRules, evaluateShellRules } from "./shell-rule-matcher.js";
import { formatRuleSpecifier, parseRuleSpecifier } from "./rule-specifier.js";
import { parseShellCommand, suggestShellPrefix } from "./shell-prefix-policy.js";
import { isDestructiveShellText } from "../reviewer/risk-classifier.js";
import { shellExfiltrationSignal, shellSensitivePathSignal } from "./shell-exfiltration.js";
import { validatePermissionRule } from "./rule-files.js";
import { isDestructiveShellArgv, isIrreversibleShellArgv, NETWORK_EGRESS_PROGRAMS, programName, refusedShellPrefix } from "./shell-prefix-values.js";
import { projectRuleRoot } from "./project-rule-files.js";

/** Derive display suggestions only from the host's original shell input. */
export function buildShellRuleApproval(command: string, projectCwd: string, rememberAllowed: boolean, sessionId?: string): ShellRuleApproval {
  const parsed = parseShellCommand(command);
  const shape = analyzeShellForRules(parsed, projectCwd);
  const floor = isDestructiveShellText(command)
    || (shape.ok && shape.commands.some((cmd) => isDestructiveShellArgv(cmd.argv)))
    || shellExfiltrationSignal(parsed, projectCwd) !== null || shellSensitivePathSignal(parsed, projectCwd) !== null;
  const reusable = rememberAllowed && !floor;
  // Network clients wait for host-scoped network rules before they get a reusable allow.
  const networkEgress = shape.ok && shape.commands.some((cmd) =>
    cmd.argv[0] !== undefined && NETWORK_EGRESS_PROGRAMS.has(programName(cmd.argv[0])));
  // Irreversible commands keep once and session choices but never become rules.
  const irreversible = shape.ok && shape.commands.some((cmd) => isIrreversibleShellArgv(cmd.argv));
  let suggestedPattern: string | null = null;
  if (reusable && !networkEgress && !irreversible && shape.ok && shape.commands[0]) {
    // An allowlisted program/verb gets its catalog wildcard; anything else only
    // an exact rule for its full argv, never with `*` appended.
    const argv = shape.commands[0].argv;
    const prefix = suggestShellPrefix(argv);
    const candidate = prefix ? { tokens: prefix, wildcard: true }
      : shape.commands.length === 1 && argv.every((token): token is string => token !== undefined)
        && !argv.some((token) => EXACT_TOKEN_UNSAFE.test(token))
        && refusedShellPrefix(argv as string[], false) === null
        ? { tokens: argv as string[], wildcard: false } : null;
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
    sessionAllowed: reusable && Boolean(sessionId),
    persistentAllowed: reusable && suggestedPattern !== null,
  };
}

/** A token an exact rule cannot spell back unchanged (spaces, quotes, globs, `*`). */
const EXACT_TOKEN_UNSAFE = /[\s;&|<>()$`'"\\*?[\]{}#~!]/;

function suggestionCovers(pattern: string, command: string, cwd: string): boolean {
  try {
    return shellRuleCoversCommand(pattern, "allow", command, cwd);
  } catch {
    // A candidate the store would refuse is simply not offered.
    return false;
  }
}

/** Reuse the strict store validator and matcher for edited dock values. */
export function shellRuleCoversCommand(pattern: string, action: "allow" | "deny", command: string, cwd: string): boolean {
  if (maskSensitiveData(pattern).masked !== pattern) return false;
  validatePermissionRule({ pattern, action });
  const spec = parseRuleSpecifier(pattern);
  if (spec.kind !== "bash") return false;
  const input = { pattern, spec };
  const result = evaluateShellRules(command, { allow: action === "allow" ? [input] : [], deny: action === "deny" ? [input] : [], ask: [] }, cwd);
  return result.decision === action;
}
