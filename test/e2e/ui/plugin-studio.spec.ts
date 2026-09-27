import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures.js";
import { closeInlineSettings, openInlineSettings } from "./inline-settings.js";

test("form to review to local package install", async ({ app, mainWindow, userDataDir, t }, testInfo) => {
  const page = await openInlineSettings(app, mainWindow, "marketplace");
  await page.getByTestId("git-marketplace:add-menu").click();
  await page.getByRole("menuitem", { name: t("pluginStudio.createTitle") }).click();
  await expect(page.getByTestId("plugin-studio")).toBeVisible();
  await page.getByTestId("plugin-studio:name").fill("team-kit");
  await page.getByTestId("plugin-studio:version").fill("1.0.0");
  await page.getByTestId("plugin-studio:description").fill("A team plugin");
  await page.getByTestId("plugin-studio:create").click();
  await expect(page.getByTestId("plugin-studio:review")).toBeVisible();
  await expect(page.getByTestId("plugin-studio:review")).toContainText("plugin.json");
  await page.screenshot({ path: testInfo.outputPath("plugin-studio-review.png") });
  await page.getByTestId("plugin-studio:install").click();
  await expect(page.getByTestId("plugin-studio:package-sheet")).toBeVisible();
  await expect(page.getByTestId("plugin-studio:package-sheet")).toContainText("A team plugin");
  await page.getByTestId("plugin-studio:install-confirm").click();
  await expect(page.getByTestId("plugin-studio:package-sheet")).toHaveCount(0);
  await expect.poll(async () => {
    const ledger = JSON.parse(await readFile(join(userDataDir, "ave-state", "packages", "ledger.json"), "utf8")) as { packages: Array<{ name: string; origin: { sourceId: string | null } }> };
    return ledger.packages.find((entry) => entry.name === "team-kit")?.origin.sourceId;
  }).toBeNull();
  await closeInlineSettings(app, page);
});
