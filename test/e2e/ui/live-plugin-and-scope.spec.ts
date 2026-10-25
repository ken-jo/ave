import { test, expect } from './fixtures.js';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";
import { VIEW_FIXTURE_DISPATCH_MARKER, VIEW_FIXTURE_TOOL } from "../../fixtures/e2e-plugins/view-fixture.js";

// Live coverage must dispatch a seeded plugin tool and route out-of-scope access to review.

const liveKey = process.env.AVE_SMOKE_OPENROUTER_KEY?.trim();
const mode = process.env.AVE_E2E_PERMISSION_MODE?.trim() ?? 'default';

test.describe('live plugin + scope', () => {
  test.skip(!liveKey, 'set AVE_SMOKE_OPENROUTER_KEY to run a real turn');
  test.setTimeout(300_000);

  test('a real model calls a plugin tool', async ({ mainWindow }) => {
    test.skip(mode !== 'allow', 'needs AVE_E2E_PERMISSION_MODE=allow');

    const composer = mainWindow.locator(testIdSelector(TEST_IDS.composerTextarea)).first();
    await expect(composer).toBeEnabled({ timeout: 60_000 });

    // Verify the seeded mode: incomplete permission data is discarded and otherwise looks identical.
    await expect(mainWindow.locator('[data-testid="iab-status-row"]'))
      .toContainText(/allow|모두 허용|전체 허용/i, { timeout: 60_000 });

    // Name tools explicitly to test exposure and dispatch rather than model selection.
    await composer.fill(
      `Call the tool ${VIEW_FIXTURE_TOOL} once and report what it returned. Use the tool, do not guess.`,
    );
    await mainWindow.locator('[data-testid="composer-send-button"]').first().click();

    // Assert the fixture-only marker; the tool name already appears in the user prompt.
    await expect(mainWindow.locator('body')).toContainText(VIEW_FIXTURE_DISPATCH_MARKER, {
      timeout: 180_000,
    });
  });

  test('a path outside the allowed directories reaches the scope review', async ({ mainWindow, t }) => {
    test.skip(mode !== 'default', 'needs AVE_E2E_PERMISSION_MODE=default');

    const composer = mainWindow.locator(testIdSelector(TEST_IDS.composerTextarea)).first();
    await expect(composer).toBeEnabled({ timeout: 60_000 });

    await composer.fill(
      'Read the file /etc/hosts using your file tool and show me its first line.',
    );
    await mainWindow.locator('[data-testid="composer-send-button"]').first().click();

    // Assert the localized review card so a silent read or refusal cannot pass.
    const card = mainWindow.getByText(t('outOfAllowedDirCard.title')).first();
    await expect(card).toBeVisible({ timeout: 180_000 });

    const once = t('outOfAllowedDirCard.allowOnceButton');
    const deny = t('outOfAllowedDirCard.denyButton');
    const detail = await mainWindow.evaluate(({ once, deny }) => {
      const text = document.body.innerText;
      return {
        showsRequestedPath: /\/etc\/hosts/.test(text),
        // Use substring matching because catalog text can contain regex metacharacters.
        offersScopes: text.includes(once) && text.includes(deny),
      };
    }, { once, deny });
    console.log(`[live-scope] requestedPathShown=${detail.showsRequestedPath} scopesOffered=${detail.offersScopes}`);

    // Review must name the requested path and let the user bound its authority.
    expect(detail.showsRequestedPath).toBe(true);
    expect(detail.offersScopes).toBe(true);

    // Denial must end the attempt without falling through to a read.
    await mainWindow.getByRole('button', { name: deny }).first().click();
    await expect(mainWindow.locator('body')).not.toContainText(/127\.0\.0\.1\s+localhost/, { timeout: 60_000 });
  });
});
