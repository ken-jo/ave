/** Browser keys pressed while a tab's page has the keyboard act on that tab, not on the app. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewGuestTitle, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => {
    if (url.pathname === "/one") return reviewPage(response, "<h1>One</h1><p>needle</p>", "One");
    if (url.pathname === "/two") return reviewPage(response, "<h1>Two</h1>", "Two");
    return false;
  });
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

/** A real key press delivered to the page, with the platform's command modifier. */
const pressInPage = (app: SeededElectronContext["app"], keyCode: string) => app.evaluate(({ webContents }, key) => {
  const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
  if (!guest) throw new Error("no page guest");
  const modifiers: ("meta" | "control")[] = [process.platform === "darwin" ? "meta" : "control"];
  guest.focus();
  guest.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
  guest.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
}, keyCode);

test("the address, find, reload and history keys pressed in a page act on its tab, and the app window is not reloaded", async () => {
  const { app, page } = context;
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/one`);
  await expect.poll(() => reviewGuestTitle(app)).toBe("One");
  await typeAddress(page, `${site.base}/two`);
  await expect.poll(() => reviewGuestTitle(app)).toBe("Two");
  // A value the app window loses if it is ever reloaded.
  await page.evaluate(() => { (window as unknown as { reviewMarker?: string }).reviewMarker = "kept"; });
  const address = page.getByTestId("chat-side-panel-browser-address");

  await pressInPage(app, "[");
  await expect.poll(() => reviewGuestTitle(app)).toBe("One");
  await pressInPage(app, "]");
  await expect.poll(() => reviewGuestTitle(app)).toBe("Two");

  const loads = () => site.hits.filter((hit) => hit.endsWith("/two")).length;
  const before = loads();
  await pressInPage(app, "R");
  await expect.poll(loads).toBe(before + 1);

  await pressInPage(app, "L");
  await expect(address).toBeFocused();

  await expect(page.getByTestId("browser-find-input")).toHaveCount(0);
  await pressInPage(app, "F");
  await expect(page.getByTestId("browser-find-input")).toBeFocused();

  expect(await page.evaluate(() => (window as unknown as { reviewMarker?: string }).reviewMarker)).toBe("kept");
});
