/** Raise each eligible deadline through the host alert service, which owns delivery identity and retries.
 * Resolves true when the kind cooldown deferred an item, so the caller can re-scan before the next tick. */
import type { AlertInput, AlertResult } from "../plugins/public-contract.js";
import { DUE_SOON_ALERT_KIND, DUE_SOON_TITLE_MAX_LENGTH } from "../alerts/host-kinds.js";
import { ALERT_KIND_COOLDOWN_MS } from "../alerts/gate.js";
import type { WorkItemListResult } from "../shared/work-board-types.js";

export const DUE_SOON_WINDOW_MS = 24 * 60 * 60_000;
export const DUE_SOON_TICK_MS = 60 * 60_000;

export interface DueSoonBoardReader {
  list(): Promise<WorkItemListResult>;
}

export async function scanAndRaiseDueSoon(
  store: DueSoonBoardReader,
  nowMs: number,
  raise: (input: AlertInput) => Promise<AlertResult>,
): Promise<boolean> {
  const listed = await store.list();
  if (listed.status !== "ok") return false;
  let deferred = false;

  for (const item of listed.items) {
    if (item.status === "completed" || !item.due_at) continue;
    const due = Date.parse(item.due_at);
    if (Number.isNaN(due) || due < nowMs || due >= nowMs + DUE_SOON_WINDOW_MS) continue;

    const result = await raise({
      kind: DUE_SOON_ALERT_KIND,
      key: `${item.id}:${item.due_at}`,
      slots: {
        title: [...item.title].slice(0, DUE_SOON_TITLE_MAX_LENGTH).join(""),
        itemId: String(item.id),
      },
      ttlMs: due - nowMs,
    });
    if (result.status === "cooldown") deferred = true;
  }
  return deferred;
}

/** Scan now and every tick. The kind cooldown raises one item per window, so a deferred scan
 * re-runs once the cooldown ends; at most one re-scan is pending, and stop clears both timers. */
export function startDueSoonScans(scan: () => Promise<boolean>, onError: (err: unknown) => void): () => void {
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = (): void => {
    void scan().then((deferred) => {
      if (!deferred || stopped || retry) return;
      retry = setTimeout(() => {
        retry = undefined;
        run();
      }, ALERT_KIND_COOLDOWN_MS);
    }, onError);
  };
  run();
  const tick = setInterval(run, DUE_SOON_TICK_MS);
  return () => {
    stopped = true;
    clearInterval(tick);
    clearTimeout(retry);
  };
}
