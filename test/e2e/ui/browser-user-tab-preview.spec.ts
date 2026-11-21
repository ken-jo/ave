/** A user tab's thumbnail shows a page that sets no background on white, as the page itself is shown. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewGuestTitle, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => {
    if (url.pathname !== "/bare") return false;
    // No stylesheet at all: the page relies on the default canvas.
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Bare</title><p>bare page</p>");
    return true;
  });
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

test("the thumbnail of a user tab whose page sets no background is light, not black", async () => {
  const { app, page } = context;
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/bare`);
  await expect.poll(() => reviewGuestTitle(app)).toBe("Bare");

  // The thumbnail is decoded in the window that would draw it; its far corner is empty page.
  const corner = await page.evaluate(async () => {
    const api = (window as unknown as { aveApi: { browserWorkspace: {
      getState(): Promise<{ ok: boolean; value: { tabs: { tabId: string; documentGeneration: number; url: string }[] } }>;
      preview(target: { tabId: string; documentGeneration: number }): Promise<{ ok: boolean; error?: string; value: { dataUrl: string; width: number; height: number } }>;
    } } }).aveApi.browserWorkspace;
    const state = await api.getState();
    const tab = state.value.tabs.find((candidate) => candidate.url.endsWith("/bare"));
    if (!tab) throw new Error("the user tab is not listed");
    const preview = await api.preview({ tabId: tab.tabId, documentGeneration: tab.documentGeneration });
    if (!preview.ok) throw new Error(`preview failed: ${preview.error}`);
    const bitmap = new Image();
    bitmap.src = preview.value.dataUrl;
    await bitmap.decode();
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context2d = canvas.getContext("2d");
    if (!context2d) throw new Error("no canvas context");
    context2d.drawImage(bitmap, 0, 0);
    const pixel = context2d.getImageData(bitmap.width - 4, bitmap.height - 4, 1, 1).data;
    return { red: pixel[0], green: pixel[1], blue: pixel[2], width: bitmap.width, height: bitmap.height };
  });
  expect(corner.width).toBeGreaterThan(50);
  expect(Math.min(corner.red ?? 0, corner.green ?? 0, corner.blue ?? 0)).toBeGreaterThan(240);
});
