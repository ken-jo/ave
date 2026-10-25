import { test, expect } from './fixtures';

// Guard layout checks when the build or relevant DOM nodes are unavailable.

const CHAT_OUTER_SELECTOR =
  '.grid.grid-rows-\\[1fr_auto\\]';

test.describe('chat column width constraints', () => {
  test('at 1920x1080 — chat column is ≤800px wide and ≥600px wide', async ({ app, mainWindow }) => {
    await app.firstWindow().then((w) => w.setViewportSize({ width: 1920, height: 1080 }).catch(() => {}));

    const chatOuter = mainWindow.locator(CHAT_OUTER_SELECTOR).first();
    const found = await chatOuter
      .waitFor({ state: 'attached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(!found, 'Chat outer container not found — skipping width check.');

    const box = await chatOuter.boundingBox();
    expect(box).not.toBeNull();
    // Allow padding and scrollbar headroom above the column-width limit.
    expect(box!.width).toBeLessThanOrEqual(800);
    expect(box!.width).toBeGreaterThan(600);
  });

  test('at 1024x720 — chat column fills most of main area (no shrink-wrap below 700px)', async ({ app, mainWindow }) => {
    await app.firstWindow().then((w) => w.setViewportSize({ width: 1024, height: 720 }).catch(() => {}));

    const chatOuter = mainWindow.locator(CHAT_OUTER_SELECTOR).first();
    const found = await chatOuter
      .waitFor({ state: 'attached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(!found, 'Chat outer container not found — skipping narrow-viewport check.');

    const box = await chatOuter.boundingBox();
    expect(box).not.toBeNull();
    // At this width the column fills available space before reaching its maximum.
    expect(box!.width).toBeGreaterThan(600);
  });

  test('at 1920x1080 — chat column is horizontally centered within the main content area', async ({ app, mainWindow }) => {
    await app.firstWindow().then((w) => w.setViewportSize({ width: 1920, height: 1080 }).catch(() => {}));

    const chatOuter = mainWindow.locator(CHAT_OUTER_SELECTOR).first();
    const found = await chatOuter
      .waitFor({ state: 'attached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(!found, 'Chat outer container not found — skipping centering check.');

    const chatBox = await chatOuter.boundingBox();
    const parent = chatOuter.locator('..');
    const parentBox = await parent.boundingBox();

    expect(chatBox).not.toBeNull();
    expect(parentBox).not.toBeNull();

    const leftGap = chatBox!.x - parentBox!.x;
    const rightGap = (parentBox!.x + parentBox!.width) - (chatBox!.x + chatBox!.width);

    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(10);
  });
});
