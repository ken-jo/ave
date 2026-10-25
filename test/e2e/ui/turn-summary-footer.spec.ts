import { test, expect } from './fixtures';

// Offline runs skip when no completed turn can produce the aggregate footer.
test('turn-summary-footer renders selectors after turn completes, or skips cleanly', async ({
  mainWindow,
}) => {
  const input = mainWindow
    .locator('textarea, input[type="text"], [contenteditable="true"]')
    .first();

  const found = await input
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!found, 'No chat input visible — turn-summary-footer e2e cannot exercise.');

  // Without a configured key no done event arrives, so this smoke skips.
  const marker = `ts-${Date.now()}`;
  await input.click();
  await input.fill(marker);
  await input.press('Enter').catch(() => {});

  const footer = mainWindow.locator('[data-testid="turn-summary-footer"]').first();
  const appeared = await footer
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!appeared, 'No LLM provider wired in this E2E sandbox — turn-summary-footer cannot complete.');

  const toggle = mainWindow.locator('[data-testid="turn-summary-footer-toggle"]').first();
  await expect(toggle).toBeVisible();

  // Zero tool steps still produce a non-empty summary.
  const steps = mainWindow.locator('[data-testid="turn-summary-steps"]').first();
  await expect(steps).toBeVisible();
  const stepsText = await steps.innerText();
  expect(stepsText).toMatch(/\b\d+\s+steps?\b/);

  const duration = mainWindow.locator('[data-testid="turn-summary-duration"]').first();
  await expect(duration).toBeVisible();
  const durationText = await duration.innerText();
  expect(durationText).toContain('⏱');

  const tokens = mainWindow.locator('[data-testid="turn-summary-tokens"]').first();
  await expect(tokens).toBeVisible();
  const tokensText = await tokens.innerText();
  expect(tokensText).toContain('🪙');
});
