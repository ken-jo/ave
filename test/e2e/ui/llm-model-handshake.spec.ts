import { test, expect } from './fixtures.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';
import { TEST_IDS } from "../../../src/shared/test-ids.js";

test.use({ seedApiKey: false });

test.describe('unselected chat model', () => {
  test('fresh settings show no selected model', async ({ app, mainWindow }, testInfo) => {
    const settingsPage = await openInlineSettings(app, mainWindow, 'llm');
    const chooser = settingsPage.getByTestId(TEST_IDS.llmModelSelect);
    await expect(chooser).toContainText('Connect a provider to choose a model');
    await expect(chooser).not.toContainText('gpt-5.4-mini');
    await settingsPage.screenshot({ path: testInfo.outputPath('unselected-model.png') });
    await closeInlineSettings(app, settingsPage);
  });
});

// Endpoint-defined model lists must stay empty until a live handshake supplies them.
test('openai-compatible model dropdown shows no hardcoded seed before an endpoint is entered', async ({
  app,
  mainWindow,
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'llm');

  await settingsPage.getByTestId('llm-tab:add-provider').click();
  await settingsPage.getByTestId('llm-tab:add-provider-item:openai-compatible').click();

  // No endpoint means no handshake and no model options.
  const baseUrl = settingsPage.getByTestId('llm-base-url-input');
  await expect(baseUrl).toBeVisible({ timeout: 10_000 });
  await expect(baseUrl).toHaveValue('');

  await settingsPage.getByTestId(TEST_IDS.llmModelSelect).click();
  await expect(settingsPage.getByText('Qwen3.6-35B-A3B-NVFP4')).toHaveCount(0);
  await expect(settingsPage.getByText('Nemotron-3-Nano-30B-A3B-FP8')).toHaveCount(0);

  // Dismiss the select overlay before teardown navigation so it cannot intercept the click.
  await settingsPage.keyboard.press('Escape');
  await closeInlineSettings(app, settingsPage);
});
