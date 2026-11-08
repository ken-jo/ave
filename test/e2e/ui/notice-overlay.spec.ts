import { writeFile } from "node:fs/promises";
import { setWindowSize } from "./seeded-electron.js";
import type { ElectronApplication, Locator } from "playwright";
import { test, expect } from "./fixtures.js";
import { test as providerTest } from "../../screenshots/fixtures.js";
import { CHANNELS, MAIN_CHAT_GROUP_ID } from "../../../src/contract/app-contract.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";

async function showApproval(app: ElectronApplication, sessionId: string, id: string) {
  await app.evaluate(({ BrowserWindow }, { channel, sessionId, id }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, {
      id, sessionId, nonce: id, category: "tool", kind: "tool", toolName: "write_file", toolCategory: "write",
      source: "builtin", trustOrigin: "user-keyboard", args: { path: "/workspace/note.txt", content: "Review" },
      reason: "Confirm the write", createdAt: Date.now(), requireExplicit: false,
    });
  }, { channel: CHANNELS.approval.request, sessionId, id });
}

async function expectControlReceivesClick(button: Locator) {
  await expect(button).toBeVisible();
  expect(await button.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  })).toBe(true);
  const target = await button.elementHandle();
  if (!target) throw new Error("Missing control");
  await target.evaluate((element) => element.addEventListener("click", () => element.setAttribute("data-answer-clicked", "true"), { once: true }));
  await button.click();
  expect(await target.evaluate((element) => element.getAttribute("data-answer-clicked"))).toBe("true");
  await target.dispose();
}

async function showWindowNotice(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }, channel) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, {
      kind: "system", title: "Ready", body: "A sticky window notice with a long message that must leave every control available", sticky: true,
    });
  }, CHANNELS.notification.toast);
}

async function activateView(app: ElectronApplication, viewKey: string) {
  await app.evaluate(({ BrowserWindow }, { channel, viewKey }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, { viewKey });
  }, { channel: CHANNELS.view.activate, viewKey });
}

for (const width of [360, 1243]) {
test(`title bar notices leave every routed toolbar clickable at ${width}px`, async ({ app, mainWindow: page }, testInfo) => {
  await setWindowSize(app, width, 640);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const canvas = page.getByTestId(TEST_IDS.routeCanvas);
  const composer = page.getByTestId("composer-textarea").first();
  await expect(composer).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const canvasBounds = await canvas.boundingBox();
  const composerBounds = await composer.boundingBox();
  const slot = page.getByTestId("window-notice-slot");
  const toast = slot.getByTestId("status-toast");
  const titlebar = page.getByTestId("custom-titlebar-darwin");

  async function checkSlot() {
    await expect(toast).toBeVisible();
    await expect(toast).toHaveCSS("opacity", "1");
    const geometry = await toast.evaluate((element) => {
      const notice = element.getBoundingClientRect();
      const slot = element.closest('[data-testid="main-toolbar-drag-band"]');
      const band = element.closest('[data-testid^="custom-titlebar"]');
      if (!slot || !band) throw new Error("Notice is outside the title bar slot");
      const free = slot.getBoundingClientRect();
      const bar = band.getBoundingClientRect();
      return {
        left: notice.left, right: notice.right, top: notice.top, bottom: notice.bottom,
        width: notice.width, height: notice.height, freeLeft: free.left, freeRight: free.right,
        bandTop: bar.top, bandBottom: bar.bottom,
        region: getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        slotRegion: getComputedStyle(slot).getPropertyValue("-webkit-app-region"),
        transform: getComputedStyle(element).transform,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.freeLeft);
    expect(geometry.right).toBeLessThanOrEqual(geometry.freeRight);
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.bandTop);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.bandBottom);
    expect(geometry.height).toBeLessThanOrEqual(28);
    expect(geometry.width).toBeLessThanOrEqual(384);
    expect(geometry).toMatchObject({ region: "no-drag", slotRegion: "drag", transform: "none" });
    await expect(toast.getByRole("button", { name: /Learn more|자세히 알아보기/ })).toBeVisible();
    await expect(toast.getByTestId("status-toast-dismiss")).toBeVisible();
    expect(await canvas.boundingBox()).toEqual(canvasBounds);
  }

  await showWindowNotice(app);
  await checkSlot();
  const header = page.locator('[data-testid="pane-header"]:visible');
  await expectControlReceivesClick(header.getByTestId("pane-action-conversation.pin"));
  await expect(header.getByTestId("pane-action-conversation.unpin")).toBeVisible();
  expect(await composer.boundingBox()).toEqual(composerBounds);
  const titleControl = page.getByTestId("bootstrap-status-pill");
  await expectControlReceivesClick(titleControl);
  await expect(titleControl).toHaveCount(0);
  // The notice uses only spare title-bar width, including after a status chip disappears.
  await checkSlot();
  if (width >= 640) {
    await expectControlReceivesClick(page.getByTestId("dev-tools-toggle"));
    await expect(page.getByTestId("dev-tools-panel")).toBeVisible();
    await page.getByTestId("dev-tools-panel").getByRole("button", { name: /Close|닫기/ }).click();
  }
  await page.screenshot({ path: testInfo.outputPath("window-notice-conversation.png") });
  const sessionId = await page.evaluate(async () => (await window.aveApi.chatSessions({ kind: "main" })).current);
  if (!sessionId) throw new Error("Missing current session");
  await showApproval(app, sessionId, "window-notice-approval");
  const card = page.getByTestId("approval-dock");
  await expect(card).toBeVisible();
  const noticeBounds = await toast.boundingBox();
  const cardBounds = await card.boundingBox();
  if (!noticeBounds || !cardBounds) throw new Error("Missing notice or card bounds");
  expect(noticeBounds.y + noticeBounds.height).toBeLessThanOrEqual(cardBounds.y);
  await expectControlReceivesClick(page.getByTestId("approve-button"));
  await app.evaluate(({ BrowserWindow }, channel) => BrowserWindow.getAllWindows()[0]?.webContents.send(channel, { requestId: "window-notice-approval" }), CHANNELS.approval.settled);
  await toast.getByTestId("status-toast-dismiss").click();
  await expect(toast).toHaveCount(0);
  expect(await canvas.boundingBox()).toEqual(canvasBounds);

  for (const route of ["settings", "work-board", "web"]) {
    await activateView(app, route);
    const control = route === "settings" ? page.getByRole("searchbox")
      : route === "work-board" ? page.getByTestId("work-board-show-schedule")
      : page.getByTestId("web-panel-address");
    await expect(control).toBeVisible();
    const controlBounds = await control.boundingBox();
    const headerBounds = await page.locator('[data-testid="pane-header"]:visible').boundingBox();
    await showWindowNotice(app);
    await checkSlot();
    expect(await control.boundingBox()).toEqual(controlBounds);
    expect(await page.locator('[data-testid="pane-header"]:visible').boundingBox()).toEqual(headerBounds);
    await expectControlReceivesClick(control);
    if (route !== "work-board") await expect(control).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`window-notice-${route}.png`) });
    // Both history controls remain live while the sticky notice follows navigation.
    await expectControlReceivesClick(page.getByTestId(TEST_IDS.viewPathBack));
    await expectControlReceivesClick(page.getByTestId("view-path-forward"));
    await expect(control).toBeVisible();
    await expect(toast).toBeVisible();
    await toast.getByTestId("status-toast-dismiss").click();
    await expect(toast).toHaveCount(0);
    expect(await canvas.boundingBox()).toEqual(canvasBounds);
    expect(await control.boundingBox()).toEqual(controlBounds);
  }

  await activateView(app, "home");
  await expect(composer).toBeVisible();
  await app.evaluate(({ BrowserWindow }, { channel, chatGroupId }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, { chatGroupId, from: "primary/model", to: "secondary/model" });
  }, { channel: CHANNELS.chat.fallback, chatGroupId: MAIN_CHAT_GROUP_ID });
  const composerToast = page.getByTestId("composer-toast-dock").getByTestId("status-toast");
  await expect(composerToast).toBeVisible();
  await expect(composerToast).toHaveCSS("opacity", "1");
  expect(await composer.boundingBox()).toEqual(composerBounds);
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  const localNoticeBounds = await composerToast.boundingBox();
  const headerBounds = await header.boundingBox();
  if (!localNoticeBounds || !headerBounds || !composerBounds) throw new Error("Missing conversation bounds");
  expect(localNoticeBounds.y).toBeGreaterThanOrEqual(headerBounds.y + headerBounds.height);
  expect(localNoticeBounds.y + localNoticeBounds.height).toBeLessThanOrEqual(composerBounds.y);
  await expectControlReceivesClick(header.getByTestId("pane-action-conversation.unpin"));
  await showApproval(app, sessionId, "composer-notice-approval");
  await expectControlReceivesClick(page.getByTestId("approve-button"));
  await app.evaluate(({ BrowserWindow }, channel) => BrowserWindow.getAllWindows()[0]?.webContents.send(channel, { requestId: "composer-notice-approval" }), CHANNELS.approval.settled);
  await page.screenshot({ path: testInfo.outputPath("composer-notice-overlay.png") });
  await composerToast.getByTestId("status-toast-dismiss").click();
  await expect(composerToast).toHaveCount(0);
  expect(await composer.boundingBox()).toEqual(composerBounds);
  await showWindowNotice(app);
  const sidebarToggle = titlebar.locator('[data-testid="sidebar-show"], [data-testid="sidebar-collapse-toggle"]');
  if (await sidebarToggle.count()) {
    await expectControlReceivesClick(sidebarToggle);
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-sidebar-state", "expanded");
  }
});
}

for (const zoomLevel of [1, 2]) {
  test(`combined update offers keep sticky notice controls reachable at 360px and zoom ${zoomLevel}`, async ({ app, mainWindow: page }, testInfo) => {
    await setWindowSize(app, 360, 640);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(async (zoomLevel) => {
      await window.aveApi.updateSettings({ appearance: { zoomLevel } });
    }, zoomLevel);
    await expect(page.getByTestId("zoom-indicator")).toBeVisible();
    await activateView(app, "settings");
    await expect(page.getByRole("searchbox")).toBeVisible();
    await app.evaluate(({ BrowserWindow }, channels) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      contents?.send(channels.update.state, { kind: "available", version: "9.9.9" });
      contents?.send(channels.marketplace.updatesAvailable, [{
        key: { sourceId: "ave", kind: "plugin", name: "notice-update" },
        displayName: "Notice update", from: "1.0.0", to: "2.0.0", state: "manual",
      }]);
      contents?.send(channels.plugins.installResult, {
        slug: "notice-install", success: false, error: "install-failed", message: "The install could not finish. Review the settings and try again.",
      });
    }, CHANNELS);
    const slot = page.getByTestId("window-notice-slot");
    const toast = slot.getByTestId("status-toast");
    await expect(toast).toHaveAttribute("data-severity", "error");
    await expect(page.getByTestId("marketplace-update-action")).toBeVisible();
    await expect(page.getByTestId("app-update-badge-available")).toBeVisible();
    const assertUnclippedHit = async (control: Locator) => {
      const hit = await control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        let clipped = false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const bounds = parent.getBoundingClientRect();
          if (style.overflowX !== "visible" && (box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5)) clipped = true;
        }
        return { width: box.width, height: box.height,
          hit: element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
          left: box.left, right: box.right, viewport: window.innerWidth, clipped,
        };
      });
      expect(hit.width).toBeGreaterThan(0);
      expect(hit.height).toBeGreaterThan(0);
      expect(hit.left).toBeGreaterThanOrEqual(0);
      expect(hit.right).toBeLessThanOrEqual(hit.viewport);
      expect(hit.clipped, JSON.stringify(hit)).toBe(false);
      expect(hit.hit, JSON.stringify(hit)).toBe(true);
    };
    const updateStyle = await page.getByTestId("app-update-badge-available").evaluate((element) => {
      const icon = element.querySelector("svg");
      if (!icon) throw new Error("Missing compact update icon");
      const box = icon.getBoundingClientRect();
      return { iconWidth: box.width, iconHeight: box.height, color: getComputedStyle(icon).color,
        background: getComputedStyle(element).backgroundColor, opacity: getComputedStyle(icon).opacity };
    });
    expect(updateStyle.iconWidth).toBeGreaterThan(0);
    expect(updateStyle.iconHeight).toBeGreaterThan(0);
    const stylePath = testInfo.outputPath("compact-update-style.json");
    await writeFile(stylePath, JSON.stringify(updateStyle, null, 2));
    await testInfo.attach("compact-update-style", { path: stylePath, contentType: "application/json" });
    const dismiss = toast.getByTestId("status-toast-dismiss");
    await assertUnclippedHit(dismiss);
    await assertUnclippedHit(page.getByTestId("app-update-badge-available"));
    await assertUnclippedHit(page.getByTestId(TEST_IDS.viewPathBack));
    await expectControlReceivesClick(page.getByTestId(TEST_IDS.viewPathBack));
    await expect(page.getByTestId("composer-textarea").first()).toBeVisible();
    await expect(toast).toBeVisible();
    expect(await toast.getAttribute("title")).toBe(await page.getByTestId("window-notice-strip").getByTestId("notice-live-assertive").textContent());
    // Capture the physical content bounds: page screenshots crop when the shell is zoomed.
    const capture = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("Missing main window");
      const image = await win.webContents.capturePage();
      return { png: image.toPNG().toString("base64"), size: image.getSize(), bounds: win.getContentBounds() };
    });
    expect(capture.size).toEqual({ width: 360, height: 640 });
    expect(capture.bounds.width).toBe(360);
    await writeFile(testInfo.outputPath(`notice-controls-360-zoom-${zoomLevel}.png`), Buffer.from(capture.png, "base64"));
    const pluginUpdate = page.getByTestId("marketplace-update-action");
    await pluginUpdate.scrollIntoViewIfNeeded();
    await assertUnclippedHit(pluginUpdate);
    await assertUnclippedHit(dismiss);
    await expectControlReceivesClick(dismiss);
    await expect(toast).toHaveCount(0);
    // The optional open action has the same hard control floor as dismissal.
    await showWindowNotice(app);
    await expect(toast).toBeVisible();
    await assertUnclippedHit(toast.getByRole("button", { name: /Learn more|자세히 알아보기/ }));
    await assertUnclippedHit(dismiss);
    await expectControlReceivesClick(dismiss);
    await expect(toast).toHaveCount(0);
  });
}

providerTest.describe("side-chat notice delivery", () => {
  providerTest.use({
    reviewerMode: "disabled",
    executionMode: "default",
    scriptedScript: {
      unavailableModels: ["unavailable-model"],
      turns: [
        { expect: "assistant", parts: [{ kind: "tool", id: "notice-side-question", name: "ask_user_question", input: {
          questions: [{ question: "Continue the side conversation?", choices: ["Continue", "Stop"] }],
        } }] },
        { expect: "assistant", parts: [{ kind: "text", text: "Recorded side answer." }] },
      ],
    },
  });

  for (const width of [360, 1243]) {
    providerTest(`real fallback and question delivery preserve the side chat at ${width}px`, async ({ app, mainWindow: page, scriptedProvider }, testInfo) => {
      if (!scriptedProvider) throw new Error("Missing scripted provider");
      await setWindowSize(app, width, 640);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(async () => {
        const current = await window.aveApi.getSettings();
        const result = await window.aveApi.updateSettings({ llm: {
          vendors: { ...current.llm.vendors, "openai-compatible": {
            ...current.llm.vendors["openai-compatible"], model: "unavailable-model",
          } },
          fallbackChain: [{ provider: "openai-compatible", model: "local-model" }],
        } });
        if ("ok" in result && !result.ok) throw new Error(result.error);
      });
      await expect(page.locator('[data-composer-surface="main"] [data-testid="iab-status-model"]')).toContainText("unavailable-model");
      await page.getByTestId(TEST_IDS.panePanelToggle).click();
      await page.getByTestId(chatSidePanelLauncherTestId("side-chat")).click();
      const side = page.getByTestId("side-chat-view");
      const composer = side.getByTestId("composer-textarea");
      const transcript = side.getByTestId("side-chat-transcript");
      await expect(composer).toBeVisible();
      const before = { composer: await composer.boundingBox(), transcript: await transcript.boundingBox() };
      await composer.fill("Keep the reading position");
      await side.getByTestId("composer-send-button").click();
      const toast = side.getByTestId("status-toast");
      const card = side.getByTestId("ask-user-question-card");
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(toast).toBeVisible();
      await expect(toast).toContainText("unavailable-model");
      await expect(toast).toContainText("local-model");
      expect(await composer.boundingBox()).toEqual(before.composer);
      expect(await transcript.boundingBox()).toEqual(before.transcript);
      const newSession = side.getByTestId("side-chat-new");
      const toolbarBounds = await newSession.boundingBox();
      const contentBounds = await side.getByTestId("side-chat-content").boundingBox();
      const toastBounds = await toast.boundingBox();
      if (!toolbarBounds || !contentBounds || !toastBounds || !before.composer) throw new Error("Missing side chat bounds");
      expect(contentBounds.y).toBeGreaterThanOrEqual(toolbarBounds.y + toolbarBounds.height);
      expect(toastBounds.y).toBeGreaterThanOrEqual(contentBounds.y);
      expect(toastBounds.y + toastBounds.height).toBeLessThanOrEqual(before.composer.y);
      await expectControlReceivesClick(page.getByRole("tab", { name: /Side chat/ }));
      const answer = card.getByRole("option", { name: "Continue", exact: true });
      expect(await answer.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      })).toBe(true);
      const overlap = await card.evaluate((element) => {
        const notice = element.closest('[data-testid="side-chat-view"]')?.querySelector('[data-testid="status-toast"]');
        if (!notice) throw new Error("Missing concurrent notice");
        const toastBox = notice.getBoundingClientRect();
        const cardBox = element.getBoundingClientRect();
        const left = Math.max(toastBox.left, cardBox.left);
        const right = Math.min(toastBox.right, cardBox.right);
        const top = Math.max(toastBox.top, cardBox.top);
        const bottom = Math.min(toastBox.bottom, cardBox.bottom);
        const overlaps = left < right && top < bottom;
        return { overlaps, cardOwnsHit: overlaps && element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)) };
      });
      expect(overlap).toEqual({ overlaps: true, cardOwnsHit: true });
      await page.screenshot({ path: testInfo.outputPath("side-chat-notice-and-question.png") });
      await answer.click();
      await expect(card).toHaveCount(0);
      await expect(transcript).toContainText("Recorded side answer.", { timeout: 30_000 });
      const fallbackIndex = scriptedProvider.requestedModels.indexOf("local-model");
      expect(fallbackIndex).toBeGreaterThan(0);
      expect(scriptedProvider.requestedModels.slice(0, fallbackIndex).every((model) => model === "unavailable-model")).toBe(true);
      const answeredQuestion = scriptedProvider.toolResponses.map((response) => JSON.parse(response) as { tool_call_id: string; content: unknown })
        .find((response) => response.tool_call_id === "notice-side-question");
      expect(JSON.stringify(answeredQuestion?.content)).toContain("Continue");
      expect(scriptedProvider.violations).toEqual([]);
      await testInfo.attach("provider-delivery", { body: JSON.stringify({
        requestedModels: scriptedProvider.requestedModels, toolResponses: scriptedProvider.toolResponses,
      }, null, 2), contentType: "application/json" });
      await toast.getByTestId("status-toast-dismiss").click();
      await expect(toast).toHaveCount(0);
      expect(await composer.boundingBox()).toEqual(before.composer);
      expect(await transcript.boundingBox()).toEqual(before.transcript);
    });
  }
});
