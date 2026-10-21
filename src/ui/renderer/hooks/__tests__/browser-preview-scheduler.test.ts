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
});
