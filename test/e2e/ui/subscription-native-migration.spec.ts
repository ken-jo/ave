import { test, expect } from "@playwright/test";
import { openInlineSettings } from "./inline-settings.js";
import { buildE2eBaseSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

for (const locale of ["en", "ko"] as const) {
  for (const errorCode of ["subscription-runtime-native-required", "subscription-runtime-unauthenticated"] as const) {
    const nativeMigration = errorCode === "subscription-runtime-native-required";
    test(`explains ${nativeMigration ? "native runtime migration" : "publisher verification"} without running installer commands in ${locale}`, async ({}, testInfo) => {
      const context = await launchSeededElectron({ historyRows: [], settings: buildE2eBaseSettings(true, locale) });
      try {
        await context.app.context().tracing.start({ screenshots: true, snapshots: true });
        await context.app.evaluate(({ ipcMain }, runtimeError) => {
          ipcMain.removeHandler("ave:settings:subscription:status");
          ipcMain.handle("ave:settings:subscription:status", async (_event, provider: string) => ({
            ok: false,
            error: provider === "claude-code" ? runtimeError : "subscription-runtime-not-configured",
            status: {
              provider, runtime: provider === "claude-code" ? "unavailable" : "not-configured", connection: "unknown",
              errorCode: provider === "claude-code" ? runtimeError : "subscription-runtime-not-configured",
              planType: null, version: null, pendingLogin: null, pendingDeviceCode: null, canOpenVerificationUrl: false,
              capabilities: { chat: false, images: false, imageAttachmentLimits: null, files: false, tools: false,
                projectAccess: false, plugins: false, mcp: false, generateText: false, compaction: false, routine: false, subagent: false },
            },
          }));
        }, errorCode);
        const appFailure = new Promise<never>((_resolve, reject) => {
          context.page.on("pageerror", reject);
          context.page.on("dialog", (dialog) => reject(new Error(`App dialog: ${dialog.type()}: ${dialog.message()}`)));
        });
        await Promise.race([appFailure, (async () => {
          const page = await openInlineSettings(context.app, context.page, "llm");
          await page.getByTestId("llm-tab:add-provider").click();
          await page.getByTestId("llm-tab:add-provider-item:claude-code").click();
          await page.getByTestId("llm-tab:sign-in-method:claude-code:subscription").click();
          const error = page.getByTestId("subscription-provider:claude-code:error");
          await expect(error).toHaveText(nativeMigration
            ? locale === "en"
              ? "This subscription runtime requires a native installation. Run claude install or use the official native installer, then remove the npm-installed copy and check again."
              : "이 구독 실행 환경은 네이티브 설치가 필요합니다. claude install 또는 공식 네이티브 설치 프로그램으로 설치한 다음 npm으로 설치한 복사본을 제거하고 다시 확인하세요."
            : locale === "en"
              ? "The subscription runtime publisher could not be verified. Follow the official setup guide to verify or reinstall it, then check again."
              : "구독 실행 환경의 배포자를 확인할 수 없습니다. 공식 설치 안내에 따라 서명을 확인하거나 다시 설치한 뒤 다시 확인하세요.");
          const guidance = page.getByTestId(`subscription-provider:claude-code:${nativeMigration ? "native-install-guidance" : "publisher-verification-guidance"}`);
          if (nativeMigration) {
            await expect(guidance).toContainText("claude install");
            await expect(guidance).toContainText("npm uninstall -g @anthropic-ai/claude-code");
          }
          await expect(guidance).not.toContainText("npm install");
          await expect(guidance).toContainText("https://code.claude.com/docs/en/setup");
          await expect(page.getByTestId("subscription-provider:claude-code:login-browser")).toHaveCount(0);
          await expect(page.getByTestId("subscription-provider:claude-code:check-again")).toBeEnabled();
          await guidance.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(nativeMigration ? "native-runtime-migration.png" : "publisher-verification.png") });
        })()]);
      } finally {
        await context.app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") });
        await teardownSeededElectron(context, { terminate: true });
      }
    });
  }
}
