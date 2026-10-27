import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewReadDocumentResult } from "../../../shared/preview-document.js";
import { buildPreviewDocumentRuntime } from "../../../__tests__/support/preview-document-runtime.js";
import { cyclicWorkbook } from "../../../__tests__/support/table-document-fixtures.js";
import * as documentInput from "../../../tools/preview-document-input.js";
import { getManagedChildProcessCount } from "../../../main/managed-child-processes.js";
import * as managedChildren from "../../../main/managed-child-processes.js";
import { validateHostRendererSender } from "../../gated.js";
import { setSessionContentsLookup } from "../../../main/app-state.js";
import { observeAgentDocumentMutation, runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../../../tools/agent-observation-context.js";
import type { DocumentObservationEvent } from "../../../shared/agent-observation.js";

const { handlers, additionalDirectories, childRuntime, defaultSession, messageBox, openPath } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  additionalDirectories: { value: [] as string[] },
  childRuntime: { mainDir: "" },
  defaultSession: {},
  messageBox: vi.fn(),
  openPath: vi.fn(async () => ""),
}));

vi.mock("../../../main/main-paths.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../main/main-paths.js")>(),
  get mainDir() { return childRuntime.mainDir; },
}));

vi.mock("electron", () => ({
  session: { defaultSession },
  dialog: { showMessageBox: messageBox },
  nativeImage: {},
  shell: { openPath },
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

import { registerPreviewHandlers, type PreviewReadFileResult } from "../preview.js";
import { registerAttachHandlers } from "../attach.js";
import { CHANNELS } from "../../../contract/app-contract.js";

const auditLog = vi.fn();
const appWindows: Array<{ isDestroyed: () => boolean; webContents: object }> = [];
const deps = { auditLogger: { log: auditLog }, getAppWindows: () => appWindows, getMainWindow: () => null } as never;
const OK_FRAME = "file:///app/index.html";
const EVIL_FRAME = "https://evil.example.com/x";
const dirLinkType = process.platform === "win32" ? "junction" : "dir";

let root: string;
let outside: string;

function documentEvent(url: string, senderId = 1, routingId = 0) {
  const frame = { url, processId: senderId, routingId, detached: false, isDestroyed: (): boolean => false };
  const sender = Object.assign(new EventEmitter(), { id: senderId, mainFrame: frame, isDestroyed: (): boolean => false,
    getType: (): string => "window", session: defaultSession, send: vi.fn() });
  appWindows.push({ isDestroyed: () => false, webContents: sender });
  return { sender, senderFrame: frame };
}

async function readFromSender(event: ReturnType<typeof documentEvent>, path: unknown, sheetIndex: unknown = 0, sessionId?: string) {
  const handler = handlers.get(CHANNELS.preview.readDocument)!;
  return (await handler(event, path, sheetIndex, sessionId)) as PreviewReadDocumentResult;
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
  registerPreviewHandlers(deps);
  registerAttachHandlers(deps);
  appWindows.length = 0;
  messageBox.mockReset();
  openPath.mockClear();
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
    const event = documentEvent(OK_FRAME);
    try {
      const pending = readFromSender(event, join(root, "data", outcome === "abort" ? "cyclic.xls" : "people.csv"));
      if (outcome === "abort") {
        await vi.waitFor(() => expect(getManagedChildProcessCount()).toBe(1));
        event.sender.emit("destroyed");
      }
      const result = await pending;
      if (outcome === "abort") expect(result).toMatchObject({ ok: false, error: "superseded" });
      else expect(result).toMatchObject({ ok: true });
      const timers = watchTimers();
      expect(timers).toHaveLength(outcome === "completion" ? 2 : 1);
      expect(cleared).toHaveBeenCalledWith(timers[0]);
      if (outcome === "completion") {
        expect(cleared).not.toHaveBeenCalledWith(timers[1]);
        event.sender.emit("destroyed");
        expect(cleared).toHaveBeenCalledWith(timers[1]);
      }
    } finally {
      event.sender.emit("destroyed");
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

  it.each(["people.csv", "broken.csv", "missing.csv"])("retains only a successful read's action receipt lifetime for %s", async (name) => {
    const event = documentEvent(OK_FRAME);
    const result = await readFromSender(event, join(root, "data", name));
    expect(event.sender.eventNames().sort()).toEqual(result.ok
      ? ["destroyed", "did-frame-navigate", "did-start-navigation", "render-process-gone"] : []);
    event.sender.emit("destroyed");
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
    const childrenAtRead: number[] = [];
    const inputReads = vi.spyOn(documentInput, "readPreviewDocumentInput").mockImplementation((...args) => {
      childrenAtRead.push(getManagedChildProcessCount());
      return read(...args);
    });
    const previous = readDocument(OK_FRAME, join(root, "data", "cyclic.xls"));
    await vi.waitFor(() => expect(getManagedChildProcessCount()).toBe(1));
    const latest = readDocument(OK_FRAME, join(root, "data", "book.xlsx"), 1);
    const [oldResult, newResult] = await Promise.all([previous, latest]);
    expect(oldResult).toMatchObject({ ok: false, error: "superseded" });
    expect(newResult).toMatchObject({ ok: true, document: { sheet: { name: "Notes" } } });
    expect(inputReads).toHaveBeenCalledTimes(2);
    expect(childrenAtRead).toEqual([0, 0]);
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("keeps only the latest same-frame request while an older read unwinds", async () => {
    const read = documentInput.readPreviewDocumentInput;
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
    } finally {
      resume();
      results = await Promise.all([previous, ...replacements]);
    }
    expect(results.slice(0, -1).every((result) => !result.ok && result.error === "superseded")).toBe(true);
    expect(results.at(-1)).toMatchObject({ ok: true, document: { sheet: { name: "Notes" } } });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(join(root, "data", "book.xlsx"), expect.any(AbortSignal));
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

  it("rejects a frame without its registered native identity", async () => {
    const read = vi.spyOn(documentInput, "readPreviewDocumentInput");
    const handler = handlers.get(CHANNELS.preview.readDocument)!;
    expect(await handler({ senderFrame: { url: OK_FRAME } }, join(root, "data", "people.csv"), 0))
      .toMatchObject({ ok: false, error: "unauthorized" });
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

describe("read-only observation sender boundary", () => {
  const ack = (event: unknown, targetId: string, extra = {}) => handlers.get(CHANNELS.preview.observationAck)!(event,
    { action: "rendered", targetId, sessionId: "session-one", seq: 0, ...extra });

  async function registerSessionOwner(event: ReturnType<typeof documentEvent>) {
    // The session lookup still requires the actual main-window registration.
    const state = await import("../../../main/app-state.js");
    state.registerMainWindow({ id: event.sender.id, webContents: event.sender, isDestroyed: () => false } as never, "primary");
    setSessionContentsLookup((sessionId) => sessionId === "session-one" ? event.sender as never : null);
  }

  async function observedPreview(event: ReturnType<typeof documentEvent>) {
    await registerSessionOwner(event);
    const result = await readFromSender(event, join(root, "data", "book.xlsx"), 0, "session-one");
    if (!result.ok || !result.observation) throw new Error("Expected an observation baseline");
    return result.observation;
  }

  afterEach(async () => {
    const state = await import("../../../main/app-state.js");
    for (const window of state.getMainWindows()) state.unregisterMainWindow(window);
    setSessionContentsLookup(null);
  });

  it("binds a full text preview to exactly its displayed bytes, frame and session", async () => {
    const event = documentEvent(OK_FRAME);
    await registerSessionOwner(event);
    const result = await handlers.get(CHANNELS.preview.readFile)!(event, join(root, "notes.txt"), { sessionId: "session-one" }) as PreviewReadFileResult;
    expect(result).toMatchObject({ ok: true, content: "plain", lineCount: 1,
      document: { format: "text", content: "plain", lines: ["plain"], totalLines: 1, truncated: false },
      observation: { sessionId: "session-one", seq: 0 } });
    expect(await ack(event, result.observation!.targetId)).toEqual({ ok: true });
    expect(await ack(event, result.observation!.targetId, { path: join(root, "other.txt") })).toEqual({ ok: false, error: "bad-request" });
    expect(await ack(event, result.observation!.targetId, { sessionId: "different-session" })).toEqual({ ok: false, error: "unauthorized" });
    expect(messageBox).not.toHaveBeenCalled();
    event.sender.emit("destroyed");
  });

  it.each(["text", "table"])("opens a successfully read %s file for its actual app frame without widening attachment reads", async (kind) => {
    const event = documentEvent(OK_FRAME);
    await registerSessionOwner(event);
    const result = kind === "text"
      ? await handlers.get(CHANNELS.preview.readFile)!(event, join(root, "notes.txt"), { sessionId: "session-one" }) as PreviewReadFileResult
      : await readFromSender(event, join(root, "data", "book.xlsx"), 0, "session-one");
    expect(result.ok).toBe(true);
    expect(await handlers.get(CHANNELS.attach.openExternal)!(event, result.path)).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledExactlyOnceWith(result.path);
    expect(await handlers.get(CHANNELS.attach.readImage)!(event, result.path)).toEqual({ ok: false, error: "path_not_authorized" });
    const other = documentEvent(OK_FRAME, 42);
    expect(await handlers.get(CHANNELS.attach.openExternal)!(other, result.path)).toEqual({ ok: false, error: "path_not_authorized" });
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(messageBox).not.toHaveBeenCalled();
    event.sender.emit("destroyed"); other.sender.emit("destroyed");
  });

  it("refuses arbitrary paths and revokes a preview opener receipt when its session or scope is lost", async () => {
    const event = documentEvent(OK_FRAME);
    await registerSessionOwner(event);
    const result = await handlers.get(CHANNELS.preview.readFile)!(event, join(root, "notes.txt"), { sessionId: "session-one" }) as PreviewReadFileResult;
    expect(await handlers.get(CHANNELS.attach.openExternal)!(event, join(root, "unread.txt"))).toEqual({ ok: false, error: "path_not_authorized" });
    setSessionContentsLookup(null);
    expect(await handlers.get(CHANNELS.attach.openExternal)!(event, result.path)).toEqual({ ok: false, error: "path_not_authorized" });
    setSessionContentsLookup(() => event.sender as never);
    expect(await handlers.get(CHANNELS.attach.openExternal)!(event, result.path)).toEqual({ ok: false, error: "path_not_authorized" });
    await handlers.get(CHANNELS.preview.readFile)!(event, join(root, "notes.txt"), { sessionId: "session-one" });
    additionalDirectories.value = [];
    expect(await handlers.get(CHANNELS.attach.openExternal)!(event, result.path)).toEqual({ ok: false, error: "path_not_authorized" });
    expect(openPath).not.toHaveBeenCalled();
    event.sender.emit("destroyed");
  });

  it.each(["did-frame-navigate", "did-start-navigation", "destroyed"])("revokes preview opener receipts on %s", async (lifecycle) => {
    const event = documentEvent(OK_FRAME);
    await registerSessionOwner(event);
    const result = await handlers.get(CHANNELS.preview.readFile)!(event, join(root, "notes.txt"), { sessionId: "session-one" }) as PreviewReadFileResult;
    if (lifecycle === "did-start-navigation") event.sender.emit(lifecycle, {}, OK_FRAME, false, true, event.sender.id, event.senderFrame.routingId);
    else event.sender.emit(lifecycle, {}, OK_FRAME, 200, "OK", true, event.sender.id, event.senderFrame.routingId);
    expect(await handlers.get(CHANNELS.attach.openExternal)!(event, result.path)).toEqual({ ok: false, error: "path_not_authorized" });
    expect(openPath).not.toHaveBeenCalled();
    event.sender.emit("destroyed");
  });

  it("rechecks app-window identity after resolving the default-app target", async () => {
    const event = documentEvent(OK_FRAME);
    await registerSessionOwner(event);
    const result = await handlers.get(CHANNELS.preview.readFile)!(event, join(root, "notes.txt"), { sessionId: "session-one" }) as PreviewReadFileResult;
    const realpath = fs.realpath;
    vi.spyOn(fs, "realpath").mockImplementationOnce(async (...args) => {
      const target = await realpath(...args);
      appWindows.length = 0;
      return target;
    });
    expect(await handlers.get(CHANNELS.attach.openExternal)!(event, result.path)).toEqual({ ok: false, error: "unauthorized" });
    expect(openPath).not.toHaveBeenCalled();
    event.sender.emit("destroyed");
  });

  it.each(["command", "tool", "js", "wsf", "desktop", "html", "svg", "lnk", "exe"])("never turns a preview of .%s into executable opener authority", async (extension) => {
    const event = documentEvent(OK_FRAME);
    await registerSessionOwner(event);
    const path = join(root, `not-passive.${extension}`);
    writeFileSync(path, "inert source display");
    const result = await handlers.get(CHANNELS.preview.readFile)!(event, path, { sessionId: "session-one" }) as PreviewReadFileResult;
    expect(result.ok).toBe(true);
    expect(await handlers.get(CHANNELS.attach.openExternal)!(event, result.path)).toEqual({ ok: false, error: "path_not_authorized" });
    expect(openPath).not.toHaveBeenCalled();
    event.sender.emit("destroyed");
  });

  it("keeps at most sixteen frame-bound preview opener receipts", async () => {
    const event = documentEvent(OK_FRAME);
    const results: PreviewReadFileResult[] = [];
    for (let index = 0; index < 17; index += 1) {
      const path = join(root, `preview-open-${index}.ts`);
      writeFileSync(path, "const value = 1;");
      results.push(await handlers.get(CHANNELS.preview.readFile)!(event, path) as PreviewReadFileResult);
    }
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await handlers.get(CHANNELS.attach.openExternal)!(event, results[0].path)).toEqual({ ok: false, error: "path_not_authorized" });
    expect(await handlers.get(CHANNELS.attach.openExternal)!(event, results[16].path)).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledExactlyOnceWith(results[16].path);
    event.sender.emit("destroyed");
  });

  it.each(["latest-first", "stale-first"])("keeps the latest text baseline alive across overlapping reloads (%s)", async (order) => {
    const event = documentEvent(OK_FRAME);
    await registerSessionOwner(event);
    const path = join(root, "text-reload-race.ts");
    writeFileSync(path, "const value = 1;\n");
    const read = documentInput.readPreviewDocumentInput;
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    let startedFirst!: () => void;
    let startedSecond!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    const secondStarted = new Promise<void>((resolve) => { startedSecond = resolve; });
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { resolveSecond = resolve; });
    vi.spyOn(documentInput, "readPreviewDocumentInput")
      .mockImplementationOnce(async (...args) => { const bytes = await read(...args); startedFirst(); await firstGate; return bytes; })
      .mockImplementationOnce(async (...args) => { const bytes = await read(...args); startedSecond(); await secondGate; return bytes; });
    const handler = handlers.get(CHANNELS.preview.readFile)!;
    const first = handler(event, path, { sessionId: "session-one" }) as Promise<PreviewReadFileResult>;
    await firstStarted;
    const second = handler(event, path, { sessionId: "session-one" }) as Promise<PreviewReadFileResult>;
    try {
      await secondStarted;
      if (order === "stale-first") {
        resolveFirst();
        expect(await first).toMatchObject({ ok: false, error: "read-failed", message: "Preview read was superseded." });
      }
      resolveSecond();
      const latest = await second;
      expect(latest).toMatchObject({ ok: true, observation: { sessionId: "session-one", seq: 0 } });
      expect(await ack(event, latest.observation!.targetId)).toEqual({ ok: true });
      resolveFirst();
      const stale = await first;
      expect(stale).toMatchObject({ ok: false, error: "read-failed", message: "Preview read was superseded." });
      expect(stale.observation).toBeUndefined();
      expect(await ack(event, latest.observation!.targetId)).toEqual({ ok: true });
      const identity = { sessionId: "session-one", turnId: "text-turn", toolUseId: "text-write" };
      await runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity, () =>
        observeAgentDocumentMutation([{ path, content: "const value = 42;\n" }], async () => { writeFileSync(path, "const value = 42;\n"); })));
      const events = (): DocumentObservationEvent[] => event.sender.send.mock.calls
        .filter(([channel]) => channel === CHANNELS.preview.observationEvents).flatMap(([, batch]) => batch as DocumentObservationEvent[]);
      await vi.waitFor(() => expect(events().find((entry) => entry.kind === "element")).toMatchObject({
        actor: "agent", target: { id: latest.observation!.targetId }, before: "const value = 1;", after: "const value = 42;",
        element: { kind: "line", line: 1 }, advisory: false,
      }));
      expect(events().find((entry) => entry.kind === "snapshot")).toMatchObject({ after: { format: "text", lines: ["const value = 42;"] } });
    } finally {
      resolveFirst(); resolveSecond();
      await Promise.allSettled([first, second]);
      event.sender.emit("destroyed");
    }
  });

  it("cancels a pending observed text read on main-frame navigation", async () => {
    const event = documentEvent(OK_FRAME);
    await registerSessionOwner(event);
    const read = documentInput.readPreviewDocumentInput;
    let resolveRead!: () => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { resolveRead = resolve; });
    vi.spyOn(documentInput, "readPreviewDocumentInput").mockImplementationOnce(async (...args) => {
      const bytes = await read(...args); started(); await gate; return bytes;
    });
    const pending = handlers.get(CHANNELS.preview.readFile)!(event, join(root, "notes.txt"), { sessionId: "session-one" }) as Promise<PreviewReadFileResult>;
    try {
      await readStarted;
      event.sender.emit("did-frame-navigate", {}, OK_FRAME, 200, "OK", true, event.sender.id, event.senderFrame.routingId);
      resolveRead();
      const result = await pending;
      expect(result).toMatchObject({ ok: false, error: "read-failed", message: "Preview read was superseded." });
      expect(result.observation).toBeUndefined();
      expect(event.sender.listenerCount("did-frame-navigate")).toBe(0);
    } finally { resolveRead(); await pending; event.sender.emit("destroyed"); }
  });

  it("bounds observed text request ownership and releases it after completion", async () => {
    const event = documentEvent(OK_FRAME);
    event.sender.setMaxListeners(0);
    const read = documentInput.readPreviewDocumentInput;
    let resolveReads!: () => void;
    const gate = new Promise<void>((resolve) => { resolveReads = resolve; });
    const input = vi.spyOn(documentInput, "readPreviewDocumentInput").mockImplementation(async (...args) => {
      const bytes = await read(...args); await gate; return bytes;
    });
    const handler = handlers.get(CHANNELS.preview.readFile)!;
    const pending = Array.from({ length: 16 }, (_, index) => {
      const path = join(root, `bounded-text-${index}.txt`);
      writeFileSync(path, "plain");
      return handler(event, path, { sessionId: "session-one" }) as Promise<PreviewReadFileResult>;
    });
    try {
      expect(await handler(event, join(root, "notes.txt"), { sessionId: "session-one" }))
        .toMatchObject({ ok: false, error: "read-failed", message: "Preview request limit exceeded." });
      await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(16));
      resolveReads();
      expect((await Promise.all(pending)).every((result) => result.ok)).toBe(true);
      expect(await handler(event, join(root, "notes.txt"), { sessionId: "session-one" })).toMatchObject({ ok: true, content: "plain" });
    } finally { resolveReads(); await Promise.allSettled(pending); event.sender.emit("destroyed"); }
  });

  it("does not observe text windows, missing sessions, or a different session owner", async () => {
    const event = documentEvent(OK_FRAME);
    await registerSessionOwner(event);
    for (const options of [undefined, { offset: 0, limit: 1, sessionId: "session-one" }, { sessionId: "different-session" }]) {
      const result = await handlers.get(CHANNELS.preview.readFile)!(event, join(root, "notes.txt"), options) as PreviewReadFileResult;
      expect(result.ok).toBe(true);
      expect(result.observation).toBeUndefined();
      expect(result.document).toBeUndefined();
    }
    event.sender.emit("destroyed");
  });

  it("refuses text observation for subframes or an app window lost during the read", async () => {
    const event = documentEvent(OK_FRAME);
    await registerSessionOwner(event);
    const subframe = { ...event, senderFrame: { ...event.senderFrame, routingId: 2 } };
    expect(await handlers.get(CHANNELS.preview.readFile)!(subframe, join(root, "notes.txt"), { sessionId: "session-one" }))
      .toMatchObject({ ok: false, error: "unauthorized" });
    const read = documentInput.readPreviewDocumentInput;
    vi.spyOn(documentInput, "readPreviewDocumentInput").mockImplementationOnce(async (...args) => {
      const bytes = await read(...args);
      appWindows.length = 0;
      return bytes;
    });
    expect(await handlers.get(CHANNELS.preview.readFile)!(event, join(root, "notes.txt"), { sessionId: "session-one" }))
      .toMatchObject({ ok: false, error: "unauthorized" });
    event.sender.emit("destroyed");
  });

  it.each(["plugin-ui-shell.html", "plugin-ui-shell.js"])("refuses a navigated webview at %s for reads and observation", async (asset) => {
    const owner = documentEvent(OK_FRAME);
    const binding = await observedPreview(owner);
    const plugin = documentEvent(`file:///app/${asset}`, 42);
    Object.assign(plugin.sender, { getType: () => "webview", session: {} });
    if (asset.endsWith(".js")) expect(validateHostRendererSender(plugin as never)).toBe(true);
    expect(await readFromSender(plugin, join(root, "data", "book.xlsx"), 0, "session-one"))
      .toMatchObject({ ok: false, error: "unauthorized" });
    expect(await handlers.get(CHANNELS.preview.readFile)!(plugin, join(root, "notes.txt"), { sessionId: "session-one" }))
      .toMatchObject({ ok: false, error: "unauthorized" });
    expect(await ack(plugin, binding.targetId)).toEqual({ ok: false, error: "unauthorized" });
    expect(await handlers.get(CHANNELS.attach.openExternal)!(plugin, join(root, "notes.txt")))
      .toEqual({ ok: false, error: "unauthorized" });
    owner.sender.emit("destroyed");
  });

  it("refuses subframes and accepts the actual app main frame without a modification confirmation", async () => {
    const event = documentEvent(OK_FRAME);
    const binding = await observedPreview(event);
    const subframe = { ...event, senderFrame: { ...event.senderFrame, routingId: 2 } };
    expect(await readFromSender(subframe, join(root, "data", "book.xlsx"), 0, "session-one"))
      .toMatchObject({ ok: false, error: "unauthorized" });
    expect(await ack(subframe, binding.targetId)).toEqual({ ok: false, error: "unauthorized" });
    expect(await handlers.get(CHANNELS.attach.openExternal)!(subframe, join(root, "notes.txt")))
      .toEqual({ ok: false, error: "unauthorized" });
    expect(await ack(event, binding.targetId)).toEqual({ ok: true });
    expect(messageBox).not.toHaveBeenCalled();
    event.sender.emit("destroyed");
  });

  it("rejects arbitrary paths and scripts in the read-only acknowledgement", async () => {
    const event = documentEvent(OK_FRAME);
    const binding = await observedPreview(event);
    expect(await ack(event, binding.targetId, { path: join(outside, "secret.csv") })).toEqual({ ok: false, error: "bad-request" });
    expect(await ack(event, binding.targetId, { script: "other.cjs" })).toEqual({ ok: false, error: "bad-request" });
    expect(handlers.has("ave:preview:edit-xlsx")).toBe(false);
    event.sender.emit("destroyed");
  });

  it("refuses an app window unregistered during a read", async () => {
    const event = documentEvent(OK_FRAME);
    const read = documentInput.readPreviewDocumentInput;
    vi.spyOn(documentInput, "readPreviewDocumentInput").mockImplementationOnce(async (...args) => {
      const bytes = await read(...args);
      appWindows.length = 0;
      return bytes;
    });
    expect(await readFromSender(event, join(root, "data", "book.xlsx")))
      .toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("revokes a baseline when its main-frame registration disappears", async () => {
    const event = documentEvent(OK_FRAME);
    const binding = await observedPreview(event);
    appWindows.length = 0;
    expect(await ack(event, binding.targetId)).toEqual({ ok: false, error: "unauthorized" });
    event.sender.emit("destroyed");
  });
});
