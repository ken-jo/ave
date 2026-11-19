/** A page's unload handler may hold back a navigation the page started, never one the user started from the app. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, reviewGuestTitle, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

const TRAP = `<h1>Unload trap</h1><a id="go" href="/other">leave</a>
<form id="order" method="post" action="/submit"><input name="item" value="book"><input name="count" value="2"></form>
<script>window.onbeforeunload = (event) => { event.preventDefault(); return "stay"; };</script>`;
const submitted: string[] = [];

test.beforeAll(async () => {
  site = await startReviewSite((request, response, url) => {
    if (url.pathname === "/unload") return reviewPage(response, TRAP, "Unload trap");
    if (url.pathname !== "/submit") return false;
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => { submitted.push(`${request.method} ${body}`); reviewPage(response, "<h1>Submitted</h1>", "Submitted"); });
    return true;
  });
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

function guest(app: SeededElectronContext["app"], script: string) {
  return app.evaluate(async ({ webContents }, code) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
    if (!page) throw new Error("no page guest");
    // A user gesture arms the page's unload handler, as a real visitor's click would.
    return page.executeJavaScript(code, true);
  }, script);
}
const title = reviewGuestTitle;

test("an address typed over a page that asks to stay navigates at once, with no question", async () => {
  const { app, page } = context;
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/unload`);
  await expect.poll(() => title(app)).toBe("Unload trap");
  await guest(app, "document.body.click(); true");

  await typeAddress(page, `${site.base}/other`);
  await expect.poll(() => title(app)).toBe("Other");
  await expect(page.getByTestId("browser-page-prompt")).toHaveCount(0);
  await expect(page.getByTestId("chat-side-panel-browser-address")).toHaveValue(`${site.base}/other`);
});

test("a navigation the page starts waits for Leave or Stay in the tab", async () => {
  const { app, page } = context;
  await typeAddress(page, `${site.base}/unload`);
  await expect.poll(() => title(app)).toBe("Unload trap");
  await guest(app, "document.body.click(); document.getElementById('go').click(); true");

  const prompt = page.getByTestId("browser-page-prompt");
  await expect(prompt).toHaveAttribute("data-kind", "leave");
  await expect(page.getByTestId("browser-page-prompt-origin")).toHaveText(site.base);
  await page.getByTestId("browser-page-prompt-stay").click();
  await expect(prompt).toHaveCount(0);
  expect(await title(app)).toBe("Unload trap");

  await guest(app, "document.getElementById('go').click(); true");
  await expect(prompt).toBeVisible();
  await page.getByTestId("browser-page-prompt-leave").click();
  await expect.poll(() => title(app)).toBe("Other");
  await expect(prompt).toHaveCount(0);
});

test("a form the page submits waits unsent: Stay sends nothing, Leave sends the one original POST", async () => {
  const { app, page } = context;
  await typeAddress(page, `${site.base}/unload`);
  await expect.poll(() => title(app)).toBe("Unload trap");
  await guest(app, "document.body.click(); document.getElementById('order').requestSubmit(); true");

  const prompt = page.getByTestId("browser-page-prompt");
  await expect(prompt).toHaveAttribute("data-kind", "leave");
  await page.getByTestId("browser-page-prompt-stay").click();
  await expect(prompt).toHaveCount(0);
  // The document is the one that asked, not a failure page, and its fields are still filled in.
  expect(await title(app)).toBe("Unload trap");
  expect(await guest(app, "document.forms.order.item.value")).toBe("book");
  await expect(page.getByTestId("browser-load-error")).toHaveCount(0);
  expect(submitted).toEqual([]);

  await guest(app, "document.getElementById('order').requestSubmit(); true");
  await expect(prompt).toBeVisible();
  await page.getByTestId("browser-page-prompt-leave").click();
  await expect.poll(() => title(app)).toBe("Submitted");
  expect(submitted).toEqual(["POST item=book&count=2"]);
  expect(site.hits.filter((hit) => hit.endsWith("/submit"))).toEqual(["POST /submit"]);
});
