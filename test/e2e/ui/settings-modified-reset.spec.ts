import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";

test("Modified settings reset one preference to the host default", async ({ app, mainWindow, t }) => {
  await openInlineSettings(app, mainWindow, "chat");
  const toggle = mainWindow.getByRole("switch", { name: t("chatTab.autoCompactLabel"), exact: true });
  if (await toggle.getAttribute("aria-checked") === "true") await toggle.click();
  await expect.poll(() => mainWindow.evaluate(() => window.aveApi.getSettings().then((settings) => settings.chat.autoCompact))).toBe(false);
  await mainWindow.getByRole("button", { name: t("settingsEditor.modifiedOnly"), exact: true }).click();
  const row = mainWindow.locator('[data-settings-actions="chat-optimization"] [data-setting-id="chat.autoCompact"]');
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: t("settingsEditor.resetLabel", { label: t("chatTab.autoCompactLabel") }), exact: true }).click();
  await expect.poll(() => mainWindow.evaluate(() => window.aveApi.getSettings().then((settings) => settings.chat.autoCompact))).toBe(true);
  await expect(row).toHaveCount(0);
  await expect(mainWindow.locator('[data-settings-section="chat-optimization"]')).toBeHidden();
  await mainWindow.screenshot({ path: "test-results/settings-modified-reset.png" });
});

test("Modified settings hide unchanged controls inside a mixed section", async ({ app, mainWindow, t }) => {
  await openInlineSettings(app, mainWindow, "chat");
  await mainWindow.evaluate(async () => {
    const defaults = (await window.aveApi.getSettingsDefaults()).features;
    if (!defaults) throw new Error("Default feature settings are missing");
    await window.aveApi.updateSettings({ features: { idlePreferenceRefresh: defaults.idlePreferenceRefresh, idleMemoryConsolidation: defaults.idleMemoryConsolidation, subAgentAutonomousWake: defaults.subAgentAutonomousWake } });
  });
  const refresh = mainWindow.getByRole("switch", { name: t("chatTab.idleRefreshLabel"), exact: true });
  await expect(refresh).toHaveAttribute("aria-checked", "false");
  await refresh.click();
  await expect.poll(() => mainWindow.evaluate(() => window.aveApi.getSettings().then((settings) => settings.features?.idlePreferenceRefresh))).toBe(true);
  await mainWindow.getByRole("button", { name: t("settingsEditor.modifiedOnly"), exact: true }).click();
  await expect(mainWindow.locator('[data-setting-row="features.idlePreferenceRefresh"]')).toBeVisible();
  await expect(mainWindow.locator('[data-setting-row="features.idleMemoryConsolidation"]')).toBeHidden();
  await expect(mainWindow.locator('[data-setting-row="features.subAgentAutonomousWake"]')).toBeHidden();
  await mainWindow.screenshot({ path: "test-results/settings-modified-mixed-rows.png" });
});
