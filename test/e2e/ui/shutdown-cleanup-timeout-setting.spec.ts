import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

// Verify the shutdown cleanup value reaches the service queried during before-quit.
test('the cleanup window round-trips through the real settings service', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'startup');

  const select = settingsPage.getByTestId('startup-shutdown-timeout');
  await expect(select).toBeVisible();
  await expect(settingsPage.getByTestId('startup-shutdown-timeout-help')).toBeVisible();
  await expect(settingsPage.getByTestId('startup-shutdown-timeout-forced')).toHaveCount(0);
  await expect(select).toBeEnabled();

  await select.selectOption('30000');
  await expect(select).toHaveValue('30000');

  await expect
    .poll(async () =>
      settingsPage.evaluate(async () => {
        const api = (window as unknown as {
          aveApi: { getSettings: () => Promise<unknown> };
        }).aveApi;
        const settings = (await api.getSettings()) as {
          system?: { shutdownCleanupTimeoutMs?: number };
        };
        return settings.system?.shutdownCleanupTimeoutMs;
      }),
    )
    .toBe(30000);

  // Cleanup inherits the app deadline; exhausted reserve reports unproven cleanup and external release remains the backstop.
  await select.selectOption('15000');
  await expect
    .poll(async () =>
      settingsPage.evaluate(async () => {
        const api = (window as unknown as {
          aveApi: { getSettings: () => Promise<unknown> };
        }).aveApi;
        const settings = (await api.getSettings()) as {
          system?: { shutdownCleanupTimeoutMs?: number };
        };
        return settings.system?.shutdownCleanupTimeoutMs;
      }),
    )
    .toBe(15000);

  await closeInlineSettings(app, settingsPage);
});
