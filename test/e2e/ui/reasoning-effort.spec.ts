import { test, expect } from "@playwright/test";
import { closeInlineSettings, openInlineSettings } from "./inline-settings.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";
import { makeTestT } from "./i18n.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";

test("persists the maximum rung and updates its visibility with the selected model", async ({}, testInfo) => {
  const ctx = await launchSeededElectron({ historyRows: [], settings: buildLlmSettings("openai", "gpt-6.1-sol") });
  const { app, page } = ctx;
  const t = makeTestT("ko");
  try {
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({ ok: false, error: "model-list-fetch-failed" }));
    }, CHANNELS.settings.listLlmModels);
    await page.evaluate(async () => {
      await window.aveApi.updateSettings({ llm: { vendors: { openai: {
        enableThinking: true, thinkingBudgetTokens: 8_000, outputTokenLimit: 2_000,
      } } } });
    });
    await openInlineSettings(app, page, "llm");
    const section = page.getByTestId("llm-tab:section-thinking");
    const maximum = section.getByRole("button", { name: t("constants.reasoningEffortMax"), exact: true });
    await expect(maximum).toBeVisible();
    await maximum.click();
    await expect(maximum).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(async () =>
      (await window.aveApi.getSettings()).llm.vendors.openai?.thinkingBudgetTokens,
    )).toBe(64_000);
    await section.screenshot({ path: testInfo.outputPath("maximum-rung.png") });
    await closeInlineSettings(app, page);
    await openInlineSettings(app, page, "llm");
    await expect(maximum).toHaveAttribute("aria-pressed", "true");
    await closeInlineSettings(app, page);
    await page.evaluate(async () => {
      await window.aveApi.updateSettings({ llm: { vendors: { openai: { model: "o3-mini" } } } });
    });
    await openInlineSettings(app, page, "llm");
    await expect(maximum).toHaveCount(0);
    await expect(section.getByRole("slider")).toHaveAttribute("aria-valuemax", "3");
    await section.screenshot({ path: testInfo.outputPath("ordinary-rungs.png") });
    await closeInlineSettings(app, page);
  } finally {
    await teardownSeededElectron(ctx, { terminate: true });
  }
});
