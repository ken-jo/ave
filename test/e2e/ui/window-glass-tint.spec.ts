import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMES } from '../../../src/ui/renderer/theme/schemes/index.js';
import { relativeLuminance } from '../../contrast-helpers.js';
import { openInlineSettings } from './inline-settings.js';
import { buildLlmSettings, launchSeededElectron, setWindowSize, teardownSeededElectron } from './seeded-electron.js';

test('glass tint spans bare material to opaque and preserves opaque safety surfaces', async () => {
  const context = await launchSeededElectron({
    seedApiKey: false,
    historyRows: [{ role: 'user', content: 'Verify populated sidebar readability' }],
    sessionTitle: 'Active glass conversation',
    prepareHome: (aveHome) => {
      const id = 'e2000001-bb11-4cc2-8dd3-eeeeeeeeeeee';
      writeFileSync(join(aveHome, 'sessions', `${id}.jsonl`), `${JSON.stringify({ role: 'user', content: 'An inactive conversation' })}\n`);
      writeFileSync(join(aveHome, 'sessions', `${id}.meta.json`), JSON.stringify({ title: 'Inactive glass conversation', unreadSince: new Date().toISOString() }));
      const archivedId = 'e2000002-bb11-4cc2-8dd3-eeeeeeeeeeee';
      writeFileSync(join(aveHome, 'sessions', `${archivedId}.jsonl`), `${JSON.stringify({ role: 'user', content: 'An archived conversation' })}\n`);
      writeFileSync(join(aveHome, 'sessions', `${archivedId}.meta.json`), JSON.stringify({ title: 'Archived glass conversation', archivedAt: new Date().toISOString() }));
    },
    settings: {
      ...buildLlmSettings(undefined, ''),
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
    const glass = await page.evaluate(() => document.documentElement.hasAttribute('data-glass'));
    if (process.platform === 'darwin') expect(glass, 'Native material must be enabled for the glass regression').toBe(true);
    await setWindowSize(app, 1200, 860);
    await openInlineSettings(app, page, 'appearance');
    await expect(page.getByTestId('sidebar-conversation-title-e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee')).toHaveText('Active glass conversation');
    await expect(page.getByTestId('sidebar-conversation-title-e2000001-bb11-4cc2-8dd3-eeeeeeeeeeee')).toHaveText('Inactive glass conversation');
    await page.getByTestId('sidebar-toggle-archived').click();
    await expect(page.getByTestId('sidebar-row-session-e2000002-bb11-4cc2-8dd3-eeeeeeeeeeee')).toHaveAttribute('data-archived', 'true');
    await expect(page.getByTestId('sidebar-conversation-title-e2000002-bb11-4cc2-8dd3-eeeeeeeeeeee')).toHaveText('Archived glass conversation');
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
    if (glass) for (const mode of ['light', 'dark'] as const) {
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
    const contrasts = [];
    for (const scheme of SCHEMES) {
      await page.evaluate(({ id, shell }) => window.aveApi.updateSettings({ appearance: {
        mode: shell, [shell === 'dark' ? 'darkScheme' : 'lightScheme']: id, glassTint: 40,
      } }), scheme);
      await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme.id);
      const foreground = await card.evaluate(element => getComputedStyle(element).color);
      // Scheme changes animate control colours; measure the settled label, not the transition.
      await expect(page.getByTestId('sidebar-search').locator('svg')).toHaveCSS('color', foreground);
      await expect(page.getByTestId('sidebar-collapse-toggle').locator('svg')).toHaveCSS('color', foreground);
      const colors = await page.evaluate(() => {
        const channels = (color: string) => {
          const values = color.match(/[\d.]+/g)?.map(Number);
          if (!values || values.length < 3) throw new Error('Unresolved painted color');
          return values;
        };
        const sidebar = document.querySelector('[data-testid="sidebar-card"]');
        if (!sidebar) throw new Error('Populated sidebar missing');
        const targets = [
          ['body', '[data-testid="sidebar-conversation-title-e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee"]'],
          ['body', '[data-testid="sidebar-conversation-title-e2000001-bb11-4cc2-8dd3-eeeeeeeeeeee"]'],
          ['body', '[data-testid="sidebar-conversation-title-e2000002-bb11-4cc2-8dd3-eeeeeeeeeeee"]'],
          ['body', '[data-testid="sidebar-row-session-e2000001-bb11-4cc2-8dd3-eeeeeeeeeeee"] .text-tiny'],
          ['body', '[data-testid="sidebar-project-header"] .text-muted-foreground'],
          ['header', '[data-testid="sidebar-project-header"] .truncate'],
          ['icon', '[data-testid="sidebar-search"] svg'],
          ['icon', '[data-testid="sidebar-collapse-toggle"] svg'],
          ['icon', '[data-testid="sidebar-conversation-glyph-e2000001-bb11-4cc2-8dd3-eeeeeeeeeeee"]'],
        ] as const;
        return {
          background: channels(getComputedStyle(sidebar).backgroundColor),
          labels: targets.map(([kind, selector]) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`Sidebar label missing: ${selector}`);
            let opacity = 1;
            for (let ancestor: Element | null = element; ancestor && ancestor !== sidebar; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
            return { kind, selector, color: channels(getComputedStyle(element).color), opacity };
          }),
        };
      });
      const alpha = colors.background[3] ?? 1;
      expect(alpha).toBe(glass ? 0.4 : 1);
      const material = scheme.shell === 'dark' ? 140 : 168;
      const background = colors.background.slice(0, 3).map(channel => (channel * alpha + material * (1 - alpha)) / 255) as [number, number, number];
      const backgroundLuminance = relativeLuminance(background);
      for (const label of colors.labels) {
        expect(label.opacity, label.selector).toBe(1);
        expect(label.color[3] ?? 1, label.selector).toBe(1);
        const foreground = relativeLuminance(label.color.slice(0, 3).map(channel => channel / 255) as [number, number, number]);
        const ratio = (Math.max(foreground, backgroundLuminance) + 0.05) / (Math.min(foreground, backgroundLuminance) + 0.05);
        expect(ratio, `${scheme.id}: ${label.selector}`).toBeGreaterThanOrEqual(label.kind === 'body' ? 4.5 : 3);
        contrasts.push({ scheme: scheme.id, shell: scheme.shell, tint: 40, kind: label.kind, ratio });
      }
      await page.getByTestId('sidebar-session-e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee').click();
      const selectedRow = page.getByTestId('sidebar-row-session-e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee');
      await expect(selectedRow).toHaveAttribute('aria-selected', 'true');
      const selectedPaint = () => selectedRow.evaluate(element => {
        const title = element.querySelector('[data-testid^="sidebar-conversation-title-"]');
        if (!title) throw new Error('Selected conversation title missing');
        return {
          background: getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [],
          foreground: getComputedStyle(title).color.match(/[\d.]+/g)?.map(Number) ?? [],
        };
      });
      await expect.poll(async () => (await selectedPaint()).background[3] ?? 1).toBe(1);
      const selected = await selectedPaint();
      expect(selected.background).toHaveLength(3);
      expect(selected.foreground).toHaveLength(3);
      const selectedBackground = relativeLuminance(selected.background.map(channel => channel / 255) as [number, number, number]);
      const selectedForeground = relativeLuminance(selected.foreground.map(channel => channel / 255) as [number, number, number]);
      const selectedRatio = (Math.max(selectedForeground, selectedBackground) + 0.05) / (Math.min(selectedForeground, selectedBackground) + 0.05);
      expect(selectedRatio, `${scheme.id}: selected conversation`).toBeGreaterThanOrEqual(4.5);
      contrasts.push({ scheme: scheme.id, shell: scheme.shell, tint: 40, kind: 'body', ratio: selectedRatio });
      const settings = page.getByTestId('sidebar-settings');
      await expect(settings).not.toHaveAttribute('aria-current', 'page');
      await expect(settings.locator('svg.text-destructive')).toBeVisible();
      await expect(page.getByTestId('sidebar-settings-alert')).toBeVisible();
      await expect(page.getByTestId('sidebar-session-unread-e2000001-bb11-4cc2-8dd3-eeeeeeeeeeee')).toBeVisible();
      const statusColors = await page.evaluate(() => {
        const read = (selector: string, property: 'color' | 'backgroundColor') => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Status marker missing: ${selector}`);
          const color = getComputedStyle(element)[property].match(/[\d.]+/g)?.map(Number);
          if (!color || color.length < 3) throw new Error('Status marker color missing');
          return { selector, color };
        };
        return [
          read('[data-testid="sidebar-settings"] svg.text-destructive', 'color'),
          read('[data-testid="sidebar-settings-alert"]', 'backgroundColor'),
          read('[data-testid="sidebar-session-unread-e2000001-bb11-4cc2-8dd3-eeeeeeeeeeee"]', 'backgroundColor'),
        ];
      });
      for (const status of statusColors.slice(0, 2)) {
        expect(status.color, `${scheme.id}: coloured error state`).not.toEqual(selected.foreground);
      }
      for (const status of statusColors) {
        expect(status.color[3] ?? 1, status.selector).toBe(1);
        const luminance = relativeLuminance(status.color.slice(0, 3).map(channel => channel / 255) as [number, number, number]);
        const ratio = (Math.max(luminance, backgroundLuminance) + 0.05) / (Math.min(luminance, backgroundLuminance) + 0.05);
        expect(ratio, `${scheme.id}: ${status.selector}`).toBeGreaterThanOrEqual(3);
        contrasts.push({ scheme: scheme.id, shell: scheme.shell, tint: 40, kind: 'status', ratio });
      }
      await openInlineSettings(app, page, 'appearance');
    }
    if (glass) {
      await slider.press('Home');
      await transparency('reduce');
      await expect(slider).toBeDisabled();
      await expect.poll(() => paints()).toMatchObject({ token: '0', sidebar: 1, rail: 1, pane: 1, body: 1 });
      evidence.push({ reducedTransparency: true, ...await paints() });
      await transparency('no-preference');
      await expect(slider).toBeEnabled();
      await expect.poll(() => paints()).toMatchObject({ token: '0', sidebar: 0, rail: 0, body: 0 });
    }
    await setWindowSize(app, 360, 768);
    await expect(page.getByTestId('primary-sidebar')).toHaveAttribute('data-sidebar-overlay', 'true');
    await expect(card).toBeVisible();
    await expect.poll(() => paints()).toMatchObject({ sidebar: 1, pane: 1, body: glass ? 0 : 1 });
    evidence.push({ overlay: true, ...await paints() });
    await test.info().attach('glass-tint-paints', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    await test.info().attach('populated-sidebar-contrast', { body: JSON.stringify(contrasts, null, 2), contentType: 'application/json' });
  } finally {
    await teardownSeededElectron(context, { terminate: true });
  }
});
