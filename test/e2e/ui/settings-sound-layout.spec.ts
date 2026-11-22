import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';
import { setWindowSize } from './seeded-electron.js';

test('sound signal labels stay readable beside their controls in a narrow window', async ({ app, mainWindow, t }) => {
  const page = await openInlineSettings(app, mainWindow, 'notifications');
  await setWindowSize(app, 420, 800);
  await expect(page.locator("[data-settings-layout]")).toHaveAttribute("data-settings-layout", "narrow");
  await page.getByRole("tab", { name: t("settingsContent.tabNotifications"), exact: true }).click();
  const row = page.getByTestId('accessibility-signal:turnFinished');
  await row.scrollIntoViewIfNeeded();
  const text = await row.locator('p').first().boundingBox();
  const select = await row.locator('select').boundingBox();
  expect(text).not.toBeNull(); expect(select).not.toBeNull();
  if (!text || !select) throw new Error("Sound controls have no rendered geometry");
  expect(text.width).toBeGreaterThan(180);
  expect(text.y + text.height).toBeLessThanOrEqual(select.y);
  await page.screenshot({ path: 'test-results/settings-sound-narrow.png' });
  await closeInlineSettings(app, page);
});
