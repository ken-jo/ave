import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";
import { inspectBrowserTarget } from "./browser-native-target.js";
import { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { assertExposedActionPaint, captureOverlay, clickExposedAction, DENIAL_ID, nativePageHole, scrollExposedPage, seedDenialHistory, settleOverlayLayout, typeExposedEditor } from "./browser-ui-overlay-fixtures.js";
import { setWindowSize } from "./seeded-electron.js";
import { prepareNativeWindowCapture } from "./native-window-capture.js";

if (process.platform === "darwin") {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => { await prepareNativeWindowCapture(testInfo); });
  for (const width of [1360, 900]) {
    test(`native notification popover and capture controls stay usable at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width);
      const { page } = fixture;
      try {
        const bell = page.getByTestId("notification-bell");
        await bell.click();
        const notifications = page.getByTestId("notification-center");
        await expect(notifications).toHaveRole("dialog");
        const rendered = await captureOverlay(fixture, notifications, testInfo, `notification-${width}`, { overlap: true });
        await assertExposedActionPaint(fixture, rendered, testInfo, `notification-${width}`);
        const notificationBounds = await notifications.boundingBox();
        assert(notificationBounds);
        await scrollExposedPage(fixture, [notificationBounds]);
        await expect(notifications).toBeVisible();
        await typeExposedEditor(fixture, "BELL", [notificationBounds]);
        await expect(notifications).toHaveCount(0);
        await bell.click();
        await expect(notifications).toBeVisible();
        await expect(notifications).toBeFocused();
        const reopenedNotificationBounds = await notifications.boundingBox();
        assert(reopenedNotificationBounds);
        await clickExposedAction(fixture, [reopenedNotificationBounds]);
        await expect(notifications).toHaveCount(0);
        await bell.focus();
        await bell.press("Enter");
        await expect(notifications).toBeVisible();
        await expect(notifications).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(notifications).toHaveCount(0);
        await expect(bell).toBeFocused();

        const capture = page.getByTestId("browser-capture-menu");
        await capture.click();
        const area = page.getByTestId("browser-capture-area");
        const menu = page.getByRole("menu").filter({ has: area });
        await captureOverlay(fixture, menu, testInfo, `capture-menu-${width}`, { overlap: true });
        const menuBounds = await menu.boundingBox();
        assert(menuBounds);
        await scrollExposedPage(fixture, [menuBounds]);
        await expect(menu).toBeVisible();
        await typeExposedEditor(fixture, "CAPTURE", [menuBounds]);
        await expect(menu).toHaveCount(0);
        await capture.click();
        await area.focus();
        await area.press("Enter");
        const selector = page.getByTestId("browser-capture-overlay");
        await expect(selector).toHaveRole("dialog");
        await expect(selector).toBeFocused();
        await captureOverlay(fixture, selector, testInfo, `capture-area-${width}`, { overlap: true, fullCover: true });
        await page.keyboard.press("Escape");
        await expect(selector).toHaveCount(0);
        await capture.click();
        await area.click();
        await expect(selector).toBeVisible();
        const bounds = await selector.boundingBox();
        assert(bounds && bounds.width > 200 && bounds.height > 400);
        const start = { x: bounds.x + 35, y: bounds.y + 270 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 160, start.y + 100, { steps: 8 });
        await expect(page.getByTestId("browser-capture-rectangle")).toBeVisible();
        await page.mouse.up();
        await expect(selector).toHaveCount(0);
        const image = page.getByTestId("attachment-chip").getByRole("img", { name: /Image #1|이미지 #1/ });
        await expect(image).toBeVisible();
        expect(await image.evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight })))
          .toEqual({ width: 160, height: 100 });
        const data = await image.getAttribute("src");
        assert(data);
        expect(await fixture.app.evaluate(({ nativeImage }, dataUrl) => {
          const image = nativeImage.createFromDataURL(dataUrl), pixels = image.toBitmap();
          const offset = ((Math.floor(image.getSize().height / 2) * image.getSize().width) + Math.floor(image.getSize().width / 2)) * 4;
          return [pixels[offset + 2], pixels[offset + 1], pixels[offset], pixels[offset + 3]];
        }, data)).toEqual([180, 0, 200, 255]);
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url))
          .toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });

    test(`native page stays live through resize and surface work panel at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width);
      const { page } = fixture;
      try {
        const splitter = page.getByTestId("chat-side-panel-width-splitter");
        await expect(splitter).toHaveRole("separator");
        const original = Number(await splitter.getAttribute("aria-valuenow"));
        await splitter.focus();
        await splitter.press("ArrowLeft");
        await expect(splitter).toHaveAttribute("aria-valuenow", String(original + 16));
        await settleOverlayLayout(fixture);
        const bar = await splitter.boundingBox();
        assert(bar);
        await splitter.hover();
        const paint = splitter.locator("span");
        await expect.poll(() => paint.evaluate(element => {
          const context = new OffscreenCanvas(1, 1).getContext("2d");
          if (!context) throw new Error("Resize color context unavailable");
          const sample = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
          };
          const style = getComputedStyle(element);
          const actual = sample(style.backgroundColor);
          const expected = sample(`hsl(${style.getPropertyValue("--primary")})`);
          return actual.every((channel, index) => channel === expected[index]) && actual[3] === 255;
        })).toBe(true);
        const paintBounds = await paint.boundingBox();
        assert(paintBounds);
        await testInfo.attach(`resize-painted-strip-${width}`, { contentType: "application/json", body: JSON.stringify({
          hitBounds: bar, paintBounds, background: await paint.evaluate(element => getComputedStyle(element).backgroundColor),
        }) });
        await captureOverlay(fixture, splitter, testInfo, `resize-strip-${width}`, {
          overlap: true, point: { x: paintBounds.x + paintBounds.width / 2, y: paintBounds.y + paintBounds.height / 2 },
        });
        const start = { x: Math.ceil(bar.x) + 1, y: Math.round(bar.y + bar.height / 2) };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x - 24, start.y, { steps: 8 });
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url)).toMatchObject({ id: fixture.targetId, attached: true });
        await page.mouse.up();
        expect(await fixture.readPage()).toMatchObject({ heldMoves: 0, unsolicitedUps: 0 });
        await expect(splitter).toHaveAttribute("aria-valuenow", String(original + 16 + 24));
        await clickExposedAction(fixture);
        await scrollExposedPage(fixture);
        await typeExposedEditor(fixture, "RESIZE");
        // Narrow replacement puts the browser in the original pane at either final size.
        await setWindowSize(fixture.app, 900, 800);
        await page.getByTestId("chat-side-panel-move-to-main").click();
        const panel = page.getByTestId("web-panel");
        await expect(panel).toBeVisible();
        await expect(nativePageHole(fixture)).toBeVisible();
        await setWindowSize(fixture.app, width, 800);
        await page.getByTestId("pane-action-surface.chat").click();
        const work = page.getByTestId("pane-work-panel");
        await captureOverlay(fixture, work, testInfo, `surface-work-panel-${width}`, { overlap: width === 900 });
        const workBounds = await work.boundingBox();
        assert(workBounds);
        const composer = work.getByTestId("composer-textarea");
        await composer.fill("Retained work panel draft");
        await expect(composer).toHaveValue("Retained work panel draft");
        await scrollExposedPage(fixture, [workBounds]);
        await expect(composer).toHaveValue("Retained work panel draft");
        await clickExposedAction(fixture, [workBounds]);
        await typeExposedEditor(fixture, "WORK", [workBounds]);
        const close = page.getByTestId("pane-work-panel-close");
        await close.focus();
        await close.press("Enter");
        await expect(work).toHaveCount(0);
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url))
          .toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });

    test(`native page stays below denial dialog and backdrop at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width, { prepareHome: seedDenialHistory });
      const { page } = fixture;
      try {
        const trigger = page.getByTestId("permission-pending-badge");
        await expect(trigger).toBeVisible();
        await trigger.click();
        const dialog = page.getByTestId("recently-denied-dialog");
        await expect(dialog).toHaveRole("dialog");
        await expect(dialog.getByTestId(`recently-denied-entry-${DENIAL_ID}`)).toBeVisible();
        await captureOverlay(fixture, dialog, testInfo, `denial-dialog-${width}`, { overlap: true, fullCover: true });
        const backdrop = page.locator('[data-state="open"].inset-0');
        await expect(backdrop).toHaveCount(1);
        const box = await nativePageHole(fixture).boundingBox();
        assert(box);
        const point = { x: box.x + box.width - 12, y: box.y + box.height - 12 };
        await captureOverlay(fixture, backdrop, testInfo, `denial-backdrop-${width}`, { overlap: true, fullCover: true, point });
        const before = await fixture.readPage();
        await page.mouse.move(point.x, point.y);
        await page.mouse.wheel(0, 240);
        expect(await fixture.readPage()).toMatchObject({ scrollY: before.scrollY, wheels: before.wheels, clicks: before.clicks });
        for (let index = 0; index < 3; index++) {
          await page.keyboard.press("Tab");
          expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
        }
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await clickExposedAction(fixture);
        await scrollExposedPage(fixture);
        await typeExposedEditor(fixture, "DIALOG");
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url))
          .toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });
  }
}
