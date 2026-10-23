import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

test('judge stages preserve mode and order when settings reopen', async ({ app, mainWindow, t }, testInfo) => {
  let settingsPage = await openInlineSettings(app, mainWindow, 'permissions');
  const section = settingsPage.locator('[data-settings-section="permissions-judge"]');
  await expect(section.locator('#permission-judge-mode')).toHaveValue('off');
  await section.locator('#permission-judge-mode').selectOption('shadow');
  await expect(section.locator('#permission-judge-stage-0-model')).toContainText(t('permissionJudge.currentReviewer'));
  await section.locator('#permission-judge-stage-0-id').fill('local-review');
  await section.locator('#permission-judge-stage-0-provider').selectOption('url');
  await section.locator('#permission-judge-stage-0-url').fill('https://judge.example.test/review');
  await section.locator('#permission-judge-stage-0-threshold').fill('0.75');
  await section.getByRole('button', { name: t('permissionJudge.addStage') }).click();
  await section.locator('#permission-judge-stage-1-id').fill('current-reviewer');
  await expect(section.locator('#permission-judge-stage-1-model')).toContainText(t('permissionJudge.currentReviewer'));
  await section.getByRole('button', { name: t('permissionJudge.moveUpStage', { number: 2 }) }).click();
  await section.getByRole('button', { name: t('permissionJudge.save') }).click();
  await expect(section.getByText(t('permissionJudge.saved'), { exact: true })).toBeVisible();
  await expect(section.getByRole('alert')).toHaveCount(0);
  await closeInlineSettings(app, settingsPage);

  settingsPage = await openInlineSettings(app, mainWindow, 'permissions');
  const reopened = settingsPage.locator('[data-settings-section="permissions-judge"]');
  await expect(reopened.locator('#permission-judge-mode')).toHaveValue('shadow');
  await expect(reopened.locator('#permission-judge-stage-0-id')).toHaveValue('current-reviewer');
  await expect(reopened.locator('#permission-judge-stage-0-provider')).toHaveValue('builtin-llm');
  await expect(reopened.locator('#permission-judge-stage-0-model')).toContainText(t('permissionJudge.currentReviewer'));
  await expect(reopened.locator('#permission-reviewer-model')).toContainText(t('permissionJudge.followChatModel'));
  await expect(reopened.locator('#permission-judge-stage-1-id')).toHaveValue('local-review');
  await expect(reopened.locator('#permission-judge-stage-1-provider')).toHaveValue('url');
  await expect(reopened.locator('#permission-judge-stage-1-threshold')).toHaveValue('0.75');
  await expect(reopened.locator('#permission-judge-stage-1-url')).toHaveValue('https://judge.example.test/review');
  await reopened.screenshot({ path: testInfo.outputPath('judge-settings.png') });
  await reopened.locator('#permission-judge-mode').selectOption('off');
  await reopened.getByRole('button', { name: t('permissionJudge.save') }).click();
  await expect(reopened.getByText(t('permissionJudge.saved'), { exact: true })).toBeVisible();
  await closeInlineSettings(app, settingsPage);
});
