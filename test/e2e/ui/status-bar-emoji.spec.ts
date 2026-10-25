import { test, expect } from './fixtures';

// Verify persistent composer identity without depending on platform emoji glyphs.
test('composer status row exposes permission, model and reasoning', async ({ mainWindow }) => {
  const row = mainWindow.locator('[data-testid="iab-status-row"]');
  await expect(row).toBeVisible({ timeout: 15_000 });

  const permission = row.locator('[data-testid="iab-status-permission"]');
  await expect(permission).toBeVisible();
  await expect(permission).toHaveAttribute('data-mode', /^(default|strict|auto|allow)$/);
  await expect(permission).toHaveAttribute('title', /.+/);

  const model = row.locator('[data-testid="iab-status-model"]');
  await expect(model).toBeVisible();
  await expect(model).toHaveAttribute('title', /.+/);

  await expect(row.locator('[data-testid="iab-status-reasoning"]')).toBeVisible();
});

test('composer status row does not render the deprecated account identity', async ({ mainWindow }) => {
  const row = mainWindow.locator('[data-testid="iab-status-row"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).not.toContainText(/[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+/);
});
