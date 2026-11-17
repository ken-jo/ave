/** The board write invariant as a property. Over seeded board files that hold stored run ids everywhere a hand edit can put them, every
 * store write path either leaves the file as it was or writes it so that (c) no stored run's id leaves the file unless the entry the write
 * removes on purpose held it, and (b) bytes the store would not write back were copied beside it first. */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { WorkBoardStore } from "../work-board-store.js";
import { sha256Hex as sha } from "../../lib/hex-digest-equal.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { TemplateRunStart } from "../../shared/workflow-template-types.js";

const RUN_IDS = ["run-a", "run-b", "run-c", "run-d", "run-e", "run-f"];
const AT = "2026-01-01T00:00:00.000Z";

// The test's own reading of "holds": the id as a whole string, its quotes escaped or not, in the text or in the text with its \uXXXX
// escapes decoded, as deep as they go.
function holds(text: string, runId: string): boolean {
  const word = new RegExp(`\\\\*"${runId}\\\\*"`);
  for (let level = text; ; ) {
    if (word.test(level)) return true;
    const next = level.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === level) return false;
    level = next;
  }
}

function prng(seed: number): (count: number) => number {
  let state = seed >>> 0;
  return (count) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * count);
  };
}

const row = (id: number, extra: object = {}) => ({ id, title: `row ${id}`, status: "planned", priority: "medium", created_at: AT, updated_at: AT, ...extra });

/** A board file drawn from `seed`: listable rows (some naming or holding stored runs), entries that do not validate holding stored run ids
 * (run fields edited in, a bad field, a row kept as a string or in a list, valid twins), unknown top-level keys holding them, written
 * pretty as a board write writes it, compact, with a hidden first items key, or with run ids spelled with escapes. */
function boardCase(seed: number): { text: string; canonical: boolean } {
  const pick = prng(seed);
  let nextId = 1;
  const id = () => nextId++;
  const runId = () => RUN_IDS[pick(RUN_IDS.length)];
  const listed: unknown[] = [];
  const invalid: unknown[] = [];
  const escapes: [string, string][] = [];
  for (let n = 0, count = 3 + pick(4); n < count; n += 1) {
    const X = runId();
    switch (pick(6)) {
      case 0: listed.push(row(id())); break;
      case 1: listed.push(row(id(), { runId: X, runStatus: ["planning", "executing", "completed"][pick(3)], runHistory: [{ runId: X, startedAt: AT, status: "executing" }] })); break;
      case 2: listed.push(row(id(), { runId: "run-zz", runStatus: "executing", runHistory: [{ runId: X, startedAt: AT, status: "completed" }, { runId: "run-zz", startedAt: AT, status: "executing" }] })); break;
      case 3: listed.push(row(id(), { detail: pick(2) === 0 ? X : `see ${X} notes` })); break;
      case 4: listed.push(row(id(), { templateId: "template-1" })); break;
      default: {
        const mark = `__escaped${escapes.length}__`;
        escapes.push([mark, `\\u${X.charCodeAt(0).toString(16).padStart(4, "0")}${X.slice(1)}`]);
        listed.push(row(id(), { runId: mark, runStatus: "completed", runHistory: [{ runId: mark, startedAt: AT, status: "completed" }] }));
      }
    }
  }
  for (let n = 0, count = 1 + pick(3); n < count; n += 1) {
    const X = runId();
    switch (pick(9)) {
      case 0: invalid.push(row(id(), { pin: { note: X } })); break;
      case 1: invalid.push(row(id(), { stageRuns: [{ runId: X }] })); break;
      case 2: invalid.push(row(id(), { planApproval: { runId: X } })); break;
      case 3: invalid.push(row(id(), { runHistory: [{ runId: "run-zz", startedAt: AT, status: "completed", stageRuns: [X] }] })); break;
      case 4: invalid.push(row(id(), { priority: 42, runId: X })); break;
      case 5: invalid.push(JSON.stringify(row(id(), { runId: X }))); break;
      case 6: invalid.push([row(id(), { runId: X })]); break;
      case 7: invalid.push(null, 7); break;
      default: {
        const twin = id();
        invalid.push(row(twin, { runId: X }), row(twin, { title: "twin" }));
      }
    }
  }
  const extra: Record<string, unknown> = {};
  if (pick(2) === 0) extra.archive = [row(100 + pick(50), { runId: runId() })];
  if (pick(3) === 0) extra.packed = JSON.stringify([row(100 + pick(50), { runId: runId() })]);
  if (pick(3) === 0) extra.note = pick(2) === 0 ? runId() : `moved ${runId()} by hand`;
  const hidden = [row(nextId + 1, { runId: runId() })];
  const file = { version: 1, nextId, ...(pick(4) === 0 ? { unknownBelow: 2 } : {}), ...extra, items: [...listed, ...invalid] };
  const form = pick(4);
  let text = form === 2 ? JSON.stringify(file)
    : form === 3 ? `{"items":${JSON.stringify(hidden)},${JSON.stringify(file).slice(1)}`
    : `${JSON.stringify(file, null, 2)}\n`;
  for (const [mark, raw] of escapes) text = text.replaceAll(`"${mark}"`, `"${raw}"`);
  return { text, canonical: form < 2 && escapes.length === 0 };
}

function start(): TemplateRunStart {
  const pin = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
  return { ...pin, source: { kind: "local-create-and-run", pin }, stageRuns: [{ stageId: "plan", attempt: 1, status: "waiting" }] };
}

interface Seen { ids: number[]; templateIds: number[]; namingIds: { id: number; runId: string; revision: string }[]; cards: { position: number; hash: string }[]; runCards: { position: number; hash: string }[] }
/** A write path: what it removes on purpose, given what the board showed before it. */
type Op = (store: WorkBoardStore, seen: Seen, entries: unknown[]) => Promise<unknown[]>;

const first = <T>(list: readonly T[]): T | undefined => list[0];
const OPS: Record<string, Op> = {
  create: async (store) => { await store.create({ title: "new" }); return []; },
  update: async (store, seen) => { for (const id of seen.ids) await store.update(id, { title: "renamed" }); return []; },
  clearDetail: async (store, seen) => { for (const id of seen.ids) await store.update(id, { detail: null }); return []; },
  transition: async (store, seen) => { const id = first(seen.ids); if (id !== undefined) await store.transition(id, "in_progress"); return []; },
  completeReopen: async (store, seen) => { const id = first(seen.ids); if (id !== undefined) { await store.complete(id); await store.reopen(id); } return []; },
  setRunStatus: async (store, seen) => { const id = first(seen.ids); if (id !== undefined) await store.setRunStatus(id, "executing"); return []; },
  beginRun: async (store, seen) => { const id = seen.ids.find((one) => !seen.templateIds.includes(one)); if (id !== undefined) await store.beginRun(id, "run-new", AT); return []; },
  beginTemplateRun: async (store, seen) => { const id = first(seen.templateIds); if (id !== undefined) await store.beginRun(id, "run-new", AT, start()); return []; },
  reconcile: async (store) => { await store.reconcileInterruptedRuns(); return []; },
  setRunSessionId: async (store, seen) => { const id = first(seen.ids); if (id !== undefined) await store.setRunSessionId(id, "session-1"); return []; },
  setRunResult: async (store, seen) => { for (const id of seen.ids) await store.setRunResult(id, { runStatus: "completed", plan: null, output: null }); return []; },
  plan: async (store, seen) => {
    for (const { id, runId } of seen.namingIds) {
      if (await store.setPlanAwaitingApproval(id, { runId, plan: "plan", runSessionId: "session-1", revision: 1, itemDigest: "d" }) === null) continue;
      const shown = await store.get(id);
      const planHash = shown.status === "found" ? shown.item.planApproval?.planHash ?? "" : "";
      await store.decidePlan(id, { runId, planHash, status: "rejected" });
    }
    return [];
  },
  clearMissingRun: async (store, seen) => { for (const { id, runId, revision } of seen.namingIds) await store.clearMissingRun(id, revision, runId); return []; },
  remove: async (store, seen) => {
    const id = first(seen.ids);
    if (id === undefined) return [];
    const shown = await store.get(id);
    await store.remove(id);
    return shown.status === "found" ? [shown.item] : [];
  },
  removeUnreadable: async (store, seen, entries) => {
    const card = first(seen.cards);
    if (!card) return [];
    await store.removeUnreadable(card, () => true);
    return entries.filter((entry) => sha(JSON.stringify(entry)) === card.hash);
  },
  pruneSettledRuns: async (store) => { await store.pruneSettledRuns(); return []; },
  discardUnreadableRun: async (store, seen) => { const card = first(seen.runCards); if (card) await store.discardUnreadableRun(card, () => true); return []; },
};

it("no store write takes a stored run's id out of board.json unless the entry it removes held it, and every write over bytes it would not give back keeps them first", async () => {
  const tally = { writes: 0, refused: 0, kept: 0 };
  for (let seed = 1; seed <= 24; seed += 1) {
    const { text, canonical } = boardCase(seed);
    for (const [name, op] of Object.entries(OPS)) {
      const dir = mkdtempSync(join(tmpdir(), "ave-wb-guard-"));
      try {
        const path = join(dir, "board.json");
        writeFileSync(path, text, "utf-8");
        writeFileSync(join(dir, "workflow-runs.json"), `${JSON.stringify({ version: 1, rowIdFloor: 0, runs: RUN_IDS.map((runId) => ({ runId, itemId: 1 })) }, null, 2)}\n`, "utf-8");
        const store = new WorkBoardStore(path, () => Date.parse(AT));
        await store.load();
        const listed = await store.list();
        if (listed.status !== "ok") throw new Error("board not listed");
        const seen: Seen = {
          ids: listed.items.map((item) => item.id),
          templateIds: listed.items.filter((item) => item.templateId !== undefined).map((item) => item.id),
          namingIds: listed.items.flatMap((item) => item.runId === undefined || item.mutationRevision === undefined ? [] : [{ id: item.id, runId: item.runId, revision: item.mutationRevision }]),
          cards: listed.unreadableRows ?? [],
          runCards: listed.unreadableRuns ?? [],
        };
        const before = readFileSync(path);
        const entries = (JSON.parse(before.toString("utf-8")) as { items: unknown[] }).items;
        let released: unknown[] = [];
        try { released = await op(store, seen, entries); }
        catch { tally.refused += 1; }
        const after = readFileSync(path);
        if (after.equals(before)) continue;
        tally.writes += 1;
        const context = `seed ${seed}, ${name}`;
        for (const runId of RUN_IDS) {
          if (holds(before.toString("utf-8"), runId) && !holds(after.toString("utf-8"), runId)) {
            expect(released.some((entry) => holds(JSON.stringify(entry), runId)), `${context}: ${runId} left the file`).toBe(true);
          }
        }
        if (!canonical) {
          const copy = readdirSync(dir).find((name) => name === `board.json.invalid-rows-${sha(before)}.bak`);
          expect(copy && readFileSync(join(dir, copy)).equals(before), `${context}: the bytes were not kept`).toBe(true);
          tally.kept += 1;
        }
      } finally {
        await cleanupTmpDir(dir);
      }
    }
  }
  // The draw reaches writes, refusals and copies alike.
  expect(tally.writes).toBeGreaterThan(50);
  expect(tally.refused).toBeGreaterThan(5);
  expect(tally.kept).toBeGreaterThan(10);
}, 180_000);
