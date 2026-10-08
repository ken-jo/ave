/**
 * Host "due soon" scanner for the Work Board.
 *
 * A subscribed `work-item-due-soon` detector consumes the plugin-bus event
 * `work_board.work_item.due_soon` { itemId, title, notifiedAt } to nudge the
 * user before a deadline. The board is now host-owned (architecture.md
 * §10.0.3), so the HOST emits this event under its own namespace: a scheduler
 * tick scans the board for not-yet-completed items whose `due_at` falls inside
 * the next 24h and fires one slim pointer event per item.
 *
 * The event was re-namespaced from the legacy plugin name during host
 * integration so host source carries no plugin-owned identifiers (the
 * decoupling audit); consumers subscribe to the host name in lock-step.
 *
 * Dedupe is keyed by `${id}:${due_at}` and persisted to
 * `due-soon-notified.json` under the work-board namespace, so an item fires at
 * most once for its current deadline, survives restarts, and re-fires only when
 * its `due_at` actually changes. Stale keys (item completed, deleted, or pushed
 * out of the window) are pruned every scan by rebuilding the map.
 *
 * No fallback: a missing notified file reads back as `null` (the storage
 * contract's "absent" signal), seeded as an empty map.
 */
import type { WorkBoardStorage } from "./storage.js";
import type { AlertInput, AlertResult } from "../plugins/public-contract.js";
import { DUE_SOON_ALERT_KIND, DUE_SOON_TITLE_MAX_LENGTH } from "../alerts/host-kinds.js";
import type {
  WorkItemListResult,
  WorkItemDueSoonEventPayload,
} from "../shared/work-board-types.js";

/** Pre-due lookahead window: an item is "due soon" within the next 24h. */
export const DUE_SOON_WINDOW_MS = 24 * 60 * 60_000;

/** Relative path (under the work-board namespace) of the dedupe map. */
export const DUE_SOON_NOTIFIED_FILE = "due-soon-notified.json";

/** Host event type consumed by a subscribed work-item-due-soon detector. */
export const DUE_SOON_EVENT = "work_board.work_item.due_soon";

/** Persisted dedupe map: `${id}:${due_at}` → ISO instant first notified. */
type DueSoonNotified = Record<string, string>;

/** Host event emitter — synchronous fire-and-forget, matching `emitEvent`. */
type EmitFn = (type: string, data?: unknown) => void;

/** Narrow board reader the scan needs (satisfied by WorkBoardStore). */
export interface DueSoonBoardReader {
  list(): Promise<WorkItemListResult>;
}

function notifiedKey(id: number, dueAt: string): string {
  return `${id}:${dueAt}`;
}

/**
 * Scan unfinished items due in `[now, now + 24h)`. Emit the bus event once
 * while each `(id, due_at)` remains in that window, and retry alert delivery
 * on every scan. Bus state is saved before delivery, so an alert refusal or
 * delivery exception cannot suppress subscribers' events. Returns bus payloads.
 */
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
    // Half-open window [now, now+24h): a future deadline within 24h.
    // Past-due (overdue) items are NOT a "due soon" nudge.
    if (Number.isNaN(due) || due < nowMs || due >= nowMs + DUE_SOON_WINDOW_MS) continue;

    const key = notifiedKey(item.id, item.due_at);
    // Delivery has its own identity table. Retrying lets a newly enabled kind
    // fire, a rate-limited item try later, and an open card reappear at boot.
    // The bus's once-per-deadline contract remains independent of delivery.
    alerts.push({
      kind: DUE_SOON_ALERT_KIND,
      key,
      slots: {
        title: [...item.title].slice(0, DUE_SOON_TITLE_MAX_LENGTH).join(""),
        itemId: String(item.id),
      },
      ttlMs: due - nowMs,
    });
    // Retain still-due-soon keys; rebuilding `next` from scratch prunes any
    // key whose item left the window (completed/deleted/rescheduled).
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

  // Persist only when the dedupe map actually changed (new fire or pruned key).
  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    await storage.writeJson(DUE_SOON_NOTIFIED_FILE, next);
  }
  // A refused alert is retried on the next scan. A thrown delivery error
  // reaches the scheduler's error handler; the bus pass above is complete.
  for (const input of alerts) await raise(input);
  return emitted;
}
