/** Typing in the address row offers pages the user has already visited, from this device only, above the page. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewGuestTitle, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => {
    if (url.pathname === "/first") return reviewPage(response, "<h1>First</h1>", "First article");
    if (url.pathname === "/second") return reviewPage(response, "<h1>Second</h1>", "Second article");
    return false;
  });
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

test("a visited page is suggested by its title, chosen with the keyboard and opened", async () => {
  const { app, page } = context;
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/first`);
  await expect.poll(() => reviewGuestTitle(app)).toBe("First article");
  await typeAddress(page, `${site.base}/second`);
  await expect.poll(() => reviewGuestTitle(app)).toBe("Second article");

  const address = page.getByTestId("chat-side-panel-browser-address");
  await expect(page.getByTestId("browser-address-suggestions")).toHaveCount(0);
  await address.fill("first art");
  const rows = page.getByTestId("browser-address-suggestion");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`${site.base}/first`);

  // The list is drawn above the page, not under it.
  const list = await page.getByTestId("browser-address-suggestions").boundingBox();
  const guest = await page.locator("webview").first().boundingBox();
  if (!list || !guest) throw new Error("the suggestion list or the page has no box");
  expect(guest.y).toBeGreaterThanOrEqual(list.y + list.height - 1);

  const requestsBefore = site.hits.length;
  await address.press("ArrowDown");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  // Offering and choosing a suggestion asks the network for nothing.
  expect(site.hits.length).toBe(requestsBefore);
  await address.press("Enter");
  await expect.poll(() => reviewGuestTitle(app)).toBe("First article");
  await expect(page.getByTestId("browser-address-suggestions")).toHaveCount(0);
  await expect(address).toHaveValue(`${site.base}/first`);
});
