import { writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { openInlineSettings } from "./inline-settings.js";
import { buildE2eBaseSettings, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";

for (const locale of ["en", "ko"] as const) {
  test(`shows reported quota gauges and a labeled burn-rate projection in ${locale}`, async ({ browserName: _browserName }, testInfo) => {
    const context = await launchSeededElectron({ historyRows: [], settings: buildE2eBaseSettings(true, locale) });
    try {
      await context.app.context().tracing.start({ screenshots: true, snapshots: true });
      await context.app.evaluate(({ ipcMain }) => {
        const observedAt = Date.now();
        const status = (provider: string) => ({
          provider, runtime: "ready", connection: "connected", planType: null, version: null,
          pendingLogin: null, pendingDeviceCode: null, canOpenVerificationUrl: false,
          capabilities: { chat: true, images: false, imageAttachmentLimits: null, files: false, tools: false,
            projectAccess: false, plugins: false, mcp: false, generateText: false, compaction: false, routine: false, subagent: false },
          ...(provider === "codex" ? { planUsage: { observedAt, windows: [
            { id: "codex:primary", usedPercent: 64, windowDurationMins: 300, resetsAt: observedAt + 7_200_000,
              projectedLimitAt: observedAt + 3_600_000 },
            { id: "codex:secondary", usedPercent: 18, windowDurationMins: 10_080, resetsAt: observedAt + 86_400_000 },
          ] } } : {}),
        });
        ipcMain.removeHandler("ave:settings:subscription:status");
        ipcMain.handle("ave:settings:subscription:status", async (_event, provider: string) => ({ ok: true, status: status(provider) }));
        ipcMain.removeHandler("ave:settings:subscription:list-models");
        ipcMain.handle("ave:settings:subscription:list-models", async (_event, provider: string) => ({ ok: true, status: status(provider), models: [] }));
      });
      const page = await openInlineSettings(context.app, context.page, "llm");
      await setWindowSize(context.app, 1100, 760);
      for (const provider of ["codex", "kimi-code"]) {
        const row = page.getByTestId(`llm-tab:connection:${provider}`);
        if (await row.count() === 0) {
          await page.getByTestId("llm-tab:add-provider").click();
          await page.getByTestId(`llm-tab:add-provider-item:${provider}`).click();
        } else {
          await page.getByTestId(`llm-tab:connection:${provider}:toggle`).click();
        }
        const method = page.getByTestId(`llm-tab:sign-in-method:${provider}:subscription`);
        if (await method.count()) await method.click();
        const card = page.getByTestId(`subscription-provider:${provider}`);
        if (provider === "kimi-code") {
          await expect(card.getByTestId("subscription-plan-usage")).toHaveCount(0);
          continue;
        }
        const usage = card.getByTestId("subscription-plan-usage");
        await expect(usage).toBeVisible();
        await expect(usage).toContainText(locale === "en" ? "64% used" : "64% 사용");
        await expect(usage).toContainText(locale === "en" ? "18% used" : "18% 사용");
        await expect(usage.getByTestId("subscription-plan-usage:warning")).toHaveText(locale === "en"
          ? /At the observed pace, projected to reach the limit around .+, before reset\. This is an estimate\./
          : /관측된 속도가 유지되면 초기화 전인 .+경 한도에 도달할 것으로 추정됩니다\./);
        await usage.scrollIntoViewIfNeeded();
        const bounds = await usage.boundingBox();
        expect(bounds).not.toBeNull();
        if (!bounds) throw new Error("Usage view has no visible bounds");
        expect(bounds.height).toBeLessThan(300);
        const cdp = await context.app.context().newCDPSession(page);
        const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
        await writeFile(testInfo.outputPath("subscription-usage-cdp.png"), Buffer.from(screenshot.data, "base64"));
        await cdp.detach();
      }
    } finally {
      await context.app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") });
      await teardownSeededElectron(context, { terminate: true });
    }
  });
}
