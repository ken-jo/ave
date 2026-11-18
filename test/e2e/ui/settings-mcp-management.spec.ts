import { test, expect } from './fixtures.js';
import { openInlineSettings } from './inline-settings.js';

test('user server saves before trust, reviews its launch details and supports undo remove', async ({ app, mainWindow, t }) => {
  const page = await openInlineSettings(app, mainWindow, 'mcp');
  await expect(page.getByTestId('mcp-policy-state')).toContainText(t('mcpTab.policyUserTrustAllowed'));
  await page.getByRole('button', { name: t('mcpTab.addServerButton'), exact: true }).click();
  await page.getByLabel(t('mcpTab.serverIdLabel'), { exact: true }).fill('local-notes-review');
  await page.getByLabel(t('mcpTab.commandRequiredLabel'), { exact: true }).fill('notes-server');
  await page.getByLabel(t('mcpTab.argsLabel'), { exact: true }).fill('--profile "team alpha"');
  await page.getByLabel(t('mcpTab.envWriteOnlyLabel'), { exact: true }).fill('PROFILE=team');
  await page.getByRole('button', { name: t('mcpTab.addButton'), exact: true }).click();
  const row = page.locator('[data-mcp-server-id="local-notes-review"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText(t('mcpTab.statusDisconnected'));
  await row.getByRole('button', { name: t('mcpTab.reviewAndStart') }).click();
  const review = row.getByRole('group', { name: t('mcpTab.trustReviewTitle') });
  await expect(review).toContainText('notes-server "--profile" "team alpha"');
  await expect(review).toContainText('PROFILE');
  await row.getByRole('button', { name: t('mcpTab.removeButton'), exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: t('mcpTab.undoRemove'), exact: true }).click();
  await expect(row).toBeVisible();
  await expect(row).toContainText(t('mcpTab.statusDisconnected'));
});

test('an explicit credential clear removes stored presence and leaves the server stopped', async ({ app, mainWindow, t }) => {
  const page = await openInlineSettings(app, mainWindow, 'mcp');
  await page.getByRole('button', { name: t('mcpTab.addServerButton'), exact: true }).click();
  await page.getByLabel(t('mcpTab.serverIdLabel'), { exact: true }).fill('local-notes-key-reset');
  await page.getByLabel(t('mcpTab.commandRequiredLabel'), { exact: true }).fill('notes-server');
  await page.getByLabel(t('mcpTab.authLabel'), { exact: true }).selectOption('api-key');
  await page.getByLabel(t('mcpTab.apiKeyWriteOnlyLabel'), { exact: true }).fill('throwaway-reset-key');
  await page.getByLabel(t('mcpTab.apiKeyEnvironmentName'), { exact: true }).fill('NOTES_API_KEY');
  await page.getByRole('button', { name: t('mcpTab.addButton'), exact: true }).click();
  const row = page.locator('[data-mcp-server-id="local-notes-key-reset"]');
  await row.getByRole('button', { name: t('mcpTab.clearApiKey'), exact: true }).click();
  await expect(row).toContainText(t('mcpTab.missingApiKey'));
  await expect(row.getByRole('button', { name: t('mcpTab.reviewAndStart') })).toBeDisabled();
  const state = await page.evaluate(() => window.ave.mcp.getManagementState());
  expect(state.hasApiKey['local-notes-key-reset']).toBe(false);
  expect(JSON.stringify(state)).not.toContain('throwaway-reset-key');
});
