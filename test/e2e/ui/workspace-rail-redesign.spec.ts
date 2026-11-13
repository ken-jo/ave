import { test, expect } from "./fixtures";
import { type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setWindowSize, buildE2eBaseSettings, buildIsolatedElectronEnv, launchElectron } from "./seeded-electron";
import { SIDE_PANEL_MIN_WIDTH } from "../../../src/shared/side-panel.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";
import { withPageWindow } from "./renderer-events.js";

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
    await setWindowSize(app, 1400, 840, page);
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

  // The sidebar card and the chat tile are siblings in one shell, so their top edges, their corners and their first rows'
  // text centres must read as one line. Measured at two real window sizes because the band is px and the type is rem.
  test("the sidebar card and the chat tile share a top line, a corner and a header centre line", async () => {
    test.skip(process.platform !== "darwin", "the shared top line is the darwin title band's");
    for (const [width, height] of [[1440, 900], [1100, 750]] as const) {
      await setWindowSize(app, width, height, page);
      const geometry = await page.evaluate(() => {
        const textMid = (root: Element) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.textContent?.trim() ? 1 : 3 });
          const node = walker.nextNode();
          if (!node) return Number.NaN;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          return (rect.top + rect.bottom) / 2;
        };
        const card = document.querySelector('[data-testid="sidebar-card"]')!;
        const pane = document.querySelector('[data-testid="pane"]')!;
        return {
          cardTop: card.getBoundingClientRect().top,
          paneTop: pane.getBoundingClientRect().top,
          cardRadius: getComputedStyle(card).borderTopLeftRadius,
          paneRadius: getComputedStyle(pane).borderTopLeftRadius,
          cardText: textMid(document.querySelector('[data-testid="sidebar-list-header"]')!),
          paneText: textMid(document.querySelector('[data-testid="pane-header"]')!),
        };
      });
      expect(geometry.cardTop, `${width}x${height}`).toBe(geometry.paneTop);
      expect(geometry.cardRadius).toBe(geometry.paneRadius);
      expect(Math.abs(geometry.cardText - geometry.paneText), `${width}x${height}`).toBeLessThanOrEqual(1);
    }
  });

  test("a canvas with space for the transcript and side panel docks", async () => {
    await setWindowSize(app, 1243, 768, page);
    const originalBounds = await withPageWindow(app, page, (window) => window.getBounds());
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    expect(await withPageWindow(app, page, (window) => window.getBounds())).toEqual(originalBounds);

    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();
  });

  test("a narrow tile floats the panel over its transcript instead of crushing it", async () => {
    await setWindowSize(app, 1400, 840, page);
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    const motion = page.getByTestId("chat-side-panel-motion");
    await expect(motion).toHaveAttribute("data-panel-mode", "docked");

    // Choose the rail before narrowing so this checks its reserved transcript width.
    const sidebarToggle = page.getByTestId("sidebar-collapse-toggle");
    if (await sidebarToggle.getAttribute("aria-pressed") === "true") await sidebarToggle.click();
    // Below docking width, float inside the tile without dimming or narrowing the transcript.
    await setWindowSize(app, 360, 840, page);
    await expect(sidebarToggle).toHaveAttribute("aria-pressed", "false");
    await expect(motion).toHaveAttribute("data-panel-mode", "overlay");
    // The panel portal belongs beside its pane transcript, not inside it.
    await expect(page.getByTestId("pane").getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    // Wait for the shell to settle before measuring: the rail toggle starts a padding transition on the main column, and the
    // reserve's own width transition chases the tile it measures, so mid-transition the reserve can trail the shrinking root.
    await expect.poll(() => motion.evaluate((element) =>
      document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running")
      && Math.round(element.getBoundingClientRect().width) === Math.round(Number.parseFloat((element as HTMLElement).style.width)))).toBe(true);
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

    await setWindowSize(app, 1400, 840, page);
    await expect(motion).toHaveAttribute("data-panel-mode", "docked");
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();
  });
});
