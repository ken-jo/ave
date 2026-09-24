import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { closeInlineSettings, forceWideMainWindow } from './inline-settings.js';
import type { ElectronApplication, Page } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(HERE, '../../..', 'dist/src/main/main.js');

/**
 * The toolbar update pill (design §15.6): an update installs only through its
 * review — commit range, version and authority change — so the pill opens that
 * review in Settings → Marketplace instead of installing. One update opens its
 * package sheet; several open the Installed view, where each shows its update.
 *
 * Network-free: the main process's update list is injected as the broadcast
 * the marketplace background sends (`marketplace:updates-available`).
 */

type PackageUpdate = {
  key: { sourceId: string; kind: 'plugin' | 'skill' | 'agent' | 'mcp'; name: string };
  displayName: string;
  from: string;
  to: string;
};

const meeting: PackageUpdate = {
  key: { sourceId: 'ave', kind: 'plugin', name: 'meeting' },
  displayName: 'Ave Meeting',
  from: '1.0.0',
  to: '1.1.0',
};
const proofread: PackageUpdate = {
  key: { sourceId: 'ave', kind: 'skill', name: 'proofread' },
  displayName: 'Proofread',
  from: '0.2.0',
  to: '0.3.0',
};

async function injectUpdatesAvailable(app: ElectronApplication, updates: PackageUpdate[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    win?.webContents.send('marketplace:updates-available', payload);
  }, updates);
}

function pill(page: Page) {
  return page.getByTestId('marketplace-update-action');
}

test.skip(!existsSync(MAIN_ENTRY), 'dist/src/main/main.js not built; run bun run build first');

test.describe('update pill → review (design §15.6)', () => {
  test('several updates open the Installed view, and nothing installs from the pill', async ({ app, mainWindow }) => {
    await injectUpdatesAvailable(app, [meeting, proofread]);
    await expect(pill(mainWindow)).toBeVisible({ timeout: 10_000 });
    // The band shows a count; the list is the hover text.
    await expect(pill(mainWindow)).toHaveAttribute('title', /Ave Meeting → 1\.1\.0/);
    await expect(pill(mainWindow)).toHaveAttribute('title', /Proofread → 0\.3\.0/);

    await forceWideMainWindow(app);
    await pill(mainWindow).click();

    await expect(mainWindow.getByTestId('git-marketplace')).toBeVisible({ timeout: 15_000 });
    await expect(mainWindow.getByTestId('git-marketplace:installed')).toHaveAttribute('aria-selected', 'true');
    await expect(mainWindow.getByTestId('git-marketplace:sheet')).toHaveCount(0);
    // A review is not an install: the pill stays until the list changes.
    await expect(pill(mainWindow)).toBeVisible();

    await closeInlineSettings(app, mainWindow);
  });

  test('one update opens its package sheet', async ({ app, mainWindow }) => {
    await injectUpdatesAvailable(app, [meeting]);
    await expect(pill(mainWindow)).toBeVisible({ timeout: 10_000 });

    await forceWideMainWindow(app);
    await pill(mainWindow).click();

    await expect(mainWindow.getByTestId('git-marketplace:sheet')).toBeVisible({ timeout: 15_000 });
    await mainWindow.getByTestId('git-marketplace:sheet:close').click();
    await closeInlineSettings(app, mainWindow);
  });

  test('skip hides the pill and records the skipped versions', async ({ app, mainWindow }) => {
    await injectUpdatesAvailable(app, [meeting, proofread]);
    await expect(pill(mainWindow)).toBeVisible({ timeout: 10_000 });

    await mainWindow.getByTestId('marketplace-update-skip').click();
    await expect(pill(mainWindow)).toHaveCount(0);

    await expect
      .poll(async () =>
        mainWindow.evaluate(async () => {
          const api = (window as unknown as { aveApi: { getSettings: () => Promise<unknown> } }).aveApi;
          const settings = (await api.getSettings()) as { marketplace?: { skippedPluginUpdates?: unknown } };
          return settings.marketplace?.skippedPluginUpdates;
        }),
      )
      .toEqual({ meeting: '1.1.0', 'skill:proofread': '0.3.0' });

    // The same versions arriving again stay hidden; a newer one shows.
    await injectUpdatesAvailable(app, [meeting]);
    await expect(pill(mainWindow)).toHaveCount(0);
    await injectUpdatesAvailable(app, [{ ...meeting, to: '1.2.0' }]);
    await expect(pill(mainWindow)).toBeVisible();
  });
});
