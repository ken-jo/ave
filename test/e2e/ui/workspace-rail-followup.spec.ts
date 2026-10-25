import { test, expect } from "./fixtures";
import { type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildIsolatedElectronEnv, launchElectron } from "./seeded-electron";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

// Verify previews and rail interaction against a real allowed project folder.
test.describe("workspace rail follow-up", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;
  let workspaceDir: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "ave-wsrail-followup-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "ave-wsrail-followup-home-"));
    // Seed files inside the harness working directory, which is the default project root.
    workspaceDir = resolve(tempHome, ".ave", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      resolve(workspaceDir, "architecture.md"),
      "# Architecture Doc\n\nreal-file-content-marker\n",
      "utf-8",
    );
    writeFileSync(
      resolve(userDataDir, "ave-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true), null, 2) + "\n",
      "utf-8",
    );
    app = await launchElectron({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        AVE_HOME: resolve(tempHome, ".ave"),
        AVE_DEV: "1",
        AVE_E2E: "1",
        AVE_MAIN_ENTRY: MAIN_ENTRY,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({ state: "visible", timeout: 60_000 });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("file-browser: project root lists a file and opens its real content", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();

    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();

    await expect(page.getByTestId("chat-side-panel-project-roots")).toBeVisible();
    const fileRow = page.getByTestId("chat-side-panel-fs-file").filter({ hasText: "architecture.md" });
    await expect(fileRow).toBeVisible({ timeout: 10_000 });

    await fileRow.click();
    await expect(page.getByTestId("chat-side-panel-file-preview")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-markdown")).toContainText("real-file-content-marker");
  });

  test("tab bar: many tabs stay reachable via horizontal scroll (diagnosis ②)", async () => {
    await page.setViewportSize({ width: 900, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();

    // Open the first tab from the empty launcher; the tab-bar menu does not exist before it.
    const kinds = ["file-browser", "browser", "terminal", "preview"] as const;
    await page.getByTestId(`chat-side-panel-launcher-${kinds[0]}`).click();
    for (const kind of [...kinds.slice(1), ...kinds]) {
      await page.getByTestId("chat-side-panel-add-tab").click();
      await page.getByTestId(`chat-side-panel-launcher-menu-${kind}`).click();
    }

    const scroll = page.getByTestId("chat-side-panel-tab-scroll");
    await expect(scroll).toBeVisible();

    const canScroll = await scroll.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(canScroll).toBe(true);
    await scroll.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const scrolled = await scroll.evaluate((el) => el.scrollLeft);
    expect(scrolled).toBeGreaterThan(0);
  });

  test("file-browser: ARIA tree, keyboard nav, folder expand, and right-click menu", async () => {
    const docsDir = resolve(workspaceDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(resolve(docsDir, "guide.md"), "# Guide\n\nnested-marker\n", "utf-8");

    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    await page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();

    const tree = page.getByRole("tree");
    await expect(tree).toBeVisible();
    const folderRow = page.getByTestId("chat-side-panel-fs-folder").filter({ hasText: "docs" });
    await expect(folderRow).toBeVisible({ timeout: 10_000 });
    await expect(folderRow).toHaveAttribute("aria-level", "1");
    await expect(folderRow).toHaveAttribute("aria-expanded", "false");

    await folderRow.focus();
    await folderRow.press("ArrowRight");
    await expect(folderRow).toHaveAttribute("aria-expanded", "true");
    await expect(tree.getByRole("group")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-fs-file").filter({ hasText: "guide.md" })).toBeVisible();

    await folderRow.press("ArrowLeft");
    await expect(folderRow).toHaveAttribute("aria-expanded", "false");

    // Close the context menu without invoking the OS file manager.
    await folderRow.click({ button: "right" });
    await expect(page.getByTestId("chat-side-panel-fs-context-menu")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-fs-ctx-reveal")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-fs-ctx-copy-path")).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(page.getByTestId("chat-side-panel-collapse-all")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-remove-root")).toHaveCount(0);
  });
});
