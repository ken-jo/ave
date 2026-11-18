import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';

test('audit rejects reversed dates and keeps the bundle range tied to the submitted search', async ({ app, mainWindow, t }) => {
  const page = await openInlineSettings(app, mainWindow, 'audit');
  const from = page.getByTestId('audit-date-from');
  const to = page.getByTestId('audit-date-to');
  const originalFrom = await from.inputValue();
  const originalTo = await to.inputValue();
  const exportRange = page.getByTestId('diagnostics-export-range');
  await expect(exportRange).toContainText(originalFrom);
  await expect(exportRange).toContainText(originalTo);
  await from.fill('2027-01-01');
  await to.fill('2026-01-01');
  await page.getByRole('button', { name: t('auditTab.searchButton'), exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: t('auditTab.invalidDateRange') })).toHaveText(t('auditTab.invalidDateRange'));
  await expect(exportRange).toContainText(originalFrom);
  await expect(exportRange).toContainText(originalTo);
  await expect(exportRange).not.toContainText('2027-01-01');
});
