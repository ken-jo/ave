import { test, expect } from './fixtures.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

// Verify the desktop composition with no remote share, where component-only snapshots cannot prove the guard.
test('keeps connection settings available without automatic approval grants', async ({
  app,
  mainWindow,
  t,
}, testInfo) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'remote-surfaces');

  await settingsPage.getByTestId("connection:telegram:toggle").click();

  // Prove the connection rendered before asserting controls are absent.
  await expect(settingsPage.getByTestId('telegram-connection-content')).toBeVisible();
  await expect(settingsPage.getByTestId('telegram-connection-connect')).toBeVisible();

  const ownerForm = settingsPage.getByTestId('telegram-connection-owner-form');
  await expect(ownerForm).toContainText(t('telegramConnection.ownerOnlyBody'));
  await expect(settingsPage.getByTestId('telegram-connection-owner-required')).toBeVisible();
  const ownerInput = settingsPage.getByTestId('telegram-connection-owner-user-id');
  const saveOwner = settingsPage.getByTestId('telegram-connection-save-owner');
  await ownerInput.fill('@someone');
  await expect(saveOwner).toBeDisabled();
  await ownerInput.fill('123456789');
  await expect(saveOwner).toBeEnabled();
  await saveOwner.click();
  await expect(settingsPage.getByTestId('telegram-connection-owner-required')).toHaveCount(0);
  await expect(saveOwner).toBeDisabled();
  await expect(ownerInput).toHaveValue('123456789');
  const screenshot = testInfo.outputPath('telegram-owner-identity.png');
  await settingsPage.screenshot({ path: screenshot });
  await testInfo.attach('telegram-owner-identity', { path: screenshot, contentType: 'image/png' });

  // Connection configuration does not itself create an approval grant.
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


test('Tailnet limits connections to the owner account', async ({ app, mainWindow, t }, testInfo) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'remote-surfaces');
  await settingsPage.getByTestId('connection:tailnet:toggle').click();
  const content = settingsPage.getByTestId('tailnet-access-content');
  await expect(content).toBeVisible();
  await expect(content).toContainText(t('tailnetAccessTab.pageDescription'));
  const screenshot = testInfo.outputPath('tailnet-owner-only.png');
  await settingsPage.screenshot({ path: screenshot });
  await testInfo.attach('tailnet-owner-only', { path: screenshot, contentType: 'image/png' });
  await closeInlineSettings(app, settingsPage);
});
