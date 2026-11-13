import { describe, expect, it, vi } from "vitest";
import { captureBrowserPage, captureBrowserViewport } from "../browser-capture.js";
import type { CdpSession } from "../browser-action-guard.js";
import { runInNewContext } from "node:vm";
import { deferred } from "../../../__tests__/support/deferred.js";

function image(width: number, height: number): string {
  const header = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(header);
  header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
  return header.toString("base64");
}
function fixture(width = 800, height = 2400) {
  let override: { width: number; height: number; deviceScaleFactor: number } | undefined;
  let viewport = { pageX: 10, pageY: 20, clientWidth: width, clientHeight: 600 };
  const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "Emulation.setDeviceMetricsOverride") {
      override = params as typeof override;
      return {};
    }
    if (method === "Emulation.clearDeviceMetricsOverride") { override = undefined; return {}; }
    if (method === "Page.getLayoutMetrics") return {
      cssContentSize: { x: 0, y: 0, width, height },
      cssVisualViewport: viewport,
    };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 73 };
    if (method === "Runtime.callFunctionOn") {
      const values = params?.arguments as Array<{ value: unknown }> | undefined;
      if (values) viewport = { ...viewport, pageX: Number(values[0]?.value), pageY: Number(values[1]?.value) };
      return {};
    }
    if (override?.deviceScaleFactor === 1) return { data: image(override.width, override.height) };
    if (method === "Page.captureScreenshot") {
      const { default: sharp } = await import("sharp");
      const ratio = override?.deviceScaleFactor ?? 1;
      return { data: (await sharp({ create: {
        width: Math.round((override?.width ?? width) * ratio), height: Math.round((override?.height ?? 600) * ratio), channels: 3, background: "#fff",
      } }).png().toBuffer()).toString("base64") };
    }
    return {};
  });
  const cdp: CdpSession = { send, onEvent: () => () => {} };
  return { cdp, send, signal: new AbortController().signal };
}

describe("browser capture", () => {
  it.each([{ pixelRatio: 1, zoom: 1 }, { pixelRatio: 2, zoom: 1 }, { pixelRatio: 2, zoom: 1.25 }, { pixelRatio: 3, zoom: 1 }])("clips CSS rows when native dimensions already use device pixels ($pixelRatio, $zoom)", async ({ pixelRatio, zoom }) => {
    const { default: sharp } = await import("sharp");
    const size = 4 * pixelRatio * zoom;
    const pixels = Buffer.alloc(size * size * 3);
    for (let row = 0; row < size; row += 1) for (let column = 0; column < size; column += 1) pixels[(row * size + column) * 3 + (row < size / 2 ? 0 : 2)] = 255;
    const png = await sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
    const guest = { getZoomFactor: () => zoom };
    const base = fixture();
    const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 4, clientHeight: 4 } };
      if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
      return base.cdp.send(method, params);
    });
    const cdp: CdpSession = { ...base.cdp, send };
    const result = await captureBrowserPage(cdp, new AbortController().signal, { clip: { x: 0, y: 3, width: 4, height: 1 } }, pixelRatio, 1000, () => captureBrowserViewport(guest, () => {}, pixelRatio, cdp));
    const decoded = await sharp(Buffer.from(result.data, "base64")).raw().toBuffer();
    expect(result).toMatchObject({ width: 4, height: 1 });
    expect([...decoded.subarray(0, 3)]).toEqual([0, 0, 255]);
    expect(send.mock.calls.filter(([method]) => method === "Page.captureScreenshot")).toEqual([
      ["Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }],
    ]);
  });

  it.each(["pageX", "pageY", "clientWidth", "clientHeight", "zoom", "scale"])("rejects a region when %s changes during readback", async (field) => {
    const viewport = { pageX: 0, pageY: 0, clientWidth: 4, clientHeight: 4, zoom: 1, scale: 1 };
    const base = fixture();
    const cdp: CdpSession = { ...base.cdp, send: async (method, params) => method === "Page.getLayoutMetrics"
      ? { cssVisualViewport: { ...viewport } } : base.cdp.send(method, params) };
    const { default: sharp } = await import("sharp");
    // These are the pixels at document rows 4-7 after a scroll, not the requested row 1.
    const data = (await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer()).toString("base64");
    await expect(captureBrowserPage(cdp, new AbortController().signal, { clip: { x: 0, y: 1, width: 4, height: 1 } }, 1, 1000, async () => {
      const key = field as keyof typeof viewport;
      viewport[key] += 4;
      return { data, cssScale: 1 };
    })).rejects.toMatchObject({ code: "screenshot-unavailable", message: "the viewport changed during capture" });
  });

  it("rejects native readback when guest zoom changes while pixels are being captured", async () => {
    let zoom = 1;
    const guest = { getZoomFactor: () => zoom };
    const send = vi.fn(async () => { zoom = 1.25; return {}; });
    await expect(captureBrowserViewport(guest, () => {}, 1, { send, onEvent: () => () => {} })).rejects.toMatchObject({ code: "screenshot-unavailable" });
    expect(zoom).toBe(1.25);
    expect(send).toHaveBeenCalledExactlyOnceWith("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  });

  it("reads one redraw-bound snapshot without using the raw copy API", async () => {
    const data = image(800, 600);
    const capturePage = vi.fn(async () => { throw new Error("Raw copy is unavailable"); });
    const guest = { getZoomFactor: () => 1, capturePage };
    const assertCurrent = vi.fn();
    const send = vi.fn(async () => ({ data }));
    expect(await captureBrowserViewport(guest, assertCurrent, 1, { send, onEvent: () => () => {} }))
      .toEqual({ data, cssScale: 1 });
    expect(send).toHaveBeenCalledExactlyOnceWith("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    expect(capturePage).not.toHaveBeenCalled();
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("reports a failed snapshot without reissuing the request", async () => {
    const failure = new Error("Snapshot readback failed");
    const send = vi.fn(async () => { throw failure; });
    await expect(captureBrowserViewport({ getZoomFactor: () => 1 }, () => {}, 1, { send, onEvent: () => () => {} })).rejects.toBe(failure);
    expect(send).toHaveBeenCalledExactlyOnceWith("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  });

  it("captures the full content without scrolling and reports its dimensions", async () => {
    const { cdp, send, signal } = fixture();
    expect(await captureBrowserPage(cdp, signal, { fullPage: true })).toMatchObject({
      width: 800, height: 2400, originalWidth: 800, originalHeight: 2400, scale: 1, truncated: false,
    });
    expect(send).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", { width: 800, height: 2400, deviceScaleFactor: 1, mobile: false });
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    expect(send).toHaveBeenCalledWith("Emulation.clearDeviceMetricsOverride");
    expect(send).toHaveBeenLastCalledWith("Runtime.callFunctionOn", expect.objectContaining({
      arguments: [{ value: 10 }, { value: 20 }],
    }));
  });
  it("captures the scrolled viewport by default", async () => {
    const { cdp, send, signal } = fixture();
    expect(await captureBrowserPage(cdp, signal)).toMatchObject({ width: 800, height: 600 });
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    expect(send).toHaveBeenLastCalledWith("Page.getLayoutMetrics");
  });
  it("captures the full page while animation callbacks are suspended and restores its scroll", async () => {
    const { cdp, send, signal } = fixture();
    const original = send.getMockImplementation();
    if (!original) throw new Error("Capture fixture has no protocol session");
    let x = 10, y = 20;
    const animationFrame = vi.fn(() => 1);
    const world = {
      window: { scrollTo: (position: { left: number; top: number }) => { x = position.left; y = position.top; } },
      requestAnimationFrame: animationFrame,
    };
    send.mockImplementation(async (method, params) => {
      if (method === "Runtime.callFunctionOn") {
        const values = params?.arguments;
        const declaration = params?.functionDeclaration;
        if (!Array.isArray(values) || typeof declaration !== "string") throw new Error("Capture scroll parameters are unavailable");
        const args = values.map((argument: { value: unknown }) => argument.value);
        await runInNewContext(`(${declaration})(...args)`, { ...world,
          get scrollX() { return x; }, get scrollY() { return y; }, args });
      }
      if (method === "Page.captureScreenshot") expect({ x, y }).toEqual({ x: 0, y: 0 });
      return original(method, params);
    });
    expect(await captureBrowserPage(cdp, signal, { fullPage: true }, 1, 1000)).toMatchObject({ width: 800, height: 2400 });
    expect(animationFrame).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    expect({ x, y }).toEqual({ x: 10, y: 20 });
    expect(send).toHaveBeenCalledWith("Emulation.clearDeviceMetricsOverride");
  });
  it("waits for the viewport readback without changing scroll", async () => {
    const { cdp, send, signal } = fixture();
    const { default: sharp } = await import("sharp");
    const data = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#fff" } }).png().toBuffer()).toString("base64");
    const entered = deferred<void>();
    const response = deferred<{ data: string }>();
    const readback = vi.fn(() => {
      entered.resolve();
      return response.promise;
    });
    const pending = captureBrowserPage(cdp, signal, {}, 1, 1000, readback);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    expect(settled).toBe(false);
    expect(readback).toHaveBeenCalledOnce();
    expect(send.mock.calls.map(([method]) => method)).toEqual(["Page.getLayoutMetrics"]);
    response.resolve({ data });
    expect(await pending).toMatchObject({ width: 800, height: 600 });
    expect(send.mock.calls.map(([method]) => method)).toEqual(["Page.getLayoutMetrics", "Page.getLayoutMetrics"]);
    expect(send.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(false);
  });
  it("admits viewport readback while page animation callbacks are unavailable", async () => {
    const { cdp, signal, send } = fixture();
    const { default: sharp } = await import("sharp");
    const data = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "blue" } }).png().toBuffer()).toString("base64");
    const original = send.getMockImplementation();
    if (!original) throw new Error("Capture fixture has no protocol session");
    send.mockImplementation(async (method, params) => method === "Runtime.callFunctionOn" ? new Promise(() => {}) : original(method, params));
    const readback = vi.fn(async () => ({ data }));
    expect(await captureBrowserPage(cdp, signal, {}, 1, 1000, readback)).toMatchObject({ width: 800, height: 600 });
    expect(readback).toHaveBeenCalledOnce();
    expect(send.mock.calls.some(([method]) => method === "Runtime.callFunctionOn")).toBe(false);
  });
  it("cancels a pending viewport readback without reissuing it", async () => {
    const { cdp } = fixture();
    const abort = new AbortController();
    const entered = deferred<void>();
    const readback = vi.fn(() => {
      entered.resolve();
      return new Promise<never>(() => {});
    });
    const pending = captureBrowserPage(cdp, abort.signal, {}, 1, 1000, readback);
    const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await entered.promise;
    abort.abort();
    await rejected;
    expect(readback).toHaveBeenCalledOnce();
  });
  it("bounds viewport readback by the original capture deadline", async () => {
    const { cdp, signal } = fixture();
    const readback = vi.fn(() => new Promise<never>(() => {}));
    await expect(captureBrowserPage(cdp, signal, {}, 1, 20, readback)).rejects.toMatchObject({ code: "screenshot-timeout" });
    expect(readback).toHaveBeenCalledOnce();
  });
  it("truncates oversized pages at the pixel limit and reports their real height", async () => {
    const { cdp, signal } = fixture(8000, 16000);
    expect(await captureBrowserPage(cdp, signal, { fullPage: true })).toMatchObject({
      width: 8000, height: 4000, originalWidth: 8000, originalHeight: 16000, scale: 1, truncated: true,
    });
  });
  it("captures a capped page from the top and restores its initial scroll", async () => {
    const { cdp, send, signal } = fixture(800, 50_000);
    expect(await captureBrowserPage(cdp, signal, { fullPage: true })).toMatchObject({
      width: 800, height: 40_000, originalHeight: 50_000, truncated: true,
    });
    const scrolls = send.mock.calls.filter(([method]) => method === "Runtime.callFunctionOn").map(([, params]) =>
      (params as { arguments: Array<{ value: unknown }> }).arguments.map((argument) => argument.value),
    );
    expect(scrolls).toEqual([[0, 0], [10, 20]]);
    const cleared = send.mock.calls.findIndex(([method]) => method === "Emulation.clearDeviceMetricsOverride");
    const restored = send.mock.calls.findLastIndex(([method]) => method === "Runtime.callFunctionOn");
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(restored).toBeGreaterThan(cleared);
  });
  it("preserves device scale during capture and returns CSS-sized image pixels", async () => {
    const { cdp, send, signal } = fixture();
    expect(await captureBrowserPage(cdp, signal, { fullPage: true }, 2.5)).toMatchObject({ width: 800, height: 2400 });
    expect(send).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", expect.objectContaining({ deviceScaleFactor: 2.5 }));
  });
  it("bounds layout waits as well as PNG encoding", async () => {
    const { cdp, signal } = fixture();
    vi.spyOn(cdp, "send").mockImplementation(() => new Promise(() => {}));
    await expect(captureBrowserPage(cdp, signal, {}, 1, 20)).rejects.toMatchObject({ code: "screenshot-timeout" });
  });
  it("cancels a pending capture without waiting for its deadline", async () => {
    const { cdp } = fixture();
    vi.spyOn(cdp, "send").mockImplementation(() => new Promise(() => {}));
    const abort = new AbortController();
    const pending = captureBrowserPage(cdp, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
  it.each([[0, 200], [100, 0], [Infinity, 20], [NaN, 20]])("rejects invalid layout %s by %s", async (width, height) => {
    const { cdp, signal } = fixture(width, height);
    await expect(captureBrowserPage(cdp, signal, { fullPage: true })).rejects.toMatchObject({ code: "screenshot-unavailable" });
  });
  it("rejects an invalid PNG before returning it", async () => {
    const { cdp, signal, send } = fixture();
    const original = send.getMockImplementation();
    if (!original) throw new Error("Capture fixture has no protocol session");
    send.mockImplementation(async (method, params) => method === "Page.captureScreenshot" ? { data: "invalid" } : original(method, params));
    await expect(captureBrowserPage(cdp, signal, { fullPage: true })).rejects.toMatchObject({ code: "screenshot-failed" });
    expect(send).toHaveBeenCalledWith("Emulation.clearDeviceMetricsOverride");
    expect(send).toHaveBeenLastCalledWith("Runtime.callFunctionOn", expect.any(Object));
  });
  it("clears device metrics after a stalled screenshot reaches its deadline", async () => {
    const { cdp, signal, send } = fixture();
    const original = send.getMockImplementation();
    if (!original) throw new Error("Capture fixture has no protocol session");
    send.mockImplementation((method, params) => method === "Page.captureScreenshot" ? new Promise(() => {}) : original(method, params));
    await expect(captureBrowserPage(cdp, signal, { fullPage: true }, 1, 60)).rejects.toMatchObject({ code: "screenshot-timeout" });
    expect(send).toHaveBeenCalledWith("Emulation.clearDeviceMetricsOverride");
    expect(send).toHaveBeenLastCalledWith("Runtime.callFunctionOn", expect.any(Object));
  });
  it("uses cleanup authority after caller cancellation without reusing page-action authority", async () => {
    const { cdp, send } = fixture();
    const abort = new AbortController();
    const original = send.getMockImplementation();
    if (!original) throw new Error("Capture fixture has no protocol session");
    const clear = vi.fn(async () => {});
    const restore = vi.fn(async () => {});
    cdp.clearDeviceMetrics = clear;
    cdp.restoreCaptureScroll = restore;
    send.mockImplementation(async (method, params) => {
      if (method === "Page.captureScreenshot") { abort.abort(); return new Promise(() => {}); }
      if (abort.signal.aborted) throw new Error("Page action authority ended");
      return original(method, params);
    });
    await expect(captureBrowserPage(cdp, abort.signal, { fullPage: true })).rejects.toMatchObject({ code: "cancelled" });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith({ executionContextId: 73, x: 10, y: 20 });
  });
});
