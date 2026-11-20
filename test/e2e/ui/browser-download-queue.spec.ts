/** Two downloads started while a Save dialog is open each get their own dialog, one after the other, and both are saved. */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";
import { launchReviewApp, openUserBrowserTab, reviewPage, startReviewSite, typeAddress, type ReviewSite } from "./browser-review-fixture.js";

let context: SeededElectronContext;
let site: ReviewSite;
const LEFTOVER = "0123456789abcdef0123456789abcdef";

test.beforeAll(async () => {
  site = await startReviewSite((_request, response, url) => {
    if (url.pathname === "/files") {
      return reviewPage(response, `<h1>Files</h1><a id="one" href="/one.bin">one</a><a id="two" href="/two.bin">two</a>`, "Files");
    }
    if (url.pathname !== "/one.bin" && url.pathname !== "/two.bin") return false;
    const name = url.pathname.slice(1);
    response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` });
    response.end(`contents of ${name}`);
    return true;
  });
  // A staged file a crashed run left behind.
  context = await launchReviewApp({ prepareHome: (aveHome) => {
    mkdirSync(join(aveHome, "browser-downloads"), { recursive: true });
    // Left open to others by whatever made it; the app narrows it before using it.
    chmodSync(join(aveHome, "browser-downloads"), 0o755);
    writeFileSync(join(aveHome, "browser-downloads", LEFTOVER), "left by a crash");
  } });
});
test.afterAll(async () => {
  await teardownSeededElectron(context);
  site.server.close();
});

test("a download that starts while a Save dialog is open waits for its own dialog, and both are saved", async () => {
  const { app, page, aveHome, tempHome } = context;
  const staging = join(aveHome, "browser-downloads");
  expect(existsSync(join(staging, LEFTOVER))).toBe(false);
  if (process.platform !== "win32") expect(statSync(staging).mode & 0o777).toBe(0o700);
  const chosen = join(tempHome, "chosen");
  mkdirSync(chosen);
  // The system Save dialog is answered here: each call waits until the test picks its path, and the most open at once is counted.
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { saveDialogs: { name: string; answer: (path: string) => void }[]; openDialogs: number; mostOpen: number };
    state.saveDialogs = []; state.openDialogs = 0; state.mostOpen = 0;
    dialog.showSaveDialog = ((...args: unknown[]) => {
      const options = args.at(-1) as { defaultPath?: string };
      state.openDialogs += 1;
      state.mostOpen = Math.max(state.mostOpen, state.openDialogs);
      return new Promise((resolve) => {
        state.saveDialogs.push({ name: String(options.defaultPath).split(/[\\/]/).pop() ?? "", answer: (path) => { state.openDialogs -= 1; resolve({ canceled: false, filePath: path }); } });
      });
    }) as typeof dialog.showSaveDialog;
  });
  const dialogNames = () => app.evaluate(() => (globalThis as unknown as { saveDialogs: { name: string }[] }).saveDialogs.map((entry) => entry.name));
  const answer = (index: number, path: string) => app.evaluate((_main, [at, to]) => {
    (globalThis as unknown as { saveDialogs: { answer: (path: string) => void }[] }).saveDialogs[at as number]?.answer(to as string);
  }, [index, path] as const);
  const click = (id: string) => app.evaluate(async ({ webContents }, target) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
    if (!guest) throw new Error("no page guest");
    await guest.executeJavaScript(`document.getElementById(${JSON.stringify(target)}).click()`, true);
  }, id);

  await openUserBrowserTab(page);
  await typeAddress(page, `${site.base}/files`);
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => contents.getType() === "webview")?.getTitle())).toBe("Files");

  await click("one");
  await expect.poll(dialogNames).toEqual(["one.bin"]);
  await click("two");
  // The second download is staged privately while the first dialog is open; its own dialog has not opened.
  await expect.poll(() => readdirSync(staging).length).toBe(2);
  expect(await dialogNames()).toEqual(["one.bin"]);

  await answer(0, join(chosen, "one.bin"));
  await expect.poll(dialogNames).toEqual(["one.bin", "two.bin"]);
  await answer(1, join(chosen, "two.bin"));

  await expect.poll(() => existsSync(join(chosen, "two.bin")) && existsSync(join(chosen, "one.bin"))).toBe(true);
  expect(readFileSync(join(chosen, "one.bin"), "utf8")).toBe("contents of one.bin");
  expect(readFileSync(join(chosen, "two.bin"), "utf8")).toBe("contents of two.bin");
  expect(await app.evaluate(() => (globalThis as unknown as { mostOpen: number }).mostOpen)).toBe(1);
  await expect.poll(() => readdirSync(staging)).toEqual([]);
  const states = await page.evaluate(async () => {
    const result = await (window as unknown as { aveApi: { browserWorkspace: { getState(): Promise<{ value: { downloads: { name: string; state: string }[] } }> } } }).aveApi.browserWorkspace.getState();
    return result.value.downloads.map((download) => [download.name, download.state]);
  });
  expect(states).toEqual(expect.arrayContaining([["one.bin", "completed"], ["two.bin", "completed"]]));
});
