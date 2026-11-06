/** Raise each eligible deadline through the host alert service, which owns delivery identity and retries. */
import type { AlertInput, AlertResult } from "../plugins/public-contract.js";
import { DUE_SOON_ALERT_KIND, DUE_SOON_TITLE_MAX_LENGTH } from "../alerts/host-kinds.js";
import type { WorkItemListResult } from "../shared/work-board-types.js";

export const DUE_SOON_WINDOW_MS = 24 * 60 * 60_000;

export interface DueSoonBoardReader {
  list(): Promise<WorkItemListResult>;
}

export async function scanAndRaiseDueSoon(
  store: DueSoonBoardReader,
  nowMs: number,
  raise: (input: AlertInput) => Promise<AlertResult>,
): Promise<void> {
  const listed = await store.list();
  if (listed.status !== "ok") return;

  for (const item of listed.items) {
    if (item.status === "completed" || !item.due_at) continue;
    const due = Date.parse(item.due_at);
    if (Number.isNaN(due) || due < nowMs || due >= nowMs + DUE_SOON_WINDOW_MS) continue;

    await raise({
      kind: DUE_SOON_ALERT_KIND,
      key: `${item.id}:${item.due_at}`,
      slots: {
        title: [...item.title].slice(0, DUE_SOON_TITLE_MAX_LENGTH).join(""),
        itemId: String(item.id),
      },
      ttlMs: due - nowMs,
    });
  }
}
