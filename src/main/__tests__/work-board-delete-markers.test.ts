import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import * as namespace from "../storage/feature-namespace.js";
import { WorkBoardStore } from "../work-board-store.js";

const AT = "2026-01-01T00:00:00.000Z";
const PIN = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
const INTENT = { itemId: 40, runId: "run-r" };
const namedRow = () => ({
  id: INTENT.itemId, title: "work", status: "planned", priority: "medium", created_at: AT, updated_at: AT,
  templateId: PIN.templateId, runId: INTENT.runId, runStatus: "executing",
});
const invalidRow = () => ({ ...namedRow(), title: 0 });

interface RunsOnDisk { deleteIntents?: unknown[]; unknownDeletes?: unknown[] }
// `faultBoard`: while on, a board write lands and then reports failure, and the board file cannot be read back after it. `reopen`: the
// store a restart opens on the same files.
interface Home { store: WorkBoardStore; readRuns(): RunsOnDisk; runWrites(): RunsOnDisk[]; faultBoard(on: boolean): void; reopen(): Promise<WorkBoardStore> }

async function withHome(board: string | unknown[], deletes: RunsOnDisk, body: (home: Home) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ave-delete-marker-"));
  const path = join(dir, "board.json");
  const runsPath = join(dir, "workflow-runs.json");
  const run = { runId: INTENT.runId, itemId: INTENT.itemId, pin: PIN, runStartedBy: { kind: "local-create-and-run", pin: PIN }, startedAt: AT, stageRuns: [] };
  writeFileSync(path, typeof board === "string" ? board : `${JSON.stringify({ version: 1, nextId: 51, items: board }, null, 2)}\n`);
  writeFileSync(runsPath, `${JSON.stringify({ version: 1, rowIdFloor: 50, runs: [run], ...deletes }, null, 2)}\n`);
  const writes: RunsOnDisk[] = [];
  let fault = false;
  let failed = false;
  const write = namespace.writeFileAtomicAtPath;
  const read = homeTrust.readAveHomeInput;
  vi.spyOn(namespace, "writeFileAtomicAtPath").mockImplementation(async (target, text) => {
    if (target === runsPath) writes.push(JSON.parse(String(text)) as RunsOnDisk);
    await write(target, text);
    if (target === path && fault) {
      failed = true;
      throw new Error("board replacement reported failure");
    }
  });
  vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async target => {
    if (target === path && fault && failed) throw Object.assign(new Error("board readback unavailable"), { code: "EACCES" });
    return read(target);
  });
  const store = new WorkBoardStore(path, () => Date.parse(AT));
  try {
    await store.load();
    await body({
      store,
      readRuns: () => JSON.parse(readFileSync(runsPath, "utf8")) as RunsOnDisk,
      runWrites: () => writes,
      faultBoard: (on) => { fault = on; failed = false; },
      reopen: async () => {
        const reopened = new WorkBoardStore(path, () => Date.parse(AT));
        await reopened.load();
        return reopened;
      },
    });
  } finally {
    vi.restoreAllMocks();
    await cleanupTmpDir(dir);
  }
}

async function classOf(store: WorkBoardStore): Promise<string> {
  const classes = await store.runClasses();
  if (typeof classes !== "function") throw new Error(`no classes: ${classes}`);
  return classes(INTENT);
}

async function card(store: WorkBoardStore): Promise<{ position: number; hash: string }> {
  const listed = await store.list();
  const found = listed.status === "ok" ? listed.unreadableRows?.[0] : undefined;
  if (!found) throw new Error("missing invalid card");
  return found;
}

it.each([
  ["a listed row", [namedRow()]],
  ["an invalid card", [invalidRow()]],
] as const)("a legacy marker of the pair alone is held while %s has its id, and that delete resolves it", async (what, items) =>
  withHome([...items], { deleteIntents: [INTENT], unknownDeletes: [{ ...INTENT }] }, async ({ store, readRuns, runWrites }) => {
    expect(await classOf(store)).toBe("unreadable");
    expect(readRuns()).toMatchObject({ deleteIntents: [INTENT], unknownDeletes: [INTENT] });
    const before = runWrites().length;
    const deleted = what === "a listed row" ? await store.remove(INTENT.itemId) : await store.removeUnreadable(await card(store), () => true);
    expect(deleted).toMatchObject({ status: "deleted", itemId: INTENT.itemId });
    expect(runWrites()[before]).toMatchObject({ deleteIntents: [INTENT] });
    expect(runWrites()[before]?.unknownDeletes).toBeUndefined();
    expect(await classOf(store)).toBe("due-delete");
  }));

it("a card delete of unknown outcome is held while another entry keeps its id, and that entry's delete resolves it", async () =>
  withHome([invalidRow(), { id: INTENT.itemId, title: 1 }], {}, async ({ store, readRuns, runWrites, faultBoard, reopen }) => {
    const target = await card(store);
    faultBoard(true);
    await expect(store.removeUnreadable(target, () => true)).rejects.toThrow("board replacement reported failure");
    faultBoard(false);
    const marker = { ...INTENT, op: "card", ownIntent: true, entrySha: expect.stringMatching(/^[0-9a-f]{64}$/) };
    expect(readRuns()).toMatchObject({ deleteIntents: [INTENT], unknownDeletes: [marker] });
    const restarted = await reopen();
    expect(await classOf(restarted)).toBe("unreadable");
    expect(readRuns()).toMatchObject({ deleteIntents: [INTENT], unknownDeletes: [marker] });
    const before = runWrites().length;
    expect(await restarted.removeUnreadable(await card(restarted), () => true)).toMatchObject({ status: "deleted", itemId: INTENT.itemId });
    expect(runWrites()[before]).toMatchObject({ deleteIntents: [INTENT] });
    expect(runWrites()[before]?.unknownDeletes).toBeUndefined();
    expect(await classOf(restarted)).toBe("due-delete");
  }));

const entry = JSON.stringify(invalidRow());
const entrySha = createHash("sha256").update(entry).digest("hex");
it.each([
  ["the same bytes", "unlanded", `{"version":1,"nextId":51,"items":[${entry}]}`],
  ["the same value written otherwise", "held", `{"version":1,"nextId":51,"items":[${JSON.stringify(invalidRow(), null, 1)}]}`],
  ["a board holding a top-level key twice", "held", `{"version":1,"nextId":51,"items":[${entry}],"items":[${entry}]}`],
] as const)("a card marker's entry is its raw stored bytes: %s reads %s", async (_, outcome, board) =>
  withHome(board, { deleteIntents: [INTENT], unknownDeletes: [{ ...INTENT, op: "card", ownIntent: true, entrySha }] }, async ({ store, readRuns }) => {
    expect(await classOf(store)).toBe("unreadable");
    if (outcome === "unlanded") {
      expect(readRuns().deleteIntents).toBeUndefined();
      expect(readRuns().unknownDeletes).toBeUndefined();
    } else {
      expect(readRuns()).toMatchObject({ deleteIntents: [INTENT], unknownDeletes: [{ ...INTENT, op: "card" }] });
    }
  }));

it.each([
  ["the pair alone", {}],
  ["another delete's intent", { op: "card", ownIntent: false }],
  ["a card op", { op: "card", ownIntent: true, entrySha }],
  ["a row op", { op: "row", ownIntent: true }],
])("a marker of %s resolves landed once no entry has its id", async (_, shape) =>
  withHome(
    [{ id: 41, title: "other", status: "planned", priority: "medium", created_at: AT, updated_at: AT }],
    { deleteIntents: [INTENT], unknownDeletes: [{ ...INTENT, ...shape }] },
    async ({ store, readRuns }) => {
      expect(await classOf(store)).toBe("due-delete");
      expect(readRuns()).toMatchObject({ deleteIntents: [INTENT] });
      expect(readRuns().unknownDeletes).toBeUndefined();
    },
  ));

it.each([
  ["a legacy marker", {}],
  ["a card with no identified entry", { op: "card", ownIntent: true }],
  ["another delete's intent", { op: "card", ownIntent: false }],
])("%s stays held when only the item id is absent and another entry holds the run id", async (_, shape) =>
  withHome(
    [{ id: 41, title: 0, retained: JSON.stringify({ nested: INTENT.runId }) }],
    { deleteIntents: [INTENT], unknownDeletes: [{ ...INTENT, ...shape }] },
    async ({ store, readRuns, reopen }) => {
      expect(await classOf(store)).toBe("unreadable");
      expect(readRuns()).toMatchObject({ deleteIntents: [INTENT], unknownDeletes: [{ ...INTENT, ...shape }] });
      expect(await classOf(await reopen())).toBe("unreadable");
    },
  ));
