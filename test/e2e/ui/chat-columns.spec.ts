import { test, expect } from "./fixtures.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { MIN_DOCKED_TRANSCRIPT_WIDTH } from "../../../src/shared/shell-geometry.js";

test("session columns push the transcript, restore toggles, and yield at narrow widths", async ({ mainWindow: page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const thumbnailsToggle = page.getByTestId(TEST_IDS.paneThumbnailToggle);
  const panelToggle = page.getByTestId(TEST_IDS.panePanelToggle);
  const thumbnails = page.getByTestId("chat-thumbnail-column");
  const panel = page.getByTestId("chat-side-panel-motion");
  const chat = page.getByTestId("chat-main-column");
  await expect(thumbnailsToggle).toHaveAttribute("aria-pressed", "false");
  const fullWidth = (await chat.boundingBox())!.width;
  await thumbnailsToggle.click();
  await expect(thumbnails).toBeVisible();
  await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await chat.boundingBox())!.width).toBeLessThan(fullWidth - 270);
  const twoColumnWidth = (await chat.boundingBox())!.width;
  await panelToggle.click();
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await expect.poll(async () => (await chat.boundingBox())!.width).toBeLessThan(twoColumnWidth - 400);
  await expect.poll(async () => {
    const thumbnailBox = (await thumbnails.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    return panelBox.x - thumbnailBox.x - thumbnailBox.width;
  }).toBeGreaterThanOrEqual(-1);
  const boxes = { chat: (await chat.boundingBox())!, thumbnails: (await thumbnails.boundingBox())!, panel: (await panel.boundingBox())! };
  expect(boxes.chat.width).toBeGreaterThanOrEqual(MIN_DOCKED_TRANSCRIPT_WIDTH);
  expect(boxes.thumbnails.x).toBeGreaterThanOrEqual(boxes.chat.x + boxes.chat.width - 1);
  expect(boxes.panel.x).toBeGreaterThanOrEqual(boxes.thumbnails.x + boxes.thumbnails.width - 1);
  await testInfo.attach("three-chat-columns.png", { body: await page.screenshot({ path: testInfo.outputPath("three-chat-columns.png") }), contentType: "image/png" });

  await thumbnailsToggle.click();
  await expect(thumbnails).toHaveCount(0);
  await expect(panelToggle).toHaveAttribute("aria-pressed", "true");
  await thumbnailsToggle.click();
  await expect.poll(async () => {
    const thumbnailBox = (await thumbnails.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    return panelBox.x - thumbnailBox.x - thumbnailBox.width;
  }).toBeGreaterThanOrEqual(-1);
  await panelToggle.click();
  // Read the durable settings through the same public bridge the renderer uses.
  await expect.poll(() => page.evaluate(async () => {
    const settings = await window.aveApi.getSettings();
    return { thumbnails: settings.system?.mainLayout?.thumbnailOpenIds, panels: settings.system?.mainLayout?.panelOpenIds };
  })).toEqual({ thumbnails: ["main"], panels: [] });
  await page.reload();
  await expect(thumbnailsToggle).toHaveAttribute("aria-pressed", "true");
  await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
  await panelToggle.click();

  await page.setViewportSize({ width: 1100, height: 820 });
  await expect(thumbnails).toHaveCount(0);
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await expect(thumbnailsToggle).toHaveAttribute("aria-disabled", "true");
  await expect(thumbnailsToggle).toHaveAttribute("aria-pressed", "false");
  await expect(panelToggle).toHaveAttribute("aria-disabled", "false");
  await thumbnailsToggle.dispatchEvent("click");
  await expect(thumbnailsToggle).toHaveAttribute("aria-disabled", "true");
  await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThanOrEqual(MIN_DOCKED_TRANSCRIPT_WIDTH);
  await page.setViewportSize({ width: 900, height: 720 });
  await expect(thumbnails).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await expect(panel).toHaveAttribute("data-panel-mode", "overlay");
  await expect(thumbnailsToggle).toHaveAttribute("aria-pressed", "false");
  await expect(panelToggle).toHaveAttribute("aria-pressed", "true");
  await expect(panelToggle).toHaveAttribute("aria-disabled", "false");
  // Floating the requested panel preserves the transcript's full tile width.
  const pane = page.getByTestId("pane");
  await expect.poll(async () => {
    const paneBox = (await pane.boundingBox())!;
    const chatBox = (await chat.boundingBox())!;
    return Math.abs(paneBox.width - chatBox.width);
  }).toBeLessThanOrEqual(2);
  await expect.poll(async () => {
    const paneBox = (await pane.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    return panelBox.x >= paneBox.x - 1
      && panelBox.y >= paneBox.y - 1
      && panelBox.x + panelBox.width <= paneBox.x + paneBox.width + 1
      && panelBox.y + panelBox.height <= paneBox.y + paneBox.height + 1;
  }).toBe(true);
  await testInfo.attach("narrow-chat-columns.png", { body: await page.screenshot({ path: testInfo.outputPath("narrow-chat-columns.png") }), contentType: "image/png" });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(thumbnails).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-panel-mode", "docked");
  await expect(thumbnailsToggle).toHaveAttribute("aria-disabled", "false");
  await expect(panelToggle).toHaveAttribute("aria-disabled", "false");
});
