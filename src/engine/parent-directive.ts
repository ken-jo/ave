// Running and resumed children share one directive grammar.
// Keep host labels outside fences and neutralize parent-authored closing tags.
import { t } from "../i18n/index.js";
import { neutralizeFenceClose, type FenceTag } from "../shared/fence-sanitizer.js";

/** Registered in `fence-sanitizer.ts`; the tag is a host constant, never caller text. */
export const PARENT_DIRECTIVE_FENCE_TAG: FenceTag = "ave-parent-directive";

export { PARENT_DIRECTIVE_MAX_CHARS } from "../shared/parent-directive-limits.js";

// Refuse per-child overflow visibly rather than rotate unread directives or grow unbounded.
export const PARENT_DIRECTIVE_MAX_PENDING = 4;

export type ParentDirectiveDropReason =
  | "unknown-recipient"
  | "cross-origin"
  | "self-send"
  // Root parents may direct only their own children; nested parent hops are forbidden.
  | "nested-parent"
  | "invalid-message"
  | "message-too-long"
  | "terminal-recipient"
  | "child-not-resumable"
  | "recipient-unavailable"
  | "pending-cap"
  | "storage-failed"
  | "mailbox-unavailable";

export type ParentDirectiveDeliveryResult =
  | {
      ok: true;
      // Queued directives reach a live round boundary; mailbox directives wait for resume.
      disposition: "queued" | "mailbox";
      childSessionId: string;
      messageId: string;
    }
  | { ok: false; reason: ParentDirectiveDropReason };

/** A work-board steer reaches only a live execute child of that item's run; nothing is stored for resume. */
export type WorkBoardSteerDropReason = Extract<
  ParentDirectiveDropReason,
  "unknown-recipient" | "invalid-message" | "message-too-long" | "recipient-unavailable" | "pending-cap"
>;

export type WorkBoardSteerDeliveryResult =
  | { ok: true; disposition: "queued"; childSessionId: string; messageId: string }
  | { ok: false; reason: WorkBoardSteerDropReason };

/** C0 controls (tab and newline excepted) never belong in a directive body. */
export function hasUnsafeDirectiveControlChars(text: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

function fenceDirective(hostInstruction: string, maskedText: string): string {
  const body = neutralizeFenceClose(maskedText, PARENT_DIRECTIVE_FENCE_TAG);
  return [
    hostInstruction,
    "",
    `<${PARENT_DIRECTIVE_FENCE_TAG}>`,
    body,
    `</${PARENT_DIRECTIVE_FENCE_TAG}>`,
  ].join("\n");
}

/** Frame already-masked, bounded text identically for live and resumed delivery. */
export function formatParentDirective(maskedText: string): string {
  return fenceDirective(t("be_parentDirective.hostInstruction"), maskedText);
}

/** Frame a work-board re-plan request: the plan the user sent back and their note, quoted together inside the same host fence. Like a
 * steer it is non-principal guidance; it changes what the plan child is asked, never what it may do. */
export function formatPlanRevisionDirective(priorPlan: string, note: string): string {
  return fenceDirective(
    t("be_parentDirective.planRevisionInstruction"),
    [t("be_parentDirective.planRevisionPriorPlanLabel"), priorPlan, "", t("be_parentDirective.planRevisionNoteLabel"), note].join("\n"),
  );
}

/** Frame a work-board user steer: the same host fence, with host wording that names the user as the sender. The envelope is non-principal
 * guidance (permission-decision-tree.md S→T, "Delegated work"): it is never the user-keyboard principal inside the child. */
export function formatUserSteerDirective(maskedText: string): string {
  return fenceDirective(t("be_parentDirective.userSteerInstruction"), maskedText);
}
