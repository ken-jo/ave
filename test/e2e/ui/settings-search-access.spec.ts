import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";

test("settings search filters rendered sections in place and supports keyboard access", async ({ app, mainWindow, t }) => {
  await openInlineSettings(app, mainWindow, "web");
  const search = mainWindow.getByRole("searchbox", { name: t("settingsContent.search") });
  await search.fill(t("webTab.apiKeyStaticTitle"));
  const section = mainWindow.locator('[data-settings-section="web-api-key"]');
  await expect(section).toBeVisible();
  await expect(section).not.toContainText("{label}");
  await expect(mainWindow.locator('[data-settings-section="startup-launch"]')).toBeHidden();
  await search.fill("web-api-key");
  await search.press("ArrowDown");
  await expect.poll(() => section.evaluate((node) => node.contains(node.ownerDocument.activeElement))).toBe(true);
  await mainWindow.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await search.fill("theme");
  await expect(mainWindow.locator('[data-settings-section="appearance-theme"]')).toBeVisible();
  await expect(mainWindow.locator('[data-settings-section="web-api-key"]')).toBeHidden();
  await mainWindow.screenshot({ path: "test-results/settings-search-keyboard.png" });
});
