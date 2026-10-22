import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";

test("explains how to repair an unsafe subscription executable location", async ({ app, mainWindow }, testInfo) => {
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
  await expect(error).toContainText("must not be writable by other users");
  await expect(error).toContainText("Choose a protected installation path");
  await expect(settings.getByTestId("subscription-provider:codex:change-runtime")).toBeVisible();
  await expect(settings.getByTestId("subscription-provider:codex:login-browser")).toHaveCount(0);
  await error.scrollIntoViewIfNeeded();
  await settings.screenshot({ path: testInfo.outputPath("unsafe-runtime-location.png") });
});
