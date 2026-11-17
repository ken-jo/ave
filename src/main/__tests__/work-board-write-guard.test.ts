/** The board write invariant as a property. Over seeded board files that hold stored run ids everywhere a hand edit can put them, every
 * store write path either leaves the file as it was or writes it so that (c) no id of a stored run that is not settled leaves the file,
 * and (b) bytes the store would not write back were copied beside it first. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { WorkBoardStore } from "../work-board-store.js";
import { WorkflowRunStore } from "../workflow-run-store.js";
import { repeatsKey, rewriteKeepingBytes } from "../storage/rewrite-keeping-bytes.js";
import { sha256Hex as sha } from "../../lib/hex-digest-equal.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { TemplateRunStart, WorkflowRunRecord } from "../../shared/workflow-template-types.js";

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
    switch (pick(7)) {
      case 0: listed.push(row(id())); break;
      case 6: listed.push(row(id(), { templateId: "template-1", runId: "run-zz", runStatus: "executing", runHistory: [{ runId: "run-zz", startedAt: AT, status: "executing" }] })); break;
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

const PIN = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
const live = (runId: string, itemId = 40): WorkflowRunRecord => ({ runId, itemId, pin: PIN, runStartedBy: { kind: "local-create-and-run", pin: PIN }, startedAt: AT, stageRuns: [] });
function start(): TemplateRunStart {
  return { ...PIN, source: { kind: "local-create-and-run", pin: PIN }, stageRuns: [{ stageId: "plan", attempt: 1, status: "waiting" }] };
}

/** The stored runs: entries that do not read as runs (so any could be on any row), or settled runs (so a mark over them can drop). */
const runsFile = (seed: number): string => `${JSON.stringify({
  version: 1, rowIdFloor: 0,
  runs: RUN_IDS.map((runId) => seed % 2 === 1 ? { runId, itemId: 1 } : {
    runId, itemId: 1, pin: PIN, runStartedBy: { kind: "local-create-and-run", pin: PIN }, startedAt: AT,
    stageRuns: [{ stageId: "plan", attempt: 1, status: "cancelled", endedAt: AT }], settled: { status: "cancelled", at: AT },
  }),
}, null, 2)}\n`;

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

it("no store write takes out of board.json the id of a stored run that is not settled, and every write over bytes it would not give back keeps them first", async () => {
  const tally = { writes: 0, refused: 0, kept: 0 };
  const wrote = new Set<string>();
  for (let seed = 1; seed <= 24; seed += 1) {
    const { text, canonical } = boardCase(seed);
    for (const [name, op] of Object.entries(OPS)) {
      const dir = mkdtempSync(join(tmpdir(), "ave-wb-guard-"));
      try {
        const path = join(dir, "board.json");
        writeFileSync(path, text, "utf-8");
        writeFileSync(join(dir, "workflow-runs.json"), runsFile(seed), "utf-8");
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
        try { await op(store, seen, entries); }
        catch { tally.refused += 1; }
        const after = readFileSync(path);
        if (after.equals(before)) continue;
        tally.writes += 1;
        wrote.add(name);
        const context = `seed ${seed}, ${name}`;
        // Odd seeds store entries that do not read as runs, so each could be a run that is not over; even seeds store settled runs.
        for (const runId of seed % 2 === 1 ? RUN_IDS : []) {
          expect(!holds(before.toString("utf-8"), runId) || holds(after.toString("utf-8"), runId), `${context}: ${runId} left the file`).toBe(true);
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
  // The draw reaches writes, refusals and copies alike, and a board write by every path; the run record discard writes the run file only.
  expect(Object.keys(OPS).filter((name) => !wrote.has(name))).toEqual(["discardUnreadableRun"]);
  expect(tally.writes).toBeGreaterThan(50);
  expect(tally.refused).toBeGreaterThan(5);
  expect(tally.kept).toBeGreaterThan(10);
}, 180_000);

async function home(board: string, runs: unknown[]): Promise<{ dir: string; path: string; store: WorkBoardStore }> {
  const dir = mkdtempSync(join(tmpdir(), "ave-evidence-"));
  writeFileSync(join(dir, "board.json"), board);
  writeFileSync(join(dir, "workflow-runs.json"), JSON.stringify({ version: 1, rowIdFloor: 50, runs }));
  const store = new WorkBoardStore(join(dir, "board.json"), () => Date.parse(AT));
  await store.load();
  return { dir, path: join(dir, "board.json"), store };
}
const nested = (value: unknown, levels: number): unknown => {
  let packed = value;
  for (let n = 0; n < levels; n += 1) packed = JSON.stringify(packed);
  return packed;
};
// Short text that still decodes past 16 levels: each level turns one `\` into the backslash of the next.
const OVERFLOW = `\\${"u005c".repeat(20)}`;
// The ways the run file cannot be read, as the home read gives them, with the code a board write they refuse gives.
const RUN_FILE_UNREADABLE: [string, () => Promise<homeTrust.AveHomeInput>, string][] = [
  ["cannot be read", async () => { throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }); }, "work-board-runs-unreadable"],
  ["awaits review", async () => ({ status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" }), "work-board-runs-unreadable"],
  ["is past its read limit", async () => { throw new homeTrust.AveHomeInputSizeLimitError("too large"); }, "work-board-runs-unreadable"],
  ["does not parse", async () => ({ status: "trusted", bytes: Buffer.from("{") }), "work-board-runs-unreadable"],
  ["holds a key twice", async () => ({ status: "trusted", bytes: Buffer.from('{"version":1,"rowIdFloor":0,"runs":[],"runs":[]}') }), "work-board-runs-unreadable"],
];

describe("the evidence scan", () => {
  it.each(["run.with-dot", "run:other", "run space", "실행", "say \"hi\"", "back\\slash", "D:\\", "x".repeat(256)])("holds the stored run id %j wherever a string holds it whole", async (runId) => {
    // Between quotes in decoded text that is not JSON too, for an id that holds neither a quote nor a backslash.
    const loose = /["\\]/.test(runId) ? [] : [{ archive: `x" "${runId}" y` }];
    for (const where of [{ archive: [row(9, { runId })] }, { archive: nested({ runId }, 3) }, ...loose]) {
      const { dir, store } = await home(JSON.stringify({ version: 1, nextId: 51, ...where, items: [row(2)] }), [live(runId)]);
      try { expect((await store.runRowsOnDisk())?.(live(runId))).toBe("unreadable"); } finally { await cleanupTmpDir(dir); }
    }
  });

  it("holds an id spelled with escapes and not one only inside other text", async () => {
    const text = `{"version":1,"nextId":51,"a":"\u0072un-a","b":"see run-b notes","items":[]}`;
    const { dir, store } = await home(text, [live("run-a"), live("run-b")]);
    try {
      const standing = await store.runRowsOnDisk();
      expect([standing?.(live("run-a")), standing?.(live("run-b"))]).toEqual(["unreadable", "gone"]);
    } finally { await cleanupTmpDir(dir); }
  });

  it("holds every id only past 16 levels of escapes, never for a backslash at a string's end", async () => {
    for (const [value, held] of [[nested("other", 18), "unreadable"], [nested("other", 6), "gone"], ["C:\\", "gone"], ["\\\\\\\\\\\\\\\\", "gone"]] as const) {
      const { dir, store } = await home(JSON.stringify({ version: 1, nextId: 51, note: value, items: [] }), [live("run-a")]);
      try { expect((await store.runRowsOnDisk())?.(live("run-a"))).toBe(held); } finally { await cleanupTmpDir(dir); }
    }
  });

  it("refuses an edit that takes out the last string holding a live run's id, whatever characters the id has", async () => {
    const { dir, path, store } = await home(`${JSON.stringify({ version: 1, nextId: 51, items: [row(2, { detail: "run.with-dot" })] }, null, 2)}\n`, [live("run.with-dot")]);
    try {
      const before = readFileSync(path, "utf8");
      await expect(store.update(2, { detail: "done" })).rejects.toMatchObject({ code: "work-board-run-id-held" });
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally { await cleanupTmpDir(dir); }
  });
});

describe("what lets a write take a live run's id out of board.json", () => {
  const card = async (store: WorkBoardStore) => {
    const shown = await store.list();
    const found = shown.status === "ok" ? shown.unreadableRows?.[0] : undefined;
    if (!found) throw new Error("no invalid card");
    return found;
  };
  const history = [{ runId: "settled-s", startedAt: AT, status: "completed", outputPreview: "run-a" }, ...Array.from({ length: 19 }, (_, n) => ({ runId: `old-${n}`, startedAt: AT, status: "completed" }))];
  const settled = { ...live("settled-s", 2), settled: { status: "completed", at: AT } };

  it.each<[string, unknown[], (store: WorkBoardStore) => Promise<unknown>]>([
    ["a delete of a row holding it", [row(2, { detail: "run-a" })], store => store.remove(2)],
    ["an invalid card's delete of a row holding it", [row(2), { id: 3, title: 0, note: "run-a" }], async store => store.removeUnreadable(await card(store), () => true)],
    ["an invalid card's delete of the row whose escapes go past 16 levels", [row(2), { id: 3, title: 0, note: nested("other", 18) }], async store => store.removeUnreadable(await card(store), () => true)],
    ["a run start whose history cap drops a settled run's entry holding it", [row(2, { runId: "old-18", runStatus: "completed", runHistory: history })], store => store.beginRun(2, "next-run", AT)],
  ])("refuses %s: nothing a write removes releases an id", async (_, items, write) => {
    const { dir, path, store } = await home(`${JSON.stringify({ version: 1, nextId: 51, items }, null, 2)}\n`, [live("run-a"), settled]);
    try {
      const before = readFileSync(path, "utf8");
      await expect(write(store)).rejects.toMatchObject({ code: "work-board-run-id-held" });
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally { await cleanupTmpDir(dir); }
  });

  it("lets only the user's delete of the row naming the run take its id out, and only with its delete intent stored", async () => {
    const { dir, path, store } = await home(`${JSON.stringify({ version: 1, nextId: 51, items: [row(40, { templateId: PIN.templateId, runId: "run-a", runStatus: "executing" })] }, null, 2)}\n`, [live("run-a")]);
    try {
      const before = readFileSync(path, "utf8");
      const marked = vi.spyOn(store.runs, "markDeleted").mockResolvedValueOnce("none");
      await expect(store.remove(40)).rejects.toMatchObject({ code: "work-board-run-id-held" });
      expect(readFileSync(path, "utf8")).toBe(before);
      marked.mockRestore();
      expect(await store.remove(40)).toEqual({ status: "deleted", itemId: 40, runId: "run-a" });
      expect(readFileSync(path, "utf8")).not.toContain("run-a");
    } finally { await cleanupTmpDir(dir); }
  });

  it("frees no run by its delete intent over a board whose escapes go past 16 levels: every run counts as held there", async () => {
    const naming = row(40, { templateId: PIN.templateId, runId: "run-a", runStatus: "executing" });
    for (const [items, deleted] of [[[{ ...naming, detail: OVERFLOW }], false], [[naming, row(41, { detail: OVERFLOW })], true]] as const) {
      const { dir, path, store } = await home(`${JSON.stringify({ version: 1, nextId: 51, items }, null, 2)}\n`, [live("run-a")]);
      try {
        const before = readFileSync(path, "utf8");
        if (deleted) expect(await store.remove(40)).toEqual({ status: "deleted", itemId: 40, runId: "run-a" });
        else {
          await expect(store.remove(40)).rejects.toMatchObject({ code: "work-board-run-id-held" });
          expect(readFileSync(path, "utf8")).toBe(before);
        }
      } finally { await cleanupTmpDir(dir); }
    }
  });

  // A write that removes an entry or the user's text while no run can be read: it cannot tell which runs that held.
  describe.each(RUN_FILE_UNREADABLE)("while the run file %s", (_, input, code) => {
    it.each<[string, unknown[], (store: WorkBoardStore) => Promise<() => Promise<unknown>>]>([
      ["a delete of a row", [row(2, { detail: "run-a" })], async store => () => store.remove(2)],
      ["an edit of the user's text", [row(2, { detail: "run-a" })], async store => () => store.update(2, { detail: "done" })],
      ["an invalid card's delete", [row(2), { id: 3, title: 0, note: "run-a" }], async store => { const shown = await card(store); return () => store.removeUnreadable(shown, () => true); }],
      ["a run start whose history cap drops an entry", [row(2, { runId: "old-18", runStatus: "completed", runHistory: history })], async store => () => store.beginRun(2, "next-run", AT)],
    ])("refuses %s over the board as it was last written", async (_, items, prepare) => {
      const { dir, path, store } = await home(`${JSON.stringify({ version: 1, nextId: 51, items }, null, 2)}\n`, [live("run-a"), settled]);
      try {
        await store.update(2, { title: "row two" });
        const write = await prepare(store);
        const before = readFileSync(path, "utf8");
        const read = homeTrust.readAveHomeInput;
        vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(target => target === join(dir, "workflow-runs.json") ? input() : read(target));
        await expect(write()).rejects.toMatchObject({ code });
        expect(readFileSync(path, "utf8")).toBe(before);
      } finally {
        vi.restoreAllMocks();
        await cleanupTmpDir(dir);
      }
    });
  });
});

describe("a file that holds a key twice", () => {
  const backups = (dir: string, file: string) => readdirSync(dir).filter(name => name.startsWith(`${file}.`) && name.endsWith(".bak"));
  function home(board: string, runs: string): { dir: string; path: string; runsPath: string; store: WorkBoardStore } {
    const dir = mkdtempSync(join(tmpdir(), "ave-repeated-key-"));
    writeFileSync(join(dir, "board.json"), board);
    writeFileSync(join(dir, "workflow-runs.json"), runs);
    return { dir, path: join(dir, "board.json"), runsPath: join(dir, "workflow-runs.json"), store: new WorkBoardStore(join(dir, "board.json"), () => Date.parse(AT)) };
  }
  const runsText = JSON.stringify({ version: 1, rowIdFloor: 50, runs: [] });

  it("is told apart from JSON whose keys are each there once, at any depth, and never from text inside a string", () => {
    expect(repeatsKey('{"a":{"b":1,"b":2}}')).toBe(true);
    expect(repeatsKey('[{"k":[1,{"x":0,"x":0}]}]')).toBe(true);
    expect(repeatsKey(`${"[".repeat(100_000)}${"]".repeat(100_000)}`)).toBe(true);
    expect(repeatsKey('{"a":1,"b":{"a":1},"c":"{\\"d\\":1,\\"d\\":2}"}')).toBe(false);
    expect(repeatsKey("{")).toBe(false);
  });

  it.each([
    ["a row's key", `{"version":1,"nextId":51,"items":[{"id":2,"title":"a","title":"b","status":"planned","priority":"medium","created_at":"${AT}","updated_at":"${AT}"}]}`],
    ["the items key", `{"version":1,"nextId":51,"items":[${JSON.stringify(row(1, { runId: "run-a", templateId: "template-1" }))}],"items":[${JSON.stringify(row(2))}]}`],
    ["a key nested in an unknown entry", `{"version":1,"nextId":51,"archive":[{"note":{"k":1,"k":2}}],"items":[${JSON.stringify(row(2))}]}`],
  ])("board.json holding %s twice is listed with the refusal, no write goes over it, and once fixed by hand it is written again", async (_, text) => {
    const { dir, path, store } = home(text, JSON.stringify({ version: 1, rowIdFloor: 50, runs: [live("run-a", 1)] }));
    try {
      await store.load();
      expect(await store.list()).toMatchObject({ status: "ok", items: [{ id: 2 }], writesRefused: "work-board-duplicate-key" });
      expect(await store.create({ title: "New" })).toEqual({ status: "invalid", reason: "work-board-duplicate-key" });
      await expect(store.update(2, { detail: "x" })).rejects.toMatchObject({ code: "work-board-duplicate-key" });
      await expect(store.remove(2)).rejects.toMatchObject({ code: "work-board-duplicate-key" });
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(backups(dir, "board.json")).toEqual([]);
      writeFileSync(path, JSON.stringify({ version: 1, nextId: 51, items: [row(1, { runId: "run-a", templateId: "template-1" }), row(2)] }));
      expect(await store.create({ title: "New" })).toMatchObject({ status: "created" });
      expect(await store.list()).not.toHaveProperty("writesRefused");
    } finally { await cleanupTmpDir(dir); }
  });

  it("workflow-runs.json holding a key twice is not read or written over: the board says why, and once fixed by hand it is read again", async () => {
    const text = `{"version":1,"rowIdFloor":50,"runs":[${JSON.stringify(live("run-a", 2))}],"runs":[]}`;
    const { dir, path, runsPath, store } = home(`${JSON.stringify({ version: 1, nextId: 51, items: [row(2, { runId: "run-a", templateId: "template-1" })] }, null, 2)}\n`, text);
    try {
      const runs = new WorkflowRunStore(runsPath);
      const refusal = { code: "workflow-runs-duplicate-key", path: runsPath };
      for (const read of [() => runs.raiseRowIdFloor(60), () => runs.issueRowId(60), () => runs.list(), () => runs.get("run-a"), () => runs.prune(() => null),
        () => runs.put(live("run-b", 3)), () => runs.discardUnreadable({ position: 0, hash: "a".repeat(64) }, () => true)]) {
        await expect(read()).rejects.toMatchObject(refusal);
      }
      await store.load();
      await expect(store.list()).rejects.toMatchObject(refusal);
      expect(await store.create({ title: "New" })).toEqual({ status: "invalid", reason: "workflow-runs-duplicate-key" });
      expect(readFileSync(runsPath, "utf8")).toBe(text);
      expect(backups(dir, "workflow-runs.json")).toEqual([]);
      writeFileSync(runsPath, runsText);
      expect(await store.list()).toMatchObject({ status: "ok" });
      expect(readFileSync(path, "utf8")).toContain("run-a");
    } finally { await cleanupTmpDir(dir); }
  });
});

describe("the copy kept of bytes a write goes over", () => {
  const before = Buffer.from('{"keep": 1}\r\n');
  it.each([["board.json", "invalid-rows"], ["workflow-runs.json", "invalid-runs"]] as const)("%s is not written over while a copy already there does not hold its bytes or cannot be read, and is once it does", async (name, tag) => {
    const dir = mkdtempSync(join(tmpdir(), "ave-kept-copy-"));
    try {
      const path = join(dir, name);
      const copy = `${path}.${tag}-${sha(before)}.bak`;
      const write = () => rewriteKeepingBytes(path, '{"keep":2}\n', { tag, unchanged: '{"keep":1}\n' });
      writeFileSync(path, before);
      writeFileSync(copy, "other bytes");
      await expect(write()).rejects.toMatchObject({ code: "work-board-backup-conflict", path: copy });
      expect([readFileSync(path), readFileSync(copy, "utf8")]).toEqual([before, "other bytes"]);
      rmSync(copy);
      mkdirSync(copy);
      await expect(write()).rejects.toMatchObject({ code: "work-board-backup-conflict", path: copy });
      expect(readFileSync(path)).toEqual(before);
      rmSync(copy, { recursive: true });
      writeFileSync(copy, before);
      await write();
      expect([readFileSync(path, "utf8"), readFileSync(copy)]).toEqual(['{"keep":2}\n', before]);
    } finally { await cleanupTmpDir(dir); }
  });

  it("a board edit over bytes whose copy there does not hold them is refused with that code, and the board stays as it was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-kept-copy-"));
    try {
      const path = join(dir, "board.json");
      const text = JSON.stringify({ version: 1, nextId: 3, items: [row(2)] });
      writeFileSync(path, text);
      writeFileSync(join(dir, "workflow-runs.json"), `${JSON.stringify({ version: 1, rowIdFloor: 2, runs: [] }, null, 2)}\n`);
      writeFileSync(`${path}.invalid-rows-${sha(Buffer.from(text))}.bak`, "other bytes");
      const store = new WorkBoardStore(path, () => Date.parse(AT));
      await store.load();
      await expect(store.update(2, { detail: "x" })).rejects.toMatchObject({ code: "work-board-backup-conflict" });
      expect(readFileSync(path, "utf8")).toBe(text);
    } finally { await cleanupTmpDir(dir); }
  });
});
