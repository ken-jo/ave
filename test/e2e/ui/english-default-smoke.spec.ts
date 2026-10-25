import { test, expect } from './fixtures';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

// Exercise the production default locale because the shared UI fixture seeds Korean.
test.use({ seedLocale: 'en' });

test('boots in English: composer placeholder renders the English catalog', async ({ mainWindow }) => {
  const textarea = mainWindow.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 10_000 });

  const placeholder = await textarea.getAttribute('placeholder');

  // The shared hint does not distinguish locales; the settings heading proves English rendering.
  expect(placeholder).toBe('typing, ⌘+V, /');
});

test('boots in English: inline settings heading is "Settings"', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'llm');

  await expect(
    settingsPage.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    settingsPage.getByRole('heading', { name: '설정', exact: true }),
  ).toHaveCount(0);

  await closeInlineSettings(app, settingsPage);
});
