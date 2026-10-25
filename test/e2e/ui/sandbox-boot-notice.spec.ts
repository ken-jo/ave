import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';
import type { SandboxCapabilityInfo } from '../../../src/shared/sandbox-capability-info.js';

/**
 * Sandbox boot-outcome surface — real-Electron plumbing smoke.
 *
 * The RENDER of the degraded notice is already unit-tested six ways in
 * `PermissionsTab.sandbox-boot.test.tsx`, so re-asserting the markup here would
 * buy nothing. What no unit test can reach is the chain the outcome actually
 * travels: boot gate → `setSandboxBootOutcome` → the sealed main-process store →
 * the permissions IPC handler → preload → the settings render. Every one of
 * those links is mocked away in the unit suites; a `boot: undefined` reaching
 * the renderer would leave all six of them green.
 *
 * So this spec asserts two things about the LIVE app:
 *   1. `boot` arrives non-null with a well-formed outcome — the gate ran and its
 *      decision survived the trip to the renderer.
 *   2. The notice's presence agrees with that decision. This is an INVARIANT,
 *      not a fixed expectation: which branch the gate takes is a property of the
 *      host (platform default, whether ASRT is installed), and a spec that
 *      demanded one branch would be asserting the test machine, not the code.
 */

const GATE_ACTIONS = ['skip', 'activate', 'degrade', 'abort'] as const;

test('the boot gate outcome reaches settings, and the notice matches it', async ({ app, mainWindow }) => {
  // The seeded plugin must survive default-on confinement; an absent plugin
  // must not be hidden behind otherwise healthy host-status rendering.
  expect((await mainWindow.evaluate(() => window.aveApi.getRuntimeCounts())).plugins).toBe(1);
  const settingsPage = await openInlineSettings(app, mainWindow, 'permissions');

  const capability = (await settingsPage.evaluate(
    () => window.ave.permission.sandboxCapability(),
  )) as SandboxCapabilityInfo;

  // The gate always runs at boot, so absence here means a broken link in the
  // chain — not "the sandbox is off". `null` is reserved for hosts that never
  // ran sandbox init, which the real main process always does.
  expect(capability.boot).toBeTruthy();
  const boot = capability.boot!;
  expect(GATE_ACTIONS).toContain(boot.action);
  expect(boot.reason.length).toBeGreaterThan(0);
  expect(['explicit-env', 'default-settings', 'off']).toContain(boot.onSignal);
  expect(Array.isArray(boot.causes)).toBe(true);
  // Raw dependency messages can carry local paths; they stay in the main log.
  expect(boot).not.toHaveProperty('dependencyErrors');
  // `abort` throws out of boot, so a running app can never report it.
  expect(boot.action).not.toBe('abort');

  const notice = settingsPage.getByTestId('os-sandbox-boot-degraded');
  if (boot.action === 'degrade') {
    await expect(notice).toBeVisible();
    // Setup failures show localized repair guidance; the raw dependency
    // output never reaches the renderer, only its classified causes.
    if (boot.causes.length > 0) {
      await expect(settingsPage.getByTestId('os-sandbox-boot-degraded-detail')).toBeVisible();
    }
  } else {
    // The startup-failure notice is separate from the persistent shell status.
    await expect(notice).toHaveCount(0);
  }

  expect(capability.shellExecutionPlan).toBeTruthy();
  const sandboxed = capability.shellExecutionPlan!.sandboxed;
  const settingsStatus = settingsPage.locator('[data-settings-section="permissions-os-sandbox"] [data-testid="sandbox-off-status"]');
  if (sandboxed) {
    await expect(settingsStatus).toHaveCount(0);
  } else {
    await expect(settingsStatus).toBeVisible();
    await expect(settingsStatus.locator('button')).toHaveCount(0);
  }

  await (sandboxed ? settingsPage.getByTestId('os-sandbox-potential-reason') : settingsStatus).scrollIntoViewIfNeeded();
  await settingsPage.screenshot({ path: test.info().outputPath('sandbox-settings.png') });

  await closeInlineSettings(app, settingsPage);
  const chatStatus = mainWindow.locator('[data-testid="iab-status-row"] [data-testid="sandbox-off-status"]').first();
  if (sandboxed) {
    await expect(chatStatus).toHaveCount(0);
  } else {
    await expect(chatStatus).toBeVisible();
    await expect(chatStatus.locator('button')).toHaveCount(0);
  }
  await mainWindow.screenshot({ path: test.info().outputPath('sandbox-chat-status.png') });
});


test.describe('persistent sandbox-off status', () => {
  test.use({ seedOsToolSandbox: false, launchEnv: { AVE_SANDBOX_ENABLED: "" } });

  test('keeps the saved off reason visible in chat and Settings', async ({ app, mainWindow, t }) => {
    const capability = await mainWindow.evaluate(() => window.ave.permission.sandboxCapability());
    expect(capability.shellExecutionPlan?.sandboxed).toBe(false);
    expect(capability.shellExecutionPlan?.fallbackReason).toBe('disabled-by-setting');
    const label = t('sandboxStatus.off', { reason: t('sandboxStatus.disabled') });

    const chatStatus = mainWindow.locator('[data-testid="iab-status-row"] [data-testid="sandbox-off-status"]').first();
    await expect(chatStatus).toHaveText(label);
    await expect(chatStatus).toBeVisible();
    await expect(chatStatus.locator('button')).toHaveCount(0);
    await mainWindow.screenshot({ path: test.info().outputPath('sandbox-off-chat.png') });

    const settingsPage = await openInlineSettings(app, mainWindow, 'permissions');
    const settingsStatus = settingsPage.locator('[data-settings-section="permissions-os-sandbox"] [data-testid="sandbox-off-status"]');
    await expect(settingsStatus).toHaveText(label);
    await expect(settingsStatus.locator('button')).toHaveCount(0);
    await settingsStatus.scrollIntoViewIfNeeded();
    await settingsPage.screenshot({ path: test.info().outputPath('sandbox-off-settings.png') });
    await closeInlineSettings(app, settingsPage);
    await expect(chatStatus).toBeVisible();
  });
});
