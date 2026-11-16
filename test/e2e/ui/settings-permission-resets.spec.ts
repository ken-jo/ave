import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';

test('Modified permission settings reset through their owning main operations', async ({ app, mainWindow, t }, testInfo) => {
  const page = await openInlineSettings(app, mainWindow, 'permissions');
  await page.locator('#exec-mode-allow-radio').click();
  await expect.poll(async () => page.evaluate(async () => (await window.ave.permission.getMode()).mode)).toBe('allow');
  await page.getByTestId('permissions-rule-pattern-input').fill('settings_reset_tool');
  await page.getByTestId('permissions-rule-add').click();
  await expect(page.locator('[data-rule-store="scoped"]').filter({ hasText: 'settings_reset_tool' })).toBeVisible();
  await page.getByRole('button', { name: t('settingsEditor.modifiedOnly'), exact: true }).click();

  const mode = page.locator('[data-setting-registered="true"][data-setting-id="permissions.executionMode"]');
  await expect(mode).toBeVisible();
  await mode.getByRole('button', { name: t('settingsEditor.resetLabel', { label: t('permissionsTab.policyTitle') }), exact: true }).click();
  await expect.poll(async () => page.evaluate(async () => (await window.ave.permission.getMode()).mode)).toBe('strict');

  const rule = page.locator('[data-setting-registered="true"][data-setting-id^="permissions.rules."]').filter({ hasText: 'settings_reset_tool' });
  await rule.getByRole('button', { name: t('settingsEditor.resetLabel', { label: 'settings_reset_tool' }), exact: true }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const listed = await window.ave.permission.listScopedRules();
    return listed.rules.some((entry) => entry.pattern === 'settings_reset_tool');
  })).toBe(false);
  await expect(rule).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('permission-reset-defaults.png') });
});
