/** The decisions every approval card offers (owner 2026-10-25, unified approval card), as data: one row of Deny ▾ | Allow for session ▾ | Allow once, the same six choices for every approval type, and per type which of them this request offers, why the others are not offered, and the rule a remembering choice saves. `ApprovalDecisionBar` draws it; each card maps the chosen choice onto its own host answer. Nothing here decides authority: every choice is checked again by the host. */
import type { ApprovalRequest } from "../../types.js";
import type { EgressGrantScope } from "../../../../shared/egress-grant-scopes.js";
import type { ApprovalRuleSave, ShellRuleApproval, ShellRuleSaveScope } from "../../../../shared/permissions-events.js";
import { formatIpcError, resolveIpcErrorKey } from "../../format-ipc-error.js";

/** The six choices of the row. The two dropdowns hold the four remembering ones; Allow for session is in its dropdown too, so a session rule can be selected and edited like the others. */
export type ApprovalCardChoice =
  | "deny-once"
  | "deny-always"
  | "allow-session"
  | "allow-project"
  | "allow-everywhere"
  | "allow-once";

/** A choice a dropdown holds. */
export type RememberingChoice = Exclude<ApprovalCardChoice, "deny-once" | "allow-once">;

const ALLOW_MENU_CHOICES = ["allow-session", "allow-project", "allow-everywhere"] as const satisfies readonly RememberingChoice[];

/** How "Edit rule" edits a selected choice's rule: in the card (a rule the host checks against the card's grammar), in Settings (an exact tool approval), or not at all. */
type RuleEditing = "inline" | "settings" | null;

interface DecisionOption {
  readonly offered: boolean;
  /** i18n key of why the choice is not offered; null when it is. */
  readonly reasonKey: string | null;
  /** The rule this choice saves unless edited (shown on the card); null when it saves no rule text or the host derived none. */
  readonly rule: string | null;
  readonly editing: RuleEditing;
  /** The choice has no rule of its own to save, so it is saved only after the person writes one. */
  readonly needsEdit: boolean;
  /** i18n key of the choice's label. */
  readonly labelKey: string;
  /** i18n key of what an offered choice covers, when the label alone would mislead (a host terminal card's Always deny saves a broad Bash rule). */
  readonly noteKey?: string;
}

export interface ApprovalDecisionModel {
  /** Which approval type the row was built for; also the bar's `data-approval-variant`. */
  readonly variant: "shell" | "network" | "exact" | "path-grant" | "one-shot";
  readonly options: Readonly<Record<RememberingChoice, DecisionOption>>;
  /** An edited allow that is a wildcard runs only sandboxed commands; the card says so while the rule is edited. */
  readonly warnsOnWildcardAllow: boolean;
  /** The lasting allows this card lists, in order; absent means every one of {@link ALLOW_MENU_CHOICES}. */
  readonly allowChoices?: readonly RememberingChoice[];
}

export const DECISION_LABEL_KEYS: Readonly<Record<ApprovalCardChoice, string>> = {
  "deny-once": "toolApprovalDialog.decisionDeny",
  "deny-always": "toolApprovalDialog.decisionDenyAlways",
  "allow-session": "toolApprovalDialog.decisionAllowSession",
  "allow-project": "toolApprovalDialog.decisionAllowProject",
  "allow-everywhere": "toolApprovalDialog.decisionAllowEverywhere",
  "allow-once": "toolApprovalDialog.allowOnce",
};

/** A host terminal card's lasting allow names one command in one folder of one shell, not "everywhere". */
const HOST_TERMINAL_ALLOW_LABEL_KEY = "toolApprovalDialog.decisionAllowHostTerminal";

/** A folder card's lasting allow is "Always allow this folder", not "everywhere": it grants the folder, not the tool. */
export const FOLDER_ALLOW_LABEL_KEY = "toolApprovalDialog.decisionAllowFolder";

function offered(rule: string | null, editing: RuleEditing, labelKey: string, needsEdit = false): DecisionOption {
  return { offered: true, reasonKey: null, rule, editing, needsEdit, labelKey };
}

function refused(reasonKey: string, labelKey: string): DecisionOption {
  return { offered: false, reasonKey, rule: null, editing: null, needsEdit: false, labelKey };
}

const label = (choice: RememberingChoice): string => DECISION_LABEL_KEYS[choice];

/** A bash or PowerShell card: every remembering choice saves a `Bash(...)` / `PowerShell(...)` rule, editable in the card. Always deny saves the command's literal argv, or a rule the person writes when there is none. */
export function shellDecisionModel(rule: ShellRuleApproval): ApprovalDecisionModel {
  const exact = rule.exactRule;
  if (rule.hostTerminal !== undefined) {
    // The user's own host terminal: the only lasting allow is the exact `HostTerminal(...)` rule (this shell, this folder, this command),
    // saved as written by the host; no session or project allow, and the rule is not editable into anything broader.
    return {
      variant: "shell",
      options: {
        // Always deny saves a `Bash(...)` rule, which denies the command in every shell and folder: the card says so.
        "deny-always": rule.denyAllowed
          ? { ...offered(rule.denyRule, "inline", label("deny-always"), rule.denyRule === null), noteKey: "toolApprovalDialog.hostTerminalDenyScope" }
          : refused("toolApprovalDialog.persistentUnavailableOneShot", label("deny-always")),
        "allow-session": refused("toolApprovalDialog.hostTerminalRuleScope", label("allow-session")),
        "allow-project": refused("toolApprovalDialog.hostTerminalRuleScope", label("allow-project")),
        "allow-everywhere": exact === null
          ? refused("toolApprovalDialog.shellExactRuleUnavailable", HOST_TERMINAL_ALLOW_LABEL_KEY)
          : offered(exact, null, HOST_TERMINAL_ALLOW_LABEL_KEY),
      },
      warnsOnWildcardAllow: false,
      // No session or project allow exists here, so the card lists only the one lasting allow it can save.
      allowChoices: ["allow-everywhere"],
    };
  }
  const allow = (choice: RememberingChoice, allowed: boolean): DecisionOption =>
    exact === null
      ? refused("toolApprovalDialog.shellExactRuleUnavailable", label(choice))
      : allowed
        ? offered(exact, "inline", label(choice))
        : refused("toolApprovalDialog.persistentUnavailableOneShot", label(choice));
  return {
    variant: "shell",
    options: {
      "deny-always": rule.denyAllowed
        ? offered(rule.denyRule, "inline", label("deny-always"), rule.denyRule === null)
        : refused("toolApprovalDialog.persistentUnavailableOneShot", label("deny-always")),
      "allow-session": allow("allow-session", rule.sessionAllowed),
      "allow-project": allow("allow-project", rule.persistentAllowed),
      "allow-everywhere": allow("allow-everywhere", rule.persistentAllowed),
    },
    warnsOnWildcardAllow: true,
  };
}

type EgressPayload = NonNullable<ApprovalRequest["egressHost"]>;

/** A network card: an allow left as it is keeps the grant of that lifetime (revocable with the other grants); Always deny, and any allow whose rule is edited, saves a `Network(...)` host rule. Host rules are shell-origin, so a terminal tab's card offers none (its allows are grants only), and a destination the rule grammar cannot name (an address literal) offers none either. */
export function networkDecisionModel(payload: EgressPayload, sessionId: string | undefined): ApprovalDecisionModel {
  const rule = payload.rule;
  const ruleEditing = (scopeHoldsRule: boolean): RuleEditing => rule !== null && scopeHoldsRule ? "inline" : null;
  const terminal = payload.terminalTabId !== undefined;
  const sessionScope: EgressGrantScope = terminal ? "tab" : "session";
  const scoped = (choice: RememberingChoice, scope: EgressGrantScope, holdsRule: boolean, labelKey = label(choice)): DecisionOption =>
    payload.scopes.includes(scope)
      ? offered(ruleEditing(holdsRule) === null ? null : rule, ruleEditing(holdsRule), labelKey)
      : refused(payload.network === "public" ? "toolApprovalDialog.networkScopeNotOffered" : "toolApprovalDialog.networkLocalScopeNotOffered", labelKey);
  return {
    variant: "network",
    options: {
      "deny-always": rule === null
        ? refused(terminal ? "toolApprovalDialog.networkRuleTerminal" : "toolApprovalDialog.networkRuleUnavailable", label("deny-always"))
        : offered(rule, "inline", label("deny-always")),
      "allow-session": scoped("allow-session", sessionScope, !terminal && sessionId !== undefined, terminal ? "toolApprovalDialog.decisionAllowShell" : label("allow-session")),
      "allow-project": scoped("allow-project", "project", payload.projectCwd !== undefined),
      "allow-everywhere": scoped("allow-everywhere", "always", true),
    },
    // An edited `Network(*.…)` allow decides only sandboxed commands' connections; the host saves it with the same warning as a wildcard shell allow.
    warnsOnWildcardAllow: true,
  };
}

/** A card whose remembered allow is an exact tool approval (this tool with this input): for the conversation, for this project folder, or everywhere (a user-global approval, owner 2026-10-25); Always deny as an exact deny, edited in Settings. */
export function exactDecisionModel(input: {
  readonly sessionOnly: boolean;
  readonly hasSession: boolean;
  /** Why an allow cannot be remembered for this request, or null when it can. */
  readonly allowRefusalKey: string | null;
  /** Why the exact-approval store records nothing for this request (a one-shot ask), or null when it records a deny. */
  readonly denyRefusalKey: string | null;
  /** Settings can hold this request's exact-deny draft. */
  readonly settingsEditing: boolean;
}): ApprovalDecisionModel {
  const allow = (choice: RememberingChoice): DecisionOption =>
    input.allowRefusalKey !== null
      ? refused(input.allowRefusalKey, label(choice))
      : offered(null, null, label(choice));
  return {
    variant: "exact",
    options: {
      "deny-always": input.denyRefusalKey !== null
        ? refused(input.denyRefusalKey, label("deny-always"))
        : offered(null, input.settingsEditing ? "settings" : null, label("deny-always")),
      "allow-session": input.hasSession || input.allowRefusalKey !== null ? allow("allow-session") : refused("toolApprovalDialog.sessionAllowNeedsConversation", label("allow-session")),
      "allow-project": input.sessionOnly ? refused("toolApprovalDialog.sessionOnlyRemember", label("allow-project")) : allow("allow-project"),
      "allow-everywhere": input.sessionOnly ? refused("toolApprovalDialog.sessionOnlyRemember", label("allow-everywhere")) : allow("allow-everywhere"),
    },
    warnsOnWildcardAllow: false,
  };
}

/** A folder-access card: always allowing the parent folder is its one remembering allow (when the host found a safe parent), labelled for the folder. Always deny is an exact deny of this request, edited in Settings, as for an exact tool approval, and refused where the exact-approval store records nothing (`denyRefusalKey`). */
export function pathGrantDecisionModel(parent: string | null, parentReasonKey: string, settingsEditing: boolean, denyRefusalKey: string | null): ApprovalDecisionModel {
  const notFolder = (choice: RememberingChoice) => refused("toolApprovalDialog.pathGrantOnlyFolder", label(choice));
  return {
    variant: "path-grant",
    options: {
      "deny-always": denyRefusalKey !== null
        ? refused(denyRefusalKey, label("deny-always"))
        : offered(null, settingsEditing ? "settings" : null, label("deny-always")),
      "allow-session": notFolder("allow-session"),
      "allow-project": notFolder("allow-project"),
      "allow-everywhere": parent === null ? refused(parentReasonKey, FOLDER_ALLOW_LABEL_KEY) : offered(parent, null, FOLDER_ALLOW_LABEL_KEY),
    },
    warnsOnWildcardAllow: false,
  };
}

/** A request the host answers once only (high risk, a sealed rationale, an elicitation, a host-narrowed choice set): every remembering choice is shown and refused with the reason. */
export function oneShotDecisionModel(reasonKey: string): ApprovalDecisionModel {
  return {
    variant: "one-shot",
    options: {
      "deny-always": refused(reasonKey, label("deny-always")),
      "allow-session": refused(reasonKey, label("allow-session")),
      "allow-project": refused(reasonKey, label("allow-project")),
      "allow-everywhere": refused(reasonKey, label("allow-everywhere")),
    },
    warnsOnWildcardAllow: false,
  };
}

/** What the middle button does with nothing selected: the first allow its dropdown offers (Allow for session when offered). */
export function defaultAllowChoice(model: ApprovalDecisionModel): RememberingChoice | null {
  return allowMenuChoices(model).find((choice) => model.options[choice].offered) ?? null;
}

/** The lasting allows `model`'s card lists. */
export function allowMenuChoices(model: ApprovalDecisionModel): readonly RememberingChoice[] {
  return model.allowChoices ?? ALLOW_MENU_CHOICES;
}

/** Why the middle button cannot allow anything, or null when it can: a folder card's reason is its folder's; every other card's is its session allow's. */
export function allowRefusalKey(model: ApprovalDecisionModel): string | null {
  if (defaultAllowChoice(model) !== null) return null;
  return model.options[allowMenuChoices(model)[0] === "allow-everywhere" || model.variant === "path-grant" ? "allow-everywhere" : "allow-session"].reasonKey;
}

/** True for a rule text the host saves with the `wildcard-allow-sandboxed-only` warning, matching its rule grammar: a shell rule ending in the ` *` wildcard (`Bash(git *)`, `PowerShell(Get-Item *)`) or a host rule naming subdomains (`Network(*.example.com)`). */
export function isWildcardRuleText(text: string): boolean {
  return /^\s*(?:bash|powershell)\s*\((?:.*\s)?\*\s*\)\s*$/i.test(text) || /^\s*network\s*\(\s*\*\./i.test(text);
}

/** The i18n key of the wildcard-allow warning for a card's rule kind. */
export function wildcardWarningKey(model: ApprovalDecisionModel): string {
  return model.variant === "network" ? "toolApprovalDialog.wildcardHostAllowSandboxedOnly" : "toolApprovalDialog.wildcardAllowSandboxedOnly";
}

/** The card rule a remembering choice stores: Always deny is user-global; allows are saved for the conversation, the project or everywhere. */
export function ruleSaveFor(choice: RememberingChoice, editedRule: string | undefined): ApprovalRuleSave {
  const scope: ShellRuleSaveScope = choice === "allow-session" ? "session" : choice === "allow-project" ? "project" : "always";
  const action = choice === "deny-always" ? "deny" : "allow";
  return editedRule === undefined ? { action, scope } : { action, scope, pattern: editedRule };
}

/** How a network card answers a choice: the host rule to save first (Always deny, or an edited allow), then the gate answer. An allow left as it is answers with the grant of the same lifetime. */
export function networkAnswer(
  payload: EgressPayload,
  choice: ApprovalCardChoice,
  editedRule: string | undefined,
): { readonly rule?: ApprovalRuleSave; readonly choice: "allow-once" | "deny-once"; readonly egressScope?: EgressGrantScope } {
  switch (choice) {
    case "deny-once":
      return { choice: "deny-once" };
    case "deny-always":
      return { rule: ruleSaveFor(choice, editedRule), choice: "deny-once" };
    case "allow-once":
      return { choice: "allow-once", egressScope: "once" };
    default: {
      if (editedRule !== undefined) return { rule: ruleSaveFor(choice, editedRule), choice: "allow-once", egressScope: "once" };
      const scope: EgressGrantScope = choice === "allow-session"
        ? (payload.terminalTabId === undefined ? "session" : "tab")
        : choice === "allow-project" ? "project" : "always";
      return { choice: "allow-once", egressScope: scope };
    }
  }
}

/** The card's message for a refused rule save: the mapped reason for the host's error code, plus the host's detail for a rejected rule or a storage failure so an invalid rule reads differently from an unwritable file. */
export function ruleSaveErrorText(result: { error?: string; message?: string } | undefined, fallback: string): string {
  const code = result?.error;
  const reason = resolveIpcErrorKey(code) ? formatIpcError(code, undefined) : fallback;
  const detail = (code === "invalid-rule" || code === "rule-does-not-match" || code === "rule-save-failed") && result?.message ? result.message : null;
  return detail ? `${reason} (${detail})` : reason;
}
