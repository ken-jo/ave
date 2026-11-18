import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';

test('web key drafts belong to their provider and save only on explicit request', async ({ app, mainWindow }) => {
  const page = await openInlineSettings(app, mainWindow, 'web');
  await page.getByRole('button', { name: 'Tavily AI', exact: true }).click();
  const keyInput = page.locator('[data-settings-section="web-api-key"] input[type="password"]');
  await expect(keyInput).toBeEnabled();
  await keyInput.fill('fixture-first-provider-key');
  await page.getByRole('button', { name: 'Serper.dev', exact: true }).click();
  await expect(keyInput).toHaveValue('');
  expect(await page.evaluate(() => window.aveApi.hasWebApiKey('tavily'))).toBe(false);
  expect(await page.evaluate(() => window.aveApi.hasWebApiKey('serper'))).toBe(false);
  await keyInput.fill('fixture-second-provider-key');
  await page.getByTestId('web-api-key-save').click();
  await expect.poll(() => page.evaluate(() => window.aveApi.hasWebApiKey('serper'))).toBe(true);
  expect(await page.evaluate(() => window.aveApi.hasWebApiKey('tavily'))).toBe(false);
  await expect(keyInput).toHaveValue('');
});
