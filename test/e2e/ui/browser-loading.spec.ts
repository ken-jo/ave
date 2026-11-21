/** While a page loads the address row says so and offers to stop it; when the load ends the row offers reload again. */
import type { ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;
const held: ServerResponse[] = [];

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => {
    if (url.pathname !== "/slow") return false;
    held.push(response);
    return true;
  });
  context = await launchReviewApp();
});
test.afterAll(async () => {
  for (const response of held.splice(0)) response.destroy();
  await teardownSeededElectron(context);
  site.server.close();
});

test("the reload control becomes stop with a loading line while a page loads, and stop ends the load", async () => {
  const { page } = context;
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/`);
  await expect(page.getByTestId("browser-reload")).toBeEnabled();
  await expect(page.getByTestId("browser-loading-line")).toHaveCount(0);

  await typeAddress(page, `${site.base}/slow`);
  await expect(page.getByTestId("browser-stop")).toBeVisible();
  await expect(page.getByTestId("browser-loading-line")).toBeVisible();
  await expect(page.getByTestId("browser-reload")).toHaveCount(0);
  await expect.poll(() => held.length).toBe(1);

  await page.getByTestId("browser-stop").click();
  await expect(page.getByTestId("browser-reload")).toBeVisible();
  await expect(page.getByTestId("browser-loading-line")).toHaveCount(0);
  // A stopped load is not a failed one: the page the tab was showing stays.
  await expect(page.getByTestId("browser-load-error")).toHaveCount(0);
});

test("the loading state ends by itself when the page arrives", async () => {
  const { app, page } = context;
  await typeAddress(page, `${site.base}/slow`);
  await expect(page.getByTestId("browser-stop")).toBeVisible();
  await expect.poll(() => held.length).toBe(2);
  reviewPage(held[1] as ServerResponse, "<h1>Slow page</h1>", "Slow page");
  await expect(page.getByTestId("browser-reload")).toBeEnabled();
  await expect(page.getByTestId("browser-loading-line")).toHaveCount(0);
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents()
    .filter((contents) => contents.getType() === "webview").map((contents) => contents.getTitle()))).toEqual(["Slow page"]);
});
