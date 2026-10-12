import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestT } from "./i18n.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STYLES = resolve(REPO_ROOT, "dist/src/styles.css");
let componentScript: string;

test.use({ viewport: { width: 980, height: 640 }, trace: "on" });
test.skip(!existsSync(STYLES), "Renderer styles are required; run bun run build:styles.");

test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: REPO_ROOT,
      loader: "tsx",
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { TokenProgressRing } from "./src/ui/renderer/components/TokenProgressRing.tsx";
        import { TooltipProvider } from "./src/components/ui/tooltip.tsx";
        import { useCostEstimate } from "./src/ui/renderer/hooks/use-cost-estimate.ts";
        import { installModelCatalog } from "./src/shared/model-catalog/active.ts";
        import catalog from "./src/core/model-catalog/bundled-snapshot.json";
        import { loadLocaleMessages } from "./src/i18n/messages/index.ts";
        import { setLocale } from "./src/i18n/runtime.ts";
        installModelCatalog(catalog);
        const entries = [
          ...[90000, 1000, 2000, 3000, 4000, 5000].map(tokensOut => ({ kind: "turn_summary", tokensIn: 2000, tokensOut })),
          { kind: "context_usage", tokensIn: 2000, source: "compact-estimate" },
        ];
        function CostSurface() {
          const [limited, setLimited] = useState(false);
          const { costEstimate, costBadgeClass } = useCostEstimate({ entries, draft: { text: "" },
            llmVendor: "openai", llmModel: "gpt-5.4-mini", maxOutputTokens: limited ? 2048 : 32000,
            outputLimitSource: limited ? "provider-reported" : "user" });
          return <TooltipProvider><main className="p-8 flex items-center gap-8">
            <TokenProgressRing used={2000} budget={272000} costEstimate={costEstimate} costClass={costBadgeClass} />
            <button data-testid="set-output-limit" onClick={() => setLimited(true)}>2048</button>
          </main></TooltipProvider>;
        }
        window.showCostSurface = async locale => {
          await loadLocaleMessages(locale); setLocale(locale);
          createRoot(document.getElementById("root")).render(<CostSurface />);
        };
      `,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  componentScript = bundle.outputFiles[0]!.text;
});

for (const locale of ["en", "ko"] as const) {
  test(`expected output cost range and changed limit in ${locale}`, async ({ page }, testInfo) => {
    const t = makeTestT(locale);
    await page.setContent(`<style>${readFileSync(STYLES, "utf8")}</style><div id="root"></div>`);
    await page.addScriptTag({ content: componentScript });
    await page.evaluate(async (locale) => {
      const surface = window as unknown as { showCostSurface: (locale: string) => Promise<void> };
      await surface.showCostSurface(locale);
    }, locale);
    await page.getByTestId("token-progress-ring").click();
    const total = page.getByTestId("token-progress-ring-cost-total");
    // 2K input and the last-five mean of 3K output: $0.015 expected,
    // versus $0.146 with the 32K limit. The 90K older turn is excluded.
    await expect(total).toHaveText("~$0.015 – $0.146");
    await expect(total.locator("..")).toHaveClass(/text-success/);
    await expect(page.getByTestId("token-progress-ring-output-limit-source"))
      .toContainText(t("chatView.costOutputLimitSourceUser"));
    await page.screenshot({ path: testInfo.outputPath(`model-output-cost-${locale}.png`) });

    await page.getByTestId("set-output-limit").click();
    await page.getByTestId("token-progress-ring").click();
    await expect(total).toHaveText("~$0.011");
    await expect(page.getByTestId("token-progress-ring-output-limit-source"))
      .toContainText(t("chatView.costOutputLimitSourceProviderReported"));
  });
}
