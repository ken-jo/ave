import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';

test('owner-away wait refuses invalid input and accepts a seven-day budget', async ({ app, mainWindow, t }, testInfo) => {
  const page = await openInlineSettings(app, mainWindow, 'permissions');
  const input = page.getByTestId('owner-away-auto-skip');
  await expect(input).toHaveAttribute('max', '10080');
  const saved = await input.inputValue();
  for (const draft of ['-1', '1.5', '10081', '']) {
    await input.fill(draft);
    await input.press('Tab');
    await expect(page.getByTestId('owner-away-error')).toHaveText(t('permissionsTab.ownerAwayInvalid', { max: 10080 }));
    await expect(input).toHaveValue(saved);
  }
  await page.screenshot({ path: testInfo.outputPath('invalid-owner-away-range.png') });
  await input.fill('10080');
  await input.press('Tab');
  await expect(input).toHaveValue('10080');
  await expect(page.getByTestId('owner-away-error')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(async () => {
    const settings = await window.aveApi.getSettings();
    return settings.permissions?.ownerAwayAutoSkipMinutes;
  })).toBe(10080);
});
