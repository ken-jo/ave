// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPreviewScheduler } from "../browser-preview-scheduler.js";
import type { BrowserPreview, BrowserWorkspaceResult } from "../../../../shared/browser-workspace.js";

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
const TARGET = { tabId: "browser:one", documentGeneration: 1 };
const PREVIEW: BrowserPreview = { ...TARGET, dataUrl: "data:image/jpeg;base64,YQ==", width: 100, height: 50 };
function connected() { const element = document.createElement("div"); document.body.appendChild(element); return element; }

describe("visible browser card scheduling", () => {
  it("does not request hidden or disconnected cards and stops on unregister", async () => {
    vi.useFakeTimers();
    const preview = vi.fn(async () => ({ ok: true as const, value: PREVIEW }));
    let visible = false;
    const scheduler = new BrowserPreviewScheduler({ preview }, () => visible);
    const unregisterHidden = scheduler.register(connected(), TARGET, vi.fn());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(preview).not.toHaveBeenCalled();
    unregisterHidden(); visible = true;
    scheduler.register(document.createElement("div"), TARGET, vi.fn());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(preview).not.toHaveBeenCalled();
    const unregister = scheduler.register(connected(), TARGET, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(preview).toHaveBeenCalledTimes(1);
    unregister(); await vi.advanceTimersByTimeAsync(30_000);
    expect(preview).toHaveBeenCalledTimes(1);
  });
  it("shares one capture owner across eligible cards and discards a late hidden result", async () => {
    vi.useFakeTimers();
    let finish!: (result: BrowserWorkspaceResult<BrowserPreview>) => void;
    const preview = vi.fn(() => new Promise<BrowserWorkspaceResult<BrowserPreview>>((resolve) => { finish = resolve; }));
    let visible = true;
    const scheduler = new BrowserPreviewScheduler({ preview }, () => visible);
    const first = vi.fn(); const second = vi.fn();
    const unregisterFirst = scheduler.register(connected(), TARGET, first);
    const unregisterSecond = scheduler.register(connected(), { ...TARGET, tabId: "browser:two" }, second);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(preview).toHaveBeenCalledTimes(1);
    visible = false; unregisterFirst(); unregisterSecond(); finish({ ok: true, value: PREVIEW });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled(); expect(preview).toHaveBeenCalledTimes(1);
  });
  it("rejects responses for a different tab or document", async () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const scheduler = new BrowserPreviewScheduler({ preview: vi.fn(async () => ({ ok: true as const, value: { ...PREVIEW, documentGeneration: 2 } })) }, () => true);
    const unregister = scheduler.register(connected(), TARGET, callback);
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).not.toHaveBeenCalled(); unregister();
  });
  it("gives every visible card a first capture before refreshing an earlier card", async () => {
    vi.useFakeTimers();
    const preview = vi.fn(async (_request: typeof TARGET) => ({ ok: false as const, error: "capture-unavailable" as const }));
    const scheduler = new BrowserPreviewScheduler({ preview }, () => true);
    const unregister = Array.from({ length: 9 }, (_, index) => scheduler.register(connected(), { ...TARGET, tabId: `browser:${index}` }, vi.fn()));
    await vi.advanceTimersByTimeAsync(12_800);
    expect(new Set(preview.mock.calls.map((call) => (call[0] as typeof TARGET).tabId)).size).toBe(9);
    for (const remove of unregister) remove();
  });
  it("reuses only an eligible current-document image and refreshes it at the cache lifetime", async () => {
    vi.useFakeTimers();
    const preview = vi.fn(async (_request: typeof TARGET) => ({ ok: true as const, value: PREVIEW }));
    const scheduler = new BrowserPreviewScheduler({ preview }, () => true);
    const unregisterFirst = scheduler.register(connected(), TARGET, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const cached = vi.fn();
    const unregisterSecond = scheduler.register(connected(), TARGET, cached);
    expect(cached).toHaveBeenCalledWith(PREVIEW);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(preview).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(preview).toHaveBeenCalledTimes(2);
    const newDocument = vi.fn();
    const unregisterNewDocument = scheduler.register(connected(), { ...TARGET, documentGeneration: 2 }, newDocument);
    expect(newDocument).not.toHaveBeenCalled();
    unregisterFirst(); unregisterSecond(); unregisterNewDocument();
  });
  it("never admits a late unregistered image when the card reopens within the cache lifetime", async () => {
    vi.useFakeTimers();
    let finish!: (result: BrowserWorkspaceResult<BrowserPreview>) => void;
    const preview = vi.fn((_request: typeof TARGET) => new Promise<BrowserWorkspaceResult<BrowserPreview>>((resolve) => { finish = resolve; }));
    const scheduler = new BrowserPreviewScheduler({ preview }, () => true);
    const unregister = scheduler.register(connected(), TARGET, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    unregister();
    finish({ ok: true, value: PREVIEW });
    await vi.advanceTimersByTimeAsync(1600);
    const reopened = vi.fn();
    const unregisterReopened = scheduler.register(connected(), TARGET, reopened);
    expect(reopened).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(preview).toHaveBeenCalledTimes(2);
    finish({ ok: true, value: { ...PREVIEW, dataUrl: "data:image/jpeg;base64,Yg==" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(reopened).toHaveBeenCalledWith(expect.objectContaining({ dataUrl: "data:image/jpeg;base64,Yg==" }));
    unregisterReopened();
  });
  it("clears admitted images and rejects pending bytes across a hidden-to-visible epoch", async () => {
    vi.useFakeTimers();
    let visible = true;
    let finish!: (result: BrowserWorkspaceResult<BrowserPreview>) => void;
    const preview = vi.fn((_request: typeof TARGET) => new Promise<BrowserWorkspaceResult<BrowserPreview>>((resolve) => { finish = resolve; }));
    const scheduler = new BrowserPreviewScheduler({ preview }, () => visible);
    const callback = vi.fn();
    const unregister = scheduler.register(connected(), TARGET, callback);
    await vi.advanceTimersByTimeAsync(0);
    visible = false; document.dispatchEvent(new Event("visibilitychange"));
    visible = true; document.dispatchEvent(new Event("visibilitychange"));
    finish({ ok: true, value: PREVIEW });
    await vi.advanceTimersByTimeAsync(1600);
    expect(callback).not.toHaveBeenCalled(); expect(preview).toHaveBeenCalledTimes(2);
    finish({ ok: true, value: PREVIEW }); await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledOnce();
    visible = false; document.dispatchEvent(new Event("visibilitychange"));
    const hidden = vi.fn();
    const unregisterHidden = scheduler.register(connected(), TARGET, hidden);
    expect(hidden).not.toHaveBeenCalled();
    visible = true; document.dispatchEvent(new Event("visibilitychange"));
    const reopened = vi.fn();
    const unregisterReopened = scheduler.register(connected(), TARGET, reopened);
    expect(reopened).not.toHaveBeenCalled();
    unregister(); unregisterHidden(); unregisterReopened();
  });
  it("does not retain a registration when its cached-preview callback fails", async () => {
    vi.useFakeTimers();
    const preview = vi.fn(async () => ({ ok: true as const, value: PREVIEW }));
    const scheduler = new BrowserPreviewScheduler({ preview }, () => true);
    const unregister = scheduler.register(connected(), TARGET, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(() => scheduler.register(connected(), TARGET, () => { throw new TypeError("Invalid preview consumer"); })).toThrow("Invalid preview consumer");
    unregister();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(preview).toHaveBeenCalledTimes(1);
  });
});

describe("one-shot sidebar captures", () => {
  it("queues rapid A to B hovers behind the shared throttle and reuses their cache", async () => {
    vi.useFakeTimers();
    const preview = vi.fn(async (target: typeof TARGET) => ({ ok: true as const, value: { ...PREVIEW, ...target } }));
    const scheduler = new BrowserPreviewScheduler({ preview }, () => true);
    const first = scheduler.request(TARGET);
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toEqual(PREVIEW);
    await vi.advanceTimersByTimeAsync(100);
    const targetB = { ...TARGET, tabId: "browser:two" };
    const second = scheduler.request(targetB);
    await vi.advanceTimersByTimeAsync(1499);
    expect(preview).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toEqual({ ...PREVIEW, ...targetB });
    expect(await scheduler.request(TARGET)).toEqual(PREVIEW);
    expect(preview).toHaveBeenCalledTimes(2);
  });
  it("keeps an open workspace card's refresh schedule intact during sidebar capture", async () => {
    vi.useFakeTimers();
    let previous = -Infinity;
    const preview = vi.fn(async (target: typeof TARGET) => {
      expect(Date.now() - previous).toBeGreaterThanOrEqual(1500);
      previous = Date.now();
      return { ok: true as const, value: { ...PREVIEW, ...target } };
    });
    const scheduler = new BrowserPreviewScheduler({ preview }, () => true);
    const workspace = vi.fn();
    const unregister = scheduler.register(connected(), TARGET, workspace);
    await vi.advanceTimersByTimeAsync(0);
    const sidebar = scheduler.request({ ...TARGET, tabId: "browser:two" });
    await vi.advanceTimersByTimeAsync(1600);
    expect(await sidebar).not.toBeNull();
    await vi.advanceTimersByTimeAsync(8399);
    expect(workspace).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(workspace).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenCalledTimes(3);
    unregister();
  });
  it("shares a pending workspace capture and rejects malformed image payloads", async () => {
    vi.useFakeTimers();
    const preview = vi.fn(async () => ({ ok: true as const, value: { ...PREVIEW, dataUrl: "page content" } }));
    const scheduler = new BrowserPreviewScheduler({ preview }, () => true);
    const unregister = scheduler.register(connected(), TARGET, vi.fn());
    const sidebar = scheduler.request(TARGET);
    await vi.advanceTimersByTimeAsync(0);
    expect(await sidebar).toBeNull();
    expect(preview).toHaveBeenCalledOnce();
    unregister();
  });
});

it("bounds pending display requests and coalesces repeated hover targets", async () => {
  vi.useFakeTimers();
  let visible = true;
  const preview = vi.fn(async (target: typeof TARGET) => ({ ok: true as const, value: { ...PREVIEW, ...target } }));
  const scheduler = new BrowserPreviewScheduler({ preview }, () => visible);
  const first = scheduler.request(TARGET);
  expect(scheduler.request(TARGET)).toBe(first);
  const queued = Array.from({ length: 16 }, (_, index) => scheduler.request({ ...TARGET, tabId: `browser:queued-${index}` }));
  expect(await first).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(await queued[0]).not.toBeNull();
  expect(preview).toHaveBeenCalledOnce();
  visible = false;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(await Promise.all(queued.slice(1))).toEqual(Array(15).fill(null));
});

it("finishes a shared one-shot when its workspace card unregisters during capture", async () => {
  vi.useFakeTimers();
  let finish!: (result: BrowserWorkspaceResult<BrowserPreview>) => void;
  const preview = vi.fn(() => new Promise<BrowserWorkspaceResult<BrowserPreview>>((resolve) => { finish = resolve; }));
  const scheduler = new BrowserPreviewScheduler({ preview }, () => true);
  const unregister = scheduler.register(connected(), TARGET, vi.fn());
  const sidebar = scheduler.request(TARGET);
  await vi.advanceTimersByTimeAsync(0);
  unregister();
  finish({ ok: true, value: PREVIEW });
  await vi.advanceTimersByTimeAsync(0);
  expect(await sidebar).toEqual(PREVIEW);
  expect(await scheduler.request(TARGET)).toEqual(PREVIEW);
  expect(preview).toHaveBeenCalledOnce();
});

it("evicts the oldest pending hover while preserving an in-flight result", async () => {
  vi.useFakeTimers();
  let visible = true;
  let finish!: (result: BrowserWorkspaceResult<BrowserPreview>) => void;
  const preview = vi.fn((target: typeof TARGET) => target.tabId === TARGET.tabId
    ? new Promise<BrowserWorkspaceResult<BrowserPreview>>((resolve) => { finish = resolve; })
    : Promise.resolve({ ok: true as const, value: { ...PREVIEW, ...target } }));
  const scheduler = new BrowserPreviewScheduler({ preview }, () => visible);
  const received = vi.fn();
  const first = scheduler.request(TARGET);
  void first.then(received);
  await vi.advanceTimersByTimeAsync(0);
  const queued = Array.from({ length: 16 }, (_, index) => scheduler.request({ ...TARGET, tabId: `browser:queued-${index}` }));
  await vi.advanceTimersByTimeAsync(0);
  expect(received).not.toHaveBeenCalled();
  expect(await queued[0]).toBeNull();
  expect(preview).toHaveBeenCalledOnce();
  finish({ ok: true, value: PREVIEW });
  await vi.advanceTimersByTimeAsync(0);
  expect(await first).toEqual(PREVIEW);
  expect(received).toHaveBeenCalledWith(PREVIEW);
  await vi.advanceTimersByTimeAsync(1600);
  expect(await queued[1]).toEqual({ ...PREVIEW, tabId: "browser:queued-1" });
  expect(preview).toHaveBeenLastCalledWith({ ...TARGET, tabId: "browser:queued-1" });
  visible = false;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(await Promise.all(queued.slice(2))).toEqual(Array(14).fill(null));
});

it("serves a queued hover before later refreshes even when the workspace fills the capture interval", async () => {
  vi.useFakeTimers();
  const preview = vi.fn(async (target: typeof TARGET) => ({ ok: true as const, value: { ...PREVIEW, ...target } }));
  const scheduler = new BrowserPreviewScheduler({ preview }, () => true);
  const remove = Array.from({ length: 7 }, (_, index) => scheduler.register(connected(), { ...TARGET, tabId: `browser:workspace-${index}` }, vi.fn()));
  await vi.advanceTimersByTimeAsync(0);
  const hover = scheduler.request(TARGET);
  await vi.advanceTimersByTimeAsync(11_200);
  expect(await hover).toEqual(PREVIEW);
  expect(preview).toHaveBeenCalledTimes(8);
  for (const unregister of remove) unregister();
});
