import { expect, type Page } from "@playwright/test";
import { realpathSync } from "node:fs";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";
import { teardownSeededElectron, type SeededElectronContext } from "./seeded-electron.js";

export async function openDocumentSessionFiles(page: Page, directory: string): Promise<void> {
  await page.getByTestId(TEST_IDS.panePanelToggle).click();
  await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();
  const root = page.getByTestId("chat-side-panel-root-select");
  await expect(root).toBeVisible();
  await root.selectOption(realpathSync(directory));
  const session = page.getByTestId("chat-side-panel-file-filter-session");
  await session.click();
  await expect(session).toHaveAttribute("aria-pressed", "true");
}

/** Files shows tree and detail side by side only from FILE_WORKSPACE_COLUMNS_MIN_WIDTH; the default side panel is narrower, so a
 * column spec widens the panel through its own resize separator the way a keyboard user does (ArrowLeft widens a start-edge bar). */
export async function showFileColumns(page: Page): Promise<void> {
  const browser = page.getByTestId("chat-side-panel-file-browser");
  await expect(browser).toBeVisible();
  const panelSplitter = page.getByTestId("chat-side-panel-width-splitter");
  for (let step = 0; step < 40 && await browser.getAttribute("data-file-layout") !== "columns"; step++) {
    await panelSplitter.focus();
    await page.keyboard.press("ArrowLeft");
  }
  await expect(browser).toHaveAttribute("data-file-layout", "columns");
}

export async function openDocumentSessionFile(page: Page, name: string): Promise<void> {
  const back = page.getByTestId("chat-side-panel-file-back");
  if (await back.isVisible()) await back.click();
  await page.getByTestId("chat-side-panel-fs-file").filter({ has: page.getByText(name, { exact: true }) }).click();
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Native quit reaps the owned children before their absence is verified. */
export async function teardownDocumentPreview(ctx: SeededElectronContext): Promise<void> {
  const child = ctx.app.process();
  const pid = child.pid;
  let ownedPids: number[] = [];
  let metricsError: unknown;
  try { ownedPids = await ctx.app.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.pid)); }
  catch (error) { metricsError = error; }
  finally { await teardownSeededElectron(ctx); }
  expect(child.exitCode !== null || child.signalCode !== null, `Fixture ${String(pid)} did not exit`).toBe(true);
  for (const ownedPid of new Set([...(pid ? [pid] : []), ...ownedPids])) {
    await expect.poll(() => processExists(ownedPid), { message: `Owned fixture process ${ownedPid} remained alive` }).toBe(false);
  }
  console.log("Document preview fixture process exit verified", { pid, exitCode: child.exitCode, signalCode: child.signalCode });
  if (metricsError) throw metricsError;
}
