import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.js";
import { openInlineSettings, closeInlineSettings } from "./inline-settings.js";
import { PERMISSIONS } from "../../../src/shared/ipc-channels.js";

// Exercise the Windows-only surface on the actual app; persistence still uses the real settings IPC.
test("shell local-network consent shows its risk and persists without a restart", async ({ app, mainWindow, userDataDir, t }) => {
  await app.evaluate(async ({ ipcMain }, payload) => {
    const { readFile } = process.getBuiltinModule("fs/promises");
    let containerAvailable = false;
    ipcMain.removeHandler(payload.channel);
    ipcMain.handle(payload.channel, async () => {
      const settings = JSON.parse(await readFile(payload.settingsPath, "utf8"));
      const enabled = settings.features?.windowsShellLocalNetworkAccess === true;
      containerAvailable ||= enabled;
      return {
        platform: "win32", enabled: true, available: true, kind: "partial",
        reason: "fixture", potentialReason: "fixture",
        runtime: { available: true, kind: "none", reason: "fixture" },
        confines: { filesystem: false, process: false, network: false },
        windowsSubstrate: {
          shellLocalNetworkAccess: enabled,
          mxc: { state: containerAvailable ? "available" : "checking" }, windowsBuild: "10.0.26300", srtWinReady: false,
          shells: enabled ? "mxc" : "approved-host", extensions: "none",
          shellEgressIdentity: enabled ? "kernel-channel" : "shared", extensionEgressIdentity: "shared",
        },
      };
    });
  }, { channel: PERMISSIONS.sandboxCapability, settingsPath: join(userDataDir, "ave-settings.json") });

  const settingsPage = await openInlineSettings(app, mainWindow, "permissions");
  const toggle = settingsPage.getByTestId("windows-shell-local-network-toggle");
  await expect(toggle).not.toBeChecked();
  await expect(settingsPage.getByTestId("os-sandbox-windows-substrate")).toHaveAttribute("data-mxc", "checking");
  await expect(settingsPage.getByTestId("windows-shell-local-network-risk"))
    .toHaveText(t("permissionsTab.windowsShellLocalNetworkRisk"));
  await expect(settingsPage.getByTestId("windows-shell-local-network-extension-scope"))
    .toHaveText(t("permissionsTab.windowsShellLocalNetworkExtensionScope"));
  await expect(settingsPage.getByTestId("os-sandbox-windows-substrate-shells"))
    .toHaveText(t("permissionsTab.osSandboxWindowsShellsLocalNetworkOff"));

  await toggle.check();
  await expect.poll(async () => settingsPage.evaluate(async () =>
    (await window.aveApi.getSettings()).features?.windowsShellLocalNetworkAccess,
  )).toBe(true);
  await expect(settingsPage.getByTestId("os-sandbox-windows-substrate")).toHaveAttribute("data-shells", "mxc");
  await expect(settingsPage.getByTestId("os-sandbox-windows-substrate")).toHaveAttribute("data-mxc", "available");
  await expect(settingsPage.getByTestId("os-sandbox-runtime-reason")).toHaveCount(0);
  expect(JSON.parse(readFileSync(join(userDataDir, "ave-settings.json"), "utf8")))
    .toHaveProperty("features.windowsShellLocalNetworkAccess", true);
  await toggle.scrollIntoViewIfNeeded();
  await settingsPage.screenshot({ path: test.info().outputPath("permissions-shell-network.png") });

  await closeInlineSettings(app, settingsPage);
  await openInlineSettings(app, mainWindow, "permissions");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(async () => settingsPage.evaluate(async () =>
    (await window.aveApi.getSettings()).features?.windowsShellLocalNetworkAccess,
  )).toBe(false);
  await expect(settingsPage.getByTestId("os-sandbox-windows-substrate")).toHaveAttribute("data-shells", "approved-host");
  await expect(settingsPage.getByTestId("os-sandbox-windows-substrate")).toHaveAttribute("data-mxc", "available");
  await expect(settingsPage.getByTestId("os-sandbox-windows-substrate-shells"))
    .toHaveText(t("permissionsTab.osSandboxWindowsShellsLocalNetworkOff"));
  await expect(settingsPage.getByRole("dialog")).toHaveCount(0);
  await closeInlineSettings(app, settingsPage);
});
