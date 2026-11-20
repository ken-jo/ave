/**
 * What a page did while the agent was driving it that a tool result must say: dialogs that were ended unanswered, and
 * downloads the page started. Page dialogs (alert, confirm) are ended unanswered because the agent was driving the page. An agent turn
 * must not wait on a page's modal dialog, so the dialog is dismissed and its type and text are reported with the next
 * tool result for that page. The text is the page's: it reaches the model only inside the untrusted-content envelope.
 */
import { browserDialogText, type BrowserPageDialogType } from "../../shared/browser-workspace.js";

export interface DismissedPageDialog { readonly type: BrowserPageDialogType; readonly message: string }
/** A download a page started while the agent drove it. `blocked` means the host refused it before it began. */
export interface AgentPageDownload { name: string; state: "started" | "completed" | "cancelled" | "interrupted" | "blocked" }

const REPORT_LIMIT = 5;
const MESSAGE_LIMIT = 500;

class DismissedPageDialogs {
  private readonly byGuest = new Map<number, { dialogs: DismissedPageDialog[]; dropped: number }>();
  private readonly downloads = new Map<number, AgentPageDownload[]>();
  private readonly settledListeners = new Map<number, Set<() => void>>();
  private readonly notedListeners = new Map<number, Set<(urlChain: readonly string[]) => void>>();

  /** Records a download and the URLs it was fetched through; the returned function updates its state until the next report takes it. */
  noteDownload(guestId: number, name: string, state: AgentPageDownload["state"], urlChain: readonly string[]): (next: AgentPageDownload["state"]) => void {
    const entry: AgentPageDownload = { name: browserDialogText(name).slice(0, 300), state };
    const list = this.downloads.get(guestId) ?? [];
    this.downloads.set(guestId, list);
    if (list.length < REPORT_LIMIT) list.push(entry);
    for (const listener of [...(this.notedListeners.get(guestId) ?? [])]) listener(urlChain);
    if (state !== "started") this.settled(guestId);
    return (next) => { entry.state = next; if (next !== "started") this.settled(guestId); };
  }
  /**
   * Calls `settled` once a download of this page that no result has reported yet has ended (saved, cancelled, failed or
   * refused): now, when one already has. Returns a cancel.
   */
  onceDownloadSettled(guestId: number, settled: () => void): () => void {
    if ((this.downloads.get(guestId) ?? []).some((entry) => entry.state !== "started")) { settled(); return () => {}; }
    const listeners = this.settledListeners.get(guestId) ?? new Set<() => void>();
    this.settledListeners.set(guestId, listeners);
    listeners.add(settled);
    return () => { listeners.delete(settled); if (listeners.size === 0 && this.settledListeners.get(guestId) === listeners) this.settledListeners.delete(guestId); };
  }
  /** Calls `noted` with its URL chain each time a download of this page is recorded, until the returned function is called. */
  onDownloadNoted(guestId: number, noted: (urlChain: readonly string[]) => void): () => void {
    const listeners = this.notedListeners.get(guestId) ?? new Set<(urlChain: readonly string[]) => void>();
    this.notedListeners.set(guestId, listeners);
    listeners.add(noted);
    return () => { listeners.delete(noted); if (listeners.size === 0 && this.notedListeners.get(guestId) === listeners) this.notedListeners.delete(guestId); };
  }
  private settled(guestId: number): void {
    const listeners = this.settledListeners.get(guestId);
    this.settledListeners.delete(guestId);
    for (const listener of listeners ?? []) listener();
  }
  takeDownloads(guestId: number): readonly AgentPageDownload[] {
    const list = this.downloads.get(guestId) ?? [];
    this.downloads.delete(guestId);
    return list.map((entry) => ({ ...entry }));
  }

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
  forget(guestId: number): void { this.byGuest.delete(guestId); this.downloads.delete(guestId); this.notedListeners.delete(guestId); this.settled(guestId); }
}

export const dismissedPageDialogs = new DismissedPageDialogs();

/**
 * A tool result header for a page, extended with what that page did for the agent since the last result: the dialogs
 * that were dismissed, and the downloads it started, each with its file name and state.
 */
export function withDismissedDialogs<T extends object>(guestId: number | undefined, header: T): T & { dismissedDialogs?: readonly DismissedPageDialog[]; dismissedDialogsOmitted?: number; downloads?: readonly AgentPageDownload[] } {
  if (guestId === undefined) return header;
  const taken = dismissedPageDialogs.take(guestId);
  const downloads = dismissedPageDialogs.takeDownloads(guestId);
  return {
    ...header,
    ...(taken ? { dismissedDialogs: taken.dialogs, ...(taken.dropped > 0 ? { dismissedDialogsOmitted: taken.dropped } : {}) } : {}),
    ...(downloads.length > 0 ? { downloads } : {}),
  };
}
