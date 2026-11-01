// A rule an approval card saves (owner 2026-10-25, unified approval card). The renderer names only the choice's action and scope and, when the person edited it, the rule text; every authority — which rule kinds the card may save, the rule it derived, the request the rule must decide — comes from the host's pending request snapshot. Invalid input fails with a named error, never by narrowing or guessing.
import type { ApprovalGate } from "./approval-gate.js";
import type { PermissionManager } from "./permission-manager.js";
import { RuleSpecifierError, canonicalRuleSpecifier, matchesWebFetchHost, normalizeRuleSpecifierInput, parseRuleSpecifier } from "./rules/rule-specifier.js";
import { isWildcardShellRule, shellRuleCoversCommand } from "./rules/shell-rule-approval.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import { isShellRuleSaveScope, type ShellRuleSaveScope } from "../shared/permissions-events.js";
import { errorMessage } from "../shared/error-message.js";

import { refreshApprovalPersistence, type ApprovalPersistenceGuard } from "./approval-persistence-guard.js";

type RequestSnapshot = NonNullable<ReturnType<ApprovalGate["getRequestSnapshot"]>>;

// The card warns before saving an edited wildcard allow; the host repeats it in the result so the warning is never only a renderer claim.
const WILDCARD_ALLOW_SANDBOXED_ONLY = "wildcard-allow-sandboxed-only" as const;
const WILDCARD_ALLOW_BROADER_SCOPE = "wildcard-allow-broader-scope" as const;

export type ApprovalRuleSaveResult =
  | {
    readonly ok: true;
    readonly action: "allow" | "deny";
    readonly scope: ShellRuleSaveScope;
    readonly pattern: string;
    readonly edited: boolean;
    readonly warning?: typeof WILDCARD_ALLOW_SANDBOXED_ONLY | typeof WILDCARD_ALLOW_BROADER_SCOPE;
  }
  | { readonly ok: false; readonly error: string; readonly message?: string };

const fail = (error: string, message?: string): ApprovalRuleSaveResult =>
  message === undefined ? { ok: false, error } : { ok: false, error, message };

// What the save depends on, once its action and scope are known: the rule to store (edited or derived) and whether the request admits this save.
type Target =
  | { readonly kind: "shell"; readonly snapshot: RequestSnapshot; readonly context: NonNullable<RequestSnapshot["shellRule"]> }
  | { readonly kind: "network"; readonly snapshot: RequestSnapshot; readonly context: NonNullable<RequestSnapshot["egress"]> };

function targetOf(snapshot: RequestSnapshot): Target | undefined {
  if (snapshot.shellRule !== undefined) return { kind: "shell", snapshot, context: snapshot.shellRule };
  if (snapshot.egress !== undefined) return { kind: "network", snapshot, context: snapshot.egress };
  return undefined;
}

// Where an allow at `scope` may be saved for this request, or the error that refuses it.
function allowRefusal(target: Target, scope: ShellRuleSaveScope): string | undefined {
  if (target.kind === "shell") {
    const offered = scope === "session" ? target.context.sessionAllowed : target.context.persistentAllowed;
    return offered ? undefined : "one-shot-not-recordable";
  }
  // A host rule is offered exactly where the card offers the grant of the same lifetime: a local or unverified destination, or a shared identity, gets no persistent one, and a terminal tab has no conversation or project.
  const grantScope = scope === "always" ? "always" : scope;
  if (!target.context.scopes.includes(grantScope)) return "scope-not-offered";
  if (scope === "session" && target.snapshot.sessionId === undefined) return "missing-session";
  if (scope === "project" && target.context.projectCwd === undefined) return "scope-not-offered";
  return undefined;
}

function derivedRule(target: Target, action: "allow" | "deny"): string | null {
  if (target.kind === "network") return target.context.rule;
  return action === "allow" ? target.context.exactRule : target.context.denyRule;
}

// An edited rule in canonical spelling, or the error naming why it cannot be one.
function editedRule(text: string): { ok: true; pattern: string } | { ok: false; message: string } {
  try {
    return { ok: true, pattern: canonicalRuleSpecifier(normalizeRuleSpecifierInput(text)) };
  } catch (error) {
    if (error instanceof RuleSpecifierError) return { ok: false, message: error.message };
    throw error;
  }
}

// True when `pattern`, as `action`, decides this request: a shell rule of the card's own dialect that allows (or refuses) its command, or a host rule naming its destination.
function decidesRequest(target: Target, pattern: string, action: "allow" | "deny"): boolean {
  if (target.kind === "shell") {
    const command = target.snapshot.args && typeof target.snapshot.args === "object"
      ? (target.snapshot.args as Record<string, unknown>).command : undefined;
    if (typeof command !== "string") return false;
    return shellRuleCoversCommand(target.context.dialect, pattern, action, command, target.context.projectCwd, target.snapshot.verifiedShellCommand);
  }
  if (maskSensitiveData(pattern).masked !== pattern) return false;
  const spec = parseRuleSpecifier(pattern);
  return spec.kind === "network" && matchesWebFetchHost(spec, target.context.host, target.context.port);
}

// Wildcards extend the allow beyond this exact action. Network rules decide
// sandboxed connections; shell prefixes also apply to matching host commands.
function isWildcardAllow(target: Target, pattern: string): boolean {
  if (target.kind === "shell") return isWildcardShellRule(pattern);
  const spec = parseRuleSpecifier(pattern);
  return spec.kind === "network" && spec.subdomains;
}

export async function saveApprovalCardRule(
  snapshot: RequestSnapshot,
  rule: Record<string, unknown>,
  answer: { readonly decision: unknown; readonly scope: unknown; readonly displayedVerdictAtApproval: unknown },
  permissionManager: PermissionManager | undefined,
  authority?: ApprovalPersistenceGuard,
): Promise<ApprovalRuleSaveResult> {
  const { action, scope, pattern: edited } = rule;
  if (Object.keys(rule).some((key) => key !== "action" && key !== "scope" && key !== "pattern")) {
    return fail("invalid-rule", "A card rule names only its action, scope and, when edited, its pattern");
  }
  if ((action !== "allow" && action !== "deny") || !isShellRuleSaveScope(scope) || (edited !== undefined && typeof edited !== "string")) {
    return fail("invalid-rule", "A card rule needs action allow or deny, scope session, project or always, and an optional pattern string");
  }
  // "Always deny" is the only deny a card saves: user-global.
  if (action === "deny" && scope !== "always") return fail("invalid-rule", "A card saves a deny rule only as Always deny");
  // The record's own fields must describe the same choice.
  if (answer.decision !== action || answer.scope !== (scope === "session" ? "session" : "persistent")) {
    return fail("invalid-rule", "The rule's action and scope do not match the recorded decision");
  }
  const target = targetOf(snapshot);
  if (target === undefined) return fail("invalid-rule", "This request has no rule a card can save");
  if (target.kind === "shell" && action === "deny" && !target.context.denyAllowed) return fail("one-shot-not-recordable", "This request cannot create a deny rule");
  // Host rules are shell-origin, like shell grants: a terminal tab's card saves none (its connections are decided by its grants).
  if (target.kind === "network" && target.context.terminalTabId !== undefined) {
    return fail("scope-not-offered", "A terminal tab's connections are decided by its grants; host rules apply to shell calls");
  }
  if (action === "allow") {
    const refusal = allowRefusal(target, scope);
    if (refusal !== undefined) return fail(refusal, "This request cannot create an allow rule at that scope");
  }
  let pattern: string | null;
  if (edited === undefined) {
    pattern = derivedRule(target, action);
    if (pattern === null) return fail("rule-required", "This request has no derived rule; edit one to save");
  } else {
    const parsed = editedRule(edited);
    if (!parsed.ok) return fail("invalid-rule", parsed.message);
    pattern = parsed.pattern;
  }
  try {
    if (!decidesRequest(target, pattern, action)) {
      return fail("rule-does-not-match", `${pattern} does not ${action === "allow" ? "allow" : "deny"} this request`);
    }
  } catch (error) {
    if (error instanceof RuleSpecifierError) return fail("invalid-rule", error.message);
    throw error;
  }
  if (answer.displayedVerdictAtApproval !== snapshot.verdictAtApproval) return fail("verdict-mismatch");
  if (!permissionManager) return fail("no-permission-manager");
  try {
    if (scope === "session") {
      if (snapshot.sessionId === undefined) return fail("missing-session", "This request has no conversation session");
      await refreshApprovalPersistence(authority);
      permissionManager.addSessionRule(snapshot.sessionId, pattern);
    } else if (scope === "project") {
      const projectCwd = target.context.projectCwd;
      if (projectCwd === undefined) return fail("scope-not-offered", "This request has no project");
      await permissionManager.addRulePersist({ pattern, action }, { kind: "project", projectCwd }, ...(authority ? [authority] as const : []));
    } else {
      await permissionManager.addRulePersist({ pattern, action }, { kind: "user" }, ...(authority ? [authority] as const : []));
    }
  } catch (error) {
    // A rule that validated but could not be stored (a refused allow prefix, a corrupt file, a lock or I/O) is reported as a failed save.
    return fail("rule-save-failed", errorMessage(error));
  }
  const warning = action === "allow" && isWildcardAllow(target, pattern)
    ? target.kind === "shell" ? WILDCARD_ALLOW_BROADER_SCOPE : WILDCARD_ALLOW_SANDBOXED_ONLY
    : undefined;
  return { ok: true, action, scope, pattern, edited: edited !== undefined, ...(warning === undefined ? {} : { warning }) };
}
