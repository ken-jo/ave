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

    // Header shows the title only — the removed count read "미리보기 N개 · 파일 M개".
    const rail = page.getByTestId("chat-preview-rail");
    await expect(rail).not.toContainText("· 파일");

    // Docked variant exposes the left-edge width drag handle.
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();

    // Empty workspace shows the launcher; opening the browser item creates a tab.
    await expect(page.getByTestId("chat-side-panel-launcher")).toBeVisible();
    await page.getByTestId(chatSidePanelLauncherTestId("browser")).click();
    await expect(page.getByTestId("chat-side-panel-tab-browser")).toBeVisible();
  });

  test("chat mode at its side-panel window width docks (no modal blur)", async () => {
    // Regression guard for the chat-mode modal-blur bug: chat mode collapses the
    // sidebar to the icon rail and its OS window reserves the base width + the
    // 448px side panel (≈908px) when the panel opens. After the collapsed-sidebar
    // padding the chat-view-root sits just under the OLD 900px docking threshold,
    // so the panel wrongly rendered as a backdrop-blur modal drawer that blocked
    // the main chat. The threshold is now derived from the panel width + a
    // transcript floor, so this width docks — the transcript and the panel stay
    // interactive side by side, matching work mode.
    // Switch to chat mode (collapses the sidebar rail — the geometry the bug
    // manifests in) and open the panel first; the mode/panel IPC resizes the OS
    // window, so pin the container width LAST so it is the final authority.
    await page.getByTestId("app-mode-chat").click();
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.setViewportSize({ width: 908, height: 840 });

    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    // Docked variant exposes the drag handle (the modal drawer drops it).
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();
  });

  test("a narrow tile floats the panel over its transcript instead of crushing it", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    const motion = page.getByTestId("chat-side-panel-motion");
    await expect(motion).toHaveAttribute("data-panel-mode", "docked");

    // Shrink below the docking threshold → the panel keeps its floor and
    // floats over the transcript's right edge, inside the tile. Nothing
    // window-level, nothing dimmed, the transcript laid out underneath.
    await page.setViewportSize({ width: 460, height: 840 });
    await expect(motion).toHaveAttribute("data-panel-mode", "overlay");
    // "Inside the tile": the panel is portaled into its pane's panel slot
    // (`pane-panel-slot`, 6a64316b5), beside the transcript rather than in it.
    await expect(page.getByTestId("pane").getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    // The reserve's width animates (--motion-layout): measure it settled, not
    // mid-transition.
    await expect.poll(() => motion.evaluate((element) =>
      Math.round(element.getBoundingClientRect().width) === Math.round(Number.parseFloat((element as HTMLElement).style.width)))).toBe(true);
    // Floating means the transcript column is NOT narrowed by the panel: the
    // composer keeps more than (root − panel), which a docked column cannot.
    const composer = await page.getByTestId(TEST_IDS.composerTextarea).boundingBox();
    const root = await page.getByTestId(TEST_IDS.chatViewRoot).boundingBox();
    const reserve = await motion.boundingBox();
    const panel = await page.getByTestId(TEST_IDS.chatSidePanel).boundingBox();
    const inset = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shell-card-inset")));
    expect(inset).toBeGreaterThan(0);
    // The reserve is the card plus its air on each side; a tile narrower than
    // the reserve gives the card all of itself but the air (shared/side-panel.ts).
    expect(reserve?.width ?? Infinity).toBeLessThanOrEqual((root?.width ?? 0) + 1);
    expect(Math.abs((panel?.width ?? 0) - Math.min(SIDE_PANEL_MIN_WIDTH, (reserve?.width ?? 0) - 2 * inset))).toBeLessThanOrEqual(1);
    expect(composer?.width ?? 0).toBeGreaterThan((root?.width ?? 0) - (panel?.width ?? 0));

    // Widen again → back to a docked column.
    await page.setViewportSize({ width: 1400, height: 840 });
    await expect(motion).toHaveAttribute("data-panel-mode", "docked");
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();
  });
});
