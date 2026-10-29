import { test, expect } from "./fixtures";
import { type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildE2eSecrets, buildIsolatedElectronEnv, launchElectron } from "./seeded-electron";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

// Verify the dedicated side conversation through real boot and preload wiring without a live model.
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

  test("opens the side-chat tab and renders the dedicated SideChatView", async () => {
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();

    const launcher = page.getByTestId(chatSidePanelLauncherTestId("side-chat"));
    await expect(launcher).toBeVisible();
    await launcher.click();

    await expect(page.getByTestId("side-chat-view")).toBeVisible();

    // Side chat owns a separate instance of the shared composer.
    const sideView = page.getByTestId("side-chat-view");
    await expect(sideView.getByTestId("composer-textarea")).toBeVisible();
    await expect(sideView.getByTestId("composer-textarea")).toHaveAttribute("data-composer-surface", "side");
    await expect(page.getByTestId("side-chat-new")).toBeVisible();
    await expect(page.getByTestId("side-chat-new")).toBeEnabled();
  });

  test("shows a localized refusal when a new side session cannot be opened", async () => {
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("side-chat")).click();
    const sideView = page.getByTestId("side-chat-view");
    await expect(sideView).toBeVisible();
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({ ok: false, error: "streaming-active" }));
    }, CHANNELS.sidechat.new);
    await page.getByTestId("side-chat-new").click();
    await expect(sideView.getByText(
      "아직 응답을 생성하는 중입니다. 중지하거나 끝날 때까지 기다린 뒤 다시 보내 주세요.",
      { exact: true },
    )).toBeVisible();
    await expect(sideView.getByText("시스템 알림 — 요청을 완료할 수 없음", { exact: true })).toBeVisible();
    await expect(sideView.getByText("시스템 알림 — 응답 스트림 오류", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("side-chat-new")).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("side-session-refusal.png"), fullPage: true });
  });

  test("shows an early provider failure as a stream notice before any prelude", async () => {
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("side-chat")).click();
    const sideView = page.getByTestId("side-chat-view");
    await expect(sideView).toBeVisible();
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({ ok: false, error: "Provider fixture connection failed" }));
    }, CHANNELS.sidechat.send);
    await sideView.getByTestId("composer-textarea").fill("try provider");
    await sideView.getByTestId("composer-send-button").click();
    await expect(sideView.getByText("시스템 알림 — 응답 스트림 오류", { exact: true })).toBeVisible();
    await expect(sideView.getByText("시스템 알림 — 요청을 완료할 수 없음", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("side-early-stream-error.png"), fullPage: true });
  });

  test("side-chat renders tool / thinking / permission through the shared TranscriptRenderer", async () => {
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await page.getByTestId(chatSidePanelLauncherTestId("side-chat")).click();
    await expect(page.getByTestId("side-chat-view")).toBeVisible();

    const sideView = page.getByTestId("side-chat-view");
    await app.evaluate(({ ipcMain }, { sendChannel, streamChannel }) => {
      // Keep renderer assertions independent of provider errors and timing.
      ipcMain.removeHandler(sendChannel);
      ipcMain.handle(sendChannel, (event, payload: { input: string; sendRequestId: string }) => {
        event.sender.send(streamChannel, {
          type: "user_message", text: payload.input, sessionId: "side-fixture", streamId: 1,
          sendRequestId: payload.sendRequestId,
        });
        return { ok: true, result: {} };
      });
    }, { sendChannel: CHANNELS.sidechat.send, streamChannel: CHANNELS.sidechat.stream });
    await page.evaluate(() => {
      const w = window as unknown as {
        aveApi: { sideChat: { onStream: (listener: (event: { type: string; streamId?: number }) => void) => () => void } };
        __sideChatAcceptedStreamId?: number;
      };
      w.aveApi.sideChat.onStream((event) => {
        if (event.type === "user_message" && typeof event.streamId === "number") {
          w.__sideChatAcceptedStreamId = event.streamId;
        }
      });
    });
    await sideView.getByTestId("composer-textarea").fill("run a tool");
    await expect(sideView.getByTestId("composer-send-button")).toBeEnabled();
    await sideView.getByTestId("composer-send-button").click();
    await page.waitForFunction(() => typeof (window as unknown as { __sideChatAcceptedStreamId?: number }).__sideChatAcceptedStreamId === "number");
    const streamId = await page.evaluate(() => (window as unknown as { __sideChatAcceptedStreamId: number }).__sideChatAcceptedStreamId);

    // Inject dedicated-channel frames to verify side chat uses shared transcript primitives.
    const groupId = `e2e-side-${Date.now()}`;
    const toolUseId = `tu-side-${Date.now()}`;
    const toolName = `side_fixture_${Date.now()}`;
    const result = `42 files (${toolUseId})`;
    const reasoning = `Side fixture reasoning (${groupId})`;
    const seamAvailable = await page.evaluate(({ groupId, toolUseId, toolName, result, reasoning, streamId }) => {
      type StreamFn = (event: unknown) => void;
      const w = window as unknown as { __aveSideChatStream?: { _emit?: StreamFn } };
      const emit = w.__aveSideChatStream?._emit;
      if (typeof emit !== "function") return false;
      // Use the accepted host turn id after its ownership prelude.
      emit({ type: "reasoning_delta", streamId, text: reasoning });
      emit({
        type: "permission_review",
        streamId,
        reviewStatus: "reviewing",
        name: toolName,
        groupId,
        toolUseId,
        displayOrder: 0,
      });
      emit({ type: "tool_start", streamId, name: toolName, groupId, toolUseId, displayOrder: 0, input: {} });
      emit({ type: "tool_end", streamId, name: toolName, groupId, toolUseId, result, isError: false, durationMs: 900 });
      emit({ type: "done", streamId });
      return true;
    }, { groupId, toolUseId, toolName, result, reasoning, streamId });

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
