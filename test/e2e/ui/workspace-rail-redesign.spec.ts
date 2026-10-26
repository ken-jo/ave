import { test, expect } from "./fixtures";
import { type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildIsolatedElectronEnv, launchElectron } from "./seeded-electron";
import { SIDE_PANEL_MIN_WIDTH } from "../../../src/shared/side-panel.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

test.describe("workspace rail redesign", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "ave-workspace-rail-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "ave-workspace-rail-home-"));
    writeFileSync(
      resolve(userDataDir, "ave-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true), null, 2) + "\n",
      "utf-8",
    );
    app = await launchElectron({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        AVE_HOME: resolve(tempHome, ".ave"),
        AVE_DEV: "1",
        AVE_E2E: "1",
        AVE_MAIN_ENTRY: MAIN_ENTRY,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({ state: "visible", timeout: 60_000 });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("docked rail: no header count, drag splitter, launcher opens a tab", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();

    const panel = page.getByTestId(TEST_IDS.chatSidePanel);
    await expect(panel).toBeVisible();

    const rail = page.getByTestId("chat-preview-rail");
    await expect(rail).not.toContainText("· 파일");

    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();

    await expect(page.getByTestId("chat-side-panel-launcher")).toBeVisible();
    await page.getByTestId(chatSidePanelLauncherTestId("browser")).click();
    await expect(page.getByTestId("chat-side-panel-tab-browser")).toBeVisible();
  });

  test("a canvas with space for the transcript and side panel docks", async () => {
    await page.setViewportSize({ width: 1243, height: 768 });
    const originalBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())).toEqual(originalBounds);

    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();
  });

  test("a narrow tile floats the panel over its transcript instead of crushing it", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    const motion = page.getByTestId("chat-side-panel-motion");
    await expect(motion).toHaveAttribute("data-panel-mode", "docked");

    // Choose the rail before narrowing so this checks its reserved transcript width.
    const sidebarToggle = page.getByTestId("sidebar-collapse-toggle");
    if (await sidebarToggle.getAttribute("aria-pressed") === "true") await sidebarToggle.click();
    // Below docking width, float inside the tile without dimming or narrowing the transcript.
    await page.setViewportSize({ width: 360, height: 840 });
    await expect(sidebarToggle).toHaveAttribute("aria-pressed", "false");
    await expect(motion).toHaveAttribute("data-panel-mode", "overlay");
    // The panel portal belongs beside its pane transcript, not inside it.
    await expect(page.getByTestId("pane").getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    // Wait for reserve-width animation before measuring.
    await expect.poll(() => motion.evaluate((element) =>
      Math.round(element.getBoundingClientRect().width) === Math.round(Number.parseFloat((element as HTMLElement).style.width)))).toBe(true);
    // Floating panels leave the transcript column at full width.
    const composer = await page.getByTestId(TEST_IDS.composerTextarea).boundingBox();
    const root = await page.getByTestId(TEST_IDS.chatViewRoot).boundingBox();
    const reserve = await motion.boundingBox();
    const panel = await page.getByTestId(TEST_IDS.chatSidePanel).boundingBox();
    const inset = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shell-card-inset")));
    expect(inset).toBeGreaterThan(0);
    // Include card insets in the reserve; narrow tiles leave only that inset space outside the card.
    expect(reserve?.width ?? Infinity).toBeLessThanOrEqual((root?.width ?? 0) + 1);
    expect(Math.abs((panel?.width ?? 0) - Math.min(SIDE_PANEL_MIN_WIDTH, (reserve?.width ?? 0) - 2 * inset))).toBeLessThanOrEqual(1);
    expect(composer?.width ?? 0).toBeGreaterThan((root?.width ?? 0) - (panel?.width ?? 0));
    await test.info().attach("narrow-panel-360.png", { body: await page.screenshot({ path: test.info().outputPath("narrow-panel-360.png") }), contentType: "image/png" });

    await page.setViewportSize({ width: 1400, height: 840 });
    await expect(motion).toHaveAttribute("data-panel-mode", "docked");
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();
  });
});
