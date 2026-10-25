import { test, expect } from './fixtures';
import path from 'node:path';
import fs from 'node:fs';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

// Immediate controls save through debounce; text fields commit on explicit editing boundaries.
// Reopen settings to verify persistence from the real store.
test('immediate-apply toggle persists privacy redaction without explicit Save', async ({
  app,
  mainWindow,
  userDataDir,
  t,
}) => {
  const settingsPath = path.join(userDataDir, 'ave-settings.json');
  const settingsPage = await openInlineSettings(app, mainWindow, 'chat');
  const redactToggle = settingsPage.getByRole('checkbox', {
    name: t('privacyTab.piiRedactToggleLabel'),
  });

  await expect(redactToggle).toBeVisible({ timeout: 10_000 });
  if ((await redactToggle.getAttribute('aria-checked')) !== 'true') {
    await redactToggle.click();
  }
  await expect(redactToggle).toHaveAttribute('aria-checked', 'true');

  // Poll the file through debounce and IPC latency rather than clicking a save button.
  await expect
    .poll(
      () => {
        try {
          const raw = fs.readFileSync(settingsPath, 'utf-8');
          return JSON.parse(raw)?.privacy?.piiRedactEnabled;
        } catch {
          return undefined;
        }
      },
      { timeout: 5_000, intervals: [200, 400, 800] },
    )
    .toBe(true);

  // Saving keeps settings open; unmount the inline view before testing fresh hydration.
  // Closing the page would close the app.
  await closeInlineSettings(app, settingsPage);

  const reopenedSettingsPage = await openInlineSettings(app, mainWindow, 'chat');
  await expect(
    reopenedSettingsPage.getByRole('checkbox', {
      name: t('privacyTab.piiRedactToggleLabel'),
    }),
  ).toHaveAttribute('aria-checked', 'true');
  await closeInlineSettings(app, reopenedSettingsPage);
});


test('inline close flushes a pending immediate-apply setting', async ({
  app,
  mainWindow,
  t,
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'chat');
  const redactToggle = settingsPage.getByRole('checkbox', {
    name: t('privacyTab.piiRedactToggleLabel'),
  });

  await expect(redactToggle).toBeVisible({ timeout: 10_000 });
  const nextState = (await redactToggle.getAttribute('aria-checked')) === 'true'
    ? 'false'
    : 'true';
  await redactToggle.click();
  await expect(redactToggle).toHaveAttribute('aria-checked', nextState);

  // Close before debounce expires to prove unmount flushes pending writes.
  await closeInlineSettings(app, settingsPage);

  const reopenedSettingsPage = await openInlineSettings(app, mainWindow, 'chat');
  await expect(
    reopenedSettingsPage.getByRole('checkbox', {
      name: t('privacyTab.piiRedactToggleLabel'),
    }),
  ).toHaveAttribute('aria-checked', nextState);
  await closeInlineSettings(app, reopenedSettingsPage);
});
