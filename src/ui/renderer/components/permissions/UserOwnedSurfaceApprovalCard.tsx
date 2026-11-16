import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { UserOwnedSurfaceChoice } from "../../../../shared/permissions-events.js";
import { canonicalStringify } from "../../../../shared/canonical-json.js";
import type { ApprovalDecisionExtras } from "../../hooks/use-approval.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";
import { isDarwin } from "../../api-client.js";
import { MODAL_DIALOG_SELECTOR, TEST_IDS, testIdSelector } from "../../../../shared/test-ids.js";

/**
 * Whether Cmd+Enter (macOS) or Ctrl+Enter pressed now is meant for the card in `panel`. The card never takes focus from the user, so the key is
 * accepted from where they are: the card itself, the composer of the card's own surface (a text field there), or nowhere in particular while this
 * is the only approval card on screen. A user typing in another tile, in a dialog or in a terminal never answers this card: keys typed into the
 * terminal the card is about belong to its shell, and must not approve the agent's access to it.
 */
function acceptShortcutIsFor(panel: HTMLElement, event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "repeat">, darwin: boolean): boolean {
  if (event.key !== "Enter" || event.isComposing || event.repeat || event.altKey || event.shiftKey) return false;
  if (darwin ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  if (document.querySelector(MODAL_DIALOG_SELECTOR) !== null) return false;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return document.querySelectorAll(testIdSelector(TEST_IDS.approvalDock)).length <= 1;
  if (panel.contains(active)) return true;
  if (active.closest(".xterm") !== null) return false;
  const composer = active.matches("textarea, input, [contenteditable]:not([contenteditable='false'])");
  return composer && panel.closest("[data-approval-scope]")?.contains(active) === true;
}

/** The pipeline's reasons for a user-owned-surface card that are fixed sentences: shown in the user's language by code. Any other reason (a rule's own text, an exfiltration
 * finding) is the host's and is shown as sent. */
const SURFACE_REASON_KEYS: Readonly<Record<string, string>> = {
  "user-owned-surface-ask": "toolApprovalDialog.surfaceReasonAsk",
  "user-owned-surface-human-required": "toolApprovalDialog.surfaceReasonHumanRequired",
  "user-owned-surface-review": "toolApprovalDialog.surfaceReasonReview",
};

/** The host-terminal command as the card shows it above its choices. */
export interface HostTerminalCommandFacts {
  /** The exact command text the approval types. */
  text: string;
  /** The sealed terminal, shell and directory; null when the request carries no sealed target. */
  where: string | null;
  /** Characters that can look like others, named by code point; null when there are none. */
  lookalikeNote: string | null;
}

export function UserOwnedSurfaceApprovalCard({ request, conversationLabel, interactionLocked, onDecide, targetDescription, notes, command = null, pendingCount = 1 }: {
  request: ApprovalRequest;
  conversationLabel: string;
  interactionLocked: boolean;
  onDecide: (choice: ApprovalChoice, pattern?: string, extras?: ApprovalDecisionExtras) => void;
  targetDescription: string | null;
  notes: readonly string[];
  /** Host terminal only: the command this card approves. It is drawn before the choices, never only inside the collapsed details. */
  command?: HostTerminalCommandFacts | null;
  pendingCount?: number;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<UserOwnedSurfaceChoice>("ask");
  const [submitted, setSubmitted] = useState(false);
  const answered = useRef(false);
  const disabled = interactionLocked || submitted;
  const realShellWarning = request.userOwnedSurface === "host-terminal" ? t("toolApprovalDialog.hostTerminalWarning") : null;
  const selectedDescription = selection === "allow" ? t("toolApprovalDialog.surfaceAllowDescription")
    : selection === "auto" ? t("toolApprovalDialog.surfaceAutoDescription") : t("toolApprovalDialog.surfaceAskDescription");
  const reasonKey = request.reasonCode === undefined ? undefined : SURFACE_REASON_KEYS[request.reasonCode];
  // A relayed request keeps the principal the host put in front of its reason.
  const reason = reasonKey === undefined ? request.reason : [request.approvalReasonPrefix, t(reasonKey)].filter(Boolean).join(" ");
  const answer = (allow: boolean) => {
    if (disabled || answered.current) return;
    answered.current = true;
    setSubmitted(true);
    if (allow) onDecide("allow-once", undefined, { userOwnedSurfaceChoice: selection });
    else onDecide("deny-once");
  };
  const panelRef = useRef<HTMLDivElement | null>(null);
  const answerRef = useRef(answer);
  answerRef.current = answer;
  const darwin = isDarwin();
  // The accept key works from the composer the user is typing in: the card does not take their focus to be answerable.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const panel = panelRef.current;
      if (!panel || !acceptShortcutIsFor(panel, event, darwin)) return;
      event.preventDefault();
      event.stopPropagation();
      answerRef.current(true);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [darwin]);
  const acceptKeys = darwin ? "⌘↵" : "Ctrl+↵";
  return (
    <div ref={panelRef} data-testid="tool-approval-panel" data-approval-request-id={request.id} data-approval-tool-name={request.toolName}
      data-approval-args={canonicalStringify(request.args)} data-pending-count={pendingCount} tabIndex={-1}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); answer(false); } }}>
    <section data-testid="user-owned-surface-card" className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3" aria-label={t("toolApprovalDialog.surfaceTitle")}>
      <div className="flex shrink-0 items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{request.userOwnedSurface === "browser" ? t("toolApprovalDialog.surfaceBrowser") : t("toolApprovalDialog.surfaceTerminal")}</h3>
        <p className="truncate text-xs text-muted-foreground" title={conversationLabel}>{conversationLabel}</p>
      </div>
      {command && (
        <section className="flex min-h-12 shrink flex-col gap-1 overflow-hidden" data-testid="user-owned-surface-command-block" aria-labelledby={`surface-command-${request.id}`}>
          <p className="shrink-0 text-xs font-medium" id={`surface-command-${request.id}`}>{t("toolApprovalDialog.hostTerminalCommandLabel")}</p>
          {/* The exact text: wrapped, never truncated; a long command scrolls inside this block so the choices stay on screen. */}
          <pre className="min-h-6 max-h-28 shrink overflow-y-auto whitespace-pre-wrap break-all rounded border bg-muted/(--opacity-subtle) px-2 py-1 font-mono text-xs"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a long command scrolls inside this block, and a keyboard user must be able to scroll it to read all of what they approve.
            data-testid="user-owned-surface-command" tabIndex={0}>{command.text}</pre>
          {command.lookalikeNote && <p className="shrink-0 text-xs font-medium leading-snug text-warning" role="note" data-testid="user-owned-surface-lookalikes">{command.lookalikeNote}</p>}
          {command.where && <p className="shrink-0 break-words text-xs leading-snug text-muted-foreground" data-testid="user-owned-surface-command-where">{command.where}</p>}
        </section>
      )}
      {realShellWarning && <p className="shrink-0 text-xs leading-snug text-muted-foreground" data-testid="user-owned-surface-note">{realShellWarning}</p>}
      <details className="min-h-0 shrink overflow-hidden rounded border open:flex open:flex-col" data-testid="user-owned-surface-review-details">
        <summary className="shrink-0 cursor-pointer px-2 py-1 text-xs font-medium" title={t("toolApprovalDialog.reviewDetailsHint")}>{t("toolApprovalDialog.reviewDetails")}</summary>
        <div className="min-h-0 max-h-32 space-y-2 overflow-y-auto border-t p-2 text-xs" data-testid="user-owned-surface-details-content">
          <p data-testid="user-owned-surface-reason">{reason}</p>
          {targetDescription && <p className="break-words" data-testid="user-owned-surface-target">{targetDescription}</p>}
          {notes.filter((note) => note !== realShellWarning && note !== command?.lookalikeNote).map((note) => <p key={note} className="text-muted-foreground" data-testid="user-owned-surface-note">{note}</p>)}
          <p className="font-medium">{t("toolApprovalDialog.showFullInput")}</p>
          <pre className="whitespace-pre-wrap break-words font-mono" data-testid="user-owned-surface-full-input">{JSON.stringify(request.args, null, 2)}</pre>
          <p className="text-muted-foreground">{t("toolApprovalDialog.surfaceSessionOnly")}</p>
          <p className="text-muted-foreground">{t("toolApprovalDialog.surfaceScope")}</p>
        </div>
      </details>
      <form className="flex shrink-0 flex-col gap-2" data-testid="user-owned-surface-choice-form" onSubmit={(event) => { event.preventDefault(); answer(true); }}>
        <fieldset disabled={disabled} className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-medium">{t("toolApprovalDialog.surfaceTitle")}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name={`surface-${request.id}`} value="allow" checked={selection === "allow"} onChange={() => setSelection("allow")} data-testid="user-owned-surface-allow" />
            <span>{t("toolApprovalDialog.surfaceAllow")}<span className="sr-only">{t("toolApprovalDialog.surfaceAllowDescription")}</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name={`surface-${request.id}`} value="auto" checked={selection === "auto"} onChange={() => setSelection("auto")} data-testid="user-owned-surface-auto" />
            <span>{t("toolApprovalDialog.surfaceAuto")}<span className="sr-only">{t("toolApprovalDialog.surfaceAutoDescription")}</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name={`surface-${request.id}`} value="ask" checked={selection === "ask"} onChange={() => setSelection("ask")} data-testid="user-owned-surface-ask" />
            <span>{t("toolApprovalDialog.surfaceAsk")}<span className="sr-only">{t("toolApprovalDialog.surfaceAskDescription")}</span></span>
          </label>
        </fieldset>
        <p className="text-xs leading-snug text-muted-foreground" data-testid="user-owned-surface-choice-description">{selectedDescription}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={disabled} data-testid="user-owned-surface-dismiss" onClick={() => answer(false)}>{t("toolApprovalDialog.surfaceDismiss")}</Button>
          <Button type="submit" disabled={disabled} data-testid="user-owned-surface-confirm" aria-keyshortcuts={darwin ? "Meta+Enter" : "Control+Enter"}
            title={t("toolApprovalDialog.surfaceAcceptHint", { keys: acceptKeys })}>
            {selection === "auto" ? t("toolApprovalDialog.surfaceReview") : t("toolApprovalDialog.surfaceConfirm")}
            <kbd className="ml-1.5 rounded border border-current/(--opacity-soft) px-1 font-sans text-tiny opacity-80" data-testid="user-owned-surface-accept-keys">{acceptKeys}</kbd>
          </Button>
        </div>
      </form>
    </section>
    </div>
  );
}
