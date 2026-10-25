/** Persist dedupe by item plus deadline across restarts; prune keys when items leave the due-soon window. */
import type { WorkBoardStorage } from "./storage.js";
import type { AlertInput, AlertResult } from "../plugins/public-contract.js";
import { DUE_SOON_ALERT_KIND, DUE_SOON_TITLE_MAX_LENGTH } from "../alerts/host-kinds.js";
import type {
  WorkItemListResult,
  WorkItemDueSoonEventPayload,
} from "../shared/work-board-types.js";

export const DUE_SOON_WINDOW_MS = 24 * 60 * 60_000;

export const DUE_SOON_NOTIFIED_FILE = "due-soon-notified.json";

export const DUE_SOON_EVENT = "work_board.work_item.due_soon";

type DueSoonNotified = Record<string, string>;

type EmitFn = (type: string, data?: unknown) => void;

export interface DueSoonBoardReader {
  list(): Promise<WorkItemListResult>;
}

function notifiedKey(id: number, dueAt: string): string {
  return `${id}:${dueAt}`;
}

/** Persist once-per-deadline bus state before alert delivery; refusal or exceptions must not suppress bus subscribers. */
export async function scanAndEmitDueSoon(
  store: DueSoonBoardReader,
  storage: WorkBoardStorage,
  emit: EmitFn,
  nowMs: number,
  raise: (input: AlertInput) => Promise<AlertResult>,
): Promise<WorkItemDueSoonEventPayload[]> {
  const listed = await store.list();
  if (listed.status !== "ok") return [];

  const prev = (await storage.readJson<DueSoonNotified>(DUE_SOON_NOTIFIED_FILE)) ?? {};
  const next: DueSoonNotified = {};
  const emitted: WorkItemDueSoonEventPayload[] = [];
  const alerts: AlertInput[] = [];
  const nowIso = new Date(nowMs).toISOString();

  for (const item of listed.items) {
    if (item.status === "completed" || !item.due_at) continue;
    const due = Date.parse(item.due_at);
    if (Number.isNaN(due) || due < nowMs || due >= nowMs + DUE_SOON_WINDOW_MS) continue;

    const key = notifiedKey(item.id, item.due_at);
    // Retry delivery independently so newly enabled, rate-limited, or restart-lost cards can appear without repeating bus events.
    alerts.push({
      kind: DUE_SOON_ALERT_KIND,
      key,
      slots: {
        title: [...item.title].slice(0, DUE_SOON_TITLE_MAX_LENGTH).join(""),
        itemId: String(item.id),
      },
      ttlMs: due - nowMs,
    });
    next[key] = prev[key] ?? nowIso;
    if (prev[key] !== undefined) continue; // already notified for this deadline

    const payload: WorkItemDueSoonEventPayload = {
      itemId: item.id,
      title: item.title,
      notifiedAt: nowIso,
    };
    emit(DUE_SOON_EVENT, payload);
    emitted.push(payload);
  }

  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    await storage.writeJson(DUE_SOON_NOTIFIED_FILE, next);
  }
  // Retry refused alerts next scan; delivery exceptions reach the scheduler only after bus publication completes.
  for (const input of alerts) await raise(input);
  return emitted;
}
