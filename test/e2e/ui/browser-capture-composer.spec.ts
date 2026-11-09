import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";

const SESSION_ID = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";

test("user area capture stays in host chrome and attaches actual page pixels to the composer", async ({ browserName: _browserName }, testInfo) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end('<!doctype html><title>Capture attachment fixture</title><style>body{margin:0;background:#00a65a;font:24px sans-serif;height:2600px}h1{margin:0;padding:20px;height:80px;box-sizing:border-box;overflow:hidden;white-space:nowrap;background:#3355aa;color:white}</style><h1>Capture attachment fixture</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Capture fixture address is unavailable");
  const url = `http://127.0.0.1:${address.port}/`;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  try {
    ctx = await launchSeededElectron({ settings: buildLlmSettings("openai", "gpt-4.1"), seedApiKey: true, sessionId: SESSION_ID,
      historyRows: [{ role: "user", content: "Browser capture fixture", createdAt: Date.now() }], sessionTitle: "Browser capture fixture" });
    await setWindowSize(ctx.app, 1280, 820);
    await expect.poll(() => ctx?.page.evaluate(() => document.hasFocus())).toBe(true);
    expect(await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isFocused()))).toBe(false);
    await ctx.page.getByTestId(TEST_IDS.panePanelToggle).click();
    await ctx.page.getByTestId("chat-side-panel-add-tab").click();
    await ctx.page.getByTestId("chat-side-panel-launcher-menu-browser").click();
    await ctx.page.getByTestId("chat-side-panel-browser-address").fill(url);
    await ctx.page.getByTestId("chat-side-panel-browser-address").press("Enter");
    const view = ctx.page.getByTestId("chat-side-panel-browser-webview");
    await expect(view).toHaveAttribute("src", url);
    const guestId = await view.evaluate((element) => (element as unknown as { getWebContentsId(): number }).getWebContentsId());
    await expect(ctx.page.getByTestId("chat-side-panel-browser-address")).toHaveValue(url);
    await expect.poll(() => ctx?.app.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id);
      return { url: guest?.getURL(), loading: guest?.isLoading() };
    }, guestId)).toEqual({ url, loading: false });
    const composer = ctx.page.getByTestId(TEST_IDS.composerTextarea);
    await expect(composer).toBeVisible();
    await expect(composer).toBeEnabled();
    await ctx.page.getByTestId("browser-capture-menu").click();
    await expect(ctx.page.getByTestId("browser-capture-viewport")).toBeVisible();
    await expect(ctx.page.getByTestId("browser-capture-full-page")).toBeVisible();
    const menuPath = testInfo.outputPath("browser-capture-menu.png");
    await ctx.page.screenshot({ path: menuPath });
    await testInfo.attach("capture-menu", { path: menuPath, contentType: "image/png" });
    await ctx.page.getByTestId("browser-capture-area").click();
    const overlay = ctx.page.getByTestId("browser-capture-overlay");
    await expect(overlay).toBeVisible();
    await ctx.page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(composer).not.toHaveValue(/\[Image #/);
    await ctx.page.getByTestId("browser-capture-menu").click();
    await ctx.page.getByTestId("browser-capture-area").click();
    await expect(overlay).toBeVisible();
    const box = await overlay.boundingBox();
    if (!box || box.width < 220 || box.height < 180) throw new Error("Capture area is too small");
    const start = { x: box.x + 30, y: box.y + 100 };
    await ctx.page.mouse.move(start.x, start.y);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(start.x + 160, start.y + 100, { steps: 8 });
    await expect(ctx.page.getByTestId("browser-capture-rectangle")).toBeVisible();
    const overlayPath = testInfo.outputPath("browser-capture-area-overlay.png");
    await ctx.page.screenshot({ path: overlayPath });
    await testInfo.attach("capture-area-overlay", { path: overlayPath, contentType: "image/png" });
    await ctx.page.mouse.up();
    await expect(overlay).toHaveCount(0);
    await expect(composer).toHaveValue(/\[Image #1\]/);
    const attached = ctx.page.getByTestId("attachment-chip").getByRole("img", { name: "Image #1" });
    await expect(attached).toBeVisible();
    expect(await attached.evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight }))).toEqual({ width: 160, height: 100 });
    const attachmentDataUrl = await attached.getAttribute("src");
    if (!attachmentDataUrl) throw new Error("Captured attachment data is unavailable");
    const clipboard = await ctx.app.evaluate(async ({ clipboard, nativeImage }, dataUrl) => {
      const items = await clipboard.read();
      const item = items.find((candidate) => candidate.types.includes("image/png"));
      if (!item) throw new Error("Captured clipboard image is unavailable");
      const blob = await item.getType("image/png");
      const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      const pixels = image.toBitmap();
      const offset = Math.floor(image.getSize().height / 2) * image.getSize().width * 4 + Math.floor(image.getSize().width / 2) * 4;
      const source = nativeImage.createFromDataURL(dataUrl);
      const sourcePixels = source.toBitmap();
      const sourceOffset = Math.floor(source.getSize().height / 2) * source.getSize().width * 4 + Math.floor(source.getSize().width / 2) * 4;
      return { size: image.getSize(), centerRGB: [pixels[offset + 2], pixels[offset + 1], pixels[offset]],
        sourceCenterRGB: [sourcePixels[sourceOffset + 2], sourcePixels[sourceOffset + 1], sourcePixels[sourceOffset]], png: image.toPNG().toString("base64") };
    }, attachmentDataUrl);
    const capturePath = testInfo.outputPath("browser-capture-region.png");
    await fs.writeFile(capturePath, Buffer.from(clipboard.png, "base64"));
    await testInfo.attach("captured-region", { path: capturePath, contentType: "image/png" });
    const guestState = await ctx.app.evaluate(async ({ webContents }, id) => {
      const guest = webContents.fromId(id);
      if (!guest) throw new Error("Captured guest disappeared");
      const page = await guest.executeJavaScript(`(() => {
        const header = document.querySelector('h1');
        return { url: location.href, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, scroll: { x: scrollX, y: scrollY },
          bodyBackground: getComputedStyle(document.body).backgroundColor, header: header ? { rect: header.getBoundingClientRect().toJSON(),
            scrollHeight: header.scrollHeight, overflow: getComputedStyle(header).overflow, fontSize: getComputedStyle(header).fontSize } : null };
      })()`);
      return { zoom: guest.getZoomFactor(), page };
    }, guestId);
    const guestStatePath = testInfo.outputPath("capture-guest-state.json");
    await fs.writeFile(guestStatePath, JSON.stringify(guestState, null, 2));
    await testInfo.attach("capture-guest-state", { path: guestStatePath, contentType: "application/json" });
    expect(clipboard.size).toEqual({ width: 160, height: 100 });
    expect(clipboard.sourceCenterRGB).toEqual([0, 166, 90]);
    expect(clipboard.centerRGB).toEqual([0, 166, 90]);
    const guestOverlayCount = await ctx.app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('document.querySelectorAll("[data-testid=browser-capture-overlay]").length'), guestId);
    expect(guestOverlayCount).toBe(0);
    const panelBefore = await view.boundingBox();
    const captureApp = ctx.app;
    const position = () => captureApp.evaluate(async ({ webContents }, id) => {
      const guest = webContents.fromId(id);
      if (!guest) throw new Error("Captured guest disappeared");
      return guest.executeJavaScript("({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight})");
    }, guestId);
    const positionBefore = await position();
    await ctx.page.getByTestId("browser-capture-menu").click();
    await ctx.page.getByTestId("browser-capture-full-page").click();
    await expect(composer).toHaveValue(/\[Image #2\]/);
    await ctx.page.getByTestId("attachment-chip-collapsed").click();
    const fullPageImage = ctx.page.getByTestId("attachment-overlay-body").getByRole("img", { name: "Image #2" });
    await expect(fullPageImage).toBeVisible();
    expect(await fullPageImage.evaluate((element: HTMLImageElement) => element.naturalHeight)).toBe(2600);
    const fullPageData = await fullPageImage.getAttribute("src");
    if (!fullPageData) throw new Error("Full-page attachment is unavailable");
    await ctx.page.keyboard.press("Escape");
    await expect.poll(position).toEqual(positionBefore);
    expect(await view.boundingBox()).toEqual(panelBefore);
    const restoredPanelPath = testInfo.outputPath("browser-full-page-restored-panel.png");
    await ctx.page.screenshot({ path: restoredPanelPath });
    await testInfo.attach("full-page-restored-panel", { path: restoredPanelPath, contentType: "image/png" });
    const restoredStatePath = testInfo.outputPath("browser-full-page-restored-layout.json");
    await fs.writeFile(restoredStatePath, JSON.stringify({ before: { panel: panelBefore, page: positionBefore }, after: { panel: await view.boundingBox(), page: await position() } }, null, 2));
    await fs.writeFile(testInfo.outputPath("browser-user-full-page.png"), Buffer.from(fullPageData.split(",")[1] ?? "", "base64"));
    const fullClipboardHeight = await captureApp.evaluate(async ({ clipboard, nativeImage }) => {
      const item = (await clipboard.read()).find((entry) => entry.types.includes("image/png"));
      if (!item) throw new Error("Full-page clipboard image is unavailable");
      return nativeImage.createFromBuffer(Buffer.from(await (await item.getType("image/png")).arrayBuffer())).getSize().height;
    });
    expect(fullClipboardHeight).toBe(2600);
  } finally {
    if (ctx) await teardownSeededElectron(ctx);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
