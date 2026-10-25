import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';
import type { ElectronApplication, Page } from '@playwright/test';
import { TEST_IDS } from "../../../src/shared/test-ids.js";

// Subscription catalogs share the model chooser and must fit its trigger and available viewport.

const MODEL_COUNT = 40;

async function stubSubscriptionRuntime(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, count) => {
    const capabilities = {
      chat: true, images: false, imageAttachmentLimits: null, files: true, tools: true,
      projectAccess: true, plugins: true, mcp: true, generateText: true, compaction: true,
      routine: true, subagent: true,
    };
    const status = (provider: string) => ({
      provider, runtime: 'ready', connection: 'connected', planType: 'pro',
      pendingLogin: null, pendingDeviceCode: null, canOpenVerificationUrl: false,
      version: '1.0.0', capabilities,
    });
    ipcMain.removeHandler('ave:settings:subscription:status');
    ipcMain.handle('ave:settings:subscription:status', async (_e, provider: unknown) =>
      ({ ok: true, status: status(String(provider)) }));
    ipcMain.removeHandler('ave:settings:subscription:list-models');
    ipcMain.handle('ave:settings:subscription:list-models', async (_e, provider: unknown) => ({
      ok: true,
      status: status(String(provider)),
      models: Array.from({ length: count }, (_, i) => ({
        id: `upstream-owner-${i % 8}/model-family-${i}-long-context-instruct-preview`,
        displayName: `upstream-owner-${i % 8}/model-family-${i}-long-context-instruct-preview`,
        isDefault: i === 0,
      })),
    }));
  }, MODEL_COUNT);
}

async function setWindowSize(app: ElectronApplication, w: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed() && x.isVisible());
    const target = wins.sort(
      (a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1],
    )[0];
    if (target) target.setContentSize(size.w, 860);
  }, { w });
}

async function gotoModelTab(w: Page): Promise<void> {
  const layout = await w.locator('[data-settings-layout]').getAttribute('data-settings-layout');
  if (layout === 'narrow') {
    const back = w.getByTestId(TEST_IDS.settingsMobileBack);
    if (await back.isVisible()) {
      await back.click();
      await w.waitForTimeout(300);
    }
    await w.getByRole('tab', { name: /Model|모델/ }).first().click();
    await expect(w.getByTestId(TEST_IDS.settingsMobileBack)).toBeVisible();
  }
}

const MEASURE = () => {
  const node = document.querySelector('[data-slot="select-content"]') as HTMLElement;
  const trigger = document.querySelector(
    '[data-state="open"][data-slot="select-trigger"]',
  ) as HTMLElement;
  const pane = document.querySelector('.ave-settings-scroll') as HTMLElement | null;
  const nb = node.getBoundingClientRect();
  const tb = trigger.getBoundingClientRect();
  const pb = pane?.getBoundingClientRect() ?? null;
  const items = [...node.querySelectorAll('[data-slot="select-item"]')].map((el) => {
    const it = el as HTMLElement;
    const label = it.querySelector('span.truncate') as HTMLElement | null;
    return {
      text: (it.textContent ?? '').slice(0, 50),
      right: it.getBoundingClientRect().right,
      overflowPx: Math.round(it.scrollWidth - it.clientWidth),
      labelClippedPx: label ? Math.round(label.scrollWidth - label.clientWidth) : 0,
    };
  });
  return {
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    popup: {
      left: Math.round(nb.left), right: Math.round(nb.right),
      width: Math.round(nb.width), height: Math.round(nb.height),
    },
    trigger: { left: Math.round(tb.left), right: Math.round(tb.right), width: Math.round(tb.width) },
    pane: pb ? { left: Math.round(pb.left), right: Math.round(pb.right) } : null,
    popupLeftMinusPaneLeft: pb ? Math.round(nb.left - pb.left) : null,
    popupRightMinusPaneRight: pb ? Math.round(nb.right - pb.right) : null,
    popupLeftMinusTriggerLeft: Math.round(nb.left - tb.left),
    popupRightMinusWindow: Math.round(nb.right - window.innerWidth),
    itemCount: items.length,
    rowsOverflowingTheirBox: items.filter((i) => i.overflowPx > 1).length,
    rowsWithClippedId: items.filter((i) => i.labelClippedPx > 1).length,
    worstClippedPx: items.reduce((max, i) => Math.max(max, i.labelClippedPx), 0),
  };
};

async function openSubscriptionModelPopup(
  app: ElectronApplication,
  mainWindow: Page,
  width: number,
): Promise<Page> {
  await stubSubscriptionRuntime(app);
  const w = await openInlineSettings(app, mainWindow, 'llm');
  await setWindowSize(app, width);
  await w.waitForTimeout(700);
  await gotoModelTab(w);

  // Connected subscriptions fetch models automatically; the chooser has no separate load action.
  const select = w.getByTestId(TEST_IDS.llmModelSelect);
  await expect(select).toBeVisible({ timeout: 10_000 });
  await select.scrollIntoViewIfNeeded();
  await select.click();
  await expect(w.locator('[data-slot="select-content"]')).toBeVisible({ timeout: 10_000 });
  await expect(
    w.locator('[data-slot="select-content"] [data-slot="select-item"]').first(),
  ).toBeVisible();
  await w.waitForTimeout(300);
  return w;
}

for (const width of [1200, 620]) {
  test(`subscription model popup stays inside the settings pane @${width}`, async ({
    app,
    mainWindow,
  }) => {
    const w = await openSubscriptionModelPopup(app, mainWindow, width);
    const m = await w.evaluate(MEASURE);
    // eslint-disable-next-line no-console
    console.log(`[subscription-popup ${width}]`, JSON.stringify(m, null, 2));

    // The subscription catalog is a floor because the chooser also includes other providers.
    expect(m.itemCount).toBeGreaterThanOrEqual(MODEL_COUNT);
    expect(m.pane).not.toBeNull();

    // The chooser must align with its trigger and stay inside the settings pane.
    expect(m.popupLeftMinusPaneLeft).toBeGreaterThanOrEqual(0);
    expect(m.popupRightMinusPaneRight).toBeLessThanOrEqual(0);
    expect(m.popupLeftMinusTriggerLeft).toBeGreaterThanOrEqual(-1);

    expect(m.popupRightMinusWindow).toBeLessThanOrEqual(0);
    expect(m.docScrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);

    // Horizontal clipping makes over-wide rows inaccessible.
    expect(m.rowsOverflowingTheirBox).toBe(0);

  });
}
