import { test, expect } from './fixtures.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';
import type { AveApi } from '../../../src/ui/renderer/types.js';

test.use({ seedLlmProvider: 'openai', seedLlmVendors: { openai: { model: 'gpt-5.4-mini' } } });

test('compaction selects a connected route and retains unavailable selections', async ({ app, mainWindow, t }, testInfo) => {
  const settings = await openInlineSettings(app, mainWindow, 'llm');
  const picker = settings.getByTestId('compaction-model');
  await expect(picker).toBeEnabled();
  const selected = await settings.evaluate(async () => {
    const snapshot = await window.ave.permission.judgeGet();
    if (!snapshot.ok) throw new Error('Could not read connected system model routes');
    const model = snapshot.modelOptions[0];
    if (!model?.route) throw new Error('No connected system model route');
    return model;
  });
  await picker.click();
  await settings.getByRole('option').filter({ has: settings.locator('[data-model-id]', { hasText: selected.model }) }).first().click();
  await settings.getByTestId('compaction-model-save').click();
  await expect.poll(() => settings.evaluate(async () => {
    const api = (window as unknown as { aveApi: AveApi }).aveApi;
    return (await api.getSettings()).llm.compactionModelSelection;
  })).toEqual(selected);

  await settings.evaluate(async (selection) => {
    const api = (window as unknown as { aveApi: AveApi }).aveApi;
    await api.updateSettings({ llm: { compactionModelSelection: { ...selection, model: 'unavailable-summary-model' } } });
  }, selected);
  await expect(picker).toContainText('unavailable-summary-model');
  await expect(settings.getByTestId('compaction-model-unavailable')).toBeVisible();
  await settings.screenshot({ path: testInfo.outputPath('compaction-model-unavailable.png') });
  await picker.click();
  await settings.getByRole('option', { name: t('compactionSettings.currentModel') }).click();
  await settings.getByTestId('compaction-model-save').click();
  await expect.poll(() => settings.evaluate(async () => {
    const api = (window as unknown as { aveApi: AveApi }).aveApi;
    return (await api.getSettings()).llm.compactionModelSelection;
  })).toBeNull();
  await expect(settings.getByTestId('compaction-model-unavailable')).toHaveCount(0);
  await closeInlineSettings(app, settings);
});
