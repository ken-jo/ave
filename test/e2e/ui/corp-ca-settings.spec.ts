import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

// Boot reads certificate settings directly before service construction; verify persistence to that file.
test('the two switches round-trip through the real settings service', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'startup');

  for (const { testId, key } of [
    { testId: 'startup-corp-ca-enabled', key: 'corpCaEnabled' },
    { testId: 'startup-corp-ca-debug', key: 'corpCaDebugLog' },
  ] as const) {
    const toggle = settingsPage.getByTestId(testId);
    await expect(toggle).toBeVisible();
    await expect(settingsPage.getByTestId(`${testId}-forced`)).toHaveCount(0);

    const before = await toggle.getAttribute('aria-checked');
    expect(before === 'true' || before === 'false').toBe(true);
    const expected = before !== 'true';

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(expected));

    await expect
      .poll(async () =>
        settingsPage.evaluate(async (settingKey) => {
          const api = (window as unknown as {
            aveApi: { getSettings: () => Promise<unknown> };
          }).aveApi;
          const settings = (await api.getSettings()) as {
            system?: Record<string, unknown>;
          };
          return settings.system?.[settingKey];
        }, key),
      )
      .toBe(expected);
  }

  // These controls affect only the next launch.
  await expect(settingsPage.getByTestId('startup-corp-ca-help')).toBeVisible();
  await expect(settingsPage.getByTestId('startup-corp-ca-debug-help')).toBeVisible();

  await closeInlineSettings(app, settingsPage);
});

test('the certificate name persists only once it is committed', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'startup');

  // Enable the feature first because its name field is disabled while off.
  const enabled = settingsPage.getByTestId('startup-corp-ca-enabled');
  if ((await enabled.getAttribute('aria-checked')) !== 'true') {
    await enabled.click();
    await expect(enabled).toHaveAttribute('aria-checked', 'true');
  }

  const field = settingsPage.getByTestId('startup-corp-ca-common-name');
  await expect(field).toBeVisible();
  await expect(settingsPage.getByTestId('startup-corp-ca-common-name-help')).toBeVisible();
  await expect(settingsPage.getByTestId('startup-corp-ca-common-name-forced')).toHaveCount(0);

  const readName = async (): Promise<unknown> =>
    settingsPage.evaluate(async () => {
      const api = (window as unknown as {
        aveApi: { getSettings: () => Promise<unknown> };
      }).aveApi;
      const settings = (await api.getSettings()) as { system?: { corpCaCommonName?: string } };
      return settings.system?.corpCaCommonName;
    });

  const before = await readName();
  const expected = before === 'E2E Root CA' ? 'E2E Root CA 2' : 'E2E Root CA';

  await field.fill(expected);
  // Do not persist half-typed values to the file the next launch reads.
  expect(await readName()).toBe(before);

  await settingsPage.getByTestId('startup-corp-ca-common-name-save').click();
  await expect.poll(readName).toBe(expected);

  await closeInlineSettings(app, settingsPage);
});
