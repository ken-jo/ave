// Corrupt rule files throw and writers refuse to overwrite them; nothing is silently dropped. Stored broad wildcards remain visible/removable but inert, survive unrelated writes unchanged, and cannot be newly saved.
import type { PermissionRule } from "../permission-manager.js";
import {
  ENFORCED_RULE_KINDS,
  RuleSpecifierError,
  formatRuleSpecifier,
  isRuleSpecifier,
  parseRuleSpecifier,
  literalRuleWord,
  type RuleSpecifier,
} from "./rule-specifier.js";
import { refusedShellPrefix } from "./shell-prefix-values.js";
import type { StoredRuleInvalidReason } from "../../shared/permissions-events.js";

// A broad allow wildcard is refused at save but retained inert when already stored.
class BroadShellWildcardError extends RuleSpecifierError {}
class RetiredRuleError extends RuleSpecifierError {}

function isRetiredHostTerminalRule(pattern: string): boolean {
  return pattern.startsWith("HostTerminal(");
}

// The reason a stored rule is inert, or null for a rule in force. Decisions skip such a rule and Settings lists it with this reason.
export function storedRuleInvalidReason(rule: { pattern: string; action: string; source?: string | undefined }, parsed?: RuleSpecifier): StoredRuleInvalidReason | null {
  if (isRetiredHostTerminalRule(rule.pattern)) return "retired-host-terminal";
  if (rule.action !== "allow" || rule.source !== undefined || !isRuleSpecifier(rule.pattern)) return null;
  const spec = parsed ?? parseRuleSpecifier(rule.pattern);
  return spec.kind === "bash" && refusedShellPrefix(spec.tokens.map((token) => literalRuleWord(token, "bash")!), spec.wildcard) === "broad-prefix"
    ? "wildcard-not-allowlisted"
    : null;
}

// Patterns of the inert rules a file already holds; a write may keep these and no others.
export function inertRulePatterns(rules: readonly PermissionRule[] | undefined): ReadonlySet<string> {
  return new Set((rules ?? []).filter((rule) => storedRuleInvalidReason(rule) !== null).map((rule) => rule.pattern));
}

export class PermissionRulesFileCorruptError extends Error {
  constructor(readonly filePath: string, detail: string) {
    super(`Permission rules file ${filePath} is corrupt: ${detail}. Fix or remove the file; its rules are not in force.`);
    this.name = "PermissionRulesFileCorruptError";
  }
}

type PermissionRuleAction = PermissionRule["action"];
const ACTIONS: ReadonlySet<string> = new Set(["allow", "deny", "ask"]);

// Validate one rule for storage. Specifier rules must be in canonical spelling, of an enforced kind, and — for allow — not a refused shell prefix. Legacy glob rules keep their existing shape. Throws RuleSpecifierError for a rule outside the language; callers that read files wrap it as corrupt.
export function validatePermissionRule(rule: unknown): PermissionRule {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new RuleSpecifierError(String(rule), "rule must be an object");
  const candidate = rule as Record<string, unknown>;
  const { pattern, action, tier, source } = candidate;
  if (typeof pattern !== "string" || pattern.length === 0) throw new RuleSpecifierError(String(pattern), "pattern must be a non-empty string");
  if (typeof action !== "string" || !ACTIONS.has(action)) throw new RuleSpecifierError(pattern, `unknown action ${String(action)}`);
  if (tier !== undefined && tier !== "read" && tier !== "write") throw new RuleSpecifierError(pattern, `unknown tier ${String(tier)}`);
  if (source !== undefined && typeof source !== "string") throw new RuleSpecifierError(pattern, "source must be a string");
  if (isRetiredHostTerminalRule(pattern)) throw new RetiredRuleError(pattern, "host terminal rules are no longer used; remove this stored rule");
  if (isRuleSpecifier(pattern)) {
    const spec = parseRuleSpecifier(pattern);
    if (source !== undefined) throw new RuleSpecifierError(pattern, "specifier rules do not take a source");
    assertStorableSpecifier(pattern, spec, action as PermissionRuleAction);
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
    const refused = refusedShellPrefix(spec.tokens.map((token) => literalRuleWord(token, "bash")!), spec.wildcard);
    if (refused === "broad-prefix") {
      throw new BroadShellWildcardError(pattern, `"${spec.tokens.join(" ")}" is a refused allow prefix (broad-prefix); save a narrower prefix or exact command instead`);
    }
    if (refused) throw new RuleSpecifierError(pattern, `"${spec.tokens.join(" ")}" is a refused allow prefix (${refused}); approve it once or for the session instead`);
  }
}

// 1-based line where element `index` of the top-level `"rules"` array starts in `text`, or undefined when it cannot be located. A small JSON scanner: strings are skipped, depth is tracked, so a `"rules"` key nested elsewhere or a comma inside a string is not miscounted.
function ruleLine(text: string, index: number): number | undefined {
  let depth = 0;
  let inRules = false;
  let element = -1;
  let expectElement = false;
  let lastKey: string | undefined;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const char = text[cursor]!;
    if (/\s/.test(char)) continue;
    if (inRules && depth === 2 && expectElement) {
      element += 1;
      if (element === index) return text.slice(0, cursor).split("\n").length;
      expectElement = false;
    }
    if (char === "\"") {
      let end = cursor + 1;
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
      if (depth === 1 && !inRules) lastKey = text.slice(cursor + 1, end);
      cursor = end;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      if (char === "[" && depth === 2 && lastKey === "rules" && !inRules) {
        inRules = true;
        expectElement = true;
      }
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (inRules && depth === 1) return undefined;
    } else if (char === "," && inRules && depth === 2) {
      expectElement = true;
    } else if (char === "," && depth === 1) {
      lastKey = undefined;
    }
  }
  return undefined;
}

// Validate a file's rule list. A bad rule fails the whole file (nothing is silently dropped); the error names the rule's position, its line in `sourceText` when the caller read one, and the rule's pattern, so the user can fix that one rule.
export function validateRuleList(
  filePath: string,
  rules: unknown,
  options: {
    specifiersOnly?: boolean;
    sourceText?: string;
    // Inert broad allow wildcards that may stay in the file: `"all"` when reading what is stored, or the patterns the file already held when writing, so a write keeps them but cannot add one.
    keepInertWildcards?: "all" | ReadonlySet<string>;
  } = {},
): PermissionRule[] {
  if (!Array.isArray(rules)) throw new PermissionRulesFileCorruptError(filePath, "rules is not an array");
  return rules.map((rule, index) => {
    try {
      const keep = options.keepInertWildcards;
      if (keep !== undefined && rule && typeof rule === "object" && !Array.isArray(rule)) {
        try {
          validatePermissionRule(rule);
        } catch (error) {
          const pattern = (rule as { pattern?: unknown }).pattern;
          if ((error instanceof BroadShellWildcardError || error instanceof RetiredRuleError) && typeof pattern === "string" && (keep === "all" || keep.has(pattern))) {
            const row = rule as PermissionRule;
            if (!ACTIONS.has(row.action) || row.source !== undefined || (row.tier !== undefined && row.tier !== "read" && row.tier !== "write")) throw error;
            return { ...row };
          }
        }
      }
      const validated = validatePermissionRule(rule);
      if (options.specifiersOnly && !isRuleSpecifier(validated.pattern)) {
        throw new RuleSpecifierError(validated.pattern, "project rule files hold rules-language specifiers only");
      }
      return validated;
    } catch (error) {
      if (error instanceof RuleSpecifierError) {
        const line = options.sourceText === undefined ? undefined : ruleLine(options.sourceText, index);
        throw new PermissionRulesFileCorruptError(filePath, `rule ${index + 1}${line === undefined ? "" : ` at line ${line}`}: ${error.message}`);
      }
      throw error;
    }
  });
}

// "invalid JSON", with the line and column when the parser reports a location.
export function invalidJsonDetail(error: unknown, text: string): string {
  const message = error instanceof Error ? error.message : "";
  const lineColumn = /line (\d+) column (\d+)/.exec(message);
  if (lineColumn) return `invalid JSON at line ${lineColumn[1]} column ${lineColumn[2]}`;
  const position = /position (\d+)/.exec(message);
  if (!position) return "invalid JSON";
  const before = text.slice(0, Number(position[1])).split("\n");
  return `invalid JSON at line ${before.length} column ${before[before.length - 1]!.length + 1}`;
}
