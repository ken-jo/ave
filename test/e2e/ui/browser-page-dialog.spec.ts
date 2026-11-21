/** alert and confirm are answered inside the tab, under the site's origin, never in a window-blocking box. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, reviewGuestTitle, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

const DIALOGS = `<h1>Dialogs</h1>
<button id="alert" onclick="alert('Saved <b>ok</b>'); document.title = 'alert-returned'">alert</button>
<button id="confirm" onclick="document.title = 'confirm-' + confirm('Delete it?')">confirm</button>
<button id="loop" onclick="let n = 0; while (n < 40 && !confirm('again ' + n)) n++; document.title = 'loop-' + n">loop</button>`;

// An embedded frame of another site, and a sandboxed frame whose origin is opaque, each call alert when the page asks.
const FRAME = `<script>addEventListener("message", () => { alert("from the frame"); parent.postMessage("frame-returned", "*"); });</script>`;
const OPAQUE = `<script>addEventListener('message', () => { alert('opaque'); parent.postMessage('opaque-returned', '*'); });</script>`;
const frames = (port: number) => `<h1>Frames</h1>
<iframe id="cross" src="http://localhost:${port}/frame"></iframe>
<iframe id="opaque" sandbox="allow-scripts allow-modals" srcdoc="${OPAQUE.replace(/"/g, "&quot;")}"></iframe>
<button id="cross-alert" onclick="document.getElementById('cross').contentWindow.postMessage('go', '*')">cross</button>
<button id="opaque-alert" onclick="document.getElementById('opaque').contentWindow.postMessage('go', '*')">opaque</button>
<script>addEventListener("message", (event) => { document.title = String(event.data); });</script>`;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => (url.pathname === "/dialogs" && reviewPage(response, DIALOGS, "Dialogs"))
    || (url.pathname === "/frames" && reviewPage(response, frames(site.port), "Frames"))
    || (url.pathname === "/frame" && reviewPage(response, FRAME, "Frame")));
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

const title = reviewGuestTitle;
// The click is not awaited to its end: the page stays inside the dialog call until the tab answers it.
const click = (app: SeededElectronContext["app"], id: string) => app.evaluate(({ webContents }, target) => {
  const page = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
  if (!page) throw new Error("no page guest");
  void page.executeJavaScript(`document.getElementById(${JSON.stringify(target)}).click()`, true);
}, id);
const nativeBoxes = (app: SeededElectronContext["app"]) => app.evaluate(() => (globalThis as unknown as { reviewDialogs?: number }).reviewDialogs ?? 0);

test("page dialogs are answered in the tab and resume the page with the answer", async () => {
  const { app, page } = context;
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { reviewDialogs: number };
    state.reviewDialogs = 0;
    dialog.showMessageBox = (async () => { state.reviewDialogs += 1; return { response: 0, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
  });
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/dialogs`);
  await expect.poll(() => title(app)).toBe("Dialogs");
  // The test driver ends a page dialog nobody listens for. A listener that does nothing leaves the dialog to the app.
  const guestPage = app.windows().find((candidate) => candidate.url() === `${site.base}/dialogs`);
  if (!guestPage) throw new Error("the page guest is not visible to the test driver");
  guestPage.on("dialog", () => {});

  await click(app, "alert");
  const prompt = page.getByTestId("browser-page-prompt");
  await expect(prompt).toHaveAttribute("data-kind", "dialog");
  await expect(page.getByTestId("browser-page-prompt-origin")).toHaveText(site.base);
  await expect(page.getByTestId("browser-page-prompt-message")).toHaveText("Saved <b>ok</b>");
  // The page is still inside alert() until the tab answers.
  expect(await title(app)).toBe("Dialogs");
  await page.getByTestId("browser-page-prompt-ok").click();
  await expect.poll(() => title(app)).toBe("alert-returned");

  await click(app, "confirm");
  await page.getByTestId("browser-page-prompt-cancel").click();
  await expect.poll(() => title(app)).toBe("confirm-false");
  await click(app, "confirm");
  await page.getByTestId("browser-page-prompt-ok").click();
  await expect.poll(() => title(app)).toBe("confirm-true");

  // A page that keeps asking can be told to stop: the rest of its dialogs end unanswered at once.
  await click(app, "loop");
  await expect(page.getByTestId("browser-page-prompt-message")).toHaveText("again 0");
  await page.getByTestId("browser-page-prompt-block-dialogs").click();
  await expect.poll(() => title(app)).toBe("loop-40");
  await expect(prompt).toHaveCount(0);
  expect(await nativeBoxes(app)).toBe(0);
});

test("a frame's dialog is titled with the frame's own site, and a frame with an opaque origin gets none", async () => {
  const { app, page } = context;
  await typeAddress(page, `${site.base}/frames`);
  await expect.poll(() => title(app)).toBe("Frames");
  await expect.poll(() => site.hits.includes("GET /frame")).toBe(true);
  const guestPage = app.windows().find((candidate) => candidate.url() === `${site.base}/frames`);
  if (!guestPage) throw new Error("the page guest is not visible to the test driver");
  guestPage.on("dialog", () => {});

  await click(app, "cross-alert");
  await expect(page.getByTestId("browser-page-prompt-message")).toHaveText("from the frame");
  await expect(page.getByTestId("browser-page-prompt-origin")).toHaveText(`http://localhost:${site.port}`);
  await page.getByTestId("browser-page-prompt-ok").click();
  await expect.poll(() => title(app)).toBe("frame-returned");

  await click(app, "opaque-alert");
  await expect.poll(() => title(app)).toBe("opaque-returned");
  await expect(page.getByTestId("browser-page-prompt")).toHaveCount(0);
  expect(await nativeBoxes(app)).toBe(0);
});
