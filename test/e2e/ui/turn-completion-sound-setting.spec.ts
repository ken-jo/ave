import { test, expect } from './fixtures.js';
import type { AveApi } from '../../../src/ui/renderer/types.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

test('completion sound can be switched off and back on through persisted settings', async ({ app, mainWindow, t }, testInfo) => {
  const page = await openInlineSettings(app, mainWindow, 'plugin-config');
  const sound = page.getByTestId('turn-completion-sound');
  await expect(sound).toBeVisible();
  await expect(sound).toBeChecked();
  const readSoundEnabled = () => page.evaluate(async () => {
    const api = (window as unknown as { aveApi: Pick<AveApi, "getSettings"> }).aveApi;
    return (await api.getSettings()).system.turnCompletionSoundEnabled;
  });
  const master = page.getByRole('switch', { name: t('alerts.osMaster'), exact: true });
  await master.click();
  await expect(master).not.toBeChecked();
  await expect(sound).toBeDisabled();
  await expect(sound).toBeChecked();
  await expect.poll(readSoundEnabled).toBe(true);
  await page.getByTestId('plugin-alerts:@host').screenshot({ path: testInfo.outputPath('completion-sound-master-off.png') });
  await master.click();
  await expect(master).toBeChecked();
  await expect(sound).toBeEnabled();
  await sound.click();
  await expect.poll(readSoundEnabled).toBe(false);
  await closeInlineSettings(app, page);
  await openInlineSettings(app, mainWindow, 'plugin-config');
  await expect(sound).not.toBeChecked();
  await page.getByTestId('plugin-alerts:@host').screenshot({ path: testInfo.outputPath('completion-sound-off.png') });
  await sound.click();
  await expect.poll(readSoundEnabled).toBe(true);
  await expect(sound).toBeChecked();
  await closeInlineSettings(app, page);
});
