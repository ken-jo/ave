import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";

test("notification controls share a destination and navigation names match titles", async ({ app, mainWindow, t }) => {
  await openInlineSettings(app, mainWindow, "notifications");
  await expect(mainWindow.locator('[data-settings-section="chat-signals"]')).toBeVisible();
  await expect(mainWindow.locator('[data-settings-section="notifications-delivery"]')).toBeVisible();
  await expect(mainWindow.locator('[data-settings-section="notifications-notices"]')).toBeAttached();
  for (const key of ["tabNotifications", "tabWeb", "tabStartup", "tabRoles", "tabMcp", "tabPluginConfig"]) {
    const name = t(`settingsContent.${key}`);
    await mainWindow.getByRole("tab", { name, exact: true }).click();
    await expect(mainWindow.getByTestId(TEST_IDS.settingsPageTitle)).toHaveText(name);
  }
  await mainWindow.getByRole("tab", { name: t("settingsContent.tabLlm"), exact: true }).click();
  const sections = mainWindow.locator('[role="tabpanel"][data-state="active"] [data-settings-section]');
  await expect(sections.first()).toHaveAttribute("data-settings-section", "llm-providers");
  await mainWindow.screenshot({ path: "test-results/settings-navigation-groups.png" });
});
