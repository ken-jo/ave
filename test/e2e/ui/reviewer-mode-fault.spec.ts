import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';
import { writePermissionSettingsFixture } from '../../../src/__tests__/support/permission-settings-fixture.js';

for (const [storedMode, locale] of [['strict', 'ko'], ['turbo', 'en']] as const) {
  test.describe(`unsupported reviewer ${storedMode}`, () => {
    test.use({ seedLocale: locale });

    test('keeps the evaluation selector unselected until explicit reviewer repair', async ({ app, mainWindow, aveHome, t }, testInfo) => {
      // Boot's one-time migration carries only restriction fields from a legacy root settings.json (ave-home-configuration.ts
      // carriedConfiguration), so a stored reviewer mode lives in the committed configuration; write it there.
      writePermissionSettingsFixture(aveHome, JSON.stringify({ permissions: { reviewer: { mode: storedMode } } }));
      const settingsPage = await openInlineSettings(app, mainWindow, 'permissions');
      const mode = settingsPage.locator('#permission-judge-mode');
      await expect(settingsPage.getByTestId('reviewer-mode-fault')).toBeVisible();
      await expect(mode).toBeDisabled();
      await expect(mode).toHaveValue('');
      await expect(mode.locator('option:checked')).toHaveText(t('permissionJudge.modeChoiceRequired'));
      const section = settingsPage.locator('[data-settings-section="permissions-judge"]');
      await expect(section).toContainText(t('permissionJudge.modeHelp'));
      await section.screenshot({ path: testInfo.outputPath('reviewer-fault-selector.png') });
      await section.getByRole('button', { name: t('permissionJudge.save') }).click();
      await expect(section.getByText(t('permissionJudge.saved'), { exact: true })).toBeVisible();
      const saved = JSON.parse(fs.readFileSync(path.join(aveHome, 'config', 'settings.json'), 'utf8'));
      expect(saved.permissions.reviewer.mode).toBe(storedMode);
      await expect(mode).toHaveValue('');
      await settingsPage.getByTestId('reviewer-mode-repair-llm').click();
      await expect(settingsPage.getByTestId('reviewer-mode-fault')).toHaveCount(0);
      await expect(mode).toBeEnabled();
      await expect(mode).toHaveValue('off');
      expect(JSON.parse(fs.readFileSync(path.join(aveHome, 'config', 'settings.json'), 'utf8')).permissions.reviewer.mode).toBe('llm');
      await closeInlineSettings(app, settingsPage);
    });
  });
}
