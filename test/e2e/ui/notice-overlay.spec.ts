import { setWindowSize } from "./seeded-electron.js";
import type { ElectronApplication, Locator } from "playwright";
import { test, expect } from "./fixtures";
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

async function expectAnswerReceivesClick(button: Locator) {
  await expect(button).toBeVisible();
  expect(await button.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  })).toBe(true);
  const target = await button.elementHandle();
  if (!target) throw new Error("Missing answer button");
  await target.evaluate((element) => element.addEventListener("click", () => element.setAttribute("data-answer-clicked", "true"), { once: true }));
  await button.click();
  expect(await target.evaluate((element) => element.getAttribute("data-answer-clicked"))).toBe("true");
  await target.dispose();
}

for (const width of [360, 1243]) {
test(`transient window and composer notices preserve bounds and card access at ${width}px`, async ({ app, mainWindow }, testInfo) => {
  await setWindowSize(app, width, 640);
  await mainWindow.emulateMedia({ reducedMotion: "reduce" });
  const canvas = mainWindow.getByTestId(TEST_IDS.routeCanvas);
  const composer = mainWindow.getByTestId("composer-textarea").first();
  await expect(composer).toBeVisible();
  await mainWindow.evaluate(() => document.fonts.ready);
  const canvasBounds = await canvas.boundingBox();
  const composerBounds = await composer.boundingBox();

  await app.evaluate(({ BrowserWindow }, channel) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, {
      kind: "system", title: "Ready", body: "Window notice", sticky: true,
    });
  }, CHANNELS.notification.toast);
  const strip = mainWindow.getByTestId("window-notice-strip");
  const windowToast = strip.getByTestId("status-toast");
  await expect(windowToast).toBeVisible();
  await expect(windowToast).toHaveCSS("opacity", "1");
  await expect(strip.getByTestId("status-bar-presence")).toHaveCSS("opacity", "1");
  await expect.poll(() => canvas.boundingBox()).toEqual(canvasBounds);
  expect(await composer.boundingBox()).toEqual(composerBounds);
  const geometry = await windowToast.evaluate((toast) => {
    const overlay = toast.parentElement;
    if (!overlay) throw new Error("Missing notice overlay");
    const box = overlay.getBoundingClientRect();
    const card = toast.getBoundingClientRect();
    const x = box.left + 1;
    const y = card.top + card.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      position: getComputedStyle(overlay).position,
      zIndex: getComputedStyle(overlay).zIndex,
      pointerEvents: getComputedStyle(overlay).pointerEvents,
      toastPointerEvents: getComputedStyle(toast).pointerEvents,
      width: card.width,
      available: box.width,
      cardTop: card.top,
      cardLeft: card.left,
      hitInside: toast.contains(document.elementFromPoint(card.left + card.width / 2, card.top + card.height / 2)),
      passedThrough: hit !== null && !overlay.contains(hit),
    };
  });
  expect(geometry).toMatchObject({ position: "absolute", zIndex: "30", pointerEvents: "none", toastPointerEvents: "auto", passedThrough: true });
  expect(geometry.hitInside, JSON.stringify(geometry)).toBe(true);
  expect(geometry.width).toBeLessThanOrEqual(Math.min(geometry.available, 384));
  const sessionId = await mainWindow.evaluate(async () => (await window.aveApi.chatSessions({ kind: "main" })).current);
  if (!sessionId) throw new Error("Missing current session");
  await showApproval(app, sessionId, "window-notice-approval");
  await expect(mainWindow.getByTestId("approval-dock")).toBeVisible();
  const noticeBounds = await windowToast.boundingBox();
  const cardBounds = await mainWindow.getByTestId("approval-dock").boundingBox();
  if (!noticeBounds || !cardBounds) throw new Error("Missing notice or card bounds");
  expect(noticeBounds.y + noticeBounds.height).toBeLessThanOrEqual(cardBounds.y);
  await expectAnswerReceivesClick(mainWindow.getByTestId("approve-button"));
  await app.evaluate(({ BrowserWindow }, channel) => BrowserWindow.getAllWindows()[0]?.webContents.send(channel, { requestId: "window-notice-approval" }), CHANNELS.approval.settled);
  await mainWindow.screenshot({ path: testInfo.outputPath("window-notice-overlay.png") });
  await windowToast.getByTestId("status-toast-dismiss").click();
  await expect(windowToast).toHaveCount(0);
  expect(await canvas.boundingBox()).toEqual(canvasBounds);

  await app.evaluate(({ BrowserWindow }, { channel, chatGroupId }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, { chatGroupId, from: "primary/model", to: "secondary/model" });
  }, { channel: CHANNELS.chat.fallback, chatGroupId: MAIN_CHAT_GROUP_ID });
  const composerToast = mainWindow.getByTestId("composer-toast-dock").getByTestId("status-toast");
  await expect(composerToast).toBeVisible();
  await expect(composerToast).toHaveCSS("opacity", "1");
  expect(await composer.boundingBox()).toEqual(composerBounds);
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  expect(await composerToast.evaluate((toast) => {
    const card = toast.getBoundingClientRect();
    return toast.contains(document.elementFromPoint(card.left + card.width / 2, card.top + card.height / 2));
  })).toBe(true);
  await showApproval(app, sessionId, "composer-notice-approval");
  await expectAnswerReceivesClick(mainWindow.getByTestId("approve-button"));
  await app.evaluate(({ BrowserWindow }, channel) => BrowserWindow.getAllWindows()[0]?.webContents.send(channel, { requestId: "composer-notice-approval" }), CHANNELS.approval.settled);
  await mainWindow.screenshot({ path: testInfo.outputPath("composer-notice-overlay.png") });
  await composerToast.getByTestId("status-toast-dismiss").click();
  await expect(composerToast).toHaveCount(0);
  expect(await composer.boundingBox()).toEqual(composerBounds);
});

}

test("side chat notices float above the composer without moving the transcript", async ({ app, mainWindow: page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId(TEST_IDS.panePanelToggle).click();
  await page.getByTestId(chatSidePanelLauncherTestId("side-chat")).click();
  const side = page.getByTestId("side-chat-view");
  const composer = side.getByTestId("composer-textarea");
  const transcript = side.getByTestId("side-chat-transcript");
  await expect(composer).toBeVisible();
  await app.evaluate(({ ipcMain }, channels) => {
    ipcMain.removeHandler(channels.sidechat.send);
    ipcMain.handle(channels.sidechat.send, (event, payload) => {
      event.sender.send(channels.sidechat.stream, { type: "user_message", text: payload.input, sessionId: "notice-side", streamId: 1, sendRequestId: payload.sendRequestId });
      return { ok: true, result: {} };
    });
  }, CHANNELS);
  await composer.fill("Keep the reading position");
  await side.getByTestId("composer-send-button").click();
  await expect(transcript).toContainText("Keep the reading position");
  const before = { composer: await composer.boundingBox(), transcript: await transcript.boundingBox() };
  await app.evaluate(({ BrowserWindow }, channel) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, { streamId: 1, from: "primary/model", to: "secondary/model" });
  }, CHANNELS.sidechat.fallback);
  const toast = side.getByTestId("status-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCSS("opacity", "1");
  expect(await composer.boundingBox()).toEqual(before.composer);
  expect(await transcript.boundingBox()).toEqual(before.transcript);
  expect(await toast.evaluate((element) => {
    const card = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(card.left + card.width / 2, card.top + card.height / 2));
  })).toBe(true);
  await showApproval(app, "notice-side", "side-notice-approval");
  await expectAnswerReceivesClick(side.getByTestId("approve-button"));
  await page.screenshot({ path: testInfo.outputPath("side-chat-notice-overlay.png") });
  await toast.getByTestId("status-toast-dismiss").click();
  await expect(toast).toHaveCount(0);
  expect(await composer.boundingBox()).toEqual(before.composer);
  expect(await transcript.boundingBox()).toEqual(before.transcript);
});
