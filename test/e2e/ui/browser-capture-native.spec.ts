import { expect, type TestInfo } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSharedElectronTest } from "./shared-electron.js";
import { closeNativeFixture, launchNativeFixture, nativeFixturePaths } from "./native-fixture-runtime.js";
import { buildIsolatedElectronEnv, launchElectron, REPO_ROOT, setWindowSize } from "./seeded-electron.js";
import type { BrowserScreenshotOptions } from "../../../src/shared/browser-capture.js";
import type { CaptureNativeFixture, CaptureNativeResult } from "./browser-capture-native/contract.js";
import { browserTargetId, inspectBrowserTarget } from "./browser-native-target.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "browser-capture-native");
const test = createSharedElectronTest<ElectronApplication>({
  launch: async (_key, workerInfo) => {
    const temporaryRoot = await fs.realpath(tmpdir());
    if (temporaryRoot === "/private/tmp" || temporaryRoot.startsWith("/private/tmp/")) throw new Error("Capture fixture requires an external temporary directory");
    const app = await launchNativeFixture("ave-browser-capture-", async ({ runtime, assets }) => {
      const home = join(runtime, "home");
      const mainOut = join(assets, "host", "src", "main", "main.js");
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(dirname(mainOut), { recursive: true });
      await fs.copyFile(join(REPO_ROOT, "dist", "src", "preload.cjs"), join(assets, "host", "src", "preload.cjs"));
      await build({ entryPoints: [join(FIXTURE, "renderer.tsx")], outfile: join(assets, "renderer.js"), bundle: true, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent" });
      await build({ entryPoints: [join(FIXTURE, "main.ts")], outfile: mainOut, bundle: true, format: "esm", platform: "node", target: "es2022", external: ["electron", "@napi-rs/canvas"],
        banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, logLevel: "silent" });
      return launchElectron({
        args: [mainOut, `--user-data-dir=${join(runtime, "profile")}`], timeout: 30_000,
        env: buildIsolatedElectronEnv({ HOME: home, USERPROFILE: home, AVE_HOME: join(runtime, "ave-home"), AVE_CAPTURE_FIXTURE_ASSETS: assets,
          AVE_CAPTURE_FIXTURE_RUNTIME: runtime, AVE_CAPTURE_FIXTURE_PAGE: join(HERE, "browser-actions-native/page.html") }),
      });
    }, workerInfo.project.outputDir);
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
    expect(await app.evaluate(async ({ BaseWindow, webContents }) => {
      const windows = BaseWindow.getAllWindows();
      const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
      const owner = BaseWindow.fromId(fixture.windowId);
      if (!owner) throw new Error("Capture fixture owner is unavailable");
      const chrome = webContents.getAllWebContents().find(contents => contents === Reflect.get(owner, "webContents"));
      if (!chrome) throw new Error("Capture fixture UI is unavailable");
      const guests = webContents.getAllWebContents().filter(contents => contents.getType() === "window" && contents.id !== chrome.id);
      const guest = guests[0];
      return { windows: windows.length, guests: guests.length, visible: windows[0]?.isVisible(), focused: windows.some(window => window.isFocused()),
        independent: guest?.id === fixture.targetId && !guest.hostWebContents,
        zoom: guest?.getZoomFactor(), page: await guest?.executeJavaScript("({x:scrollX,y:scrollY,storage:localStorage.length,session:sessionStorage.length,url:location.pathname})"),
        cookies: (await guest?.session.cookies.get({}))?.length };
    })).toEqual({ windows: 1, guests: 1, visible: true, focused: false, independent: true, zoom: 1,
      page: { x: 0, y: 0, storage: 0, session: 0, url: "/page" }, cookies: 0 });
    const page = await app.firstWindow();
    await expect(page.locator("#slot")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  },
  close,
});

test.beforeEach(async ({ sharedApp: app }) => {
  const host = await app.firstWindow();
  const slot = await host.locator("#slot").boundingBox();
  if (!slot) throw new Error("Capture fixture slot is unavailable");
  const target = await app.evaluate(() => {
    const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
    return { windowId: fixture.windowId, url: fixture.pageUrl };
  });
  await expect.poll(() => inspectBrowserTarget(app, target.windowId, target.url))
    .toMatchObject({ type: "window", embedded: false, connected: true, attached: true });
  // Binding precedes asynchronous native presentation; measure restoration only after the page has its pane viewport.
  await expect.poll(() => app.evaluate(async ({ webContents }) => {
    const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
    const guest = webContents.fromId(fixture.targetId);
    if (!guest) throw new Error("Capture fixture guest is unavailable");
    return guest.executeJavaScript("({ width: innerWidth, height: innerHeight })");
  })).toEqual({ width: Math.round(slot.width), height: Math.round(slot.height) });
});

async function setGuestZoom(app: ElectronApplication, zoom: number): Promise<void> {
  const slot = await (await app.firstWindow()).locator("#slot").boundingBox();
  if (!slot) throw new Error("Capture fixture slot is unavailable");
  await app.evaluate(({ webContents }, factor) => {
    const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
    const guest = webContents.fromId(fixture.targetId);
    if (!guest) throw new Error("Capture fixture guest is unavailable");
    guest.setZoomFactor(factor);
  }, zoom);
  await expect.poll(() => app.evaluate(async ({ webContents }) => {
    const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
    const guest = webContents.fromId(fixture.targetId);
    if (!guest) throw new Error("Capture fixture guest is unavailable");
    return guest.executeJavaScript("({ width: innerWidth, height: innerHeight, visibility: document.visibilityState })");
  })).toEqual({ width: Math.round(slot.width / zoom), height: Math.round(slot.height / zoom), visibility: "visible" });
}

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

test("native capture build assets stay inside the invocation output", async ({ sharedApp: app }, testInfo) => {
  const { assets } = nativeFixturePaths(app);
  expect(dirname(assets)).toBe(await fs.realpath(testInfo.project.outputDir));
  expect((await fs.readFile(join(assets, "renderer.js"), "utf8")).length).toBeGreaterThan(0);
  await app.evaluate(() => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.reset());
  await expect((await app.firstWindow()).locator("#slot")).toBeVisible();
});

async function layout(app: ElectronApplication) {
  const target = await app.evaluate(() => {
    const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
    return { windowId: fixture.windowId, targetId: fixture.targetId, pageUrl: fixture.pageUrl };
  });
  expect(await browserTargetId(app, target.pageUrl)).toBe(target.targetId);
  const native = await app.evaluate(({ BaseWindow, webContents }, target) => {
    const window = BaseWindow.fromId(target.windowId);
    const guest = webContents.fromId(target.targetId);
    if (!window || !guest) throw new Error("Capture fixture native layout is unavailable");
    return { bounds: window.getContentBounds(), zoom: guest.getZoomFactor(), type: guest.getType(), embedded: Boolean(guest.hostWebContents) };
  }, target);
  expect(native).toMatchObject({ type: "window", embedded: false });
  const guest = await app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id);
    if (!contents) throw new Error("Capture fixture guest is unavailable");
    return contents.executeJavaScript("({width:visualViewport.width,height:visualViewport.height,x:scrollX,y:scrollY})");
  }, target.targetId);
  return { native, guest, slot: await (await app.firstWindow()).locator("#slot").boundingBox() };
}

for (const zoom of [1, 1.25]) {
  test(`native full-page capture includes the tall page bottom pixels at zoom ${zoom}`, async ({ sharedApp: app }, testInfo) => {
    let before: Awaited<ReturnType<typeof layout>> | undefined;
    try {
      await setGuestZoom(app, zoom);
      await app.evaluate(async ({ webContents }) => {
        const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
      const guest = webContents.fromId(fixture.targetId);
        if (!guest) throw new Error("Capture fixture guest is unavailable");
        await guest.executeJavaScript("scrollTo(0,123)");
      });
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
    await setGuestZoom(app, zoom);
    await app.evaluate(async ({ webContents }) => {
      const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
      const guest = webContents.fromId(fixture.targetId);
      if (!guest) throw new Error("Capture fixture guest is unavailable");
      await guest.executeJavaScript("scrollTo(0,20)");
    });
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
  const target = await app.evaluate(() => {
    const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
    return { windowId: fixture.windowId, targetId: fixture.targetId, pageUrl: fixture.pageUrl };
  });
  await host.locator("#slot").evaluate((element) => { element.style.display = "none"; });
  await expect.poll(async () => (await inspectBrowserTarget(app, target.windowId, target.pageUrl)).attached, { timeout: 15_000 }).toBe(false);
  const result = await capture(app, { fullPage: true });
  expect(result.dimensions.height).toBeGreaterThan(result.viewport.height * 2);
  expect(result.dimensions).toEqual({ width: result.viewport.width, height: result.content.height });
  expectFixtureBands(result);
  await expect(host.locator("#slot")).toBeHidden();
  expect(await inspectBrowserTarget(app, target.windowId, target.pageUrl)).toMatchObject({ id: target.targetId, attached: false });
  await attachImage(testInfo, "parked-full-page-capture", result);
});

test("parked native page retains compositor frames and trusted clicks without disturbing the host editor", async ({ sharedApp: app }, testInfo) => {
  const host = await app.firstWindow();
  const target = await app.evaluate(() => {
    const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
    return { windowId: fixture.windowId, targetId: fixture.targetId, pageUrl: fixture.pageUrl };
  });
  await host.locator("#slot").evaluate(element => { element.style.display = "none"; });
  await expect.poll(() => inspectBrowserTarget(app, target.windowId, target.pageUrl)).toMatchObject({ connected: true, attached: false });
  await host.locator("#composer").fill("unfinished host draft");
  await host.locator("#composer").evaluate(element => {
    element.setAttribute("data-blurs", "0");
    element.addEventListener("blur", () => { element.setAttribute("data-blurs", String(Number(element.getAttribute("data-blurs")) + 1)); });
  });
  try {
    await app.evaluate(() => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.startPreview());
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.previewFrame()?.data.length ?? 0)).toBeGreaterThan(1000);
    const frame = await app.evaluate(() => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.previewFrame());
    if (!frame) throw new Error("Native preview frame disappeared");
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
    expect(await app.evaluate(() => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.clickHuman()))
      .toEqual({ clicks: 1, trusted: true });
    await expect(host.locator("#composer")).toBeFocused();
    await expect(host.locator("#composer")).toHaveValue("unfinished host draft");
    await expect(host.locator("#composer")).toHaveAttribute("data-blurs", "0");
    expect(await inspectBrowserTarget(app, target.windowId, target.pageUrl)).toMatchObject({ connected: true, attached: false, ownerFocused: false });
    const path = testInfo.outputPath("parked-compositor.jpg");
    await fs.writeFile(path, Buffer.from(frame.data, "base64"));
    await testInfo.attach("parked-compositor", { path, contentType: "image/jpeg" });
  } finally {
    await app.evaluate(() => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.stopPreview());
  }
});

test("native parked agent tab captures its viewport and returns to sleep", async ({ sharedApp: app }, testInfo) => {
  const backgroundThrottled = () => app.evaluate(({ webContents }) => {
    const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
    const guest = webContents.fromId(fixture.targetId);
    if (!guest) throw new Error("Capture fixture guest is unavailable");
    return guest.getBackgroundThrottling();
  });
  // Exercise restoration from a throttled baseline; background test guests start unthrottled.
  await app.evaluate(({ webContents }) => {
    const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
    const guest = webContents.fromId(fixture.targetId);
    if (!guest) throw new Error("Capture fixture guest is unavailable");
    guest.setBackgroundThrottling(true);
  });
  expect(await backgroundThrottled()).toBe(true);
  const host = await app.firstWindow();
  const target = await app.evaluate(() => {
    const fixture = (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture;
    return { windowId: fixture.windowId, targetId: fixture.targetId, pageUrl: fixture.pageUrl };
  });
  await host.locator("#slot").evaluate((element) => { element.style.display = "none"; });
  await expect.poll(async () => (await inspectBrowserTarget(app, target.windowId, target.pageUrl)).attached, { timeout: 15_000 }).toBe(false);
  const result = await capture(app, {});
  expect(await backgroundThrottled()).toBe(false);
  expect(result.dimensions).toEqual(result.viewport);
  expect(result.truncated).toBe(false);
  await expect(host.locator("#slot")).toBeHidden();
  expect(await inspectBrowserTarget(app, target.windowId, target.pageUrl)).toMatchObject({ id: target.targetId, attached: false });
  await attachImage(testInfo, "parked-viewport-capture", result);
  await expect.poll(async () => (await inspectBrowserTarget(app, target.windowId, target.pageUrl)).attached, { timeout: 5_000 }).toBe(false);
  await expect.poll(backgroundThrottled, { timeout: 5_000 }).toBe(true);
});
