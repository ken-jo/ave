import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

test('the global recorder preserves focus traversal and refuses unsafe chords', async ({ app, mainWindow, t }) => {
  const page = await openInlineSettings(app, mainWindow, 'startup');
  const capture = page.getByTestId('startup-accelerator-capture');
  const record = page.getByTestId('startup-accelerator-record');
  const readBinding = () => page.evaluate(async () => {
    const api = (window as unknown as { aveApi: { getSettings(): Promise<{ shortcuts: { toggleWindow: string | null } }> } }).aveApi;
    return (await api.getSettings()).shortcuts.toggleWindow;
  });
  const before = await readBinding();

  await record.click();
  await expect(capture).toBeFocused();
  await capture.press('Tab');
  await expect(record).toBeFocused();
  expect(await readBinding()).toBe(before);

  await record.click();
  await capture.press('Shift+Tab');
  await expect(capture).not.toBeFocused();
  expect(await readBinding()).toBe(before);

  await record.click();
  await capture.press('j');
  await expect(page.getByRole('alert').filter({ hasText: t('shortcutsTab.notice.needsModifier') })).toHaveText(t('shortcutsTab.notice.needsModifier'));
  await expect(capture).toHaveText(t('startupTab.shortcutCapturing'));
  expect(await readBinding()).toBe(before);

  const mac = await page.evaluate(() => navigator.platform.toLowerCase().includes('mac'));
  await capture.press(mac ? 'Meta+Space' : 'Alt+Tab');
  await expect(page.getByRole('alert').filter({ hasText: t('shortcutsTab.notice.osReserved') })).toHaveText(t('shortcutsTab.notice.osReserved'));
  expect(await readBinding()).toBe(before);
  await capture.press('Escape');
  await expect(capture).not.toHaveText(t('startupTab.shortcutCapturing'));
  await closeInlineSettings(app, page);
});
