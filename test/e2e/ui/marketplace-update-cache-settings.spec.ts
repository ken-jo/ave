import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

// Verify marketplace maintenance controls reach the settings service, beyond resolver-only coverage.
test('the update-notice and kept-download switches round-trip through the real settings service', async ({
  app,
  mainWindow,
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'marketplace');

  const readMarketplace = () =>
    settingsPage.evaluate(async () => {
      const api = (window as unknown as {
        aveApi: { getSettings: () => Promise<unknown> };
      }).aveApi;
      const settings = (await api.getSettings()) as {
        marketplace?: { updateCheckEnabled?: boolean; offlineCacheEnabled?: boolean };
      };
      return {
        updateCheckEnabled: settings.marketplace?.updateCheckEnabled,
        offlineCacheEnabled: settings.marketplace?.offlineCacheEnabled,
      };
    });

  for (const { testId, field } of [
    { testId: 'git-marketplace:update-check', field: 'updateCheckEnabled' as const },
    { testId: 'git-marketplace:offline-cache', field: 'offlineCacheEnabled' as const },
  ]) {
    const toggle = settingsPage.getByTestId(testId);
    await expect(toggle).toBeVisible();
    // Wait for initial settings hydration before clicking.
    await expect(toggle).toBeEnabled();
    await expect(settingsPage.getByTestId(`${testId}:help`)).toBeVisible();
    // No environment override is seeded, so an override notice would be misleading.
    await expect(settingsPage.getByTestId(`${testId}:forced`)).toHaveCount(0);

    const before = await toggle.getAttribute('aria-checked');
    expect(before === 'true' || before === 'false').toBe(true);
    const expected = before !== 'true';

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(expected));
    await expect.poll(async () => (await readMarketplace())[field]).toBe(expected);
  }

  await closeInlineSettings(app, settingsPage);
});
