import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { llmModelListCacheKey } from "../../../src/shared/llm-model-list.js";

const CASE_MODELS = [
  // The saved id matches both reports by case. Its badges use the catalog's
  // text input and no-tools declaration instead of borrowing either report.
  { model: "gPt-3.5-tUrBo", vision: false, tools: false },
  { model: "GPT-3.5-Turbo", vision: true, tools: true },
  { model: "gpt-3.5-turbo", vision: false, tools: false },
];

for (const locale of ["en", "ko"] as const) {
  test.describe(`model capability reports (${locale})`, () => {
    test.use({ seedLocale: locale });

    test("keeps case-distinct badges and selected model ids separate", async ({ app, mainWindow, t }, testInfo) => {
      await app.evaluate(({ ipcMain }, channels) => {
        ipcMain.removeHandler(channels.hasApiKey);
        ipcMain.handle(channels.hasApiKey, (_event, provider) => provider === "openai");
        // Keep the saved reports authoritative while refresh is unavailable.
        ipcMain.removeHandler(channels.listLlmModels);
        ipcMain.handle(channels.listLlmModels, () => ({ ok: false, error: "model-list-fetch-failed", message: "No remote catalog in this fixture" }));
      }, { hasApiKey: CHANNELS.settings.hasApiKey, listLlmModels: CHANNELS.settings.listLlmModels });
      await mainWindow.evaluate(async (cacheKey) => {
        await window.aveApi.updateSettings({ llm: {
          provider: "openai",
          vendors: { openai: { model: "gPt-3.5-tUrBo" } },
          modelListCache: { [cacheKey]: {
            vendor: "openai", endpoint: "https://models.e2e.invalid/v1/models", models: ["GPT-3.5-Turbo", "gpt-3.5-turbo"],
            modelEntries: [
              { id: "GPT-3.5-Turbo", inputModalities: ["text", "image"], supportedParameters: ["tools"] },
              { id: "gpt-3.5-turbo", inputModalities: ["text"], supportedParameters: ["temperature"] },
            ],
            fetchedAt: new Date(0).toISOString(),
          } },
        } });
      }, llmModelListCacheKey("openai"));

      const settings = await openInlineSettings(app, mainWindow, "llm");
      const chooser = settings.getByTestId(TEST_IDS.llmModelSelect);
      await expect(chooser).toBeVisible();
      await chooser.click();
      const content = settings.locator('[data-slot="select-content"]');
      for (const { model, vision, tools } of CASE_MODELS) {
        const row = content.locator('[data-slot="select-item"]').filter({ has: settings.locator(`[data-model-id="${model}"]`) });
        await expect(row).toBeVisible();
        await expect(row.getByTestId(`llm-tab:model-vision:${model}`)).toHaveCount(vision ? 1 : 0);
        await expect(row.getByTestId(`llm-tab:model-no-tools:${model}`)).toHaveCount(tools ? 0 : 1);
        if (!tools) {
          const badge = row.getByTestId(`llm-tab:model-no-tools:${model}`);
          await expect(badge).toHaveText(t("llmTab.modelNoToolsBadge"));
          await expect(badge).toHaveAttribute("aria-label", t("llmTab.modelNoToolsHelp"));
          await expect(badge).toHaveAttribute("title", t("llmTab.modelNoToolsHelp"));
        }
      }
      const measure = () => [...document.querySelectorAll('[data-slot="select-content"] [data-slot="select-item"]')].map((element) => ({
        model: element.querySelector('[data-model-id]')?.getAttribute("data-model-id"),
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      }));
      const cdp = await settings.context().newCDPSession(settings);
      const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression: `(${measure.toString()})()`, returnByValue: true });
      await cdp.detach();
      expect(exceptionDetails).toBeUndefined();
      const rows = result.value as ReturnType<typeof measure>;
      for (const { model } of CASE_MODELS) expect(rows.some((row) => row.model === model)).toBe(true);
      for (const row of rows) expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      await testInfo.attach("picker-row-metrics", { body: JSON.stringify(rows), contentType: "application/json" });
      await testInfo.attach("picker", { body: await content.screenshot(), contentType: "image/png" });
      await settings.keyboard.press("Escape");

      for (const { model } of CASE_MODELS) {
        await chooser.click();
        await content.locator('[data-slot="select-item"]').filter({ has: settings.locator(`[data-model-id="${model}"]`) }).click();
        await expect.poll(() => mainWindow.evaluate(async () => (await window.aveApi.getSettings()).llm.vendors.openai?.model)).toBe(model);
        await expect(chooser).toContainText(model);
      }
    });
  });
}
