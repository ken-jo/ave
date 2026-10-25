import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import type { McpAuthStatus } from "../../../src/mcp/types.js";

test.use({ seedViewFixturePlugin: false });

test("remote server settings show authentication progress, success and reauthentication", async ({ app, mainWindow, t }, testInfo) => {
  await app.evaluate(({ ipcMain }, channels) => {
    type AddedConfig = { id: string; transport: "http"; url: string; auth: "oauth"; oauth: Record<string, never> };
    type Fixture = { authStatus: McpAuthStatus; calls: unknown[][]; addedConfig?: AddedConfig; finish?: (authenticated: boolean) => void };
    const fixture: Fixture = { authStatus: "required", calls: [] };
    (globalThis as unknown as { __mcpOAuthUiFixture: Fixture }).__mcpOAuthUiFixture = fixture;
    for (const channel of [channels.servers, channels.configGet, channels.configPath, channels.configAdd, channels.authenticate]) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.handle(channels.servers, () => [{
      id: "remote-a", status: fixture.authStatus === "authenticated" ? "connected" : "disconnected",
      registeredTools: [], authStatus: fixture.authStatus,
    }, ...(fixture.addedConfig ? [{ id: fixture.addedConfig.id, status: "disconnected", registeredTools: [], authStatus: "required" }] : [])]);
    ipcMain.handle(channels.configGet, () => [{ id: "remote-a", transport: "http", url: "https://example.test/mcp", auth: "oauth", oauth: {} }, ...(fixture.addedConfig ? [fixture.addedConfig] : [])]);
    ipcMain.handle(channels.configPath, () => "/tmp/ave-test-fixture/.mcp.json");
    ipcMain.handle(channels.configAdd, (_event, config: AddedConfig) => {
      fixture.addedConfig = config;
      return { connected: false, errorCode: "mcp-auth-required" };
    });
    ipcMain.handle(channels.authenticate, (_event, ...args: unknown[]) => {
      fixture.calls.push(args);
      fixture.authStatus = "authenticating";
      return new Promise((resolve) => {
        fixture.finish = (authenticated) => {
          fixture.authStatus = authenticated ? "authenticated" : "required";
          resolve(authenticated ? { connected: true } : { connected: false, errorCode: "mcp-auth-required" });
        };
      });
    });
  }, CHANNELS.mcp);

  const settings = await openInlineSettings(app, mainWindow, "mcp");
  const row = settings.locator('[data-mcp-server-id="remote-a"]');
  await expect(row.getByRole("status")).toHaveText(t("mcpTab.authRequired"));
  await row.getByRole("button", { name: t("mcpTab.authenticateButton"), exact: true }).click();
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { __mcpOAuthUiFixture: { calls: unknown[][] } }).__mcpOAuthUiFixture.calls.length,
  )).toBe(1);
  await expect(row.getByRole("button", { name: t("mcpTab.authenticating"), exact: true })).toBeDisabled();
  await expect(row.getByRole("status")).toHaveText(t("mcpTab.authenticating"));
  await testInfo.attach("authentication-progress", { body: await row.screenshot(), contentType: "image/png" });

  await app.evaluate(() => {
    const fixture = (globalThis as unknown as { __mcpOAuthUiFixture: { finish?: (authenticated: boolean) => void } }).__mcpOAuthUiFixture;
    fixture.finish?.(true);
  });
  await expect(row.getByRole("status")).toHaveText(t("mcpTab.authenticated"));
  await expect(settings.getByText(t("mcpTab.authSuccess", { id: "remote-a" }), { exact: true })).toBeVisible();
  await testInfo.attach("authenticated-server", { body: await row.screenshot(), contentType: "image/png" });

  await app.evaluate(() => {
    (globalThis as unknown as { __mcpOAuthUiFixture: { authStatus: string } }).__mcpOAuthUiFixture.authStatus = "required";
  });
  await expect(row.getByRole("status")).toHaveText(t("mcpTab.authRequired"));
  await row.getByRole("button", { name: t("mcpTab.authenticateButton"), exact: true }).click();
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { __mcpOAuthUiFixture: { calls: unknown[][] } }).__mcpOAuthUiFixture.calls.length,
  )).toBe(2);
  await app.evaluate(() => {
    (globalThis as unknown as { __mcpOAuthUiFixture: { finish?: (authenticated: boolean) => void } }).__mcpOAuthUiFixture.finish?.(false);
  });
  await expect(settings.getByText(t("mcpTab.authRequiredMessage"), { exact: true })).toBeVisible();
  await expect(row.getByRole("status")).toHaveText(t("mcpTab.authRequired"));
  expect(await app.evaluate(() => (globalThis as unknown as { __mcpOAuthUiFixture: { calls: unknown[][] } }).__mcpOAuthUiFixture.calls))
    .toEqual([["remote-a"], ["remote-a"]]);

  await settings.getByRole("button", { name: t("mcpTab.addServerButton"), exact: true }).click();
  await expect(settings.getByRole("option", { name: t("mcpTab.authOAuth"), exact: true })).toHaveCount(0);
  await settings.getByLabel(t("mcpTab.transportLabel"), { exact: true }).selectOption("http");
  await expect(settings.getByRole("option", { name: t("mcpTab.authOAuth"), exact: true })).toHaveCount(1);
  await settings.getByLabel(t("mcpTab.authLabel"), { exact: true }).selectOption("oauth");
  await expect(settings.getByLabel(t("mcpTab.apiKeyWriteOnlyLabel"), { exact: true })).toBeDisabled();
  await settings.getByLabel(t("mcpTab.transportLabel"), { exact: true }).selectOption("stdio");
  await expect(settings.getByLabel(t("mcpTab.authLabel"), { exact: true })).toHaveValue("none");
  await settings.getByLabel(t("mcpTab.transportLabel"), { exact: true }).selectOption("http");
  await settings.getByLabel(t("mcpTab.authLabel"), { exact: true }).selectOption("oauth");
  await settings.getByLabel(t("mcpTab.serverIdLabel"), { exact: true }).fill("remote-b");
  await settings.getByLabel(t("mcpTab.urlRequiredLabel"), { exact: true }).fill("https://example.test/other");
  await settings.getByRole("button", { name: t("mcpTab.addButton"), exact: true }).click();
  await expect(settings.getByText(t("mcpTab.serverSavedAuthRequired", { id: "remote-b" }), { exact: true })).toBeVisible();
  const addedRow = settings.locator('[data-mcp-server-id="remote-b"]');
  await expect(addedRow.getByRole("status")).toHaveText(t("mcpTab.authRequired"));
  await expect(addedRow.getByRole("button", { name: t("mcpTab.authenticateButton"), exact: true })).toBeEnabled();
  await testInfo.attach("saved-server-needs-authentication", { body: await addedRow.screenshot(), contentType: "image/png" });
});
