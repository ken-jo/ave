import { setWindowSize } from "./seeded-electron.js";
import { test, expect } from './fixtures.js';
import { closeInlineSettings, forceWideMainWindow, openInlineSettings } from './inline-settings.js';
import { TEST_IDS } from '../../../src/shared/test-ids.js';
import type { AveApi } from '../../../src/ui/renderer/types.js';
import { DEFAULT_LLM_VENDOR } from '../../../src/shared/llm-vendor-defaults.js';

test.use({ seedLlmProvider: 'copilot', seedLocale: 'en' });

test.describe('a profile that also saved a model for the fallback vendor', () => {
  // Built-in vendors no longer pick a model, and the one-time migration clears a saved model equal to a removed built-in
  // default (gpt-5.4-mini for OpenAI). The fallback route therefore offers a model only when the profile saved another one.
  test.use({ seedLlmVendors: { [DEFAULT_LLM_VENDOR]: { model: 'gpt-5.4' } } });

  test('choosing the migrated model from the composer resolves provider retirement', async ({ app, mainWindow }) => {
    await forceWideMainWindow(app, mainWindow);
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
});

test('a retired profile stays blocked until an explicit model choice', async ({ app, mainWindow }) => {
  await forceWideMainWindow(app, mainWindow);
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
      await forceWideMainWindow(app, mainWindow);
      await mainWindow.evaluate(async () => {
        await (window as unknown as { aveApi: AveApi }).aveApi.updateSettings({
          llm: { provider: 'openai', vendors: { openai: { model: 'o4-mini' } } },
        } as never);
      });
      const notice = mainWindow.getByTestId('deprecated-model-notice');
      await expect(notice).toBeVisible();
      await expect(notice).not.toHaveAttribute('role');
      await expect(notice).not.toHaveAttribute('aria-live');
      const title = t('app.deprecatedModelNoticeTitle', { model: 'o4-mini' });
      const body = t('app.deprecatedModelNoticeBody');
      await expect(notice).toContainText(title);
      await expect(notice).toContainText(body);
      const polite = mainWindow.getByTestId('window-notice-strip').getByTestId('notice-live-polite');
      await expect(polite).toHaveAttribute('role', 'status');
      await expect(polite).toHaveAttribute('aria-live', 'polite');
      await expect(polite).toContainText(title);
      await expect(polite).toContainText(body);
      await expect(mainWindow.getByTestId('retired-provider-notice')).toHaveCount(0);
      const settings = await mainWindow.evaluate(() => (window as unknown as { aveApi: AveApi }).aveApi.getSettings());
      expect(settings.llm.retiredProvider).toBeUndefined();
      await mainWindow.getByTestId(TEST_IDS.composerTextarea).fill('A turn on a deprecated model');
      await expect(mainWindow.getByRole('button', { name: t('bottomActionRow.sendButton'), exact: true })).toBeEnabled();

      await setWindowSize(app, 420, 860);
      await expect(notice).toBeVisible();
      const measure = () => {
        const element = document.querySelector('[data-testid="deprecated-model-notice"]') as HTMLElement;
        return {
          notice: { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth },
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      };
      // The window reaches 420px first; the shell then relayouts from its ResizeObservers (sidebar and pane width tiers)
      // over the next frames. Sample until that settles, so an overflow that persists still fails.
      const cdp = await mainWindow.context().newCDPSession(mainWindow);
      let metrics: ReturnType<typeof measure> | undefined;
      try {
        await expect.poll(async () => {
          const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression: `(${measure.toString()})()`, returnByValue: true });
          expect(exceptionDetails).toBeUndefined();
          metrics = result.value as ReturnType<typeof measure>;
          return metrics.notice.scrollWidth <= metrics.notice.clientWidth && metrics.page <= 0;
        }, { message: 'deprecated notice fits a 420px window' }).toBe(true);
      } finally { await cdp.detach(); }
      await testInfo.attach('deprecated-notice-metrics-narrow', { body: JSON.stringify(metrics), contentType: 'application/json' });
      await testInfo.attach('deprecated-notice-narrow', { body: await notice.screenshot(), contentType: 'image/png' });
      await forceWideMainWindow(app, mainWindow);

      await mainWindow.getByTestId('deprecated-model-notice-action').click();
      await expect(mainWindow.getByTestId(TEST_IDS.llmModelSelect))
        .toContainText(t('llmTab.modelDeprecatedPlaceholder', { model: 'o4-mini' }));
      await closeInlineSettings(app, mainWindow);
      await mainWindow.getByTestId('deprecated-model-notice-dismiss').click();
      await expect(notice).toHaveCount(0);
    });
  });
}
