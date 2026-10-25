import { test, expect } from './fixtures';
import { BUNDLE_IDS } from '../../../src/shared/theme-bundles.js';

// Verify computed backgrounds and geometry for every shipped theme, beyond attribute round-trips.

function parseRgb(rgb: string): [number, number, number] | null {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance(rgb: [number, number, number]): number {
  return rgb[0] + rgb[1] + rgb[2];
}

test('every theme bundle resolves to a paintable surface', async ({ mainWindow }) => {
  const bgs = new Map<string, string>();
  for (const id of BUNDLE_IDS) {
    const result = await mainWindow.evaluate((bundleId) => {
      document.documentElement.setAttribute('data-theme-bundle', bundleId);
      const cs = getComputedStyle(document.body);
      return {
        attr: document.documentElement.getAttribute('data-theme-bundle'),
        bg: cs.backgroundColor,
        fg: cs.color,
      };
    }, id);

    expect(result.attr, `data-theme-bundle should round-trip for ${id}`).toBe(id);
    expect(result.bg, `${id} bg must be set (non-empty)`).not.toBe('');
    expect(result.bg, `${id} bg must be a real color (not transparent)`).not.toMatch(
      /rgba?\(0,\s*0,\s*0,\s*0\)/,
    );

    const bg = parseRgb(result.bg);
    const fg = parseRgb(result.fg);
    expect(bg, `${id} bg should parse as rgb()`).not.toBeNull();
    expect(fg, `${id} fg should parse as rgb()`).not.toBeNull();
    const contrast = Math.abs(luminance(bg!) - luminance(fg!));
    expect(
      contrast,
      `${id} body fg vs bg must have ≥50 summed-RGB delta (got ${contrast})`,
    ).toBeGreaterThanOrEqual(50);

    bgs.set(id, result.bg);
  }

  // Different bundles must produce different computed backgrounds.
  expect(bgs.get('gallery'), 'gallery should paint a bg different from moonstone').not.toBe(bgs.get('moonstone'));
});
