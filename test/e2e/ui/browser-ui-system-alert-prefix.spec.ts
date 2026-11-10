import { test } from "@playwright/test";
import { exerciseSystemAlert } from "./browser-ui-system-alert-fixture.js";
import { prepareNativeWindowCapture } from "./native-window-capture.js";

if (process.platform === "darwin") {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => { await prepareNativeWindowCapture(testInfo); });
  for (const width of [1360, 900]) {
    test(`system alert formats one error prefix at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      await exerciseSystemAlert(width, true, testInfo);
    });
  }
}
