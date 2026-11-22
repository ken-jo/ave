import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';

test('permission rules require explicit wildcard consent and explain invalid or duplicate input', async ({ app, mainWindow, t }, testInfo) => {
  const page = await openInlineSettings(app, mainWindow, 'permissions');
  const input = page.getByTestId('permissions-rule-pattern-input');
  await input.fill('*');
  await page.getByTestId('permissions-rule-add').click();
  await expect(page.getByTestId('permissions-rule-warning')).toContainText(t('permissionsTab.ruleAllowAllWarning'));
  await expect.poll(async () => page.evaluate(async () => {
    const result = await window.ave.permission.listScopedRules();
    return result.rules.some(rule => rule.pattern === '*' && rule.action === 'allow' && rule.scope === 'user');
  })).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('wildcard-warning.png') });
  await page.getByTestId('permissions-rule-confirm').click();
  const broadRow = page.locator('[data-rule-store="scoped"]').filter({ has: page.getByTestId('permissions-rule-broad') }).filter({ hasText: '*' });
  await expect(broadRow).toHaveCount(1);
  await expect(page.getByTestId('permissions-rule-warning')).toHaveCount(0);

  await input.fill('*');
  await page.getByTestId('permissions-rule-add').click();
  await expect(page.getByTestId('permissions-rule-input-error')).toHaveText(t('permissionsTab.ruleDuplicate'));
  await input.fill('bad name!');
  await page.getByTestId('permissions-rule-add').click();
  await expect(page.getByTestId('permissions-rule-input-error')).toHaveText(t('permissionsTab.rulePatternInvalid'));
  await expect(input).toHaveValue('bad name!');

  await input.fill('custom_tool');
  await page.getByTestId('permissions-rule-action').click();
  await page.getByRole('option', { name: t('permissionsTab.actionAsk'), exact: true }).click();
  await page.getByTestId('permissions-rule-add').click();
  await expect(page.locator('[data-rule-store="scoped"]').filter({ hasText: 'custom_tool' })).toContainText(t('permissionsTab.actionAsk'));
  await expect(page.getByTestId('permissions-rule-warning')).toHaveCount(0);
});
