/** The address row's site information states the host's facts about the open site and changes only that site. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewGuestTitle, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => {
    if (url.pathname !== "/info") return false;
    response.setHeader("set-cookie", "visit=1; Path=/");
    return reviewPage(response, "<h1>Info</h1>", "Info");
  });
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

const cookies = (app: SeededElectronContext["app"], url: string) => app.evaluate(async ({ session }, target) => (await session.fromPartition("persist:ave-side-browser").cookies.get({ url: target })).map((cookie) => cookie.name), url);

test("site information names the site and its connection, keeps a rule for it, and clears its data", async () => {
  const { app, page } = context;
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/info`);
  await expect.poll(() => reviewGuestTitle(app)).toBe("Info");
  await expect.poll(() => cookies(app, site.base)).toEqual(["visit"]);

  await expect(page.getByTestId("browser-site-info")).toHaveCount(0);
  await page.getByTestId("browser-site-info-toggle").click();
  const info = page.getByTestId("browser-site-info");
  await expect(info).toBeVisible();
  await expect(page.getByTestId("browser-site-info-origin")).toHaveText(site.base);
  await expect(page.getByTestId("browser-site-info-connection")).toHaveAttribute("data-secure", "false");
  // No agent owns a tab the user opened, so the agent has no access to take back here.
  await expect(page.getByTestId("browser-site-info-agent")).toHaveAttribute("data-grant", "none");
  await expect(page.getByTestId("browser-site-info-revoke")).toHaveCount(0);

  // The panel sits above the page, not under it: the page begins at or below the panel's lower edge.
  const panel = await info.boundingBox();
  const guest = await page.locator("webview").first().boundingBox();
  if (!panel || !guest) throw new Error("the site information panel or the page has no box");
  expect(guest.y).toBeGreaterThanOrEqual(panel.y + panel.height - 1);

  const camera = page.getByTestId("browser-site-info-permission-camera");
  await expect(camera).toHaveValue("ask");
  await camera.selectOption("block");
  await expect(camera).toHaveValue("block");
  await page.getByTestId("browser-site-info-toggle").click();
  await expect(info).toHaveCount(0);
  await page.getByTestId("browser-site-info-toggle").click();
  await expect(page.getByTestId("browser-site-info-permission-camera")).toHaveValue("block");

  await page.getByTestId("browser-site-info-clear").click();
  await expect(page.getByTestId("browser-site-info-cleared")).toBeVisible();
  expect(await cookies(app, site.base)).toEqual([]);
});
