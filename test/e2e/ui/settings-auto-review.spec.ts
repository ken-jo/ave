import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';
import { execModeTestId } from '../../../src/shared/test-ids.js';

test('mode selections reconcile automatic review in main', async ({ app, mainWindow, t }, testInfo) => {
  const page = await openInlineSettings(app, mainWindow, 'permissions');
  const readState = () => page.evaluate(async () => {
    const mode = await window.ave.permission.getMode();
    const reviewer = await window.ave.permission.reviewerDispatch('show');
    return { mode: mode.mode, reviewer: reviewer.ok ? reviewer.settings.mode : 'failed' };
  });
  const auto = page.getByTestId(execModeTestId('auto'));
  await expect(auto).toContainText(t('constants.execModeAutoLabel'));
  await page.locator('#exec-mode-auto-radio').click();
  await expect.poll(readState).toEqual({ mode: 'auto', reviewer: 'llm' });
  await page.locator('#exec-mode-strict-radio').click();
  await expect.poll(readState).toEqual({ mode: 'strict', reviewer: 'disabled' });
  await page.locator('#exec-mode-auto-radio').click();
  await expect.poll(readState).toEqual({ mode: 'auto', reviewer: 'llm' });
  await expect(auto.locator('[role="radio"]')).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('auto-review-enabled.png') });
});
