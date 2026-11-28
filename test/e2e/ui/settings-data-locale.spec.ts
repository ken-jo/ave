import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';

test.describe('English settings data', () => {
  test.use({ seedLocale: 'en' });
  test('usage periods follow the app language', async ({ app, mainWindow, t }) => {
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
