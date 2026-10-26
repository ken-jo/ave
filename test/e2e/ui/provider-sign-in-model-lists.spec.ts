import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';

test.use({ seedApiKey: false });

test('first-run model setup reveals credentials only after an explicit choice', async ({ app, mainWindow }, testInfo) => {
  await expect(mainWindow.getByTestId('iab-status-model-setup')).toBeVisible();
  await expect(mainWindow.getByTestId('iab-status-model')).toHaveCount(0);
  const settings = await openInlineSettings(app, mainWindow, 'llm');

  for (const provider of ['codex', 'claude-code']) {
    await settings.getByTestId('llm-tab:add-provider').click();
    const choice = settings.getByTestId(`llm-tab:add-provider-item:${provider}`);
    await expect(choice).not.toContainText(/Codex|Claude Code/);
    await choice.click();
    const card = settings.getByTestId(`llm-tab:connection:${provider}`);
    const key = card.getByTestId('llm-api-key-input');
    await expect(key).toHaveCount(0);
    await expect(card.getByTestId(`llm-tab:sign-in-method:${provider}:api`)).toBeVisible();
    await card.getByTestId(`llm-tab:sign-in-method:${provider}:api`).click();
    await expect(key).toBeVisible();
    await card.getByTestId(`llm-tab:sign-in-method:${provider}:subscription`).click();
    await expect(key).toHaveCount(0);
    for (const action of ["configure-runtime", "change-runtime", "forget-runtime"]) {
      await expect(card.getByTestId(`subscription-provider:${provider}:${action}`)).toHaveCount(0);
    }
    await settings.screenshot({ path: testInfo.outputPath(`${provider}-sign-in.png`) });
  }

  await settings.getByTestId('llm-tab:add-provider').click();
  await settings.getByTestId('llm-tab:add-provider-item:gemini').click();
  const apiCard = settings.getByTestId('llm-tab:connection:gemini');
  const apiKey = apiCard.getByTestId('llm-api-key-input');
  await expect(apiKey).toBeFocused();
  await apiKey.fill('discarded-draft');
  await apiCard.getByTestId('llm-tab:save-providers-cancel').click();
  await expect(apiKey).toHaveCount(0);
  await apiCard.getByTestId('llm-tab:connection:gemini:toggle').click();
  await expect(apiKey).toHaveValue('');
  await settings.screenshot({ path: testInfo.outputPath('api-key-card.png') });
});
