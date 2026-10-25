import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';

// Settings render in the main window; wide-layout helpers avoid narrow navigation ambiguity.

const WIDE_CONTENT_WIDTH = 1200;
const WIDE_CONTENT_HEIGHT = 860;
type MainWindowBounds = { x: number; y: number; width: number; height: number };
const originalMainWindowBounds = new WeakMap<ElectronApplication, MainWindowBounds>();

// Restore saved window bounds when closing settings.
export async function forceWideMainWindow(app: ElectronApplication): Promise<void> {
  const originalBounds = await app.evaluate(({ BrowserWindow }, size) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible());
    const target = wins.sort(
      (a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1],
    )[0];
    if (!target) return null;
    const bounds = target.getBounds();
    target.setContentSize(size.w, size.h);
    return bounds;
  }, { w: WIDE_CONTENT_WIDTH, h: WIDE_CONTENT_HEIGHT });
  if (originalBounds && !originalMainWindowBounds.has(app)) {
    originalMainWindowBounds.set(app, originalBounds);
  }
}

async function restoreMainWindowBounds(app: ElectronApplication): Promise<void> {
  const bounds = originalMainWindowBounds.get(app);
  if (!bounds) return;
  await app.evaluate(({ BrowserWindow }, original) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible());
    const target = wins.sort(
      (a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1],
    )[0];
    target?.setBounds(original);
  }, bounds);
  originalMainWindowBounds.delete(app);
}

// Activate settings through trusted main-to-renderer delivery; no renderer window-opening IPC exists.
export async function openInlineSettings(
  app: ElectronApplication,
  mainWindow: Page,
  initialTab = 'llm',
): Promise<Page> {
  await forceWideMainWindow(app);
  await app.evaluate(({ BrowserWindow }, tab) => {
    const wins = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win.isVisible());
    const target = wins.sort(
      (a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1],
    )[0];
    if (!target) throw new Error('main window is unavailable');
    target.webContents.send('ave:view:activate', { viewKey: 'settings', settingsTab: tab });
  }, initialTab);

  // Use the layout marker for locale-independent settings readiness.
  await expect(mainWindow.locator('[data-settings-layout]')).toBeVisible({ timeout: 15_000 });
  // Wait for the width observer to commit wide layout before selecting tab content.
  await expect
    .poll(
      async () =>
        mainWindow.locator('[data-settings-layout]').getAttribute('data-settings-layout'),
      { timeout: 5_000 },
    )
    .toBe('wide');
  return mainWindow;
}

// Settings tabs create history entries; replay back within the history bound until settings unmount.
export async function closeInlineSettings(
  app: ElectronApplication,
  settingsPage: Page,
): Promise<void> {
  const layout = settingsPage.locator('[data-settings-layout]');
  const currentPath = settingsPage.locator('[data-testid^="view-path-current-"]').first();

  try {
    for (let step = 0; step < 52; step += 1) {
      if (await layout.count() === 0) return;

      const before = await currentPath.getAttribute('data-testid') ?? `settings-step-${step}`;
      const back = settingsPage.getByTestId('view-path-back');
      await expect(back).toBeEnabled();
      await back.click();
      await expect.poll(async () => {
        if (await layout.count() === 0) return '__settings_closed__';
        return await currentPath.getAttribute('data-testid') ?? '__settings_open__';
      }, { timeout: 10_000 }).not.toBe(before);
    }

    throw new Error('settings history did not reach a non-settings view within 52 back steps');
  } finally {
    await restoreMainWindowBounds(app);
  }
}
