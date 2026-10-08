import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

/**
 * Update notices + kept downloads — real-Electron round trip.
 *
 * Both of these were environment-only flags, which a packaged app's user has
 * no shell to set. The unit tests cover the resolvers; what they cannot cover
 * is whether the two switches in Settings → Marketplace → Maintenance actually
 * reach the settings service the marketplace reads. A control that only moved
 * component state would pass every render test and still change nothing about
 * the app.
 *
 * So this drives the real switches and asks the main process what it holds.
 */
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
    // The switch waits for the saved value before it takes a click.
    await expect(toggle).toBeEnabled();
    await expect(settingsPage.getByTestId(`${testId}:help`)).toBeVisible();
    // Neither variable is set in this harness, so the "the environment is
    // deciding this" notice must stay absent — it is the one piece of copy
    // that would be a lie if it appeared on its own.
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
