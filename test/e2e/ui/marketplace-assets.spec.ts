import { test, expect } from './fixtures.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

// Test picker-to-marketplace routing; isolated runs do not install packages from a remote source.
test('the provider picker opens its marketplace and built-in language choices persist', async ({
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
  await expect(kind('language')).toHaveCount(0);

  await appearanceTab.click();
  await expect(settingsPage.getByTestId('appearance-tab:marketplace-themes')).toHaveCount(0);
  await expect(settingsPage.getByTestId('appearance-tab:marketplace-languages')).toHaveCount(0);
  const languages = settingsPage.locator('[data-settings-section="appearance-language"]');
  await expect(languages.getByRole('radio')).toHaveCount(2);
  for (const locale of ['ko', 'en']) {
    const choice = languages.getByTestId(`language-option-${locale}`);
    await choice.click();
    await expect(choice).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => settingsPage.evaluate(async () => (await window.aveApi.getSettings()).appearance.language)).toBe(locale);
  }

  await closeInlineSettings(app, settingsPage);
});
