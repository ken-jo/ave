import { test, expect } from "./fixtures.js";
import type { ElectronApplication, Page } from "playwright";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_ENTRY, buildE2eBaseSettings, buildE2eSecrets, buildIsolatedElectronEnv, launchElectron, teardownSeededElectron } from "./seeded-electron.js";

// Real list, preload and pane-history wiring against an isolated persisted conversation.
test("pane-bound sidebar row reveals its terminal and chat without opening the rail", async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "ave-pane-chat-routing-"));
  const userData = join(root, "user-data");
  const home = join(root, "home");
  const featureHome = join(home, ".ave");
  const tabId = "terminal:abcd1234-1";
  const parentId = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const sideId = "a2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  try {
    mkdirSync(userData, { recursive: true });
    mkdirSync(join(featureHome, "sessions"), { recursive: true });
    mkdirSync(join(featureHome, "side-chat", "sessions"), { recursive: true });
    writeFileSync(join(userData, "ave-settings.json"), JSON.stringify({
      ...buildE2eBaseSettings(true, "en"),
      system: { mainLayout: {
        version: 1, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main",
        surfaces: { main: { kind: "terminal", tabId, ordinal: 1, cwd: null, url: null } },
        panelOpenIds: [], thumbnailOpenIds: [], sideTabs: {},
      } },
    }));
    writeFileSync(join(userData, "ave-secrets.json"), JSON.stringify(buildE2eSecrets()), { mode: 0o600 });
    writeFileSync(join(featureHome, "sessions", `${parentId}.jsonl`), `${JSON.stringify({ role: "user", content: "Parent conversation" })}\n`);
    writeFileSync(join(featureHome, "sessions", `${parentId}.meta.json`), JSON.stringify({ title: "Parent conversation" }));
    writeFileSync(join(featureHome, "sessions", ".active-session.json"), JSON.stringify({
      mainActiveMode: "resume", mainActiveSessionId: parentId, updatedAt: new Date().toISOString(),
    }));
    writeFileSync(join(featureHome, "side-chat", "sessions", `${sideId}.jsonl`), [
      { role: "user", content: "Inspect this terminal" },
      { role: "assistant", content: "Terminal conversation marker" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(join(featureHome, "side-chat", "sessions", `${sideId}.meta.json`), JSON.stringify({
      sessionKind: "main", title: "Terminal conversation", paneTabId: tabId, originSessionId: parentId,
    }));
    app = await launchElectron({
      args: [MAIN_ENTRY, `--user-data-dir=${userData}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({ HOME: home, USERPROFILE: home, AVE_HOME: featureHome, AVE_DEV: "1", AVE_E2E: "1", NODE_ENV: "test" }),
    });
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    page = await app.firstWindow();
    await expect(page.getByTestId("main-toolbar").first()).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: testInfo.outputPath("pane-chat-initial-layout.png") });
    // Session hydration selects the parent after layout restoration; the terminal stays live in the surface inventory.
    const surfaceRow = page.getByTestId(`sidebar-surface-${tabId}`);
    await expect(surfaceRow).toBeVisible();
    await expect(page.getByTestId(`sidebar-surface-chats-${tabId}`).getByTestId(`sidebar-session-${sideId}`)).toBeVisible();
    await expect(page.getByTestId(`sidebar-session-${sideId}`)).toHaveCount(1);
    await surfaceRow.click();
    await expect(page.locator(`[data-testid="surface-pane"][data-tab-id="${tabId}"]`)).toBeVisible();
    await page.getByTestId(`sidebar-session-${parentId}`).click();
    await expect(page.getByTestId("pane-chat")).toHaveCount(0);
    await page.getByTestId(`sidebar-session-${sideId}`).click();
    const paneChat = page.locator(`[data-testid="pane-chat"][data-tab-id="${tabId}"]`);
    await expect(page.locator(`[data-testid="surface-pane"][data-tab-id="${tabId}"]`)).toBeVisible();
    await expect(paneChat).toBeVisible();
    await expect(paneChat).toContainText("Terminal conversation marker");
    await expect(page.getByTestId("side-chat-view")).toHaveCount(1);
    await expect(page.getByTestId("assistant-system-notice")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("pane-chat-routing.png") });
    await app.context().tracing.stop({ path: testInfo.outputPath("pane-chat-routing-trace.zip") });
  } finally {
    if (app && page) await teardownSeededElectron({ app, page, userDataDir: userData, tempHome: home, aveHome: featureHome }, { terminate: true });
    rmSync(root, { recursive: true, force: true });
  }
});
