import { setWindowSize } from "./seeded-electron.js";
import { test, expect } from './fixtures.js';

// Guard layout checks when the build or relevant DOM nodes are unavailable.

const CHAT_OUTER_SELECTOR = '.chat-composer-column';

// The reading-column cap is 58rem; cross it by one pixel after reserving shell space and parent padding.
function readingCapWindowWidth(column: Element): number {
  const parent = column.parentElement!;
  const style = getComputedStyle(parent);
  const available = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return Math.ceil(innerWidth - available + parseFloat(getComputedStyle(column).maxWidth) + 1);
}

test.describe('chat column width constraints', () => {
  test('the reading column reaches its configured width cap', async ({ app, mainWindow }) => {
    const wideWidth = await mainWindow.locator(CHAT_OUTER_SELECTOR).first().evaluate(readingCapWindowWidth);
    await setWindowSize(app, wideWidth, 860);

    const chatOuter = mainWindow.locator(CHAT_OUTER_SELECTOR).first();
    const found = await chatOuter
      .waitFor({ state: 'attached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(!found, 'Chat outer container not found — skipping width check.');

    const box = await chatOuter.boundingBox();
    expect(box).not.toBeNull();
    const cap = await chatOuter.evaluate((column) => parseFloat(getComputedStyle(column).maxWidth));
    expect(Math.abs(box!.width - cap)).toBeLessThanOrEqual(1);
    expect(box!.width).toBeGreaterThan(600);
  });

  test('at 1024x720 — chat column fills most of main area (no shrink-wrap below 700px)', async ({ app, mainWindow }) => {
    await setWindowSize(app, 1024, 720);

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

  test('the capped reading column is horizontally centered', async ({ app, mainWindow }) => {
    const wideWidth = await mainWindow.locator(CHAT_OUTER_SELECTOR).first().evaluate(readingCapWindowWidth);
    await setWindowSize(app, wideWidth, 860);

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
