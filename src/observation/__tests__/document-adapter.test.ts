import { appendFileSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const clock = vi.hoisted(() => ({ immediate: false }));
vi.mock("node:timers/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:timers/promises")>();
  return { ...original, setTimeout: <T>(milliseconds: number, value: T, options?: { signal?: AbortSignal }) => {
    options?.signal?.throwIfAborted();
    return clock.immediate ? Promise.resolve(value) : original.setTimeout(milliseconds, value, options);
  } };
});
import { terminalFileEvidence } from "../../main/terminal/changed-file-evidence.js";
import { DocumentObservationAdapter } from "../document-adapter.js";
import type { DocumentObservationEngine, DocumentObservationEvent } from "../../shared/agent-observation.js";
import type { PreviewTableDocument } from "../../shared/preview-document.js";
import { parseObservedTextDocument } from "../text-document.js";

const adapters: DocumentObservationAdapter[] = [];
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  clock.immediate = false;
  for (const adapter of adapters.splice(0)) adapter.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const HASHES = Object.freeze({
  before: "6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb",
  after: "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8",
  "after-two": "daeba8f55bf2b80cf87005e3687416f9cffbf23dcd4195bf13dbfbf6d5239a4e",
  "user-save": "092003a4925515aa7cf0f8edc465ab143af608529b56562e5fac6873d8706048",
  "private-user-content": "c3f524d0d1ae86c51ff83421bcb1edb840640ec9669549e4d104851daebee48a",
});
const identity = { sessionId: "session-a", turnId: "turn-1", toolUseId: "tool-1" };
function document(value = "1", second = "2", needsRecalculation = false): PreviewTableDocument {
  return { format: "xlsx", needsRecalculation, sheetNames: ["Sheet1"], totalSheets: 1, sheetsTruncated: false,
    sheet: { index: 0, name: "Sheet1", firstRow: 0, firstColumn: 0, totalRows: 3, totalColumns: 2,
      rows: [["Name", "Value"], ["Alpha", value], ["Beta", second]], rowsTruncated: false, columnsTruncated: false,
      cellsTruncated: false, clippedCells: [] } };
}
function fixture(engine?: DocumentObservationEngine | null, acknowledged = true) {
  const root = mkdtempSync(join(tmpdir(), "ave-document-observation-"));
  roots.push(root);
  const path = join(root, "book.xlsx");
  const home = join(root, "action");
  mkdirSync(join(home, "document-observation"), { recursive: true });
  const journal = join(home, "document-observation", "journal.jsonl");
  writeFileSync(path, "before");
  const parse = vi.fn(async (bytes: Buffer) => bytes.toString() === "after-two"
    ? document("99", "84", true) : document("42", "84", true));
  const adapter = new DocumentObservationAdapter(engine === undefined ? { id: "table-reader", parse } : engine);
  adapters.push(adapter);
  const events: DocumentObservationEvent[] = [];
  let current = true;
  adapter.registerView({ id: "view-a", sessionId: "session-a", path, hash: HASHES.before, document: document(),
    isCurrent: () => current, onEvents: (batch) => events.push(...batch) });
  if (acknowledged) adapter.acknowledge("view-a", 0);
  return { root, path, home, journal, adapter, events, parse, expire: () => { current = false; } };
}
function append(path: string, record: unknown): void { appendFileSync(path, `${JSON.stringify(record)}\n`); }
function begin(path: string, target: string, beforeHash = HASHES.before): void {
  append(path, { v: 1, kind: "begin", editId: "edit-1", target, beforeHash });
}
function cell(path: string, address: string, before: string, after: string): void {
  append(path, { v: 1, kind: "cell", editId: "edit-1", sheet: "Sheet1", cell: address, before, after });
}

describe("agent document observation", () => {
  it("does not watch or emit user-only preview changes", async () => {
    const { path, adapter, events, parse } = fixture();
    writeFileSync(path, "user-save");
    await tick();
    await adapter.finishInvocation(identity);
    expect(events).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("does not attribute an idle user save in an agent-opened document", async () => {
    const { path, adapter, events, parse } = fixture();
    adapter.markAgentDocument("session-a", path);
    writeFileSync(path, "user-save");
    await tick();
    expect(events).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("reconciles an exact native mutation after an atomic rename", async () => {
    const { path, adapter, events } = fixture();
    writeFileSync(`${path}.tmp`, "after");
    renameSync(`${path}.tmp`, path);
    await adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    await tick();
    expect(events.filter((event) => event.kind === "element")).toMatchObject([
      { actor: "agent", before: "1", after: "42", advisory: false, element: { sheet: "Sheet1", row: 1, column: 1 } },
      { actor: "agent", before: "2", after: "84", advisory: false, element: { sheet: "Sheet1", row: 2, column: 1 } },
    ]);
    expect(events.find((event) => event.kind === "snapshot")).toMatchObject({ after: { needsRecalculation: true,
      sheet: { rows: [["Name", "Value"], ["Alpha", "42"], ["Beta", "84"]] } } });
  });

  it("refuses to fold a prior user revision into an agent delta", async () => {
    const { path, adapter, events, parse } = fixture();
    writeFileSync(path, "after");
    await adapter.observeMutation(identity, path, HASHES["user-save"], HASHES.after);
    await tick();
    expect(events).toMatchObject([{ kind: "status", after: { code: "reload-required" } }]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("refuses an actual file that disagrees with the native post-image", async () => {
    const { path, adapter, events, parse } = fixture();
    writeFileSync(path, "user-save");
    await adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    await tick();
    expect(events.some((event) => event.kind === "status" && event.after.code === "reload-required")).toBe(true);
    expect(events.some((event) => event.kind === "element" || event.kind === "snapshot")).toBe(false);
    expect(parse).not.toHaveBeenCalled();
  });

  it("streams separate provisional cells before save and then shows the actual file", async () => {
    const { path, home, journal, adapter, events, parse } = fixture();
    const lease = adapter.openJournal(identity, home);
    begin(journal, path);
    cell(journal, "B2", "1", "journal-draft");
    cell(journal, "B3", "2", "84");
    lease.poll();
    await tick();
    expect(events.filter((event) => event.kind === "element")).toMatchObject([
      { before: "1", after: "journal-draft", advisory: true, element: { row: 1, column: 1 } },
      { before: "2", after: "84", advisory: true, element: { row: 2, column: 1 } },
    ]);
    expect(parse).not.toHaveBeenCalled();
    writeFileSync(`${path}.tmp`, "after");
    renameSync(`${path}.tmp`, path);
    append(journal, { v: 1, kind: "commit", editId: "edit-1", afterHash: HASHES.after });
    await lease.finish();
    await tick();
    expect(events.findLast((event) => event.kind === "snapshot")).toMatchObject({ kind: "snapshot", after: {
      needsRecalculation: true, sheet: { rows: [["Name", "Value"], ["Alpha", "42"], ["Beta", "84"]] },
    } });
  });

  it("does not let a journal target an unregistered path or another session", async () => {
    const { root, home, journal, adapter, events, parse } = fixture();
    const unknown = join(root, "unopened.xlsx");
    writeFileSync(unknown, "private-user-content");
    const lease = adapter.openJournal(identity, home);
    begin(journal, unknown);
    cell(journal, "B2", "1", "42");
    append(journal, { v: 1, kind: "commit", editId: "edit-1", afterHash: HASHES["private-user-content"] });
    await lease.finish();
    await tick();
    expect(events).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("does not let another session journal a registered document", async () => {
    const { path, home, journal, adapter, events, parse } = fixture();
    const lease = adapter.openJournal({ ...identity, sessionId: "session-b" }, home);
    begin(journal, path);
    cell(journal, "B2", "1", "42");
    append(journal, { v: 1, kind: "commit", editId: "edit-1", afterHash: HASHES.before });
    await lease.finish();
    await tick();
    expect(events).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("never interprets workbook journal cells as text-line observation", async () => {
    const { path, home, journal, adapter, events, parse } = fixture();
    adapter.release("view-a");
    adapter.registerView({ id: "view-text", sessionId: "session-a", path, hash: HASHES.before,
      document: parseObservedTextDocument(Buffer.from("before")), isCurrent: () => true,
      onEvents: (batch) => events.push(...batch) });
    adapter.acknowledge("view-text", 0);
    const lease = adapter.openJournal(identity, home);
    begin(journal, path);
    cell(journal, "B2", "before", "draft");
    append(journal, { v: 1, kind: "commit", editId: "edit-1", afterHash: HASHES.before });
    await lease.finish();
    await tick();
    expect(events).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("does not stream until the initial view was acknowledged as rendered", async () => {
    const { path, home, journal, adapter, events, parse } = fixture(undefined, false);
    const lease = adapter.openJournal(identity, home);
    begin(journal, path);
    cell(journal, "B2", "1", "42");
    append(journal, { v: 1, kind: "commit", editId: "edit-1", afterHash: HASHES.before });
    await lease.finish();
    await tick();
    expect(events).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("clears uncommitted journal drafts when the invocation ends", async () => {
    const { path, home, journal, adapter, events } = fixture();
    const lease = adapter.openJournal(identity, home);
    begin(journal, path);
    cell(journal, "B2", "1", "draft");
    lease.poll();
    await tick();
    await adapter.finishInvocation(identity);
    await tick();
    expect(events.findLast((event) => event.kind === "status")).toMatchObject({ after: { code: "reload-required" } });
    expect(events.some((event) => event.kind === "snapshot")).toBe(false);
  });

  it("does not invalidate a successfully finished journal when its lease is disposed", async () => {
    const { path, home, journal, adapter, events } = fixture();
    const lease = adapter.openJournal(identity, home);
    begin(journal, path);
    cell(journal, "B2", "1", "42");
    writeFileSync(path, "after");
    append(journal, { v: 1, kind: "commit", editId: "edit-1", afterHash: HASHES.after });
    await lease.finish();
    lease.dispose();
    lease.dispose();
    await tick();
    expect(events.findLast((event) => event.kind === "status")).toMatchObject({ after: { code: "live" } });
  });

  it("revokes a journal synchronously and rejects later records and publication", async () => {
    const { path, home, journal, adapter, events, parse } = fixture();
    const lease = adapter.openJournal(identity, home);
    begin(journal, path);
    cell(journal, "B2", "1", "draft");
    lease.poll();
    adapter.revokeInvocation(identity);
    writeFileSync(path, "after");
    cell(journal, "B3", "2", "84");
    append(journal, { v: 1, kind: "commit", editId: "edit-1", afterHash: HASHES.after });
    lease.poll();
    await lease.finish();
    await tick();
    expect(events.some((event) => event.kind === "element" || event.kind === "snapshot")).toBe(false);
    expect(events.findLast((event) => event.kind === "status")).toMatchObject({ after: { code: "reload-required" } });
    expect(parse).not.toHaveBeenCalled();
  });

  it("invalidates an earlier pending save when a later edit in the same journal is uncommitted", async () => {
    const { path, home, journal, adapter, events, parse } = fixture();
    const lease = adapter.openJournal(identity, home);
    begin(journal, path);
    cell(journal, "B2", "1", "42");
    writeFileSync(path, "after");
    append(journal, { v: 1, kind: "commit", editId: "edit-1", afterHash: HASHES.after });
    append(journal, { v: 1, kind: "begin", editId: "edit-2", target: path, beforeHash: HASHES.after });
    append(journal, { v: 1, kind: "cell", editId: "edit-2", sheet: "Sheet1", cell: "B3", before: "2", after: "draft" });
    await lease.finish();
    await tick();
    expect(events.some((event) => event.kind === "snapshot" || event.kind === "element")).toBe(false);
    expect(events.findLast((event) => event.kind === "status")).toMatchObject({ after: { code: "reload-required" } });
    expect(parse).not.toHaveBeenCalled();
  });

  it("aborts a native reconciliation and discards queued content on revocation", async () => {
    const { path, adapter, events } = fixture();
    writeFileSync(path, "after");
    const pending = adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    adapter.revokeInvocation(identity);
    await pending;
    await tick();
    expect(events.some((event) => event.kind === "element" || event.kind === "snapshot")).toBe(false);
    expect(events.findLast((event) => event.kind === "status")).toMatchObject({ after: { code: "reload-required" } });
  });

  it("discards a verified snapshot revoked while file evidence recording is pending", async () => {
    const { path, adapter, events } = fixture();
    let entered!: () => void;
    let resume!: () => void;
    const recording = new Promise<void>((resolve) => { entered = resolve; });
    const suspended = new Promise<void>((resolve) => { resume = resolve; });
    const record = vi.spyOn(terminalFileEvidence, "recordWrite").mockImplementationOnce(async () => {
      entered();
      await suspended;
    });
    writeFileSync(path, "after");
    const pending = adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    try {
      await recording;
      adapter.revokeInvocation(identity);
      resume();
      await pending;
      await tick();
      expect(events.some((event) => event.kind === "element" || event.kind === "snapshot")).toBe(false);
      expect(events.findLast((event) => event.kind === "status")).toMatchObject({ after: { code: "reload-required" } });
    } finally {
      resume();
      await pending;
      record.mockRestore();
    }
  });

  it("discards an older verified snapshot replaced while file evidence recording is pending", async () => {
    const { path, adapter, events } = fixture();
    let enterOlder!: () => void;
    let enterNewer!: () => void;
    let resumeOlder!: () => void;
    let resumeNewer!: () => void;
    const olderRecording = new Promise<void>((resolve) => { enterOlder = resolve; });
    const newerRecording = new Promise<void>((resolve) => { enterNewer = resolve; });
    const olderSuspended = new Promise<void>((resolve) => { resumeOlder = resolve; });
    const newerSuspended = new Promise<void>((resolve) => { resumeNewer = resolve; });
    const record = vi.spyOn(terminalFileEvidence, "recordWrite")
      .mockImplementationOnce(async () => { enterOlder(); await olderSuspended; })
      .mockImplementationOnce(async () => { enterNewer(); await newerSuspended; });
    writeFileSync(path, "after");
    const older = adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    let newer: Promise<void> | undefined;
    try {
      await olderRecording;
      writeFileSync(path, "after-two");
      newer = adapter.observeMutation({ ...identity, toolUseId: "tool-2" }, path, HASHES.after, HASHES["after-two"]);
      await newerRecording;
      resumeOlder();
      await older;
      await tick();
      expect(events.some((event) => event.kind === "element" || event.kind === "snapshot")).toBe(false);
      resumeNewer();
      await newer;
      await tick();
      const snapshots = events.filter((event) => event.kind === "snapshot");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ after: { sheet: { rows: [["Name", "Value"], ["Alpha", "99"], ["Beta", "84"]] } } });
    } finally {
      resumeOlder();
      resumeNewer();
      await Promise.all([older, newer]);
      record.mockRestore();
    }
  });

  it("discards an older invocation's queued save after a newer receipt replaces its proof", async () => {
    const { path, adapter, events, parse } = fixture();
    writeFileSync(path, "after");
    await adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    expect(events.some((event) => event.kind === "snapshot")).toBe(false);
    writeFileSync(path, "after-two");
    const pending = adapter.observeMutation({ ...identity, toolUseId: "tool-2" }, path, HASHES.after, HASHES["after-two"]);
    adapter.revokeInvocation(identity);
    await pending;
    await tick();
    expect(events.some((event) => event.kind === "element" || event.kind === "snapshot")).toBe(false);
    expect(events.findLast((event) => event.kind === "status")).toMatchObject({ after: { code: "reload-required" } });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("diffs consecutive verified saves against the last rendered acknowledgement", async () => {
    const { path, adapter, events } = fixture();
    writeFileSync(path, "after");
    await adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    await tick();
    const firstSnapshot = events.find((event) => event.kind === "snapshot")!;
    expect(firstSnapshot.kind).toBe("snapshot");
    events.length = 0;
    writeFileSync(path, "after-two");
    await adapter.observeMutation({ ...identity, toolUseId: "tool-2" }, path, HASHES.after, HASHES["after-two"]);
    await tick();
    expect(events.filter((event) => event.kind === "element")).toMatchObject([
      { before: "1", after: "99" }, { before: "2", after: "84" },
    ]);
  });

  it("advances the baseline only after the delivered snapshot was acknowledged", async () => {
    const { path, adapter, events } = fixture();
    writeFileSync(path, "after");
    await adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    await tick();
    const lastSequence = events.at(-1)!.seq;
    expect(() => adapter.acknowledge("view-a", lastSequence + 1)).toThrow("Invalid observation acknowledgement.");
    adapter.acknowledge("view-a", lastSequence);
    events.length = 0;
    writeFileSync(path, "after-two");
    await adapter.observeMutation({ ...identity, toolUseId: "tool-2" }, path, HASHES.after, HASHES["after-two"]);
    await tick();
    expect(events.filter((event) => event.kind === "element")).toMatchObject([{ before: "42", after: "99" }]);
  });

  it("retains an in-flight snapshot digest across many coalesced saves", async () => {
    clock.immediate = true;
    const { path, adapter, events } = fixture();
    let beforeHash: string = HASHES.before;
    for (let edit = 0; edit < 67; edit += 1) {
      const text = edit % 2 === 0 ? "after" : "after-two";
      const afterHash = HASHES[text];
      writeFileSync(path, text);
      await adapter.observeMutation({ ...identity, toolUseId: `tool-${edit}` }, path, beforeHash, afterHash);
      if (edit === 0) await tick();
      beforeHash = afterHash;
    }
    const first = events.find((event) => event.kind === "snapshot")!;
    expect(first.kind).toBe("snapshot");
    adapter.acknowledge("view-a", first.seq);
    events.length = 0;
    writeFileSync(path, "after-two");
    await adapter.observeMutation({ ...identity, toolUseId: "tool-final" }, path, HASHES.after, HASHES["after-two"]);
    await tick();
    for (let drain = 0; drain < 8; drain += 1) {
      const last = events.at(-1);
      if (!last) break;
      adapter.acknowledge("view-a", last.seq);
      await tick();
    }
    expect(events.findLast((event) => event.kind === "element" && event.element.kind === "cell" && event.element.row === 1))
      .toMatchObject({ before: "42", after: "99", advisory: false });
  });

  it("preserves an agent-opened target when a reload replaces its view", async () => {
    const { path, adapter, events } = fixture(null);
    adapter.markAgentDocument("session-a", path);
    await tick();
    events.length = 0;
    adapter.release("view-a");
    adapter.registerView({ id: "view-b", sessionId: "session-a", path, hash: HASHES.before, document: document(),
      isCurrent: () => true, onEvents: (batch) => events.push(...batch) });
    adapter.acknowledge("view-b", 0);
    await tick();
    expect(events).toMatchObject([{ target: { id: "view-b" }, kind: "status", after: { code: "engine-unavailable" } }]);
  });

  it("expires an agent-open admission without a rendered view before a later user preview", async () => {
    vi.useFakeTimers();
    const { path, adapter, events } = fixture(null);
    adapter.release("view-a");
    adapter.markAgentDocument("session-a", path);
    await vi.advanceTimersByTimeAsync(10_000);
    adapter.registerView({ id: "view-later", sessionId: "session-a", path, hash: HASHES.before, document: document(),
      isCurrent: () => true, onEvents: (batch) => events.push(...batch) });
    adapter.acknowledge("view-later", 0);
    writeFileSync(path, "user-save");
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual([]);
  });

  it("uses the explicit existing-viewer fallback only when the engine is absent", async () => {
    const { path, adapter, events } = fixture(null);
    await adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    await tick();
    expect(events.every((event) => event.kind === "status" && event.after.code === "engine-unavailable")).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it("reports a broken engine as an error without selecting the absent-engine fallback", async () => {
    const engine = { id: "broken-reader", parse: vi.fn(async () => { throw new Error("parser failed"); }) };
    const { path, adapter, events } = fixture(engine);
    writeFileSync(path, "after");
    await adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    await tick();
    expect(events.some((event) => event.kind === "status" && event.after.code === "observation-error")).toBe(true);
    expect(events.some((event) => event.kind === "status" && event.after.code === "engine-unavailable")).toBe(false);
  });

  it("stops delivery after the owner frame loses its binding", async () => {
    const { path, adapter, events, expire } = fixture();
    writeFileSync(path, "after");
    const pending = adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    expire();
    await pending;
    await tick();
    expect(events).toEqual([]);
  });

  it("does not publish a parsed snapshot superseded by a concurrent file save", async () => {
    let path = "";
    const engine = { id: "table-reader", parse: vi.fn(async () => { writeFileSync(path, "user-save"); return document("42", "84", true); }) };
    const item = fixture(engine);
    path = item.path;
    writeFileSync(path, "after");
    await item.adapter.observeMutation(identity, path, HASHES.before, HASHES.after);
    await tick();
    expect(item.events.some((event) => event.kind === "snapshot" || event.kind === "element")).toBe(false);
    expect(item.events.findLast((event) => event.kind === "status")).toMatchObject({ after: { code: "reload-required" } });
  });
});
