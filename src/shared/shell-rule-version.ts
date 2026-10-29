// Exact shell allows identify literal raw words; earlier stored formats cannot prove that identity.
export const SHELL_RULE_CANONICAL_VERSION = 1;

export interface ShellRuleVersion {
  shellRuleVersion?: number;
}

interface VersionedRule extends ShellRuleVersion {
  pattern: string;
  action: string;
}

function isShellRulePattern(pattern: string): boolean {
  return /^(?:Bash|PowerShell|HostTerminal)\(/.test(pattern);
}

// Restrictions keep narrowing independently of the format that originally wrote them.
export function isCurrentShellRule(rule: VersionedRule): boolean {
  return rule.action !== "allow" || !isShellRulePattern(rule.pattern)
    || rule.shellRuleVersion === SHELL_RULE_CANONICAL_VERSION;
}

// Call only when authoring a fresh rule. Loading or retaining a stored row must preserve its version.
export function withCurrentShellRuleVersion<T extends VersionedRule>(rule: T): T & ShellRuleVersion {
  return rule.action === "allow" && isShellRulePattern(rule.pattern)
    ? { ...rule, shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }
    : { ...rule };
}
