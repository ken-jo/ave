/**
 * initial-size E2E (PR #368 follow-up — narrow width, right-docked tall height).
 *
 * The main BrowserWindow is sized at creation for the persisted app mode
 * (`system.appMode` in ave-settings.json, read before bootstrap):
 *   - chat mode: width 460 px (single-column chat shell), height 840 px,
 *     right edge keeps a small visual gap from the primary work area edge;
 *     macOS/Linux open near the top edge, Windows near the bottom edge.
 *   - first run (nothing persisted): work mode, `computeWorkModeBounds`.
 *
 * Uses `app.evaluate` to read bounds directly via Electron BrowserWindow APIs.
 * Skipped automatically when the built app binary is absent so CI that doesn't
 * run Electron tests is unaffected.
 */
import { test, expect } from "@playwright/test";
import { ElectronApplication } from "playwright";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeWorkModeBounds } from "../../../src/main/main-window-bounds.js";
import { buildIsolatedElectronEnv, launchElectron } from "../ui/seeded-electron.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_MAIN = resolve(HERE, "../../../dist/src/main/main.js");
const EXPECTED_WIDTH = 460;
const EXPECTED_HEIGHT = 840;
const EXPECTED_MIN_HEIGHT = 640;
const EXPECTED_RIGHT_GAP = 10;
const EXPECTED_TOP_GAP = 24;
const EXPECTED_BOTTOM_GAP = 24;

test.describe("initial window size", () => {
  test.skip(!existsSync(DIST_MAIN), "dist/src/main/main.js not built — skipping");

  let app: ElectronApplication | undefined;
  let tempHome: string | undefined;
  let userDataDir: string | undefined;

  /** Launch with an isolated home, data home and profile; `settings` seeds ave-settings.json. */
  async function launch(settings?: object): Promise<ElectronApplication> {
    tempHome = mkdtempSync(resolve(tmpdir(), "ave-e2e-home-"));
    userDataDir = mkdtempSync(resolve(tmpdir(), "ave-e2e-initial-size-"));
    if (settings) writeFileSync(resolve(userDataDir, "ave-settings.json"), JSON.stringify(settings));
    app = await launchElectron({
      args: [DIST_MAIN, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        AVE_HOME: resolve(tempHome, ".ave"),
        AVE_DEV: "1",
        AVE_E2E: "1",
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    await app.firstWindow();
    return app;
  }

  async function windowBounds(launched: ElectronApplication) {
    return launched.evaluate(({ BrowserWindow, screen }) => {
      const [win] = BrowserWindow.getAllWindows();
      if (!win) throw new Error("main BrowserWindow was not created");
      return {
        bounds: win.getBounds(),
        workArea: screen.getPrimaryDisplay().workArea,
        platform: process.platform,
      };
    });
  }

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("first run opens in work mode, centered at the work-mode size", async () => {
    const { bounds, workArea } = await windowBounds(await launch());
    const expected = computeWorkModeBounds(workArea);
    expect(Math.abs(bounds.width - expected.width)).toBeLessThanOrEqual(8);
    expect(Math.abs(bounds.height - expected.height)).toBeLessThanOrEqual(8);
    expect(Math.abs(bounds.x - expected.x)).toBeLessThanOrEqual(8);
    expect(Math.abs(bounds.y - expected.y)).toBeLessThanOrEqual(8);
  });

  test("chat mode opens narrow, taller, and right-aligned", async () => {
    const { bounds, workArea, platform } = await windowBounds(await launch({ system: { appMode: "chat" } }));

    const expectedWidth = EXPECTED_WIDTH;
    const expectedHeight = Math.max(EXPECTED_MIN_HEIGHT, Math.min(EXPECTED_HEIGHT, workArea.height));
    expect(bounds.width).toBeGreaterThanOrEqual(expectedWidth);
    expect(bounds.width).toBeLessThanOrEqual(expectedWidth + 8);
    expect(bounds.height).toBeGreaterThanOrEqual(expectedHeight);
    expect(bounds.height).toBeLessThanOrEqual(expectedHeight + 8);
    const rightGap = (workArea.x + workArea.width) - (bounds.x + bounds.width);
    const expectedRightGap = bounds.width < workArea.width ? EXPECTED_RIGHT_GAP : 0;
    expect(Math.abs(rightGap - expectedRightGap)).toBeLessThanOrEqual(8);
    const availableVerticalSpace = Math.max(0, workArea.height - bounds.height);
    const expectedY = platform === "win32"
      ? workArea.y + Math.max(0, availableVerticalSpace - EXPECTED_BOTTOM_GAP)
      : workArea.y + Math.min(EXPECTED_TOP_GAP, availableVerticalSpace);
    expect(Math.abs(bounds.y - expectedY)).toBeLessThanOrEqual(8);
    // Ensure height is not accidentally compact (the PR #368 regression was 380px)
    expect(bounds.height).toBeGreaterThanOrEqual(600);
  });
});
