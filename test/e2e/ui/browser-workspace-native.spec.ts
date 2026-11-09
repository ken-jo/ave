import { expect } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSharedElectronTest, sharedElectronTest as isolatedTest } from "./shared-electron.js";
import { closeNativeFixture, launchNativeFixture, nativeFixturePaths } from "./native-fixture-runtime.js";
import { BROWSER_WORKSPACE_LIMITS } from "../../../src/shared/browser-workspace.js";
import { buildIsolatedElectronEnv, launchElectron, setWindowSize } from "./seeded-electron.js";
import type { WorkspaceNativeFixture, WorkspaceNativeState } from "./browser-workspace-native/main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const test = createSharedElectronTest<ElectronApplication>({
  launch: (_key, workerInfo) => launch(workerInfo.project.outputDir),
  reset: async (app) => {
    await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.reset());
    await setWindowSize(app, 940, 740);
  },
  assertClean: async (app) => {
    await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.assertClean());
    expect(await read(app)).toMatchObject({ mainVisible: true, popup: null, nativeEvents: [] });
    expect(await app.evaluate(async ({ BrowserWindow, webContents }) => {
      const windows = BrowserWindow.getAllWindows();
      const guests = webContents.getAllWebContents().filter(contents => contents.getType() === "webview");
      const guest = guests[0];
      return { windows: windows.length, guests: guests.length, focused: windows.some(window => window.isFocused()),
        page: await guest?.executeJavaScript("({x:scrollX,y:scrollY,storage:localStorage.length,session:sessionStorage.length,url:location.pathname})"),
        cookies: (await guest?.session.cookies.get({}))?.length };
    })).toEqual({ windows: 1, guests: 1, focused: false, page: { x: 0, y: 0, storage: 0, session: 0, url: "/page" }, cookies: 0 });
  },
  close,
});

async function launch(outputDir: string, mode: "cdp" | "foreground" = "cdp") {
  const app = await launchNativeFixture("ave-browser-workspace-", async ({ runtime, assets }) => {
    const home = join(runtime, "home");
    const mainOut = join(assets, "main.mjs");
    await fs.mkdir(home, { recursive: true });
    await build({
      entryPoints: [join(HERE, "browser-workspace-native/main.ts")], outfile: mainOut,
      bundle: true, format: "esm", platform: "node", target: "es2022", external: ["electron", "@napi-rs/canvas"],
      banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, logLevel: "silent",
    });
    return launchElectron({
      args: [mainOut, `--user-data-dir=${join(runtime, "profile")}`], timeout: 30_000,
      env: buildIsolatedElectronEnv({ HOME: home, USERPROFILE: home, AVE_HOME: join(runtime, "ave-home"), AVE_WORKSPACE_FIXTURE_RUNTIME: runtime, AVE_NATIVE_FIXTURE_MODE: mode }),
    });
  }, outputDir);
  app.process().stderr?.on("data", (data: Buffer) => process.stdout.write(`[workspace-native:stderr] ${data}`));
  try {
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture?: WorkspaceNativeFixture }).workspaceNativeFixture?.ready === true), { timeout: 30_000 }).toBe(true);
    await setWindowSize(app, 940, 740);
    return app;
  } catch (startupError) {
    try { await close(app); }
    catch (teardownError) { throw new AggregateError([startupError, teardownError], "Native fixture startup and teardown failed"); }
    throw startupError;
  }
}
async function read(app: ElectronApplication): Promise<WorkspaceNativeState> {
  return app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.read());
}
async function close(app: ElectronApplication): Promise<void> {
  await closeNativeFixture(app, () => app.evaluate(() =>
    (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.close()));
}
async function openRegisteredPopup(app: ElectronApplication): Promise<WorkspaceNativeState> {
  await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.openPopup());
  await expect.poll(async () => {
    const state = await read(app);
    return { kind: state.popup?.kind, nativeEvents: state.nativeEvents };
  }).toMatchObject({ kind: "popup" });
  return read(app);
}
async function nativePopupPage(app: ElectronApplication) {
  await expect.poll(() => app.windows().some((page) => page.url().endsWith("/popup"))).toBe(true);
  const popup = app.windows().find((page) => page.url().endsWith("/popup"));
  if (!popup) throw new Error("Native popup page disappeared");
  return popup;
}

test("native workspace fixture isolates its home from the parent process", async ({ sharedApp: app }) => {
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

isolatedTest("CDP native popup preserves registration, hardening, opener, session and close lifecycle", { annotation: { type: "isolated-app", description: "Exercises native window lifecycle" } }, async ({}, testInfo) => {
  const app = await launch(testInfo.project.outputDir);
  try {
    // Page activation creates an actual child; no foreground receipt is required.
    const registered = await openRegisteredPopup(app);
    expect(registered.popup).toMatchObject({ openerTabId: registered.mainHandle, windowId: registered.ownerWindowId, sameSession: true, sandbox: true, contextIsolation: true, nodeIntegration: false });
    const closed = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.closePopup());
    expect(closed).toEqual({ ok: true, tabId: registered.popup!.handle });
    const afterClose = await read(app);
    expect(afterClose).toMatchObject({ popup: null, mainHandle: registered.mainHandle, mainVisible: true });
  } finally { await close(app); }
});

isolatedTest("@os-focus native popup verifies focus, human pause, trusted title and explicit resume", { annotation: { type: "isolated-app", description: "Native OS focus requires a dedicated process" } }, async ({}, testInfo) => {
  const app = await launch(testInfo.project.outputDir, "foreground");
  try {
    const registered = await openRegisteredPopup(app);
    const selected = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.selectPopup());
    expect(selected).toMatchObject({ ok: true, tabId: registered.popup!.handle });
    expect((await read(app)).popup).toMatchObject({ windowFocused: true, guestFocused: true });
    const preview = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.preview());
    expect(preview.focusPreserved).toBe(true);
    expect((await read(app)).popup).toMatchObject({ windowFocused: true, guestFocused: true });
    await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.holdPopup());
    const popup = await nativePopupPage(app);
    await popup.locator("#human").click();
    await expect.poll(async () => (await read(app)).popup?.mode).toBe("human-paused");
    const paused = (await read(app)).popup!;
    expect(paused.nativeTitle).toMatch(/^Ave · /);
    expect(paused.nativeTitle).toMatch(/Paused|human-paused/);
    await popup.evaluate(() => { document.title = "Page attempted title"; });
    await expect.poll(async () => (await read(app)).popup?.title).toBe("Page attempted title");
    expect((await read(app)).popup!.nativeTitle).toMatch(/^Ave · /);
    expect(await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.resumePopup())).toBe(true);
    const resumed = (await read(app)).popup!;
    expect(resumed.mode).toBe("agent-active");
    expect(resumed.generation).toBeGreaterThan(paused.generation);
  } finally { await close(app); }
});

test("native find advances and reverses across two actual page matches", async ({ sharedApp: app }) => {
  const initial = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.find(true, true));
  const next = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.find(true, false));
  const previous = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.find(false, false));
  expect(initial).toEqual({ matches: 2, activeMatchOrdinal: 1 });
  expect(next).toEqual({ matches: 2, activeMatchOrdinal: 2 });
  expect(previous).toEqual({ matches: 2, activeMatchOrdinal: 1 });
});

test("native preview captures real bounded pixels without changing focus", async ({ sharedApp: app }, testInfo) => {
  const result = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.preview());
  expect(result.preview.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(result.bytes).toBeGreaterThan(1_000);
  expect(result.bytes).toBeLessThanOrEqual(BROWSER_WORKSPACE_LIMITS.previewBytes);
  expect(result.decodedWidth).toBe(result.preview.width);
  expect(result.decodedHeight).toBe(result.preview.height);
  expect(result.preview.width).toBeLessThanOrEqual(BROWSER_WORKSPACE_LIMITS.previewWidth);
  expect(result.preview.height).toBeLessThanOrEqual(BROWSER_WORKSPACE_LIMITS.previewHeight);
  expect(result.focusPreserved).toBe(true);
  const path = testInfo.outputPath("native-workspace-preview.jpg");
  await fs.writeFile(path, Buffer.from(result.preview.dataUrl.split(",")[1]!, "base64"));
  await testInfo.attach("native-workspace-preview", { path, contentType: "image/jpeg" });
});

isolatedTest("native capture has one in-flight owner and discards its image after window hide", { annotation: { type: "isolated-app", description: "Exercises native window lifecycle" } }, async ({}, testInfo) => {
  const app = await launch(testInfo.project.outputDir);
  try {
    const result = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.hiddenPreviewRace());
    expect(result).toEqual({ secondError: "capture-busy", firstError: "stale-document", hiddenError: "window-hidden", hidden: true });
  } finally { await close(app); }
});

test("shared workspace reset clears persisted permission rules and queued writes", async ({ sharedApp: app }, testInfo) => {
  const pid = app.process().pid;
  await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.savePermissionRules());
  const dirty = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.permissionState());
  expect(dirty.disk).toMatchObject({ sitePermissions: expect.arrayContaining([
    expect.objectContaining({ permission: "camera", decision: "allow" }),
    expect.objectContaining({ permission: "microphone", decision: "block" }),
  ]) });
  expect(dirty.reloaded.sitePermissions).toEqual(dirty.live.sitePermissions);
  const dirtyAssertion = await app.evaluate(async () => {
    try { await (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.assertClean(); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  });
  const pending = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.resetWithPendingPermissionWrites());
  expect(pending.pendingBeforeReset).toBe(2);
  expect(app.process().pid).toBe(pid);
  const clean = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.permissionState());
  await fs.writeFile(testInfo.outputPath("workspace-permission-reset.json"), JSON.stringify({ pid, afterPid: app.process().pid, pending, dirty, dirtyAssertion, clean }, null, 2));
  expect(clean.disk).toEqual({ version: 1, bookmarks: [], history: [], sitePermissions: [] });
  expect(clean.live).toEqual({ storageStatus: "ready", bookmarks: [], history: [], sitePermissions: [] });
  expect(clean.reloaded).toEqual(clean.live);
  expect(dirtyAssertion).toContain("persisted workspace");
  await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.assertClean());
});
