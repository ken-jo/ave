import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";

test("explains how to repair an unsafe subscription executable location", async ({ app, mainWindow, t }, testInfo) => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("ave:settings:subscription:status");
    ipcMain.handle("ave:settings:subscription:status", async (_event, provider: unknown) => ({
      ok: false,
      error: provider === "codex" ? "subscription-runtime-unsafe-location" : "subscription-runtime-not-configured",
      status: {
        provider,
        runtime: provider === "codex" ? "unavailable" : "not-configured",
        connection: "signed-out", planType: null, version: null,
        pendingLogin: null, pendingDeviceCode: null, canOpenVerificationUrl: false,
        capabilities: { chat: false, images: false, imageAttachmentLimits: null, files: false, tools: false,
          projectAccess: false, plugins: false, mcp: false, generateText: false, compaction: false, routine: false, subagent: false },
      },
    }));
  });
  const settings = await openInlineSettings(app, mainWindow, "llm");
  const row = settings.getByTestId("llm-tab:connection:codex");
  if (await row.count() === 0) {
    await settings.getByTestId("llm-tab:add-provider").click();
    await settings.getByTestId("llm-tab:add-provider-item:codex").click();
  } else {
    await settings.getByTestId("llm-tab:connection:codex:toggle").click();
  }
  const error = settings.getByTestId("subscription-provider:codex:error");
  // The repair copy names the ownership rule and the remedy (fd5ff52c0); read it from the catalog.
  await expect(error).toContainText(t("subscriptionProvidersSection.errorRuntimeUnsafeLocation"));
  // Ave finds codex itself (fd5ff52c0): there is no runtime to change, so the way back is "check again" after reinstalling.
  await expect(settings.getByTestId("subscription-provider:codex:cli-unavailable")
    .getByRole("button", { name: t("subscriptionProvidersSection.checkAgain") })).toBeVisible();
  await expect(settings.getByTestId("subscription-provider:codex:change-runtime")).toHaveCount(0);
  await expect(settings.getByTestId("subscription-provider:codex:login-browser")).toHaveCount(0);
  await error.scrollIntoViewIfNeeded();
  await settings.screenshot({ path: testInfo.outputPath("unsafe-runtime-location.png") });
});
