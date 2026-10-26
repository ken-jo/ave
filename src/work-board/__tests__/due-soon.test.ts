/** Use a half-open 24-hour window and deduplicate by item plus deadline; changed deadlines may fire again. */
import { describe, it, expect, vi } from "vitest";
import {
  scanAndEmitDueSoon,
  DUE_SOON_EVENT,
  DUE_SOON_NOTIFIED_FILE,
  DUE_SOON_WINDOW_MS,
  type DueSoonBoardReader,
} from "../due-soon.js";
import type { WorkBoardStorage } from "../storage.js";
import type {
  WorkItem,
  WorkItemResolved,
} from "../../shared/work-board-types.js";
import { okListReader } from "./board-test-fixtures.js";

const raiseAlert = async () => ({ status: "disabled_by_user" as const });

const NOW = Date.parse("2026-06-16T00:00:00.000Z");

function item(partial: Partial<WorkItem> & { id: number }): WorkItemResolved {
  const base: WorkItem = {
    title: `item ${partial.id}`,
    status: "planned",
    priority: "medium",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
  return { ...base, status_resolved: base.status };
}

function memStorage(seed?: Record<string, unknown>): WorkBoardStorage {
  const files: Record<string, unknown> = { ...seed };
  return {
    readJson: async <T>(rel: string): Promise<T | null> =>
      (files[rel] as T) ?? null,
    writeJson: async (rel: string, data: unknown): Promise<void> => {
      files[rel] = data;
    },
  } as unknown as WorkBoardStorage;
}

function recorder() {
  const calls: Array<{ type: string; data: unknown }> = [];
  return { emit: (type: string, data?: unknown) => calls.push({ type, data }), calls };
}

describe("scanAndEmitDueSoon", () => {
  it("finishes and persists the bus pass even if alert delivery throws", async () => {
    const dueAt = new Date(NOW + 60_000).toISOString();
    const store = okListReader([item({ id: 1, due_at: dueAt }), item({ id: 2, due_at: dueAt })]);
    const storage = memStorage();
    const { emit, calls } = recorder();
    await expect(scanAndEmitDueSoon(store, storage, emit, NOW, async () => { throw new Error("delivery failed"); }))
      .rejects.toThrow("delivery failed");
    expect(calls).toHaveLength(2);
    await scanAndEmitDueSoon(store, storage, emit, NOW, raiseAlert);
    expect(calls).toHaveLength(2);
  });
  it("raises a deadline identity on every scan while emitting the bus event only once", async () => {
    const dueAt = new Date(NOW + 60 * 60_000).toISOString();
    const store = okListReader([item({ id: 7, title: "Report", due_at: dueAt })]);
    const storage = memStorage();
    const { emit, calls } = recorder();
    const raise = vi.fn(raiseAlert);
    await scanAndEmitDueSoon(store, storage, emit, NOW, raise);
    await scanAndEmitDueSoon(store, storage, emit, NOW + 5 * 60_000, raise);
    expect(calls).toHaveLength(1);
    expect(raise).toHaveBeenCalledTimes(2);
    expect(raise).toHaveBeenNthCalledWith(1, {
      kind: "due-soon", key: `7:${dueAt}`, slots: { title: "Report", itemId: "7" }, ttlMs: 60 * 60_000,
    });
    expect(raise).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: `7:${dueAt}` }));
  });

  it("bounds a title by code points before entering the slot validator", async () => {
    const raise = vi.fn(raiseAlert);
    await scanAndEmitDueSoon(okListReader([item({
      id: 7, title: "😀".repeat(250), due_at: new Date(NOW + 60_000).toISOString(),
    })]), memStorage(), recorder().emit, NOW, raise);
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ slots: { title: "😀".repeat(200), itemId: "7" } }));
  });
  it("emits for an item due inside the next 24h", async () => {
    const dueIn1h = new Date(NOW + 60 * 60_000).toISOString();
    const store = okListReader([item({ id: 1, due_at: dueIn1h })]);
    const { emit, calls } = recorder();

    const emitted = await scanAndEmitDueSoon(store, memStorage(), emit, NOW, raiseAlert);

    expect(emitted).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: DUE_SOON_EVENT,
      data: { itemId: 1, title: "item 1", notifiedAt: new Date(NOW).toISOString() },
    });
  });

  it("does NOT emit for items outside the window or completed/undated", async () => {
    const store = okListReader([
      item({ id: 1 }), // no due_at
      item({ id: 2, due_at: new Date(NOW - 60_000).toISOString() }), // past due (overdue, not soon)
      item({ id: 3, due_at: new Date(NOW + DUE_SOON_WINDOW_MS).toISOString() }), // exactly +24h (half-open → excluded)
      item({ id: 4, due_at: new Date(NOW + 60_000).toISOString(), status: "completed" }), // completed
    ]);
    const { emit, calls } = recorder();

    const emitted = await scanAndEmitDueSoon(store, memStorage(), emit, NOW, raiseAlert);

    expect(emitted).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("dedupes: a second scan for the same deadline does not re-emit", async () => {
    const dueIn1h = new Date(NOW + 60 * 60_000).toISOString();
    const store = okListReader([item({ id: 1, due_at: dueIn1h })]);
    const storage = memStorage();
    const { emit, calls } = recorder();

    await scanAndEmitDueSoon(store, storage, emit, NOW, raiseAlert);
    await scanAndEmitDueSoon(store, storage, emit, NOW + 5 * 60_000, raiseAlert);

    expect(calls).toHaveLength(1); // only the first scan fired
    // The dedupe map persisted exactly one key, retaining its first-notified instant.
    const persisted = (await storage.readJson<Record<string, string>>(DUE_SOON_NOTIFIED_FILE)) ?? {};
    expect(Object.keys(persisted)).toEqual([`1:${dueIn1h}`]);
    expect(persisted[`1:${dueIn1h}`]).toBe(new Date(NOW).toISOString());
  });

  it("re-fires when the deadline changes (new (id, due_at) key)", async () => {
    const due1 = new Date(NOW + 60 * 60_000).toISOString();
    const due2 = new Date(NOW + 2 * 60 * 60_000).toISOString();
    const storage = memStorage();
    const { emit, calls } = recorder();

    await scanAndEmitDueSoon(okListReader([item({ id: 1, due_at: due1 })]), storage, emit, NOW, raiseAlert);
    await scanAndEmitDueSoon(okListReader([item({ id: 1, due_at: due2 })]), storage, emit, NOW, raiseAlert);

    expect(calls).toHaveLength(2);
    const persisted = (await storage.readJson<Record<string, string>>(DUE_SOON_NOTIFIED_FILE)) ?? {};
    expect(Object.keys(persisted)).toEqual([`1:${due2}`]);
  });

  it("prunes the dedupe map when an item leaves the window", async () => {
    const dueIn1h = new Date(NOW + 60 * 60_000).toISOString();
    const storage = memStorage();
    const { emit } = recorder();

    await scanAndEmitDueSoon(okListReader([item({ id: 1, due_at: dueIn1h })]), storage, emit, NOW, raiseAlert);
    await scanAndEmitDueSoon(
      okListReader([item({ id: 1, due_at: dueIn1h, status: "completed" })]),
      storage,
      emit,
      NOW + 5 * 60_000,
      raiseAlert,
    );

    const persisted = (await storage.readJson<Record<string, string>>(DUE_SOON_NOTIFIED_FILE)) ?? {};
    expect(persisted).toEqual({});
  });

  it("returns [] when the board list is not ok", async () => {
    const store: DueSoonBoardReader = {
      list: async () => ({ status: "invalid", reason: "boom" }),
    };
    const { emit, calls } = recorder();

    const emitted = await scanAndEmitDueSoon(store, memStorage(), emit, NOW, raiseAlert);

    expect(emitted).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
