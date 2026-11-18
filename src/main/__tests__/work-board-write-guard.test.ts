/** The board write invariant as a property over random op sequences, each on one home every op changes: store writes (a delete whose
 * board write fails before or after it replaces the file among them), the engine's settle, boot, own fields and its end of each run whose
 * delete is due, and hand edits of either file. Read with the test's own model, never the store's rule: a stored run that is not settled
 * never has its id taken out of board.json by a store write, except by the user's delete of the row its record names with that delete's
 * intent on disk before the file is replaced, one run at a time, and never over text past the escape cap; a delete whose write does not
 * land takes its intent back; a run ends from its intent only once the board lists no row with that id and holds the id as no string
 * value; its row reads as standing wherever its id is; bytes a write goes over that the store did not write are copied beside the file
 * first; a file holding a key twice is never written. */
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { WorkBoardStore } from "../work-board-store.js";
import { WorkflowRunStore } from "../workflow-run-store.js";
import { WorkBoardWriteRefusal, repeatsKey, rewriteKeepingBytes } from "../storage/rewrite-keeping-bytes.js";
import { sha256Hex as sha } from "../../lib/hex-digest-equal.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import * as namespace from "../storage/feature-namespace.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";
import type { TemplateRunStart, WorkflowRunRecord } from "../../shared/workflow-template-types.js";

const AT = "2026-01-01T00:00:00.000Z";
const LIVE = ["run-a", "run.dot 1", "run:b", "실행-c", "run\"q", "run\\b", "run-😀"];
// Short text that still decodes past 16 levels: each level turns one `\` into the backslash of the next.
const OVERFLOW = `\\${"u005c".repeat(20)}`;
const BLOB = JSON.stringify(OVERFLOW).slice(1, -1);

const jsonOf = (text: string): { value: unknown } | undefined => { try { return { value: JSON.parse(text) as unknown }; } catch { return undefined; } };
// The test's own reading of "holds": the file read as JSON, the id as a whole string value anywhere (never a key), or in a string value
// that is JSON itself, read the same way. Text holding the overflow blob holds every id. `plain`: every string value holding a quote or a
// backslash is JSON or a run id the sequence named, so no reading of the text finds other string values in it.
function stringsOf(text: string, named: ReadonlySet<string> = new Set()): { values: Set<string>; plain: boolean } {
  const values = new Set<string>();
  let plain = true;
  const walk = (value: unknown, depth: number): void => {
    if (typeof value === "string") {
      values.add(value);
      const inner = depth < 64 ? jsonOf(value) : undefined;
      if (inner) walk(inner.value, depth + 1);
      else if (/["\\]/.test(value) && !named.has(value)) plain = false;
    } else if (typeof value === "object" && value !== null) for (const entry of Object.values(value)) walk(entry, depth);
  };
  walk(JSON.parse(text), 0);
  return { values, plain };
}
function heldBy(text: string): (runId: string) => boolean {
  if (text.includes(BLOB)) return () => true;
  const { values } = stringsOf(text);
  return (runId) => values.has(runId);
}
const holds = (text: string, runId: string): boolean => heldBy(text)(runId);
const odd = (runId: string): string | undefined =>
  runId.includes("\"") ? "quote" : runId.includes("\\") ? "backslash" : /[\ud800-\udfff]/.test(runId) ? "surrogate" : undefined;

function prng(seed: number): (count: number) => number {
  let state = seed >>> 0;
  return (count) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * count);
  };
}
const one = <T>(pick: (count: number) => number, list: readonly T[]): T | undefined => list.length === 0 ? undefined : list[pick(list.length)];

const row = (id: number, extra: object = {}) => ({ id, title: `row ${id}`, status: "planned", priority: "medium", created_at: AT, updated_at: AT, ...extra });
const PIN = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
const live = (runId: string, itemId = 40): WorkflowRunRecord => ({ runId, itemId, pin: PIN, runStartedBy: { kind: "local-create-and-run", pin: PIN }, startedAt: AT, stageRuns: [] });
const ended = (runId: string, itemId: number): WorkflowRunRecord => ({ ...live(runId, itemId), settled: { status: "completed", at: AT } });
function start(): TemplateRunStart {
  return { ...PIN, source: { kind: "local-create-and-run", pin: PIN }, stageRuns: [{ stageId: "plan", attempt: 1, status: "waiting" }] };
}
const old = (count: number, from = 0) => Array.from({ length: count }, (_, n) => ({ runId: `old-${from + n}`, startedAt: AT, status: "completed" }));
const own = (id: number, runId: string, runHistory: object[] = [{ runId, startedAt: AT, status: "executing" }]) =>
  row(id, { templateId: PIN.templateId, runId, runStatus: "executing", runHistory });

/** A home: a template row naming each live run (row 4's run first in a history the second start there pushes past the cap), a settled run
 * named and one in a history, a settled run whose row is gone, a row whose run has no record, rows naming another row's run (one whose
 * own row is gone), a run whose row is gone held only by another row's session id, user text and capped histories holding stored ids,
 * entries that do not read as runs whose ids only text holds; both files as no store writes them. */
function seedHome(dir: string, pick: (count: number) => number): void {
  const anyLive = () => LIVE[pick(LIVE.length)];
  const named = anyLive();
  const items = [
    own(1, LIVE[0]), own(2, LIVE[1]), own(3, LIVE[2]), own(4, LIVE[3], [{ runId: LIVE[3], startedAt: AT, status: "executing" }, ...old(18)]),
    row(5, { templateId: PIN.templateId, runId: "settled-s", runStatus: "completed", runHistory: [{ runId: "settled-h", startedAt: AT, status: "completed" }, { runId: "settled-s", startedAt: AT, status: "completed" }] }),
    own(6, "missing-1"),
    row(7, { detail: anyLive() }),
    row(8, { runId: "plain-8", runStatus: "completed", runSessionId: "run-e", runHistory: [{ ...old(1, 40)[0], outputPreview: "unread-1" }, ...old(19)] }),
    row(9, { runId: "plain-9", runStatus: "completed", runHistory: [{ ...old(1, 50)[0], outputPreview: pick(2) === 0 ? anyLive() : "unread-2" }, ...old(18)] }),
    row(10, { title: "unread-4", detail: "unread-2" }),
    { id: 11, title: 0, note: "unread-3" },
    row(12, { runId: named, runStatus: "completed", runHistory: [{ runId: named, startedAt: AT, status: "completed" }] }),
    row(14, { runId: "run-orphan", runStatus: "completed", runHistory: [{ runId: "run-orphan", startedAt: AT, status: "completed" }] }),
    own(15, LIVE[4]), own(16, LIVE[5]), own(17, LIVE[6]),
  ];
  const extra = { ...(pick(2) === 0 ? { note: anyLive() } : {}), ...(pick(2) === 0 ? { archive: [row(100, { runId: "unread-3" })] } : {}) };
  writeFileSync(join(dir, "board.json"), JSON.stringify({ version: 1, nextId: 18, ...extra, items }));
  writeFileSync(join(dir, "workflow-runs.json"), JSON.stringify({ version: 1, rowIdFloor: 17, runs: [
    ...LIVE.map((runId, n) => live(runId, n < 4 ? n + 1 : n + 11)), live("run-orphan", 13), live("run-e", 13), ended("settled-s", 5), ended("settled-h", 5), ended("settled-x", 13),
    { runId: "unread-1", itemId: 8 }, { runId: "unread-2", itemId: 10 }, { runId: "unread-3", itemId: 11 }, { runId: "unread-4", itemId: 10 },
  ] }));
}

interface Raw { id: number; title: string; templateId?: string; runId?: string; runStatus?: string; detail?: string; output?: string; runSessionId?: string }
const isRow = (entry: unknown): entry is Raw =>
  typeof entry === "object" && entry !== null && !Array.isArray(entry) && typeof (entry as Raw).id === "number" && typeof (entry as Raw).title === "string";
const parsed = (bytes: Buffer): Record<string, unknown> => JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
interface Stored { itemId: number; readable: boolean }
// Every run file entry that is not settled, by run id: a run, or an entry that does not read as one and so could be.
function liveIn(runs: Buffer): Map<string, Stored> {
  const stored = new Map<string, Stored>();
  for (const entry of parsed(runs).runs as Record<string, unknown>[]) {
    if (typeof entry?.runId === "string" && !("settled" in entry)) stored.set(entry.runId, { itemId: entry.itemId as number, readable: "pin" in entry });
  }
  return stored;
}
interface Intent { itemId: number; runId: string }
const key = ({ itemId, runId }: Intent): string => `${itemId}|${runId}`;
const intentsIn = (runs: Buffer): string[] => ((parsed(runs).deleteIntents ?? []) as Intent[]).map(key);
// The intents still open, by the test's own reading: an entry of exactly a row id and a run id whose run the run file holds once,
// readable and not settled, as of that row.
function openIntents(runs: Buffer): Intent[] {
  const file = parsed(runs);
  const records = (file.runs as unknown[]).filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry));
  return ((file.deleteIntents ?? []) as unknown[]).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || Object.keys(entry).length !== 2) return [];
    const { itemId, runId } = entry as Record<string, unknown>;
    const run = records.filter(record => record.runId === runId);
    const open = typeof runId === "string" && Number.isSafeInteger(itemId) && (itemId as number) >= 1 && run.length === 1 && "pin" in run[0] && !("settled" in run[0]) && run[0].itemId === itemId;
    return open ? [{ itemId: itemId as number, runId: runId as string }] : [];
  });
}
// What may end from its intent: an open intent whose run id the board file holds as no string value; `due`, those whose row id no entry
// of its items list has, valid or not, too. `plain`: the store reads the same string values in the file.
function intentModel(board: Buffer, runs: Buffer, named: ReadonlySet<string>): { allowed: string[]; due: Intent[]; plain: boolean } {
  const text = board.toString("utf8");
  const blob = text.includes(BLOB);
  const { values, plain } = stringsOf(text, named);
  const rowIds = new Set((parsed(board).items as unknown[]).flatMap((entry) => {
    const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
    return typeof id === "number" && Number.isSafeInteger(id) && id >= 1 ? [id] : [];
  }));
  const allowed = openIntents(runs).filter(intent => !blob && !values.has(intent.runId));
  return { allowed: allowed.map(key), due: allowed.filter(intent => !rowIds.has(intent.itemId)), plain: plain || blob };
}
class Injected extends Error {
  readonly when: "before" | "after";
  constructor(when: "before" | "after") {
    super(`the board write failed ${when} it replaced the file`);
    this.when = when;
  }
}

/** What an op did, for the oracle: the row it edited or deleted (with the run that row named, and when its write was made to fail), or the
 * runs it settled, discarded, started or ended as their delete was due. */
interface Effect {
  kind: "none" | "edit" | "remove" | "settle" | "discard" | "begin" | "consume"; id?: number; runId?: string; result?: { status: string; runId?: string };
  when?: "before" | "after"; fired?: "before" | "after"; ended?: string[];
}
interface Step {
  store: WorkBoardStore; path: string; pick: (count: number) => number; n: number; rows: Raw[]; items: unknown[]; runs: unknown[]; live: Map<string, Stored>;
  attempts: Set<string>; named: Set<string>; due: Intent[]; inject: { when?: "before" | "after" }; eff: Effect;
}
const token = (s: Step): string => one(s.pick, [...s.live.keys(), "settled-s"]) ?? "settled-s";
// The row a text edit goes to: one whose own text holds a stored id, one naming a live run, or any.
function editTarget(s: Step): Raw | undefined {
  const draw = s.pick(3);
  const text = s.rows.filter(r => [...s.live.keys()].some(runId => holds(JSON.stringify([r.title, r.detail ?? ""]), runId)));
  const naming = s.rows.filter(r => r.runId !== undefined && s.live.has(r.runId));
  return one(s.pick, draw === 0 ? text : draw === 1 ? naming : []) ?? one(s.pick, s.rows);
}

const STORE_OPS: Record<string, (s: Step) => Promise<unknown>> = {
  create: s => s.store.create(s.pick(2) === 0 ? { title: "new" } : { title: "new", templateId: PIN.templateId }),
  rename: async s => {
    const target = editTarget(s);
    if (!target) return;
    s.eff = { kind: "edit", id: target.id };
    return s.store.update(target.id, { title: s.pick(2) === 0 ? "renamed" : token(s) });
  },
  detail: async s => {
    const target = editTarget(s);
    if (!target) return;
    s.eff = { kind: "edit", id: target.id };
    return s.store.update(target.id, { detail: one(s.pick, [token(s), "done", OVERFLOW, null]) });
  },
  transition: async s => { const target = one(s.pick, s.rows); return target && s.store.transition(target.id, s.pick(2) === 0 ? "planned" : "in_progress"); },
  completeReopen: async s => {
    const target = one(s.pick, s.rows);
    if (target) { await s.store.complete(target.id); await s.store.reopen(target.id); }
  },
  beginPlain: async s => {
    const plain = s.rows.filter(r => r.templateId === undefined);
    const target = (s.pick(2) === 0 ? one(s.pick, plain.filter(r => r.id === 8 || r.id === 9)) : undefined) ?? one(s.pick, plain);
    return target && s.store.beginRun(target.id, `plain-${s.n}`, AT);
  },
  beginTemplate: async s => {
    const template = s.rows.filter(r => r.templateId === PIN.templateId);
    const target = (s.pick(2) === 0 ? template.find(r => r.id === 4) : undefined) ?? one(s.pick, template);
    if (!target) return;
    const runId = one(s.pick, [`run-${s.n}`, `run.${s.n} x`, `실행:${s.n}`, `run"${s.n}`, `run\\${s.n}`, `😀-${s.n}`]) ?? `run-${s.n}`;
    s.named.add(runId);
    s.eff = { kind: "begin", runId };
    return s.store.beginRun(target.id, runId, AT, start());
  },
  settle: async s => {
    const runId = one(s.pick, [...s.live].filter(([, run]) => run.readable).map(([id]) => id));
    if (runId === undefined) return;
    s.eff = { kind: "settle", runId };
    s.eff.result = await s.store.runs.update(runId, run => ({ ...run, settled: { status: "cancelled", at: AT } }));
  },
  // To a row naming a live run, one whose detail is past the escape cap, or any.
  remove: async s => {
    const draw = s.pick(3);
    const naming = s.rows.filter(r => r.runId !== undefined && s.live.has(r.runId));
    const target = one(s.pick, draw === 0 ? naming : draw === 1 ? s.rows.filter(r => r.detail === OVERFLOW) : []) ?? one(s.pick, s.rows);
    if (!target) return;
    s.eff = { kind: "remove", id: target.id, runId: target.runId };
    if (target.runId !== undefined) s.attempts.add(`${target.id}|${target.runId}`);
    s.eff.result = await s.store.remove(target.id);
  },
  // A delete of a row naming its own live run, whose board write fails before or after it replaces the file.
  failRemove: async s => {
    const target = one(s.pick, s.rows.filter(r => r.runId !== undefined && s.live.get(r.runId)?.readable === true && s.live.get(r.runId)?.itemId === r.id));
    if (target?.runId === undefined) return;
    const when = s.pick(2) === 0 ? "before" : "after";
    s.eff = { kind: "remove", id: target.id, runId: target.runId, when };
    s.attempts.add(`${target.id}|${target.runId}`);
    s.inject.when = when;
    try { s.eff.result = await s.store.remove(target.id); }
    catch (error) {
      if (!(error instanceof Injected)) throw error;
      s.eff.fired = error.when;
    } finally { s.inject.when = undefined; }
  },
  // The engine ends each run the model finds due, as its row removed.
  consume: async s => {
    if (s.due.length === 0) return;
    s.eff = { kind: "consume", ended: [] };
    for (const { runId } of s.due) {
      const result = await s.store.runs.update(runId, run => ({ ...run, settled: { status: "cancelled", at: AT } }));
      if (result.status === "stored") s.eff.ended?.push(runId);
    }
  },
  removeUnreadable: async s => {
    const invalid = s.items.filter(entry => !isRow(entry));
    const position = invalid.length === 0 ? undefined : s.pick(invalid.length);
    return position === undefined ? undefined : s.store.removeUnreadable({ position, hash: sha(JSON.stringify(invalid[position])) }, () => true);
  },
  discardRun: async s => {
    const position = one(s.pick, s.runs.flatMap((entry, at) => typeof entry === "object" && entry !== null && !("pin" in entry) ? [at] : []));
    if (position === undefined) return;
    const entry = s.runs[position] as { runId: string };
    s.eff = { kind: "discard", runId: entry.runId };
    s.eff.result = await s.store.discardUnreadableRun({ position, hash: sha(JSON.stringify(entry)) }, () => true);
  },
  prune: s => s.store.pruneSettledRuns(),
  reconcile: s => s.store.reconcileInterruptedRuns(),
  // The engine's own fields, to a row holding one already or any plain row.
  runResult: async s => {
    const plain = s.rows.filter(r => r.templateId === undefined);
    const target = one(s.pick, s.pick(2) === 0 ? plain.filter(r => r.output !== undefined) : []) ?? one(s.pick, plain);
    return target && s.store.setRunResult(target.id, { runStatus: "completed", plan: null, output: one(s.pick, [token(s), "done", null]) ?? null });
  },
  session: async s => {
    const plain = s.rows.filter(r => r.templateId === undefined);
    const target = one(s.pick, s.pick(2) === 0 ? plain.filter(r => r.runSessionId !== undefined) : []) ?? one(s.pick, plain);
    return target && s.store.setRunSessionId(target.id, s.pick(2) === 0 ? token(s) : `session-${s.n}`);
  },
  plan: async s => {
    const target = one(s.pick, s.rows.filter(r => r.templateId === undefined && r.runStatus === "planning"));
    if (target?.runId === undefined) return;
    const { runId } = target;
    const asked = await s.store.setPlanAwaitingApproval(target.id, { runId, plan: "plan", runSessionId: "session-1", revision: 1, itemDigest: "d" });
    const planHash = asked?.status === "updated" ? asked.item.planApproval?.planHash : undefined;
    if (planHash !== undefined) await s.store.decidePlan(target.id, { runId, planHash, status: "rejected" });
  },
  clearMissing: async s => {
    const target = s.rows.find(r => r.runId === "missing-1");
    const shown = target && await s.store.get(target.id);
    const revision = shown?.status === "found" ? shown.item.mutationRevision : undefined;
    if (target && revision !== undefined) return s.store.clearMissingRun(target.id, revision, "missing-1");
  },
  reopen: async s => {
    s.store = new WorkBoardStore(s.path, () => Date.parse(AT));
    await s.store.load();
  },
};
const WEIGHTS: [string, number][] = [
  ["create", 1], ["rename", 2], ["detail", 4], ["transition", 1], ["completeReopen", 1], ["beginPlain", 2], ["beginTemplate", 3], ["settle", 2],
  ["remove", 4], ["removeUnreadable", 2], ["discardRun", 1], ["prune", 1], ["reconcile", 1], ["runResult", 1], ["plan", 1], ["clearMissing", 1],
  ["reopen", 2], ["token", 2], ["invalid", 1], ["blob", 2], ["dup", 3], ["failRemove", 2], ["consume", 2], ["session", 2], ["plant", 1],
];
const DRAW = WEIGHTS.flatMap(([name, weight]) => Array<string>(weight).fill(name));
const SEEDS = 32;
const STEPS = 40;

// A hand edit, written compact as no store write writes a file: an id under a new top-level key (spelled as is, its first character
// escaped, or every character past ASCII escaped), an invalid entry holding one, the overflow blob out, or in under a new key or in the
// detail of a row naming a live run, a key given twice in either file, fixed by hand a few steps later, or the delete intent of a live
// run, as a crash after it was stored leaves it.
function handEdit(name: string, step: number, pick: (count: number) => number, files: { board: string; runs: string }, dup: { board?: number; runs?: number }, attempts: Set<string>): string | undefined {
  if (name === "dup") {
    const file = pick(3) === 0 ? "board" : "runs";
    if (dup[file] !== undefined) return undefined;
    const text = readFileSync(files[file], "utf8");
    writeFileSync(files[file], `${pick(2) === 0 ? '{"version":1,' : file === "board" ? '{"items":[],' : '{"runs":[],'}${text.slice(1)}`);
    dup[file] = step + 2 + pick(4);
    return file;
  }
  if (name === "plant") {
    if (dup.runs !== undefined) return undefined;
    const runs = parsed(readFileSync(files.runs));
    const chosen = one(pick, [...liveIn(readFileSync(files.runs))].filter(([, run]) => run.readable));
    const intents = (runs.deleteIntents ?? []) as Intent[];
    if (!chosen || intents.some(intent => key(intent) === `${chosen[1].itemId}|${chosen[0]}`)) return undefined;
    runs.deleteIntents = [...intents, { itemId: chosen[1].itemId, runId: chosen[0] }];
    writeFileSync(files.runs, JSON.stringify(runs));
    attempts.add(`${chosen[1].itemId}|${chosen[0]}`);
    return "runs";
  }
  if (dup.board !== undefined) return undefined;
  const board = parsed(readFileSync(files.board));
  const stored = liveIn(readFileSync(files.runs));
  const value = one(pick, [...stored.keys(), "settled-s"]) ?? "settled-s";
  const mark = `@mark-${step}@`;
  const rows = (board.items as unknown[]).filter(isRow);
  const carrying = rows.filter(r => r.detail === OVERFLOW);
  const naming = one(pick, rows.filter(r => r.runId !== undefined && stored.has(r.runId)));
  if (name === "token") board[`t${step}`] = mark;
  else if (name === "invalid") (board.items as unknown[]).push(one(pick, [{ id: 1000 + step, title: 0, note: value }, JSON.stringify(row(1000 + step, { runId: value })), [row(1000 + step, { detail: value })]]));
  else if ("deep" in board || carrying.length > 0) {
    delete board.deep;
    for (const carrier of carrying) delete carrier.detail;
  } else if (naming && pick(3) > 0) naming.detail = OVERFLOW;
  else board.deep = OVERFLOW;
  const quoted = JSON.stringify(value).slice(1, -1);
  const coded = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  const spelled = one(pick, [quoted, `${coded(value)}${quoted.slice(1)}`, quoted.replace(/[^\x20-\x7e]/g, coded)]) ?? quoted;
  writeFileSync(files.board, JSON.stringify(board).replace(`"${mark}"`, () => `"${spelled}"`));
  return "board";
}

async function sequence(seed: number, tally: (key: string) => void): Promise<void> {
  const pick = prng(seed);
  const dir = mkdtempSync(join(tmpdir(), "ave-wb-sequence-"));
  const files = { board: join(dir, "board.json"), runs: join(dir, "workflow-runs.json") };
  // Each board write as it is made: a stored run's id the model holds and the write takes out has its intent on disk already. A delete's
  // write may be made to fail before or after it replaces the file.
  const inject: { when?: "before" | "after" } = {};
  const unordered: string[] = [];
  const write = namespace.writeFileAtomicAtPath;
  vi.spyOn(namespace, "writeFileAtomicAtPath").mockImplementation(async (target, body) => {
    if (target === files.board) {
      const prior = heldBy(readFileSync(target, "utf8"));
      const next = heldBy(typeof body === "string" ? body : Buffer.from(body).toString("utf8"));
      const runs = readFileSync(files.runs);
      const intents = intentsIn(runs);
      for (const [runId, { itemId }] of liveIn(runs)) {
        if (!prior(runId) || next(runId)) continue;
        if (intents.includes(`${itemId}|${runId}`)) tally("ordered");
        else unordered.push(runId);
      }
      const { when } = inject;
      inject.when = undefined;
      if (when === "after") await write(target, body);
      if (when !== undefined) throw new Injected(when);
    }
    return write(target, body);
  });
  try {
    seedHome(dir, pick);
    let store = new WorkBoardStore(files.board, () => Date.parse(AT));
    await store.load();
    const attempts = new Set<string>();
    const named = new Set<string>(LIVE);
    const hand = { board: true, runs: true };
    const dup: { board?: number; runs?: number } = {};
    const trace: string[] = [];
    // Set once the run file reads again after a write was refused while it could not: the next board write lands with no restart.
    let refusedUnreadable = false;
    let recovering = false;
    for (let step = 0; step < STEPS; step += 1) {
      const due = (["board", "runs"] as const).find(file => (dup[file] ?? Number.POSITIVE_INFINITY) <= step);
      // While the run file cannot be read, the engine writes its own fields half the time.
      const name = due ? `fix-${due}` : (dup.runs !== undefined && pick(2) === 0 ? one(pick, ["runResult", "session"]) : undefined) ?? DRAW[pick(DRAW.length)];
      trace.push(name);
      const context = `seed ${seed}, step ${step}: ${trace.slice(-8).join(" > ")}`;
      if (due) {
        writeFileSync(files[due], JSON.stringify(parsed(readFileSync(files[due]))));
        dup[due] = undefined;
        hand[due] = true;
        if (due === "runs") [recovering, refusedUnreadable] = [refusedUnreadable, false];
        continue;
      }
      if (!(name in STORE_OPS)) {
        const edited = handEdit(name, step, pick, files, dup, attempts);
        if (edited) hand[edited as "board" | "runs"] = true;
        continue;
      }
      const bB = readFileSync(files.board);
      const rB = readFileSync(files.runs);
      const stored = liveIn(rB);
      const items = parsed(bB).items as unknown[];
      const ahead = intentModel(bB, rB, named);
      const s: Step = {
        store, path: files.board, pick, n: step, rows: items.filter(isRow), items, runs: parsed(rB).runs as unknown[], live: stored, attempts, named,
        due: dup.runs === undefined && ahead.plain ? ahead.due : [], inject, eff: { kind: "none" },
      };
      let refusal: string | undefined;
      try { await STORE_OPS[name](s); }
      catch (error) {
        if (!(error instanceof WorkBoardWriteRefusal)) throw new Error(`${context}: ${(error as Error).stack}`);
        refusal = error.code;
        tally(`refused:${refusal}`);
      }
      store = s.store;
      const { eff } = s;
      const bA = readFileSync(files.board);
      const rA = readFileSync(files.runs);
      const storedAfter = liveIn(rA);
      const before = bB.toString("utf8");
      const after = bA.toString("utf8");
      const heldBefore = heldBy(before);
      const heldAfter = heldBy(after);
      if (!bA.equals(bB) || !rA.equals(rB)) tally(`wrote:${name}`);
      if (before.includes(BLOB)) tally("blob-step");
      expect(unordered.splice(0), `${context}: ids taken out of board.json before their delete intents were stored`).toEqual([]);
      const removed = eff.kind === "remove" ? s.rows.find(r => r.id === eff.id) : undefined;
      if (refusal === "work-board-run-id-held") {
        if (name.startsWith("begin")) tally("cap-held");
        if (name === "removeUnreadable") tally("invalid-delete-held");
        if (removed?.detail === OVERFLOW) tally("capped-delete-held");
        if (removed?.runId !== undefined && stored.has(removed.runId) && stored.get(removed.runId)?.itemId !== removed.id) tally("cross-row-delete-held");
      }
      const edited = eff.kind === "edit" ? s.rows.find(r => r.id === eff.id) : undefined;
      if (refusal === "work-board-runs-unreadable" && edited && [...stored.keys()].some(runId => holds(JSON.stringify(edited), runId))) tally("edit-held-unreadable");
      if (name === "runResult" || name === "session") {
        if (refusal === "work-board-runs-unreadable") tally("engine-refused-unreadable");
        if (refusal === "work-board-run-id-held") tally("engine-held");
      }
      // While the run file cannot be read, any string value could be a run's id: no write takes one out of board.json.
      if (dup.runs !== undefined && !bA.equals(bB)) {
        const kept = heldBy(after);
        const lost = [...stringsOf(before).values].filter(value => value.length > 0 && value.length <= 256 && !kept(value));
        expect(lost, `${context}: string values taken out of board.json while the run file could not be read`).toEqual([]);
        tally("unreadable-write");
      }
      if (refusal === "work-board-runs-unreadable") refusedUnreadable = true;
      if (name === "reopen") recovering = false;
      else if (recovering && refusal === undefined && !bA.equals(bB)) {
        tally("recovered");
        recovering = false;
      }

      // A run that is not settled leaves the run file only as the engine settles it, ends it as its delete is due, or its entry is
      // discarded, and comes in only as it starts.
      for (const runId of stored.keys()) {
        if (storedAfter.has(runId)) continue;
        const ends = eff.ended?.includes(runId) === true || (eff.runId === runId
          && ((eff.kind === "settle" && eff.result?.status === "stored") || (eff.kind === "discard" && eff.result?.status === "deleted")));
        expect(ends, `${context}: ${runId} left the run file`).toBe(true);
      }
      for (const runId of storedAfter.keys()) expect(stored.has(runId) || (eff.kind === "begin" && eff.runId === runId), `${context}: ${runId} came into the run file`).toBe(true);

      // No stored run that is not settled has its id taken out of board.json, but by the user's delete of the row its record names,
      // with that delete's intent stored, over text holding no blob; never two in one write. A delete whose write failed counts as one
      // once that write replaced the file.
      const intents = intentsIn(rA);
      const left = [...stored.keys()].filter(runId => heldBefore(runId) && !heldAfter(runId));
      for (const runId of left) {
        const record = stored.get(runId);
        const deleted = (eff.result?.status === "deleted" && eff.result.runId === runId) || eff.fired === "after";
        const released = eff.kind === "remove" && deleted && eff.runId === runId
          && record?.readable === true && record.itemId === eff.id && !before.includes(BLOB) && intents.includes(`${eff.id}|${runId}`);
        expect(released, `${context}: ${runId} left board.json`).toBe(true);
        tally("released");
        const kind = odd(runId);
        if (kind) tally(`released:${kind}`);
      }
      expect(left.length, `${context}: more than one run left board.json`).toBeLessThanOrEqual(1);
      for (const intent of intents) expect(attempts.has(intent), `${context}: intent ${intent} no delete stored`).toBe(true);

      // A delete whose write fails before it replaces the file leaves the board as it was and takes its intent back; one that fails after
      // keeps its intent, and the store shows the row gone.
      if (eff.fired !== undefined) {
        const intent = `${eff.id}|${eff.runId}`;
        if (eff.fired === "before") {
          expect(bA.equals(bB) && !intents.includes(intent), `${context}: a delete that did not land kept its intent or changed the board`).toBe(true);
          tally("withdrawn");
        } else {
          const shown = await store.get(eff.id ?? 0);
          const listed = (parsed(bA).items as unknown[]).filter(isRow).some(r => r.id === eff.id);
          expect([listed, intents.includes(intent), shown.status], `${context}: a delete that landed and failed`).toEqual([false, true, "not_found"]);
          tally("landed-failed");
        }
      }
      // A run the engine ends as its delete is due takes its intent with it.
      for (const runId of eff.ended ?? []) {
        expect(intents.some(intent => intent.endsWith(`|${runId}`)), `${context}: ${runId} ended, its intent stayed`).toBe(false);
        tally("consumed");
      }

      // A file holding a key twice is never written over or copied; bytes the store did not write are copied before a write goes over them.
      for (const [file, prior, next, tag] of [["board", bB, bA, "invalid-rows"], ["runs", rB, rA, "invalid-runs"]] as const) {
        const copy = `${files[file]}.${tag}-${sha(prior)}.bak`;
        if (dup[file] !== undefined) {
          expect(next.equals(prior) && !existsSync(copy), `${context}: ${file} holding a key twice was written`).toBe(true);
          tally(`dup-${file}-step`);
        }
        if (next.equals(prior)) continue;
        if (hand[file]) {
          expect(existsSync(copy) && readFileSync(copy).equals(prior), `${context}: the ${file} bytes were not kept`).toBe(true);
          tally(`kept:${file}`);
        }
        hand[file] = false;
      }

      // The engine's view: the runs to end, never one whose id the board file holds, and exactly the model's while the store reads the
      // file's string values as the model does; each run's row standing wherever its id is, and not standing once its delete is due.
      const model = intentModel(bA, rA, named);
      if (dup.runs === undefined) {
        const deleted = await store.deletedRuns();
        expect(Array.isArray(deleted), `${context}: deleted runs ${String(deleted)}`).toBe(true);
        const got = (deleted as Intent[]).map(key).sort();
        expect(got.filter(intent => !model.allowed.includes(intent)), `${context}: a run to end whose id board.json holds`).toEqual([]);
        if (model.plain) expect(got, `${context}: deleted runs`).toEqual(model.due.map(key).sort());
        for (const { runId } of deleted as Intent[]) {
          tally("deleted-runs");
          const kind = odd(runId);
          if (kind) tally(`due:${kind}`);
        }
      }
      const standing = await store.runRowsOnDisk();
      for (const [runId, { itemId }] of storedAfter) {
        const where = standing?.({ itemId, runId });
        if (heldAfter(runId)) expect(["named", "moved", "unreadable"], `${context}: ${runId} held, reads ${where}`).toContain(where);
        if (model.due.some(intent => intent.runId === runId)) expect(["named", "moved"], `${context}: ${runId} deleted, reads ${where}`).not.toContain(where);
        tally("standing");
      }
    }
  } finally {
    vi.restoreAllMocks();
    await cleanupTmpDir(dir);
  }
}

it("no op sequence has a store write take out of board.json the id of a stored run that is not settled without its row's delete and intent stored first, end a run whose id the file holds, or write over bytes it did not write or a key given twice", async () => {
  const counts: Record<string, number> = {};
  for (let seed = 1; seed <= SEEDS; seed += 1) await sequence(seed, key => { counts[key] = (counts[key] ?? 0) + 1; });
  // Every store op wrote, and the draw reached every state the oracle judges.
  expect(Object.keys(STORE_OPS).filter(name => !counts[`wrote:${name}`])).toEqual([]);
  const reached = ["released", "refused:work-board-run-id-held", "refused:work-board-runs-unreadable", "refused:work-board-duplicate-key", "refused:workflow-runs-duplicate-key",
    "edit-held-unreadable", "cap-held", "invalid-delete-held", "capped-delete-held", "cross-row-delete-held", "blob-step", "kept:board", "kept:runs",
    "dup-board-step", "dup-runs-step", "deleted-runs", "standing", "ordered", "withdrawn", "landed-failed", "consumed", "engine-refused-unreadable",
    "engine-held", "recovered", "unreadable-write", ...["quote", "backslash", "surrogate"].flatMap(kind => [`released:${kind}`, `due:${kind}`])];
  expect(reached.filter(key => !counts[key]), JSON.stringify(counts)).toEqual([]);
}, 240_000);

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
    // As a string in decoded text that is not JSON too, for an id that holds neither a quote nor a backslash.
    const loose = /["\\]/.test(runId) ? [] : [{ archive: `x "${runId}" y` }];
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

  it.each(["items", ":", "version", "{", "run-k", "x"])("does not hold %j as a key or as text outside strings", async (runId) => {
    const text = JSON.stringify({ version: 1, nextId: 51, archive: { "run-k": [1, true, null] }, note: nested({ x: 1 }, 2), items: [row(2)] });
    const { dir, path, store } = await home(text, [live(runId)]);
    try {
      expect((await store.runRowsOnDisk())?.(live(runId))).toBe("gone");
      writeFileSync(path, text.replace("\"note\"", `"keep":${JSON.stringify(runId)},"note"`));
      expect((await store.runRowsOnDisk())?.(live(runId))).toBe("unreadable");
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

    it("refuses an engine write that takes out a string value, writes one that takes out none, and judges the next write as usual once the file reads", async () => {
      const { dir, path, store } = await home(`${JSON.stringify({ version: 1, nextId: 51, items: [row(2)] }, null, 2)}\n`, [live("run-a")]);
      try {
        expect(await store.setRunResult(2, { runStatus: "completed", output: "run-a" })).toMatchObject({ status: "updated" });
        const before = readFileSync(path, "utf8");
        const read = homeTrust.readAveHomeInput;
        const reading = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(target => target === join(dir, "workflow-runs.json") ? input() : read(target));
        await expect(store.setRunResult(2, { runStatus: "completed", output: null })).rejects.toMatchObject({ code });
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(await store.setRunSessionId(2, "session-b")).toMatchObject({ status: "updated" });
        await expect(store.setRunSessionId(2, "session-c")).rejects.toMatchObject({ code });
        expect(readFileSync(path, "utf8")).toContain("session-b");
        reading.mockRestore();
        expect(await store.setRunSessionId(2, "session-c")).toMatchObject({ status: "updated" });
        await expect(store.setRunResult(2, { runStatus: "completed", output: null })).rejects.toMatchObject({ code: "work-board-run-id-held" });
        expect(readFileSync(path, "utf8")).toContain("\"run-a\"");
      } finally {
        vi.restoreAllMocks();
        await cleanupTmpDir(dir);
      }
    });
  });

  it("names workflow-runs.json in the notice a write refused while the run file cannot be read shows, in English and Korean", () => {
    for (const catalog of [en, ko]) expect(catalog["reasonCodes.work-board-runs-unreadable"]).toContain("workflow-runs.json");
  });
});

describe("a delete intent", () => {
  const naming = row(40, { templateId: PIN.templateId, runId: "run-a", runStatus: "executing" });
  const intents = (dir: string): unknown => (JSON.parse(readFileSync(join(dir, "workflow-runs.json"), "utf8")) as { deleteIntents?: unknown }).deleteIntents ?? [];

  it("is taken back when the guard refuses its delete: after a reload the run is there unsettled and no intent is", async () => {
    const { dir, path, store } = await home(JSON.stringify({ version: 1, nextId: 51, items: [{ ...naming, detail: OVERFLOW }] }), [live("run-a")]);
    try {
      const before = readFileSync(path, "utf8");
      await expect(store.remove(40)).rejects.toMatchObject({ code: "work-board-run-id-held" });
      expect(readFileSync(path, "utf8")).toBe(before);
      const reopened = new WorkBoardStore(path);
      await reopened.load();
      expect(await reopened.runs.deleteIntents()).toEqual([]);
      expect(await reopened.runs.get("run-a")).toEqual({ status: "found", run: live("run-a") });
    } finally { await cleanupTmpDir(dir); }
  });

  it.each([["before", false], ["after", true]] as const)("of a delete whose board write fails %s it replaces the file is taken back only while the file still lists the row", async (_, lands) => {
    const { dir, path, store } = await home(JSON.stringify({ version: 1, nextId: 51, items: [naming] }), [live("run-a")]);
    const write = namespace.writeFileAtomicAtPath;
    vi.spyOn(namespace, "writeFileAtomicAtPath").mockImplementation(async (target, body) => {
      if (target !== path) return write(target, body);
      if (lands) await write(target, body);
      throw new Error("board write failed");
    });
    const told: unknown[] = [];
    store.rowDeleted.subscribe(change => told.push(change));
    try {
      await expect(store.remove(40)).rejects.toThrow("board write failed");
      expect(readFileSync(path, "utf8").includes("run-a")).toBe(!lands);
      expect(intents(dir)).toEqual(lands ? [{ itemId: 40, runId: "run-a" }] : []);
      expect(told).toEqual(lands ? [{ itemId: 40, runId: "run-a" }] : []);
    } finally {
      vi.restoreAllMocks();
      await cleanupTmpDir(dir);
    }
  });

  it.each<[string, (items: unknown[]) => Record<string, unknown>]>([
    ["its row that does not validate", items => ({ items: [{ ...naming, title: 0 }, ...items] })],
    ["its row and a twin", items => ({ items: [naming, { ...naming }, ...items] })],
    ["its run id under another key", items => ({ archive: { value: "run-a" }, items })],
    ["its row kept as a string", items => ({ items: [JSON.stringify(naming), ...items] })],
  ])("stored before a crash is not due while the board file holds %s; once it holds none, it is", async (_, held) => {
    const { dir, path, store } = await home(JSON.stringify({ version: 1, nextId: 51, items: [naming] }), [live("run-a")]);
    try {
      expect(await store.runs.markDeleted({ itemId: 40, runId: "run-a" })).toBe("marked");
      writeFileSync(path, JSON.stringify({ version: 1, nextId: 51, ...held([row(41)]) }));
      expect(await store.deletedRuns()).toEqual([]);
      writeFileSync(path, JSON.stringify({ version: 1, nextId: 51, items: [row(41), { id: 40, title: 5 }, null] }));
      expect(await store.deletedRuns()).toEqual([]);
      writeFileSync(path, JSON.stringify({ version: 1, nextId: 51, items: [row(41), { id: 39, title: 5 }, null] }));
      expect(await store.deletedRuns()).toEqual([{ itemId: 40, runId: "run-a" }]);
    } finally { await cleanupTmpDir(dir); }
  });
});

it.each([["before", false], ["after", true]] as const)("a board write that fails %s it replaces the file shows the board on disk and tells listeners only once it landed", async (_, lands) => {
  const { dir, path, store } = await home(JSON.stringify({ version: 1, nextId: 51, items: [row(2)] }), []);
  const write = namespace.writeFileAtomicAtPath;
  vi.spyOn(namespace, "writeFileAtomicAtPath").mockImplementation(async (target, body) => {
    if (target !== path) return write(target, body);
    if (lands) await write(target, body);
    throw new Error("directory sync failed");
  });
  let changed = 0;
  store.boardChanged.subscribe(() => { changed += 1; });
  try {
    await expect(store.update(2, { title: "renamed" })).rejects.toThrow("directory sync failed");
    const shown = await store.get(2);
    expect([shown.status === "found" ? shown.item.title : undefined, changed]).toEqual(lands ? ["renamed", 1] : ["row 2", 0]);
  } finally {
    vi.restoreAllMocks();
    await cleanupTmpDir(dir);
  }
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

  it.each([["board.json", "invalid-rows"], ["workflow-runs.json", "invalid-runs"]] as const)("%s is not written over while the copy there is a second name of a file holding its bytes, its own or another", async (name, tag) => {
    const dir = mkdtempSync(join(tmpdir(), "ave-kept-copy-"));
    try {
      const path = join(dir, name);
      const copy = `${path}.${tag}-${sha(before)}.bak`;
      const write = () => rewriteKeepingBytes(path, '{"keep":2}\n', { tag });
      writeFileSync(path, before);
      writeFileSync(join(dir, "elsewhere.json"), before);
      for (const target of [path, join(dir, "elsewhere.json")]) {
        linkSync(target, copy);
        await expect(write()).rejects.toMatchObject({ code: "work-board-backup-conflict", path: copy });
        expect(readFileSync(path)).toEqual(before);
        rmSync(copy);
      }
      await write();
      expect([readFileSync(path, "utf8"), readFileSync(copy)]).toEqual(['{"keep":2}\n', before]);
    } finally { await cleanupTmpDir(dir); }
  });

  it.skipIf(process.platform === "win32")("is not written over while the copy there is a symbolic link to a file holding its bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-kept-copy-"));
    try {
      const path = join(dir, "board.json");
      const copy = `${path}.invalid-rows-${sha(before)}.bak`;
      writeFileSync(path, before);
      writeFileSync(join(dir, "elsewhere.json"), before);
      for (const target of [path, join(dir, "elsewhere.json")]) {
        symlinkSync(target, copy);
        await expect(rewriteKeepingBytes(path, '{"keep":2}\n', { tag: "invalid-rows" })).rejects.toMatchObject({ code: "work-board-backup-conflict", path: copy });
        expect(readFileSync(path)).toEqual(before);
        rmSync(copy);
      }
    } finally { await cleanupTmpDir(dir); }
  });

  it.each<[string, (write: typeof namespace.writeFileAtomicAtPath, target: string) => Promise<void>]>([
    ["cannot be made", async () => { throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" }); }],
    ["once made does not hold them", async (write, target) => write(target, "other bytes")],
  ])("refuses the write with work-board-backup-failed while the copy %s, and the file stays as it was", async (_, made) => {
    const dir = mkdtempSync(join(tmpdir(), "ave-kept-copy-"));
    try {
      const path = join(dir, "board.json");
      const copy = `${path}.invalid-rows-${sha(before)}.bak`;
      writeFileSync(path, before);
      const write = namespace.writeFileAtomicAtPath;
      const writing = vi.spyOn(namespace, "writeFileAtomicAtPath").mockImplementation(async (target, body) => target === copy ? made(write, target) : write(target, body));
      const refused = rewriteKeepingBytes(path, '{"keep":2}\n', { tag: "invalid-rows" });
      await expect(refused).rejects.toBeInstanceOf(WorkBoardWriteRefusal);
      await expect(refused).rejects.toMatchObject({ code: "work-board-backup-failed", path: copy });
      expect(readFileSync(path)).toEqual(before);
      writing.mockRestore();
      rmSync(copy, { force: true });
      await rewriteKeepingBytes(path, '{"keep":2}\n', { tag: "invalid-rows" });
      expect([readFileSync(path, "utf8"), readFileSync(copy)]).toEqual(['{"keep":2}\n', before]);
    } finally {
      vi.restoreAllMocks();
      await cleanupTmpDir(dir);
    }
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
