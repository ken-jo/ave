import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';

test('search settings offer implemented providers and disclose keyless fallback', async ({ app, mainWindow, t }) => {
  const page = await openInlineSettings(app, mainWindow, 'web');
  const providers = page.locator('[data-settings-section="web-search-engine"]');
  await expect(providers.getByRole('group', { name: t('webTab.searchEngineTitle'), exact: true }).getByRole('button')).toHaveCount(3);
  await providers.getByRole('button', { name: 'Tavily AI', exact: true }).click();
  await expect(page.locator('[data-settings-section="web-api-key"]')).toContainText(t('webTab.missingKeyFallback'));
});
