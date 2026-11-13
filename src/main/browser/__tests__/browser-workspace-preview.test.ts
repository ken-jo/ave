import type { NativeImage, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { BrowserWorkspacePreview } from "../browser-workspace-preview.js";
import { captureAgentPreview, type AgentPreviewHost, type AgentPreviewTab } from "../browser-agent-preview.js";
import { createBrowserTabActivity } from "../browser-tab-activity.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import { EventEmitter } from "node:events";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";

function image(bytes = 100): NativeImage {
  const value = { getSize: () => ({ width: 1920, height: 1080 }), isEmpty: () => false, resize: vi.fn(() => value), toJPEG: () => Buffer.alloc(bytes) };
  return value as unknown as NativeImage;
}
function setup() {
  let visible = true;
  let generation = 1;
  let live = true;
  let at = 1000;
  const capturePage = vi.fn(async () => image());
  const focus = vi.fn(); const loadURL = vi.fn();
  let throttled = true;
  const guest = Object.assign(new EventEmitter(), { id: 7, capturePage, focus, loadURL,
    getBackgroundThrottling: () => throttled, setBackgroundThrottling: vi.fn((value: boolean) => { throttled = value; }),
    getURL: vi.fn(() => "https://example.com"), isLoadingMainFrame: vi.fn(() => false), isDestroyed: () => false }) as unknown as WebContents;
  const preview = new BrowserWorkspacePreview({ liveTab: (windowId, tabId) => live && windowId === 1 && tabId.startsWith("browser:") ? { guest, documentGeneration: generation } : null, isWindowVisible: () => visible, now: () => at });
  return { preview, guest, capturePage, focus, loadURL, setVisible: (value: boolean) => { visible = value; }, setGeneration: (value: number) => { generation = value; }, setLive: (value: boolean) => { live = value; }, advance: (ms: number) => { at += ms; } };
}
const TARGET = { tabId: "browser:one", documentGeneration: 1 };

describe("browser preview capture", () => {
  it.each([true, false])("holds painting through readback and restores the original throttling %s", async throttled => {
    const { preview, guest, capturePage } = setup();
    guest.setBackgroundThrottling(throttled);
    capturePage.mockImplementationOnce(async () => {
      expect(guest.getBackgroundThrottling()).toBe(false);
      return image();
    });
    await preview.capture(1, TARGET);
    expect(guest.getBackgroundThrottling()).toBe(throttled);
    expect(capturePage).toHaveBeenCalledTimes(1);
  });

  it("restores painting after a native readback failure and preserves its cause", async () => {
    const { preview, guest, capturePage } = setup();
    const cause = new Error("Native readback failed");
    capturePage.mockRejectedValueOnce(cause);
    await expect(preview.capture(1, TARGET)).rejects.toMatchObject({ message: "capture-unavailable", cause });
    expect(guest.getBackgroundThrottling()).toBe(true);
  });

  it("keeps the native capture failure first when painting cleanup also fails", async () => {
    const { preview, guest, capturePage } = setup();
    const nativeError = new Error("Native readback failed");
    const cleanupError = new Error("Painting cleanup failed");
    capturePage.mockRejectedValueOnce(nativeError);
    vi.mocked(guest.setBackgroundThrottling).mockImplementation(enabled => { if (enabled) throw cleanupError; });
    const failure = await preview.capture(1, TARGET).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: "capture-unavailable", errors: [expect.objectContaining({ cause: nativeError }), cleanupError] });
  });

  it.each(["preview", "activity"] as const)("retains painting when %s finishes before the other owner", async first => {
    vi.useFakeTimers();
    const { preview, guest, capturePage } = setup();
    const capture = deferred<NativeImage>();
    const action = deferred<void>();
    capturePage.mockImplementationOnce(() => capture.promise);
    const pendingPreview = preview.capture(1, TARGET);
    const pendingAction = createBrowserTabActivity(() => true)(guest, new AbortController().signal, async () => true, () => action.promise);
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (first === "preview") { capture.resolve(image()); await pendingPreview; }
      else { action.resolve(); await pendingAction; await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs); }
      expect(guest.getBackgroundThrottling()).toBe(false);
    } finally {
      capture.resolve(image());
      action.resolve();
      await Promise.allSettled([pendingPreview, pendingAction]);
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs);
      vi.useRealTimers();
    }
    expect(guest.getBackgroundThrottling()).toBe(true);
  });

  it("captures a compressed bounded thumbnail without showing, focusing or navigating its guest", async () => {
    const { preview, capturePage, focus, loadURL, advance } = setup();
    const result = await preview.capture(1, TARGET);
    expect(capturePage).toHaveBeenCalledWith(undefined, { stayHidden: false, stayAwake: false });
    expect(result.width).toBe(320); expect(result.height).toBe(180);
    expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(focus).not.toHaveBeenCalled(); expect(loadURL).not.toHaveBeenCalled();
    await expect(preview.capture(1, TARGET)).rejects.toThrow("capture-throttled");
    advance(1500);
    await preview.capture(1, TARGET);
    expect(capturePage).toHaveBeenCalledTimes(2);
  });
  it("does no native capture for hidden, stale, missing or cross-window requests", async () => {
    const { preview, capturePage, setVisible } = setup();
    setVisible(false);
    await expect(preview.capture(1, TARGET)).rejects.toThrow("window-hidden");
    setVisible(true);
    await expect(preview.capture(2, TARGET)).rejects.toThrow("no-such-tab");
    await expect(preview.capture(1, { ...TARGET, documentGeneration: 2 })).rejects.toThrow("stale-document");
    expect(capturePage).not.toHaveBeenCalled();
  });
  it("allows only one in-flight capture per window and throttles a different card", async () => {
    const { preview, capturePage, advance } = setup();
    let finish!: (value: NativeImage) => void;
    capturePage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = preview.capture(1, TARGET);
    await expect(preview.capture(1, { ...TARGET, tabId: "browser:two" })).rejects.toThrow("capture-busy");
    finish(image()); await pending;
    await expect(preview.capture(1, { ...TARGET, tabId: "browser:two" })).rejects.toThrow("capture-throttled");
    advance(1500);
    await preview.capture(1, { ...TARGET, tabId: "browser:two" });
    expect(capturePage).toHaveBeenCalledTimes(2);
  });
  it("discards late bytes after a hide followed by show, navigation, or close", async () => {
    for (const change of ["hide", "navigation", "close", "guest-invalidated"] as const) {
      const { preview, capturePage, setVisible, setGeneration, setLive, guest } = setup();
      let finish!: (value: NativeImage) => void;
      capturePage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const pending = preview.capture(1, TARGET);
      if (change === "hide") { setVisible(false); preview.invalidateWindow(1); setVisible(true); }
      if (change === "navigation") setGeneration(2);
      if (change === "close") setLive(false);
      if (change === "guest-invalidated") preview.invalidateGuest(guest.id);
      finish(image());
      await expect(pending).rejects.toThrow("stale-document");
    }
  });
  it("never loads a page or captures an uncommitted document", async () => {
    const { preview, guest, capturePage, loadURL } = setup();
    vi.mocked(guest.getURL).mockReturnValue("");
    await expect(preview.capture(1, TARGET)).rejects.toThrow("capture-unavailable");
    expect(capturePage).not.toHaveBeenCalled();
    expect(loadURL).not.toHaveBeenCalled();
  });
  it("captures an available frame while loading instead of causing workspace backoff", async () => {
    const { preview, guest, capturePage, loadURL } = setup();
    vi.mocked(guest.isLoadingMainFrame).mockReturnValue(true);
    await expect(preview.capture(1, TARGET)).resolves.toMatchObject({ tabId: TARGET.tabId, dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/) });
    expect(capturePage).toHaveBeenCalledOnce();
    expect(loadURL).not.toHaveBeenCalled();
  });
  it("rejects over-limit image bytes", async () => {
    const { preview, capturePage } = setup();
    capturePage.mockResolvedValueOnce(image(256_001));
    await expect(preview.capture(1, TARGET)).rejects.toThrow("capture-unavailable");
  });
});

describe("agent capture fallback", () => {
  const AGENT = { ...TARGET, dataUrl: "data:image/jpeg;base64,QUdFTlQ=", width: 320, height: 180 };
  it("serves the agent's last capture of the same document when a live capture cannot paint", async () => {
    const { preview, capturePage, setVisible, setGeneration, advance } = setup();
    preview.remember(1, AGENT);
    capturePage.mockResolvedValueOnce({ getSize: () => ({ width: 0, height: 0 }), isEmpty: () => true } as unknown as NativeImage);
    await expect(preview.capture(1, TARGET)).resolves.toEqual(AGENT);
    setVisible(false);
    await expect(preview.capture(1, TARGET)).resolves.toEqual(AGENT);
    setVisible(true);
    await expect(preview.capture(1, TARGET)).rejects.toThrow("capture-throttled");
    advance(1500);
    await expect(preview.capture(1, TARGET)).resolves.not.toEqual(AGENT);
    setGeneration(2);
    capturePage.mockResolvedValueOnce({ getSize: () => ({ width: 0, height: 0 }), isEmpty: () => true } as unknown as NativeImage);
    advance(1500);
    await expect(preview.capture(1, { ...TARGET, documentGeneration: 2 })).rejects.toThrow("capture-unavailable");
    setGeneration(1);
    setVisible(false);
    await expect(preview.capture(1, TARGET)).rejects.toThrow("window-hidden");
  });
  it("forgets agent captures when the window is disposed", async () => {
    const { preview, setVisible } = setup();
    preview.remember(1, AGENT);
    preview.disposeWindow(1);
    setVisible(false);
    await expect(preview.capture(1, TARGET)).rejects.toThrow("window-hidden");
  });
});

describe("agent capture thumbnail", () => {
  // A snapshot capture never decodes; a call to decodePng here would be a wrong path.
  function host(record: AgentPreviewHost["record"]): AgentPreviewHost {
    return { decodePng: () => { throw new Error("snapshot captures never decode a PNG"); }, record };
  }
  function tab(capturePage = vi.fn(async () => image())): AgentPreviewTab & { documentId: number } {
    return { windowId: 1, rendererTabId: "browser:one", documentId: 3, guest: { isDestroyed: () => false, capturePage } as unknown as AgentPreviewTab["guest"] };
  }
  it("encodes the screenshot PNG and records it under the renderer tab and document", async () => {
    const record = vi.fn();
    const decodePng = vi.fn(() => image());
    const result = await captureAgentPreview(tab(), "iVBORw0KGgo=", { decodePng, record });
    expect(decodePng).toHaveBeenCalledWith("iVBORw0KGgo=");
    expect(result).toMatchObject({ width: 320, height: 180, dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/) });
    expect(record).toHaveBeenCalledWith(1, { tabId: "browser:one", documentGeneration: 3, ...result });
  });
  it.each(["document", "guest"])("discards a supplied capture PNG when its %s changes during decoding", async (changed) => {
    const captured = tab();
    const record = vi.fn();
    const decodePng = () => {
      if (changed === "document") captured.documentId++;
      else Object.assign(captured, { guest: tab().guest });
      return image();
    };
    await expect(captureAgentPreview(captured, "iVBORw0KGgo=", { decodePng, record })).resolves.toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });
  it("captures the page for a snapshot, and gives up silently on timeout, failure, or a document change", async () => {
    const record = vi.fn();
    const captured = tab();
    await expect(captureAgentPreview(captured, undefined, host(record))).resolves.toMatchObject({ width: 320 });
    expect(captured.guest!.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true, stayAwake: false });
    const hung = tab(vi.fn(() => new Promise<NativeImage>(() => {})));
    await expect(captureAgentPreview(hung, undefined, host(record), { maxMs: 5 })).resolves.toBeUndefined();
    await expect(captureAgentPreview(tab(vi.fn(async () => { throw new Error("gone"); })), undefined, host(record))).resolves.toBeUndefined();
    const moved = tab();
    vi.mocked(moved.guest!.capturePage).mockImplementationOnce(async () => { moved.documentId = 4; return image(); });
    await expect(captureAgentPreview(moved, undefined, host(record))).resolves.toBeUndefined();
    await expect(captureAgentPreview(tab(), "x", { decodePng: () => { throw new Error("bad png"); }, record })).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
  });
  it("gives up a page capture as soon as the tool call is stopped, and never starts one for a stopped call", async () => {
    const record = vi.fn();
    const hung = tab(vi.fn(() => new Promise<NativeImage>(() => {})));
    const stop = new AbortController();
    // The capture timeout is far beyond the test's own, so only the abort can end this wait.
    const pending = captureAgentPreview(hung, undefined, host(record), { maxMs: 60_000, signals: [undefined, stop.signal] });
    stop.abort();
    await expect(pending).resolves.toBeUndefined();
    const idle = tab();
    await expect(captureAgentPreview(idle, undefined, host(record), { signals: [stop.signal] })).resolves.toBeUndefined();
    expect(idle.guest!.capturePage).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
  it("returns the thumbnail without recording a tab that has no renderer card", async () => {
    const record = vi.fn();
    await expect(captureAgentPreview({ ...tab(), rendererTabId: null }, undefined, host(record))).resolves.toMatchObject({ width: 320 });
    expect(record).not.toHaveBeenCalled();
  });
});
