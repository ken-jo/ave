/** An address the app cannot open must be refused where it is typed, and must never cost the tab its page. */
import { expect, test } from "@playwright/test";
import { EXTERNAL_URL_HOST_CASES } from "../../../src/shared/external-url-host-cases.js";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

test.beforeAll(async () => {
  site = await startReviewSite();
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

test("a refused address leaves the tab able to load the next one", async () => {
  const { app, page } = context;
  await openUserBrowserTab(page);

  // Rows the renderer's own URL parser accepts but the main process parser rejects are the ones that used to kill a tab.
  for (const { input } of EXTERNAL_URL_HOST_CASES.filter((row) => !row.ok)) {
    await typeAddress(page, input);
    await expect(page.getByTestId("chat-side-panel-browser-address-error"), input).toBeVisible();
    expect(await page.locator("webview").count(), input).toBe(0);
  }

  await typeAddress(page, `${site.base}/other`);
  await expect.poll(() => site.hits).toContain("GET /other");
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents()
    .filter((contents) => contents.getType() === "webview").map((contents) => contents.getTitle()))).toEqual(["Other"]);
  await expect(page.getByTestId("browser-reload")).toBeEnabled();
});

test("the main process reports a guest it refused to the document that mounted it", async () => {
  const { page } = context;
  const refused = "https://hello%20world/";
  const received = await page.evaluate(async (src) => {
    const api = (window as unknown as { aveApi: { browserWorkspace: { onAttachBlocked(handler: (event: { src: string }) => void): () => void } } }).aveApi;
    return new Promise<string>((resolve) => {
      const guest = document.createElement("webview");
      const off = api.browserWorkspace.onAttachBlocked((event) => { off(); guest.remove(); resolve(event.src); });
      guest.setAttribute("partition", "persist:ave-side-browser");
      guest.setAttribute("src", src);
      document.body.append(guest);
    });
  }, refused);
  expect(received).toBe(refused);
});

test("a local host without a scheme opens over http, and words go to the configured search engine", async () => {
  const { app, page } = context;
  await typeAddress(page, `localhost:${site.port}/`);
  await expect(page.getByTestId("chat-side-panel-browser-address")).toHaveValue(`http://localhost:${site.port}/`);
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents()
    .filter((contents) => contents.getType() === "webview").map((contents) => contents.getTitle()))).toEqual(["Fixture home"]);

  // The search request is recorded and cancelled in the app's own session, so the spec never leaves this machine.
  await app.evaluate(({ session }) => {
    const seen: string[] = [];
    (globalThis as unknown as { reviewSearchRequests: string[] }).reviewSearchRequests = seen;
    session.fromPartition("persist:ave-side-browser").webRequest.onBeforeRequest({ urls: ["https://duckduckgo.com/*"] }, (details, respond) => {
      seen.push(details.url);
      respond({ cancel: true });
    });
  });
  await page.evaluate(() => (window as unknown as { aveApi: { updateSettings(patch: unknown): Promise<unknown> } }).aveApi
    .updateSettings({ webView: { addressSearchEngine: "duckduckgo" } }));
  await typeAddress(page, "ave browser review");
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { reviewSearchRequests: string[] }).reviewSearchRequests))
    .toEqual(["https://duckduckgo.com/?q=ave%20browser%20review"]);
  await expect(page.getByTestId("chat-side-panel-browser-address-error")).toHaveCount(0);
});
