import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";
import { UI_COMPOSITION_NOTICE_TOOL, UI_COMPOSITION_TOOL, seedUiCompositionApp } from "../../fixtures/e2e-plugins/ui-composition-fixture.js";
import { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { captureOverlay, clickExposedAction, nativePageHole, openPagePoint, scrollExposedPage, typeExposedEditor } from "./browser-ui-overlay-fixtures.js";
import { inspectBrowserTarget } from "./browser-native-target.js";
import { captureNativeWindow, prepareNativeWindowCapture } from "./native-window-capture.js";

if (process.platform === "darwin") {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => { await prepareNativeWindowCapture(testInfo); });
  for (const width of [1360, 900]) {
    test(`native page remains interactive under a genuine plugin notice at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width, { prepareHome: seedUiCompositionApp, admitPreparedPlugins: true, suggestions: true });
      const { app, page } = fixture;
      try {
        await fixture.clickFromAgent();
        fixture.requestTool("request_plugin", { pluginId: "compositionfixture" });
        await expect.poll(fixture.toolReady).toBe(true);
        fixture.requestTool(UI_COMPOSITION_NOTICE_TOOL, {});
        await expect.poll(fixture.toolReady).toBe(true);
        expect(fixture.toolResults().at(-1)).toMatch(/"status"\s*:\s*"raised"/);
        expect(fixture.toolResults().at(-1)).toMatch(/"card"\s*:\s*true/);
        expect(fixture.toolResults().at(-1)).toMatch(/"toast"\s*:\s*false/);
        await fixture.finishTurn();
        const card = page.getByTestId("overlay-card-region").filter({ hasText: "Composition notice" });
        await expect(card).toBeVisible();
        await captureOverlay(fixture, card, testInfo, `plugin-notice-${width}`, { overlap: width === 900 });
        const cardBox = await card.boundingBox();
        assert(cardBox);
        const excluded = [cardBox];
        await scrollExposedPage(fixture, excluded);
        await expect(card).toBeVisible();
        await clickExposedAction(fixture, excluded);
        await expect(card).toBeVisible();
        await card.getByTestId("routine-card-dismiss").click();
        await expect(card).toHaveCount(0);
        expect(await inspectBrowserTarget(app, fixture.host.windowId, fixture.url)).toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });
    test(`native page stays below app card floating and fullscreen modes at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width, { prepareHome: seedUiCompositionApp, admitPreparedPlugins: true });
      const { app, page } = fixture;
      const appState = () => app.evaluate(async ({ webContents }) => {
        const guests = webContents.getAllWebContents().filter(contents => contents.getURL().startsWith("ave-mcp-app://"));
        return Promise.all(guests.map(async guest => ({ id: guest.id, state: await guest.executeJavaScript("(() => { const f=document.querySelector('iframe'); return {status:f?.contentDocument?.getElementById('status')?.textContent,contexts:f?.contentWindow?.fixtureContexts}; })()") })));
      });
      const requestMode = async (mode: "pip" | "fullscreen") => {
        const guests = await appState();
        expect(guests).toHaveLength(1);
        const [guest] = guests;
        assert(guest);
        await app.evaluate(async ({ webContents }, target) => {
          const contents = webContents.fromId(target.id);
          if (!contents) throw new Error("App card guest unavailable");
          // The fixture app sends the standard protocol request through its live bridge.
          await contents.executeJavaScript(`void document.querySelector('iframe').contentWindow.requestMode(${JSON.stringify(target.mode)})`);
        }, { id: guest.id, mode });
      };
      try {
        await fixture.clickFromAgent();
        await app.evaluate(({ webContents }, chromeId) => {
          const chrome = webContents.fromId(chromeId);
          if (!chrome) throw new Error("Lifecycle observation UI unavailable");
          const events: Array<{ event: string; url?: string; mainFrame?: boolean; inPlace?: boolean }> = [];
          (globalThis as unknown as { uiNativeLifecycleEvents: typeof events }).uiNativeLifecycleEvents = events;
          chrome.on("did-start-loading", () => { events.push({ event: "did-start-loading" }); });
          chrome.on("did-stop-loading", () => { events.push({ event: "did-stop-loading" }); });
          chrome.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
            events.push({ event: "did-start-navigation", url, inPlace, mainFrame });
          });
        }, fixture.host.chromeId);
        await page.evaluate(() => {
          const states: unknown[] = [];
          Reflect.set(window, "nativeLifecycleSurfaceStates", states);
          window.aveApi.browserTabs?.onNativeSurfaceChanged(change => { states.push(change); });
        });
        fixture.requestTool("request_plugin", { pluginId: "compositionfixture" });
        await expect.poll(fixture.toolReady).toBe(true);
        fixture.requestTool(UI_COMPOSITION_TOOL, {});
        await expect.poll(fixture.toolReady).toBe(true);
        expect(fixture.toolResults().at(-1)).toMatch(/"ok"\s*:\s*true/);
        await expect.poll(async () => (await appState()).some(guest => guest.state.status === "Composition app ready")).toBe(true);
        await requestMode("pip");
        const pip = page.getByTestId("mcp-app-pip-panel");
        await expect(pip).toBeVisible();
        await page.locator(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${fixture.rendererTabId}"]`).getByRole("tab").click();
        try {
          await expect.poll(async () => (await inspectBrowserTarget(app, fixture.host.windowId, fixture.url)).attached).toBe(true);
        } catch (error) {
          const statePath = testInfo.outputPath(`app-browser-reveal-state-${width}.json`);
          await fs.writeFile(statePath, `${JSON.stringify({
            native: await inspectBrowserTarget(app, fixture.host.windowId, fixture.url),
            control: await fixture.control(),
            lifecycle: await app.evaluate(() => (globalThis as unknown as { uiNativeLifecycleEvents: unknown }).uiNativeLifecycleEvents),
            ui: await page.evaluate(async () => ({
              bindings: await window.aveApi.browserTabs?.getSessionBindings(),
              nativeSurfaceEvents: Reflect.get(window, "nativeLifecycleSurfaceStates"),
              panelToggle: document.querySelector('[data-testid="pane-panel-toggle"]')?.getAttribute("aria-pressed"),
              selectedTabs: Array.from(document.querySelectorAll('[role="tab"]')).map(tab => ({
                text: tab.textContent, selected: tab.getAttribute("aria-selected"),
                tabId: tab.closest("[data-tab-id]")?.getAttribute("data-tab-id"),
              })),
              elements: Array.from(document.querySelectorAll('[data-tab-id], [data-testid="mcp-app-pip-panel"]')).map(element => ({
                testId: element.getAttribute("data-testid"), tabId: element.getAttribute("data-tab-id"),
                native: element.getAttribute("data-ave-native-page"), role: element.getAttribute("role"),
                text: element.getAttribute("role") === "tab" ? element.textContent : null,
                bounds: element.getBoundingClientRect().toJSON(), display: getComputedStyle(element).display,
                visibility: getComputedStyle(element).visibility, opacity: getComputedStyle(element).opacity,
                ariaHidden: element.getAttribute("aria-hidden"), hidden: element.hasAttribute("hidden"), inert: element.hasAttribute("inert"),
              })),
            })),
          }, null, 2)}\n`);
          await testInfo.attach("app-browser-reveal-state", { path: statePath, contentType: "application/json" });
          throw error;
        }
        expect(await fixture.control()).toMatchObject({ mode: "agent-active" });
        await expect.poll(async () => (await appState()).some(guest => guest.state.contexts?.at(-1)?.displayMode === "pip")).toBe(true);
        const before = await pip.boundingBox();
        assert(before);
        const handle = pip.getByTestId("mcp-app-pip-drag-handle");
        await handle.focus();
        await handle.press("ArrowLeft");
        await expect.poll(async () => (await pip.boundingBox())?.x).toBeLessThan(before.x);
        const pageBox = await nativePageHole(fixture).boundingBox();
        const positioned = await pip.boundingBox();
        const handleBox = await handle.boundingBox();
        assert(pageBox && positioned && handleBox);
        const desiredX = pageBox.x + 16 - positioned.width;
        const dragStart = { x: Math.ceil(handleBox.x) + 12, y: Math.ceil(handleBox.y) + 12 };
        await page.mouse.move(dragStart.x, dragStart.y);
        await page.mouse.down();
        await page.mouse.move(dragStart.x + desiredX - positioned.x, dragStart.y, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => (await pip.boundingBox())?.x).toBe(desiredX);
        expect(await fixture.readPage()).toMatchObject({ heldMoves: 0, unsolicitedUps: 0 });
        await captureOverlay(fixture, pip, testInfo, `app-pip-${width}`, { overlap: true });
        await fixture.composer.fill("Overlay draft 한국어");
        await fixture.composer.evaluate(editor => {
          const state = { editor, blurs: 0 };
          (window as unknown as { overlayComposerFocus: typeof state }).overlayComposerFocus = state;
          editor.addEventListener("blur", () => { state.blurs++; });
        });
        const composerFocusBefore = await inspectBrowserTarget(app, fixture.host.windowId, fixture.url);
        const controlBefore = await fixture.control();
        const clicksBefore = (await fixture.readPage()).clicks;
        await expect.poll(fixture.toolReady).toBe(true);
        fixture.requestPageClick();
        await expect.poll(fixture.toolReady).toBe(true);
        expect(await fixture.readPage()).toMatchObject({ clicks: clicksBefore + 1, trusted: true, activation: true });
        await expect(fixture.composer).toHaveValue("Overlay draft 한국어");
        expect(await fixture.composer.evaluate(() => {
          const state = (window as unknown as { overlayComposerFocus: { editor: Element; blurs: number } }).overlayComposerFocus;
          return { active: document.activeElement === state.editor, blurs: state.blurs };
        })).toEqual({ active: true, blurs: 0 });
        expect(await inspectBrowserTarget(app, fixture.host.windowId, fixture.url)).toMatchObject({
          id: fixture.targetId, attached: true, ownerFocused: false,
          focusedHostFrame: composerFocusBefore.focusedHostFrame, focusedContentsId: composerFocusBefore.focusedContentsId,
        });
        expect(await fixture.control()).toMatchObject({ mode: "agent-active", generation: controlBefore.generation, owner: controlBefore.owner });
        await expect(pip).toBeVisible();
        await captureNativeWindow(app, page, testInfo, `composer-with-app-pip-${width}`);
        const pipBox = await pip.boundingBox();
        assert(pipBox);
        await scrollExposedPage(fixture, [pipBox]);
        await expect(pip).toBeVisible();
        await clickExposedAction(fixture, [pipBox]);
        await expect(pip).toBeVisible();
        await typeExposedEditor(fixture, "APP", [pipBox]);
        await expect(pip).toBeVisible();
        expect(await fixture.readPage()).toMatchObject({ heldMoves: 0, unsolicitedUps: 0 });
        await requestMode("fullscreen");
        const fullscreen = page.getByTestId("mcp-app-fullscreen-panel");
        await expect(fullscreen).toBeVisible();
        await expect(pip).toHaveCount(0);
        await expect.poll(async () => (await appState()).some(guest => guest.state.contexts?.at(-1)?.displayMode === "fullscreen")).toBe(true);
        await captureOverlay(fixture, fullscreen, testInfo, `app-fullscreen-${width}`, { overlap: true, fullCover: true });
        const state = await fixture.readPage();
        const point = await fullscreen.boundingBox();
        assert(point);
        await page.mouse.move(point.x + 12, point.y + point.height - 24);
        await page.mouse.wheel(0, 240);
        expect(await fixture.readPage()).toMatchObject({ clicks: state.clicks, wheels: state.wheels, scrollY: state.scrollY });
        const exit = page.getByTestId("mcp-app-fullscreen-exit");
        await exit.focus();
        await exit.press("Enter");
        await expect(fullscreen).toHaveCount(0);
        await expect.poll(async () => (await appState()).some(guest => guest.state.contexts?.at(-1)?.displayMode === "inline")).toBe(true);
        await openPagePoint(fixture);
        expect(await inspectBrowserTarget(app, fixture.host.windowId, fixture.url)).toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });
  }
}
