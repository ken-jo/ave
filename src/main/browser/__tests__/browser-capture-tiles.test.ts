import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { captureBrowserPage, captureBrowserViewport } from "../browser-capture.js";
import { captureScrollParameters } from "../browser-capture-scroll.js";
import type { CdpSession } from "../browser-action-guard.js";

const WIDTH = 4;
const VIEWPORT_HEIGHT = 4;
const CONTENT_HEIGHT = 10;
const COLORS = [[220, 38, 38], [22, 163, 74], [37, 99, 235], [234, 179, 8]] as const;

function colorAt(row: number): readonly number[] {
  if (row < 4) return COLORS[0];
  if (row < 6) return COLORS[1];
  if (row < 8) return COLORS[2];
  return COLORS[3];
}

async function tile(pageY: number): Promise<string> {
  const pixels = Buffer.alloc(WIDTH * VIEWPORT_HEIGHT * 3);
  for (let row = 0; row < VIEWPORT_HEIGHT; row += 1) {
    const color = colorAt(Math.min(CONTENT_HEIGHT - 1, pageY + row));
    for (let column = 0; column < WIDTH; column += 1) {
      const offset = (row * WIDTH + column) * 3;
      pixels[offset] = color[0] ?? 0;
      pixels[offset + 1] = color[1] ?? 0;
      pixels[offset + 2] = color[2] ?? 0;
    }
  }
  return (await sharp(pixels, { raw: { width: WIDTH, height: VIEWPORT_HEIGHT, channels: 3 } }).png().toBuffer()).toString("base64");
}

function tiledSession(pixelRatio = 1, zoom = 1, captureTile?: (pageY: number) => Promise<Buffer>) {
  let pageY = 0;
  const restore = vi.fn(async () => {});
  const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "Page.getLayoutMetrics") return {
      cssContentSize: { x: 0, y: 0, width: WIDTH, height: CONTENT_HEIGHT },
      cssVisualViewport: { pageX: 0, pageY, clientWidth: WIDTH, clientHeight: VIEWPORT_HEIGHT },
    };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 73 };
    if (method === "Runtime.callFunctionOn") {
      const values = params?.arguments as Array<{ value: unknown }>;
      pageY = Math.min(Number(values[1]?.value), CONTENT_HEIGHT - VIEWPORT_HEIGHT);
      return {};
    }
    if (method === "Page.captureScreenshot") {
      const png = captureTile ? await captureTile(pageY) : await sharp(Buffer.from(await tile(pageY), "base64"))
        .resize({ width: WIDTH * pixelRatio * zoom, height: VIEWPORT_HEIGHT * pixelRatio * zoom, kernel: "nearest" }).png().toBuffer();
      return { data: png.toString("base64") };
    }
    throw new Error(`unexpected protocol call: ${method}`);
  });
  const cdp: CdpSession = {
    fullPageTiling: true,
    send,
    restoreCaptureScroll: restore,
    onEvent: () => () => {},
  };
  return {
    cdp, send, restore,
    captureViewport: () => captureBrowserViewport({ getZoomFactor: () => zoom }, () => {}, pixelRatio, cdp),
  };
}

describe("browser capture tiles", () => {
  it.each([{ pixelRatio: 1, zoom: 1 }, { pixelRatio: 2, zoom: 1 }, { pixelRatio: 3, zoom: 1 }, { pixelRatio: 2, zoom: 1.25 }])("stitches every document row and clips the overlap at density $pixelRatio and zoom $zoom", async ({ pixelRatio, zoom }) => {
    const { cdp, send, restore, captureViewport } = tiledSession(pixelRatio, zoom);
    const result = await captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport);
    expect(result).toMatchObject({ width: WIDTH, height: CONTENT_HEIGHT, originalHeight: CONTENT_HEIGHT, truncated: false, captureMethod: "scroll-and-stitch" });
    const decoded = await sharp(Buffer.from(result.data, "base64")).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: WIDTH, height: CONTENT_HEIGHT, channels: 4 });
    const pixel = (row: number) => [...decoded.data.subarray(row * WIDTH * 4, row * WIDTH * 4 + 3)];
    for (let row = 0; row < CONTENT_HEIGHT; row += 1) expect(pixel(row)).toEqual(colorAt(row));
    expect(pixel(0)).toEqual(COLORS[0]);
    expect(pixel(3)).toEqual(COLORS[0]);
    expect(pixel(4)).toEqual(COLORS[1]);
    expect(pixel(5)).toEqual(COLORS[1]);
    expect(pixel(6)).toEqual(COLORS[2]);
    expect(pixel(7)).toEqual(COLORS[2]);
    expect(pixel(8)).toEqual(COLORS[3]);
    expect(pixel(9)).toEqual(COLORS[3]);
    expect(send.mock.calls.filter(([method]) => method === "Runtime.callFunctionOn").map(([, params]) =>
      (params as { arguments: Array<{ value: unknown }> }).arguments.slice(0, 2).map((argument) => argument.value),
    )).toEqual([[0, 0], [0, 4], [0, 8]]);
    expect(restore).toHaveBeenCalledWith({ executionContextId: 73, x: 0, y: 0 });
    expect(send.mock.calls.filter(([method]) => method === "Page.captureScreenshot")).toEqual(Array.from({ length: 3 }, () => [
      "Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true },
    ]));
  });

  it.each([[2, 2, 128], [3, 4, 255], [2.5, 3, 191]])("samples a one-device-pixel line at %sx without blurring adjacent rows", async (scale, line, expected) => {
    const nativeWidth = WIDTH * scale;
    const nativeHeight = VIEWPORT_HEIGHT * scale;
    const pixels = Buffer.alloc(nativeWidth * nativeHeight * 3);
    pixels.fill(255, line * nativeWidth * 3, (line + 1) * nativeWidth * 3);
    const png = await sharp(pixels, { raw: { width: nativeWidth, height: nativeHeight, channels: 3 } }).png().toBuffer();
    const { cdp, captureViewport } = tiledSession(scale, 1, async () => png);
    const result = await captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport);
    expect(result).toMatchObject({ width: WIDTH, height: CONTENT_HEIGHT });
    const data = await sharp(Buffer.from(result.data, "base64")).raw().toBuffer();
    expect(Array.from({ length: CONTENT_HEIGHT }, (_, row) => data[row * WIDTH * 4])).toEqual([
      0, expected, 0, 0, 0, expected, 0, 0, 0, 0,
    ]);
  });

  it("retains the embedded wide-gamut profile and pixel values", async () => {
    const tagged = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
      .withIccProfile("p3").png().toBuffer();
    const profileStart = tagged.indexOf("iCCP") - 4;
    const profile = tagged.subarray(profileStart, profileStart + 12 + tagged.readUInt32BE(profileStart));
    const color = [230, 102, 26];
    const width = WIDTH * 2.5, height = VIEWPORT_HEIGHT * 2.5;
    const png = await sharp(Buffer.alloc(width * height * 3).fill(Buffer.from(color)), {
      raw: { width, height, channels: 3 },
    }).png().toBuffer();
    const data = Buffer.concat([png.subarray(0, 33), profile, png.subarray(33)]);
    const { cdp, captureViewport } = tiledSession(2.5, 1, async () => data);
    const result = await captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport);
    const output = Buffer.from(result.data, "base64");
    expect((await sharp(output).metadata()).icc).toEqual((await sharp(data).metadata()).icc);
    const actual = await sharp(output, { ignoreIcc: true }).raw().toBuffer();
    expect(actual).toEqual(Buffer.alloc(WIDTH * CONTENT_HEIGHT * 4).fill(Buffer.from([...color, 255])));
  });

  it("rejects a change in the tile color profile instead of mixing encoded gamuts", async () => {
    const input = { create: { width: WIDTH, height: VIEWPORT_HEIGHT, channels: 3 as const, background: "white" } };
    const plain = await sharp(input).png().toBuffer();
    const tagged = await sharp(input).withIccProfile("p3").png().toBuffer();
    const { cdp, captureViewport } = tiledSession(1, 1, async (pageY) => pageY === 0 ? tagged : plain);
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport))
      .rejects.toMatchObject({ code: "screenshot-unavailable" });
  });

  it("filters translucent edge pixels with their coverage", async () => {
    const width = WIDTH * 2, height = VIEWPORT_HEIGHT * 2;
    const pixels = Buffer.alloc(width * height * 4).fill(Buffer.from([0, 0, 255, 0]));
    pixels.fill(Buffer.from([255, 0, 0, 255]), width * 4, width * 8);
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const { cdp, captureViewport } = tiledSession(2, 1, async () => png);
    const result = await captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport);
    const output = await sharp(Buffer.from(result.data, "base64")).raw().toBuffer();
    expect([...output.subarray(0, 4)]).toEqual([255, 0, 0, 128]);
  });

  it("clamps edge samples when the native viewport is smaller than the CSS output", async () => {
    const pixels = Buffer.concat([Buffer.alloc(9), Buffer.alloc(9, 128), Buffer.alloc(9, 255)]);
    const png = await sharp(pixels, { raw: { width: 3, height: 3, channels: 3 } }).png().toBuffer();
    const { cdp, captureViewport } = tiledSession(0.75, 1, async () => png);
    const result = await captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport);
    const output = await sharp(Buffer.from(result.data, "base64")).raw().toBuffer();
    expect(Array.from({ length: CONTENT_HEIGHT }, (_, row) => output[row * WIDTH * 4])).toEqual([
      0, 80, 176, 255, 0, 80, 176, 255, 176, 255,
    ]);
  });

  it("uses a fixed isolated-world function with only coordinate values", () => {
    const parameters = captureScrollParameters({ executionContextId: 73, x: 4, y: 8 });
    expect(parameters).toMatchObject({ executionContextId: 73, returnByValue: true, awaitPromise: true, arguments: [{ value: 4 }, { value: 8 }] });
    expect(parameters.functionDeclaration).toContain("window.scrollTo");
    expect(parameters.functionDeclaration).not.toContain("${");
    expect(Object.keys(parameters)).toEqual(["executionContextId", "functionDeclaration", "returnByValue", "awaitPromise", "arguments"]);
  });

  it("rejects a page that does not advance to the requested tile", async () => {
    const { cdp, captureViewport } = tiledSession();
    vi.spyOn(cdp, "send").mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getLayoutMetrics") return {
        cssContentSize: { x: 0, y: 0, width: WIDTH, height: CONTENT_HEIGHT },
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: WIDTH, clientHeight: VIEWPORT_HEIGHT },
      };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 73 };
      if (method === "Runtime.callFunctionOn") return {};
      if (method === "Page.captureScreenshot") return { data: await tile(0) };
      throw new Error(`unexpected protocol call: ${method} ${String(params)}`);
    });
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport)).rejects.toMatchObject({ code: "screenshot-unavailable" });
  });

  it("rejects a tile when its viewport dimensions change during native capture", async () => {
    const { cdp, send, captureViewport } = tiledSession();
    const original = send.getMockImplementation();
    if (!original) throw new Error("Tile fixture has no protocol session");
    let layoutReads = 0;
    vi.spyOn(cdp, "send").mockImplementation(async (method, params) => {
      const response = await original(method, params);
      if (method !== "Page.getLayoutMetrics" || ++layoutReads !== 3) return response;
      const metrics = response as { cssContentSize: Record<string, number>; cssVisualViewport: Record<string, number> };
      return { ...metrics, cssVisualViewport: { ...metrics.cssVisualViewport, clientWidth: WIDTH + 1 } };
    });
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport)).rejects.toMatchObject({ code: "screenshot-unavailable" });
  });

  it("rejects a tile when horizontal scroll shifts during native capture", async () => {
    const { cdp, send, captureViewport } = tiledSession();
    const original = send.getMockImplementation();
    if (!original) throw new Error("Tile fixture has no protocol session");
    let layoutReads = 0;
    vi.spyOn(cdp, "send").mockImplementation(async (method, params) => {
      const response = await original(method, params);
      if (method !== "Page.getLayoutMetrics" || ++layoutReads !== 3) return response;
      const metrics = response as { cssContentSize: Record<string, number>; cssVisualViewport: Record<string, number> };
      return { ...metrics, cssVisualViewport: { ...metrics.cssVisualViewport, pageX: 1 } };
    });
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport)).rejects.toMatchObject({ code: "screenshot-unavailable" });
  });

  it("rejects a tile when its native capture scale changes", async () => {
    const { cdp, captureViewport } = tiledSession();
    let captures = 0;
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, async () => ({
      ...await captureViewport(), cssScale: ++captures === 1 ? 1 : 1.25,
    }))).rejects.toMatchObject({ code: "screenshot-unavailable" });
  });

  it("refuses a concurrent capture that shares a guest key", async () => {
    const pending = new Promise<never>(() => {});
    const cdp: CdpSession = {
      captureKey: {},
      send: async (method) => {
        if (method === "Page.getLayoutMetrics") return { cssContentSize: { x: 0, y: 0, width: 4, height: 4 }, cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 4, clientHeight: 4 } };
        if (method === "Page.captureScreenshot") return pending;
        throw new Error(`unexpected protocol call: ${method}`);
      },
      onEvent: () => () => {},
    };
    const abort = new AbortController();
    const first = captureBrowserPage(cdp, abort.signal, {}, 1, 10_000);
    await expect(captureBrowserPage(cdp, new AbortController().signal, {}, 1, 10_000)).rejects.toMatchObject({ code: "screenshot-busy" });
    abort.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
  });

  it("restores emulation after a rejected override", async () => {
    const clear = vi.fn(async () => {});
    const restore = vi.fn(async () => {});
    const cdp: CdpSession = {
      clearDeviceMetrics: clear,
      restoreCaptureScroll: restore,
      send: async (method) => {
        if (method === "Page.getLayoutMetrics") return { cssContentSize: { x: 0, y: 0, width: 4, height: 4 }, cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 4, clientHeight: 4 } };
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 73 };
        if (method === "Emulation.setDeviceMetricsOverride") throw new Error("override refused");
        throw new Error(`unexpected protocol call: ${method}`);
      },
      onEvent: () => () => {},
    };
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000)).rejects.toThrow("override refused");
    expect(clear).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledWith({ executionContextId: 73, x: 0, y: 0 });
  });

  it("keeps a guest capture key busy until a timed-out restoration completes", async () => {
    let finishRestore: (() => void) | undefined;
    const restored = new Promise<void>((resolve) => { finishRestore = resolve; });
    const captureKey = {};
    const cdp: CdpSession = {
      captureKey,
      restoreCaptureScroll: async () => restored,
      send: async (method) => {
        if (method === "Page.getLayoutMetrics") return { cssContentSize: { x: 0, y: 0, width: WIDTH, height: VIEWPORT_HEIGHT }, cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: WIDTH, clientHeight: VIEWPORT_HEIGHT } };
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 73 };
        if (method === "Emulation.setDeviceMetricsOverride" || method === "Emulation.clearDeviceMetricsOverride" || method === "Runtime.callFunctionOn") return {};
        if (method === "Page.captureScreenshot") return { data: await tile(0) };
        throw new Error(`unexpected protocol call: ${method}`);
      },
      onEvent: () => () => {},
    };
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 60)).rejects.toMatchObject({ code: "screenshot-timeout" });
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 60)).rejects.toMatchObject({ code: "screenshot-busy" });
    if (!finishRestore) throw new Error("Restore did not start");
    finishRestore();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 60)).resolves.toMatchObject({ width: WIDTH, height: VIEWPORT_HEIGHT });
  });

  it("releases a guest after a temporary scroll restoration failure", async () => {
    const { cdp, restore, captureViewport } = tiledSession();
    restore.mockRejectedValueOnce(new Error("Temporary restoration failure"));
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport)).rejects.toThrow("Temporary restoration failure");
    await expect(captureBrowserPage(cdp, new AbortController().signal, { fullPage: true }, 1, 10_000, captureViewport)).resolves.toMatchObject({ height: CONTENT_HEIGHT });
    expect(restore).toHaveBeenCalledTimes(2);
  });
});
