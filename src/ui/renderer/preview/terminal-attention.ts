import { useEffect, useSyncExternalStore } from "react";

/**
 * Terminal attention — a shell asking to be looked at.
 *
 * A program in a terminal says "look at me" with a desktop-notification escape
 * sequence: OSC 9 (`ESC ] 9 ; message BEL`, iTerm2's form) or OSC 777
 * (`ESC ] 777 ; notify ; title ; body BEL`, urxvt's form). The pattern follows
 * the terminal tools the owner pointed at (cmux): such a terminal gets a ring
 * on its pane and an unread badge on its tab; seeing it marks it read; and the
 * OS is told only when the window is not focused.
 *
 * The scan runs on the window's terminal data stream, not inside a view: a
 * side-panel terminal that is not the active tab has no view mounted, and its
 * shell can still finish a build and ask for attention.
 */
export interface TerminalAttention {
  tabId: string;
  message: string;
  /** Monotonic order of arrival, for "the latest unread". */
  order: number;
}

const unread = new Map<string, TerminalAttention>();
const attended = new Set<string>();
const replaying = new Set<string>();
const listeners = new Set<() => void>();
let order = 0;
let snapshot: ReadonlyMap<string, TerminalAttention> = new Map();

function emit(): void {
  snapshot = new Map(unread);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTerminalAttention(): ReadonlyMap<string, TerminalAttention> {
  return snapshot;
}

/** The unread attention of every terminal, keyed by tab id. */
export function useTerminalAttention(): ReadonlyMap<string, TerminalAttention> {
  return useSyncExternalStore(subscribe, getTerminalAttention);
}

export function markTerminalRead(tabId: string): void {
  if (!unread.delete(tabId)) return;
  emit();
}

/** The most recent unread terminal, if any. */
export function latestUnreadTerminal(): TerminalAttention | undefined {
  let latest: TerminalAttention | undefined;
  for (const each of unread.values()) if (!latest || each.order > latest.order) latest = each;
  return latest;
}

/**
 * A view says the user is looking at this terminal: it is on screen AND it is
 * the side panel's front tab or its main pane has focus (a terminal in the
 * other half of a split is visible but not attended, so it still rings). With
 * the window focused, attention arriving for an attended terminal is already
 * seen, and any it had is read.
 */
export function setTerminalAttended(tabId: string, isAttended: boolean): void {
  if (isAttended) attended.add(tabId);
  else attended.delete(tabId);
  if (isAttended && document.hasFocus()) markTerminalRead(tabId);
}

/**
 * A view is about to (re)attach: the scrollback main replays next is output
 * already seen, and must not ring again. Cleared when the attach settles.
 */
export function setTerminalReplaying(tabId: string, isReplaying: boolean): void {
  if (isReplaying) replaying.add(tabId);
  else replaying.delete(tabId);
}

// ESC ] (9|777) ; payload (BEL | ESC \)
const OSC_NOTIFY = /\x1b\](9|777);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
/** How much of an unterminated sequence is carried into the next chunk. */
const TAIL_MAX = 1024;

/** The notification messages in `text` (OSC 9 progress reports excluded). */
export function parseTerminalNotifications(text: string): string[] {
  const messages: string[] = [];
  for (const match of text.matchAll(OSC_NOTIFY)) {
    const [, code, payload = ""] = match;
    if (code === "9") {
      // `9;4;…` is ConEmu's progress report, not a notification.
      if (/^4;/.test(payload)) continue;
      messages.push(payload);
    } else {
      // 777;notify;title;body
      const [kind, title = "", body = ""] = payload.split(";");
      if (kind !== "notify") continue;
      messages.push(body ? (title ? `${title}: ${body}` : body) : title);
    }
  }
  return messages;
}

function notifyAttention(tabId: string, message: string, label: (tabId: string) => string): void {
  if (attended.has(tabId) && document.hasFocus()) return;
  order += 1;
  unread.set(tabId, { tabId, message, order });
  emit();
  // The OS is told only when the window is not where the user is looking.
  if (!document.hasFocus() && typeof Notification === "function") {
    new Notification(label(tabId), { body: message });
  }
}

interface TerminalDataSource {
  onData: (listener: (payload: { tabId: string; chunk: string }) => void) => () => void;
}

/**
 * Scan every terminal's output for notification sequences. Mounted once per
 * window. `label` names a terminal for the OS notification.
 */
export function useTerminalAttentionWatcher(terminal: TerminalDataSource | undefined, label: (tabId: string) => string): void {
  useEffect(() => {
    if (!terminal) return undefined;
    const tails = new Map<string, string>();
    const off = terminal.onData(({ tabId, chunk }) => {
      if (replaying.has(tabId)) return;
      const text = (tails.get(tabId) ?? "") + chunk;
      for (const message of parseTerminalNotifications(text)) notifyAttention(tabId, message, label);
      // Keep an unterminated sequence's start for the next chunk.
      const open = text.lastIndexOf("\x1b]");
      const tail = open >= 0 && !/\x07|\x1b\\/.test(text.slice(open)) ? text.slice(open) : "";
      if (tail && tail.length <= TAIL_MAX) tails.set(tabId, tail);
      else tails.delete(tabId);
    });
    const onFocus = () => {
      for (const tabId of attended) markTerminalRead(tabId);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [terminal, label]);
}
