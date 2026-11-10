import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";
import { inspectBrowserTarget } from "./browser-native-target.js";
import { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { captureOverlay, clickExposedAction, nativePageHole, scrollExposedPage, typeExposedEditor } from "./browser-ui-overlay-fixtures.js";
import { captureNativeWindow, prepareNativeWindowCapture } from "./native-window-capture.js";

interface CompositionProbe {
  editor: HTMLTextAreaElement;
  blurs: number;
  events: Array<{ type: string; data: string; trusted: boolean }>;
}

if (process.platform === "darwin") {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => { await prepareNativeWindowCapture(testInfo); });
  for (const width of [1360, 900]) {
    test(`composer composition and tab drag retain the native page at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width);
      const { app, page, composer, host, url, rendererTabId } = fixture;
      const session = await page.context().newCDPSession(page);
      try {
        await composer.fill("Retained draft ");
        await composer.focus();
        await composer.evaluate(editor => {
          if (!(editor instanceof HTMLTextAreaElement)) throw new Error("Composer textarea unavailable");
          const probe: CompositionProbe = { editor, blurs: 0, events: [] };
          (window as unknown as { compositionProbe: CompositionProbe }).compositionProbe = probe;
          editor.addEventListener("blur", () => { probe.blurs++; });
          for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
            editor.addEventListener(type, event => {
              const composition = event as CompositionEvent;
              probe.events.push({ type: composition.type, data: composition.data, trusted: composition.isTrusted });
            });
          }
        });
        // Protocol composition exercises the real editable pipeline without activating an OS input method.
        await session.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
        await expect(composer).toHaveValue("Retained draft 한");
        const nativeBefore = await inspectBrowserTarget(app, host.windowId, url);
        await fixture.clickFromAgent();
        expect(await fixture.readPage()).toMatchObject({ clicks: 1, trusted: true, activation: true, value: "", keys: [] });
        expect(await composer.evaluate(() => {
          const probe = (window as unknown as { compositionProbe: CompositionProbe }).compositionProbe;
          return { active: document.activeElement === probe.editor, blurs: probe.blurs, events: probe.events };
        })).toMatchObject({ active: true, blurs: 0, events: [{ type: "compositionstart", trusted: true }, { type: "compositionupdate", data: "한", trusted: true }] });
        expect(await inspectBrowserTarget(app, host.windowId, url)).toMatchObject({
          id: fixture.targetId, attached: true, ownerFocused: false,
          focusedHostFrame: nativeBefore.focusedHostFrame, focusedContentsId: nativeBefore.focusedContentsId,
        });
        await captureNativeWindow(app, page, testInfo, `composer-composition-${width}`);
        await session.send("Input.imeSetComposition", { text: "한국", selectionStart: 2, selectionEnd: 2 });
        await expect(composer).toHaveValue("Retained draft 한국");
        await session.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
        await expect(composer).toHaveValue("Retained draft ");
        await session.send("Input.insertText", { text: "한국어" });
        await expect(composer).toHaveValue("Retained draft 한국어");
        expect(await fixture.readPage()).toMatchObject({ value: "", keys: [] });
        await expect(composer).toHaveAccessibleName(/.+/);

        const tab = page.locator(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${rendererTabId}"]`).getByRole("tab");
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(tab).toHaveAttribute("draggable", "true");
        const tabBox = await tab.boundingBox();
        const holeBox = await nativePageHole(fixture).boundingBox();
        const mainBox = await page.getByTestId("pane-cell:main").boundingBox();
        assert(tabBox && holeBox && mainBox);
        const beforeDrag = await fixture.control();
        await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(holeBox.x + holeBox.width / 2, holeBox.y + holeBox.height / 2, { steps: 12 });
        await page.mouse.move(mainBox.x + mainBox.width / 2, mainBox.y + mainBox.height / 2, { steps: 12 });
        const indicator = page.getByTestId("pane-drop-indicator");
        await expect(indicator).toBeVisible();
        expect(await fixture.readPage()).toMatchObject({ heldMoves: 0, unsolicitedUps: 0, clicks: 1 });
        expect(await inspectBrowserTarget(app, host.windowId, url)).toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
        await captureOverlay(fixture, indicator, testInfo, `surface-tab-drag-${width}`, { overlap: true, fullCover: true });
        await page.mouse.up();
        await expect(indicator).toHaveCount(0);
        await expect(page.getByTestId("pane-cell:main").locator(`[data-ave-native-page][data-tab-id="${rendererTabId}"]`)).toBeVisible();
        expect(await fixture.readPage()).toMatchObject({ heldMoves: 0, unsolicitedUps: 0, clicks: 1, value: "", keys: [] });
        expect(await inspectBrowserTarget(app, host.windowId, url)).toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
        expect(await fixture.control()).toMatchObject({ mode: beforeDrag.mode, generation: beforeDrag.generation, owner: beforeDrag.owner });
        await captureNativeWindow(app, page, testInfo, `surface-tab-dropped-${width}`);
        await clickExposedAction(fixture);
        await scrollExposedPage(fixture);
        await typeExposedEditor(fixture, "DROPPED");
        expect(await fixture.readPage()).toMatchObject({ clicks: 2, trusted: true, value: "DROPPED", inputTrusted: true,
          heldMoves: 0, unsolicitedUps: 0 });
      } finally {
        await session.detach();
        await fixture.close();
      }
    });
  }
}
