import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInlineSettings } from "./inline-settings.js";
import { buildE2eBaseSettings, buildIsolatedElectronEnv, MAIN_ENTRY, launchElectron } from "./seeded-electron.js";

test("recorded run metrics appear on schedule chips, details and completed board cards", async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "routine-metrics-e2e-"));
  const userData = join(root, "user-data");
  const aveHome = join(root, "profile");
  mkdirSync(userData, { recursive: true });
  mkdirSync(join(aveHome, "routine"), { recursive: true });
  writeFileSync(join(userData, "ave-settings.json"), JSON.stringify(buildE2eBaseSettings(true, "ko")));
  const today = new Date();
  today.setHours(9, 0, 0, 0);
  const firedAt = today.toISOString();
  const older = new Date(today.getTime() - 3_600_000).toISOString();
  const next = new Date(today.getTime() + 86_400_000).toISOString();
  writeFileSync(join(aveHome, "routine", "routines.json"), JSON.stringify({ version: 2, routines: [{
    id: "measured", title: "Measured routine", trigger: "schedule", execution: "llm-session", prePrompt: "Summarize",
    createdAt: older, lastFiredAt: firedAt, schedule: { at: next, repeat: { kind: "daily" } },
    runs: [
      { routineId: "measured", firedAt: older, status: "done" },
      { routineId: "measured", firedAt, status: "failed", metrics: { startedAt: firedAt, durationMs: 192_000, tokens: { input: 4000, output: 100, total: 4100 } } },
    ],
  }] }));
  const launch = () => launchElectron({
    args: [MAIN_ENTRY, `--user-data-dir=${userData}`, "--no-sandbox"],
    env: buildIsolatedElectronEnv({ AVE_HOME: aveHome, AVE_DEV: "1", AVE_E2E: "1", AVE_MAIN_ENTRY: MAIN_ENTRY, NODE_ENV: "test" }),
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    const reviewPage = await app.firstWindow();
    await reviewPage.getByTestId("main-toolbar").first().waitFor({ timeout: 60_000 });
    const settings = await openInlineSettings(app, reviewPage, "permissions");
    const pending = settings.getByTestId("home-trust-row").filter({ hasText: "routine/routines.json" });
    await pending.getByTestId("home-trust-approve").click();
    await expect(pending).toHaveCount(0);
    await app.close();
    app = await launch();
    const page = await app.firstWindow();
    await page.getByTestId("main-toolbar").first().waitFor({ timeout: 60_000 });
    await page.getByTestId("sidebar-routines").click();
    const panel = page.getByTestId("schedule-panel");
    const measured = panel.getByTestId("schedule-chip").filter({ has: page.getByTestId("routine-run-metrics") });
    await expect(measured).toHaveCount(1);
    await expect(measured).toContainText("3분 12초 · 4.1k 토큰");
    await measured.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("schedule-run-chip.png"), fullPage: true });
    await measured.click();
    const recent = page.getByTestId("schedule-recent-runs");
    await expect(recent.getByTestId("routine-run-metrics")).toHaveCount(1);
    await expect(recent).toContainText("3분 12초 · 4.1k 토큰");
    await page.screenshot({ path: testInfo.outputPath("schedule-run-detail.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await page.getByTestId("sidebar-card-work-board").click();
    await page.getByTestId("work-board-show-schedule").waitFor();
    const completedTab = page.getByTestId("work-board-tab-completed");
    if (await completedTab.isVisible()) await completedTab.click();
    const bundle = page.getByTestId("board-schedule-week");
    await bundle.getByRole("button", { expanded: false }).click();
    await expect(bundle.getByTestId("routine-run-metrics")).toHaveCount(1);
    await expect(bundle).toContainText("3분 12초 · 4.1k 토큰");
    await page.screenshot({ path: testInfo.outputPath("board-run-metrics.png"), fullPage: true });
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
