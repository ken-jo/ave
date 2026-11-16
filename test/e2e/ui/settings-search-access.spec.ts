import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";

test("settings search finds API key anchors and supports keyboard traversal", async ({ app, mainWindow, t }) => {
  await openInlineSettings(app, mainWindow, "web");
  const search = mainWindow.getByRole("searchbox", { name: t("settingsContent.search") });
  await search.fill("api key");
  const results = mainWindow.getByRole("list", { name: t("settingsContent.search") });
  await expect(results).not.toContainText("{label}");
  await search.press("ArrowDown");
  await expect(results.getByRole("button").first()).toBeFocused();
  await results.getByRole("button").first().press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await search.fill("Search API key");
  await search.press("ArrowDown");
  await results.getByRole("button").first().press("Enter");
  await expect(mainWindow.locator('[data-settings-section="web-api-key"]')).toBeVisible();
  await expect(mainWindow.locator('[data-settings-section="web-api-key"]')).toBeFocused();
  await mainWindow.screenshot({ path: "test-results/settings-search-keyboard.png" });
});
