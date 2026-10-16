/**
 * Per-project rule scope cache and the shell-rule decision helper used by
 * `PermissionManager.checkDetailed` (issue #28, P1a).
 *
 * `checkDetailed` is synchronous, so per-project rules are loaded ahead of the
 * decision by {@link ProjectRuleScopes.ensureLoaded} (the tool pipeline awaits
 * it before calling the manager). A decision for a project whose rules were
 * never loaded is an internal contract violation and throws.
 */
import { stat } from "node:fs/promises";
import { capturePersistedPolicyVersion, isPersistedPolicyVersionCurrent, persistedPolicyVersionForContent, type PersistedPolicyVersion } from "../persisted-policy-version.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { isMissingPathError } from "../../lib/atomic-file.js";
import type { PermissionRule } from "../permission-manager.js";
import { isRuleSpecifier, parseRuleSpecifier } from "./rule-specifier.js";
import { PermissionRulesFileCorruptError, validatePermissionRule } from "./rule-files.js";
import { projectRulesLocation, readProjectRulesFile, updateProjectRulesFile } from "./project-rule-files.js";
import { evaluateShellRules, type ShellRuleEvaluation, type ShellRuleInput, type ShellRuleSet } from "./shell-rule-matcher.js";
import type { ShellCommandInput } from "./shell-prefix-policy.js";

export type ProjectRuleState =
  | { ok: true; projectRoot: string; rules: readonly PermissionRule[] }
  | { ok: false; projectRoot: string; error: PermissionRulesFileCorruptError };

/** File version a cached state was read from (mtime + size); `null` = absent. */
type FileStamp = string | null;

async function fileStamp(filePath: string): Promise<FileStamp> {
  try {
    const info = await stat(filePath);
    return `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

export class ProjectRuleScopes {
  private readonly states = new Map<string, ProjectRuleState>();
  private readonly stamps = new Map<string, FileStamp>();
  private readonly policyVersions = new Map<string, PersistedPolicyVersion | undefined>();
  private revision = 0;

  constructor(private readonly baseDir: string) {}

  getRevision(): number {
    return this.revision;
  }

  policyVersionFor(projectCwd: string): PersistedPolicyVersion | undefined {
    const location = projectRulesLocation(this.baseDir, projectCwd);
    if (this.policyVersions.has(location.identity)) return this.policyVersions.get(location.identity);
    const version = capturePersistedPolicyVersion(location.filePath);
    // A present store must have been evaluated, never merely fingerprinted.
    return version?.digest === null ? version : undefined;
  }

  /**
   * Load the rule file of the project `projectCwd` belongs to, re-reading it
   * whenever its mtime changed (a hand edit or another window's write). A
   * corrupt file is recorded, not thrown: non-read decisions for that project
   * then fail closed with the file's error as the visible reason.
   */
  async ensureLoaded(projectCwd: string): Promise<ProjectRuleState> {
    const location = projectRulesLocation(this.baseDir, projectCwd);
    const cached = this.states.get(location.identity);
    if (cached && this.stamps.get(location.identity) === await fileStamp(location.filePath)) return cached;
    return this.reload(projectCwd);
  }

  async reload(projectCwd: string): Promise<ProjectRuleState> {
    const location = projectRulesLocation(this.baseDir, projectCwd);
    const stamp = await fileStamp(location.filePath);
    const policyVersion = capturePersistedPolicyVersion(location.filePath);
    let state: ProjectRuleState;
    let loadedPolicy = false;
    try {
      const file = await readProjectRulesFile(location);
      loadedPolicy = policyVersion?.contentsDigest === sha256Hex(canonicalStringify(file));
      state = { ok: true, projectRoot: location.projectRoot, rules: Object.freeze([...(file?.rules ?? [])]) };
    } catch (error) {
      if (!(error instanceof PermissionRulesFileCorruptError)) throw error;
      console.error(`[permission] ${error.message}`);
      state = { ok: false, projectRoot: location.projectRoot, error };
    }
    this.states.set(location.identity, state);
    this.policyVersions.set(location.identity, loadedPolicy && policyVersion !== undefined && isPersistedPolicyVersionCurrent(policyVersion) ? policyVersion : undefined);
    this.revision += 1;
    this.stamps.set(location.identity, stamp);
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
    this.policyVersions.set(location.identity, persistedPolicyVersionForContent(location.filePath, `${JSON.stringify(file, null, 2)}\n`));
    this.revision += 1;
    this.stamps.set(location.identity, await fileStamp(location.filePath));
  }

  async removeRule(projectCwd: string, pattern: string, action: PermissionRule["action"]): Promise<void> {
    const location = projectRulesLocation(this.baseDir, projectCwd);
    const file = await updateProjectRulesFile(location, (current) => {
      current.rules = current.rules.filter((r) => !(r.pattern === pattern && r.action === action));
    });
    this.states.set(location.identity, { ok: true, projectRoot: location.projectRoot, rules: Object.freeze([...file.rules]) });
    this.policyVersions.set(location.identity, persistedPolicyVersionForContent(location.filePath, `${JSON.stringify(file, null, 2)}\n`));
    this.revision += 1;
    this.stamps.set(location.identity, await fileStamp(location.filePath));
  }
}

/** Bash specifier rules from any number of scopes, grouped by class. */
function collectShellRuleSet(...scopes: ReadonlyArray<readonly PermissionRule[]>): ShellRuleSet {
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
  subject: { command: ShellCommandInput; cwd?: string },
  ...scopes: ReadonlyArray<readonly PermissionRule[]>
): ShellRuleEvaluation {
  return evaluateShellRules(subject.command, collectShellRuleSet(...scopes), subject.cwd);
}
