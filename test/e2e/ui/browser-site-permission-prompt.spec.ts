/** A page's permission question is asked inside its tab, and "Block" holds for the document that asked. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, reviewGuestTitle, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

const LOOP = `<h1>Geo loop</h1><script>
let denied = 0;
function ask() { navigator.geolocation.getCurrentPosition(() => { document.title = "granted"; }, () => {
  denied += 1; document.title = "denied-" + denied; if (denied < 8) setTimeout(ask, 30);
}); }
ask();
</script>`;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => url.pathname === "/geoloop" && reviewPage(response, LOOP, "asking"));
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

const guestTitle = reviewGuestTitle;
async function nativeDialogs(app: SeededElectronContext["app"]): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { reviewDialogs?: number }).reviewDialogs ?? 0);
}

test("Block answers a page that keeps asking once, in the tab's panel, and Always block writes the site rule", async () => {
  const { app, page } = context;
  // Any native message box would be a regression: count them instead of letting one block the run.
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { reviewDialogs: number };
    state.reviewDialogs = 0;
    dialog.showMessageBox = (async () => { state.reviewDialogs += 1; return { response: 0, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
  });
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/geoloop`);

  const prompt = page.getByTestId("browser-page-prompt");
  await expect(prompt).toBeVisible();
  await expect(page.getByTestId("browser-page-prompt-origin")).toHaveText(site.base);
  // The question sits in the panel above the page, not over it.
  const promptBox = await prompt.boundingBox();
  const frameBox = await page.locator('[data-testid="web-surface-frame"]').boundingBox();
  expect(promptBox && frameBox && promptBox.y + promptBox.height <= frameBox.y + 1).toBe(true);

  await page.getByTestId("browser-page-prompt-block").click();
  await expect.poll(() => guestTitle(app)).toBe("denied-8");
  await expect(prompt).toHaveCount(0);
  expect(await nativeDialogs(app)).toBe(0);

  // A new document of the same site asks again; Always block ends that for the site.
  await page.getByTestId("browser-reload").click();
  await expect(prompt).toBeVisible();
  await page.getByTestId("browser-page-prompt-always-block").click();
  await expect.poll(() => guestTitle(app)).toBe("denied-8");
  await page.getByTestId("browser-reload").click();
  await expect.poll(() => guestTitle(app)).toBe("denied-8");
  await expect(prompt).toHaveCount(0);
  const rules = await page.evaluate(async () => {
    const state = await (window as unknown as { aveApi: { browserWorkspace: { getState(): Promise<{ ok: boolean; value: { sitePermissions: unknown[] } }> } } }).aveApi.browserWorkspace.getState();
    return state.value.sitePermissions;
  });
  expect(rules).toEqual([{ origin: site.base, permission: "geolocation", decision: "block" }]);
  expect(await nativeDialogs(app)).toBe(0);
});
