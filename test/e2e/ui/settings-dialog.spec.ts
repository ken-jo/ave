import { test, expect } from './fixtures';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

// Verify settings in the main window across widths; the compatibility filename does not imply a dialog.
test('inline settings opens to the requested tab and closes back', async ({ app, mainWindow, t }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'chat');

  // Scope to settings because the main sidebar also contains a similarly named chat tab.
  const settingsPanel = settingsPage.locator('[data-settings-layout]');
  await expect(
    settingsPanel.getByRole('tab', { name: t('settingsContent.tabChat'), exact: true }),
  ).toHaveAttribute('data-state', 'active');

  await closeInlineSettings(app, settingsPage);
});
