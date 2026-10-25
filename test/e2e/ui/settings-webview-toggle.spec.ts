import { test, expect } from './fixtures';
import path from 'node:path';
import fs from 'node:fs';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

test('webView.preferredFlow toggle persists to settings.json', async ({
  app,
  mainWindow,
  userDataDir,
}) => {
  const settingsPath = path.join(userDataDir, 'ave-settings.json');
  const settingsPage = await openInlineSettings(app, mainWindow, 'web');

  const radiogroup = settingsPage.locator('[data-testid="webview-preferred-flow"]').first();
  await expect(radiogroup).toBeVisible({ timeout: 10_000 });

  const systemBrowserBtn = radiogroup.locator('[data-value="system-browser"]').first();
  await systemBrowserBtn.click();

  await expect
    .poll(
      () => {
        try {
          const raw = fs.readFileSync(settingsPath, 'utf-8');
          return JSON.parse(raw)?.webView?.preferredFlow;
        } catch {
          return undefined;
        }
      },
      { timeout: 5_000, intervals: [200, 400, 800] },
    )
    .toBe('system-browser');

  await expect(systemBrowserBtn).toHaveAttribute('aria-checked', 'true');

  const inAppBtn = radiogroup.locator('[data-value="in-app"]').first();
  await inAppBtn.click();
  await expect
    .poll(
      () => {
        try {
          const raw = fs.readFileSync(settingsPath, 'utf-8');
          return JSON.parse(raw)?.webView?.preferredFlow;
        } catch {
          return undefined;
        }
      },
      { timeout: 5_000, intervals: [200, 400, 800] },
    )
    .toBe('in-app');

  await closeInlineSettings(app, settingsPage);
});
