import { test, expect } from './fixtures';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";
import { sendRendererStreamEvent as sendStreamEvent } from './seeded-electron.js';

// Inject stream events to exercise recovery banners without a live model connection.

test.describe('compact recovery banners (#916 + #917)', () => {
  test('B1 (#916): force-recover compact_started shows OFF-override warning in StatusBar', async ({
    app,
    mainWindow,
    t,
  }) => {
    const composer = mainWindow.locator(testIdSelector(TEST_IDS.composer)).first();
    const booted = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!booted, 'Chat surface not booted.');

    await sendStreamEvent(app, {
      type: 'compact_started',
      triggerSource: 'force-recover',
      estimatedBefore: 90_000,
      preflight: 88_000,
    });
    const statusBar = mainWindow.locator('[data-testid="status-bar"]');
    await statusBar.waitFor({ state: 'visible', timeout: 8_000 });

    await expect
      .poll(
        async () => (await statusBar.textContent()) ?? '',
        { timeout: 8_000 },
      )
      .toContain(t('app.compactForceRecoverValue'));

    await sendStreamEvent(app, {
      type: 'compact_notice',
      removedMessages: 5,
      freedTokens: 4_000,
    });
  });

  test('B2 (#916): normal compact_started shows standard 자동 압축 중 label (not OFF-override)', async ({
    app,
    mainWindow,
    t,
  }) => {
    const composer = mainWindow.locator(testIdSelector(TEST_IDS.composer)).first();
    const booted = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!booted, 'Chat surface not booted.');

    await sendStreamEvent(app, {
      type: 'compact_started',
      triggerSource: 'estimate',
      estimatedBefore: 90_000,
      preflight: 88_000,
    });
    const statusBar = mainWindow.locator('[data-testid="status-bar"]');
    await statusBar.waitFor({ state: 'visible', timeout: 8_000 });

    await expect
      .poll(
        async () => (await statusBar.textContent()) ?? '',
        { timeout: 8_000 },
      )
      .toContain(t('app.compactInProgressValue'));

    const text = (await statusBar.textContent()) ?? '';
    expect(text).not.toContain(t('app.compactForceRecoverValue'));

    await sendStreamEvent(app, {
      type: 'compact_notice',
      removedMessages: 5,
      freedTokens: 4_000,
    });
  });

  test('B3 (#917): recovery_exhausted shows persistent 압축으로 복구 불가 error in StatusBar', async ({
    app,
    mainWindow,
    t,
  }) => {
    const composer = mainWindow.locator(testIdSelector(TEST_IDS.composer)).first();
    const booted = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!booted, 'Chat surface not booted.');

    await sendStreamEvent(app, { type: 'recovery_exhausted' });
    const statusBar = mainWindow.locator('[data-testid="status-bar"]');
    await statusBar.waitFor({ state: 'visible', timeout: 8_000 });

    await expect
      .poll(
        async () => (await statusBar.textContent()) ?? '',
        { timeout: 8_000 },
      )
      .toContain(t('app.compactExhaustedValue'));
  });

  test('B4 (#917): recovery_exhausted banner persists; standard compact_started does not remove it', async ({
    app,
    mainWindow,
    t,
  }) => {
    const composer = mainWindow.locator(testIdSelector(TEST_IDS.composer)).first();
    const booted = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!booted, 'Chat surface not booted.');

    await sendStreamEvent(app, { type: 'recovery_exhausted' });
    const statusBar = mainWindow.locator('[data-testid="status-bar"]');
    await statusBar.waitFor({ state: 'visible', timeout: 8_000 });

    await expect
      .poll(
        async () => (await statusBar.textContent()) ?? '',
        { timeout: 8_000 },
      )
      .toContain(t('app.compactExhaustedValue'));

    await sendStreamEvent(app, {
      type: 'compact_started',
      triggerSource: 'estimate',
      estimatedBefore: 90_000,
      preflight: 88_000,
    });
    await sendStreamEvent(app, {
      type: 'compact_notice',
      removedMessages: 3,
      freedTokens: 2_000,
    });

    const textAfterCompact = (await statusBar.textContent()) ?? '';
    expect(textAfterCompact).toContain(t('app.compactExhaustedValue'));
  });
});
