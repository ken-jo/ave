import { test, expect } from "./fixtures";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildE2eSecrets, buildIsolatedElectronEnv } from "./seeded-electron";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

/**
 * Side-chat tab render smoke — opens the dedicated side-chat workspace tab in a
 * real Electron boot and asserts the SideChatView (its own composer / New / send
 * affordances) renders. This exercises the second ConversationLoop's UI surface
 * end-to-end (boot wiring → dedicated IPC preload → SideChatView) without a live
 * LLM: it proves the engine is reachable, not the model round-trip (the seeded
 * `sk-e2e-*` key does not produce a real stream).
 */
test.describe("side-chat tab", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "ave-side-chat-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "ave-side-chat-home-"));
    writeFileSync(
      resolve(userDataDir, "ave-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true), null, 2) + "\n",
      "utf-8",
    );
    writeFileSync(
      resolve(userDataDir, "ave-secrets.json"),
      JSON.stringify(buildE2eSecrets(), null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
    app = await electron.launch({
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

  test("opens the side-chat tab and renders the dedicated SideChatView", async () => {
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();

    // The launcher exposes side chat as a first-class workspace item.
    const launcher = page.getByTestId(chatSidePanelLauncherTestId("side-chat"));
    await expect(launcher).toBeVisible();
    await launcher.click();

    // The dedicated, lightweight SideChatView mounts (not a placeholder).
    await expect(page.getByTestId("side-chat-view")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-side-chat-placeholder")).toHaveCount(0);

    // The SHARED composer (same component as the main dock, at the side
    // surface) + the New affordance are present; the field is the side chat's
    // own instance, independent of the main chat's textarea.
    const sideView = page.getByTestId("side-chat-view");
    await expect(sideView.getByTestId("composer-textarea")).toBeVisible();
    await expect(sideView.getByTestId("composer-textarea")).toHaveAttribute("data-composer-surface", "side");
    await expect(page.getByTestId("side-chat-new")).toBeVisible();
    // Idle: New is enabled (only disabled mid-stream — MAJOR 2 UI guard).
    await expect(page.getByTestId("side-chat-new")).toBeEnabled();
  });

  test("side-chat renders tool / thinking / permission through the shared TranscriptRenderer", async () => {
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("side-chat")).click();
    await expect(page.getByTestId("side-chat-view")).toBeVisible();

    // Start a turn so the reducer arms its stream (send resolves only when the
    // turn ends, but the transcript is driven by the DEDICATED side stream).
    const sideView = page.getByTestId("side-chat-view");
    await sideView.getByTestId("composer-textarea").fill("run a tool");
    await expect(sideView.getByTestId("composer-send-button")).toBeEnabled();
    await sideView.getByTestId("composer-send-button").click();

    // Inject synthetic side-chat frames onto the DEDICATED side channel via the
    // dev-only E2E seam (AVE_DEV=1). This proves the side transcript renders
    // tool groups + reasoning + permission-review status through the SAME
    // shared primitives as the main transcript — the unification contract.
    const groupId = `e2e-side-${Date.now()}`;
    const toolUseId = `tu-side-${Date.now()}`;
    const toolName = `side_fixture_${Date.now()}`;
    const result = `42 files (${toolUseId})`;
    const reasoning = `Side fixture reasoning (${groupId})`;
    const seamAvailable = await page.evaluate(({ groupId, toolUseId, toolName, result, reasoning }) => {
      type StreamFn = (event: unknown) => void;
      const w = window as unknown as { __aveSideChatStream?: { _emit?: StreamFn } };
      const emit = w.__aveSideChatStream?._emit;
      if (typeof emit !== "function") return false;
      // streamId 1 is the first turn's id (main allocates ++nextSideStreamId).
      emit({ type: "reasoning_delta", streamId: 1, text: reasoning });
      emit({
        type: "permission_review",
        streamId: 1,
        reviewStatus: "reviewing",
        name: toolName,
        groupId,
        toolUseId,
        displayOrder: 0,
      });
      emit({ type: "tool_start", streamId: 1, name: toolName, groupId, toolUseId, displayOrder: 0, input: {} });
      emit({ type: "tool_end", streamId: 1, name: toolName, groupId, toolUseId, result, isError: false, durationMs: 900 });
      emit({ type: "done", streamId: 1 });
      return true;
    }, { groupId, toolUseId, toolName, result, reasoning });

    expect(seamAvailable).toBe(true);

    const toolRow = sideView.getByTestId("tool-row-header").filter({ hasText: toolName.replace(/_/g, " ") });
    await expect(toolRow).toBeVisible();
    await expect(toolRow.getByTestId("permission-review-status-card")).toHaveAttribute("data-status", "reviewing");
    await toolRow.click();
    await expect(sideView.getByText(result, { exact: true })).toBeVisible();

    const workGroup = sideView.getByTestId("work-group");
    await expect(workGroup).toHaveCount(1);
    const groupToggle = workGroup.locator(":scope > button");
    if (await groupToggle.getAttribute("aria-expanded") === "false") await groupToggle.click();
    await workGroup.getByRole("button", { name: /생각 완료|Thought complete/ }).click();
    await expect(workGroup.getByText(reasoning, { exact: true })).toBeVisible();
  });
});
