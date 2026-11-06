import { test, expect } from './fixtures.js';
import { launchElectron, buildIsolatedElectronEnv, MAIN_ENTRY } from './seeded-electron.js';

// Exercise a served app through the shipping sidebar, IPC staging and composer rather than a bridge-only harness.
test('sidebar app messages fill the composer without sending a turn', async ({ app, mainWindow, aveHome, userDataDir, tempHome }) => {
  test.setTimeout(120_000);
  await mainWindow.getByTestId('sidebar-settings').click();
  await mainWindow.getByRole('tab', { name: 'Permissions', exact: true }).click();
  await mainWindow.getByTestId('home-trust-approve-all').click();
  await expect(mainWindow.getByTestId('home-trust-done')).toBeVisible();
  await app.close();

  const restarted = await launchElectron({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: buildIsolatedElectronEnv({ HOME: tempHome, USERPROFILE: tempHome, AVE_HOME: aveHome, AVE_DEV: '1' }),
  });
  try {
    const page = await restarted.firstWindow();
    await page.getByTestId('sidebar-group-plugins').click();
    await page.getByRole('menuitem', { name: 'View Fixture', exact: true }).click();
    await expect.poll(() => restarted.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('ave-mcp-app://'));
      return guest ? guest.executeJavaScript("document.querySelector('iframe')?.contentDocument?.getElementById('status')?.textContent") : null;
    })).toBe('Standard app ready');
    await page.screenshot({ path: '.cache/mcp-apps-convergence/sidebar-e2e.png' });
    await restarted.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('ave-mcp-app://'));
      if (!guest) throw new Error('App guest not found');
      await guest.executeJavaScript("document.querySelector('iframe').contentDocument.getElementById('draft').click()");
    });
    await page.getByTestId('pane-close').click();
    const composer = page.locator('textarea').first();
    await expect(composer).toHaveValue('Review the selected fixture item');
    await expect(page.getByTestId('composer-send-button')).toBeVisible();
    await page.screenshot({ path: '.cache/mcp-apps-convergence/composer-draft-e2e.png' });
  } finally {
    await restarted.close();
  }
});
