/**
 * Persisted permission rule validation (issue #28, P1a), shared by the
 * user-global Store A file (`<ave home>/permissions.json`, extended in place to
 * hold specifier and `ask` rules) and the per-project rule files
 * (`project-rule-files.ts`).
 *
 * Corrupt data fails clearly: a file that does not parse, has the wrong shape,
 * or holds a rule outside the language throws
 * {@link PermissionRulesFileCorruptError}. Nothing is silently dropped, and the
 * writers refuse to overwrite a corrupt file (they read before they write).
 */
import type { PermissionRule } from "../permission-manager.js";
import {
  ENFORCED_RULE_KINDS,
  RuleSpecifierError,
  formatRuleSpecifier,
  isRuleSpecifier,
  parseRuleSpecifier,
  type RuleSpecifier,
} from "./rule-specifier.js";
import { refusedShellPrefix } from "./shell-prefix-policy.js";

export class PermissionRulesFileCorruptError extends Error {
  constructor(readonly filePath: string, detail: string) {
    super(`Permission rules file ${filePath} is corrupt: ${detail}. Fix or remove the file; its rules are not in force.`);
    this.name = "PermissionRulesFileCorruptError";
  }
}

type PermissionRuleAction = PermissionRule["action"];
const ACTIONS: ReadonlySet<string> = new Set(["allow", "deny", "ask"]);

/**
 * Validate one rule for storage. Specifier rules must be in canonical spelling,
 * of an enforced kind, and — for allow — not a refused shell prefix. Legacy
 * glob rules keep their existing shape. Throws {@link RuleSpecifierError} for a
 * rule outside the language; callers that read files wrap it as corrupt.
 */
export function validatePermissionRule(rule: unknown): PermissionRule {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new RuleSpecifierError(String(rule), "rule must be an object");
  const candidate = rule as Record<string, unknown>;
  const { pattern, action, tier, source } = candidate;
  if (typeof pattern !== "string" || pattern.length === 0) throw new RuleSpecifierError(String(pattern), "pattern must be a non-empty string");
  if (typeof action !== "string" || !ACTIONS.has(action)) throw new RuleSpecifierError(pattern, `unknown action ${String(action)}`);
  if (tier !== undefined && tier !== "read" && tier !== "write") throw new RuleSpecifierError(pattern, `unknown tier ${String(tier)}`);
  if (source !== undefined && typeof source !== "string") throw new RuleSpecifierError(pattern, "source must be a string");
  if (isRuleSpecifier(pattern)) {
    const spec = parseRuleSpecifier(pattern);
    assertStorableSpecifier(pattern, spec, action as PermissionRuleAction);
    if (source !== undefined) throw new RuleSpecifierError(pattern, "specifier rules do not take a source");
  }
  return candidate as unknown as PermissionRule;
}

function assertStorableSpecifier(pattern: string, spec: RuleSpecifier, action: PermissionRuleAction): void {
  if (formatRuleSpecifier(spec) !== pattern) {
    throw new RuleSpecifierError(pattern, `not in canonical form (expected ${formatRuleSpecifier(spec)})`);
  }
  if (!ENFORCED_RULE_KINDS.has(spec.kind)) {
    throw new RuleSpecifierError(pattern, `${spec.kind} rules are not enforced yet`);
  }
  if (spec.kind === "bash" && action === "allow") {
    const refused = refusedShellPrefix(spec.tokens);
    if (refused) throw new RuleSpecifierError(pattern, `"${spec.tokens.join(" ")}" is a refused allow prefix (${refused}); approve it once or for the session instead`);
  }
}

export function validateRuleList(
  filePath: string,
  rules: unknown,
  options: { specifiersOnly?: boolean } = {},
): PermissionRule[] {
  if (!Array.isArray(rules)) throw new PermissionRulesFileCorruptError(filePath, "rules is not an array");
  return rules.map((rule, index) => {
    try {
      const validated = validatePermissionRule(rule);
      if (options.specifiersOnly && !isRuleSpecifier(validated.pattern)) {
        throw new RuleSpecifierError(validated.pattern, "project rule files hold rules-language specifiers only");
      }
      return validated;
    } catch (error) {
      if (error instanceof RuleSpecifierError) {
        throw new PermissionRulesFileCorruptError(filePath, `rule ${index}: ${error.message}`);
      }
      throw error;
    }
  });
}
