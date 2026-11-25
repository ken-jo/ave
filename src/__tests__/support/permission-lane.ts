import type { PermissionManager } from "../../permissions/permission-manager.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import { canonicalRuleSpecifier } from "../../permissions/rules/rule-specifier.js";

export function literalShellRulePattern(dialect: ShellRuleDialect, command: string): string {
  return canonicalRuleSpecifier(`${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`);
}

export function distinctPathArguments(length: number): string {
  let command = "printf %s";
  for (let index = 0; command.length < length; index += 1) command += ` data/path${index}`;
  return command.slice(0, length);
}

export function checkShellPermission(
  manager: PermissionManager,
  cwd: string,
  sessionId: string,
  command: string,
  dialect: ShellRuleDialect,
  runsSandboxed: boolean,
  headless = false,
) {
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command, cwd },
    shellExecution: { runsSandboxed },
    sessionId,
    headless,
  });
}

/** An exhausted shell analysis: a human answers it on a host route, and the mode answers it on a contained one. */
export function analysisLimitAnswer(runsSandboxed: boolean, headless: boolean, contained: Record<string, unknown>): Record<string, unknown> {
  if (runsSandboxed) return contained;
  return headless ? { decision: "deny", reasonCode: "no-approver" } : { decision: "ask", forceModal: true, reasonCode: "shell-analysis-limit" };
}

/** The mode's answer for an unproven contained shell command that no reviewer has answered yet. */
export function containedModeAnswer(mode: "strict" | "default" | "auto" | "allow", headless: boolean): Record<string, unknown> {
  if (mode === "allow") return { decision: "allow", reasonCode: "allow-mode" };
  if (mode === "auto") return { decision: "ask", reasonCode: "review-required" };
  return headless ? { decision: "deny", reasonCode: "no-approver" } : { decision: "ask", reasonCode: "shell-approval" };
}
