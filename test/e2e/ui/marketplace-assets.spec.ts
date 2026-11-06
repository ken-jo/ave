import { test, expect } from './fixtures.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

// Test picker-to-marketplace routing; isolated runs do not install packages from a remote source.
test('the provider and language pickers open the git marketplace on their kind', async ({
  app,
  mainWindow,
  t,
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'llm');

  const appearanceTab = settingsPage.getByRole('tab', {
    name: t('settingsContent.tabAppearance'),
    exact: true,
  });
  const marketplaceTab = settingsPage.getByRole('tab', {
    name: t('settingsContent.tabMarketplace'),
    exact: true,
  });
  const kind = (name: string) => settingsPage.getByTestId(`git-marketplace:kind:${name}`);

  await settingsPage.getByTestId('llm-tab:marketplace-providers').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');
  await expect(settingsPage.getByTestId('git-marketplace')).toBeVisible();
  await expect(kind('provider')).toHaveAttribute('aria-selected', 'true');

  await appearanceTab.click();
  await expect(settingsPage.getByTestId('appearance-tab:marketplace-themes')).toHaveCount(0);
  await settingsPage.getByTestId('appearance-tab:marketplace-languages').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');
  await expect(kind('language')).toHaveAttribute('aria-selected', 'true');

  await closeInlineSettings(app, settingsPage);
});
