import { expect, type TestInfo } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSharedElectronTest, sharedElectronTest as isolatedTest } from "./shared-electron.js";
import { closeNativeFixture, launchNativeFixture, nativeFixturePaths } from "./native-fixture-runtime.js";
import { buildIsolatedElectronEnv, launchElectron, setWindowSize, withNativeFocusDiagnostics } from "./seeded-electron.js";
import type { NativeAction, NativeActionResult, NativeBrowserFixture } from "./browser-actions-native/contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "browser-actions-native");
const execFileAsync = promisify(execFile);
// Run this desktop fixture serially through the shared validation budget.
// Select @cdp without an unlocked desktop; @os-focus retains actual OS focus proof.
type FixtureMode = "cdp" | "foreground";
const test = createSharedElectronTest<ElectronApplication>({
  launch: () => launch(undefined, "cdp"),
  reset: async (app) => {
    await app.evaluate(() => (globalThis as unknown as { nativeBrowserFixture: NativeBrowserFixture }).nativeBrowserFixture.reset());
    await setWindowSize(app, 1180, 820);
  },
  assertClean: async (app) => {
    await app.evaluate(() => (globalThis as unknown as { nativeBrowserFixture: NativeBrowserFixture }).nativeBrowserFixture.assertClean());
    expect(await app.evaluate(async ({ BrowserWindow, webContents }) => {
      const guests = webContents.getAllWebContents().filter((contents) => contents.getType() === "webview");
      const guest = guests[0];
      return { windows: BrowserWindow.getAllWindows().length, guests: guests.length,
        page: await guest?.executeJavaScript("({storage:localStorage.length,session:sessionStorage.length,focused:document.hasFocus()})"),
        cookies: (await guest?.session.cookies.get({}))?.length };
    })).toEqual({ windows: 1, guests: 1, page: { storage: 0, session: 0, focused: true }, cookies: 0 });
    const state = await read(app);
    expect(state).toMatchObject({ ok: true, mode: "agent-active", owner: "native-fixture-conversation", received: null,
      oracle: { hover: 0, dragStarted: 0, dropped: "", dropCount: 0, humanClicks: 0, selected: "a", slider: "0", upload: null, uploadResponse: null, scrollTop: 0, pageY: 0 } });
    expect(state.oracle.url).toMatch(/\/page$/);
    expect(state.focus.window).toBe(false);
    const paths = nativeFixturePaths(app);
    await expect.poll(async () => {
      try { return await fs.readdir(join(paths.runtime, "ave-home/browser-uploads")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    }).toEqual([]);
  },
  close,
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

async function launch(testInfo: TestInfo | undefined, mode: FixtureMode): Promise<ElectronApplication> {
  const app = await launchNativeFixture("ave-browser-actions-", async ({ runtime, assets }) => {
    const mainOut = join(assets, "main.mjs");
    const preloadOut = join(assets, "preload.cjs");
    await build({ entryPoints: [join(FIXTURE_DIR, "preload.ts")], outfile: preloadOut, bundle: true, format: "cjs", platform: "node", external: ["electron"], logLevel: "silent" });
    await build({
      entryPoints: [join(FIXTURE_DIR, "main.ts")], outfile: mainOut,
      bundle: true, format: "esm", platform: "node", target: "es2022", external: ["electron", "@napi-rs/canvas"],
      banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, logLevel: "silent",
    });
    return launchElectron({
      args: [mainOut, `--user-data-dir=${join(runtime, "profile")}`], timeout: 30_000,
      env: buildIsolatedElectronEnv({ HOME: process.env.HOME, USERPROFILE: process.env.HOME, AVE_HOME: join(runtime, "ave-home"), AVE_NATIVE_FIXTURE_DIR: FIXTURE_DIR, AVE_NATIVE_FIXTURE_PRELOAD: preloadOut, AVE_NATIVE_FIXTURE_RUNTIME: runtime, AVE_NATIVE_FIXTURE_MODE: mode }),
    });
  });
  app.process().stderr?.on("data", (data: Buffer) => process.stdout.write(`[native-browser:stderr] ${data}`));
  try {
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { nativeBrowserFixture?: NativeBrowserFixture }).nativeBrowserFixture?.ready === true), { timeout: 30_000 }).toBe(true);
    await setWindowSize(app, 1180, 820);
    if (mode === "cdp") {
      await expect.poll(() => app.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
        return guest ? guest.executeJavaScript("document.hasFocus()") : false;
      })).toBe(true);
      return app;
    }
    if (!testInfo) throw new Error("Foreground fixture requires test metadata");
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
    await withNativeFocusDiagnostics(app, testInfo, () => expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused()), { timeout: diagnostic ? 240_000 : 5_000 }).toBe(true));
    return app;
  } catch (startupError) {
    try { await close(app); }
    catch (teardownError) { throw new AggregateError([startupError, teardownError], "Native fixture startup and teardown failed"); }
    throw startupError;
  }
}

async function close(app: ElectronApplication): Promise<void> {
  await closeNativeFixture(app, () => app.evaluate(() =>
    (globalThis as unknown as { nativeBrowserFixture: NativeBrowserFixture }).nativeBrowserFixture.close()));
}

test("@cdp navigation reads main text while a subresource remains open", async ({ sharedApp: app }) => {
  const result = await run(app, "read-content");
  expect(result.ok, resultMessage(result)).toBe(true);
  expect(result.value).toMatchObject({ readiness: { url: expect.stringContaining("/readable") },
    text: { text: "Fixture news headline\nReadable story text.", truncated: false }, loading: true });
  expect((result.value as { readiness: unknown }).readiness).not.toHaveProperty("loading");
});

test("@cdp hover reaches the guest element", async ({ sharedApp: app }) => {
  const before = await read(app);
  const result = await run(app, "hover");
  expect(result.ok, resultMessage(result)).toBe(true);
  expect(result.oracle.hover).toBeGreaterThan(before.oracle.hover);
});

test("@cdp pointer drag delivers HTML5 drag payload", async ({ sharedApp: app }) => {
  const result = await run(app, "drag");
  expect(result.ok, resultMessage(result)).toBe(true);
  await expect.poll(async () => (await read(app)).oracle.dropped).toBe("fixture-drag-payload");
  expect((await read(app)).oracle.dragStarted).toBeGreaterThan(0);
  expect((await read(app)).oracle.dropCount).toBe(1);
});

test("@cdp pointer drag changes a native range value", async ({ sharedApp: app }) => {
  const result = await run(app, "slider");
  expect(result.ok, resultMessage(result)).toBe(true);
  expect(Number(result.oracle.slider)).toBeGreaterThan(75);
});

isolatedTest("@os-focus native single select proves the final requested value", { annotation: { type: "isolated-app", description: "Native OS focus requires a dedicated process" } }, async ({}, testInfo) => {
  const app = await launch(testInfo, "foreground");
  try {
    const result = await run(app, "select");
    expect(result.ok, resultMessage(result)).toBe(true);
    expect(result.oracle.selected).toBe("b");
  } finally { await close(app); }
});

test("@cdp targeted wheel scrolls the nested container", async ({ sharedApp: app }) => {
  const result = await run(app, "scroll");
  expect(result.ok, resultMessage(result)).toBe(true);
  await expect.poll(async () => (await read(app)).oracle.scrollTop).toBeGreaterThan(0);
  expect((await read(app)).oracle.pageY).toBe(0);
});

test("@cdp full-page capture includes the bottom marker beyond the viewport", async ({ sharedApp: app }) => {
  await setWindowSize(app, 1180, 820);
  const result = await run(app, "screenshot");
  expect(result.ok, resultMessage(result)).toBe(true);
  expect(result.value).toMatchObject({ dimensions: result.oracle.content, bottomPixelRGB: [0, 166, 90] });
  expect(result.oracle.content.height).toBeGreaterThan(result.oracle.viewport.height * 2);
});

test("@cdp picker callback selection uploads immutable fixture bytes to a real server", async ({ sharedApp: app }) => {
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
});

test("@cdp cancelled picker callback assigns no files or server bytes", async ({ sharedApp: app }) => {
  const result = await run(app, "cancel-upload");
  expect(result.ok, resultMessage(result)).toBe(true);
  expect(result.value).toMatchObject({ status: "cancelled", count: 0, bytes: 0 });
  expect(result.oracle.upload).toBeNull();
  expect(result.received).toBeNull();
});

test("@cdp non-agent click pauses the guest until explicit main-process resume", async ({ sharedApp: app }) => {
  const held = await run(app, "hold-control");
  expect(held.mode).toBe("agent-active");
  // Deliver unmarked input to the guest target; background host windows do not route OS pointer focus into embedded guests.
  await app.evaluate(async ({ webContents }, point) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
    if (!guest) throw new Error("Native guest is unavailable");
    await guest.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await guest.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  }, held.oracle.humanPoint);
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
});

test("@cdp final activating click navigation completes", async ({ sharedApp: app }) => {
  const navigated = await run(app, "navigate");
  expect(navigated.ok, resultMessage(navigated)).toBe(true);
  expect(navigated.oracle.url).toMatch(/\/navigated$/);
});

isolatedTest("@os-focus intermediate select navigation fails", { annotation: { type: "isolated-app", description: "Native OS focus requires a dedicated process" } }, async ({}, testInfo) => {
  const app = await launch(testInfo, "foreground");
  try {
    const changed = await run(app, "select-navigation");
    expect(changed.ok, resultMessage(changed)).toBe(false);
    expect(changed.error?.code).toBe("document-changed");
    expect(changed.oracle.url).toMatch(/\/navigated-select$/);
  } finally { await close(app); }
});


test("shared native process resets dirty guest state and extra windows", async ({ sharedApp: app, sharedElectronSession }) => {
  const pid = app.process().pid;
  await app.evaluate(async ({ BrowserWindow, webContents }) => {
    const guest = webContents.getAllWebContents().find(contents => contents.getType() === "webview");
    if (!guest) throw new Error("Native fixture guest is unavailable");
    await guest.executeJavaScript('localStorage.setItem("dirty", "yes"); sessionStorage.setItem("dirty", "yes"); document.cookie = "dirty=yes"; scrollTo(0, 123)');
    guest.setZoomFactor(1.25);
    const extra = new BrowserWindow({ width: 700, height: 700, show: false });
    await extra.loadURL("about:blank");
    extra.showInactive();
  });
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
  const prepared = await sharedElectronSession.prepare(reason => { throw new Error(`Unexpected fixture relaunch: ${reason}`); });
  expect(prepared).toBe(app);
  expect(prepared.process().pid).toBe(pid);
  expect((await read(prepared)).oracle).toMatchObject({ scrollTop: 0, pageY: 0, upload: null, humanClicks: 0 });
  await prepared.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find(contents => contents.getType() === "webview");
    if (!guest) throw new Error("Native fixture guest is unavailable");
    await guest.executeJavaScript('localStorage.setItem("dirty-again", "yes")');
  });
});
