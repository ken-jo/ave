import { expect, test, type TestInfo } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_WORKSPACE_LIMITS } from "../../../src/shared/browser-workspace.js";
import { buildIsolatedElectronEnv, launchElectron } from "./seeded-electron.js";
import type { WorkspaceNativeFixture, WorkspaceNativeState } from "./browser-workspace-native/main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let mainOut: string;
test.beforeAll(async ({}, testInfo) => {
  mainOut = testInfo.outputPath("browser-workspace-native-main.mjs");
  await build({
    entryPoints: [join(HERE, "browser-workspace-native/main.ts")], outfile: mainOut,
    bundle: true, format: "esm", platform: "node", target: "es2022", external: ["electron"],
    banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, logLevel: "silent",
  });
});

async function launch(testInfo: TestInfo) {
  const runtime = testInfo.outputPath("runtime");
  await fs.mkdir(runtime, { recursive: true });
  const app = await launchElectron({
    args: [mainOut, `--user-data-dir=${join(runtime, "profile")}`], timeout: 30_000,
    env: buildIsolatedElectronEnv({ AVE_HOME: join(runtime, "ave-home"), AVE_WORKSPACE_FIXTURE_RUNTIME: runtime }),
  });
  app.process().stderr?.on("data", (data: Buffer) => process.stdout.write(`[workspace-native:stderr] ${data}`));
  try {
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture?: WorkspaceNativeFixture }).workspaceNativeFixture?.ready === true), { timeout: 30_000 }).toBe(true);
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}
async function read(app: ElectronApplication): Promise<WorkspaceNativeState> {
  return app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.read());
}
async function close(app: ElectronApplication) {
  await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.close()).catch(() => {});
  await app.close().catch(() => {});
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

test("CDP native popup preserves registration, hardening, opener, session and close lifecycle", async ({}, testInfo) => {
  const app = await launch(testInfo);
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

test("foreground native popup verifies focus, human pause, trusted title and explicit resume", async ({}, testInfo) => {
  const app = await launch(testInfo);
  try {
    const registered = await openRegisteredPopup(app);
    const selected = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.selectPopup());
    expect(selected).toMatchObject({ ok: true, tabId: registered.popup!.handle });
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

test("native find advances and reverses across two actual page matches", async ({}, testInfo) => {
  const app = await launch(testInfo);
  try {
    const initial = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.find(true, true));
    const next = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.find(true, false));
    const previous = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.find(false, false));
    expect(initial).toEqual({ matches: 2, activeMatchOrdinal: 1 });
    expect(next).toEqual({ matches: 2, activeMatchOrdinal: 2 });
    expect(previous).toEqual({ matches: 2, activeMatchOrdinal: 1 });
  } finally { await close(app); }
});

test("native preview captures real bounded pixels without changing focus", async ({}, testInfo) => {
  const app = await launch(testInfo);
  try {
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
  } finally { await close(app); }
});

test("native capture has one in-flight owner and discards its image after window hide", async ({}, testInfo) => {
  const app = await launch(testInfo);
  try {
    const result = await app.evaluate(() => (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture.hiddenPreviewRace());
    expect(result).toEqual({ secondError: "capture-busy", firstError: "stale-document", hiddenError: "window-hidden", hidden: true });
  } finally { await close(app); }
});
