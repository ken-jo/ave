/** A link that is not a web page says so in its tab, and a mail link reaches the system only after the user agrees. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

const LINKS = `<h1>Links</h1><a id="mail" href="mailto:someone@example.com?subject=Hi">mail</a> <a id="other" href="unknown-scheme:thing">other</a>`;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => url.pathname === "/links" && reviewPage(response, LINKS, "Links"));
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

const click = (app: SeededElectronContext["app"], id: string) => app.evaluate(async ({ webContents }, target) => {
  const page = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
  if (!page) throw new Error("no page guest");
  await page.executeJavaScript(`document.getElementById(${JSON.stringify(target)}).click()`, true);
}, id);
const opened = (app: SeededElectronContext["app"]) => app.evaluate(() => (globalThis as unknown as { reviewOpened?: string[] }).reviewOpened ?? []);

test("a mail link asks in the tab before the system's app opens, and an unknown link is named, not swallowed", async () => {
  const { app, page } = context;
  // The hand-off to the system is recorded instead of performed, so the run opens no other app.
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { reviewOpened: string[] };
    state.reviewOpened = [];
    shell.openExternal = async (url: string) => { state.reviewOpened.push(url); };
  });
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/links`);
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => contents.getType() === "webview")?.getTitle())).toBe("Links");

  await click(app, "mail");
  const prompt = page.getByTestId("browser-page-prompt");
  await expect(prompt).toHaveAttribute("data-kind", "external");
  await expect(page.getByTestId("browser-page-prompt-origin")).toHaveText(site.base);
  await expect(page.getByTestId("browser-page-prompt-target")).toHaveText("someone@example.com");
  expect(await opened(app)).toEqual([]);
  await page.getByTestId("browser-page-prompt-dismiss").click();
  await expect(prompt).toHaveCount(0);
  expect(await opened(app)).toEqual([]);

  await click(app, "mail");
  await page.getByTestId("browser-page-prompt-open").click();
  await expect.poll(() => opened(app)).toEqual(["mailto:someone@example.com?subject=Hi"]);
  await expect(prompt).toHaveCount(0);

  await click(app, "other");
  await expect(prompt).toContainText("unknown-scheme:");
  await expect(page.getByTestId("browser-page-prompt-open")).toHaveCount(0);
  await page.getByTestId("browser-page-prompt-dismiss").click();
  expect(await opened(app)).toHaveLength(1);
  await expect(page.getByTestId("chat-side-panel-browser-address")).toHaveValue(`${site.base}/links`);
});
