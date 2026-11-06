import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";

test.use({ onboardingCompleted: false, seedApiKey: false });

test("a fresh keyless workspace remains usable while its optional tour can be dismissed", async ({ mainWindow, aveHome }) => {
  await expect(mainWindow.getByTestId("main-toolbar")).toBeVisible();
  await expect(mainWindow.getByTestId("spotlight-tour:card")).toBeVisible();

  await mainWindow.getByTestId("spotlight-tour:skip").click();
  await expect(mainWindow.getByTestId("spotlight-tour:card")).toHaveCount(0);

  const tourStatePath = path.join(aveHome, "onboarding", "tour-state.json");
  await expect.poll(() => {
    if (!fs.existsSync(tourStatePath)) return null;
    const state = JSON.parse(fs.readFileSync(tourStatePath, "utf-8")) as { dismissedAt?: string | null };
    return typeof state.dismissedAt === "string";
  }).toBe(true);
});
