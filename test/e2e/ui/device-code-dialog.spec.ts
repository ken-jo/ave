import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { buildIsolatedElectronEnv, launchElectron, quitElectron } from "./seeded-electron.js";

interface DialogFixture { state: { copied: string[]; opened: string[]; canceled: boolean; ready: boolean }; close(): void }

test("device sign-in shows both verification paths, copies fixed values and cancels without native focus", async ({ browserName: _browserName }, testInfo) => {
  const output = resolve(testInfo.outputDir);
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, "device-dialog-"));
  const entry = join(directory, "main.mjs");
  await build({ entryPoints: [resolve("test/e2e/ui/device-code-dialog-driver.ts")], outfile: entry,
    bundle: true, format: "esm", platform: "node", target: "node22", external: ["electron"], logLevel: "silent" });
  const userData = join(directory, "user-data");
  await mkdir(userData);
  const app = await launchElectron({ args: [entry], env: buildIsolatedElectronEnv({ AVE_DEVICE_DIALOG_USER_DATA: userData }) });
  try {
    const state = () => app.evaluate(() => (globalThis as unknown as { deviceCodeDialogFixture: DialogFixture }).deviceCodeDialogFixture.state);
    await expect.poll(async () => {
      try { return (await state()).ready; } catch { return false; }
    }).toBe(true);
    const pages = app.windows();
    const page = pages.find(candidate => candidate.url().startsWith("data:text/html;charset=utf-8,"));
    if (!page) throw new Error("Device sign-in dialog is unavailable");
    await expect(page.getByRole("heading", { name: "Sign in on another device" })).toBeVisible();
    await expect(page.locator("#device-user-code")).toHaveText("ABCD-EFGH");
    await expect(page.getByText("https://auth.example.test/verify", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open link with code" })).toBeVisible();
    expect(await page.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>).require,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    }))).toEqual({ require: "undefined", horizontalOverflow: false });
    const screenshot = testInfo.outputPath("device-code-dialog.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("device-sign-in", { path: screenshot, contentType: "image/png" });
    const clickAction = async (label: string): Promise<void> => {
      const position = await page.evaluate((name) => {
        const link = [...document.querySelectorAll<HTMLAnchorElement>('a[role="button"]')].find(element => element.textContent === name);
        if (!link) throw new Error("Device sign-in action is unavailable");
        const bounds = link.getBoundingClientRect();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      }, label);
      await page.mouse.click(position.x, position.y);
    };
    await clickAction("Copy code");
    await expect.poll(async () => (await state()).copied).toEqual(["ABCD-EFGH"]);
    await clickAction("Copy link");
    await expect.poll(async () => (await state()).copied).toEqual(["ABCD-EFGH", "https://auth.example.test/verify"]);
    await clickAction("Open verification page");
    await clickAction("Open link with code");
    await expect.poll(async () => (await state()).opened).toEqual([
      "https://auth.example.test/verify", "https://auth.example.test/verify?user_code=ABCD-EFGH",
    ]);
    const nativeWindow = await app.browserWindow(page);
    expect(await nativeWindow.evaluate(target => ({ focused: target.isFocused(), modal: target.isModal() }))).toEqual({ focused: false, modal: false });
    await clickAction("Cancel");
    await expect.poll(async () => (await state()).canceled).toBe(true);
    await expect.poll(() => page.isClosed()).toBe(true);
  } finally {
    await quitElectron(app);
    await rm(directory, { recursive: true, force: true });
  }
});
