import { test, expect } from './fixtures.js';
import { closeInlineSettings, forceWideMainWindow, openInlineSettings } from './inline-settings.js';
import { TEST_IDS } from '../../../src/shared/test-ids.js';
import type { AveApi } from '../../../src/ui/renderer/types.js';

test.use({ seedLlmProvider: 'copilot', seedLocale: 'en' });

test('choosing the migrated model from the composer resolves provider retirement', async ({ app, mainWindow }) => {
  await forceWideMainWindow(app);
  const notice = mainWindow.getByTestId('retired-provider-notice');
  await expect(notice).toBeVisible();
  await mainWindow.getByTestId(TEST_IDS.composerTextarea).fill('A draft held for an explicit model choice');
  const send = mainWindow.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  const before = await mainWindow.evaluate(() => (window as unknown as { aveApi: AveApi }).aveApi.getSettings());
  expect(before.llm.retiredProvider).toBe('copilot');
  const model = before.llm.vendors[before.llm.provider]?.model;
  expect(model).toBeTruthy();

  await mainWindow.getByTestId('iab-status-model').click();
  await mainWindow.getByTestId(`model-quick-picker-option:${before.llm.provider}:${model}`).click();
  await expect.poll(async () => {
    const settings = await mainWindow.evaluate(() => (window as unknown as { aveApi: AveApi }).aveApi.getSettings());
    return settings.llm.retiredProvider ?? null;
  }).toBeNull();
  await expect(notice).toHaveCount(0);
  await expect(send).toBeEnabled();
  await mainWindow.screenshot({ path: test.info().outputPath('retired-provider-composer-choice.png') });
});

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

// Deprecated saved models keep working; the notice only reports catalog status.
for (const locale of ['en', 'ko'] as const) {
  test.describe(`deprecated model notice (${locale})`, () => {
    test.use({ seedLlmProvider: 'openai', seedLocale: locale });

    test('tells about a deprecated model without blocking chat', async ({ app, mainWindow, t }, testInfo) => {
      await forceWideMainWindow(app);
      await mainWindow.evaluate(async () => {
        await (window as unknown as { aveApi: AveApi }).aveApi.updateSettings({
          llm: { provider: 'openai', vendors: { openai: { model: 'o4-mini' } } },
        } as never);
      });
      const notice = mainWindow.getByTestId('deprecated-model-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute('role', 'status');
      await expect(notice).toContainText(t('app.deprecatedModelNoticeTitle', { model: 'o4-mini' }));
      await expect(notice).toContainText(t('app.deprecatedModelNoticeBody'));
      await expect(mainWindow.getByTestId('retired-provider-notice')).toHaveCount(0);
      const settings = await mainWindow.evaluate(() => (window as unknown as { aveApi: AveApi }).aveApi.getSettings());
      expect(settings.llm.retiredProvider).toBeUndefined();
      await mainWindow.getByTestId(TEST_IDS.composerTextarea).fill('A turn on a deprecated model');
      await expect(mainWindow.getByRole('button', { name: t('bottomActionRow.sendButton'), exact: true })).toBeEnabled();

      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.setContentSize(420, 900);
      });
      await expect(notice).toBeVisible();
      const measure = () => {
        const element = document.querySelector('[data-testid="deprecated-model-notice"]') as HTMLElement;
        return {
          notice: { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth },
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      };
      const cdp = await mainWindow.context().newCDPSession(mainWindow);
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression: `(${measure.toString()})()`, returnByValue: true });
      await cdp.detach();
      expect(exceptionDetails).toBeUndefined();
      const metrics = result.value as ReturnType<typeof measure>;
      expect(metrics.notice.scrollWidth).toBeLessThanOrEqual(metrics.notice.clientWidth);
      expect(metrics.page).toBeLessThanOrEqual(0);
      await testInfo.attach('deprecated-notice-metrics-narrow', { body: JSON.stringify(metrics), contentType: 'application/json' });
      await testInfo.attach('deprecated-notice-narrow', { body: await notice.screenshot(), contentType: 'image/png' });
      await forceWideMainWindow(app);

      await mainWindow.getByTestId('deprecated-model-notice-action').click();
      await expect(mainWindow.getByTestId(TEST_IDS.llmModelSelect))
        .toContainText(t('llmTab.modelDeprecatedPlaceholder', { model: 'o4-mini' }));
      await closeInlineSettings(app, mainWindow);
      await mainWindow.getByTestId('deprecated-model-notice-dismiss').click();
      await expect(notice).toHaveCount(0);
    });
  });
}
