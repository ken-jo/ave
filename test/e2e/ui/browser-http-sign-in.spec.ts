/** A server that asks for a user name and password gets a sign-in row in the tab instead of a silent failure. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, reviewGuestTitle, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;
const EXPECTED = `Basic ${Buffer.from("ken:open sesame").toString("base64")}`;

test.beforeAll(async () => {
  site = await startReviewSite((request, response, url) => {
    if (url.pathname !== "/private") return false;
    if (request.headers.authorization === EXPECTED) return reviewPage(response, "<h1>Members</h1>", "Members");
    response.writeHead(401, { "www-authenticate": 'Basic realm="Staff area"', "content-type": "text/html" });
    response.end("<title>Refused</title><h1>Refused</h1>");
    return true;
  });
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

const title = reviewGuestTitle;

test("the tab asks for credentials, cancel shows the server's refusal, and the right ones load the page", async () => {
  const { app, page } = context;
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/private`);
  const prompt = page.getByTestId("browser-page-prompt");
  await expect(prompt).toHaveAttribute("data-kind", "signIn");
  await expect(page.getByTestId("browser-page-prompt-origin")).toHaveText(site.base);
  await expect(page.getByTestId("browser-page-prompt-realm")).toContainText("Staff area");
  await page.getByTestId("browser-page-prompt-sign-in-cancel").click();
  await expect(prompt).toHaveCount(0);
  await expect.poll(() => title(app)).toBe("Refused");

  await typeAddress(page, `${site.base}/private`);
  await page.getByTestId("browser-page-prompt-username").fill("ken");
  await page.getByTestId("browser-page-prompt-password").fill("wrong");
  await page.getByTestId("browser-page-prompt-sign-in-submit").click();
  // Wrong credentials are refused by the server, which asks again in a fresh, empty row.
  await expect(page.getByTestId("browser-page-prompt-password")).toHaveValue("");
  await page.getByTestId("browser-page-prompt-username").fill("ken");
  await page.getByTestId("browser-page-prompt-password").fill("open sesame");
  await page.getByTestId("browser-page-prompt-sign-in-submit").click();
  await expect.poll(() => title(app)).toBe("Members");
  await expect(prompt).toHaveCount(0);
});
