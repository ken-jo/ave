import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

// Verify persistence to the settings file that boot reads before service construction.
test('the toggle round-trips through the real settings service', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'startup');

  const toggle = settingsPage.getByTestId('startup-hardware-acceleration');
  await expect(toggle).toBeVisible();
  // The running process cannot apply this change.
  await expect(settingsPage.getByTestId('startup-hardware-acceleration-help')).toBeVisible();
  await expect(settingsPage.getByTestId('startup-hardware-acceleration-forced')).toHaveCount(0);

  const before = await toggle.getAttribute('aria-checked');
  expect(before === 'true' || before === 'false').toBe(true);
  const expected = before !== 'true';

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(expected));

  await expect
    .poll(async () =>
      settingsPage.evaluate(async () => {
        const api = (window as unknown as {
          aveApi: { getSettings: () => Promise<unknown> };
        }).aveApi;
        const settings = (await api.getSettings()) as {
          system?: { hardwareAcceleration?: boolean };
        };
        return settings.system?.hardwareAcceleration;
      }),
    )
    .toBe(expected);

  await closeInlineSettings(app, settingsPage);
});
