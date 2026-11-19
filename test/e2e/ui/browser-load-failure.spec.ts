/** A page that fails to load must say so in the tab, with the reason and a way forward, instead of staying blank. */
import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, typeAddress } from "./browser-review-fixture.js";

let context: SeededElectronContext;

test.beforeAll(async () => { context = await launchReviewApp(); });
test.afterAll(async () => { await teardownSeededElectron(context); });

function listen(port: number): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Back online</title><h1>Back online</h1>");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    resolve({ port: address.port, close: () => new Promise((done) => server.close(() => done())) });
  }));
}

test("a refused connection shows the host's error page, and Try again loads the page once the server answers", async () => {
  const { app, page } = context;
  const reserved = await listen(0);
  await reserved.close();
  const url = `http://127.0.0.1:${reserved.port}/`;
  await openUserBrowserTab(page);
  await typeAddress(page, url);

  const error = page.getByTestId("browser-load-error");
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute("data-reason", "connection");
  await expect(page.getByTestId("browser-load-error-url")).toHaveText(url);
  await expect(error).toContainText("ERR_CONNECTION_REFUSED");
  // The blank failed page is not painted under the host's error page.
  await expect(page.locator('[data-testid="web-surface-frame"]')).toBeHidden();

  const server = await listen(reserved.port);
  try {
    await page.getByTestId("browser-load-error-retry").click();
    await expect(error).toHaveCount(0);
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .filter((contents) => contents.getType() === "webview").map((contents) => contents.getTitle()))).toEqual(["Back online"]);
    await expect(page.locator('[data-testid="web-surface-frame"]')).toBeVisible();
  } finally {
    await server.close();
  }
});

test("a port the browser refuses to open is reported as blocked, and a good address replaces the error", async () => {
  const { app, page } = context;
  await typeAddress(page, "http://127.0.0.1:1/");
  const error = page.getByTestId("browser-load-error");
  await expect(error).toHaveAttribute("data-reason", "blocked");
  const server = await listen(0);
  try {
    await typeAddress(page, `http://127.0.0.1:${server.port}/`);
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .filter((contents) => contents.getType() === "webview").map((contents) => contents.getTitle()))).toEqual(["Back online"]);
    await expect(error).toHaveCount(0);
    await expect(page.locator('[data-testid="web-surface-frame"]')).toBeVisible();
  } finally {
    await server.close();
  }
});
