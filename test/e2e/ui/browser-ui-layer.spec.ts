import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";
import { browserHostIdentity, inspectBrowserTarget } from "./browser-native-target.js";
import { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { captureNativeWindow, prepareNativeWindowCapture, sampleNativeWindow } from "./native-window-capture.js";

if (process.platform === "darwin") {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
    await prepareNativeWindowCapture(testInfo);
  });
  for (const width of [1360, 900]) {
    test(`native UI add menu stays above a live agent page at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width);
      const { app, page, host, url, rendererTabId } = fixture;
      try {
        const hole = page.locator(`[data-ave-native-page][data-tab-id="${rendererTabId}"]`);
        await expect(hole).toBeVisible();
        const pageBox = await hole.boundingBox();
        assert(pageBox);
        await page.getByTestId("chat-side-panel-add-tab").click();
        const menu = page.getByTestId("chat-side-panel-launcher-menu");
        await expect(menu).toBeVisible();
        await expect(menu).toHaveRole("menu");
        const menuBox = await menu.boundingBox();
        assert(menuBox);
        const overlap = {
          left: Math.max(pageBox.x, menuBox.x), right: Math.min(pageBox.x + pageBox.width, menuBox.x + menuBox.width),
          top: Math.max(pageBox.y, menuBox.y), bottom: Math.min(pageBox.y + pageBox.height, menuBox.y + menuBox.height),
        };
        expect(overlap.right - overlap.left).toBeGreaterThan(20);
        expect(overlap.bottom - overlap.top).toBeGreaterThan(20);
        const menuPoint = { x: (overlap.left + overlap.right) / 2, y: (overlap.top + overlap.bottom) / 2 };
        const pagePoint = { x: pageBox.x + 12, y: pageBox.y + pageBox.height - 36 };
        const controlBefore = await fixture.control();
        await menu.evaluate(() => {
          const element = document.activeElement;
          if (!(element instanceof HTMLElement)) throw new Error("Menu focus target unavailable");
          const state = { element, blurs: 0 };
          (window as unknown as { uiLayerFocus: typeof state }).uiLayerFocus = state;
          element.addEventListener("blur", () => { state.blurs++; });
        });
        const nativeBefore = await inspectBrowserTarget(app, host.windowId, url);
        await fixture.clickFromAgent();
        expect(await fixture.readPage()).toMatchObject({ clicks: 1, trusted: true, activation: true });
        await expect(menu).toBeVisible();
        expect(await menu.evaluate(() => {
          const state = (window as unknown as { uiLayerFocus: { element: HTMLElement; blurs: number } }).uiLayerFocus;
          return { active: document.activeElement === state.element, blurs: state.blurs };
        })).toEqual({ active: true, blurs: 0 });
        const nativeAfter = await inspectBrowserTarget(app, host.windowId, url);
        expect(nativeAfter).toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false,
          focusedHostFrame: nativeBefore.focusedHostFrame, focusedContentsId: nativeBefore.focusedContentsId });
        expect(await fixture.control()).toMatchObject({ mode: "agent-active", generation: controlBefore.generation, owner: controlBefore.owner });
        expect(await browserHostIdentity(app, page)).toEqual(host);
        const capture = await captureNativeWindow(app, page, testInfo, `toolbar-add-menu-${width}`);
        const pixels = await sampleNativeWindow(app, capture, [menuPoint, pagePoint]);
        expect(pixels[1]).toEqual([180, 0, 200, 255]);
        expect(pixels[0]).not.toEqual([180, 0, 200, 255]);
        const geometryPath = testInfo.outputPath(`toolbar-add-menu-${width}-geometry.json`);
        await fs.writeFile(geometryPath, `${JSON.stringify({ pageBox, menuBox, overlap, menuPoint, pagePoint, pixels }, null, 2)}\n`);
        await testInfo.attach("menu-native-overlap", { path: geometryPath, contentType: "application/json" });
        const targetPoint = async (selector: string) => {
          const viewport = await hole.boundingBox();
          assert(viewport);
          const local = await app.evaluate(async ({ webContents }, target) => {
            const contents = webContents.fromId(target.id);
            if (!contents) throw new Error("Native pointer target unavailable");
            return contents.executeJavaScript(`(() => { const element = document.querySelector(${JSON.stringify(target.selector)}); if (!element) throw new Error('Pointer element unavailable'); const rect = element.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`);
          }, { id: fixture.targetId, selector });
          return { x: viewport.x + local.x, y: viewport.y + local.y };
        };
        await page.mouse.move(pagePoint.x, pagePoint.y);
        await page.mouse.wheel(0, 360);
        await expect.poll(async () => (await fixture.readPage()).scrollY).toBeGreaterThan(0);
        expect((await fixture.readPage()).wheels).toBeGreaterThan(0);
        await expect(menu).toBeVisible();
        await page.mouse.wheel(0, -360);
        await expect.poll(async () => (await fixture.readPage()).scrollY).toBe(0);
        const action = await targetPoint("#action");
        await page.mouse.click(action.x, action.y);
        await expect.poll(async () => (await fixture.readPage()).clicks).toBe(2);
        expect(await fixture.readPage()).toMatchObject({ trusted: true, activation: true });
        expect(await fixture.control()).toMatchObject({ mode: "human-paused" });
        await expect(menu).toHaveCount(0);
        await page.getByTestId("chat-side-panel-add-tab").click();
        await page.getByTestId("chat-side-panel-launcher-menu-terminal").click();
        await expect(menu).toHaveCount(0);
        await expect(page.getByTestId("chat-side-panel-pty-terminal")).toBeVisible();
        await page.locator(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${rendererTabId}"]`).getByRole("tab").click();
        await expect.poll(async () => (await inspectBrowserTarget(app, host.windowId, url)).attached).toBe(true);
        expect(await fixture.readPage()).toMatchObject({ clicks: 2, trusted: true });
        const editor = await targetPoint("#editor");
        await page.mouse.click(editor.x, editor.y);
        // Targeted keys prove page-local delivery; OS keyboard destination is covered separately.
        await app.evaluate(({ webContents }, id) => {
          const target = webContents.fromId(id);
          if (!target) throw new Error("Native typing target unavailable");
          for (const key of "NATIVE") {
            target.sendInputEvent({ type: "keyDown", keyCode: key });
            target.sendInputEvent({ type: "char", keyCode: key });
            target.sendInputEvent({ type: "keyUp", keyCode: key });
          }
        }, fixture.targetId);
        await expect.poll(async () => (await fixture.readPage()).value).toBe("NATIVE");
        expect(await fixture.readPage()).toMatchObject({ inputTrusted: true });
        await expect(fixture.composer).toHaveValue("");
        expect(await inspectBrowserTarget(app, host.windowId, url)).toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally {
        await fixture.close();
      }
    });
  }
}
