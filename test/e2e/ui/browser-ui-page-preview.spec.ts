import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";
import { inspectBrowserTarget } from "./browser-native-target.js";
import { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { captureOverlay, clickExposedAction, nativePageHole, scrollExposedPage, settleOverlayLayout, typeExposedEditor,
  type UiLayerFixture } from "./browser-ui-overlay-fixtures.js";
import { prepareNativeWindowCapture } from "./native-window-capture.js";
import { setWindowSize } from "./seeded-electron.js";

if (process.platform === "darwin") {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => { await prepareNativeWindowCapture(testInfo); });
  for (const width of [1360, 900]) {
    test(`parked agent page preview stays above another live page at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width);
      const { app, page, host } = fixture;
      try {
        const firstControl = await fixture.control();
        const firstCard = page.locator(`[data-testid="agent-browser-pip-card"][data-tab-id="${fixture.rendererTabId}"]`);
        await expect(firstCard).toHaveCount(0);
        await fixture.clickFromAgent();
        await expect.poll(fixture.toolReady).toBe(true);
        const secondUrl = `${fixture.url}#preview-second`;
        fixture.requestTool("browser_tab_new", { url: secondUrl });
        await expect.poll(fixture.toolReady).toBe(true);
        expect(fixture.toolResults().at(-1)).not.toMatch(/"error"\s*:/);
        const secondControl = await page.evaluate(async url => {
          const tabs = window.aveApi.browserTabs;
          if (!tabs) throw new Error("Browser controls unavailable");
          const result = (await tabs.getState()).tabs.find(tab => tab.url === url);
          if (!result?.rendererTabId) throw new Error("Second agent tab unavailable");
          return result;
        }, secondUrl);
        assert(secondControl.rendererTabId);
        expect(secondControl.tabId).not.toBe(firstControl.tabId);
        expect(secondControl).toMatchObject({ mode: "agent-active", owner: firstControl.owner });
        expect(await inspectBrowserTarget(app, host.windowId, fixture.url)).toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
        expect(await inspectBrowserTarget(app, host.windowId, secondUrl)).toMatchObject({ attached: false, ownerFocused: false });

        const secondTab = page.locator(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${secondControl.rendererTabId}"]`).getByRole("tab");
        await secondTab.click();
        await expect(secondTab).toHaveAttribute("aria-selected", "true");
        const secondHole = page.locator(`[data-ave-native-page][data-tab-id="${secondControl.rendererTabId}"]`);
        await expect(secondHole).toBeVisible();
        const rawIdentity = await secondHole.getAttribute("data-ave-native-page");
        assert(rawIdentity);
        const identity = JSON.parse(rawIdentity) as { tabId: string; webContentsId: number; epoch: number };
        expect(identity.tabId).toBe(secondControl.rendererTabId);
        expect(Number.isSafeInteger(identity.webContentsId) && identity.webContentsId > 0).toBe(true);
        expect(Number.isSafeInteger(identity.epoch) && identity.epoch > 0).toBe(true);
        const active: UiLayerFixture = {
          ...fixture, url: secondUrl, rendererTabId: secondControl.rendererTabId, targetId: identity.webContentsId,
          readPage: () => app.evaluate(async ({ webContents }, id) => {
            const target = webContents.fromId(id);
            if (!target) throw new Error("Visible native page unavailable");
            return target.executeJavaScript("({...window.fixtureState,scrollY})");
          }, identity.webContentsId),
          control: () => page.evaluate(async id => {
            const tabs = window.aveApi.browserTabs;
            if (!tabs) throw new Error("Browser controls unavailable");
            const result = (await tabs.getState()).tabs.find(tab => tab.tabId === id);
            if (!result) throw new Error("Visible browser control unavailable");
            return result;
          }, secondControl.tabId),
        };
        // The pane body owns preview drag bounds; place B there through the ordinary user action.
        await setWindowSize(app, 900, 800);
        await page.locator(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${secondControl.rendererTabId}"]`)
          .getByTestId("chat-side-panel-move-to-main").click();
        await expect(page.getByTestId("web-panel")).toBeVisible();
        await expect(nativePageHole(active)).toBeVisible();
        await setWindowSize(app, width, 800);
        await settleOverlayLayout(active);
        const currentRaw = await nativePageHole(active).getAttribute("data-ave-native-page");
        assert(currentRaw);
        const presentedIdentity = JSON.parse(currentRaw) as { tabId: string; webContentsId: number; epoch: number };
        expect(presentedIdentity).toMatchObject({ tabId: identity.tabId, webContentsId: identity.webContentsId });
        expect(Number.isSafeInteger(presentedIdentity.epoch) && presentedIdentity.epoch > 0).toBe(true);
        const visible = await inspectBrowserTarget(app, host.windowId, secondUrl);
        expect(visible).toMatchObject({ id: identity.webContentsId, attached: true, ownerFocused: false });
        expect(await inspectBrowserTarget(app, host.windowId, fixture.url)).toMatchObject({ id: fixture.targetId, attached: false, ownerFocused: false });
        expect(await fixture.control()).toMatchObject({ mode: "agent-active", owner: firstControl.owner, generation: firstControl.generation });
        await expect(firstCard).toBeVisible();
        await expect(firstCard).toHaveAttribute("data-compact", "false");
        await expect(page.locator(`[data-testid="agent-browser-pip-card"][data-tab-id="${secondControl.rendererTabId}"]`)).toHaveCount(0);
        const preview = firstCard.getByTestId("browser-observation-preview");
        await expect(preview).toHaveAttribute("data-preview-state", "live");
        const image = preview.getByRole("img");
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)).toBe(true);

        const open = firstCard.getByRole("button", { name: /^(Open browser tab:|브라우저 탭 열기:)/ });
        await settleOverlayLayout(active);
        const before = await firstCard.boundingBox();
        const pageBounds = await nativePageHole(active).boundingBox();
        assert(before && pageBounds);
        const start = { x: before.x + 35, y: before.y + 15 };
        const destination = { x: pageBounds.x + pageBounds.width - before.width - 30, y: pageBounds.y + 60 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + destination.x - before.x, start.y + destination.y - before.y, { steps: 12 });
        expect(await inspectBrowserTarget(app, host.windowId, secondUrl)).toMatchObject({ id: identity.webContentsId, attached: true, ownerFocused: false });
        expect(await active.readPage()).toMatchObject({ heldMoves: 0, unsolicitedUps: 0, clicks: 0, value: "", keys: [] });
        await page.mouse.up();
        const moved = await firstCard.boundingBox();
        assert(moved);
        const dragPath = testInfo.outputPath(`agent-page-preview-${width}-drag.json`);
        await fs.writeFile(dragPath, JSON.stringify({ before, pageBounds, start, destination, moved,
          regions: await page.locator("[data-pip-region]").evaluateAll(elements => elements.map(element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          })), native: await inspectBrowserTarget(app, host.windowId, secondUrl), input: await active.readPage() }, null, 2));
        await testInfo.attach(`agent-page-preview-${width}-drag`, { path: dragPath, contentType: "application/json" });
        expect(Math.hypot(moved.x - before.x, moved.y - before.y)).toBeGreaterThan(12);
        expect(await active.readPage()).toMatchObject({ heldMoves: 0, unsolicitedUps: 0, clicks: 0, value: "", keys: [] });
        const rendered = await captureOverlay(active, firstCard, testInfo, `agent-page-preview-${width}`, {
          overlap: true, point: { x: moved.x + 15, y: moved.y + 15 },
        });
        const excluded = [rendered.geometry.overlayRect];
        await scrollExposedPage(active, excluded);
        await expect(firstCard).toBeVisible();
        await clickExposedAction(active, excluded);
        await typeExposedEditor(active, "PREVIEW", excluded);
        await expect(firstCard).toBeVisible();
        expect(await fixture.readPage()).toMatchObject({ clicks: 1, value: "", keys: [] });
        expect(await active.control()).toMatchObject({ mode: "human-paused", owner: firstControl.owner });
        expect(await fixture.control()).toMatchObject({ mode: "agent-active", owner: firstControl.owner, generation: firstControl.generation });
        const path = testInfo.outputPath(`agent-page-preview-${width}-identity.json`);
        await fs.writeFile(path, JSON.stringify({ first: { rendererTabId: fixture.rendererTabId, webContentsId: fixture.targetId, control: await fixture.control() },
          second: { ...presentedIdentity, control: await active.control() }, before, moved, native: await inspectBrowserTarget(app, host.windowId, secondUrl) }, null, 2));
        await testInfo.attach(`agent-page-preview-${width}-identity`, { path, contentType: "application/json" });

        await open.focus();
        await expect(open).toBeFocused();
        await open.press("Enter");
        await expect(nativePageHole(fixture)).toBeVisible();
        await expect(firstCard).toHaveCount(0);
        expect(await inspectBrowserTarget(app, host.windowId, fixture.url)).toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
        expect(await inspectBrowserTarget(app, host.windowId, secondUrl)).toMatchObject({ id: identity.webContentsId, attached: false, ownerFocused: false });
        expect(await active.readPage()).toMatchObject({ clicks: 1, value: "PREVIEW", inputTrusted: true, heldMoves: 0, unsolicitedUps: 0 });
      } finally { await fixture.close(); }
    });
  }
}
