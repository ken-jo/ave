import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';

test('fallback edits save independently from immediate model controls', async ({ app, mainWindow, t }) => {
  const page = await openInlineSettings(app, mainWindow, 'llm');
  await page.evaluate(async () => {
    const saved = await window.aveApi.updateSettings({ llm: { fallbackChain: [{ provider: 'openai', model: 'fixture-fallback-model' }] } });
    if ('ok' in saved && saved.ok === false) throw new Error(saved.error);
  });
  await page.getByTestId('fallback-chain-toggle').click();
  const fallback = page.locator('[data-settings-section="llm-fallback"]');
  await fallback.getByRole('button', { name: t('llmTab.delete'), exact: true }).click();
  const thinking = page.locator('[data-settings-section="llm-thinking"]').getByRole('switch');
  const nextThinking = (await thinking.getAttribute('aria-checked')) !== 'true';
  await thinking.click();
  await expect.poll(() => page.evaluate(async () => {
    const settings = await window.aveApi.getSettings();
    return settings.llm.vendors[settings.llm.provider]?.enableThinking;
  })).toBe(nextThinking);
  expect(await page.evaluate(async () => (await window.aveApi.getSettings()).llm.fallbackChain)).toEqual([{ provider: 'openai', model: 'fixture-fallback-model' }]);
  await page.getByTestId('llm-tab:save-fallback').click();
  await expect.poll(() => page.evaluate(async () => (await window.aveApi.getSettings()).llm.fallbackChain)).toEqual([]);
  await expect(page.getByTestId('llm-tab:save-fallback')).toBeDisabled();
});
