/**
 * Per-project rule scope cache and the shell-rule decision helper used by
 * `PermissionManager.checkDetailed` (issue #28, P1a).
 *
 * `checkDetailed` is synchronous, so per-project rules are loaded ahead of the
 * decision by {@link ProjectRuleScopes.ensureLoaded} (the tool pipeline awaits
 * it before calling the manager). A decision for a project whose rules were
 * never loaded is an internal contract violation and throws.
 */
import type { PermissionRule } from "../permission-manager.js";
import { isRuleSpecifier, parseRuleSpecifier } from "./rule-specifier.js";
import { PermissionRulesFileCorruptError, validatePermissionRule } from "./rule-files.js";
import { projectRulesLocation, readProjectRulesFile, updateProjectRulesFile } from "./project-rule-files.js";
import { evaluateShellRules, type ShellRuleEvaluation, type ShellRuleInput, type ShellRuleSet } from "./shell-rule-matcher.js";

export type ProjectRuleState =
  | { ok: true; projectRoot: string; rules: readonly PermissionRule[] }
  | { ok: false; projectRoot: string; error: PermissionRulesFileCorruptError };

export class ProjectRuleScopes {
  private readonly states = new Map<string, ProjectRuleState>();

  constructor(private readonly baseDir: string) {}

  /**
   * Load (once) the rule file of the project rooted at `projectCwd`. A corrupt
   * file is recorded, not thrown: decisions for that project then fail closed
   * with the file's error as the visible reason.
   */
  async ensureLoaded(projectCwd: string): Promise<ProjectRuleState> {
    const location = projectRulesLocation(this.baseDir, projectCwd);
    const cached = this.states.get(location.identity);
    if (cached) return cached;
    return this.reload(projectCwd);
  }

  async reload(projectCwd: string): Promise<ProjectRuleState> {
    const location = projectRulesLocation(this.baseDir, projectCwd);
    let state: ProjectRuleState;
    try {
      const file = await readProjectRulesFile(location);
      state = { ok: true, projectRoot: location.projectRoot, rules: Object.freeze([...(file?.rules ?? [])]) };
    } catch (error) {
      if (!(error instanceof PermissionRulesFileCorruptError)) throw error;
      console.error(`[permission] ${error.message}`);
      state = { ok: false, projectRoot: location.projectRoot, error };
    }
    this.states.set(location.identity, state);
    return state;
  }

  /** Sync lookup for the decision path; throws when the project was never loaded. */
  stateFor(projectCwd: string): ProjectRuleState {
    const location = projectRulesLocation(this.baseDir, projectCwd);
    const state = this.states.get(location.identity);
    if (!state) {
      throw new Error(`Project permission rules were not loaded before the decision (${location.projectRoot})`);
    }
    return state;
  }

  async addRule(projectCwd: string, rule: PermissionRule): Promise<void> {
    const validated = validatePermissionRule(rule);
    const location = projectRulesLocation(this.baseDir, projectCwd);
    const file = await updateProjectRulesFile(location, (current) => {
      const exists = current.rules.some((r) => r.pattern === validated.pattern && r.action === validated.action);
      if (!exists) {
        // Deny first so a reader scanning in order sees restrictions first;
        // precedence does not depend on order (deny > ask > allow).
        if (validated.action === "allow") current.rules.push(validated);
        else current.rules.unshift(validated);
      }
    });
    this.states.set(location.identity, { ok: true, projectRoot: location.projectRoot, rules: Object.freeze([...file.rules]) });
  }

  async removeRule(projectCwd: string, pattern: string, action: PermissionRule["action"]): Promise<void> {
    const location = projectRulesLocation(this.baseDir, projectCwd);
    const file = await updateProjectRulesFile(location, (current) => {
      current.rules = current.rules.filter((r) => !(r.pattern === pattern && r.action === action));
    });
    this.states.set(location.identity, { ok: true, projectRoot: location.projectRoot, rules: Object.freeze([...file.rules]) });
  }
}

/** Bash specifier rules from any number of scopes, grouped by class. */
export function collectShellRuleSet(...scopes: ReadonlyArray<readonly PermissionRule[]>): ShellRuleSet {
  const deny: ShellRuleInput[] = [];
  const ask: ShellRuleInput[] = [];
  const allow: ShellRuleInput[] = [];
  for (const rules of scopes) {
    for (const rule of rules) {
      if (rule.source || !isRuleSpecifier(rule.pattern)) continue;
      const spec = parseRuleSpecifier(rule.pattern);
      if (spec.kind !== "bash") continue;
      (rule.action === "deny" ? deny : rule.action === "ask" ? ask : allow).push({ pattern: rule.pattern, spec });
    }
  }
  return { deny, ask, allow };
}

export function evaluateShellSubject(
  subject: { command: string; cwd?: string },
  ...scopes: ReadonlyArray<readonly PermissionRule[]>
): ShellRuleEvaluation {
  return evaluateShellRules(subject.command, collectShellRuleSet(...scopes), subject.cwd);
}
