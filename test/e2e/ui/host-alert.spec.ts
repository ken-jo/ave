import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AveApi } from "../../../src/ui/renderer/types.js";
import { MAIN_ENTRY, buildE2eBaseSettings, buildIsolatedElectronEnv } from "./seeded-electron.js";

test("host deadline cards use built-in presentation and service-owned Settings", async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "ave-host-alert-"));
  const userData = join(root, "user-data");
  const home = join(root, "home");
  const featureHome = join(home, ".ave");
  let app: ElectronApplication | undefined;
  try {
    mkdirSync(userData, { recursive: true });
    mkdirSync(join(featureHome, "work-board"), { recursive: true });
    mkdirSync(join(featureHome, "sessions"), { recursive: true });
    writeFileSync(join(userData, "ave-settings.json"), JSON.stringify({
      ...buildE2eBaseSettings(true, "en"),
      alerts: {
        osNotificationsEnabled: true,
        kinds: { "@host:due-soon": { enabled: true, osNotification: false, visibility: "user-visible", seenByUser: false } },
      },
    }));
    const now = new Date().toISOString();
    writeFileSync(join(featureHome, "work-board", "board.json"), JSON.stringify({
      version: 1, nextId: 8,
      items: [{ id: 7, title: "Prepare the weekly report", status: "planned", priority: "medium",
        created_at: now, updated_at: now, due_at: new Date(Date.now() + 3_600_000).toISOString() }],
    }));
    const sessionId = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
    writeFileSync(join(featureHome, "sessions", `${sessionId}.jsonl`),
      `${JSON.stringify({ role: "user", content: "Review my work" })}\n${JSON.stringify({ role: "assistant", content: "Ready." })}\n`);
    writeFileSync(join(featureHome, "sessions", `${sessionId}.meta.json`), JSON.stringify({ title: "Work review" }));
    writeFileSync(join(featureHome, "sessions", ".active-session.json"), JSON.stringify({
      mainActiveMode: "resume", mainActiveSessionId: sessionId, updatedAt: now,
    }));
    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userData}`, "--no-sandbox"],
      env: Object.fromEntries(Object.entries(buildIsolatedElectronEnv({ HOME: home, USERPROFILE: home, AVE_HOME: featureHome,
        AVE_DEV: "1", AVE_E2E: "1", NODE_ENV: "test" })).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    });
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    const page = await app.firstWindow();
    await expect(page.getByTestId("main-toolbar").first()).toBeVisible({ timeout: 60_000 });
    const card = page.getByTestId("routine-card");
    await expect(card).toContainText("Due soon: Prepare the weekly report");
    await expect(card).toContainText("Built-in notice");
    await expect(card.getByTestId("plugin-provenance-id")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("host-alert.png") });
    const settingsResult = await page.evaluate(async () => {
      const api = (window as unknown as { aveApi: AveApi }).aveApi;
      const kinds = await api.alerts!.listKinds();
      const cards = await api.alerts!.listOpen();
      const choice = await api.alerts!.setKind("@host:due-soon", { enabled: false });
      const master = await api.alerts!.setOsNotificationsEnabled(false);
      return { kinds, cards, choice, master };
    });
    expect(settingsResult.kinds).toMatchObject([{ kindKey: "@host:due-soon", pluginLabel: "Built-in" }]);
    expect(settingsResult.cards[0]?.pendingPrompt).toContain('source="overlay:host--due-soon"');
    expect(settingsResult.choice).toMatchObject({ choice: { enabled: false, seenByUser: true } });
    expect(settingsResult.master).toEqual({ osNotificationsEnabled: false });
    await card.getByTestId("routine-card-dismiss").click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () =>
      (window as unknown as { aveApi: AveApi }).aveApi.alerts!.listOpen())).toEqual([]);
    await app.context().tracing.stop({ path: testInfo.outputPath("host-alert-trace.zip") });
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
