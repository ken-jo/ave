import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';
import { TEST_IDS, execModeTestId } from "../../../src/shared/test-ids.js";

// Auto mode owns implicit review; settings expose only the execution policy axis.
test('reviewer prompt stays collapsed inside the auto-verification policy row', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'permissions');

  await expect(settingsPage.getByTestId(execModeTestId("auto"))).toBeVisible();

  await settingsPage.locator('#exec-mode-auto-radio').click();

  const autoRow = settingsPage.getByTestId(execModeTestId("auto"));
  await expect(autoRow.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeVisible();
  await expect(settingsPage.getByText('검증 프롬프트')).toHaveCount(0);
  await autoRow.getByTestId(TEST_IDS.reviewerPromptPanel).locator('summary').click();
  await expect(autoRow.getByTestId('reviewer-system-prompt')).toContainText('UNTRUSTED_INPUT');

  await closeInlineSettings(app, settingsPage);
});

test('switching exec-mode away from auto hides the reviewer prompt collapse again', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'permissions');

  await settingsPage.locator('#exec-mode-auto-radio').click();
  await expect(settingsPage.getByTestId(execModeTestId("auto")).getByTestId(TEST_IDS.reviewerPromptPanel)).toBeVisible();

  await settingsPage.locator('#exec-mode-default-radio').click();
  await expect(settingsPage.getByTestId(TEST_IDS.reviewerPromptPanel)).toHaveCount(0);

  await closeInlineSettings(app, settingsPage);
});

test('owner-away approval wait defaults to unlimited and saves a bounded auto-skip', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'permissions');
  const minutes = settingsPage.getByTestId('owner-away-auto-skip');
  await expect(minutes).toHaveValue('0');
  await minutes.fill('2');
  await minutes.press('Tab');
  await expect.poll(async () => settingsPage.evaluate(async () =>
    (await window.aveApi.getSettings()).permissions?.ownerAwayAutoSkipMinutes,
  )).toBe(2);
  await settingsPage.screenshot({ path: test.info().outputPath('owner-away-settings.png') });
  await closeInlineSettings(app, settingsPage);
  await openInlineSettings(app, mainWindow, 'permissions');
  await expect(settingsPage.getByTestId('owner-away-auto-skip')).toHaveValue('2');
  await closeInlineSettings(app, settingsPage);
});
