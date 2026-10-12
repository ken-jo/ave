import { test, expect } from "./fixtures.js";
import { closeInlineSettings, openInlineSettings } from "./inline-settings.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { llmImageInputKey } from "../../../src/shared/llm-vendor-defaults.js";
import { llmModelListCacheKey } from "../../../src/shared/llm-model-list.js";

const MODEL = "opaque-model";
const ENDPOINT = "https://models.e2e.invalid/v1";
const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lvkAAAAASUVORK5CYII=";

for (const locale of ["en", "ko"] as const) {
  test.describe(`custom model image declaration (${locale})`, () => {
    test.use({ seedLocale: locale });

    test("names the setting in the refusal, persists support and restores the conservative default", async ({ app, mainWindow, t }, testInfo) => {
      await app.evaluate(({ ipcMain }, channels) => {
        ipcMain.removeHandler(channels.hasApiKey);
        ipcMain.handle(channels.hasApiKey, (_event, provider) => provider === "openai-compatible");
        ipcMain.removeHandler(channels.listLlmModels);
        ipcMain.handle(channels.listLlmModels, () => ({ ok: false, error: "model-list-fetch-failed", message: "No remote catalog in this fixture" }));
      }, { hasApiKey: CHANNELS.settings.hasApiKey, listLlmModels: CHANNELS.settings.listLlmModels });
      await mainWindow.evaluate(async ({ model, endpoint, key }) => {
        await window.aveApi.updateSettings({ llm: {
          provider: "openai-compatible",
          vendors: { "openai-compatible": { model, baseUrl: endpoint } },
          modelListCache: { [key]: { vendor: "openai-compatible", baseUrl: endpoint, endpoint: `${endpoint}/models`, models: [model], modelEntries: [{ id: model }], fetchedAt: new Date().toISOString() } },
        } });
      }, { model: MODEL, endpoint: ENDPOINT, key: llmModelListCacheKey("openai-compatible", ENDPOINT, "") });

      const textarea = mainWindow.getByTestId(TEST_IDS.composerTextarea);
      await expect(textarea).toBeEnabled();
      await textarea.evaluate((element, png) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(atob(png), (character) => character.charCodeAt(0))], "fixture.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
      }, IMAGE);
      const refusal = mainWindow.getByTestId("composer-vision-unsupported-hint");
      await expect(refusal).toBeVisible();
      const settingsPath = [t("settingsContent.sidebarHeading"), t("llmTab.pageTitle"), t("llmTab.imageInput")].join(" → ");
      await expect(refusal).toContainText(t("llmTab.imageInputRecovery", { settingsPath }));

      const settings = await openInlineSettings(app, mainWindow, "llm");
      const control = settings.getByRole("combobox", { name: t("llmTab.imageInput"), exact: true });
      await expect(control).toContainText(t("llmTab.imageInputAutomatic"));
      await control.click();
      await settings.getByRole("option", { name: t("llmTab.imageInputSupported"), exact: true }).click();
      await expect(control).toContainText(t("llmTab.imageInputSupported"));
      await expect.poll(() => mainWindow.evaluate(async (key) => {
        const saved = await window.aveApi.getSettings();
        return saved.llm.vendors["openai-compatible"]?.imageInput?.[key];
      }, llmImageInputKey(MODEL))).toBe(true);
      await testInfo.attach("image-input-setting", { body: await control.locator("..").screenshot(), contentType: "image/png" });

      await closeInlineSettings(app, settings);
      await expect(refusal).toHaveCount(0);
      await openInlineSettings(app, mainWindow, "llm");
      await expect(control).toContainText(t("llmTab.imageInputSupported"));
      await control.click();
      await settings.getByRole("option", { name: t("llmTab.imageInputAutomatic"), exact: true }).click();
      await expect(control).toContainText(t("llmTab.imageInputAutomatic"));
      await expect.poll(() => mainWindow.evaluate(async (key) => {
        const saved = await window.aveApi.getSettings();
        return saved.llm.vendors["openai-compatible"]?.imageInput?.[key] ?? "automatic";
      }, llmImageInputKey(MODEL))).toBe("automatic");
      await closeInlineSettings(app, settings);
      await expect(refusal).toBeVisible();
    });
  });
}
