import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let bootstrapScript: string;

test.use({ viewport: { width: 980, height: 640 }, trace: "on" });

test.beforeAll(async () => {
  // Exercise the unmounted startup panel directly, including the host refusal
  // path. No running host or provider credentials are needed for this state.
  const bundle = await build({
    stdin: {
      resolveDir: REPO_ROOT,
      contents: `
        import { installRendererModelCatalog, renderModelCatalogUnavailable } from "./src/ui/renderer/model-catalog-bootstrap.ts";
        import { loadLocaleMessages } from "./src/i18n/messages/index.ts";
        import { setLocale } from "./src/i18n/runtime.ts";
        window.showCatalogFailure = async (locale, code) => {
          await loadLocaleMessages(locale);
          setLocale(locale);
          const failure = await installRendererModelCatalog({
            getModelCatalog: async () => ({ ok: false, error: code }),
          }).catch(error => error);
          renderModelCatalogUnavailable(document.getElementById("root"), failure);
        };
      `,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
  });
  bootstrapScript = bundle.outputFiles[0]!.text;
});

for (const { locale, code, message, reloadLabel } of [
  {
    locale: "en", code: "catalog-unavailable",
    message: "The model catalog is not available yet. Please restart the app.", reloadLabel: "Reload",
  },
  {
    locale: "ko", code: "unauthorized-frame",
    message: "인증되지 않은 프레임에서의 요청입니다. 창을 새로고침하거나 앱을 다시 시작해 주세요.", reloadLabel: "새로고침",
  },
] as const) {
  test(`startup refusal is localized in ${locale}`, async ({ page }, testInfo) => {
    await page.setContent('<style>*{box-sizing:border-box}body{margin:0}</style><div id="root"></div>');
    await page.addScriptTag({ content: bootstrapScript });
    await page.evaluate(async ({ locale, code }) => {
      const startup = window as unknown as { showCatalogFailure: (locale: string, code: string) => Promise<void> };
      await startup.showCatalogFailure(locale, code);
    }, { locale, code });

    const panel = page.getByRole("alert");
    await expect(panel).toBeVisible();
    await expect(panel).not.toContainText(code);
    await expect(panel).toContainText(message);
    const reload = panel.getByRole("button", { name: reloadLabel, exact: true });
    await expect(reload).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`model-catalog-unavailable-${locale}.png`) });
    await Promise.all([page.waitForEvent("framenavigated"), reload.click()]);
  });
}
