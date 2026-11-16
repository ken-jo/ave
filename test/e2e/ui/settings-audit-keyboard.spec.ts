import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';
import fs from 'node:fs';
import path from 'node:path';

test('audit filters are named and event details open and close by keyboard', async ({ app, mainWindow, aveHome, t }, testInfo) => {
  const now = new Date();
  const auditDir = path.join(aveHome, 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.appendFileSync(path.join(auditDir, `${now.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({
    timestamp: now.toISOString(), sessionId: 'keyboard-audit-fixture', type: 'turn', input: 'keyboard-audit-detail',
  })}\n`);
  const page = await openInlineSettings(app, mainWindow, 'audit');
  await expect(page.getByLabel(t('auditTab.filterDateFrom'), { exact: true })).toBeVisible();
  await expect(page.getByLabel(t('auditTab.filterDateTo'), { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: t('auditTab.filterType') })).toBeVisible();
  await expect(page.getByRole('combobox', { name: t('auditTab.logLevel') })).toBeVisible();
  const help = page.getByTestId('settings-page-help');
  await expect(help).toBeVisible();
  const helpBox = await help.boundingBox();
  expect(helpBox).not.toBeNull();
  if (helpBox === null) throw new Error("Settings help button geometry is unavailable.");
  expect(helpBox.width).toBeGreaterThanOrEqual(24);
  expect(helpBox.height).toBeGreaterThanOrEqual(24);
  await page.getByRole('textbox', { name: t('auditTab.filterTextPlaceholder') }).fill('keyboard-audit-detail');
  await page.getByRole('button', { name: t('auditTab.searchButton'), exact: true }).click();
  const toggle = page.getByRole('button', { name: t('auditTab.toggleDetails', { number: 1 }) });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: testInfo.outputPath('audit-keyboard-details.png') });
  await toggle.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});
