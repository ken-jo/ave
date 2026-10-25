// Computed-style failures need real CSS; renderer markup assertions alone cannot prove legibility or alignment.
import { test, expect } from './fixtures.js';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

// Scope locators to the main dock; side chat renders the same controls and test ids.
const MAIN = '[data-composer-surface="main"] ';

function parseRgb(value: string): [number, number, number] {
  const nums = value.match(/[\d.]+/g);
  if (!nums || nums.length < 3) throw new Error(`unparseable colour: ${value}`);
  return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
}

// Measure contrast against the actual backdrop; different color values alone do not prove legibility.
function contrastRatio(a: string, b: string): number {
  const luminance = (colour: string) => {
    const channel = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, bl] = parseRgb(colour);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
  };
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test('idle composer: the turn control is a quiet, icon-only send button', async ({ mainWindow }) => {
  const send = mainWindow.locator(MAIN + '[data-testid="composer-send-button"]');
  await expect(send).toBeVisible();
  await expect(mainWindow.locator(MAIN + '[data-testid="composer-cancel-button"]')).toHaveCount(0);

  const idle = await send.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      background: cs.backgroundColor,
      borderWidth: cs.borderTopWidth,
      label: (el.textContent ?? '').trim(),
      keycaps: el.querySelectorAll('kbd').length,
      glyphs: el.querySelectorAll('svg').length,
      ariaLabel: el.getAttribute('aria-label'),
    };
  });

  expect(idle.label).toBe('');
  expect(idle.keycaps).toBe(0);
  expect(idle.glyphs).toBe(1);
  expect(idle.ariaLabel).toBeTruthy();

  // Idle controls should remain quiet rather than painting a disabled solid disc.
  expect(idle.borderWidth).not.toBe('0px');
});

test('typing turns the quiet control solid', async ({ mainWindow }) => {
  const send = mainWindow.locator(MAIN + '[data-testid="composer-send-button"]');
  const before = await send.evaluate((el) => getComputedStyle(el).backgroundColor);

  const textarea = mainWindow.locator(MAIN + testIdSelector(TEST_IDS.composerTextarea));
  await textarea.click();
  await textarea.fill('포털 세션 유지 시간 확인할 수 있나?');

  const after = await send.evaluate((el) => ({
    background: getComputedStyle(el).backgroundColor,
    borderWidth: getComputedStyle(el).borderTopWidth,
  }));
  expect(after.background).not.toBe(before);
  expect(after.borderWidth).toBe('0px');
});

test('message queue panel stays a full-bleed band and paints visible actions', async ({ mainWindow }) => {
  await mainWindow.evaluate(() => {
    const store = (window as unknown as { __ave_message_queue_store__?: { add: (t: string) => void } })
      .__ave_message_queue_store__;
    store?.add('계속 확인해봐');
  });

  const panel = mainWindow.locator(MAIN + '[data-testid="message-queue-panel"]');
  await expect(panel).toBeVisible();
  const inject = mainWindow.locator(MAIN + '[data-testid="message-queue-row-send-now-button"]').first();
  await expect(inject).toBeVisible();

  const measured = await panel.evaluate((el) => {
    const panelBox = el.getBoundingClientRect();
    // Compare strip alignment with its dock column; the main region also includes the sidebar.
    const dockBox = document
      .querySelector('[data-testid="composer-queue-dock"]')
      ?.getBoundingClientRect();
    const injectEl = el.querySelector('[data-testid="message-queue-row-send-now-button"]')!;
    // Translucent panel backgrounds require contrast against the nearest opaque ancestor.
    let opaque: HTMLElement | null = el as HTMLElement;
    let behindPanel = 'rgb(255, 255, 255)';
    while (opaque) {
      const bg = getComputedStyle(opaque).backgroundColor;
      const alpha = bg.match(/[\d.]+/g);
      const isOpaque = bg.startsWith('rgb(') || (alpha && alpha.length === 4 && Number(alpha[3]) === 1);
      if (isOpaque) { behindPanel = bg; break; }
      opaque = opaque.parentElement;
    }
    return {
      left: Math.round(panelBox.left),
      right: Math.round(panelBox.right),
      dockLeft: dockBox ? Math.round(dockBox.left) : null,
      dockRight: dockBox ? Math.round(dockBox.right) : null,
      injectWidth: Math.round(injectEl.getBoundingClientRect().width),
      injectColor: getComputedStyle(injectEl).color,
      behindPanel,
    };
  });

  // Strips fill the dock column; only the composer is inset.
  expect(measured.left).toBe(measured.dockLeft);
  expect(measured.right).toBe(measured.dockRight);

  // Measure visible width and contrast against the actual action backdrop.
  expect(measured.injectWidth).toBeGreaterThan(0);
  expect(contrastRatio(measured.injectColor, measured.behindPanel)).toBeGreaterThanOrEqual(4.5);
});

test('edit bubble is a single frame with a readable save button', async ({ mainWindow }) => {
  const textarea = mainWindow.locator(MAIN + '[data-testid="composer-textarea"]');
  await textarea.click();
  await textarea.fill('포털 세션 유지 시간 확인할 수 있나?');
  await mainWindow.locator(MAIN + '[data-testid="composer-send-button"]').click();

  const actions = mainWindow.locator('[data-testid="user-message-actions"]').first();
  await expect(actions).toBeAttached({ timeout: 15_000 });
  await actions.locator('button').first().click({ force: true });

  const bubble = mainWindow.locator('[data-testid="user-message-editor"]');
  await expect(bubble).toBeVisible({ timeout: 10_000 });

  const measured = await bubble.evaluate((el) => {
    const inner = el.querySelector('textarea')!;
    const save = el.querySelector('[data-testid="user-message-editor-save"]')!;
    const saveCs = getComputedStyle(save);
    return {
      bubbleBorderWidth: getComputedStyle(el).borderTopWidth,
      innerBorderWidth: getComputedStyle(inner).borderTopWidth,
      saveLabel: (save.textContent ?? '').trim(),
      saveColor: saveCs.color,
      saveBackground: saveCs.backgroundColor,
    };
  });

  expect(measured.bubbleBorderWidth).not.toBe('0px');
  expect(measured.innerBorderWidth).toBe('0px');

  // Caption typography must not cause class merging to drop the button foreground color.
  expect(measured.saveLabel.length).toBeGreaterThan(0);
  expect(contrastRatio(measured.saveColor, measured.saveBackground)).toBeGreaterThanOrEqual(4.5);
});
