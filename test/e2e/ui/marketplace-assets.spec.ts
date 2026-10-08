import { test, expect } from './fixtures.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

/**
 * The "more in the marketplace" links of the provider, theme and language
 * pickers open Settings → Marketplace on that kind of package (design §15.1).
 * Installing one needs a git source, which an isolated E2E run does not reach;
 * the content install itself is covered by the content store suites.
 */
test('the provider, theme and language pickers open the git marketplace on their kind', async ({
  app,
  mainWindow,
  t,
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'llm');

  const llmTab = settingsPage.getByRole('tab', { name: t('settingsContent.tabLlm'), exact: true });
  // Exact names: the marketplace's own kind tabs read "Theme 0", "Language 0".
  const appearanceTab = settingsPage.getByRole('tab', {
    name: t('settingsContent.tabAppearance'),
    exact: true,
  });
  const marketplaceTab = settingsPage.getByRole('tab', {
    name: t('settingsContent.tabMarketplace'),
    exact: true,
  });
  const kind = (name: string) => settingsPage.getByTestId(`git-marketplace:kind:${name}`);

  // A built-in provider is on the page (the fixture seeds a key for every
  // vendor); a marketplace provider is not, until a package brings it.
  await expect(settingsPage.getByTestId('llm-tab:connection:claude')).toBeVisible();
  await expect(settingsPage.getByTestId('llm-tab:connection:groq')).toHaveCount(0);

  await settingsPage.getByTestId('llm-tab:marketplace-providers').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');
  await expect(settingsPage.getByTestId('git-marketplace')).toBeVisible();
  await expect(kind('provider')).toHaveAttribute('aria-selected', 'true');

  await llmTab.click();
  await expect(settingsPage.getByTestId('llm-tab:connection:groq')).toHaveCount(0);

  await appearanceTab.click();
  await settingsPage.getByTestId('appearance-tab:marketplace-themes').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');
  await expect(kind('theme')).toHaveAttribute('aria-selected', 'true');

  await appearanceTab.click();
  await settingsPage.getByTestId('appearance-tab:marketplace-languages').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');
  await expect(kind('language')).toHaveAttribute('aria-selected', 'true');

  await closeInlineSettings(app, settingsPage);
});
