import { test, expect } from "@playwright/test";
import { buildE2eBaseSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";
import { closeInlineSettings, openInlineSettings } from "./inline-settings.js";

const FAILURE_COPY = {
  en: {
    settings: "Catalog policy could not be read. Reopen these settings to retry.",
    startup: "Ave could not load its model catalog, so the app cannot start.",
    reload: "Reload",
  },
  ko: {
    settings: "카탈로그 정책을 읽지 못했습니다. 이 설정을 다시 열어 재시도하세요.",
    startup: "모델 카탈로그를 불러오지 못해 앱을 시작할 수 없습니다.",
    reload: "새로고침",
  },
} as const;

for (const locale of ["en", "ko"] as const) {
  test(`catalog settings persist and failures recover in ${locale}`, async ({}, testInfo) => {
    const context = await launchSeededElectron({
      historyRows: [],
      settings: { ...buildE2eBaseSettings(true, locale), llm: { modelCatalogRefresh: "off" } },
    });
    const { app, page } = context;
    try {
      const settingsPage = await openInlineSettings(app, page, "llm");
      const control = settingsPage.getByTestId("llm-model-catalog-refresh");
      await expect(control).toBeEnabled();
      await expect(control).toHaveAttribute("aria-checked", "false");
      await control.click();
      await expect(control).toHaveAttribute("aria-checked", "true");
      await control.click();
      await expect(control).toHaveAttribute("aria-checked", "false");
      await expect.poll(() => page.evaluate(async () =>
        (await window.aveApi.getSettings()).llm.modelCatalogRefresh,
      )).toBe("off");

      const catalog = await page.evaluate(() => window.aveApi.getModelCatalog());
      expect(catalog.ok).toBe(true);
      await closeInlineSettings(app, page);
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler("ave:llm:get-model-catalog");
        ipcMain.handle("ave:llm:get-model-catalog", () => ({ ok: false, error: "catalog-unavailable" }));
      });

      await openInlineSettings(app, page, "llm");
      await expect(control).toBeDisabled();
      await expect(page.locator('[data-settings-section="llm-model-catalog"] [role="alert"]'))
        .toHaveText(FAILURE_COPY[locale].settings);

      const logged: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") logged.push(message.text());
      });
      await page.reload();
      const failure = page.getByTestId("model-catalog-unavailable");
      await expect(failure).toContainText(FAILURE_COPY[locale].startup);
      await expect(failure).not.toContainText("catalog-unavailable");
      await expect(failure).not.toContainText("the host refused");
      const reload = failure.getByRole("button", { name: FAILURE_COPY[locale].reload, exact: true });
      await expect(reload).toBeVisible();
      expect(logged.some((message) => message.includes("model catalog unavailable"))).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`catalog-failure-${locale}.png`) });

      await app.evaluate(({ ipcMain }, result) => {
        ipcMain.removeHandler("ave:llm:get-model-catalog");
        ipcMain.handle("ave:llm:get-model-catalog", () => result);
      }, catalog);
      await reload.click();
      await expect(page.getByTestId("main-toolbar")).toBeVisible();
      await expect(page.getByTestId("model-catalog-unavailable")).toHaveCount(0);
      await openInlineSettings(app, page, "llm");
      await expect(control).toBeEnabled();
      await expect(control).toHaveAttribute("aria-checked", "false");
    } finally {
      await teardownSeededElectron(context);
    }
  });
}
