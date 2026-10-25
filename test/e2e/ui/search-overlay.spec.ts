import { test, expect } from './fixtures';

test('find shortcut opens unified search, accepts a query, and Escape closes it', async ({ mainWindow }) => {
  const panel = mainWindow.getByTestId('unified-search-panel');
  await expect(panel).toHaveCount(0);

  await mainWindow.keyboard.press(process.platform === 'darwin' ? 'Meta+F' : 'Control+F');
  await expect(panel).toBeVisible();

  const input = panel.getByTestId('unified-search-input');
  await expect(input).toBeFocused();
  await input.fill('hello');
  await expect(input).toHaveValue('hello');

  await input.press('Escape');
  await expect(panel).toHaveCount(0);
});
