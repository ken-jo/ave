import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewReadDocumentResult } from "../../../shared/preview-document.js";
import { buildPreviewDocumentRuntime } from "../../../__tests__/support/preview-document-runtime.js";
import { cyclicWorkbook } from "../../../__tests__/support/table-document-fixtures.js";
import type { XlsxPanelEditResult } from "../../../shared/xlsx-panel-edit.js";
import * as sandboxPolicy from "../../../permissions/asrt-sandbox.js";
import * as documentInput from "../../../tools/preview-document-input.js";
import { getManagedChildProcessCount } from "../../../main/managed-child-processes.js";
import * as managedChildren from "../../../main/managed-child-processes.js";

const { handlers, additionalDirectories, childRuntime } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  additionalDirectories: { value: [] as string[] },
  childRuntime: { mainDir: "" },
}));

vi.mock("../../../main/main-paths.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../main/main-paths.js")>(),
  get mainDir() { return childRuntime.mainDir; },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({
    permissions: { additionalDirectories: additionalDirectories.value, pendingWorkspaceRootRemovals: [] },
  }),
}));

import { registerPreviewHandlers } from "../preview.js";
import { CHANNELS } from "../../../contract/app-contract.js";

const auditLog = vi.fn();
const deps = { auditLogger: { log: auditLog } } as never;
const OK_FRAME = "file:///app/index.html";
const EVIL_FRAME = "https://evil.example.com/x";
const dirLinkType = process.platform === "win32" ? "junction" : "dir";

let root: string;
let outside: string;

function documentEvent(url: string, senderId = 1, routingId = 0) {
  const frame = { url, processId: senderId, routingId, detached: false, isDestroyed: (): boolean => false };
  const sender = Object.assign(new EventEmitter(), { id: senderId, mainFrame: frame, isDestroyed: (): boolean => false });
  return { sender, senderFrame: frame };
}

async function readFromSender(event: ReturnType<typeof documentEvent>, path: unknown, sheetIndex: unknown = 0) {
  const handler = handlers.get(CHANNELS.preview.readDocument)!;
  return (await handler(event, path, sheetIndex)) as PreviewReadDocumentResult;
}

async function readDocument(frame: string, path: unknown, sheetIndex: unknown = 0, senderId = 1, routingId = 0) {
  return readFromSender(documentEvent(frame, senderId, routingId), path, sheetIndex);
}

beforeAll(async () => {
  childRuntime.mainDir = await buildPreviewDocumentRuntime();
  root = mkdtempSync(join(tmpdir(), "ave-preview-doc-"));
  outside = mkdtempSync(join(tmpdir(), "ave-preview-doc-outside-"));
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "people.csv"), "name,age\nalice,30\nbob,41\n");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["q", "rev"], ["Q1", 10]]), "Sales");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["note"]]), "Notes");
  writeFileSync(join(root, "data", "book.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
  const bomb = new AdmZip();
  bomb.addFile("xl/sharedStrings.xml", Buffer.alloc(8 * 1024 * 1024, 0x41));
  writeFileSync(join(root, "data", "bomb.xlsx"), bomb.toBuffer());
  writeFileSync(join(root, "data", "broken.xlsx"), "this is not a workbook");
  writeFileSync(join(root, "data", "cyclic.xls"), cyclicWorkbook());
  writeFileSync(join(root, "data", "broken.csv"), 'a,b\n"unterminated,2');
  writeFileSync(join(root, "notes.txt"), "plain");
  writeFileSync(join(root, "data", "huge.csv"), "");
  truncateSync(join(root, "data", "huge.csv"), PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1);
  writeFileSync(join(outside, "secret.csv"), "k,v\napi,123\n");
  symlinkSync(outside, join(root, "link-out"), dirLinkType);
  registerPreviewHandlers(deps);
});

afterAll(async () => {
  await cleanupTmpDir(root);
  await cleanupTmpDir(outside);
  await cleanupTmpDir(childRuntime.mainDir);
});

beforeEach(() => {
  additionalDirectories.value = [root];
  auditLog.mockClear();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("preview:read-document handler", () => {
  it.each(["completion", "abort"])("clears the owner watch interval on %s", async (outcome) => {
    const clearTimer = globalThis.clearInterval;
    const intervals = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    const watchTimers = (): ReturnType<typeof setInterval>[] => intervals.mock.calls.flatMap(([, delay], index) =>
      delay === PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs ? [intervals.mock.results[index]!.value] : []);
    try {
      const event = documentEvent(OK_FRAME);
      const pending = readFromSender(event, join(root, "data", outcome === "abort" ? "cyclic.xls" : "people.csv"));
      if (outcome === "abort") {
        await vi.waitFor(() => expect(getManagedChildProcessCount()).toBe(1));
        event.sender.emit("destroyed");
      }
      const result = await pending;
      if (outcome === "abort") expect(result).toMatchObject({ ok: false, error: "superseded" });
      else expect(result).toMatchObject({ ok: true });
      const timers = watchTimers();
      expect(timers).toHaveLength(1);
      expect(cleared).toHaveBeenCalledWith(timers[0]);
    } finally {
      for (const timer of watchTimers()) clearTimer(timer);
    }
  });

  it("aborts a destroyed sender and frees the slot without waiting for the parse deadline", async () => {
    const event = documentEvent(OK_FRAME);
    const unrelated = vi.fn();
    event.sender.on("destroyed", unrelated);
    const pending = readFromSender(event, join(root, "data", "cyclic.xls"));
    await vi.waitFor(() => expect(getManagedChildProcessCount()).toBe(1));
    const started = performance.now();
    event.sender.isDestroyed = () => true;
    event.sender.emit("destroyed");
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: "superseded" });
    expect(performance.now() - started).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs / 2);
    expect(getManagedChildProcessCount()).toBe(0);
    expect(await readDocument(OK_FRAME, join(root, "data", "people.csv"), 0, 2)).toMatchObject({ ok: true });
    expect(event.sender.listenerCount("destroyed")).toBe(1);
    expect(unrelated).toHaveBeenCalledOnce();
  });

  it.each(["detached", "destroyed", "navigated", "crashed"])("aborts an owner whose frame is %s", async (departure) => {
    const event = documentEvent(OK_FRAME);
    const pending = readFromSender(event, join(root, "data", "cyclic.xls"));
    await vi.waitFor(() => expect(getManagedChildProcessCount()).toBe(1));
    const started = performance.now();
    if (departure === "detached") event.senderFrame.detached = true;
    else if (departure === "destroyed") event.senderFrame.isDestroyed = () => true;
    else if (departure === "crashed") event.sender.emit("render-process-gone", {}, { reason: "crashed" });
    else event.sender.emit("did-frame-navigate", {}, "file:///app/next.html", 200, "OK", true, 2, 10);
    expect(await pending).toMatchObject({ ok: false, error: "superseded" });
    expect(performance.now() - started).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs / 2);
    expect(getManagedChildProcessCount()).toBe(0);
    expect(event.sender.eventNames()).toEqual([]);
  });

  it("keeps a live owner during attempted or unrelated frame navigation", async () => {
    const event = documentEvent(OK_FRAME);
    const stopped = vi.spyOn(managedChildren, "forceKillManagedChildProcess");
    const pending = readFromSender(event, join(root, "data", "cyclic.xls"));
    await vi.waitFor(() => expect(getManagedChildProcessCount()).toBe(1));
    event.sender.emit("did-start-navigation", { frame: event.senderFrame, isSameDocument: false });
    event.sender.emit("did-frame-navigate", {}, "file:///app/other.html", 200, "OK", false, 99, 99);
    const stoppedForUnrelatedNavigation = stopped.mock.calls.length;
    event.sender.emit("did-frame-navigate", {}, "file:///app/next.html", 200, "OK", true, 1, 0);
    expect(await pending).toMatchObject({ ok: false, error: "superseded" });
    expect(stoppedForUnrelatedNavigation).toBe(0);
    expect(stopped).toHaveBeenCalledOnce();
    expect(event.sender.eventNames()).toEqual([]);
  });

  it.each(["people.csv", "broken.csv", "missing.csv"])("removes owner listeners after reading %s", async (name) => {
    const event = documentEvent(OK_FRAME);
    await readFromSender(event, join(root, "data", name));
    expect(event.sender.eventNames()).toEqual([]);
  });

  it.each(["navigated", "detached"])("cancels a %s document while its replacement request is waiting for admission", async (departure) => {
    const read = documentInput.readPreviewDocumentInput;
    const event = documentEvent(OK_FRAME);
    let entered!: () => void;
    let resume!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const spy = vi.spyOn(documentInput, "readPreviewDocumentInput").mockImplementationOnce(async (...args) => {
      const bytes = await read(...args);
      entered();
      await gate;
      args[1]?.throwIfAborted();
      return bytes;
    });
    const previous = readFromSender(event, join(root, "data", "people.csv"));
    await reading;
    const replacement = readFromSender(event, join(root, "data", "book.xlsx"));
    if (departure === "detached") event.senderFrame.detached = true;
    else event.sender.emit("did-frame-navigate", {}, "file:///app/next.html", 200, "OK", true, 1, 0);
    resume();
    const results = await Promise.all([previous, replacement]);
    expect(results.every((result) => !result.ok && result.error === "superseded")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(event.sender.eventNames()).toEqual([]);
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("admits only one full-size input buffer before concurrent reads", async () => {
    const buffers = new Set<Buffer>();
    let peak = 0;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const read = vi.spyOn(documentInput, "readPreviewDocumentInput").mockImplementation(async () => {
      const buffer = Buffer.allocUnsafe(PREVIEW_DOCUMENT_LIMITS.maxFileBytes);
      buffers.add(buffer);
      peak = Math.max(peak, buffers.size);
      await gate;
      buffers.delete(buffer);
      throw new Error("Read held for admission check.");
    });
    const calls = Array.from({ length: 20 }, (_, index) =>
      readDocument(OK_FRAME, join(root, "data", "people.csv"), 0, index + 1));
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalled());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(peak).toBe(1);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      resume();
      await Promise.all(calls);
    }
  });

  it("supersedes an older parse for the same frame before loading the latest sheet", async () => {
    const read = documentInput.readPreviewDocumentInput;
    const snapshot = documentInput.readPreviewDocumentSnapshot;
    const childrenAtRead: number[] = [];
    const inputReads = vi.spyOn(documentInput, "readPreviewDocumentInput").mockImplementation((...args) => {
      childrenAtRead.push(getManagedChildProcessCount());
      return read(...args);
    });
    const snapshotReads = vi.spyOn(documentInput, "readPreviewDocumentSnapshot").mockImplementation((...args) => {
      childrenAtRead.push(getManagedChildProcessCount());
      return snapshot(...args);
    });
    const previous = readDocument(OK_FRAME, join(root, "data", "cyclic.xls"));
    await vi.waitFor(() => expect(getManagedChildProcessCount()).toBe(1));
    const latest = readDocument(OK_FRAME, join(root, "data", "book.xlsx"), 1);
    const [oldResult, newResult] = await Promise.all([previous, latest]);
    expect(oldResult).toMatchObject({ ok: false, error: "superseded" });
    expect(newResult).toMatchObject({ ok: true, document: { sheet: { name: "Notes" } } });
    expect(inputReads).toHaveBeenCalledTimes(1);
    expect(snapshotReads).toHaveBeenCalledTimes(1);
    expect(childrenAtRead).toEqual([0, 0]);
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("keeps only the latest same-frame request while an older read unwinds", async () => {
    const read = documentInput.readPreviewDocumentInput;
    const snapshots = vi.spyOn(documentInput, "readPreviewDocumentSnapshot");
    let entered!: () => void;
    let resume!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const spy = vi.spyOn(documentInput, "readPreviewDocumentInput").mockImplementationOnce(async (path, signal) => {
      const bytes = await read(path, signal);
      entered();
      await gate;
      signal?.throwIfAborted();
      return bytes;
    });
    const previous = readDocument(OK_FRAME, join(root, "data", "people.csv"));
    await reading;
    const replacements = Array.from({ length: 20 }, () => readDocument(OK_FRAME, join(root, "data", "book.xlsx"), 1));
    let results: PreviewReadDocumentResult[];
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(snapshots).not.toHaveBeenCalled();
    } finally {
      resume();
      results = await Promise.all([previous, ...replacements]);
    }
    expect(results.slice(0, -1).every((result) => !result.ok && result.error === "superseded")).toBe(true);
    expect(results.at(-1)).toMatchObject({ ok: true, document: { sheet: { name: "Notes" } } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveBeenCalledWith(join(root, "data", "book.xlsx"), expect.any(AbortSignal));
  });

  it("reports another frame as busy without reading or superseding its owner", async () => {
    const read = vi.spyOn(documentInput, "readPreviewDocumentInput");
    const previous = readDocument(OK_FRAME, join(root, "data", "cyclic.xls"));
    await vi.waitFor(() => expect(getManagedChildProcessCount()).toBe(1));
    const otherFrame = await readDocument(OK_FRAME, join(root, "data", "people.csv"), 0, 1, 1);
    const readsWhileBusy = read.mock.calls.length;
    const latest = readDocument(OK_FRAME, join(root, "data", "people.csv"));
    const [oldResult, newResult] = await Promise.all([previous, latest]);
    expect(otherFrame).toMatchObject({ ok: false, error: "busy" });
    expect(readsWhileBusy).toBe(1);
    expect(oldResult).toMatchObject({ ok: false, error: "superseded" });
    expect(newResult).toMatchObject({ ok: true });
  });

  it("fails clearly if an admitted frame lacks its runtime identity", async () => {
    const read = vi.spyOn(documentInput, "readPreviewDocumentInput");
    const handler = handlers.get(CHANNELS.preview.readDocument)!;
    expect(await handler({ senderFrame: { url: OK_FRAME } }, join(root, "data", "people.csv"), 0))
      .toMatchObject({ ok: false, error: "read-failed" });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns a parsed table for a CSV inside the allow-list, never raw bytes", async () => {
    const res = await readDocument(OK_FRAME, join(root, "data", "people.csv"));
    if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
    expect(res.document.format).toBe("csv");
    if (!("sheet" in res.document)) throw new Error("Expected a table preview.");
    expect(res.document.sheet.rows).toEqual([["name", "age"], ["alice", "30"], ["bob", "41"]]);
    expect(JSON.stringify(res)).not.toContain("content");
  });

  it("returns the requested workbook sheet and the tab list", async () => {
    const res = await readDocument(OK_FRAME, join(root, "data", "book.xlsx"), 1);
    if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
    if (!("sheet" in res.document)) throw new Error("Expected a table preview.");
    expect(res.document.sheetNames).toEqual(["Sales", "Notes"]);
    expect(res.document.sheet).toMatchObject({ index: 1, name: "Notes", rows: [["note"]] });
  });

  it("audits a successful read with a redacted path", async () => {
    await readDocument(OK_FRAME, join(root, "data", "people.csv"));
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining(CHANNELS.preview.readDocument),
    }));
  });

  it("rejects a non-host frame", async () => {
    const res = await readDocument(EVIL_FRAME, join(root, "data", "people.csv"));
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("applies the read_file guard: outside the allow-list, through a symlink, sensitive paths, globs", async () => {
    expect(await readDocument(OK_FRAME, join(outside, "secret.csv"))).toMatchObject({ ok: false, error: "path-not-allowed" });
    expect(await readDocument(OK_FRAME, join(root, "link-out", "secret.csv"))).toMatchObject({ ok: false, error: "path-not-allowed" });
    expect(await readDocument(OK_FRAME, join(homedir(), ".ssh", "known_hosts.csv"))).toMatchObject({ ok: false, error: "sensitive-path" });
    expect(await readDocument(OK_FRAME, "**/*.csv")).toMatchObject({ ok: false, error: "not-a-file" });
  });

  it("rejects bad arguments and non-table files", async () => {
    expect(await readDocument(OK_FRAME, "")).toMatchObject({ ok: false, error: "not-a-file" });
    expect(await readDocument(OK_FRAME, join(root, "data", "people.csv"), -1)).toMatchObject({ ok: false, error: "invalid-index" });
    expect(await readDocument(OK_FRAME, join(root, "data", "people.csv"), "0")).toMatchObject({ ok: false, error: "invalid-index" });
    expect(await readDocument(OK_FRAME, join(root, "notes.txt"))).toMatchObject({ ok: false, error: "unsupported-format" });
    expect(await readDocument(OK_FRAME, join(root, "data", "missing.csv"))).toMatchObject({ ok: false, error: "read-failed" });
    expect(await readDocument(OK_FRAME, join(root, "data"))).toMatchObject({ ok: false, error: "unsupported-format" });
  });

  it("refuses an over-size file from its stat, before reading it", async () => {
    expect(await readDocument(OK_FRAME, join(root, "data", "huge.csv"))).toMatchObject({
      ok: false,
      error: "too-large",
      bytes: PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1,
    });
  });

  it("refuses a zip bomb and a corrupt workbook with distinct codes", async () => {
    expect(await readDocument(OK_FRAME, join(root, "data", "bomb.xlsx"))).toMatchObject({ ok: false, error: "archive-too-large" });
    expect(await readDocument(OK_FRAME, join(root, "data", "broken.xlsx"))).toMatchObject({ ok: false, error: "corrupt-document" });
  });

  it("maps fatal delimited errors through the private document channel", async () => {
    expect(await readDocument(OK_FRAME, join(root, "data", "broken.csv")))
      .toMatchObject({ ok: false, error: "corrupt-document" });
  });

  it("keeps the host responsive and reaps a cyclic document at the deadline", async () => {
    let ticks = 0;
    const pulse = setInterval(() => { ticks += 1; }, 20);
    const started = performance.now();
    try {
      expect(await readDocument(OK_FRAME, join(root, "data", "cyclic.xls")))
        .toMatchObject({ ok: false, error: "parse-limit" });
    } finally {
      clearInterval(pulse);
    }
    expect(ticks).toBeGreaterThan(10);
    expect(performance.now() - started).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs + 2_000);
    expect(await readDocument(OK_FRAME, join(root, "data", "people.csv"))).toMatchObject({ ok: true });
  });
});

async function editFromSender(event: ReturnType<typeof documentEvent>, request: unknown): Promise<XlsxPanelEditResult> {
  return await handlers.get(CHANNELS.preview.editXlsx)!(event, request) as XlsxPanelEditResult;
}

async function readEditToken(event: ReturnType<typeof documentEvent>): Promise<string> {
  const result = await readFromSender(event, join(root, "data", "book.xlsx"));
  if (!result.ok) throw new Error(`Expected a workbook preview, got ${result.error}`);
  expect(result.document).toMatchObject({ format: "xlsx", sheet: { rows: [["q", "rev"], ["Q1", "10"]] } });
  expect(result.editToken).toMatch(/^[a-f0-9]{64}$/);
  return result.editToken!;
}

describe("preview:edit-xlsx boundary", () => {
  it.each(["source", "directory", "backup"] as const)("keeps a readable workbook uneditable when the write deny floor covers its %s", async (target) => {
    const path = join(root, "data", "book.xlsx");
    const denied = target === "directory" ? join(root, "data") : target === "backup" ? `${path}.ave-bak` : path;
    const floor = vi.spyOn(sandboxPolicy, "getDefaultSensitiveWriteDenyPaths").mockReturnValue([denied]);
    const event = documentEvent(OK_FRAME);
    try {
      const result = await readFromSender(event, path);
      if (!result.ok) throw new Error(`Expected a readable workbook, got ${result.error}`);
      expect(result.document).toMatchObject({ format: "xlsx", sheet: { rows: [["q", "rev"], ["Q1", "10"]] } });
      expect(floor).toHaveBeenCalled();
      expect(result.editToken).toBeUndefined();
      expect(event.sender.eventNames()).toEqual([]);
      expect(getManagedChildProcessCount()).toBe(0);
    } finally { event.sender.emit("destroyed"); }
  });

  it.each(["source", "directory", "backup"] as const)("keeps a readable workbook uneditable when the protected read floor covers its %s", async (target) => {
    const path = join(root, "data", "book.xlsx");
    const denied = target === "directory" ? join(root, "data") : target === "backup" ? `${path}.ave-bak` : path;
    const floor = vi.spyOn(sandboxPolicy, "getProtectedReadDenyFloor").mockReturnValue([denied]);
    const event = documentEvent(OK_FRAME);
    try {
      const result = await readFromSender(event, path);
      if (!result.ok) throw new Error(`Expected a readable workbook, got ${result.error}`);
      expect(result.document).toMatchObject({ format: "xlsx", sheet: { rows: [["q", "rev"], ["Q1", "10"]] } });
      expect(floor).toHaveBeenCalled();
      expect(result.editToken).toBeUndefined();
      expect(event.sender.eventNames()).toEqual([]);
      expect(getManagedChildProcessCount()).toBe(0);
    } finally { event.sender.emit("destroyed"); }
  });

  it.each([
    { path: "/outside/other.xlsx" },
    { script: "arbitrary-script.cjs" },
    { sheet: 1 },
  ])("rejects extra target or executable fields %j on a real preview token", async (extra) => {
    const event = documentEvent(OK_FRAME);
    try {
      const token = await readEditToken(event);
      expect(await editFromSender(event, { action: "save", token, row: 1, column: 1, value: 84, ...extra }))
        .toEqual({ ok: false, error: "invalid-request" });
      expect(getManagedChildProcessCount()).toBe(0);
    } finally { event.sender.emit("destroyed"); }
  });

  it.each([[2, 0], [1, 1]])("rejects a real token used by sender %s frame %s", async (senderId, routingId) => {
    const owner = documentEvent(OK_FRAME);
    try {
      const token = await readEditToken(owner);
      const foreign = documentEvent(OK_FRAME, senderId, routingId);
      expect(await editFromSender(foreign, { action: "cell", row: 0, column: 1, token }))
        .toEqual({ ok: false, error: "expired" });
      expect(getManagedChildProcessCount()).toBe(0);
    } finally { owner.sender.emit("destroyed"); }
  });

  it("rejects an untrusted frame before consuming a real preview token", async () => {
    const owner = documentEvent(OK_FRAME);
    try {
      const token = await readEditToken(owner);
      expect(await editFromSender(documentEvent(EVIL_FRAME), { action: "cell", row: 0, column: 1, token }))
        .toEqual({ ok: false, error: "unauthorized" });
      expect(getManagedChildProcessCount()).toBe(0);
    } finally { owner.sender.emit("destroyed"); }
  });

  it.each([
    { senderFrame: { url: OK_FRAME, processId: 1, routingId: 0 } },
    { sender: { id: 1 }, senderFrame: { url: OK_FRAME } },
  ])("rejects incomplete edit sender identities %j", async (event) => {
    expect(await handlers.get(CHANNELS.preview.editXlsx)!(event, { action: "cell", row: 0, column: 1, token: "a".repeat(64) }))
      .toEqual({ ok: false, error: "unauthorized" });
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("invalidates the previous token when the same frame reads the next sheet", async () => {
    const event = documentEvent(OK_FRAME);
    try {
      const token = await readEditToken(event);
      const next = await readFromSender(event, join(root, "data", "book.xlsx"), 1);
      if (!next.ok) throw new Error("Expected the replacement workbook preview");
      expect(next.document).toMatchObject({ sheet: { name: "Notes", rows: [["note"]] } });
      expect(next.editToken).toMatch(/^[a-f0-9]{64}$/);
      expect(next.editToken).not.toBe(token);
      expect(await editFromSender(event, { action: "cell", row: 0, column: 1, token }))
        .toEqual({ ok: false, error: "expired" });
      expect(getManagedChildProcessCount()).toBe(0);
    } finally { event.sender.emit("destroyed"); }
  });

  it("invalidates the previous token even when the replacement read is refused", async () => {
    const event = documentEvent(OK_FRAME);
    try {
      const token = await readEditToken(event);
      expect(await readFromSender(event, join(outside, "secret.csv")))
        .toMatchObject({ ok: false, error: "path-not-allowed" });
      expect(await editFromSender(event, { action: "cell", row: 0, column: 1, token }))
        .toEqual({ ok: false, error: "expired" });
      expect(getManagedChildProcessCount()).toBe(0);
    } finally { event.sender.emit("destroyed"); }
  });

  it("invalidates a workbook token when its frame switches to a text preview", async () => {
    const event = documentEvent(OK_FRAME);
    try {
      const token = await readEditToken(event);
      const text = await handlers.get(CHANNELS.preview.readFile)!(event, join(root, "notes.txt"));
      expect(text).toMatchObject({ ok: true, content: "plain" });
      expect(await editFromSender(event, { action: "cell", row: 0, column: 1, token }))
        .toEqual({ ok: false, error: "expired" });
      expect(event.sender.eventNames()).toEqual([]);
      expect(getManagedChildProcessCount()).toBe(0);
    } finally { event.sender.emit("destroyed"); }
  });

  it("invalidates a completed preview token on committed owner-frame navigation", async () => {
    const event = documentEvent(OK_FRAME);
    try {
      const token = await readEditToken(event);
      expect(event.sender.listenerCount("did-frame-navigate")).toBe(1);
      event.sender.emit("did-frame-navigate", {}, "file:///app/next.html", 200, "OK", true, 1, 0);
      expect(await editFromSender(event, { action: "cell", row: 0, column: 1, token }))
        .toEqual({ ok: false, error: "expired" });
      expect(event.sender.eventNames()).toEqual([]);
      expect(getManagedChildProcessCount()).toBe(0);
    } finally { event.sender.emit("destroyed"); }
  });
});
