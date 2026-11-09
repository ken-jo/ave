import { expect, type TestInfo } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSharedElectronTest } from "./shared-electron.js";
import { closeNativeFixture, launchNativeFixture, nativeFixturePaths } from "./native-fixture-runtime.js";
import { buildIsolatedElectronEnv, launchElectron, setWindowSize } from "./seeded-electron.js";
import type { BrowserScreenshotOptions } from "../../../src/shared/browser-capture.js";
import type { CaptureNativeFixture, CaptureNativeResult } from "./browser-capture-native/contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "browser-capture-native");
const test = createSharedElectronTest<ElectronApplication>({
  launch: async () => {
    const app = await launchNativeFixture("ave-browser-capture-", async ({ runtime, assets }) => {
      const home = join(runtime, "home");
      const mainOut = join(assets, "main.mjs");
      await fs.mkdir(home, { recursive: true });
      await build({ entryPoints: [join(FIXTURE, "preload.ts")], outfile: join(assets, "preload.cjs"), bundle: true, format: "cjs", platform: "node", external: ["electron"], logLevel: "silent" });
      await build({ entryPoints: [join(FIXTURE, "renderer.tsx")], outfile: join(assets, "renderer.js"), bundle: true, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent" });
      await build({ entryPoints: [join(FIXTURE, "main.ts")], outfile: mainOut, bundle: true, format: "esm", platform: "node", target: "es2022", external: ["electron", "@napi-rs/canvas"],
        banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, logLevel: "silent" });
      return launchElectron({
        args: [mainOut, `--user-data-dir=${join(runtime, "profile")}`], timeout: 30_000,
        env: buildIsolatedElectronEnv({ HOME: home, USERPROFILE: home, AVE_HOME: join(runtime, "ave-home"), AVE_CAPTURE_FIXTURE_ASSETS: assets,
          AVE_CAPTURE_FIXTURE_RUNTIME: runtime, AVE_CAPTURE_FIXTURE_PAGE: join(HERE, "browser-actions-native/page.html") }),
      });
    });
    app.process().stderr?.on("data", (data: Buffer) => process.stdout.write(`[capture-native:stderr] ${data}`));
    try {
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { captureNativeFixture?: CaptureNativeFixture }).captureNativeFixture?.ready === true), { timeout: 30_000 }).toBe(true);
      await setWindowSize(app, 1180, 820);
      return app;
    } catch (startupError) {
      try { await close(app); }
      catch (teardownError) { throw new AggregateError([startupError, teardownError], "Native fixture startup and teardown failed"); }
      throw startupError;
    }
  },
  reset: async (app) => {
    await app.evaluate(() => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.reset());
    await setWindowSize(app, 1180, 820);
  },
  assertClean: async (app) => {
    await app.evaluate(() => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.assertClean());
    expect(await app.evaluate(async ({ BrowserWindow, webContents }) => {
      const windows = BrowserWindow.getAllWindows();
      const guests = webContents.getAllWebContents().filter((contents) => contents.getType() === "webview");
      const guest = guests[0];
      return { windows: windows.length, guests: guests.length, visible: windows[0]?.isVisible(), focused: windows.some(window => window.isFocused()),
        zoom: guest?.getZoomFactor(), page: await guest?.executeJavaScript("({x:scrollX,y:scrollY,storage:localStorage.length,session:sessionStorage.length,url:location.pathname})"),
        cookies: (await guest?.session.cookies.get({}))?.length };
    })).toEqual({ windows: 1, guests: 1, visible: true, focused: false, zoom: 1,
      page: { x: 0, y: 0, storage: 0, session: 0, url: "/page" }, cookies: 0 });
    const page = await app.firstWindow();
    await expect(page.locator("#slot")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  },
  close,
});

async function capture(app: ElectronApplication, options: BrowserScreenshotOptions, zoom = 1): Promise<CaptureNativeResult> {
  return app.evaluate(async (_main, input) => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.capture(input.options, input.zoom), { options, zoom });
}

async function close(app: ElectronApplication): Promise<void> {
  await closeNativeFixture(app, () => app.evaluate(() =>
    (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.close()));
}

async function attachImage(testInfo: TestInfo, name: string, result: CaptureNativeResult): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await fs.writeFile(path, Buffer.from(result.data, "base64"));
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function expectFixtureBands(result: CaptureNativeResult): void {
  // Sample beyond each band boundary as well as its interior to detect stretched tiles.
  const expected = [[229, 83, 61], [47, 120, 220], [47, 120, 220], [214, 181, 39], [214, 181, 39], [145, 77, 200], [145, 77, 200], [0, 166, 90], [0, 166, 90]];
  expect(result.bandPixelsRGB).toHaveLength(expected.length);
  // Native display color conversion can round an individual channel by one.
  for (const [index, band] of expected.entries()) {
    for (const [channel, value] of band.entries()) expect(Math.abs((result.bandPixelsRGB[index]?.[channel] ?? -255) - value)).toBeLessThanOrEqual(2);
  }
  for (const [channel, value] of [0, 166, 90].entries()) expect(Math.abs((result.bottomPixelRGB[channel] ?? -255) - value)).toBeLessThanOrEqual(2);
}

test("native capture fixture isolates its home from the parent process", async ({ sharedApp: app }) => {
  const runtime = nativeFixturePaths(app).runtime;
  const expected = join(runtime, "home");
  const child = await app.evaluate(() => {
    const home = process.env.HOME;
    return { home, userProfile: process.env.USERPROFILE, osHome: process.getBuiltinModule("node:os").homedir(),
      aveHome: process.env.AVE_HOME, homeDirectory: home !== undefined && process.getBuiltinModule("node:fs").statSync(home).isDirectory() };
  });
  expect(child).toEqual({ home: expected, userProfile: expected, osHome: expected,
    aveHome: join(runtime, "ave-home"), homeDirectory: true });
  expect(child.home).not.toBe(process.env.HOME);
});

async function layout(app: ElectronApplication) {
  const native = await app.evaluate(({ BrowserWindow, webContents }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
    if (!window || !guest) throw new Error("Capture fixture native layout is unavailable");
    return { bounds: window.getContentBounds(), zoom: guest.getZoomFactor() };
  });
  const guest = await app.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find((entry) => entry.getType() === "webview");
    if (!contents) throw new Error("Capture fixture guest is unavailable");
    return contents.executeJavaScript("({width:visualViewport.width,height:visualViewport.height,x:scrollX,y:scrollY})");
  });
  return { native, guest, slot: await (await app.firstWindow()).locator("#slot").boundingBox() };
}

for (const zoom of [1, 1.25]) {
  test(`native full-page capture includes the tall page bottom pixels at zoom ${zoom}`, async ({ sharedApp: app }, testInfo) => {
    let before: Awaited<ReturnType<typeof layout>> | undefined;
    try {
      await app.evaluate(async ({ webContents }, zoom) => {
        const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
        if (!guest) throw new Error("Capture fixture guest is unavailable");
        guest.setZoomFactor(zoom);
        await guest.executeJavaScript("scrollTo(0,123)");
      }, zoom);
      before = await layout(app);
      // Scroll positions quantize to rendered pixels at guest zoom.
      expect(Math.abs(before.guest.y - 123)).toBeLessThanOrEqual(1 / zoom);
      const result = await capture(app, { fullPage: true }, zoom);
      await attachImage(testInfo, "full-page-capture", result);
      expect(result.dimensions.height).toBeGreaterThan(result.viewport.height * 2);
      expect(result.dimensions.width).toBe(Math.ceil(result.viewport.width));
      // Layout metrics and DOM scroll height can round differently at fractional zoom.
      expect(Math.abs(result.dimensions.height - result.content.height)).toBeLessThanOrEqual(1);
      expectFixtureBands(result);
      expect(result.truncated).toBe(false);
    } finally {
      if (before) {
        await expect.poll(() => layout(app)).toEqual(before);
        await testInfo.attach("restored-panel-layout", { body: JSON.stringify({ before, after: await layout(app) }), contentType: "application/json" });
      }
    }
  });
}

for (const zoom of [1, 1.25]) {
  test(`native ref capture keeps the element CSS size at zoom ${zoom}`, async ({ sharedApp: app }, testInfo) => {
    await app.evaluate(async ({ webContents }, zoom) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
      if (!guest) throw new Error("Capture fixture guest is unavailable");
      guest.setZoomFactor(zoom);
      await guest.executeJavaScript("scrollTo(0,20)");
    }, zoom);
    const result = await capture(app, { ref: "Drag source" }, zoom);
    await attachImage(testInfo, `ref-capture-${zoom}`, result);
    expect(result.element).toEqual({ width: 145, height: 56 });
    expect(result.dimensions).toEqual(result.element);
    expect((await layout(app)).guest.y).toBe(20);
    // Display color conversion and image resampling can round individual channels.
    for (const pixel of result.elementPixelsRGB) {
      for (const [index, expected] of [51, 102, 170].entries()) {
        expect(Math.abs((pixel[index] ?? 255) - expected)).toBeLessThanOrEqual(16);
      }
    }
  });
}

test("native parked agent tab wakes for full-page capture without selecting its slot", async ({ sharedApp: app }, testInfo) => {
  const host = await app.firstWindow();
  await host.locator("#slot").evaluate((element) => { element.style.display = "none"; });
  const frame = host.getByTestId("web-surface-frame");
  await expect.poll(() => frame.evaluate((element) => getComputedStyle(element).visibility), { timeout: 15_000 }).toBe("hidden");
  const result = await capture(app, { fullPage: true });
  expect(result.dimensions.height).toBeGreaterThan(result.viewport.height * 2);
  expect(result.dimensions).toEqual({ width: result.viewport.width, height: result.content.height });
  expectFixtureBands(result);
  await expect(host.locator("#slot")).toBeHidden();
  await expect(frame).toHaveAttribute("aria-hidden", "true");
  await attachImage(testInfo, "parked-full-page-capture", result);
});

test("native parked agent tab captures its viewport and returns to sleep", async ({ sharedApp: app }, testInfo) => {
  const backgroundThrottled = () => app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
    if (!guest) throw new Error("Capture fixture guest is unavailable");
    return guest.getBackgroundThrottling();
  });
  // Exercise restoration from a throttled baseline; background test guests start unthrottled.
  await app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
    if (!guest) throw new Error("Capture fixture guest is unavailable");
    guest.setBackgroundThrottling(true);
  });
  expect(await backgroundThrottled()).toBe(true);
  const host = await app.firstWindow();
  await host.locator("#slot").evaluate((element) => { element.style.display = "none"; });
  const frame = host.getByTestId("web-surface-frame");
  await expect.poll(() => frame.evaluate((element) => getComputedStyle(element).visibility), { timeout: 15_000 }).toBe("hidden");
  const result = await capture(app, {});
  expect(await backgroundThrottled()).toBe(false);
  expect(result.dimensions).toEqual(result.viewport);
  expect(result.truncated).toBe(false);
  await expect(host.locator("#slot")).toBeHidden();
  await expect(frame).toHaveAttribute("aria-hidden", "true");
  await expect(frame).toHaveAttribute("inert", "");
  await attachImage(testInfo, "parked-viewport-capture", result);
  await expect.poll(() => frame.evaluate((element) => getComputedStyle(element).visibility), { timeout: 5_000 }).toBe("hidden");
  await expect.poll(backgroundThrottled, { timeout: 5_000 }).toBe(true);
});
