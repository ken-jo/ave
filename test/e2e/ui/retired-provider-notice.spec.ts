import { test, expect } from './fixtures.js';
import { closeInlineSettings, forceWideMainWindow, openInlineSettings } from './inline-settings.js';
import { TEST_IDS } from '../../../src/shared/test-ids.js';
import type { AveApi } from '../../../src/ui/renderer/types.js';

test.use({ seedLlmProvider: 'copilot', seedLocale: 'en' });

test('a retired profile stays blocked until an explicit model choice', async ({ app, mainWindow }) => {
  await forceWideMainWindow(app);
  const notice = mainWindow.getByTestId('retired-provider-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('no longer used');
  await expect(notice.getByRole('button')).toHaveCount(1);
  const composer = mainWindow.getByTestId(TEST_IDS.composerTextarea);
  const send = mainWindow.getByRole('button', { name: 'Send', exact: true });
  await composer.fill('A draft held until a provider is chosen');
  await expect(send).toBeDisabled();
  await mainWindow.screenshot({ path: test.info().outputPath('retired-provider-notice.png') });

  await openInlineSettings(app, mainWindow, 'chat');
  const autoCompact = mainWindow.locator('[data-settings-section="chat-optimization"]').getByRole('checkbox').first();
  await expect(autoCompact).toBeChecked();
  await autoCompact.click();
  await expect.poll(async () => {
    const settings = await mainWindow.evaluate(() => (window as unknown as { aveApi: AveApi }).aveApi.getSettings());
    return settings.chat.autoCompact;
  }).toBe(false);
  const afterChatSave = await mainWindow.evaluate(() => (window as unknown as { aveApi: AveApi }).aveApi.getSettings());
  expect(afterChatSave.llm.retiredProvider).toBe('copilot');
  await closeInlineSettings(app, mainWindow);
  await expect(notice).toBeVisible();
  await expect(send).toBeDisabled();

  await mainWindow.getByTestId('retired-provider-notice-action').click();
  const chooser = mainWindow.getByTestId(TEST_IDS.llmModelSelect);
  await expect(chooser).toBeVisible();
  await chooser.click();
  const model = mainWindow.getByRole('option', { name: /gpt-5\.4-mini/ }).first();
  await expect(model).toBeVisible();
  await model.click();
  await expect.poll(async () => {
    const settings = await mainWindow.evaluate(() => (window as unknown as { aveApi: AveApi }).aveApi.getSettings());
    return settings.llm.retiredProvider ?? null;
  }).toBeNull();

  await closeInlineSettings(app, mainWindow);
  await expect(notice).toHaveCount(0);
  await expect(send).toBeEnabled();
});
