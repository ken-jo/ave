import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";
import { inspectBrowserTarget } from "./browser-native-target.js";
import { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { captureOverlay, clickExposedAction, scrollExposedPage } from "./browser-ui-overlay-fixtures.js";
import { prepareNativeWindowCapture } from "./native-window-capture.js";

if (process.platform === "darwin") {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => { await prepareNativeWindowCapture(testInfo); });
  for (const width of [1360, 900]) {
    test(`real model fallback notice stays above the native page at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width, { fallbackNotice: true });
      const { app, page } = fixture;
      try {
        await fixture.clickFromAgent();
        await fixture.startFallbackTurn();
        const toast = page.getByTestId("composer-toast-dock").getByTestId("status-toast");
        await expect(toast).toBeVisible();
        await expect(toast).toContainText("native-ui-layer-fixture");
        await expect(toast).toContainText("native-ui-layer-backup");
        await expect(page.getByTestId("composer-toast-dock").getByTestId("notice-live-polite")).toContainText("native-ui-layer-backup");
        expect(await fixture.readPage()).toMatchObject({ clicks: 1, trusted: true });
        await captureOverlay(fixture, toast, testInfo, `model-fallback-toast-${width}`, { overlap: width === 900 });
        const bounds = await toast.boundingBox();
        assert(bounds);
        await scrollExposedPage(fixture, [bounds]);
        await expect(toast).toBeVisible();
        await clickExposedAction(fixture, [bounds]);
        await expect(toast).toBeVisible();
        const dismiss = toast.getByTestId("status-toast-dismiss");
        await dismiss.focus();
        await dismiss.press("Enter");
        await expect(toast).toHaveCount(0);
        expect(await inspectBrowserTarget(app, fixture.host.windowId, fixture.url)).toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });
  }
}
