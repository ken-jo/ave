import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronApplication } from "playwright";
import type { TestInfo } from "@playwright/test";

const { execute, currentPlatform } = vi.hoisted(() => ({ execute: vi.fn(), currentPlatform: vi.fn(() => "darwin") }));
vi.mock("node:child_process", () => ({ execFile: execute }));
vi.mock("node:os", () => ({ platform: currentPlatform }));
import { withNativeFocusDiagnostics } from "../e2e/ui/native-focus.js";

function fixture() {
  const frame = {};
  const window = { id: 1, isVisible: () => true, isMinimized: () => false, isFocused: () => false,
    isModal: () => true, getParentWindow: () => ({ id: 2 }),
    webContents: { id: 11, isFocused: () => false, focusedFrame: frame, mainFrame: frame } };
  const native = { focusedWindowId: null, windows: [{ id: 1, visible: true, minimized: false, focused: false, modal: true, parentId: 2, chromeId: 11, contentsFocused: false, mainFrameFocused: true }] };
  const evaluate = vi.fn(async (reader: (context: unknown) => unknown) => reader({
    BaseWindow: { getFocusedWindow: () => null, getAllWindows: () => [window] },
    webContents: { getAllWebContents: () => [window.webContents] },
  }));
  const app = { evaluate, process: () => ({ pid: 1234 }) } as unknown as ElectronApplication;
  const attach = vi.fn<TestInfo["attach"]>(async () => {});
  return { app, evaluate, attach, native };
}

beforeEach(() => {
  execute.mockReset(); currentPlatform.mockReturnValue("darwin");
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  execute.mockImplementation((file, _args, _options, done) => done(null,
    file === "/usr/bin/osascript" ? '{"name":"loginwindow","pid":433,"active":true}'
      : '"CGSSessionScreenIsLocked"=Yes,"CGSSessionScreenLockedTime"=1794184858', ""));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("native focus diagnostics", () => {
  it("does no desktop inspection when the original focus assertion passes", async () => {
    const { app, evaluate, attach } = fixture();
    expect(await withNativeFocusDiagnostics(app, { attach }, async () => 42)).toBe(42);
    expect(evaluate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled();
  });
  it("records a locked desktop and native window state while preserving the original failure", async () => {
    const { app, attach, native } = fixture();
    const failure = new Error("Native focus assertion failed");
    await expect(withNativeFocusDiagnostics(app, { attach }, async () => { throw failure; })).rejects.toBe(failure);
    const payload = JSON.parse(String(attach.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({ expectedPid: 1234, desktop: { locked: true, lockedAt: "2026-11-09T00:40:58.000Z", frontmost: { name: "loginwindow", pid: 433 } }, native });
  });
  it("preserves the assertion failure when desktop inspection is unavailable", async () => {
    const { app, attach } = fixture();
    execute.mockImplementation((_file, _args, _options, done) => done(new Error("Desktop inspection unavailable"), "", ""));
    const failure = new Error("Native focus assertion failed");
    await expect(withNativeFocusDiagnostics(app, { attach }, async () => { throw failure; })).rejects.toBe(failure);
    expect(JSON.parse(String(attach.mock.calls[0]?.[1]?.body)).desktop.unavailable).toBe("Desktop inspection unavailable");
  });
  it("does not replace a focus failure when attachment collection fails", async () => {
    const { app, attach } = fixture(); attach.mockRejectedValueOnce(new Error("Attachment unavailable"));
    const failure = new Error("Native focus assertion failed");
    await expect(withNativeFocusDiagnostics(app, { attach }, async () => { throw failure; })).rejects.toBe(failure);
  });
  it("preserves the focus failure when native window inspection is no longer available", async () => {
    const { app, evaluate, attach } = fixture(); evaluate.mockRejectedValueOnce(new Error("Window closed"));
    const failure = new Error("Native focus assertion failed");
    await expect(withNativeFocusDiagnostics(app, { attach }, async () => { throw failure; })).rejects.toBe(failure);
    expect(JSON.parse(String(attach.mock.calls[0]?.[1]?.body)).native).toEqual({ unavailable: "Window closed" });
  });
  it("keeps native window diagnostics available on other platforms without invoking desktop commands", async () => {
    currentPlatform.mockReturnValue("linux");
    const { app, attach } = fixture();
    await expect(withNativeFocusDiagnostics(app, { attach }, async () => { throw new Error("Native focus assertion failed"); })).rejects.toThrow("Native focus assertion failed");
    expect(JSON.parse(String(attach.mock.calls[0]?.[1]?.body)).desktop).toEqual({ platform: "linux" });
    expect(execute).not.toHaveBeenCalled();
  });
});
