import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

test('taken chords name their owners and support replace, unbind and reset all', async ({ app, mainWindow, t }) => {
  const page = await openInlineSettings(app, mainWindow, 'shortcuts');
  const panel = page.locator('[data-settings-layout]');
  const readBindings = () => page.evaluate(async () => {
    const api = (window as unknown as { aveApi: { getSettings(): Promise<{ shortcuts: { bindings: Record<string, string> } }> } }).aveApi;
    return (await api.getSettings()).shortcuts.bindings;
  });
  const mac = await page.evaluate(() => navigator.platform.toLowerCase().includes('mac'));
  await panel.getByTestId('shortcuts:record-app.commandPalette').click();
  await page.keyboard.press(mac ? 'Meta+f' : 'Control+f');
  await expect(panel.getByTestId('shortcuts:replacement')).toContainText(t('shortcuts.label.search'));
  expect((await readBindings())['app.commandPalette']).toBeUndefined();
  await panel.getByTestId('shortcuts:cancel-replace').click();
  await expect(panel.getByTestId('shortcuts:replacement')).toHaveCount(0);

  await panel.getByTestId('shortcuts:record-app.commandPalette').click();
  await page.keyboard.press(mac ? 'Meta+f' : 'Control+f');
  await panel.getByTestId('shortcuts:replace').click();
  await expect.poll(readBindings).toMatchObject({ 'app.search': '', 'app.commandPalette': 'CommandOrControl+F' });
  await expect(panel.getByTestId('shortcuts:record-app.search')).toHaveText(t('shortcutsTab.unset'));

  await panel.getByTestId('shortcuts:unbind-app.commandPalette').click();
  await expect.poll(async () => (await readBindings())['app.commandPalette']).toBe('');
  await panel.getByTestId('shortcuts:reset-all').click();
  await expect.poll(readBindings).toEqual({});
  await expect(panel.getByTestId('shortcuts:reset-all')).toBeDisabled();
  await closeInlineSettings(app, page);
});
