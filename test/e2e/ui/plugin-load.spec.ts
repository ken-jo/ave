import { test, expect } from './fixtures.js';
import { TEST_IDS, testIdSelector } from '../../../src/shared/test-ids.js';
import { captureCommandMenus, capturedCommandMenus } from './command-menu.js';
import { VIEW_FIXTURE_VIEW_KEY } from '../../fixtures/e2e-plugins/view-fixture.js';

// Use the repository fixture so plugin view reachability needs no external installation.
const PLUGIN_VIEW_KEYS = [VIEW_FIXTURE_VIEW_KEY] as const;

test('plugins with UI views appear in the command menu', async ({ app, mainWindow }) => {
  test.setTimeout(120_000);
  const trigger = mainWindow.locator(testIdSelector(TEST_IDS.slashPickerTrigger));
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await captureCommandMenus(app);

  // Plugins load after the window; wait for their menu rows.
  const pluginRows = async (): Promise<string[]> => {
    await trigger.click();
    const payloads = await capturedCommandMenus(app);
    const latest = payloads[payloads.length - 1];
    const plugins = latest?.sections.flatMap((section) => section.items).find((row) => row.id === 'category:plugin');
    return (plugins?.submenu ?? []).map((row) => row.id).sort();
  };
  await expect
    .poll(pluginRows, { timeout: 45_000, intervals: [1_000] })
    .toEqual(expect.arrayContaining(PLUGIN_VIEW_KEYS.map((viewKey) => `plugin:${viewKey}`)));
});
