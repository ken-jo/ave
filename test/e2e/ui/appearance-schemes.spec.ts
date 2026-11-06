import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';
import { SCHEMES } from '../../../src/ui/renderer/theme/schemes/index.js';

test('appearance mode and schemes update painted UI', async ({ app, mainWindow }) => {
  const page = await openInlineSettings(app, mainWindow, 'appearance');
  for (const mode of ['dark', 'light'] as const) {
    await page.getByTestId(`appearance-mode-${mode}`).click();
    await expect(page.locator('html')).toHaveAttribute('data-shell', mode);
    for (const scheme of SCHEMES.filter((candidate) => candidate.shell === mode)) {
      await page.locator(`[data-scheme-id="${scheme.id}"]`).click();
      await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme.id);
      const colors = await page.evaluate(() => {
        const style = getComputedStyle(document.body);
        return { background: style.backgroundColor, foreground: style.color };
      });
      expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(colors.foreground).not.toBe(colors.background);
    }
  }
  await page.getByTestId('appearance-mode-system').click();
  await expect(page.locator('[data-scheme-id]')).toHaveCount(12);
});

test('terminal font preview changes immediately and settings search jumps to its section', async ({ app, mainWindow }) => {
  const page = await openInlineSettings(app, mainWindow, 'appearance');
  const section = page.locator('[data-settings-section="appearance-terminal"]');
  const size = section.locator('input[inputmode="numeric"]').first();
  await size.fill('18');
  await expect(page.getByTestId('terminal-font-preview')).toHaveCSS('font-size', '18px');
  const search = page.locator('input[type="search"]');
  await search.fill('terminal');
  await page.getByRole('listitem').first().click();
  await expect(section).toBeInViewport();
});
