import { expect } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import type { ElectronFixtures } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";
import { buildIsolatedElectronEnv, launchElectron, MAIN_ENTRY } from "./seeded-electron.js";

/** Admit seeded files through the visible trust review, then reload the isolated profile. */
export async function admitFixturePlugins({ app, mainWindow, aveHome, userDataDir, tempHome }: Pick<ElectronFixtures,
  "app" | "mainWindow" | "aveHome" | "userDataDir" | "tempHome"
>, launchEnv: Record<string, string | undefined> = {}, devFlag = true): Promise<{ app: ElectronApplication; mainWindow: Page }> {
  await openInlineSettings(app, mainWindow, "permissions");
  await mainWindow.getByTestId("home-trust-approve-all").click();
  await expect(mainWindow.getByTestId("home-trust-done")).toBeVisible();
  await app.close();
  const restarted = await launchElectron({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: buildIsolatedElectronEnv({ ...launchEnv, HOME: tempHome, USERPROFILE: tempHome, AVE_HOME: aveHome, AVE_DEV: devFlag ? "1" : undefined }),
  });
  const page = await restarted.firstWindow();
  await expect(page.getByTestId("sidebar-settings")).toBeVisible();
  // The reload restores Settings; start from a composer so later Settings visits have a return destination.
  await page.getByTestId("sidebar-new-chat").click();
  await expect(page.getByTestId("composer-textarea").first()).toBeVisible();
  return { app: restarted, mainWindow: page };
}
