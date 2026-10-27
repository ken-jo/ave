import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../tools/types.js";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  mode: "direct" as "direct" | "link",
  holder: null as unknown,
  visible: true,
  allowed: true,
  audit: vi.fn(),
}));
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => state.handlers.set(channel, handler) } }));
vi.mock("../app-state.js", () => ({
  findSessionMainWindowContents: (sessionId: string) => sessionId === "session-one" ? state.holder : null,
  mainWindowForContents: () => ({ isVisible: () => state.visible, isMinimized: () => false }),
}));
vi.mock("../../tools/file-read-core.js", () => ({ assertReadableFilePath: () => state.allowed ? { ok: true, resolved: "/workspace/book.xlsx" } : { ok: false, error: "path-not-allowed" } }));
vi.mock("../../permissions/permission-settings-store.js", () => ({ readPermissionSettings: () => ({ permissions: { additionalDirectories: [] } }) }));
vi.mock("../../permissions/allowed-directories.js", () => ({ buildRuntimeAllowedDirectories: () => [] }));
import { openDocumentForSession, registerDocumentOpenHandlers } from "../document-open.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

const context = (): ToolExecutionContext => ({ cwd: "/workspace", extraAllowedDirectories: [], metadata: { sessionId: "session-one" } });
const frame = { url: "file:///app/index.html" };
const sender = Object.assign(new EventEmitter(), { id: 12, mainFrame: frame, isDestroyed: () => false, send: vi.fn() });
const acknowledge = (payload: unknown, source: unknown = sender, sourceFrame: unknown = frame) => state.handlers.get(CHANNELS.preview.documentOpenAck)!({ sender: source, senderFrame: sourceFrame }, payload);
const request = () => sender.send.mock.calls.at(-1)![1] as { requestId: string; sessionId: string; path: string };

beforeEach(() => {
  vi.useFakeTimers();
  state.mode = "direct"; state.holder = sender; state.visible = true; state.allowed = true;
  sender.removeAllListeners(); sender.send.mockReset(); state.audit.mockReset();
  registerDocumentOpenHandlers({ settingsService: { get: () => ({ openMode: state.mode }) }, auditLogger: { log: state.audit } } as never);
});
afterEach(() => { vi.useRealTimers(); });

describe("document panel opening", () => {
  it("waits for the originating session's guarded acknowledgement", async () => {
    let settled = false;
    const result = openDocumentForSession("/workspace/book.xlsx", context()).then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(request()).toMatchObject({ sessionId: "session-one", path: "/workspace/book.xlsx" });
    expect(await acknowledge({ ...request(), opened: true }, { id: 999 })).toEqual({ ok: false, error: "unauthorized" });
    expect(await acknowledge({ ...request(), opened: true }, sender, { url: "https://evil.example/" })).toEqual({ ok: false, error: "unauthorized" });
    expect(await acknowledge({ ...request(), opened: true })).toEqual({ ok: true });
    expect(await result).toMatchObject({ isError: false });
    expect(sender.listenerCount("destroyed")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns a file link without sending a panel request in link mode", async () => {
    state.mode = "link";
    // The file tool passes a canonical absolute path, which carries a drive on Windows.
    const document = resolve("/workspace/a b.xlsx");
    const output = JSON.parse((await openDocumentForSession(document, context())).output);
    expect(output).toMatchObject({ mode: "link", opened: false, path: document });
    expect(output.fileLink).toMatch(process.platform === "win32"
      ? /^file:\/\/\/[A-Za-z]:\/workspace\/a%20b\.xlsx$/
      : /^file:\/\/\/workspace\/a%20b\.xlsx$/);
    expect(fileURLToPath(output.fileLink)).toBe(document);
    expect(sender.send).not.toHaveBeenCalled();
  });
  it("refuses an expired acknowledgement even before the overdue timer runs", async () => {
    const result = openDocumentForSession("/workspace/book.xlsx", context());
    const current = request();
    vi.setSystemTime(Date.now() + TOOL_TIMEOUT_POLICY.documentPanelAckMs + 1);
    expect(await acknowledge({ ...current, opened: true })).toEqual({ ok: false, error: "stale-request" });
    expect((await result).isError).toBe(true);
  });
  it.each(["direct", "link"] as const)("refuses a headless %s invocation", async (mode) => {
    state.mode = mode;
    const result = await openDocumentForSession("/workspace/book.xlsx", { ...context(), headless: true });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.parse(result.output).error).toBe("ui-unavailable");
    expect(sender.send).not.toHaveBeenCalled();
  });
  it.each(["missing-session", "hidden-window", "outside-preview-scope"])("does not dispatch when %s", async (failure) => {
    if (failure === "missing-session") state.holder = null;
    if (failure === "hidden-window") state.visible = false;
    if (failure === "outside-preview-scope") state.allowed = false;
    const result = await openDocumentForSession("/workspace/book.xlsx", context());
    expect(result.isError).toBe(true);
    expect(sender.send).not.toHaveBeenCalled();
  });
  it.each(["timeout", "destroyed", "aborted", "navigated"])("cleans pending requests after %s", async (reason) => {
    const controller = new AbortController();
    const result = openDocumentForSession("/workspace/book.xlsx", { ...context(), abortSignal: controller.signal });
    const pending = request();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.documentPanelAckMs);
    else if (reason === "aborted") controller.abort();
    else sender.emit(reason === "navigated" ? "did-start-navigation" : "destroyed");
    expect((await result).isError).toBe(true);
    expect(await acknowledge({ ...pending, opened: true })).toEqual({ ok: false, error: "stale-request" });
    expect(sender.listenerCount("destroyed")).toBe(0);
    expect(sender.listenerCount("did-start-navigation")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a late acknowledgement when the session moved to another window", async () => {
    const result = openDocumentForSession("/workspace/book.xlsx", context());
    const pending = request(); state.holder = null;
    expect(await acknowledge({ ...pending, opened: true })).toEqual({ ok: false, error: "stale-request" });
    expect((await result).isError).toBe(true);
  });
});
