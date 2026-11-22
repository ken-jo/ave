import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';
import fs from 'node:fs';
import path from 'node:path';

test.describe('English settings data', () => {
  test.use({ seedLocale: 'en' });
  test('audit timestamps and usage periods follow the app language', async ({ app, mainWindow, aveHome, t }, testInfo) => {
    const now = new Date();
    const auditDir = path.join(aveHome, 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(path.join(auditDir, `${now.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({
      timestamp: now.toISOString(), sessionId: 'locale-audit-fixture', type: 'turn', input: 'locale-audit-detail',
    })}\n`);
    const page = await openInlineSettings(app, mainWindow, 'audit');
    await page.getByRole('textbox', { name: t('auditTab.filterTextPlaceholder') }).fill('locale-audit-detail');
    await page.getByRole('button', { name: t('auditTab.searchButton'), exact: true }).click();
    await expect(page.getByTestId('audit-row-time')).toHaveText(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(now));
    await page.screenshot({ path: testInfo.outputPath('audit-english-timestamp.png') });
    await closeInlineSettings(app, page);
    const usage = await openInlineSettings(app, mainWindow, 'usage');
    await expect(usage.getByRole('button', { name: t('usageDashboard.presetDays', { count: 7 }), exact: true })).toBeVisible();
    await expect(usage.getByRole('button', { name: t('usageDashboard.presetDays', { count: 30 }), exact: true })).toBeVisible();
  });
});

test.describe('Korean settings context', () => {
  test.use({ seedLocale: 'ko' });
  test('names preferences and context in the app language', async ({ app, mainWindow, t }) => {
    const page = await openInlineSettings(app, mainWindow, 'roles');
    await expect(page.getByRole('heading', { name: t('rolesTab.sectionPreferences'), exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: t('rolesTab.sectionPreview'), exact: true })).toBeVisible();
    await expect(page.locator('[data-settings-section="roles-preview"] pre')).toContainText('시스템 프롬프트');
  });
});
