import { expect, test, type TestInfo } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsolatedElectronEnv, launchElectron, setWindowSize } from "./seeded-electron.js";
import type { BrowserScreenshotOptions } from "../../../src/shared/browser-capture.js";
import type { CaptureNativeFixture, CaptureNativeResult } from "./browser-capture-native/contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "browser-capture-native");
let mainOut: string;
let assets: string;

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  assets = testInfo.outputPath("capture-native-assets");
  await fs.mkdir(assets, { recursive: true });
  mainOut = join(assets, "main.mjs");
  await Promise.all([
    build({ entryPoints: [join(FIXTURE, "preload.ts")], outfile: join(assets, "preload.cjs"), bundle: true, format: "cjs", platform: "node", external: ["electron"], logLevel: "silent" }),
    build({ entryPoints: [join(FIXTURE, "renderer.tsx")], outfile: join(assets, "renderer.js"), bundle: true, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent" }),
    build({ entryPoints: [join(FIXTURE, "main.ts")], outfile: mainOut, bundle: true, format: "esm", platform: "node", target: "es2022", external: ["electron"],
      banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, logLevel: "silent" }),
  ]);
});

async function launch(testInfo: TestInfo): Promise<ElectronApplication> {
  const runtime = testInfo.outputPath("runtime");
  await fs.mkdir(runtime, { recursive: true });
  const app = await launchElectron({
    args: [mainOut, `--user-data-dir=${join(runtime, "profile")}`], timeout: 30_000,
    env: buildIsolatedElectronEnv({ AVE_HOME: join(runtime, "ave-home"), AVE_CAPTURE_FIXTURE_ASSETS: assets,
      AVE_CAPTURE_FIXTURE_RUNTIME: runtime, AVE_CAPTURE_FIXTURE_PAGE: join(HERE, "browser-actions-native/page.html") }),
  });
  app.process().stderr?.on("data", (data: Buffer) => process.stdout.write(`[capture-native:stderr] ${data}`));
  try {
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { captureNativeFixture?: CaptureNativeFixture }).captureNativeFixture?.ready === true), { timeout: 30_000 }).toBe(true);
    await setWindowSize(app, 1180, 820);
    await (await app.firstWindow()).bringToFront();
    await app.evaluate(({ app: fixtureApp, BrowserWindow }) => {
      fixtureApp.focus({ steal: true });
      BrowserWindow.getAllWindows()[0]?.focus();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused())).toBe(true);
    return app;
  } catch (error) { await app.close().catch(() => {}); throw error; }
}

async function capture(app: ElectronApplication, options: BrowserScreenshotOptions, zoom = 1): Promise<CaptureNativeResult> {
  return app.evaluate(async (_main, input) => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.capture(input.options, input.zoom), { options, zoom });
}

async function close(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture.close()).catch(() => {});
  await app.close().catch(() => {});
}

async function attachImage(testInfo: TestInfo, name: string, result: CaptureNativeResult): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await fs.writeFile(path, Buffer.from(result.data, "base64"));
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("native full-page capture includes the tall page bottom pixels", async ({ browserName: _browserName }, testInfo) => {
  const app = await launch(testInfo);
  try {
    const result = await capture(app, { fullPage: true });
    await attachImage(testInfo, "full-page-capture", result);
    expect(result.dimensions.height).toBeGreaterThan(result.viewport.height * 2);
    expect(result.dimensions).toEqual(result.content);
    expect(result.bottomPixelRGB).toEqual([0, 166, 90]);
    expect(result.truncated).toBe(false);
  } finally { await close(app); }
});

for (const zoom of [1, 1.25]) {
  test(`native ref capture keeps the element CSS size at zoom ${zoom}`, async ({ browserName: _browserName }, testInfo) => {
    const app = await launch(testInfo);
    try {
      const result = await capture(app, { ref: "Drag source" }, zoom);
      await attachImage(testInfo, `ref-capture-${zoom}`, result);
      expect(result.element).toEqual({ width: 145, height: 56 });
      expect(result.dimensions).toEqual(result.element);
      // Display color conversion and image resampling can round individual channels.
      for (const pixel of result.elementPixelsRGB) {
        for (const [index, expected] of [51, 102, 170].entries()) {
          expect(Math.abs((pixel[index] ?? 255) - expected)).toBeLessThanOrEqual(16);
        }
      }
    } finally { await close(app); }
  });
}

test("native parked agent tab wakes for full-page capture without selecting its slot", async ({ browserName: _browserName }, testInfo) => {
  const app = await launch(testInfo);
  try {
    const host = await app.firstWindow();
    await host.locator("#slot").evaluate((element) => { element.style.display = "none"; });
    const frame = host.getByTestId("web-surface-frame");
    await expect.poll(() => frame.evaluate((element) => getComputedStyle(element).visibility), { timeout: 15_000 }).toBe("hidden");
    const result = await capture(app, { fullPage: true });
    expect(result.dimensions.height).toBeGreaterThan(result.viewport.height * 2);
    expect(result.dimensions).toEqual(result.content);
    expect(result.bottomPixelRGB).toEqual([0, 166, 90]);
    await expect(host.locator("#slot")).toBeHidden();
    await expect(frame).toHaveAttribute("aria-hidden", "true");
    await attachImage(testInfo, "parked-full-page-capture", result);
  } finally { await close(app); }
});

test("native parked agent tab captures its viewport and returns to sleep", async ({ browserName: _browserName }, testInfo) => {
  const app = await launch(testInfo);
  try {
    const host = await app.firstWindow();
    await host.locator("#slot").evaluate((element) => { element.style.display = "none"; });
    const frame = host.getByTestId("web-surface-frame");
    await expect.poll(() => frame.evaluate((element) => getComputedStyle(element).visibility), { timeout: 15_000 }).toBe("hidden");
    const result = await capture(app, {});
    expect(result.dimensions).toEqual(result.viewport);
    expect(result.truncated).toBe(false);
    await expect(host.locator("#slot")).toBeHidden();
    await attachImage(testInfo, "parked-viewport-capture", result);
    await expect.poll(() => frame.evaluate((element) => getComputedStyle(element).visibility), { timeout: 5_000 }).toBe("hidden");
  } finally { await close(app); }
});
