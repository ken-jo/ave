import { test, expect } from "@playwright/test";
import { openInlineSettings } from "./inline-settings.js";
import { buildE2eBaseSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

for (const locale of ["en", "ko"] as const) {
  test(`offers signed-out sign-in and shows a failed verification in ${locale}`, async ({}, testInfo) => {
    const context = await launchSeededElectron({ historyRows: [], settings: buildE2eBaseSettings(true, locale) });
    try {
      await context.app.evaluate(({ ipcMain }) => {
        let verificationFailed = false;
        ipcMain.removeHandler("ave:settings:subscription:status");
        ipcMain.handle("ave:settings:subscription:status", async (_event, provider: string) => {
          if (provider === "codex" && verificationFailed) {
            return { ok: false, error: "subscription-operation-failed" };
          }
          return { ok: true, status: {
            provider, runtime: "unverified", connection: provider === "codex" ? "unknown" : "signed-out",
            planType: null, version: "1.2.3", pendingLogin: null,
            pendingDeviceCode: null, canOpenVerificationUrl: false,
            capabilities: { chat: false, images: false, imageAttachmentLimits: null, files: false,
              tools: false, projectAccess: false, plugins: false, mcp: false, generateText: false,
              compaction: false, routine: false, subagent: false },
          } };
        });
        ipcMain.removeHandler("ave:settings:subscription:verify");
        ipcMain.handle("ave:settings:subscription:verify", async () => {
          verificationFailed = true;
          return { ok: false, error: "subscription-runtime-unavailable" };
        });
      });
      await context.app.context().tracing.start({ screenshots: true, snapshots: true });
      const page = await openInlineSettings(context.app, context.page, "llm");
      for (const provider of ["claude-code", "kimi-code", "grok-build", "codex"]) {
        const row = page.getByTestId(`llm-tab:connection:${provider}`);
        if (await row.count() === 0) {
          await page.getByTestId("llm-tab:add-provider").click();
          await page.getByTestId(`llm-tab:add-provider-item:${provider}`).click();
        } else {
          await page.getByTestId(`llm-tab:connection:${provider}:toggle`).click();
        }
        const method = page.getByTestId(`llm-tab:sign-in-method:${provider}:subscription`);
        if (await method.count()) await method.click();
        if (provider !== "codex") {
          const loginMethod = provider === "claude-code" ? "browser" : "device-code";
          const login = page.getByTestId(`subscription-provider:${provider}:login-${loginMethod}`);
          await expect(login).toBeVisible();
          await expect(login).toBeEnabled();
          await expect(page.getByTestId(`subscription-provider:${provider}:verify-runtime`)).toHaveCount(0);
          await login.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`${provider}-sign-in.png`) });
        }
      }
      await page.getByTestId("subscription-provider:codex:verify-runtime").click();
      const error = page.getByTestId("subscription-provider:codex:error");
      await expect(error).toBeVisible();
      await expect(error).toHaveText(locale === "en"
        ? "The subscription runtime is unavailable."
        : "구독 런타임을 사용할 수 없습니다.");
      await error.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("verify-error.png") });
    } finally {
      await context.app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") }).catch(() => {});
      await teardownSeededElectron(context);
    }
  });
}
