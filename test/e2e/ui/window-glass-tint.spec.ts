import { test, expect } from '@playwright/test';
import { openInlineSettings } from './inline-settings.js';
import { buildLlmSettings, launchSeededElectron, setWindowSize, teardownSeededElectron } from './seeded-electron.js';

test('glass tint spans bare material to opaque and preserves opaque safety surfaces', async () => {
  const context = await launchSeededElectron({
    historyRows: [],
    settings: {
      ...buildLlmSettings(),
      system: { sidebarState: 'expanded' },
    },
  });
  try {
    const { page, app } = context;
    const cdp = await page.context().newCDPSession(page);
    const transparency = async (value: 'reduce' | 'no-preference') => {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value }],
      });
    };
    await transparency('no-preference');
    // Exercise the glass stylesheet contract even on test hosts without a native material.
    // These markers represent the preload state of a window created with the material.
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-glass', '');
      document.documentElement.setAttribute('data-glass-capable', '');
    });
    await setWindowSize(app, 1200, 860);
    await openInlineSettings(app, page, 'appearance');
    const slider = page.locator('#appearance-glass-tint-input');
    const card = page.getByTestId('sidebar-card');
    const paints = () => page.evaluate(() => {
      const alpha = (element: Element) => {
        const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g);
        if (!channels || channels.length < 3) throw new Error('Unresolved background color');
        return channels.length === 4 ? Number(channels[3]) : 1;
      };
      const sidebar = document.querySelector('[data-testid="sidebar-card"]');
      const rail = document.querySelector('[data-testid="sidebar-rail"]');
      const pane = document.querySelector('[data-testid="pane"]');
      if (!sidebar || !rail || !pane) throw new Error('Painted surface missing');
      return {
        token: getComputedStyle(document.documentElement).getPropertyValue('--glass-tint-alpha').trim(),
        sidebar: alpha(sidebar), rail: alpha(rail), pane: alpha(pane), body: alpha(document.body),
      };
    });
    const evidence = [];
    for (const mode of ['light', 'dark'] as const) {
      await page.getByTestId(`appearance-mode-${mode}`).click();
      await expect(slider).toHaveValue('40');
      for (const [key, tint] of [['Home', 0], ['End', 100]] as const) {
        await slider.press(key);
        await expect(slider).toHaveValue(String(tint));
        await expect.poll(() => paints()).toMatchObject({ token: String(tint / 100), sidebar: tint / 100, rail: tint / 100, pane: 1, body: 0 });
        await expect.poll(() => page.evaluate(async () => (await window.aveApi.getSettings()).appearance.glassTint)).toBe(tint);
        evidence.push({ mode, tint, ...await paints() });
      }
      await page.evaluate(() => window.aveApi.updateSettings({ appearance: { glassTint: 40 } }));
      await expect(slider).toHaveValue('40');
      await expect.poll(() => paints()).toMatchObject({ token: '0.4', sidebar: 0.4, rail: 0.4, pane: 1, body: 0 });
      evidence.push({ mode, tint: 40, ...await paints() });
    }
    await slider.press('Home');
    await transparency('reduce');
    await expect(slider).toBeDisabled();
    await expect.poll(() => paints()).toMatchObject({ token: '0', sidebar: 1, rail: 1, pane: 1, body: 1 });
    evidence.push({ reducedTransparency: true, ...await paints() });
    await transparency('no-preference');
    await expect(slider).toBeEnabled();
    await expect.poll(() => paints()).toMatchObject({ token: '0', sidebar: 0, rail: 0, body: 0 });
    await setWindowSize(app, 360, 768);
    await expect(page.getByTestId('primary-sidebar')).toHaveAttribute('data-sidebar-overlay', 'true');
    await expect(card).toBeVisible();
    await expect.poll(() => paints()).toMatchObject({ token: '0', sidebar: 1, pane: 1, body: 0 });
    evidence.push({ overlay: true, ...await paints() });
    await test.info().attach('glass-tint-paints', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } finally {
    await teardownSeededElectron(context, { terminate: true });
  }
});
