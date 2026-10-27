import { test, expect } from "@playwright/test";
import { openInlineSettings } from "./inline-settings.js";
import { buildE2eBaseSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";

for (const locale of ["en", "ko"] as const) {
  test(`shows subscription and API-key billing in the model chooser in ${locale}`, async ({}, testInfo) => {
    const settings = buildE2eBaseSettings(true, locale);
    settings.llm = { provider: "openai", activeChatRuntime: { kind: "subscription", provider: "claude-code", model: "claude-sonnet-5-5" } };
    const context = await launchSeededElectron({ historyRows: [], settings });
    try {
      await context.app.evaluate(({ ipcMain }, channels) => {
        ipcMain.removeHandler(channels.hasApiKey);
        ipcMain.handle(channels.hasApiKey, (_event, provider) => provider === "openai");
        ipcMain.removeHandler(channels.listLlmModels);
        ipcMain.handle(channels.listLlmModels, () => ({
          ok: true, vendor: "openai", endpoint: "https://api.openai.com/v1/models",
          models: ["gpt-5.4"], modelEntries: [{ id: "gpt-5.4" }], fetchedAt: new Date().toISOString(),
        }));
        const status = (provider: string) => ({
          provider, runtime: "ready", connection: "connected", planType: "pro", version: "1.0.0",
          pendingLogin: null, pendingDeviceCode: null, canOpenVerificationUrl: false,
          capabilities: { chat: true, images: false, imageAttachmentLimits: null, files: true,
            tools: true, projectAccess: true, plugins: true, mcp: true, generateText: true,
            compaction: true, routine: true, subagent: true },
        });
        ipcMain.removeHandler("ave:settings:subscription:status");
        ipcMain.handle("ave:settings:subscription:status", async (_event, provider: string) => ({ ok: true, status: status(provider) }));
        ipcMain.removeHandler("ave:settings:subscription:list-models");
        ipcMain.handle("ave:settings:subscription:list-models", async (_event, provider: string) => ({
          ok: true, status: status(provider), models: [{ id: "claude-sonnet-5-5", displayName: "claude-sonnet-5-5", isDefault: false }],
        }));
      }, { hasApiKey: CHANNELS.settings.hasApiKey, listLlmModels: CHANNELS.settings.listLlmModels });
      await context.app.context().tracing.start({ screenshots: true, snapshots: true });
      const page = await openInlineSettings(context.app, context.page, "llm");
      const select = page.getByTestId(TEST_IDS.llmModelSelect);
      await expect(select).toBeVisible();
      await select.click();
      const popup = page.locator('[data-slot="select-content"]');
      const subscription = popup.locator('[data-model-billing="claude-code"]').first();
      const apiKey = popup.locator('[data-model-billing="api:openai"]').first();
      await expect(subscription).toHaveText(locale === "en"
        ? "Billed to your own Claude subscription, not an API key."
        : "API 키가 아닌 본인의 Claude 구독으로 청구됩니다.");
      await expect(apiKey).toHaveText(locale === "en"
        ? "Billed to your configured API key."
        : "설정한 본인의 API 키로 청구됩니다.");
      await subscription.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("subscription-model-billing.png") });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("llm-tab:model-billing")).toBeVisible();
    } finally {
      await context.app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") }).catch(() => {});
      await teardownSeededElectron(context, { terminate: true });
    }
  });
}
