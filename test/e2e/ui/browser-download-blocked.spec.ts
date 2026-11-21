/** A download the host refuses is reported in the tab, and several saved downloads in a row are not refused. */
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => {
    if (url.pathname === "/files") return reviewPage(response, `<h1>Files</h1><a id="file" href="/file.bin">file</a>`, "Files");
    if (url.pathname !== "/file.bin") return false;
    response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="report.bin"' });
    response.end("data");
    return true;
  });
  context = await launchReviewApp();
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

const click = (app: SeededElectronContext["app"]) => app.evaluate(async ({ webContents }) => {
  const page = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
  if (!page) throw new Error("no page guest");
  await page.executeJavaScript(`document.getElementById("file").click()`, true);
});

test("a download refused after repeated cancelled Save dialogs is named in the tab and can be allowed again", async () => {
  const { app, page } = context;
  // The system Save dialog is answered here instead of shown: closed without a path, as a user closing it does.
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = (async () => ({ canceled: true, filePath: "" })) as typeof dialog.showSaveDialog;
  });
  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/files`);
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => contents.getType() === "webview")?.getTitle())).toBe("Files");

  const prompt = page.getByTestId("browser-page-prompt");
  const downloadStates = () => page.evaluate(async () => {
    const result = await (window as unknown as { aveApi: { browserWorkspace: { getState(): Promise<{ value: { downloads: { state: string }[] } }> } } }).aveApi.browserWorkspace.getState();
    return result.value.downloads.map((download) => download.state);
  });
  // Three Save dialogs closed without saving are tolerated; each is listed as cancelled.
  for (let count = 1; count <= 3; count++) { await click(app); await expect.poll(downloadStates).toHaveLength(count); }
  await expect(prompt).toHaveCount(0);
  await click(app);
  await expect(prompt).toHaveAttribute("data-kind", "downloadBlocked");
  await expect(page.getByTestId("browser-page-prompt-origin")).toHaveText(site.base);
  await expect(page.getByTestId("browser-page-prompt-target")).toHaveText("report.bin");

  await page.getByTestId("browser-page-prompt-allow-downloads").click();
  await expect(prompt).toHaveCount(0);
  await click(app);
  await expect(prompt).toHaveCount(0);
  await expect.poll(downloadStates).toHaveLength(5);
  const states = await downloadStates();
  expect(states.filter((state) => state === "blocked")).toHaveLength(1);
  expect(states.filter((state) => state === "cancelled")).toHaveLength(4);
});
