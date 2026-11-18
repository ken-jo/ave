import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowRunStore } from "../workflow-run-store.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import * as namespace from "../storage/feature-namespace.js";
import type { WorkflowRunRecord } from "../../shared/workflow-template-types.js";

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "workflow-runs-")); file = join(dir, "workflow-runs.json"); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const pin = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
const run = (patch: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord => ({
  runId: "run-1", itemId: 1, pin, runStartedBy: { kind: "local-create-and-run", pin }, startedAt: "2026-01-01T00:00:00.000Z",
  stageRuns: [{ stageId: "plan", attempt: 1, status: "awaiting_gate", output: "result", resultHash: "a".repeat(64), outputHash: "c".repeat(64), gate: { type: "human", status: "pending", revision: 0 } }],
  ...patch,
});
const stored = async (): Promise<{ version: number; runs: unknown[] }> => JSON.parse(await readFile(file, "utf8"));

it("stores a run by runId and returns copies", async () => {
  const store = new WorkflowRunStore(file);
  expect(await store.get("run-1")).toEqual({ status: "not-found" });
  expect(await store.put(run())).toEqual({ status: "stored", run: run() });
  expect(await stored()).toEqual({ version: 1, rowIdFloor: 1, runs: [run()] });
  const read = await store.get("run-1");
  if (read.status !== "found") throw new Error("Missing run");
  for (const entry of read.run.stageRuns) entry.attempt = 3;
  expect(await store.get("run-1")).toEqual({ status: "found", run: run() });
  expect(await store.put(run({ runId: "run-2", itemId: 2 }))).toMatchObject({ status: "stored" });
  expect((await stored()).runs).toHaveLength(2);
});

it("carries the complete run state through a write", async () => {
  const store = new WorkflowRunStore(file);
  const full = run({
    runStartedBy: { kind: "schedule-attachment", attachmentId: "attachment", pin, firedAt: "2026-01-01T00:00:00.000Z" },
    runWorkspace: { kind: "folder", runRoot: "/runs/example", outputDir: "/runs/example/_out" },
    stageJoins: [{ joinId: "join-a", stageIds: ["plan"], status: "conflict", conflict: { conflictHash: "a".repeat(64), reason: "same-path", files: [{ path: "report.txt", stageIds: ["plan"] }] } }],
  });
  expect(await store.put(full)).toEqual({ status: "stored", run: full });
  expect(await store.get("run-1")).toEqual({ status: "found", run: full });
});

it.each([
  { itemId: 2 },
  { pin: { ...pin, version: 2 }, runStartedBy: { kind: "local-create-and-run" as const, pin: { ...pin, version: 2 } } },
  { runStartedBy: { kind: "schedule-attachment" as const, attachmentId: "attachment", pin, firedAt: "2026-01-01T00:00:00.000Z" } },
])("refuses to rebind a stored run %j", async patch => {
  const store = new WorkflowRunStore(file);
  await store.put(run());
  const before = await readFile(file, "utf8");
  await expect(store.put(run(patch))).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.update("run-1", value => ({ ...value, ...patch }))).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.update("run-1", value => ({ ...value, runId: "run-9" }))).rejects.toMatchObject({ code: "invalid-template-run" });
  expect(await readFile(file, "utf8")).toBe(before);
});

it.each([
  { runStartedBy: { kind: "local-create-and-run", pin: { ...pin, version: 2 } } },
  { runStartedBy: { kind: "schedule-attachment", pin, firedAt: "2026-01-01T00:00:00.000Z" } },
  { pin: { ...pin, graphHash: "bad" } }, { itemId: 0 }, { runId: "" }, { startedAt: "never" }, { templateId: "template-1" },
  { runWorkspace: { kind: "folder" } }, { stageJoins: [{ joinId: "join-a", stageIds: ["other"], status: "integrated" }] },
  ...[{ attempt: 4 }, { status: "future" }, { resultHash: "bad" }, { outputHash: "bad" }, { gate: { type: "human", status: "approved", revision: -1 } }, { output: "x".repeat(48_001) }]
    .map(patch => ({ stageRuns: [{ ...run().stageRuns[0], ...patch }] })),
])("refuses to store a malformed run %j", async patch => {
  const store = new WorkflowRunStore(file);
  await expect(store.put({ ...run(), ...patch } as WorkflowRunRecord)).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("updates under one lock and never calls the mutation for a missing run", async () => {
  const store = new WorkflowRunStore(file);
  await store.put(run());
  const mutate = vi.fn((value: WorkflowRunRecord) => value);
  expect(await store.update("other-run", mutate)).toEqual({ status: "not-found" });
  expect(mutate).not.toHaveBeenCalled();
  const bump = (value: WorkflowRunRecord): WorkflowRunRecord => ({ ...value, stageRuns: value.stageRuns.map(stage => ({ ...stage, attempt: stage.attempt + 1 })) });
  await Promise.all([store.update("run-1", bump), store.update("run-1", bump)]);
  expect(await store.get("run-1")).toMatchObject({ status: "found", run: { stageRuns: [{ attempt: 3 }] } });
  const before = await readFile(file, "utf8");
  expect(await store.update("run-1", () => null)).toEqual({ status: "refused" });
  expect(await readFile(file, "utf8")).toBe(before);
});

it.each([
  ["a malformed stage", { ...run({ runId: "run-bad" }), stageRuns: [{ stageId: "plan", attempt: 4, status: "running" }] }],
  ["an unknown key", { ...run({ runId: "run-bad" }), approvedBy: "user" }],
])("refuses only the entry with %s and keeps its stored value", async (_name, bad) => {
  await writeFile(file, JSON.stringify({ version: 1, runs: [run(), bad, "stray"] }));
  const store = new WorkflowRunStore(file);
  expect(await store.get("run-bad")).toEqual({ status: "invalid" });
  const mutate = vi.fn((value: WorkflowRunRecord) => value);
  expect(await store.update("run-bad", mutate)).toEqual({ status: "invalid" });
  expect(mutate).not.toHaveBeenCalled();
  expect(await store.put(run({ runId: "run-bad" }))).toEqual({ status: "invalid" });
  expect(await store.update("run-1", value => ({ ...value, stageRuns: [] }))).toMatchObject({ status: "stored" });
  expect(await store.put(run({ runId: "run-2", itemId: 2 }))).toMatchObject({ status: "stored" });
  expect((await stored()).runs).toEqual([run({ stageRuns: [] }), bad, "stray", run({ runId: "run-2", itemId: 2 })]);
  expect(await new WorkflowRunStore(file).get("run-bad")).toEqual({ status: "invalid" });
});

it("refuses every entry that shares a runId", async () => {
  await writeFile(file, JSON.stringify({ version: 1, runs: [run(), run({ itemId: 2 })] }));
  const store = new WorkflowRunStore(file);
  expect(await store.get("run-1")).toEqual({ status: "invalid" });
  expect(await store.put(run())).toEqual({ status: "invalid" });
});

it.each(["not json", JSON.stringify({ version: 2, runs: [] }), JSON.stringify({ version: 1, runs: {} }),
  ...[-1, "1", 1.5, null].map(rowIdFloor => JSON.stringify({ version: 1, rowIdFloor, runs: [] }))])("fails clearly on an unreadable run file %j", async bytes => {
  await writeFile(file, bytes);
  const store = new WorkflowRunStore(file);
  await expect(store.get("run-1")).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.put(run())).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.issueRowId(0)).rejects.toMatchObject({ code: "invalid-template-run" });
  await store.raiseRowIdFloor(5).catch(() => undefined);
  expect(await readFile(file, "utf8")).toBe(bytes);
});

it("issues each row id above the floor and above every id seen, stores it, and never lowers the floor", async () => {
  const store = new WorkflowRunStore(file);
  expect(await store.issueRowId(0)).toBe(1);
  expect(await store.issueRowId(7)).toBe(8);
  expect(await store.issueRowId(2)).toBe(9);
  await store.raiseRowIdFloor(4);
  expect(await stored()).toEqual({ version: 1, rowIdFloor: 9, runs: [] });
  await store.raiseRowIdFloor(12);
  expect(await store.issueRowId(0)).toBe(13);
  await store.put(run({ itemId: 20 }));
  expect(await stored()).toMatchObject({ rowIdFloor: 20 });
  await store.prune(() => null);
  expect(await stored()).toEqual({ version: 1, rowIdFloor: 20, runs: [] });
});

it("issues no id past the safe-integer limit, and says so: the floor stays at the limit", async () => {
  const store = new WorkflowRunStore(file);
  await store.raiseRowIdFloor(Number.MAX_SAFE_INTEGER - 1);
  expect(await store.issueRowId(0)).toBe(Number.MAX_SAFE_INTEGER);
  expect(await store.issueRowId(0)).toBe("exhausted");
  expect(await store.issueRowId(Number.MAX_SAFE_INTEGER)).toBe("exhausted");
  expect(await stored()).toEqual({ version: 1, rowIdFloor: Number.MAX_SAFE_INTEGER, runs: [] });
});

it("reports a size-limit refusal as pending review and lets other read errors throw", async () => {
  const store = new WorkflowRunStore(file);
  await store.put(run());
  const before = await readFile(file, "utf8");
  const read = vi.spyOn(homeTrust, "readAveHomeInput");
  read.mockRejectedValue(new homeTrust.AveHomeInputSizeLimitError("too large"));
  expect(await store.get("run-1")).toEqual({ status: "pending-review" });
  expect((await store.view()).pendingReview).toBe(true);
  const mutate = vi.fn((value: WorkflowRunRecord) => value);
  expect(await store.update("run-1", mutate)).toEqual({ status: "pending-review" });
  expect(await store.put(run({ runId: "run-2", itemId: 2 }))).toEqual({ status: "pending-review" });
  expect(mutate).not.toHaveBeenCalled();
  read.mockRejectedValue(Object.assign(new Error("read failed"), { code: "EIO" }));
  await expect(store.get("run-1")).rejects.toMatchObject({ code: "EIO" });
  await expect(store.view()).rejects.toMatchObject({ code: "EIO" });
  await expect(store.put(run({ runId: "run-2", itemId: 2 }))).rejects.toMatchObject({ code: "EIO" });
  read.mockRestore();
  expect(await readFile(file, "utf8")).toBe(before);
});

it("stores how a run ended only through settleRun, from its cause, once, and refuses a malformed end", async () => {
  const store = new WorkflowRunStore(file);
  const settled = { status: "cancelled", at: "2026-01-02T00:00:00.000Z" } as const;
  expect(await store.put(run())).toMatchObject({ status: "stored" });
  // No other write sets an end, changes one or drops one.
  await expect(store.update("run-1", value => ({ ...value, settled }))).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.update("run-1", value => ({ run: value, ends: "stopped", at: settled.at }) as never)).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.put(run({ runId: "run-2", settled }))).rejects.toMatchObject({ code: "invalid-template-run" });
  await expect(store.settleRun("run-1", value => ({ ...value, settled }), () => true)).rejects.toMatchObject({ code: "invalid-template-run" });
  // A cause `allowed` refuses on what the file holds of the run writes nothing.
  const asked: unknown[] = [];
  expect(await store.settleRun("run-1", value => ({ run: value, ends: "orphan", at: settled.at }), (cause, facts) => { asked.push([cause, facts]); return false; }))
    .toEqual({ status: "cause-refused" });
  expect(asked).toEqual([["orphan", { readable: true, intent: false, unknown: false }]]);
  expect(await store.get("run-1")).toMatchObject({ status: "found", run: { stageRuns: run().stageRuns } });
  expect((await store.get("run-1") as { run: object }).run).not.toHaveProperty("settled");
  expect(await store.settleRun("run-1", value => ({ run: value, ends: "stopped", at: settled.at }), () => true)).toMatchObject({ status: "stored", run: { settled } });
  expect(await store.get("run-1")).toMatchObject({ status: "found", run: { settled } });
  // Once over, its end stays: another end is refused as the run already over, and a write that changes or drops it is refused.
  expect(await store.settleRun("run-1", value => ({ run: value, ends: "completed", at: settled.at }), () => true)).toEqual({ status: "refused" });
  for (const next of [{ status: "completed" as const, at: settled.at }, undefined]) {
    await expect(store.update("run-1", ({ settled: _, ...value }) => ({ ...value, ...(next ? { settled: next } : {}) }) as WorkflowRunRecord)).rejects.toMatchObject({ code: "invalid-template-run" });
    await expect(store.put(next ? run({ settled: next }) : run(), value => value)).rejects.toMatchObject({ code: "invalid-template-run" });
  }
  expect(await store.get("run-1")).toMatchObject({ status: "found", run: { settled } });
  for (const bad of [{ status: "idle", at: settled.at }, { status: "error", at: "never" }, { status: "error" }, { ...settled, by: "user" }]) {
    await expect(store.update("run-1", value => ({ ...value, settled: bad as never }))).rejects.toMatchObject({ code: "invalid-template-run" });
  }
});

it.each([
  ["completed", "completed"], ["denied", "denied"], ["failed", "error"], ["stopped", "cancelled"], ["unstarted", "error"], ["item-removed", "cancelled"],
  ["orphan", "cancelled"], ["lost", "error"],
] as const)("a run that ends %s is stored %s, and its delete intent and unknown marker go in the same write", async (ends, status) => {
  const store = new WorkflowRunStore(file);
  const intent = { itemId: run().itemId, runId: "run-1" };
  expect(await store.put(run())).toMatchObject({ status: "stored" });
  expect(await store.markDeleted(intent)).toBe("marked");
  await store.markUnknown(intent);
  expect(await store.deleteIntents()).toEqual([intent]);
  expect(JSON.parse(await readFile(file, "utf8")).unknownDeletes).toEqual([intent]);
  expect(await store.settleRun("run-1", value => ({ run: value, ends, at: "2026-01-02T00:00:00.000Z" }), cause => cause === ends))
    .toMatchObject({ status: "stored", run: { settled: { status, at: "2026-01-02T00:00:00.000Z" } } });
  expect(await store.deleteIntents()).toEqual([]);
  const stored = JSON.parse(await readFile(file, "utf8"));
  expect([stored.deleteIntents, stored.unknownDeletes]).toEqual([undefined, undefined]);
});

it("reads a delete as unknown while the file holds its marker or the store holds it in memory, and resolves it only as told, confirmed by reading the file again", async () => {
  const store = new WorkflowRunStore(file);
  const intent = { itemId: run().itemId, runId: "run-1" };
  expect(await store.put(run())).toMatchObject({ status: "stored" });
  expect(await store.markDeleted(intent)).toBe("marked");
  expect(await store.hasUnknown()).toBe(false);
  await store.markUnknown(intent);
  expect(await store.hasUnknown()).toBe(true);
  expect((await store.runFacts())?.of(intent)).toEqual({ readable: true, intent: true, unknown: true });
  // A new store reads the marker from the file.
  const restarted = new WorkflowRunStore(file);
  expect((await restarted.runFacts())?.of(intent)).toEqual({ readable: true, intent: true, unknown: true });
  // Landed: only the marker goes, and the intent decides.
  await restarted.resolveUnknown(() => true);
  expect((await restarted.runFacts())?.of(intent)).toEqual({ readable: true, intent: true, unknown: false });
  expect(await restarted.hasUnknown()).toBe(false);
  // The first store still holds it in memory until it resolves it: not landed takes the intent back with it.
  expect((await store.runFacts())?.of(intent)).toEqual({ readable: true, intent: true, unknown: true });
  await store.resolveUnknown(() => false);
  expect((await store.runFacts())?.of(intent)).toEqual({ readable: true, intent: false, unknown: false });
  expect(await store.hasUnknown()).toBe(false);
  expect(await store.withdrawIntent(intent)).toBe(true);
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

it("shows every entry that does not read as a run by its place and content, and discards only the one named, after keeping the file as it was", async () => {
  const store = new WorkflowRunStore(file);
  const broken = { runId: "broken", itemId: 4 };
  const entries = [run(), null, broken, run({ runId: "twice" }), run({ runId: "twice", itemId: 3 }), { itemId: "two" }];
  const text = JSON.stringify({ version: 1, rowIdFloor: 9, runs: entries });
  await writeFile(file, text);
  expect((await store.view()).unreadable).toEqual([
    { position: 1, hash: sha("null") }, { position: 2, hash: sha(JSON.stringify(broken)), itemId: 4 },
    { position: 3, hash: sha(JSON.stringify(entries[3])), itemId: 1 }, { position: 4, hash: sha(JSON.stringify(entries[4])), itemId: 3 },
    { position: 5, hash: sha(JSON.stringify(entries[5])) },
  ]);
  for (const target of [{ position: 2, hash: sha("null") }, { position: 0, hash: sha(JSON.stringify(run())) }, { position: 6, hash: sha("null") }]) {
    expect(await store.discardUnreadable(target, () => true)).toBe("changed");
  }
  expect(await readFile(file, "utf8")).toBe(text);
  const write = vi.spyOn(namespace, "writeFileAtomicAtPath");
  write.mockRejectedValueOnce(Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }));
  await expect(store.discardUnreadable({ position: 2, hash: sha(JSON.stringify(broken)) }, () => true)).rejects.toMatchObject({ code: "work-board-backup-failed" });
  expect(await readFile(file, "utf8")).toBe(text);
  write.mockRestore();
  expect(await store.discardUnreadable({ position: 2, hash: sha(JSON.stringify(broken)) }, () => true)).toBe("discarded");
  expect(await readFile(`${file}.invalid-runs-${sha(text)}.bak`, "utf8")).toBe(text);
  expect((await stored()).runs).toEqual([run(), null, ...entries.slice(3)]);
  // The places follow the file as it is now; a repeated runId left once reads as its run.
  expect(await store.discardUnreadable({ position: 2, hash: sha(JSON.stringify(broken)) }, () => true)).toBe("changed");
  expect(await store.discardUnreadable({ position: 3, hash: sha(JSON.stringify(entries[4])) }, () => true)).toBe("discarded");
  expect(await store.get("twice")).toEqual({ status: "found", run: run({ runId: "twice" }) });
  expect((await store.view()).unreadable).toEqual([{ position: 1, hash: sha("null") }, { position: 3, hash: sha(JSON.stringify(entries[5])) }]);
});

it("discards no entry the check refuses, given the entry as read, and copies nothing then", async () => {
  const store = new WorkflowRunStore(file);
  const entry = { runId: "broken", itemId: 4 };
  const text = JSON.stringify({ version: 1, runs: [entry] });
  await writeFile(file, text);
  const allowed = vi.fn(() => false);
  expect(await store.discardUnreadable({ position: 0, hash: sha(JSON.stringify(entry)) }, allowed)).toBe("refused");
  expect(allowed).toHaveBeenCalledWith(entry);
  expect(await readFile(file, "utf8")).toBe(text);
  expect(readdirSync(dir).filter(name => name.endsWith(".bak"))).toEqual([]);
});

it("discards nothing while the run file awaits review, is past its read limit or is not there", async () => {
  const store = new WorkflowRunStore(file);
  const target = { position: 0, hash: sha("null") };
  expect(await store.discardUnreadable(target, () => true)).toBe("changed");
  expect(existsSync(file)).toBe(false);
  const text = JSON.stringify({ version: 1, runs: [null] });
  await writeFile(file, text);
  const read = vi.spyOn(homeTrust, "readAveHomeInput").mockResolvedValueOnce({ status: "untrusted", bytes: Buffer.from(text), reason: "changed" });
  expect(await store.discardUnreadable(target, () => true)).toBe("changed");
  read.mockRejectedValueOnce(new homeTrust.AveHomeInputSizeLimitError("too large"));
  expect(await store.discardUnreadable(target, () => true)).toBe("changed");
  expect(await readFile(file, "utf8")).toBe(text);
  expect((await store.view()).unreadable).toEqual([target]);
});

const RUN_FILE_WRITES: [string, (store: WorkflowRunStore) => Promise<unknown>][] = [
  ["put", store => store.put(run({ runId: "run-2", itemId: 2 }))],
  ["update", store => store.update("run-1", value => ({ ...value, stageRuns: [] }))],
  ["prune", store => store.prune(value => value.runId === "run-1" ? null : value)],
  ["issueRowId", store => store.issueRowId(0)],
  ["raiseRowIdFloor", store => store.raiseRowIdFloor(50)],
  ["startLegacyBoardCopy", store => store.startLegacyBoardCopy(3, "a".repeat(64))],
  ["finishLegacyBoardCopy", store => store.finishLegacyBoardCopy("a".repeat(64))],
  ["discardUnreadable", store => store.discardUnreadable({ position: 3, hash: sha(JSON.stringify("stray")) }, () => true)],
];
it.each(RUN_FILE_WRITES)("%s writes the run file's other keys and every entry that does not read as a run back as they were, and keeps bytes it would not give back first", async (name, write) => {
  const archive = [{ runId: "run-9", itemId: 9 }];
  const unreadable = [{ runId: "broken", itemId: 4, extra: 1 }, { itemId: "two" }, "stray"];
  const copy = { through: 5, board: "a".repeat(64) };
  // Compact and a floor below a stored run's row: neither is what a write writes.
  const text = `{"archive":${JSON.stringify(archive)},"version":1,"rowIdFloor":0,"runs":${JSON.stringify([run(), ...unreadable])},"note":"moved by hand","legacyBoardCopy":${JSON.stringify(copy)}}`;
  await writeFile(file, text);
  const store = new WorkflowRunStore(file);
  await write(store);
  const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> & { runs: unknown[] };
  expect(Object.keys(after)[0]).toBe("archive");
  expect(after).toMatchObject({ archive, note: "moved by hand" });
  for (const entry of name === "discardUnreadable" ? unreadable.slice(0, 2) : unreadable) expect(after.runs).toContainEqual(entry);
  expect(await readFile(`${file}.invalid-runs-${sha(text)}.bak`, "utf8")).toBe(text);
  // Written as a write writes it, the file is not copied again.
  const copies = () => readdirSync(dir).filter(entry => entry.endsWith(".bak"));
  expect(copies()).toHaveLength(1);
  await store.raiseRowIdFloor(60);
  expect(copies()).toHaveLength(1);
});

it.each(RUN_FILE_WRITES)("%s writes nothing over a run file that holds a key twice, and refuses with its code", async (_, write) => {
  const text = `{"version":1,"rowIdFloor":0,"runs":${JSON.stringify([run(), "stray"])},"note":"x","note":"moved by hand","legacyBoardCopy":{"through":5,"board":"${"a".repeat(64)}"}}`;
  await writeFile(file, text);
  await expect(write(new WorkflowRunStore(file))).rejects.toMatchObject({ code: "workflow-runs-duplicate-key", path: file });
  expect(await readFile(file, "utf8")).toBe(text);
  expect(readdirSync(dir).filter(entry => entry.endsWith(".bak"))).toEqual([]);
});

it("calls a run missing only when the file read holds no entry under its id and none without a string runId, and never while it awaits review", async () => {
  const store = new WorkflowRunStore(file);
  expect((await store.view()).missing?.("gone")).toBe(true);
  await writeFile(file, JSON.stringify({ version: 1, runs: [run(), { runId: "broken", itemId: 4 }, run({ runId: "twice" }), run({ runId: "twice" })] }));
  const view = await store.view();
  expect(["gone", "run-1", "broken", "twice"].map(runId => view.missing?.(runId))).toEqual([true, false, false, false]);
  for (const entry of [null, { itemId: 4 }, { runId: 7, itemId: 4 }, "run-x"]) {
    await writeFile(file, JSON.stringify({ version: 1, runs: [run(), entry] }));
    expect((await store.view()).missing?.("gone")).toBe(false);
  }
  vi.spyOn(homeTrust, "readAveHomeInput").mockResolvedValueOnce({ status: "untrusted", bytes: Buffer.from("{}"), reason: "changed" });
  expect((await store.view()).missing?.("gone")).toBeUndefined();
});

it("holds an open run below an id while an entry does not read as a run, and none once every run below it is over", async () => {
  const store = new WorkflowRunStore(file);
  for (const entry of [null, { itemId: 2 }, { ...run(), stageRuns: "x" }]) {
    await writeFile(file, JSON.stringify({ version: 1, rowIdFloor: 5, runs: [entry] }));
    expect(await store.openRunBelow(5)).toBe(true);
  }
  await writeFile(file, JSON.stringify({ version: 1, rowIdFloor: 5, runs: [run({ itemId: 4 }), run({ runId: "run-2", itemId: 5 })] }));
  expect(await store.openRunBelow(5)).toBe(true);
  await writeFile(file, JSON.stringify({ version: 1, rowIdFloor: 5, runs: [run({ itemId: 4, settled: { status: "completed", at: "2026-01-02T00:00:00.000Z" } }), run({ runId: "run-2", itemId: 5 })] }));
  expect(await store.openRunBelow(5)).toBe(false);
});

it("lists every readable run, leaves out unreadable and repeated entries, and lists nothing while the file awaits review", async () => {
  const store = new WorkflowRunStore(file);
  expect(await store.list()).toEqual({ status: "found", runs: [] });
  const settled = run({ runId: "run-2", itemId: 2, settled: { status: "completed", at: "2026-01-02T00:00:00.000Z" } });
  await writeFile(file, JSON.stringify({ version: 1, runs: [run(), { runId: "broken" }, settled, run({ runId: "twice" }), run({ runId: "twice", itemId: 3 })] }));
  expect(await store.list()).toEqual({ status: "found", runs: [run(), settled] });
  vi.spyOn(homeTrust, "readAveHomeInput").mockResolvedValue({ status: "untrusted", bytes: Buffer.alloc(0), reason: "changed" });
  expect(await store.list()).toEqual({ status: "pending-review" });
});
