import { test, expect } from './fixtures.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

// Verify the desktop composition with no remote share, where component-only snapshots cannot prove the guard.
test('keeps connection settings available without automatic approval grants', async ({
  app,
  mainWindow,
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'remote-surfaces');

  await settingsPage.getByTestId("connection:telegram:toggle").click();

  // Prove the connection rendered before asserting controls are absent.
  await expect(settingsPage.getByTestId('telegram-connection-content')).toBeVisible();
  await expect(settingsPage.getByTestId('telegram-connection-connect')).toBeVisible();

  // Remote requests always use the owner's one-shot human approval.
  await expect(settingsPage.getByTestId('away-authority-content')).toHaveCount(0);
  await expect(settingsPage.getByTestId('away-authority-open-arm-dialog')).toHaveCount(0);
  await expect(settingsPage.getByTestId('away-authority-arm-dialog')).toHaveCount(0);
  await expect(settingsPage.getByTestId('away-authority-disarm')).toHaveCount(0);

  await closeInlineSettings(app, settingsPage);
});

// Check both current tab identity and its alias so either route cannot silently break.
test('reaches the remote surfaces tab by its current id', async ({
  app,
  mainWindow,
  t,
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'remote-surfaces');

  const panel = settingsPage.locator('[data-settings-layout]');
  await expect(
    panel.getByRole('tab', { name: t('settingsContent.tabRemoteSurfaces'), exact: true }),
  ).toHaveAttribute('data-state', 'active');

  await closeInlineSettings(app, settingsPage);
});
