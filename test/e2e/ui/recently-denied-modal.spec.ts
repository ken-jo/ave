import { test, expect } from "./fixtures";
import { type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildIsolatedElectronEnv, launchElectron } from "./seeded-electron";
import { makeTestT } from "./i18n";

// This independently seeded harness uses Korean regardless of the shared fixture locale.
const t = makeTestT("ko");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

const LONG_INPUT_SUMMARY = JSON.stringify({
  allowedPlugins: [],
  execution: "llm-session",
  notifications: {
    token: "abcdefghijklmnopqrstuvwxyz0123456789".repeat(8),
    endpoint: "https://example.invalid/really/long/path/that/must/not/stretch/the-modal",
  },
  payload:
    "routine_schedule_write_payload_with_a_very_long_unbroken_identifier_".repeat(7),
});

test.describe("recent denial history modal", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "ave-denial-history-modal-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "ave-denial-history-modal-home-"));
    writeFileSync(
      resolve(userDataDir, "ave-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true), null, 2) + "\n",
      "utf-8",
    );
    const aveHome = resolve(tempHome, ".ave");
    const queueDir = resolve(aveHome, "permissions");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(
      resolve(queueDir, "recently-denied.json"),
      JSON.stringify([{
        id: "12345678-1234-1234-1234-123456789abc",
        ts: "2026-05-11T09:00:00.000Z",
        toolName: "routine_schedule",
        source: "builtin",
        category: "write",
        inputSummary: LONG_INPUT_SUMMARY,
        reason: "Nobody can approve this request; do not retry.",
      }]) + "\n",
      "utf-8",
    );

    app = await launchElectron({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        AVE_HOME: aveHome,
        AVE_DEV: "1",
        AVE_E2E: "1",
        AVE_MAIN_ENTRY: MAIN_ENTRY,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("keeps long denied input inside the modal without horizontal page overflow", async () => {
    await page.setViewportSize({ width: 460, height: 840 });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+B" : "Control+Shift+B");
    await expect(page.getByTestId("primary-sidebar")).toHaveCount(0);
    const queueButton = page.getByTestId("permission-pending-badge");
    await queueButton.waitFor({ state: "visible", timeout: 20_000 });
    await expect(queueButton).toContainText(t("permissionModeBadge.queueLabelCount", { count: 1 }));
    await queueButton.click();

    const dialog = page.getByTestId("recently-denied-dialog");
    await expect(dialog).toBeVisible();
    const entry = dialog.getByTestId("recently-denied-entry-12345678-1234-1234-1234-123456789abc");
    await expect(entry.locator("code", { hasText: "routine_schedule" }).first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: t("recentlyDenied.rerun") })).toBeDisabled();
    await expect(dialog.getByText(t("recentlyDenied.unavailable"))).toBeVisible();

    await page.screenshot({ path: test.info().outputPath("recently-denied.png") });
    const metrics = await collectModalMetrics(page);
    expect(metrics.documentOverflowX).toBeLessThanOrEqual(1);
    expect(metrics.dialogOverflowX).toBeLessThanOrEqual(1);
    expect(metrics.panelOverflowX).toBeLessThanOrEqual(1);
    expect(metrics.entryOverflowX).toBeLessThanOrEqual(1);
    expect(metrics.inputPreviewOverflowX).toBeLessThanOrEqual(1);
  });
});

async function collectModalMetrics(page: Page) {
  return page.evaluate(() => {
    const overflowX = (el: Element | null) => {
      if (!el) return 0;
      const target = el as HTMLElement;
      return Math.max(0, target.scrollWidth - target.clientWidth);
    };
    const doc = document.documentElement;
    const dialog = document.querySelector('[data-testid="recently-denied-dialog"]');
    const panel = document.querySelector('[data-testid="recently-denied-panel"]');
    const entry = document.querySelector('[data-testid="recently-denied-entry-12345678-1234-1234-1234-123456789abc"]');
    const inputPreview = document.querySelector('[data-testid="recently-denied-input"]') ?? entry?.querySelector("pre") ?? null;
    return {
      documentOverflowX: Math.max(0, doc.scrollWidth - window.innerWidth),
      dialogOverflowX: overflowX(dialog),
      panelOverflowX: overflowX(panel),
      entryOverflowX: overflowX(entry),
      inputPreviewOverflowX: overflowX(inputPreview),
    };
  });
}
