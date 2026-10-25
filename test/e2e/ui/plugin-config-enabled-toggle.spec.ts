import { test, expect } from './fixtures';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

test.use({ seedTogglePlugin: true, seedViewFixturePlugin: false });

// Toggle a loaded plugin and verify its own status and tool visibility, not another row's badge.
test('plugin-config Switch toggles a loaded plugin active/inactive and back', async ({ app, mainWindow, t }) => {
  const settings = await openInlineSettings(app, mainWindow, 'plugin-config');
  try {
    const anyToggle = settings.locator('[data-testid^="plugin-config:enabled-toggle:"]').first();
    const hasToggle = await anyToggle
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    expect(hasToggle, 'Expected at least one runtime-loaded plugin with an active-state toggle').toBe(true);

    const pluginId = 'e2e-toggle-plugin';
    await settings.locator(`[data-testid="plugin-config:row:${pluginId}"]`).click();

    const toggle = settings.locator(`[data-testid="plugin-config:enabled-toggle:${pluginId}"]`);
    const detailStatus = settings.locator(`[data-testid="plugin-config:detail-status:${pluginId}"]`);
    const hiddenNote = settings.locator(`[data-testid="plugin-config:tools-hidden-note:${pluginId}"]`);

    await expect(toggle).toHaveAttribute('data-state', 'checked');
    await expect(detailStatus).toHaveText(t('pluginConfigTab.statusLoaded'));

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'unchecked', { timeout: 15_000 });
    await expect(detailStatus).toHaveText(t('pluginConfigTab.statusDisabled'), { timeout: 15_000 });
    await expect(hiddenNote).toBeVisible({ timeout: 15_000 });

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'checked', { timeout: 15_000 });
    await expect(detailStatus).toHaveText(t('pluginConfigTab.statusLoaded'), { timeout: 15_000 });
    await expect(hiddenNote).toHaveCount(0);
  } finally {
    await closeInlineSettings(app, settings).catch(() => {});
  }
});
