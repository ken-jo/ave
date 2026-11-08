import { useCallback, useEffect, useRef, useState } from "react";
import { useModalOpen } from "../../../components/ui/modal-presence.js";
import { isNoticeSuppressed, suppressNotice } from "./status-bar/notice-suppression.js";
import type { AveApi } from "../types.js";
import { LONG_TOAST_TTL_MS } from "../constants.js";
import type { PersistentItem, ToastItem } from "./status-bar/types.js";
import { useStatusBarNotifications } from "./status-bar/use-status-bar-notifications.js";
import { useStatusBarInstall } from "./status-bar/use-status-bar-install.js";

// Re-export shared types so existing call sites (App.tsx, StatusBar.tsx, tests) continue to import from this module
// without changes.
export type { StatusBarSeverity, NotificationToastMeta, PersistentItem, ToastItem } from "./status-bar/types.js";

/**
 * Compare two persistent items by their display-relevant fields only. The
 * `onClick` handler is intentionally excluded: producers may build a fresh
 * closure on every run, but a changed handler identity must not be treated as
 * a state change (that would defeat the loop guard in `upsertPersistent`).
 */
function samePersistentDisplay(a: PersistentItem, b: PersistentItem): boolean {
  return (
    a.id === b.id &&
    a.severity === b.severity &&
    a.label === b.label &&
    a.value === b.value &&
    a.dot === b.dot &&
    a.a11yLabel === b.a11yLabel &&
    a.tooltip === b.tooltip
  );
}

interface UseStatusBarOptions {
  api: AveApi;
  /** Default toast TTL in milliseconds. Override per-toast at push time. Defaults to LONG_TOAST_TTL_MS (5 s) — long enough to
   * read a single Korean sentence, short enough to feel ephemeral. */
  defaultToastTtlMs?: number;
}

/**
 * Hard cap on the toast queue. Prevents an event burst (e.g. 100 install
 * events in one tick) from growing state unbounded between eviction sweeps.
 * The on-screen render only shows the latest 3; capping at 50 leaves
 * generous headroom while bounding memory + re-render cost.
 */
const TOAST_QUEUE_CAP = 50;
const TOAST_MARQUEE_CHAR_THRESHOLD = 48;
const TOAST_MARQUEE_BASE_TTL_MS = 4000;
const TOAST_MARQUEE_MS_PER_CHAR = 280;
const TOAST_MARQUEE_MAX_TTL_MS = 45_000;

type ToastInput = {
  severity: ToastItem["severity"];
  message: string;
  ttlMs?: number;
  sticky?: boolean;
  notification?: ToastItem["notification"];
  action?: ToastItem["action"];
  kind?: string;
  suppressible?: true;
};

function createToastItem(id: string, input: ToastInput, defaultToastTtlMs: number): ToastItem {
  if (input.suppressible === true && (input.kind === undefined || input.severity === "error")) {
    throw new Error(`[notices] a suppressible notice needs a kind and cannot be an error: ${input.message}`);
  }
  const ttlMs = resolveToastTtlMs(input.message, input.ttlMs ?? defaultToastTtlMs);
  // An error stays until it is dismissed: a person who looked away must still find it. Brief confirmations keep their TTL.
  const sticky = input.sticky === true || input.severity === "error";
  return {
    id,
    severity: input.severity,
    message: input.message,
    ttlMs,
    expiresAt: Date.now() + ttlMs,
    ...(sticky ? { sticky: true as const } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.suppressible === true ? { suppressible: true as const } : {}),
    notification: input.notification,
    ...(input.action ? { action: input.action } : {}),
  };
}

function appendToast(queue: ToastItem[], item: ToastItem): ToastItem[] {
  if (queue.length >= TOAST_QUEUE_CAP) {
    return [...queue.slice(queue.length - TOAST_QUEUE_CAP + 1), item];
  }
  return [...queue, item];
}

function resolveToastTtlMs(message: string, requestedTtlMs: number): number {
  const charCount = Array.from(message).length;
  if (charCount <= TOAST_MARQUEE_CHAR_THRESHOLD) return requestedTtlMs;
  const scrollTtlMs = TOAST_MARQUEE_BASE_TTL_MS + charCount * TOAST_MARQUEE_MS_PER_CHAR;
  return Math.max(requestedTtlMs, Math.min(TOAST_MARQUEE_MAX_TTL_MS, scrollTtlMs));
}

/** Use one notice queue per owning surface so conversation toasts cannot repeat in every tile; attach window producers only
 * to the window queue. */
export function useStatusNotices(opts: { defaultToastTtlMs?: number } = {}) {
  // LONG_TOAST_TTL_MS (5 s) gives comfortable reading time for a Korean phrase; callers that need a shorter or longer window
  // pass defaultToastTtlMs.
  const { defaultToastTtlMs = LONG_TOAST_TTL_MS } = opts;
  const [persistent, setPersistent] = useState<PersistentItem[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Stable counter for unique toast IDs without leaning on Date.now() (which collides under quick successive pushes).
  const toastCounterRef = useRef(0);

  const pushToast = useCallback(
    (input: ToastInput) => {
      const id = `toast:${++toastCounterRef.current}`;
      const item = createToastItem(id, input, defaultToastTtlMs);
      if (item.suppressible && item.kind !== undefined && isNoticeSuppressed(item.kind)) return id;
      setToasts((prev) => {
        return appendToast(prev, item);
      });
      return id;
    },
    [defaultToastTtlMs],
  );

  /** Replace an existing toast in its current queue position, or append it when absent. A producer that reports the same
   * subject again (an install result, a provider swap, a re-applied approval) uses a stable ID so the newer report replaces
   * the older one instead of queueing behind it. */
  const upsertToast = useCallback(
    (id: string, input: ToastInput) => {
      const item = createToastItem(id, input, defaultToastTtlMs);
      if (item.suppressible && item.kind !== undefined && isNoticeSuppressed(item.kind)) return id;
      setToasts((prev) => {
        const index = prev.findIndex((toast) => toast.id === id);
        if (index === -1) return appendToast(prev, item);
        const next = [...prev];
        next[index] = item;
        return next;
      });
      return id;
    },
    [defaultToastTtlMs],
  );

  /** Drop matching toasts. A new head gets a fresh TTL, so it is not skipped for having waited in line. */
  const removeToastsWhere = useCallback(
    (drop: (toast: ToastItem) => boolean) => {
      setToasts((prev) => {
        const next = prev.filter((t) => !drop(t));
        if (next.length === prev.length) return prev;
        const head = next[0];
        if (head && head.id !== prev[0]?.id) next[0] = { ...head, expiresAt: Date.now() + (head.ttlMs ?? defaultToastTtlMs) };
        return next;
      });
    },
    [defaultToastTtlMs],
  );

  const removeToast = useCallback((id: string) => removeToastsWhere((t) => t.id === id), [removeToastsWhere]);

  /** Drop the toasts of settled approvals. */
  const removeApprovalToasts = useCallback(
    (approvalIds: ReadonlySet<string>) => removeToastsWhere((t) => approvalIds.has(t.notification?.contextRef?.approvalId ?? "")),
    [removeToastsWhere],
  );

  /** "Don't show again": silence this kind from now on and drop every queued notice of it. */
  const suppressToastKind = useCallback(
    (kind: string) => {
      suppressNotice(kind);
      removeToastsWhere((t) => t.kind === kind);
    },
    [removeToastsWhere],
  );

  // While a modal dialog is open the queue is held: nothing shows, nothing expires, and nothing is dropped. The modal owns
  // the person's attention and focus; a notice drawn behind its backdrop would expire unread. The moment it closes the head
  // shows with its full time, measured from the release. Tracked during render (not in an effect) so the first frame
  // after the close already carries the release time and cannot schedule an already-elapsed timer.
  const modalOpen = useModalOpen();
  const [heldByModal, setHeldByModal] = useState(modalOpen);
  const [releasedAt, setReleasedAt] = useState(0);
  if (heldByModal !== modalOpen) {
    setHeldByModal(modalOpen);
    if (!modalOpen) setReleasedAt(Date.now());
  }

  // Only the queue head (toasts[0]) is exposed as `visibleToast`, so at most one notice is visible per queue. When the
  // head's TTL elapses (or removeToast dismisses it early), the next item in the queue becomes the new head and gets its
  // own timer, so a burst of events never renders several notices at once.
  const visibleToast = modalOpen ? null : (toasts[0] ?? null);
  useEffect(() => {
    if (visibleToast === null || visibleToast.sticky) return;
    const shownUntil = Math.max(visibleToast.expiresAt, releasedAt + (visibleToast.ttlMs ?? defaultToastTtlMs));
    const delay = Math.max(0, shownUntil - Date.now());
    const id = setTimeout(() => {
      setToasts((prev) => {
        if (prev[0]?.id !== visibleToast.id) return prev;
        const [, nextHead, ...rest] = prev;
        if (!nextHead) return [];
        const ttlMs = nextHead.ttlMs ?? defaultToastTtlMs;
        return [{ ...nextHead, expiresAt: Date.now() + ttlMs }, ...rest];
      });
    }, delay);
    return () => clearTimeout(id);
  }, [defaultToastTtlMs, releasedAt, visibleToast]);

  const upsertPersistent = useCallback((item: PersistentItem) => {
    setPersistent((prev) => {
      const idx = prev.findIndex((p) => p.id === item.id);
      if (idx === -1) return [...prev, item];
      // Return the same array for identical display fields, ignoring callback identity, to prevent upsert/render loops.
      if (samePersistentDisplay(prev[idx], item)) return prev;
      const next = [...prev];
      next[idx] = item;
      return next;
    });
  }, []);

  const removePersistent = useCallback((id: string) => {
    setPersistent((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return {
    persistent,
    toasts,
    /** The single toast currently visible in the status bar (queue head). */
    visibleToast,
    /** Number of queued toasts waiting behind the visible one. */
    pendingCount: visibleToast === null ? 0 : Math.max(0, toasts.length - 1),
    pushToast,
    upsertToast,
    removeToast,
    removeApprovalToasts,
    suppressToastKind,
    upsertPersistent,
    removePersistent,
  };
}

/** A notice drawn inline beside the controls it reports on (a settings tab's last action). The newest report replaces the
 * previous one, and it obeys the same rules as every other notice because it is the same queue. */
export function useInlineNotice() {
  const { upsertToast, removeToast, visibleToast } = useStatusNotices();
  const show = useCallback(
    (severity: ToastItem["severity"], message: string) => {
      upsertToast("inline-notice", { severity, message });
    },
    [upsertToast],
  );
  const dismiss = useCallback((toast: ToastItem) => removeToast(toast.id), [removeToast]);
  return { show, notice: visibleToast, dismiss };
}

/** The WINDOW's notice queue: `useStatusNotices` with the producers that report on the window attached. Subscribed once,
 * drawn once, in the window's notice strip — never inside a tile, where a second tile would draw it again. */
export function useStatusBar(opts: UseStatusBarOptions) {
  const { api, defaultToastTtlMs } = opts;
  const notices = useStatusNotices({ defaultToastTtlMs });

  // Window producers own notification/install toasts; persistent operational items belong to each tile's queue.
  useStatusBarNotifications({ api, pushToast: notices.pushToast });
  useStatusBarInstall({ api, pushToast: notices.pushToast, upsertToast: notices.upsertToast });

  return notices;
}
