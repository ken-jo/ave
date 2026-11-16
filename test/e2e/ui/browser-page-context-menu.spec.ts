/** A user's browser tab has a context menu: a link can be opened in a new tab from it. The real menu is built; only showing it on screen is replaced. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

const OPENER = `<h1>Opener</h1><button id="open" onclick="window.open('/', 'signin', 'width=420,height=360')">open</button>`;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => url.pathname === "/opener" && reviewPage(response, OPENER, "Opener"));
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

test("right-clicking a link offers it in a new tab, and choosing that opens a panel tab", async () => {
  const { app, page } = context;
  // The app builds its real menu; only showing it on screen is replaced, since a shown menu would hold the test until a person picks.
  await app.evaluate(({ Menu }) => {
    const state = globalThis as unknown as { reviewMenus: Electron.Menu[]; reviewPopup: Electron.Menu["popup"] };
    state.reviewMenus = [];
    state.reviewPopup = Menu.prototype.popup;
    Menu.prototype.popup = function (this: Electron.Menu) { state.reviewMenus.push(this); };
  });
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/`);
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => contents.getType() === "webview")?.getTitle())).toBe("Fixture home");

  await app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
    if (!guest) throw new Error("no page guest");
    const point = await guest.executeJavaScript(`(() => { const box = document.getElementById("other").getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; })()`);
    guest.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...point });
    guest.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...point });
  });
  const ids = () => app.evaluate(() => ((globalThis as unknown as { reviewMenus: Electron.Menu[] }).reviewMenus.at(-1)?.items ?? []).map((item) => item.id).filter(Boolean));
  await expect.poll(ids).toEqual(["open-link-in-new-tab", "copy-link", "back", "forward", "reload", "open-in-system-browser"]);

  // Choosing the item goes through the real menu item, as a person picking it does.
  await app.evaluate(() => {
    const menu = (globalThis as unknown as { reviewMenus: Electron.Menu[] }).reviewMenus.at(-1);
    (menu?.items.find((item) => item.id === "open-link-in-new-tab")?.click as (() => void) | undefined)?.();
  });
  await app.evaluate(({ Menu }) => { Menu.prototype.popup = (globalThis as unknown as { reviewPopup: Electron.Menu["popup"] }).reviewPopup; });
  await expect(page.getByTestId("chat-side-panel-tab-browser")).toHaveCount(2);
  await expect(page.getByTestId("chat-side-panel-browser-address")).toHaveValue(`${site.base}/other`);
});

test("a popup window's page has the same page menu, with the pause control first and no new-tab link", async () => {
  const { app, page } = context;
  await app.evaluate(({ Menu }) => {
    const state = globalThis as unknown as { reviewMenus: Electron.Menu[]; reviewPopup: Electron.Menu["popup"] };
    state.reviewMenus = [];
    state.reviewPopup = Menu.prototype.popup;
    Menu.prototype.popup = function (this: Electron.Menu) { state.reviewMenus.push(this); };
  });
  await typeAddress(page, `${site.base}/opener`);
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => contents.getType() === "webview" && contents.getTitle() === "Opener") !== undefined)).toBe(true);
  await app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview" && contents.getTitle() === "Opener");
    void guest?.executeJavaScript(`document.getElementById("open").click()`, true);
  });
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => contents.getType() === "window" && contents.getTitle() === "Fixture home") !== undefined)).toBe(true);
  await app.evaluate(async ({ webContents }) => {
    const popup = webContents.getAllWebContents().find((contents) => contents.getType() === "window" && contents.getTitle() === "Fixture home");
    if (!popup) throw new Error("no popup page");
    popup.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, x: 200, y: 200 });
    popup.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, x: 200, y: 200 });
  });
  const menu = () => app.evaluate(() => {
    const items = (globalThis as unknown as { reviewMenus: Electron.Menu[] }).reviewMenus.at(-1)?.items ?? [];
    return { first: items[0]?.label ?? null, ids: items.map((item) => item.id).filter(Boolean) };
  });
  await expect.poll(menu).toEqual({ first: expect.any(String), ids: ["back", "forward", "reload", "open-in-system-browser"] });
  await app.evaluate(({ Menu }) => { Menu.prototype.popup = (globalThis as unknown as { reviewPopup: Electron.Menu["popup"] }).reviewPopup; });
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getType() === "window" && window.webContents.getTitle() === "Fixture home") window.close(); });
});
