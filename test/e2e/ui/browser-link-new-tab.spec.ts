/** A link that asks for a new tab opens as a tab in the panel, not as a bare window. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

const LINKS = `<h1>Opener</h1><a id="blank" target="_blank" href="/other">new tab</a>
<button id="sized" onclick="window.open('/other', 'sized', 'width=400,height=300')">sized window</button>`;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => url.pathname === "/opener" && reviewPage(response, LINKS, "Opener"));
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

const guests = (app: SeededElectronContext["app"]) => app.evaluate(({ webContents }) =>
  webContents.getAllWebContents().filter((contents) => contents.getType() === "webview").map((contents) => contents.getURL()).sort());
const windows = (app: SeededElectronContext["app"]) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const click = (app: SeededElectronContext["app"], id: string) => app.evaluate(async ({ webContents }, target) => {
  const page = webContents.getAllWebContents().find((contents) => contents.getType() === "webview" && contents.getURL().endsWith("/opener"));
  if (!page) throw new Error("no opener guest");
  await page.executeJavaScript(`document.getElementById(${JSON.stringify(target)}).click()`, true);
}, id);

test("a new-tab link becomes a panel tab with the address row, and only a sized popup gets a window", async () => {
  const { app, page } = context;
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/opener`);
  await expect.poll(() => guests(app)).toEqual([`${site.base}/opener`]);
  const before = await windows(app);
  const tabs = page.getByTestId("chat-side-panel-tab-browser");
  await expect(tabs).toHaveCount(1);

  await click(app, "blank");
  await expect.poll(() => guests(app)).toEqual([`${site.base}/opener`, `${site.base}/other`]);
  expect(await windows(app)).toBe(before);
  await expect(tabs).toHaveCount(2);
  // The new tab is the selected one and shows the same row as any tab, pointed at the link.
  await expect(page.getByTestId("chat-side-panel-browser-address")).toHaveValue(`${site.base}/other`);
  await expect(page.getByTestId("browser-back")).toBeVisible();
  // Each tab is named by its page, so two browser tabs can be told apart.
  await expect(tabs.nth(0)).toHaveText("Opener");
  await expect(tabs.nth(1)).toHaveText("Other");

  // A page that asks for a window of its own, with a size, still gets one.
  await tabs.first().click();
  await expect(page.getByTestId("chat-side-panel-browser-address")).toHaveValue(`${site.base}/opener`);
  await click(app, "sized");
  await expect.poll(() => windows(app)).toBe(before + 1);
  await expect(tabs).toHaveCount(2);
});
