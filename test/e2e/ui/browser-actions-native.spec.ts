import { expect, test, type TestInfo } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsolatedElectronEnv, launchElectron } from "./seeded-electron.js";
import type { NativeAction, NativeActionResult, NativeBrowserFixture } from "./browser-actions-native/contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "browser-actions-native");
const execFileAsync = promisify(execFile);
// Run this desktop fixture serially through the shared validation budget.
// Select @cdp without an unlocked desktop; @foreground retains actual OS focus proof.
type FixtureMode = "cdp" | "foreground";
let mainOut: string;
let preloadOut: string;

test.beforeAll(async ({}, testInfo) => {
  mainOut = testInfo.outputPath("native-browser-actions-main.mjs");
  preloadOut = testInfo.outputPath("native-browser-actions-preload.cjs");
  await build({ entryPoints: [join(FIXTURE_DIR, "preload.ts")], outfile: preloadOut, bundle: true, format: "cjs", platform: "node", external: ["electron"], logLevel: "silent" });
  await build({
    entryPoints: [join(FIXTURE_DIR, "main.ts")], outfile: mainOut,
    bundle: true, format: "esm", platform: "node", target: "es2022", external: ["electron"],
    banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, logLevel: "silent",
  });
});

function resultMessage(result: NativeActionResult): string {
  return JSON.stringify({ error: result.error, mode: result.mode, generation: result.generation, oracle: result.oracle, focus: result.focus, nativeEvents: result.nativeEvents }, null, 2);
}

async function run(app: ElectronApplication, action: NativeAction): Promise<NativeActionResult> {
  return app.evaluate(async (_main, name) =>
    (globalThis as unknown as { nativeBrowserFixture: NativeBrowserFixture }).nativeBrowserFixture.run(name), action);
}

async function read(app: ElectronApplication): Promise<NativeActionResult> {
  return app.evaluate(async () => (globalThis as unknown as { nativeBrowserFixture: NativeBrowserFixture }).nativeBrowserFixture.read());
}

async function launch(testInfo: TestInfo, mode: FixtureMode): Promise<ElectronApplication> {
  const runtime = testInfo.outputPath("runtime");
  await fs.mkdir(runtime, { recursive: true });
  const app = await launchElectron({
    args: [mainOut, `--user-data-dir=${join(runtime, "profile")}`], timeout: 30_000,
    env: buildIsolatedElectronEnv({ AVE_HOME: join(runtime, "ave-home"), AVE_NATIVE_FIXTURE_DIR: FIXTURE_DIR, AVE_NATIVE_FIXTURE_PRELOAD: preloadOut, AVE_NATIVE_FIXTURE_RUNTIME: runtime, AVE_NATIVE_FIXTURE_MODE: mode }),
  });
  app.process().stderr?.on("data", (data: Buffer) => process.stdout.write(`[native-browser:stderr] ${data}`));
  try {
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { nativeBrowserFixture?: NativeBrowserFixture }).nativeBrowserFixture?.ready === true), { timeout: 30_000 }).toBe(true);
    if (mode === "cdp") return app;
    await (await app.firstWindow()).bringToFront();
    if (process.platform === "darwin") {
      const pid = app.process().pid;
      if (!Number.isSafeInteger(pid) || pid === undefined || pid < 1) throw new Error("Native fixture PID is unavailable");
      await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", `ObjC.import('AppKit'); const fixture = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (!fixture || !fixture.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps)) throw new Error('Native fixture activation failed');`]);
    }
    await app.evaluate(({ app: fixtureApp, BrowserWindow }) => {
      fixtureApp.focus({ steal: true });
      BrowserWindow.getAllWindows()[0]?.focus();
    });
    const diagnostic = process.env.AVE_NATIVE_FIXTURE_FOCUS_DIAGNOSTIC === "1";
    if (diagnostic) {
      testInfo.setTimeout(300_000);
      process.stdout.write(`[native-focus] title=Native action host pid=${app.process().pid} executable=${app.process().spawnfile}\n`);
    }
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused()), { timeout: diagnostic ? 240_000 : 5_000 }).toBe(true);
    return app;
  } catch (error) { await close(app); throw error; }
}

async function close(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => (globalThis as unknown as { nativeBrowserFixture: NativeBrowserFixture }).nativeBrowserFixture.close()).catch(() => {});
  await app.close().catch(() => {});
}

test("@cdp hover reaches the guest element", async ({}, testInfo) => {
  const app = await launch(testInfo, "cdp");
  try {
    const before = await read(app);
    const result = await run(app, "hover");
    expect(result.ok, resultMessage(result)).toBe(true);
    expect(result.oracle.hover).toBeGreaterThan(before.oracle.hover);
  } finally { await close(app); }
});

test("@cdp pointer drag delivers HTML5 drag payload", async ({}, testInfo) => {
  const app = await launch(testInfo, "cdp");
  try {
    const result = await run(app, "drag");
    expect(result.ok, resultMessage(result)).toBe(true);
    await expect.poll(async () => (await read(app)).oracle.dropped).toBe("fixture-drag-payload");
    expect((await read(app)).oracle.dragStarted).toBeGreaterThan(0);
    expect((await read(app)).oracle.dropCount).toBe(1);
  } finally { await close(app); }
});

test("@cdp pointer drag changes a native range value", async ({}, testInfo) => {
  const app = await launch(testInfo, "cdp");
  try {
    const result = await run(app, "slider");
    expect(result.ok, resultMessage(result)).toBe(true);
    expect(Number(result.oracle.slider)).toBeGreaterThan(75);
  } finally { await close(app); }
});

test("@foreground native single select proves the final requested value", async ({}, testInfo) => {
  const app = await launch(testInfo, "foreground");
  try {
    const result = await run(app, "select");
    expect(result.ok, resultMessage(result)).toBe(true);
    expect(result.oracle.selected).toBe("b");
  } finally { await close(app); }
});

test("@cdp targeted wheel scrolls the nested container", async ({}, testInfo) => {
  const app = await launch(testInfo, "cdp");
  try {
    const result = await run(app, "scroll");
    expect(result.ok, resultMessage(result)).toBe(true);
    await expect.poll(async () => (await read(app)).oracle.scrollTop).toBeGreaterThan(0);
    expect((await read(app)).oracle.pageY).toBe(0);
  } finally { await close(app); }
});

test("@cdp full-page capture reports unavailable before unsafe clipping", async ({}, testInfo) => {
  const app = await launch(testInfo, "cdp");
  try {
    const result = await run(app, "screenshot");
    expect(result.ok, resultMessage(result)).toBe(false);
    expect(result.error?.code).toBe("screenshot-unavailable");
    expect(result.value).toBeUndefined();
    expect(result.oracle.content.height).toBeGreaterThan(result.oracle.viewport.height * 2);
  } finally { await close(app); }
});

test("@cdp picker callback selection uploads immutable fixture bytes to a real server", async ({}, testInfo) => {
  const app = await launch(testInfo, "cdp");
  try {
    // The native modal is an explicit boundary: the callback selects a real
    // fixture file; staging, assignment, file lifetime and HTTP delivery ship.
    const selected = await run(app, "upload");
    expect(selected.ok, resultMessage(selected)).toBe(true);
    expect(selected.value).toMatchObject({ status: "selected", count: 1, bytes: 24 });
    const edited = await run(app, "edit-original");
    expect(edited.ok, resultMessage(edited)).toBe(true);
    expect(edited.value).toEqual({ originalBytes: "edited original after staging\n" });
    const sent = await run(app, "submit");
    expect(sent.ok, resultMessage(sent)).toBe(true);
    await expect.poll(async () => (await read(app)).received?.bytes).toBe("immutable fixture bytes\n");
    await expect.poll(async () => (await read(app)).oracle.uploadResponse).toBe("fixture bytes received");
  } finally { await close(app); }
});

test("@cdp cancelled picker callback assigns no files or server bytes", async ({}, testInfo) => {
  const app = await launch(testInfo, "cdp");
  try {
    const result = await run(app, "cancel-upload");
    expect(result.ok, resultMessage(result)).toBe(true);
    expect(result.value).toMatchObject({ status: "cancelled", count: 0, bytes: 0 });
    expect(result.oracle.upload).toBeNull();
    expect(result.received).toBeNull();
  } finally { await close(app); }
});

test("@cdp non-agent click pauses the guest until explicit main-process resume", async ({}, testInfo) => {
  const app = await launch(testInfo, "cdp");
  try {
    const held = await run(app, "hold-control");
    expect(held.mode).toBe("agent-active");
    const page = await app.firstWindow();
    const origin = await page.locator("webview").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { x: box.x + parseFloat(style.borderLeftWidth), y: box.y + parseFloat(style.borderTopWidth) };
    });
    await page.mouse.click(origin.x + held.oracle.humanPoint.x, origin.y + held.oracle.humanPoint.y);
    await expect.poll(async () => (await read(app)).mode).toBe("human-paused");
    await expect.poll(async () => (await read(app)).oracle.humanClicks).toBeGreaterThan(held.oracle.humanClicks);
    const blocked = await run(app, "hover");
    expect(blocked.ok, resultMessage(blocked)).toBe(false);
    expect(blocked.error?.message).toContain("paused");
    expect(blocked.owner).toBe(held.owner);
    const resumed = await run(app, "resume");
    expect(resumed.generation).toBeGreaterThan(held.generation);
    const result = await run(app, "hover");
    expect(result.ok, resultMessage(result)).toBe(true);
  } finally { await close(app); }
});

test("@cdp final activating click navigation completes", async ({}, testInfo) => {
  const app = await launch(testInfo, "cdp");
  try {
    const navigated = await run(app, "navigate");
    expect(navigated.ok, resultMessage(navigated)).toBe(true);
    expect(navigated.oracle.url).toMatch(/\/navigated$/);
  } finally { await close(app); }
});

test("@foreground intermediate select navigation fails", async ({}, testInfo) => {
  const app = await launch(testInfo, "foreground");
  try {
    const changed = await run(app, "select-navigation");
    expect(changed.ok, resultMessage(changed)).toBe(false);
    expect(changed.error?.code).toBe("document-changed");
    expect(changed.oracle.url).toMatch(/\/navigated-select$/);
  } finally { await close(app); }
});
