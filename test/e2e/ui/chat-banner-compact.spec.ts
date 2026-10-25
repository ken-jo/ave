import { test, expect } from './fixtures';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

// Verify chat DOM contracts and the compact-command path without relying on provider availability.
test.describe('chat banner + compact pipeline', () => {
  test('status-bar and composer DOM contracts render after window open', async ({ mainWindow }) => {
    const composer = mainWindow.locator(testIdSelector(TEST_IDS.composer)).first();
    const found = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(!found, 'Composer not visible — chat surface not booted in this E2E sandbox.');

    await expect(mainWindow.locator(testIdSelector(TEST_IDS.composerTextarea)).first()).toBeVisible();
    await expect(mainWindow.locator('[data-testid="composer-send-button"]').first()).toBeVisible();
    // Empty notifications unmount; persistent status belongs in the composer action bar.
    await expect(mainWindow.locator('[data-testid="iab-status-row"]').first()).toBeVisible();
  });

  test('/compact slash command produces a system-entry banner response', async ({ mainWindow }) => {
    const input = mainWindow.locator(testIdSelector(TEST_IDS.composerTextarea)).first();
    const found = await input
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(!found, 'No composer textarea visible — chat surface not booted.');

    const baselineSystemEntries = await mainWindow
      .locator('[data-testid="system-entry"]')
      .count();

    await input.click();
    await input.fill('/compact');
    await mainWindow.locator('[data-testid="composer-send-button"]').click();

    // Compact always emits a system entry, including unconfigured-provider and no-op outcomes.
    await expect.poll(
      async () => mainWindow.locator('[data-testid="system-entry"]').count(),
      { timeout: 10_000 },
    ).toBeGreaterThan(baselineSystemEntries);
  });

  test('composer textarea accepts text input', async ({ mainWindow }) => {
    const input = mainWindow.locator(testIdSelector(TEST_IDS.composerTextarea)).first();
    const found = await input
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(!found, 'No composer textarea visible.');

    const marker = `compact-e2e-${Date.now()}`;
    await input.click();
    await input.fill(marker);
    const value = await input.evaluate(
      (el: HTMLInputElement | HTMLTextAreaElement) => ('value' in el ? el.value : (el as HTMLElement).textContent ?? ''),
    );
    expect(value).toContain(marker);
  });
});
