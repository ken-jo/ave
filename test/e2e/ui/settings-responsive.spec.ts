import { test, expect } from './fixtures';
import { openInlineSettings } from './inline-settings.js';
import { setWindowSize } from './seeded-electron.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_IDS } from "../../../src/shared/test-ids.js";

// Settings layout follows panel width: wide master-detail or a narrow category stack.

const OUT = process.env.AVE_SHOT_DIR ?? join(process.cwd(), 'test-results', 'settings-shots');

async function expectSettingsBottomClearance(
  mainWindow: import('@playwright/test').Page,
) {
  const measure = async () => mainWindow.locator('.ave-settings-scroll').evaluate(async (scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const activePanel = scroller.querySelector<HTMLElement>(
      '[role="tabpanel"][data-state="active"]',
    );
    const content = activePanel?.lastElementChild as HTMLElement | null;
    if (!activePanel || !content) return { gap: -1, display: '' };

    return {
      gap: Math.round(
        scroller.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom,
      ),
      display: getComputedStyle(activePanel).display,
    };
  });

  await expect.poll(async () => (await measure()).gap, { timeout: 5_000 }).toBeGreaterThanOrEqual(44);
  expect((await measure()).display).toBe('flex');
}

test('Settings inline shell is responsive (wide master-detail ↔ narrow 2-depth)', async ({ app, mainWindow }) => {
  mkdirSync(OUT, { recursive: true });

  await openInlineSettings(app, mainWindow, 'llm');

  await setWindowSize(app, 1180, 860);
  const root = mainWindow.locator('[data-settings-layout]');
  await expect.poll(async () => root.getAttribute('data-settings-layout'), { timeout: 5_000 }).toBe('wide');
  await expect(mainWindow.getByTestId('settings-mobile-list')).toHaveCount(0);
  await expectSettingsBottomClearance(mainWindow);

  await root.getByRole('tab', { name: /Plugin Settings|플러그인 설정/ }).click();
  await expectSettingsBottomClearance(mainWindow);
  await root.getByRole('tab', { name: /Model|모델/ }).first().click();

  writeFileSync(join(OUT, '1-desktop-master-detail.png'), await mainWindow.screenshot());

  await setWindowSize(app, 400, 820);
  await expect.poll(async () => root.getAttribute('data-settings-layout'), { timeout: 5_000 }).toBe('narrow');
  // Narrowing preserves active detail; return to the category list before asserting it.
  await expect(mainWindow.getByTestId(TEST_IDS.settingsMobileBack)).toBeVisible();
  await mainWindow.getByTestId(TEST_IDS.settingsMobileBack).click();
  await expect(mainWindow.getByTestId('settings-mobile-list')).toBeVisible();
  writeFileSync(join(OUT, '2-mobile-list.png'), await mainWindow.screenshot());

  await mainWindow.getByRole('tab', { name: /Model|모델/ }).first().click();
  await expect(mainWindow.getByTestId(TEST_IDS.settingsMobileBack)).toBeVisible();
  await expectSettingsBottomClearance(mainWindow);
  writeFileSync(join(OUT, '3-mobile-detail.png'), await mainWindow.screenshot());

  await mainWindow.getByTestId(TEST_IDS.settingsMobileBack).click();
  await expect(mainWindow.getByTestId('settings-mobile-list')).toBeVisible();
});
