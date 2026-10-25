import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

// Verify saved rate corrections reach the settings service used by the next usage aggregation.
test('a price correction round-trips through the real settings service', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'llm');

  const readOverrides = () =>
    settingsPage.evaluate(async () => {
      const api = (window as unknown as {
        aveApi: { getSettings: () => Promise<unknown> };
      }).aveApi;
      const settings = (await api.getSettings()) as {
        llm?: { pricingOverrides?: unknown[] };
      };
      return settings.llm?.pricingOverrides ?? [];
    });

  const readResolvedOverrides = () => mainWindow.evaluate(async () => {
    const api = (window as unknown as { aveApi: { getPricingOverrides: () => Promise<unknown> } }).aveApi;
    return api.getPricingOverrides();
  });

  await expect(settingsPage.getByTestId('llm-pricing-overrides-forced')).toHaveCount(0);
  await expect(settingsPage.getByTestId('llm-pricing-overrides-empty')).toBeVisible();

  const save = settingsPage.getByTestId('llm-pricing-override-save');
  await settingsPage.getByTestId('llm-pricing-override-add').click();
  // Incomplete rows cannot be saved because the store would silently drop them.
  await expect(save).toBeDisabled();
  await expect(settingsPage.getByTestId('llm-pricing-override-incomplete')).toBeVisible();

  await settingsPage.getByTestId('llm-pricing-override-vendor-0').selectOption('claude');
  await settingsPage.getByTestId('llm-pricing-override-model-0').fill('claude-sonnet-4-6');
  await settingsPage.getByTestId('llm-pricing-override-input-0').fill('2.5');
  await settingsPage.getByTestId('llm-pricing-override-output-0').fill('11');
  await expect(save).toBeEnabled();
  await save.click();

  await expect.poll(readOverrides).toEqual([
    { vendor: 'claude', model: 'claude-sonnet-4-6', inputPer1M: 2.5, outputPer1M: 11 },
  ]);
  await expect.poll(readResolvedOverrides).toEqual([
    { vendor: 'claude', model: 'claude-sonnet-4-6', inputPer1M: 2.5, outputPer1M: 11 },
  ]);

  // Verify corrections can be removed as well as added.
  await settingsPage.getByTestId('llm-pricing-override-remove-0').click();
  await save.click();
  await expect.poll(readOverrides).toEqual([]);
  await expect.poll(readResolvedOverrides).toEqual([]);

  await closeInlineSettings(app, settingsPage);
});
