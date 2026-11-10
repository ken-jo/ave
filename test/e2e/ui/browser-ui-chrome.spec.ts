import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";
import { AVE_SIDE_BROWSER_PARTITION } from "../../../src/shared/side-browser.js";
import { VIEW_FIXTURE } from "../../fixtures/e2e-plugins/view-fixture.js";
import { writeFixturePlugin, writeFixtureRegistry } from "../../fixtures/e2e-plugins/seed.js";
import { inspectBrowserTarget } from "./browser-native-target.js";
import { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { captureOverlay, clickExposedAction, nativePageHole, scrollExposedPage, settleOverlayLayout, typeExposedEditor, type UiLayerFixture } from "./browser-ui-overlay-fixtures.js";
import { captureNativeWindow, prepareNativeWindowCapture, sampleNativeWindow } from "./native-window-capture.js";
import { setWindowSize } from "./seeded-electron.js";

async function showMainPage(fixture: UiLayerFixture, width: number) {
  await setWindowSize(fixture.app, 900, 800);
  await fixture.page.locator(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${fixture.rendererTabId}"]`)
    .getByTestId("chat-side-panel-move-to-main").click();
  await expect(fixture.page.getByTestId("web-panel")).toBeVisible();
  await expect(nativePageHole(fixture)).toBeVisible();
  await setWindowSize(fixture.app, width, 800);
  await settleOverlayLayout(fixture);
}

if (process.platform === "darwin") {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => { await prepareNativeWindowCapture(testInfo); });
  for (const width of [1360, 900]) {
    test(`main browser tooltip and keyboard reload preserve the native page at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width);
      try {
        await fixture.clickFromAgent();
        await fixture.finishTurn();
        await showMainPage(fixture, width);
        const reload = fixture.page.getByTestId("web-panel-reload");
        await reload.hover();
        const tooltip = fixture.page.getByRole("tooltip", { name: /^(Reload|새로고침)$/ });
        await captureOverlay(fixture, tooltip, testInfo, `main-navigation-tooltip-${width}`, { overlap: false });
        await fixture.page.keyboard.press("Escape");
        await expect(tooltip).toHaveCount(0);
        await fixture.page.getByTestId("web-panel-address").focus();
        await fixture.page.keyboard.press("Shift+Tab");
        await expect(reload).toBeFocused();
        await expect(tooltip).toBeVisible();
        await reload.press("Enter");
        await expect.poll(() => fixture.readPage().then(state => state.clicks).catch(() => null)).toBe(0);
        await clickExposedAction(fixture);
        await scrollExposedPage(fixture);
        await typeExposedEditor(fixture, "TOOLTIP");
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url))
          .toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });

    test(`sidebar plugin flyout stays above the main browser at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width, {
        prepareHome: async home => writeFixtureRegistry(home, [await writeFixturePlugin(home, VIEW_FIXTURE)]),
        admitPreparedPlugins: true,
      });
      const { page } = fixture;
      try {
        await fixture.clickFromAgent();
        await fixture.finishTurn();
        await showMainPage(fixture, width);
        const fold = page.getByTestId("sidebar-collapse-toggle");
        await expect(fold).toHaveAttribute("aria-pressed", "true");
        await fold.click();
        await expect(page.getByTestId("sidebar-collapse-toggle")).toHaveAttribute("aria-pressed", "false");
        await settleOverlayLayout(fixture);
        const trigger = page.getByTestId("sidebar-group-plugins");
        await trigger.click();
        const menu = page.getByTestId("sidebar-group-plugins-menu");
        await expect(menu).toHaveRole("menu");
        await captureOverlay(fixture, menu, testInfo, `sidebar-group-flyout-${width}`, { overlap: true });
        const bounds = await menu.boundingBox();
        assert(bounds);
        await scrollExposedPage(fixture, [bounds]);
        await expect(menu).toBeVisible();
        await clickExposedAction(fixture, [bounds]);
        await expect(menu).toHaveCount(0);
        await trigger.focus();
        await trigger.press("Enter");
        await expect(menu).toBeVisible();
        const item = menu.getByRole("menuitem", { name: "View Fixture", exact: true });
        await page.keyboard.press("End");
        await page.keyboard.press("Home");
        await expect(item).toBeFocused();
        await page.evaluate(() => {
          const probe = window as unknown as { chromePointerProbe: unknown[] };
          probe.chromePointerProbe = [];
          for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "focusin", "focusout", "keydown", "keyup"]) {
            for (const capture of [true, false]) document.addEventListener(type, event => {
              if (probe.chromePointerProbe.length >= 100) return;
              const target = event.target instanceof Element ? event.target : null;
              probe.chromePointerProbe.push({ type: event.type, capture, trusted: event.isTrusted, prevented: event.defaultPrevented,
                target: target?.tagName, testId: target?.closest("[data-testid]")?.getAttribute("data-testid"),
                x: event instanceof MouseEvent ? event.clientX : null, y: event instanceof MouseEvent ? event.clientY : null,
                key: event instanceof KeyboardEvent ? event.key : null });
            }, capture);
          }
        });
        await typeExposedEditor(fixture, "FLYOUT", [bounds]);
        const diagnostic = await page.evaluate(() => ({
          events: (window as unknown as { chromePointerProbe: unknown[] }).chromePointerProbe,
          active: document.activeElement?.getAttribute("data-testid"),
          menu: (() => { const node = document.querySelector('[data-testid="sidebar-group-plugins-menu"]');
            const rect = node?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null; })(),
        }));
        const diagnosticPath = testInfo.outputPath(`sidebar-group-flyout-${width}-outside-input.json`);
        await fs.writeFile(diagnosticPath, JSON.stringify({ initialBounds: bounds, ...diagnostic, page: await fixture.readPage() }, null, 2));
        await testInfo.attach(`sidebar-group-flyout-${width}-outside-input`, { path: diagnosticPath, contentType: "application/json" });
        await expect(menu).toHaveCount(0);
        await trigger.focus();
        await trigger.press("Enter");
        await page.keyboard.press("End");
        await page.keyboard.press("Home");
        await expect(item).toBeFocused();
        await item.press("Enter");
        await expect(menu).toHaveCount(0);
        await expect(page.getByTestId("web-panel")).toHaveCount(0);
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url)).toMatchObject({ id: fixture.targetId, attached: false });
        await page.getByTestId("sidebar-collapse-toggle").click();
        await page.getByTestId(`sidebar-surface-${fixture.rendererTabId}`).click();
        await expect(nativePageHole(fixture)).toBeVisible();
        expect(await fixture.readPage()).toMatchObject({ clicks: 2, value: "FLYOUT", inputTrusted: true });
      } finally { await fixture.close(); }
    });

    test(`real missing credential popover stays usable beside the page at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width);
      const { page } = fixture;
      try {
        await fixture.clickFromAgent();
        await fixture.finishTurn();
        await fixture.composer.fill("Retain this draft until a credential is configured.");
        expect(await page.evaluate(() => window.aveApi.hasApiKey("openai"))).toBe(false);
        expect(await page.evaluate(() => window.aveApi.updateSettings({ llm: { provider: "openai" } })))
          .toMatchObject({ llm: { provider: "openai" } });
        const chip = page.getByTestId("composer-api-key-chip");
        if (!await chip.isVisible()) await fixture.composer.press("Enter");
        await expect(chip).toBeVisible();
        await chip.click();
        const popover = page.getByTestId("composer-api-key-popover");
        await expect(popover).toHaveRole("dialog");
        // The missing-key strip expands the composer reservation beneath the floating page.
        await captureOverlay(fixture, popover, testInfo, `runtime-issue-popover-${width}`, { overlap: false });
        const bounds = await popover.boundingBox();
        assert(bounds);
        await scrollExposedPage(fixture, [bounds]);
        await expect(popover).toBeVisible();
        await clickExposedAction(fixture, [bounds]);
        await expect(popover).toHaveCount(0);
        await chip.focus();
        await chip.press("Enter");
        await expect(popover).toBeVisible();
        const settings = page.getByTestId("composer-api-key-chip:settings");
        const marketplace = page.getByTestId("composer-api-key-chip:marketplace");
        await expect(settings).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(marketplace).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(settings).toBeFocused();
        const reopenedBounds = await popover.boundingBox();
        assert(reopenedBounds);
        await typeExposedEditor(fixture, "RUNTIME", [reopenedBounds]);
        await expect(popover).toHaveCount(0);
        await chip.focus();
        await chip.press("Enter");
        await expect(popover).toBeVisible();
        await expect(settings).toBeFocused();
        await settings.press("Enter");
        await expect(page.locator("[data-settings-layout]")).toBeVisible();
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url)).toMatchObject({ id: fixture.targetId, attached: false, ownerFocused: false });
      } finally { await fixture.close(); }
    });

    test(`user-opened webview retains input and workspace controls at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchUiLayerFixture(width);
      const { app, page } = fixture;
      try {
        await fixture.clickFromAgent();
        await fixture.finishTurn();
        await page.getByTestId("chat-side-panel-add-tab").click();
        await page.getByTestId("chat-side-panel-launcher-menu-browser").click();
        const workspace = page.getByTestId("chat-side-panel-browser-workspace");
        const address = workspace.getByTestId("chat-side-panel-browser-address");
        const userUrl = `${fixture.url}#user-page`;
        await address.fill(userUrl);
        await address.press("Enter");
        const view = page.getByTestId("chat-side-panel-browser-webview");
        await expect(view).toBeVisible();
        await expect(view).toHaveAttribute("src", userUrl);
        const guestId = await view.evaluate(element => (element as unknown as { getWebContentsId(): number }).getWebContentsId());
        const userId = await view.getAttribute("data-tab-id");
        assert(userId);
        expect(await app.evaluate(({ webContents, session }, input) => {
          const guest = webContents.fromId(input.id);
          if (!guest) throw new Error("User browser guest unavailable");
          if (!("getLastWebPreferences" in guest) || typeof guest.getLastWebPreferences !== "function") {
            throw new Error("User browser preferences unavailable");
          }
          return { type: guest.getType(), hostId: guest.hostWebContents?.id,
            sharedSession: guest.session === session.fromPartition(input.partition), preferences: guest.getLastWebPreferences() };
        }, { id: guestId, partition: AVE_SIDE_BROWSER_PARTITION })).toMatchObject({ type: "webview", hostId: fixture.host.chromeId,
          sharedSession: true, preferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
        const userControl = () => page.evaluate(async id => {
          const tabs = window.aveApi.browserTabs;
          if (!tabs) throw new Error("User browser controls unavailable");
          return (await tabs.getState()).tabs.find(tab => tab.rendererTabId === id);
        }, userId);
        await expect.poll(() => userControl().then(control => control?.mode)).toBe("human");
        expect(await userControl())
          .toMatchObject({ owner: null, lease: null });
        const readUser = () => app.evaluate(async ({ webContents }, id) => {
          const guest = webContents.fromId(id);
          if (!guest) throw new Error("User browser guest unavailable");
          return guest.executeJavaScript("({...window.fixtureState,scrollY})");
        }, guestId);
        await expect.poll(() => readUser().then(state => state.clicks)).toBe(0);
        const rect = await view.boundingBox();
        assert(rect);
        await workspace.getByTestId("browser-capture-menu").click();
        const menu = page.getByRole("menu").filter({ has: page.getByTestId("browser-capture-viewport") });
        await expect(menu).toBeVisible();
        const menuRect = await menu.boundingBox();
        assert(menuRect);
        const left = Math.max(rect.x, menuRect.x), right = Math.min(rect.x + rect.width, menuRect.x + menuRect.width);
        const top = Math.max(rect.y, menuRect.y), bottom = Math.min(rect.y + rect.height, menuRect.y + menuRect.height);
        expect((right - left) * (bottom - top)).toBeGreaterThan(0);
        const capture = await captureNativeWindow(app, page, testInfo, `retained-user-host-${width}`);
        const points = [{ x: (left + right) / 2, y: (top + bottom) / 2 }, { x: rect.x + 12, y: rect.y + rect.height - 30 }];
        const pixels = await sampleNativeWindow(app, capture, points);
        const geometryPath = testInfo.outputPath(`retained-user-host-${width}-geometry.json`);
        await fs.writeFile(geometryPath, JSON.stringify({ pageRect: rect, overlayRect: menuRect, points, pixels, guestId, userId }, null, 2));
        await testInfo.attach(`retained-user-host-${width}-geometry`, { path: geometryPath, contentType: "application/json" });
        expect(pixels[0]).not.toEqual([180, 0, 200, 255]);
        expect(pixels[1]).toEqual([180, 0, 200, 255]);
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        await page.mouse.click(rect.x + 32, rect.y + 104);
        await expect.poll(() => readUser().then(state => state.clicks)).toBe(1);
        expect(await readUser()).toMatchObject({ trusted: true, activation: true });
        await page.mouse.move(rect.x + 12, rect.y + rect.height - 30);
        await page.mouse.wheel(0, 240);
        await expect.poll(() => readUser().then(state => state.scrollY)).toBeGreaterThan(0);
        expect((await readUser()).wheels).toBeGreaterThan(0);
        await page.mouse.wheel(0, -240);
        await expect.poll(() => readUser().then(state => state.scrollY)).toBe(0);
        await page.mouse.click(rect.x + 32, rect.y + 182);
        await app.evaluate(({ webContents }, id) => {
          const guest = webContents.fromId(id);
          if (!guest) throw new Error("User browser keyboard target unavailable");
          for (const key of "USER") {
            guest.sendInputEvent({ type: "keyDown", keyCode: key });
            guest.sendInputEvent({ type: "char", keyCode: key });
            guest.sendInputEvent({ type: "keyUp", keyCode: key });
          }
        }, guestId);
        await expect.poll(() => readUser().then(state => state.value)).toBe("USER");
        expect(await readUser()).toMatchObject({ inputTrusted: true });
        await workspace.getByTestId("browser-workspace-toggle").click();
        const tools = workspace.getByTestId("browser-workspace-panel");
        const zoom = tools.getByRole("combobox", { name: /^(Zoom|확대)$/ });
        await zoom.selectOption("1.25");
        await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor(), guestId)).toBe(1.25);
        await zoom.selectOption("1");
        await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor(), guestId)).toBe(1);
        await app.evaluate(({ webContents }, id) => {
          const guest = webContents.fromId(id);
          if (!guest) throw new Error("User browser find target unavailable");
          const probe = globalThis as unknown as { userBrowserFind: { matches: number } | null };
          probe.userBrowserFind = null;
          guest.on("found-in-page", (_event, result) => { if (result.finalUpdate) probe.userBrowserFind = { matches: result.matches }; });
        }, guestId);
        const find = tools.getByRole("textbox", { name: /^(Find|찾기)$/ });
        await find.fill("Page action");
        await find.press("Enter");
        await expect.poll(() => app.evaluate(() => (globalThis as unknown as { userBrowserFind: { matches: number } | null }).userBrowserFind?.matches)).toBe(1);
        await expect(tools.getByRole("alert")).toHaveCount(0);
        await tools.getByRole("button", { name: /^(Clear find|찾기 지우기)$/ }).click();
        await expect(find).toHaveValue("");
        await workspace.getByTestId("browser-workspace-toggle").click();
        await address.fill(`${fixture.url}#user-next`);
        await address.press("Enter");
        await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), guestId)).toBe(`${fixture.url}#user-next`);
        await workspace.getByTestId("browser-back").click();
        await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), guestId)).toBe(userUrl);
        await workspace.getByTestId("browser-reload").click();
        await expect.poll(() => readUser().then(state => state.value).catch(() => null)).toBe("");
        await page.locator(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${fixture.rendererTabId}"]`).getByRole("tab").click();
        await expect(nativePageHole(fixture)).toBeVisible();
        expect(await fixture.readPage()).toMatchObject({ clicks: 1 });
        await page.locator(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${userId}"]`).getByRole("tab").click();
        await expect(view).toBeVisible();
        expect(await view.evaluate(element => (element as unknown as { getWebContentsId(): number }).getWebContentsId())).toBe(guestId);
        expect(await inspectBrowserTarget(app, fixture.host.windowId, fixture.url)).toMatchObject({ id: fixture.targetId, attached: false, ownerFocused: false });
      } finally { await fixture.close(); }
    });
  }
}
