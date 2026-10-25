// Running and resumed children share one directive grammar.
// Keep host labels outside fences and neutralize parent-authored closing tags.
import { t } from "../i18n/index.js";
import { neutralizeFenceClose, type FenceTag } from "../shared/fence-sanitizer.js";

/** Registered in `fence-sanitizer.ts`; the tag is a host constant, never caller text. */
export const PARENT_DIRECTIVE_FENCE_TAG: FenceTag = "ave-parent-directive";

// Bound the body below half the guidance limit to leave room for localized host framing.
export const PARENT_DIRECTIVE_MAX_CHARS = 4_000;

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

/** C0 controls (tab and newline excepted) never belong in a directive body. */
export function hasUnsafeDirectiveControlChars(text: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

/** Frame already-masked, bounded text identically for live and resumed delivery. */
export function formatParentDirective(maskedText: string): string {
  const body = neutralizeFenceClose(maskedText, PARENT_DIRECTIVE_FENCE_TAG);
  return [
    t("be_parentDirective.hostInstruction"),
    "",
    `<${PARENT_DIRECTIVE_FENCE_TAG}>`,
    body,
    `</${PARENT_DIRECTIVE_FENCE_TAG}>`,
  ].join("\n");
}
