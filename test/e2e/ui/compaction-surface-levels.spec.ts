import { test, expect } from "./fixtures.js";
import { CHANNELS, MAIN_CHAT_GROUP_ID } from "../../../src/contract/app-contract.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";
import { getUsableContext } from "../../../src/shared/context-budget.js";

test.use({ seedViewFixturePlugin: false });

for (const surface of ["main", "side"] as const) {
  for (const width of [360, 900, 1243, 1600]) {
    test(`${surface} compaction history and next-send warning keep their levels at ${width}px`, async ({ app, mainWindow: page }, testInfo) => {
      await page.setViewportSize({ width: 1243, height: 900 });
      const contextWindow = 200_000;
      await page.evaluate(async (contextWindow) => {
        const api = window.aveApi;
        const result = await api.updateSettings({ llm: {
          provider: "openai",
          vendors: { openai: { model: "gpt-5.4-mini", contextWindow } },
        } });
        if ("ok" in result && !result.ok) throw new Error(result.error);
      }, contextWindow);
      const estimatedAfter = Math.ceil(getUsableContext(contextWindow) * 1.09);
      await expect(page.locator('[data-composer-surface="main"] [data-testid="iab-status-model"]')).toContainText("gpt-5.4-mini");
      await app.evaluate(({ ipcMain }, { channels, group, estimatedAfter }) => {
        const notice = { type: "compact_notice", removedMessages: 3, freedTokens: 100, estimatedAfter, summary: "## Preserved decisions\n\nKeep history and the next send separate.", compactNum: 1, compactStatus: "summarized" };
        ipcMain.removeHandler(channels.chat.compact);
        ipcMain.handle(channels.chat.compact, (event) => {
          event.sender.send(channels.chat.stream, { ...notice, chatGroupId: group, trigger: "manual" });
          return { compacted: true, removedMessageCount: 3, compactedAt: "2026-10-26", summary: notice.summary };
        });
        ipcMain.removeHandler(channels.sidechat.send);
        ipcMain.handle(channels.sidechat.send, (event, payload) => {
          event.sender.send(channels.sidechat.stream, { type: "user_message", text: payload.input, sessionId: "compaction-side", streamId: 1, sendRequestId: payload.sendRequestId });
          event.sender.send(channels.sidechat.stream, { ...notice, sessionId: "compaction-side", streamId: 1, trigger: "auto-compact" });
          event.sender.send(channels.sidechat.stream, { type: "done", sessionId: "compaction-side", streamId: 1 });
          return { ok: true, result: {} };
        });
      }, { channels: CHANNELS, group: MAIN_CHAT_GROUP_ID, estimatedAfter });

      if (surface === "side") {
        await page.getByTestId(TEST_IDS.panePanelToggle).click();
        await page.getByTestId(chatSidePanelLauncherTestId("side-chat")).click();
      }
      const root = surface === "main" ? page.getByTestId("chat-main-column") : page.getByTestId("side-chat-view");
      const dock = root.locator(`[data-composer-surface="${surface}"]`);
      await dock.getByTestId("composer-textarea").fill(surface === "main" ? "/compact" : "Capture side history");
      await dock.getByTestId("composer-send-button").click();
      await expect(root.getByTestId("summary-toast")).toBeVisible();
      // Give the owning chat column the viewport, independently of desktop shell pane sizing.
      await root.evaluate((column) => {
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;inset:0;z-index:100;background:hsl(var(--background));display:flex";
        document.getElementById("root")!.append(host);
        host.append(column);
        (column as HTMLElement).style.cssText = "display:flex;flex:1;min-width:0;width:100%;height:100%";
      });
      await page.setViewportSize({ width, height: 900 });
      const warning = dock.getByTestId("composer-context-notice");
      await expect(warning).toBeVisible();
      await expect(warning).toHaveAttribute("role", "status");
      await expect(warning).toHaveAttribute("aria-live", "polite");
      await expect(warning).toHaveAttribute("data-severity", "warning");
      await expect(warning).toContainText("109%");
      await expect(root.getByTestId("checkpoint-divider")).toHaveCount(1);
      await expect(root.getByTestId("summary-toast")).toHaveCount(1);
      const unit = root.getByTestId("checkpoint-divider");
      await expect(unit.getByTestId("summary-toast")).toHaveCount(1);
      await expect(unit).not.toContainText(/📦|📖|↩/u);
      if (surface === "main") {
        await expect(unit.getByTestId("ck-btn-view")).toHaveClass(/bg-secondary/);
        await expect(unit.getByTestId("ck-btn-fork")).toHaveClass(/bg-secondary/);
      }
      await expect(root.getByTestId("system-entry")).toHaveCount(0);
      const geometry = await root.evaluate((root) => {
        const frame = root.querySelector('[data-testid="composer-frame"]')!.getBoundingClientRect();
        const notice = root.querySelector('[data-testid="composer-context-notice"]')!.getBoundingClientRect();
        const summary = root.querySelector('[data-testid="summary-toast"]')!;
        return { frame: { left: frame.left, right: frame.right, width: frame.width }, notice: { left: notice.left, right: notice.right }, history: !!summary.closest('[data-testid="chat-transcript-log"],[data-testid="side-chat-transcript"]'), scrollWidth: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth };
      });
      expect(geometry.frame.width).toBeGreaterThan(Math.min(width - 40, 300));
      expect(Math.abs(geometry.notice.left - geometry.frame.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.notice.right - geometry.frame.right)).toBeLessThanOrEqual(1);
      expect(geometry.history).toBe(true);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
      const summary = root.getByTestId("summary-toast");
      const disclosure = summary.locator("summary");
      await disclosure.click();
      expect(await disclosure.evaluate((element) => element.matches(":focus-visible"))).toBe(false);
      await disclosure.press("Enter");
      await expect(summary).not.toHaveAttribute("open");
      await disclosure.press("Space");
      await expect(summary).toHaveAttribute("open");
      await page.screenshot({ path: testInfo.outputPath("compaction-levels.png") });
    });
  }
}
