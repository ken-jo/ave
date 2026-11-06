import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';
import { relativeLuminance } from '../../contrast-helpers.js';
import { SCHEMES } from '../../../src/ui/renderer/theme/schemes/index.js';

test('appearance mode and schemes update painted UI', async ({ app, mainWindow }) => {
  const page = await openInlineSettings(app, mainWindow, 'appearance');
  await page.getByTestId('appearance-mode-system').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('appearance-mode-dark')).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'dark');
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
  await expect(page.locator('[role="status"][aria-live="polite"][aria-atomic="true"]')).toHaveText(/1/);
  await page.getByRole('listitem').first().getByRole('button').click();
  await expect(section).toBeInViewport();
});

test('all schemes keep status, line, selection and diff colors readable in the browser', async ({ mainWindow }) => {
  const surfaceNames = ['background', 'card', 'popover', 'muted', 'secondary', 'accent', 'message-user-bg', 'input-bar-bg', 'code-bg', 'surface-sunken', 'surface', 'surface-raised', 'surface-overlay'];
  const statusNames = ['destructive', 'warning', 'success', 'info', 'emphasis'];
  for (const scheme of SCHEMES) {
    await mainWindow.evaluate(async ({ id, shell }) => {
      await window.aveApi.updateSettings({ appearance: { mode: shell, [shell === 'dark' ? 'darkScheme' : 'lightScheme']: id } });
    }, scheme);
    await expect(mainWindow.locator('html')).toHaveAttribute('data-scheme', scheme.id);
    const colors = await mainWindow.evaluate((names) => {
      const probe = document.createElement('span');
      document.body.append(probe);
      try {
        return Object.fromEntries(names.map((name) => {
          probe.style.color = `hsl(var(--${name}))`;
          const channels = getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0, 3).map((value) => Number(value) / 255);
          if (!channels || channels.length !== 3) throw new Error(`Unresolved color: ${name}`);
          return [name, channels];
        }));
      } finally { probe.remove(); }
    }, [...surfaceNames, ...statusNames, 'ui-line', 'foreground', 'selection-bg', 'selection-fg']);
    const ratio = (a: number[], b: number[]) => {
      const x = relativeLuminance(a as [number, number, number]);
      const y = relativeLuminance(b as [number, number, number]);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    for (const surface of surfaceNames) {
      for (const status of statusNames) expect(ratio(colors[status]!, colors[surface]!), `${scheme.id}: ${status}/${surface}`).toBeGreaterThanOrEqual(3);
      expect(ratio(colors['ui-line']!, colors[surface]!), `${scheme.id}: line/${surface}`).toBeGreaterThanOrEqual(3);
      for (const status of ['success', 'destructive']) {
        const wash = colors[status]!.map((channel, index) => channel * 0.15 + colors[surface]![index]! * 0.85);
        expect(ratio(colors.foreground!, wash), `${scheme.id}: diff ${status}/${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(ratio(colors['selection-fg']!, colors['selection-bg']!), `${scheme.id}: selection`).toBeGreaterThanOrEqual(4.5);
  }
});
