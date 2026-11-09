import { expect } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import type { ElectronFixtures } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";
import { buildIsolatedElectronEnv, launchElectron, MAIN_ENTRY, quitElectron } from "./seeded-electron.js";

/** Admit seeded files through the visible trust review, then reload the isolated profile. */
export async function admitFixturePlugins({ app, mainWindow, aveHome, userDataDir, tempHome }: Pick<ElectronFixtures,
  "app" | "mainWindow" | "aveHome" | "userDataDir" | "tempHome"
>, launchEnv: Record<string, string | undefined> = {}, devFlag = true): Promise<{ app: ElectronApplication; mainWindow: Page }> {
  await openInlineSettings(app, mainWindow, "permissions");
  await mainWindow.getByTestId("home-trust-approve-all").click();
  await expect(mainWindow.getByTestId("home-trust-done")).toBeVisible();
  await quitElectron(app);
  const restarted = await launchElectron({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: buildIsolatedElectronEnv({ ...launchEnv, HOME: tempHome, USERPROFILE: tempHome, AVE_HOME: aveHome, AVE_DEV: devFlag ? "1" : undefined }),
  });
  try {
    const child = restarted.process();
    child.stdout?.on("data", (data: Buffer) => process.stdout.write(`[electron:restarted:stdout] ${data}`));
    child.stderr?.on("data", (data: Buffer) => process.stdout.write(`[electron:restarted:stderr] ${data}`));
    const page = await restarted.firstWindow();
    // Same boot budget as the fixture's first launch: a confined boot also starts the OS sandbox.
    await expect(page.getByTestId("sidebar-settings")).toBeVisible({ timeout: 60_000 });
    // The reload restores Settings; start from a composer so later Settings visits have a return destination.
    await page.getByTestId("sidebar-new-chat").click();
    await expect(page.getByTestId("composer-textarea").first()).toBeVisible();
    return { app: restarted, mainWindow: page };
  } catch (startupError) {
    try { await quitElectron(restarted); }
    catch (teardownError) { throw new AggregateError([startupError, teardownError], "Fixture restart and teardown failed"); }
    throw startupError;
  }
}
