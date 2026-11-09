import { NOTIFICATION_HISTORY_LIMIT } from "../../shared/notification-types.js";
import type { ToastItem } from "./hooks/status-bar/types.js";

type NoticeSource = "window" | "banner" | NonNullable<ToastItem["notification"]>["kind"];
export interface NoticeAction {
  key?: string;
  label: string;
  run: () => void;
  disabled?: boolean;
}
export interface NoticeInput {
  createdAt?: number;
  severity: ToastItem["severity"];
  message: string;
  notification?: ToastItem["notification"];
  action?: NoticeAction;
  actions?: NoticeAction[];
  source?: NoticeSource;
}
export interface NoticeRecord extends ToastItem {
  action?: NoticeAction;
  createdAt: number;
  read: boolean;
  source: NoticeSource;
  actions?: NoticeAction[];
}

/** Window lifetime only: clearing a record never changes its producer's state. */
export function createNotificationHistory() {
  let records: NoticeRecord[] = [];
  let latest: NoticeRecord | null = null;
  let latestPolite: NoticeRecord | null = null;
  let latestError: NoticeRecord | null = null;
  let pendingAnnouncements: NoticeRecord[] = [];
  // Local rows can evict a main row from the visible cap; that must not make its replay a new arrival.
  const receivedIds = new Set<string>();
  let open = false;
  let sequence = 0;
  let arrival = 0;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const upsert = (id: string, input: NoticeInput): string => {
    if (input.notification?.kind === "approval" || input.notification?.kind === "ask-user") return id;
    const createdAt = input.createdAt ?? Date.now();
    const record: NoticeRecord = {
      ...input, id, announcementId: ++arrival, createdAt, expiresAt: createdAt, read: open,
      source: input.source ?? input.notification?.kind ?? "window",
    };
    records = [record, ...records.filter((item) => item.id !== id)].slice(0, NOTIFICATION_HISTORY_LIMIT);
    latest = record;
    pendingAnnouncements.push(record);
    const errors = record.severity === "error";
    const announcement = {
      ...record,
      message: pendingAnnouncements.filter((item) => (item.severity === "error") === errors).map((item) => item.message).join("\n"),
    };
    if (errors) latestError = announcement;
    else latestPolite = announcement;
    emit();
    return id;
  };
  return {
    getSnapshot: () => records,
    getLatest: () => latest,
    getLatestPolite: () => latestPolite,
    getLatestError: () => latestError,
    // Only committed text is acknowledged; later arrivals must remain in the next announcement batch.
    acknowledgeAnnouncements: (through: number) => {
      pendingAnnouncements = pendingAnnouncements.filter((item) => (item.announcementId ?? 0) > through);
    },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push: (input: NoticeInput) => upsert(`notice:${++sequence}`, input),
    upsert,
    receive: (id: string, input: NoticeInput) => {
      if (receivedIds.has(id)) return id;
      receivedIds.add(id);
      if (receivedIds.size > NOTIFICATION_HISTORY_LIMIT) {
        const oldest = receivedIds.values().next().value;
        if (oldest !== undefined) receivedIds.delete(oldest);
      }
      return upsert(id, input);
    },
    updateActions: (id: string, actions: NoticeAction[]) => {
      const current = records.find((item) => item.id === id);
      if (!current) return;
      if ((current.actions?.length ?? 0) === actions.length && actions.every((action, index) => action.key === current.actions?.[index]?.key && action.label === current.actions?.[index]?.label && action.disabled === current.actions?.[index]?.disabled)) return;
      records = records.map((item) => item.id === id ? { ...item, actions } : item);
      emit();
    },
    markRead: () => {
      if (!records.some((item) => !item.read)) return;
      records = records.map((item) => ({ ...item, read: true }));
      emit();
    },
    setOpen: (value: boolean) => {
      open = value;
      if (!open || !records.some((item) => !item.read)) return;
      records = records.map((item) => ({ ...item, read: true }));
      emit();
    },
    clear: (id: string) => {
      records = records.filter((item) => item.id !== id);
      emit();
    },
    clearAll: () => { records = []; emit(); },
  };
}
export type NotificationHistory = ReturnType<typeof createNotificationHistory>;

export function notificationCounts(records: readonly NoticeRecord[], approvals: number) {
  const unread = records.filter((item) => !item.read);
  return { unread: unread.length, total: approvals + unread.length, error: unread.some((item) => item.severity === "error") };
}
