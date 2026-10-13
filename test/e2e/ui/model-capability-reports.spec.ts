import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { llmModelListCacheKey } from "../../../src/shared/llm-model-list.js";

const CASE_MODELS = [
  // The saved id matches both reports by case. Its badges use the catalog's
  // text input and no-tools declaration instead of borrowing either report.
  // (gpt-3.5-turbo, used here before, is deprecated in the catalog and so no
  // longer offered.)
  { model: "tExT-eMbEdDiNg-3-sMaLl", vision: false, tools: false, effortUnknown: false },
  { model: "Text-Embedding-3-Small", vision: true, tools: true, effortUnknown: false },
  { model: "text-embedding-3-small", vision: false, tools: false, effortUnknown: false },
  // Not in the catalog, and its report names no reasoning parameter: thinking
  // would send no effort, so the row says so.
  { model: "gpt-5.1-codex", vision: false, tools: true, effortUnknown: true },
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
          vendors: { openai: { model: "tExT-eMbEdDiNg-3-sMaLl" } },
          modelListCache: { [cacheKey]: {
            vendor: "openai", endpoint: "https://models.e2e.invalid/v1/models",
            models: ["Text-Embedding-3-Small", "text-embedding-3-small", "gpt-5.1-codex"],
            modelEntries: [
              { id: "Text-Embedding-3-Small", inputModalities: ["text", "image"], supportedParameters: ["tools"] },
              { id: "text-embedding-3-small", inputModalities: ["text"], supportedParameters: ["temperature"] },
              { id: "gpt-5.1-codex", inputModalities: ["text"], supportedParameters: ["tools"] },
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
      for (const { model, vision, tools, effortUnknown } of CASE_MODELS) {
        const row = content.locator('[data-slot="select-item"]').filter({ has: settings.locator(`[data-model-id="${model}"]`) });
        await expect(row).toBeVisible();
        await expect(row.getByTestId(`llm-tab:model-reasoning-unstated:${model}`)).toHaveCount(effortUnknown ? 1 : 0);
        if (effortUnknown) {
          const badge = row.getByTestId(`llm-tab:model-reasoning-unstated:${model}`);
          await expect(badge).toHaveText(t("llmTab.modelReasoningUnstatedBadge"));
          await expect(badge).toHaveAttribute("title", t("llmTab.modelReasoningUnstatedHelp", { vendor: "openai" }));
          await expect(badge).toHaveAttribute("title", /llm\.vendors\.openai\.catalogModel/);
        }
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

      // The same rows at a phone-like width: the badges share the id's line.
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.setContentSize(420, 900);
      });
      // A narrow window folds the inline settings away; open them again there.
      const narrowSettings = await openInlineSettings(app, mainWindow, "llm");
      await narrowSettings.getByTestId(TEST_IDS.llmModelSelect).click();
      await expect(narrowSettings.locator('[data-slot="select-content"] [data-slot="select-item"]').first()).toBeVisible();
      const narrowCdp = await narrowSettings.context().newCDPSession(narrowSettings);
      const narrow = await narrowCdp.send("Runtime.evaluate", {
        expression: `(${measure.toString()})()`, returnByValue: true,
      });
      await narrowCdp.detach();
      expect(narrow.exceptionDetails).toBeUndefined();
      const narrowRows = narrow.result.value as ReturnType<typeof measure>;
      expect(narrowRows.some((row) => row.model === "gpt-5.1-codex")).toBe(true);
      for (const row of narrowRows) expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      const pageOverflow = await narrowSettings.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(pageOverflow).toBeLessThanOrEqual(0);
      await testInfo.attach("picker-row-metrics-narrow", { body: JSON.stringify({ rows: narrowRows, pageOverflow }), contentType: "application/json" });
      await testInfo.attach("picker-narrow", {
        body: await narrowSettings.locator('[data-slot="select-content"]').screenshot(), contentType: "image/png",
      });
      await narrowSettings.keyboard.press("Escape");
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.setContentSize(1280, 900);
      });
      await openInlineSettings(app, mainWindow, "llm");

      for (const { model } of CASE_MODELS) {
        await chooser.click();
        await content.locator('[data-slot="select-item"]').filter({ has: settings.locator(`[data-model-id="${model}"]`) }).click();
        await expect.poll(() => mainWindow.evaluate(async () => (await window.aveApi.getSettings()).llm.vendors.openai?.model)).toBe(model);
        await expect(chooser).toContainText(model);
      }
    });
  });
}
