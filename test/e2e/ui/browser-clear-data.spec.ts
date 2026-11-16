/** The browser profile's cookies and site data can be cleared, for one site or for all. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

const STORE = `<h1>Store</h1><script>document.cookie = "visit=1; max-age=3600"; localStorage.setItem("note", "kept"); document.title = "stored";</script>`;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => url.pathname === "/store" && reviewPage(response, STORE, "Store"));
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

const cookies = (app: SeededElectronContext["app"], url: string) => app.evaluate(async ({ session }, target) =>
  (await session.fromPartition("persist:ave-side-browser").cookies.get({ url: target })).map((cookie) => cookie.name), url);
const stored = (app: SeededElectronContext["app"]) => app.evaluate(({ webContents }) =>
  webContents.getAllWebContents().find((contents) => contents.getType() === "webview")?.executeJavaScript(`localStorage.getItem("note")`));

test("clearing one site's data, then all cookies and site data, removes them from the shared profile", async () => {
  const { app, page } = context;
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/store`);
  await expect.poll(() => cookies(app, site.base)).toEqual(["visit"]);
  expect(await stored(app)).toBe("kept");

  await page.getByTestId("browser-workspace-toggle").click();
  await page.getByTestId("browser-workspace-panel").getByRole("button", { expanded: false }).first().click();
  await page.getByTestId("browser-clear-site-data").click();
  await expect(page.getByTestId("browser-site-data-cleared")).toBeVisible();
  await expect.poll(() => cookies(app, site.base)).toEqual([]);
  expect(await stored(app)).toBeNull();

  await page.getByTestId("browser-reload").click();
  await expect.poll(() => cookies(app, site.base)).toEqual(["visit"]);
  await page.getByTestId("browser-clear-data-siteData").check();
  await page.getByTestId("browser-clear-data-submit").click();
  await expect(page.getByTestId("browser-data-cleared")).toBeVisible();
  await expect.poll(() => cookies(app, site.base)).toEqual([]);
});
