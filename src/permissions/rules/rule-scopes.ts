// Load project rules before synchronous permission evaluation; evaluating an unloaded scope is a contract violation and throws.
import { isCurrentShellRule, withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { stat } from "node:fs/promises";
import { capturePersistedPolicyVersion, isPersistedPolicyVersionCurrent, persistedPolicyVersionForContent, type PersistedPolicyVersion } from "../persisted-policy-version.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { isMissingPathError } from "../../lib/atomic-file.js";
import type { PermissionRule } from "../permission-manager.js";
import { isRuleSpecifier, literalRuleWord, parseRuleSpecifier, type RuleSpecifier } from "./rule-specifier.js";
import { canonicalPowerShellName, POWERSHELL_COMMAND_POLICIES } from "./powershell-command-policy.js";
import { inspectPowerShellCommand, parsePowerShellCommand, powerShellRuleShape, type PowerShellCommandInput } from "./powershell-exfiltration.js";
import { isRetiredHostTerminalRule, PermissionRulesFileCorruptError, storedRuleInvalidReason, validatePermissionRule } from "./rule-files.js";
import { projectRulesLocation, storedFileRulesLocation, readProjectRulesFile, updateProjectRulesFile } from "./project-rule-files.js";
import { evaluateShellRules, type ShellRuleEvaluation, type ShellRuleInput, type ShellRuleSet } from "./shell-rule-matcher.js";
import { type ShellCommandInput } from "./shell-prefix-policy.js";
import { MAX_LITERAL_COMMAND_LENGTH } from "./shell-prefix-values.js";

export type ProjectRuleState =
  | { ok: true; projectRoot: string; rules: readonly PermissionRule[] }
  | { ok: false; projectRoot: string; error: PermissionRulesFileCorruptError };

// File version a cached state was read from (mtime + size); `null` = absent.
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
  private readonly pendingLoads = new Map<string, Promise<ProjectRuleState>>();
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

  // Load the rule file of the project `projectCwd` belongs to, re-reading it whenever its mtime changed (a hand edit or another window's write). A corrupt file is recorded, not thrown: non-read decisions for that project then fail closed with the file's error as the visible reason.
  async ensureLoaded(projectCwd: string): Promise<ProjectRuleState> {
    const location = projectRulesLocation(this.baseDir, projectCwd);
    const pending = this.pendingLoads.get(location.identity);
    if (pending) return pending;
    const load = (async () => {
      const stamp = await fileStamp(location.filePath);
      const cached = this.states.get(location.identity);
      if (cached && this.stamps.get(location.identity) === stamp) return cached;
      return this.reload(projectCwd);
    })();
    this.pendingLoads.set(location.identity, load);
    try {
      return await load;
    } finally {
      this.pendingLoads.delete(location.identity);
    }
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

  // Sync lookup for the decision path; throws when the project was never loaded.
  stateFor(projectCwd: string): ProjectRuleState {
    const location = projectRulesLocation(this.baseDir, projectCwd);
    const state = this.states.get(location.identity);
    if (!state) {
      throw new Error(`Project permission rules were not loaded before the decision (${location.projectRoot})`);
    }
    return state;
  }

  async addRule(projectCwd: string, rule: PermissionRule): Promise<void> {
    const validated = validatePermissionRule(withCurrentShellRuleVersion(rule));
    const location = projectRulesLocation(this.baseDir, projectCwd);
    const file = await updateProjectRulesFile(location, (current) => {
      const exists = current.rules.some((r) => r.pattern === validated.pattern && r.action === validated.action && isCurrentShellRule(r));
      if (!exists) current.rules = current.rules.filter((r) => !(r.pattern === validated.pattern && r.action === validated.action));
      if (!exists) {
        // Deny first so a reader scanning in order sees restrictions first; precedence does not depend on order (deny > ask > allow).
        if (validated.action === "allow") current.rules.push(validated);
        else current.rules.unshift(validated);
      }
    });
    this.states.set(location.identity, { ok: true, projectRoot: location.projectRoot, rules: Object.freeze([...file.rules]) });
    this.policyVersions.set(location.identity, persistedPolicyVersionForContent(location.filePath, `${JSON.stringify(file, null, 2)}\n`));
    this.revision += 1;
    this.stamps.set(location.identity, await fileStamp(location.filePath));
  }

  // `storedFile` names a listed file by its stored identity; `projectCwd` is then that file's stored root.
  async removeRule(projectCwd: string, pattern: string, action: PermissionRule["action"], storedFile?: string): Promise<void> {
    const location = storedFile === undefined
      ? projectRulesLocation(this.baseDir, projectCwd)
      : storedFileRulesLocation(this.baseDir, storedFile, projectCwd);
    const file = await updateProjectRulesFile(location, (current) => {
      current.rules = current.rules.filter((r) => !(r.pattern === pattern && r.action === action));
    });
    this.states.set(location.identity, { ok: true, projectRoot: location.projectRoot, rules: Object.freeze([...file.rules]) });
    this.policyVersions.set(location.identity, persistedPolicyVersionForContent(location.filePath, `${JSON.stringify(file, null, 2)}\n`));
    this.revision += 1;
    this.stamps.set(location.identity, await fileStamp(location.filePath));
  }
}

// Repeated patterns across scopes share one parse within this evaluation.
function forEachCommandRule(scopes: ReadonlyArray<readonly PermissionRule[]>, visit: (rule: PermissionRule, spec: RuleSpecifier) => void): void {
  const specifiers = new Map<string, RuleSpecifier>();
  for (const rules of scopes) {
    for (const rule of rules) {
      if (rule.source || !isRuleSpecifier(rule.pattern) || !isCurrentShellRule(rule) || isRetiredHostTerminalRule(rule.pattern)) continue;
      let spec = specifiers.get(rule.pattern);
      if (spec === undefined) {
        spec = parseRuleSpecifier(rule.pattern);
        specifiers.set(rule.pattern, spec);
      }
      if (storedRuleInvalidReason(rule, spec) !== null) continue;
      visit(rule, spec);
    }
  }
}

// Bash specifier rules from any number of scopes, grouped by class.
function collectShellRuleSet(...scopes: ReadonlyArray<readonly PermissionRule[]>): ShellRuleSet {
  const deny: ShellRuleInput[] = [];
  const ask: ShellRuleInput[] = [];
  const allow: ShellRuleInput[] = [];
  forEachCommandRule(scopes, (rule, spec) => {
    if (spec.kind !== "bash" || storedRuleInvalidReason(rule, spec) !== null) return;
    (rule.action === "deny" ? deny : rule.action === "ask" ? ask : allow).push({ pattern: rule.pattern, spec });
  });
  return { deny, ask, allow };
}

/** The host terminal bound to the current action. */
export interface HostTerminalRuleTarget {
  readonly shell: "zsh" | "bash";
  /** Canonical physical directory of the shell (realpath, case as stored). */
  readonly cwd: string;
}

export function evaluateShellSubject(
  subject: { command: ShellCommandInput; cwd?: string; exactAllowOnly?: boolean; hostTerminal?: HostTerminalRuleTarget },
  ...scopes: ReadonlyArray<readonly PermissionRule[]>
): ShellRuleEvaluation {
  const rules = collectShellRuleSet(...scopes);
  if (subject.exactAllowOnly) rules.allow = rules.allow.filter((rule) => !rule.spec.wildcard);
  // Deny and ask `Bash(...)` rules still restrict a host terminal command; floors still run in evaluateShellRules.
  if (subject.hostTerminal) rules.allow = [];
  return evaluateShellRules(subject.command, rules, subject.cwd);
}

type PowerShellRuleSpecifier = Extract<RuleSpecifier, { kind: "powershell" }>;
interface PowerShellRuleInput { pattern: string; spec: PowerShellRuleSpecifier; restriction: PowerShellRuleSpecifier }

function collectPowerShellRules(...scopes: ReadonlyArray<readonly PermissionRule[]>): { deny: PowerShellRuleInput[]; ask: PowerShellRuleInput[]; allow: PowerShellRuleInput[] } {
  const deny: PowerShellRuleInput[] = [];
  const ask: PowerShellRuleInput[] = [];
  const allow: PowerShellRuleInput[] = [];
  forEachCommandRule(scopes, (rule, spec) => {
    if (spec.kind !== "powershell") return;
    const restriction = rule.action === "allow" ? spec : { ...spec, tokens: restrictionTokens(spec.tokens) };
    (rule.action === "deny" ? deny : rule.action === "ask" ? ask : allow).push({ pattern: rule.pattern, spec, restriction });
  });
  return { deny, ask, allow };
}

// A rule restricts (deny or ask) every command it is a prefix of; an exact rule names one argv.
function matchesPowerShellRule(spec: PowerShellRuleSpecifier, argv: readonly (string | null)[]): boolean {
  if (spec.wildcard ? argv.length < spec.tokens.length : argv.length !== spec.tokens.length) return false;
  return spec.tokens.every((token, index) => argv[index] === token);
}

// The name a deny or ask rule compares, on both sides: a directory path, a `Module\` qualifier, trailing dots (Win32 strips them) and an executable
// extension are dropped, case is
// folded and an alias resolves to its cmdlet, so `C:\Git\bin\git.exe`, `GIT` and `git` meet `PowerShell(git push *)`, and
// `Microsoft.PowerShell.Management\Remove-Item`, `ri` and `PowerShell(gci *)`'s `gci` meet their cmdlets. Matching more only narrows; an allow keeps
// comparing the literal identity (`matchesPowerShellRule` on the unnormalized tokens).
function restrictionTokens<T extends string | null>(tokens: readonly T[]): T[] {
  const values = tokens.map((token) => typeof token === "string" ? literalRuleWord(token, "powershell") ?? token : token);
  const head = values[0];
  if (typeof head !== "string") return [...values] as T[];
  const base = head.slice(Math.max(head.lastIndexOf("\\"), head.lastIndexOf("/")) + 1).replace(/\.+$/, "").replace(/\.(?:exe|com|cmd|bat)$/i, "").replace(/\.+$/, "");
  const name = canonicalPowerShellName(base.length > 0 ? base : head);
  const policy = POWERSHELL_COMMAND_POLICIES[name];
  return [name as T, ...values.slice(1).map((token) => {
    if (typeof token !== "string") return token as T;
    const normalized = token.replace(/[\u2013-\u2015]/g, "-");
    const parameter = policy !== undefined && policy.native === undefined ? /^(-[A-Za-z][A-Za-z0-9]*)(:[\s\S]*)?$/.exec(normalized) : null;
    return (parameter ? parameter[1]!.toLowerCase() + (parameter[2] ?? "") : normalized) as T;
  })];
}

// `PowerShell(...)` rules for a PowerShell call, with the same precedence and strictness as `Bash(...)` rules (`evaluateShellRules`): a deny that matches a visible command wins; input the matcher cannot fully read asks when any deny or ask rule exists; an allow covers the call only when every command is a literal simple command matched by an allow rule and no floor signal is present. `exactAllowOnly` (no sandbox for this call) keeps only exact allow rules.
export function evaluatePowerShellSubject(
  subject: { command: PowerShellCommandInput; cwd?: string; exactAllowOnly: boolean; floorSignal: string | null },
  ...scopes: ReadonlyArray<readonly PermissionRule[]>
): ShellRuleEvaluation {
  const rules = collectPowerShellRules(...scopes);
  if (subject.exactAllowOnly) rules.allow = rules.allow.filter((rule) => !rule.spec.wildcard);
  const hasRestrictions = rules.deny.length > 0 || rules.ask.length > 0;
  if (!hasRestrictions && rules.allow.length === 0) return { decision: null, reason: "no powershell rules" };
  const parsed = typeof subject.command === "string" ? parsePowerShellCommand(subject.command)
    : "syntax" in subject.command ? subject.command : parsePowerShellCommand(subject.command.command);
  const proofLimited = parsed.command.length > MAX_LITERAL_COMMAND_LENGTH;
  if (proofLimited && !hasRestrictions) return { decision: null, reason: "literal command length limit exceeded" };
  const shape = proofLimited && hasRestrictions
    ? powerShellRuleShape(parsed, { restrictionsOnly: true })
    : powerShellRuleShape(parsed);
  if (hasRestrictions) {
    // A restriction also meets the command under every spelling of its name (`restrictionTokens`): over-matching a deny or ask only narrows, so the
    // normalization that rule identity refuses (an allow compares the literal name) is safe here.
    const visible = shape.ok ? shape.commands : shape.visible;
    const restricted = visible.map((argv) => ({ argv, normalized: restrictionTokens(argv) }));
    const matching = (list: readonly PowerShellRuleInput[]) => list.find((rule) => restricted.some(({ argv, normalized }) =>
      matchesPowerShellRule(rule.spec, argv) || matchesPowerShellRule(rule.restriction, normalized)));
    const deny = matching(rules.deny);
    if (deny) return { decision: "deny", pattern: deny.pattern, reason: `deny rule ${deny.pattern}` };
    if (!shape.ok || shape.opaque !== null) {
      return { decision: "ask", pattern: null, reason: `powershell rules could not inspect every command (${shape.ok ? shape.opaque : shape.reason})` };
    }
    const ask = matching(rules.ask);
    if (ask) return { decision: "ask", pattern: ask.pattern, reason: `ask rule ${ask.pattern}` };
  }
  if (proofLimited) return { decision: null, reason: "literal command length limit exceeded" };
  if (rules.allow.length === 0) return { decision: null, reason: "no allow rule" };
  if (!shape.ok) return { decision: null, reason: `unreadable: ${shape.reason}` };
  if (shape.opaque !== null) return { decision: null, reason: shape.opaque };
  if (shape.commands.length === 0) return { decision: null, reason: "no command" };
  const inspection = inspectPowerShellCommand(parsed, subject.cwd);
  if (inspection.outcome === "visible-floor" || inspection.analysisLimited
    || (inspection.outcome === "unproven" && inspection.exactLiteralEvaluation !== true)) {
    return { decision: null, reason: inspection.exfiltration ?? inspection.sensitive ?? inspection.ordinaryAsk ?? "Shell command requires runtime evaluation" };
  }
  if (inspection.exactLiteralEvaluation === true) rules.allow = rules.allow.filter((rule) => !rule.spec.wildcard);
  if (subject.floorSignal !== null) return { decision: null, reason: subject.floorSignal };
  const patterns: string[] = [];
  for (const argv of shape.commands) {
    const rule = rules.allow.find((candidate) => matchesPowerShellRule(candidate.spec, argv));
    if (!rule) return { decision: null, reason: "a command is not covered by any allow rule" };
    if (!patterns.includes(rule.pattern)) patterns.push(rule.pattern);
  }
  return { decision: "allow", patterns, reason: `allow rules ${patterns.join(", ")}` };
}
