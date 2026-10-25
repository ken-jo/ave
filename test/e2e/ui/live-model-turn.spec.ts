import { test, expect } from './fixtures.js';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

// A real app turn verifies settings, credentials, engine dispatch and permissions beyond the adapter wire.

const liveKey = process.env.AVE_SMOKE_OPENROUTER_KEY?.trim();

test.describe('live model turn', () => {
  test.skip(!liveKey, 'set AVE_SMOKE_OPENROUTER_KEY to run a real turn');
  test.use({ seedViewFixturePlugin: false });

  test('answers a prompt end to end', async ({ mainWindow }) => {
    const composer = mainWindow.locator(testIdSelector(TEST_IDS.composerTextarea)).first();
    await expect(composer).toBeVisible({ timeout: 60_000 });

    // A disabled composer means the seeded credential was not resolved.
    await expect(composer).toBeEnabled({ timeout: 60_000 });

    await composer.fill('Reply with exactly one word: pong');
    await mainWindow.locator('[data-testid="composer-send-button"]').first().click();

    const assistant = mainWindow.locator('[data-testid="assistant-message-body"]').first();
    await expect(assistant).toBeVisible({ timeout: 180_000 });

    // Assert the actual model answer; provider errors render in the same transcript node.
    await expect(assistant).toContainText(/pong/i, { timeout: 180_000 });
  });
});
