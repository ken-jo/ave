import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildE2eBaseSettings, buildIsolatedElectronEnv, MAIN_ENTRY } from "./seeded-electron.js";

test("missing-plugin routines retain their status and can be removed", async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "routine-missing-e2e-"));
  const userData = join(root, "user-data");
  const aveHome = join(root, "profile");
  mkdirSync(userData, { recursive: true });
  mkdirSync(join(aveHome, "routine"), { recursive: true });
  writeFileSync(join(userData, "ave-settings.json"), JSON.stringify(buildE2eBaseSettings(true, "en")));
  const now = new Date(Date.now() - 60_000).toISOString();
  const routinePath = join(aveHome, "routine", "routines.json");
  writeFileSync(routinePath, JSON.stringify({ version: 2, routines: [
    { id: "missing", title: "Unavailable summary", trigger: "schedule", execution: "llm-session", prePrompt: "Summarize", createdAt: now,
      schedule: { at: now }, scope: { pluginIds: { mode: "allow", ids: ["absent-plugin"] }, forcedPluginIds: [], directories: [] } },
    { id: "partial", title: "Partial summary", trigger: "schedule", execution: "llm-session", createdAt: now,
      schedule: { at: now }, lastFiredAt: now, needsAttention: { missingPluginIds: ["other-plugin"] } },
  ] }));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userData}`, "--no-sandbox"],
    env: Object.fromEntries(Object.entries(buildIsolatedElectronEnv({ AVE_HOME: aveHome, AVE_DEV: "1", AVE_E2E: "1", AVE_MAIN_ENTRY: MAIN_ENTRY, NODE_ENV: "test", ELECTRON_DISABLE_SECURITY_WARNINGS: "1" })).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
    const page = await app.firstWindow();
    await page.getByTestId("main-toolbar").first().waitFor({ timeout: 60_000 });
    await page.getByTestId("sidebar-group-features").click();
    await page.getByTestId("sidebar-routines").click();
    const panel = page.getByTestId("routine-panel");
    const skipped = panel.getByTestId("routine-row").filter({ hasText: "Unavailable summary" });
    const partial = panel.getByTestId("routine-row").filter({ hasText: "Partial summary" });
    await expect(skipped.getByRole("status")).toContainText("Skipped:", { timeout: 45_000 });
    await expect(skipped.getByRole("status")).toContainText("absent-plugin");
    await expect(partial.getByRole("status")).toContainText("Needs attention:");
    await expect(partial.getByRole("status")).toContainText("other-plugin");
    const stored = JSON.parse(readFileSync(routinePath, "utf8"));
    expect(stored.routines.find((row: { id: string }) => row.id === "missing").lastFiredAt).toBeUndefined();
    await page.screenshot({ path: testInfo.outputPath("routine-status-desktop.png"), fullPage: true });
    await skipped.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(skipped).toHaveCount(0);
    await partial.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(panel.getByTestId("routine-row")).toHaveCount(0);
    expect(JSON.parse(readFileSync(routinePath, "utf8")).routines).toEqual([]);
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
