/** Finding in a page says how many matches there are, and zoom is set from the address row. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewGuestTitle, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => url.pathname === "/words" && reviewPage(response, "<h1>Words</h1><p>needle one</p><p>needle two</p><p>needle three</p>", "Words"));
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

test("find shows the match count and position, says when nothing matches, and the address row sets the page zoom", async () => {
  const { app, page } = context;
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/words`);
  await expect.poll(() => reviewGuestTitle(app)).toBe("Words");

  await page.getByTestId("browser-workspace-toggle").click();
  const find = page.getByTestId("browser-find-input");
  const count = page.getByTestId("browser-find-count");
  await find.fill("needle");
  await find.press("Enter");
  await expect(count).toHaveText("1 of 3");
  await page.getByTestId("browser-workspace-panel").getByRole("button", { name: "Next", exact: true }).click();
  await expect(count).toHaveText("2 of 3");
  await find.fill("absent-word");
  await expect(count).toHaveCount(0);
  await find.press("Enter");
  await expect(count).toHaveText("No matches");
  await find.press("Escape");
  await expect(find).toHaveValue("");
  await expect(count).toHaveCount(0);

  // The library shows one section at a time.
  await page.getByTestId("browser-workspace-panel").getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByTestId("browser-library")).toHaveAttribute("data-section", "tabs");
  await page.getByTestId("browser-library-history").click();
  await expect(page.getByTestId("browser-history-user").getByTestId("browser-history-row")).toHaveCount(1);
  await expect(page.getByTestId("browser-clear-data")).toHaveCount(0);

  const zoom = page.getByTestId("browser-zoom");
  await expect(zoom).toHaveValue("1");
  await zoom.selectOption("1.25");
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => contents.getType() === "webview")?.getZoomFactor())).toBe(1.25);
  await expect(zoom).toHaveValue("1.25");
});
