import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures.js";
import { buildIsolatedElectronEnv, launchElectron, MAIN_ENTRY, setWindowSize } from "./seeded-electron.js";

function readTourState(aveHome: string): { completedScenarios?: string[]; dismissedAt?: string | null } | null {
  const tourStatePath = path.join(aveHome, "onboarding", "tour-state.json");
  if (!fs.existsSync(tourStatePath)) return null;
  return JSON.parse(fs.readFileSync(tourStatePath, "utf-8"));
}

test.describe("fresh workspace", () => {
  test.use({ onboardingCompleted: false, seedApiKey: false });

  test("a fresh keyless workspace remains usable while its optional tour can be dismissed", async ({ app, mainWindow, aveHome }) => {
    await setWindowSize(app, 1280, 800);
    await expect(mainWindow.getByTestId("main-toolbar")).toBeVisible();
    await expect(mainWindow.getByTestId("spotlight-tour:card")).toBeVisible();

    await mainWindow.getByTestId("spotlight-tour:skip").click();
    await expect(mainWindow.getByTestId("spotlight-tour:card")).toHaveCount(0);

    await expect.poll(() => typeof readTourState(aveHome)?.dismissedAt === "string").toBe(true);
  });
});

test.describe("upgraded workspace", () => {
  test.use({ onboardingCompleted: true, seedApiKey: false });

  test("a legacy settings completion is imported once and never replays the tour", async ({ app, mainWindow, aveHome, tempHome, userDataDir }) => {
    await setWindowSize(app, 1280, 800);
    await expect(mainWindow.getByTestId("main-toolbar")).toBeVisible();
    await expect.poll(() => readTourState(aveHome)?.completedScenarios).toEqual(["first-boot-essentials"]);
    await expect(mainWindow.getByTestId("spotlight-tour:card")).toHaveCount(0);
    const tourStatePath = path.join(aveHome, "onboarding", "tour-state.json");
    const imported = fs.readFileSync(tourStatePath, "utf-8");
    const importedAt = fs.statSync(tourStatePath).mtimeMs;
    await app.close();

    const relaunched = await launchElectron({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        AVE_DEV: "1",
        AVE_E2E: "1",
        AVE_HOME: aveHome,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    try {
      const win = await relaunched.firstWindow();
      await win.locator('[data-testid="main-toolbar"]').first().waitFor({ state: "visible", timeout: 60_000 });
      await setWindowSize(relaunched, 1280, 800);
      // The controller reads tour state on mount; give a replay the time a fresh tour needs to appear.
      await win.waitForTimeout(3_000);
      await expect(win.getByTestId("spotlight-tour:card")).toHaveCount(0);
      expect(fs.readFileSync(tourStatePath, "utf-8")).toBe(imported);
      expect(fs.statSync(tourStatePath).mtimeMs).toBe(importedAt);
      const settings = JSON.parse(fs.readFileSync(path.join(userDataDir, "ave-settings.json"), "utf-8")) as {
        features?: { onboardingCompleted?: boolean };
      };
      expect(settings.features?.onboardingCompleted).toBe(true);
    } finally {
      await relaunched.close().catch(() => {});
    }
  });
});
