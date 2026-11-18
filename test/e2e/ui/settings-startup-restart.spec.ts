import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

test('startup changes retain restart indicators across reopening settings and refuse empty certificate names', async ({ app, mainWindow }, testInfo) => {
  let page = await openInlineSettings(app, mainWindow, 'startup');
  const toggle = page.getByTestId('startup-hardware-acceleration');
  const before = await toggle.getAttribute('aria-checked');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
  await expect(page.getByTestId('settings-restart-required')).toBeVisible();
  await expect(page.locator('[data-settings-section="startup-rendering"]').getByTestId('setting-restart-chip')).toBeVisible();
  await closeInlineSettings(app, page);
  page = await openInlineSettings(app, mainWindow, 'startup');
  await expect(page.getByTestId('settings-restart-required')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("startup-restart-required.png") });
  const enabled = page.getByTestId('startup-corp-ca-enabled');
  if ((await enabled.getAttribute('aria-checked')) !== 'true') await enabled.click();
  await page.getByTestId('startup-corp-ca-common-name').fill('');
  await expect(page.getByTestId('startup-corp-ca-common-name-save')).toBeDisabled();
  await expect(page.getByTestId('startup-corp-ca-common-name')).toHaveAttribute('aria-invalid', 'true');
  await closeInlineSettings(app, page);
});

test('the about page exposes automatic update control and a manual check', async ({ app, mainWindow }) => {
  const page = await openInlineSettings(app, mainWindow, 'about');
  await expect(page.getByTestId('about-auto-check-updates')).toBeVisible();
  await expect(page.getByTestId('about-check-updates')).toBeVisible();
  await closeInlineSettings(app, page);
});
