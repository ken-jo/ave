import { test, expect } from './fixtures';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

// Inject stream pairs through the production reducer to verify duration badges without live tool timing.
test('tool duration badge renders ⏱ X.Ys after a tool completes', async ({ mainWindow }) => {
  await expect(mainWindow.locator(testIdSelector(TEST_IDS.composer)).first()).toBeVisible();
  await mainWindow.waitForFunction(
    () => typeof (window as unknown as { __aveChatStream?: { _emit?: unknown } })
      .__aveChatStream?._emit === 'function',
  );

  await mainWindow.evaluate(() => {
    const emit = (window as unknown as { __aveChatStream: { _emit: (event: unknown) => void } })
      .__aveChatStream._emit;
    const groupId = 'e2e-tool-duration';
    const toolUseId = 'tu-e2e-tool-duration';
    emit({ type: 'tool_start', name: 'web_fetch', groupId, toolUseId, displayOrder: 0, input: {} });
    emit({ type: 'tool_end', name: 'web_fetch', groupId, toolUseId, result: 'ok', isError: false, durationMs: 1400 });
  });

  const badge = mainWindow.locator('[data-testid="tool-duration"]').first();
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('⏱');
  await expect(badge).toContainText('1.4s');
});
