/**
 * Page dialogs (alert, confirm) that were ended unanswered because the agent was driving the page. An agent turn
 * must not wait on a page's modal dialog, so the dialog is dismissed and its type and text are reported with the next
 * tool result for that page. The text is the page's: it reaches the model only inside the untrusted-content envelope.
 */
import { browserDialogText, type BrowserPageDialogType } from "../../shared/browser-workspace.js";

export interface DismissedPageDialog { readonly type: BrowserPageDialogType; readonly message: string }

const REPORT_LIMIT = 5;
const MESSAGE_LIMIT = 500;

class DismissedPageDialogs {
  private readonly byGuest = new Map<number, { dialogs: DismissedPageDialog[]; dropped: number }>();

  note(guestId: number, type: BrowserPageDialogType, message: string): void {
    const entry = this.byGuest.get(guestId) ?? { dialogs: [], dropped: 0 };
    this.byGuest.set(guestId, entry);
    if (entry.dialogs.length < REPORT_LIMIT) entry.dialogs.push({ type, message: browserDialogText(message).slice(0, MESSAGE_LIMIT) });
    else entry.dropped++;
  }
  /** The dialogs dismissed since the last report for this page, oldest first, and how many more were not kept. */
  take(guestId: number): { readonly dialogs: readonly DismissedPageDialog[]; readonly dropped: number } | null {
    const entry = this.byGuest.get(guestId);
    this.byGuest.delete(guestId);
    return entry ?? null;
  }
  forget(guestId: number): void { this.byGuest.delete(guestId); }
}

export const dismissedPageDialogs = new DismissedPageDialogs();

/** A tool result header for a page, extended with the dialogs that page showed and that were dismissed for the agent. */
export function withDismissedDialogs<T extends object>(guestId: number | undefined, header: T): T & { dismissedDialogs?: readonly DismissedPageDialog[]; dismissedDialogsOmitted?: number } {
  const taken = guestId === undefined ? null : dismissedPageDialogs.take(guestId);
  if (!taken) return header;
  return { ...header, dismissedDialogs: taken.dialogs, ...(taken.dropped > 0 ? { dismissedDialogsOmitted: taken.dropped } : {}) };
}
