/** The one decision row every approval card draws (owner 2026-10-25, unified approval card): Deny ▾ | Allow for session ▾ | Allow once. A dropdown item selects a remembering choice (Always deny; Allow for session, Always allow in this project, Always allow everywhere); the button beside it then names that choice and commits it, and "Edit rule" appears above the row for a choice that saves a rule. Allow once commits at once. The card decides what each choice means for its approval type (see `approval-decision.ts`); the host checks every answer again. */
import { useCallback, useEffect, useId, useState, type ButtonHTMLAttributes, type ReactElement, type Ref } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../../components/ui/dropdown-menu.js";
import { Input } from "../../../../components/ui/input.js";
import { useTranslation } from "../../../../i18n/react.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import {
  ALLOW_MENU_CHOICES,
  DECISION_LABEL_KEYS,
  defaultAllowChoice,
  isWildcardRuleText,
  wildcardWarningKey,
  type ApprovalCardChoice,
  type ApprovalDecisionModel,
  type RememberingChoice,
} from "./approval-decision.js";

/** The row's selection: the remembering choice a dropdown selected (null: none), and the rule text being edited for it (null: not editing). */
export interface ApprovalDecisionState {
  readonly selected: RememberingChoice | null;
  readonly draft: string | null;
  readonly select: (choice: RememberingChoice | null) => void;
  readonly setDraft: (draft: string | null) => void;
}

/** Selection state for one request; it starts over when the request changes. */
export function useApprovalDecisionState(requestId: string | null): ApprovalDecisionState {
  const [selected, setSelected] = useState<RememberingChoice | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    setSelected(null);
    setDraft(null);
  }, [requestId]);
  const select = useCallback((choice: RememberingChoice | null) => {
    setSelected(choice);
    setDraft(null);
  }, []);
  return { selected, draft, select, setDraft };
}

/** The choice each of the three buttons commits now: Deny or the selected Always deny; the selected allow or the first one offered; Allow once. */
function slotChoices(model: ApprovalDecisionModel, selected: RememberingChoice | null): readonly [ApprovalCardChoice, RememberingChoice | null, ApprovalCardChoice] {
  const allow = selected !== null && selected !== "deny-always" ? selected : defaultAllowChoice(model);
  return [selected === "deny-always" ? "deny-always" : "deny-once", allow, "allow-once"];
}

/** The rule text a commit carries: the edited text when the person changed the rule, else none (the host saves the rule it derived). Null when the selected choice needs a written rule and has none yet. */
function editedRuleFor(model: ApprovalDecisionModel, state: Pick<ApprovalDecisionState, "selected" | "draft">, choice: ApprovalCardChoice): string | undefined | null {
  if (choice === "deny-once" || choice === "allow-once") return undefined;
  const option = model.options[choice];
  const missing = option.needsEdit ? null : undefined;
  if (choice !== state.selected || option.editing !== "inline" || state.draft === null) return missing;
  const text = state.draft.trim();
  if (text.length === 0) return missing;
  return text === option.rule ? undefined : text;
}

/** Whether each of the three buttons is disabled, so a card's focus order skips exactly the buttons the row disables. */
export function decisionSlotsDisabled(
  model: ApprovalDecisionModel,
  state: Pick<ApprovalDecisionState, "selected" | "draft">,
  flags: { readonly locked: boolean; readonly denyUnavailable?: boolean; readonly allowUnavailable?: boolean; readonly allowOnceUnavailable?: boolean },
): readonly [boolean, boolean, boolean] {
  const [deny, allow] = slotChoices(model, state.selected);
  return [
    flags.locked || flags.denyUnavailable === true || (deny === "deny-always" && editedRuleFor(model, state, deny) === null),
    flags.locked || flags.allowUnavailable === true || allow === null || editedRuleFor(model, state, allow) === null,
    flags.locked || flags.allowUnavailable === true || flags.allowOnceUnavailable === true,
  ];
}

type SlotProps = ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement>; "data-proposed"?: string };

export function ApprovalDecisionBar({
  model,
  state,
  disabled,
  onCommit,
  onEditInSettings,
  editInSettingsDisabled = false,
  slotProps,
  hideAllows = false,
  compact = false,
  stackWhenNarrow = false,
}: {
  model: ApprovalDecisionModel;
  state: ApprovalDecisionState;
  /** From `decisionSlotsDisabled`. */
  disabled: readonly [boolean, boolean, boolean];
  onCommit: (choice: ApprovalCardChoice, editedRule?: string) => void;
  /** Opens Settings on this request's exact deny, for a choice whose rule Settings edits. It is not a decision, so a lock on the decisions (Settings
   * already holding the draft) leaves it open as the way back; only `editInSettingsDisabled` closes it. */
  onEditInSettings?: () => void;
  editInSettingsDisabled?: boolean;
  /** Per-button attributes a card adds (focus order, shortcuts, descriptions). */
  slotProps?: (slot: 0 | 1 | 2) => SlotProps;
  /** Draw Deny only: a sealed display that cannot be read offers no allow at all. */
  hideAllows?: boolean;
  compact?: boolean;
  /** Stack the three buttons when the bar itself is narrow (it is its own size container, so this holds wherever the bar is drawn). */
  stackWhenNarrow?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  // A terminal banner draws one row per ask, so the editor's label pairs with its own input.
  const inputId = useId();
  const [denyChoice, allowChoice] = slotChoices(model, state.selected);
  const selectedOption = state.selected === null ? null : model.options[state.selected];
  const editing = selectedOption?.editing ?? null;
  // The row above the buttons appears once a choice is selected: what it saves, and Edit rule where the rule can be edited.
  const showEdit = selectedOption !== null && (editing !== null || selectedOption.rule !== null);
  const editorOpen = editing === "inline" && (state.draft !== null || selectedOption?.needsEdit === true);
  const draftText = state.draft ?? selectedOption?.rule ?? "";
  const warnWildcard = model.warnsOnWildcardAllow && state.selected !== null && state.selected !== "deny-always" &&
    editorOpen && isWildcardRuleText(draftText);
  const commit = (choice: ApprovalCardChoice | null) => {
    if (choice === null) return;
    const edited = editedRuleFor(model, state, choice);
    if (edited === null) return;
    onCommit(choice, edited);
  };
  const lockAll = disabled[0] && disabled[1] && disabled[2];
  // Compact (a terminal banner) keeps the row short but never fixes the height: a label that wraps grows its button instead of overflowing it.
  const buttonSize = compact ? "min-h-7 px-2 py-1 text-xs" : "";
  const slot = (index: 0 | 1 | 2): SlotProps => slotProps?.(index) ?? {};
  const menuItem = (choice: RememberingChoice | "deny-once") => {
    const option = choice === "deny-once" ? null : model.options[choice];
    const reason = option?.offered === false && option.reasonKey !== null ? t(option.reasonKey) : null;
    return (
      <DropdownMenuItem
        key={choice}
        disabled={option?.offered === false}
        data-testid={`approval-choice-${choice}`}
        data-selected={(choice === "deny-once" ? state.selected === null || state.selected !== "deny-always" : state.selected === choice) ? "true" : undefined}
        className="flex-col items-start gap-0.5"
        onSelect={() => state.select(choice === "deny-once" ? null : choice)}
      >
        <span className="text-xs">{t(option?.labelKey ?? DECISION_LABEL_KEYS["deny-once"])}</span>
        {reason ? <span className="text-[10px] text-muted-foreground" data-testid={`approval-choice-${choice}-reason`}>{reason}</span> : null}
      </DropdownMenuItem>
    );
  };
  const chevron = (testId: string, ariaKey: string, menuDisabled: boolean) => (
    <DropdownMenuTrigger asChild disabled={menuDisabled}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={`h-auto shrink-0 rounded-l-none border-l-0 px-1 ${buttonSize}`}
        aria-label={t(ariaKey)}
        data-testid={testId}
      >
        <ChevronDown className="size-3" aria-hidden />
      </Button>
    </DropdownMenuTrigger>
  );
  const mainClass = `h-auto min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere] leading-tight ${compact ? buttonSize : "px-1 py-2 text-[11px]"}`;
  return (
    <div className={`min-w-0 space-y-1.5 ${stackWhenNarrow ? "@container" : ""}`} data-testid="approval-decision-bar" data-approval-variant={model.variant} data-selected-choice={state.selected ?? undefined}>
      {showEdit ? (
        <div className="min-w-0 space-y-1" data-testid="approval-rule-row">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <p className="min-w-0 break-all text-[11px] text-muted-foreground">
              {selectedOption?.rule !== null && selectedOption?.rule !== undefined && !editorOpen ? (
                <>
                  {t("toolApprovalDialog.ruleToSave")}{" "}
                  <code className="font-mono text-xs text-foreground" data-testid="approval-rule-pattern">{selectedOption.rule}</code>
                </>
              ) : editing === "settings" ? t("toolApprovalDialog.exactDenyInSettings") : null}
            </p>
            {editing === "inline" && !editorOpen ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={lockAll}
                data-testid="approval-edit-rule"
                onClick={() => state.setDraft(selectedOption?.rule ?? "")}>
                {t("toolApprovalDialog.editRule")}
              </Button>
            ) : null}
            {editing === "settings" ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={editInSettingsDisabled || !onEditInSettings}
                data-testid={TEST_IDS.openPermanentDenySettings}
                onClick={() => onEditInSettings?.()}>
                {t("toolApprovalDialog.editRule")}
              </Button>
            ) : null}
          </div>
          {editorOpen ? (
            <div className="min-w-0 space-y-1">
              <label className="block text-[11px] text-muted-foreground" htmlFor={inputId}>{t("toolApprovalDialog.editRuleLabel")}</label>
              <Input
                id={inputId}
                className="h-7 font-mono text-xs"
                value={draftText}
                disabled={lockAll}
                spellCheck={false}
                autoComplete="off"
                data-testid="approval-rule-input"
                onChange={(event) => state.setDraft(event.target.value)}
              />
              {selectedOption?.needsEdit && draftText.trim().length === 0 ? (
                <p className="text-[10px] text-muted-foreground" data-testid="approval-rule-required">{t("toolApprovalDialog.ruleEditRequired")}</p>
              ) : null}
              {warnWildcard ? (
                <p role="note" className="text-[10px] font-medium text-warning" data-testid="approval-rule-wildcard-warning">
                  {t(wildcardWarningKey(model))}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        className={`grid min-w-0 gap-2 ${hideAllows ? "grid-cols-1" : "grid-cols-3"} ${stackWhenNarrow ? "@max-[14rem]:grid-cols-1" : ""}`}
        data-testid="approval-decision-actions"
      >
        <DropdownMenu modal={false}>
          <div className="flex min-w-0">
            <Button
              type="button"
              size="sm"
              variant="outline"
              {...slot(0)}
              className={`${mainClass} rounded-r-none border-destructive text-destructive hover:bg-destructive/(--opacity-soft)`}
              disabled={disabled[0]}
              data-testid={TEST_IDS.denyButton}
              data-choice={denyChoice}
              onClick={() => commit(denyChoice)}
            >
              {t(DECISION_LABEL_KEYS[denyChoice])}
            </Button>
            {chevron("approval-deny-menu", "toolApprovalDialog.moreDenyChoices", lockAll)}
          </div>
          <DropdownMenuContent align="start" className="max-w-72">
            {menuItem("deny-once")}
            <DropdownMenuSeparator />
            {menuItem("deny-always")}
          </DropdownMenuContent>
        </DropdownMenu>
        {hideAllows ? null : (
          <DropdownMenu modal={false}>
            <div className="flex min-w-0">
              <Button
                type="button"
                size="sm"
                variant="outline"
                {...slot(1)}
                className={`${mainClass} rounded-r-none`}
                disabled={disabled[1]}
                data-testid={TEST_IDS.allowSessionButton}
                data-choice={allowChoice ?? undefined}
                onClick={() => commit(allowChoice)}
              >
                {t(allowChoice === null ? DECISION_LABEL_KEYS["allow-session"] : model.options[allowChoice].labelKey)}
              </Button>
              {chevron("approval-allow-menu", "toolApprovalDialog.moreAllowChoices", lockAll)}
            </div>
            <DropdownMenuContent align="start" className="max-w-72">
              {ALLOW_MENU_CHOICES.map((choice) => menuItem(choice))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {hideAllows ? null : (
          <Button
            type="button"
            size="sm"
            variant="default"
            {...slot(2)}
            className={mainClass}
            disabled={disabled[2]}
            data-testid={TEST_IDS.approveButton}
            data-choice="allow-once"
            onClick={() => commit("allow-once")}
          >
            {t(DECISION_LABEL_KEYS["allow-once"])}
          </Button>
        )}
      </div>
    </div>
  );
}
