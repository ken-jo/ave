import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OBSERVATION_LIMITS } from "../../shared/agent-observation.js";
import { BrowserScreencast, ScreencastClosedError, type ScreencastCallbacks, type ScreencastTransport } from "../browser-screencast.js";

class FakeSession implements ScreencastTransport {
  readonly sent: { method: string; params?: Record<string, unknown> }[] = [];
  readonly open = new Map<string, { resolve(value?: unknown): void; reject(error: Error): void }[]>();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private readonly closers = new Set<(reason: string) => void>();
  /** Methods that never answer, like a session that went away without settling its commands. */
  readonly hang = new Set<string>();
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, ...(params ? { params } : {}) });
    if (!this.hang.has(method)) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      const entries = this.open.get(method) ?? [];
      entries.push({ resolve, reject });
      this.open.set(method, entries);
    });
  }
  onEvent(listener: (method: string, params: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  onClose(listener: (reason: string) => void) {
    this.closers.add(listener);
    return () => { this.closers.delete(listener); };
  }
  emit(method: string, params: Record<string, unknown>) { for (const listener of [...this.listeners]) listener(method, params); }
  frame(sessionId: number, data = `real-${sessionId}`) {
    this.emit("Page.screencastFrame", { sessionId, data, metadata: { deviceWidth: 1280, deviceHeight: 800 } });
  }
  close(reason = "target closed") { for (const listener of [...this.closers]) listener(reason); }
  methods() { return this.sent.map((entry) => entry.method); }
  count(method: string) { return this.sent.filter((entry) => entry.method === method).length; }
  get listening() { return this.listeners.size; }
}

let session: FakeSession;
let callbacks: { frame: ReturnType<typeof vi.fn<ScreencastCallbacks["frame"]>>; updating: ReturnType<typeof vi.fn<ScreencastCallbacks["updating"]>>;
  ended: ReturnType<typeof vi.fn<ScreencastCallbacks["ended"]>>; isBlank: ScreencastCallbacks["isBlank"] };
let screencast: BrowserScreencast;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  session = new FakeSession();
  callbacks = { frame: vi.fn<ScreencastCallbacks["frame"]>(), updating: vi.fn<ScreencastCallbacks["updating"]>(),
    ended: vi.fn<ScreencastCallbacks["ended"]>(), isBlank: (data: string) => data.startsWith("blank") };
  screencast = new BrowserScreencast(session, callbacks);
});
afterEach(async () => { await screencast.stop(); vi.useRealTimers(); });

describe("agent browser screencast", () => {
  it("starts one bounded JPEG screencast on the existing session", () => {
    screencast.start();
    expect(session.sent).toEqual([{ method: "Page.startScreencast", params: { format: "jpeg", quality: OBSERVATION_LIMITS.previewJpegQuality,
      maxWidth: OBSERVATION_LIMITS.previewMaxWidth, maxHeight: OBSERVATION_LIMITS.previewMaxHeight, everyNthFrame: 1 } }]);
    expect(() => screencast.start()).toThrow("already started");
  });

  it("acknowledges every Chromium frame on receipt, even while renderer delivery is throttled or in flight", async () => {
    screencast.start();
    for (let id = 1; id <= 5; id++) session.frame(id);
    expect(session.sent.filter((entry) => entry.method === "Page.screencastFrameAck").map((entry) => entry.params))
      .toEqual([1, 2, 3, 4, 5].map((sessionId) => ({ sessionId })));
    // Only one frame reached the renderer; the rest coalesce behind it.
    expect(callbacks.frame).toHaveBeenCalledTimes(1);
    await flush();
    expect(callbacks.ended).not.toHaveBeenCalled();
  });

  it("bounds forwarding to one unrendered frame, the minimum interval and the frame size", async () => {
    screencast.start();
    session.frame(1);
    expect(callbacks.frame).toHaveBeenLastCalledWith({ frame: 1, data: "real-1", width: 1280, height: 800 });
    session.frame(2); session.frame(3);
    expect(callbacks.frame).toHaveBeenCalledTimes(1);
    screencast.rendered(1);
    // Rendered, but the interval has not elapsed: the newest queued frame waits for it.
    expect(callbacks.frame).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OBSERVATION_LIMITS.previewMinFrameIntervalMs);
    expect(callbacks.frame).toHaveBeenCalledTimes(2);
    expect(callbacks.frame).toHaveBeenLastCalledWith(expect.objectContaining({ frame: 2, data: "real-3" }));
    screencast.rendered(99);
    session.frame(4);
    await vi.advanceTimersByTimeAsync(OBSERVATION_LIMITS.previewMinFrameIntervalMs);
    expect(callbacks.frame).toHaveBeenCalledTimes(2);
    screencast.rendered(2);
    session.emit("Page.screencastFrame", { sessionId: 5, data: "x".repeat(OBSERVATION_LIMITS.previewMaxFrameChars + 1), metadata: {} });
    await vi.advanceTimersByTimeAsync(OBSERVATION_LIMITS.previewMinFrameIntervalMs);
    expect(callbacks.frame).toHaveBeenLastCalledWith(expect.objectContaining({ frame: 3, data: "real-4" }));
    expect(session.count("Page.screencastFrameAck")).toBe(5);
  });

  it("re-arms the screencast on each main-frame commit because Chromium drops the client across documents", async () => {
    screencast.start();
    session.frame(1);
    screencast.navigationCommitted();
    await flush();
    expect(callbacks.updating).toHaveBeenCalledOnce();
    expect(session.methods()).toEqual(["Page.startScreencast", "Page.screencastFrameAck", "Page.stopScreencast", "Page.startScreencast"]);
  });

  it("re-arms after a silence while shown, and not while frames keep arriving", async () => {
    screencast.start();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(OBSERVATION_LIMITS.previewSilenceMs - 100);
      session.frame(i + 1);
      screencast.rendered(i + 1);
    }
    expect(session.count("Page.startScreencast")).toBe(1);
    await vi.advanceTimersByTimeAsync(OBSERVATION_LIMITS.previewSilenceMs);
    expect(session.count("Page.stopScreencast")).toBe(1);
    expect(session.count("Page.startScreencast")).toBe(2);
    // The watchdog keeps re-arming a still-silent page instead of giving up after one try.
    await vi.advanceTimersByTimeAsync(OBSERVATION_LIMITS.previewSilenceMs);
    expect(session.count("Page.startScreencast")).toBe(3);
  });

  it("keeps the stale real frame marked updating for a blank commit paint, without pinning blank frames forever", async () => {
    screencast.start();
    session.frame(1, "real-page");
    screencast.rendered(1);
    screencast.navigationCommitted();
    await flush();
    callbacks.updating.mockClear();
    session.frame(2, "blank-commit");
    expect(callbacks.frame).toHaveBeenCalledTimes(1);
    expect(callbacks.updating).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(OBSERVATION_LIMITS.previewCommitBlankMs);
    // A page that really is blank renders after the commit window.
    session.frame(3, "blank-page");
    expect(callbacks.frame).toHaveBeenLastCalledWith(expect.objectContaining({ frame: 2, data: "blank-page" }));
  });

  it("renders a blank first frame when there is no earlier real frame to keep", () => {
    screencast.start();
    screencast.navigationCommitted();
    session.frame(1, "blank-first");
    expect(callbacks.frame).toHaveBeenCalledWith(expect.objectContaining({ frame: 1, data: "blank-first" }));
  });

  it("rejects every in-flight command at once with a closed error when the session closes", async () => {
    session.hang.add("Page.startScreencast");
    session.hang.add("Page.screencastFrameAck");
    screencast.start();
    session.frame(1);
    expect(session.open.get("Page.startScreencast")).toHaveLength(1);
    expect(session.open.get("Page.screencastFrameAck")).toHaveLength(1);
    session.close("Render process gone.");
    await flush();
    expect(callbacks.ended).toHaveBeenCalledOnce();
    const error = callbacks.ended.mock.calls[0]![0] as Error;
    expect(error).toBeInstanceOf(ScreencastClosedError);
    expect(error.message).toBe("Browser preview session closed (Render process gone.).");
    // No timer is left to masquerade as a later timeout, and no listener survives the close.
    expect(vi.getTimerCount()).toBe(0);
    expect(session.listening).toBe(0);
    await expect(screencast.stop()).resolves.toBeUndefined();
    expect(session.count("Page.stopScreencast")).toBe(0);
  });

  it("reports a protocol failure as an error rather than a close", async () => {
    session.send = vi.fn(async () => { throw new Error("Page.startScreencast failed"); });
    screencast.start();
    await flush();
    expect(callbacks.ended).toHaveBeenCalledWith(new Error("Page.startScreencast failed"));
    expect(callbacks.ended.mock.calls[0]![0]).not.toBeInstanceOf(ScreencastClosedError);
  });

  it("stops forwarding and timers immediately on stop and sends one stop command", async () => {
    screencast.start();
    session.frame(1);
    await screencast.stop();
    session.frame(2);
    expect(callbacks.frame).toHaveBeenCalledTimes(1);
    expect(session.count("Page.stopScreencast")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await screencast.stop();
    expect(session.count("Page.stopScreencast")).toBe(1);
  });
});
