import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpOAuthDependencies } from "../../mcp/mcp-oauth.js";

const capture = vi.hoisted(() => ({ args: [] as unknown[], sink: undefined as { getAllWindows(): unknown[] } | undefined }));
vi.mock("../../mcp/mcp-manager.js", () => ({
  McpManager: class {
    constructor(...args: unknown[]) { capture.args = args; }
    async loadFromConfig() { return []; }
    async handlePolicyWithdrawal() {}
  },
}));
vi.mock("../../mcp/mcp-governance.js", () => ({ McpGovernance: class { startPolicyRefresh() {} } }));
vi.mock("../../mcp/mcp-elicitation-resolver.js", () => ({ createElicitationResolverFactory: () => undefined }));
vi.mock("../../mcp/mcp-server-disconnect-sink.js", () => ({ createMcpServerDisconnectedSink: (deps: { getAllWindows(): unknown[] }) => { capture.sink = deps; return undefined; } }));

import { setupMcp } from "../steps/mcp-setup.js";
import type { BootContext } from "../context.js";

beforeEach(() => { capture.args = []; capture.sink = undefined; });

async function wiring(encrypted = true) {
  const settings = {
    isSecretStorageEncrypted: vi.fn(() => encrypted),
    getSecret: vi.fn(() => "development-plaintext"),
    getEncryptedSecret: vi.fn(() => "encrypted-record"),
    setSecret: vi.fn(async () => {}),
    deleteSecret: vi.fn(async () => {}),
  };
  const windows: unknown[] = [];
  const hostFetch = vi.fn();
  const shellOpenExternal = vi.fn(async () => {});
  const openOAuthLogin = vi.fn(async (_url: string, _login: import("../../main/oauth-login.js").OAuthLoginOptions) => {});
  const context = {
    settingsService: settings, singleHopNetworkFetch: hostFetch,
    host: { desktop: { shellOpenExternal, openOAuthLogin, getAppWindows: () => windows } },
  } as unknown as BootContext;
  await setupMcp(context);
  return { windows, settings, hostFetch, shellOpenExternal, openOAuthLogin, oauth: capture.args[8] as McpOAuthDependencies };
}

describe("remote authorization boot boundaries", () => {
  it("resolves disconnect recipients through live app ownership", async () => {
    const { windows } = await wiring();
    expect(capture.sink?.getAllWindows()).toEqual([]);
    const main = { id: 17, webContents: { id: 23 } };
    windows.push(main);
    expect(capture.sink?.getAllWindows()).toEqual([main]);
  });

  it("uses the host egress transport and rejects legacy plaintext secret reads", async () => {
    const { settings, hostFetch, oauth } = await wiring();
    expect(capture.args[2]).toBe(hostFetch);
    expect(oauth.secrets.getSecret("mcp.oauth.record")).toBe("encrypted-record");
    expect(settings.getEncryptedSecret).toHaveBeenCalledWith("mcp.oauth.record");
    expect(settings.getSecret).not.toHaveBeenCalled();
  });

  it("answers encrypted-storage availability from the settings store, the single source of truth", async () => {
    const { settings, oauth } = await wiring(false);
    expect(oauth.secrets.canStoreEncrypted()).toBe(false);
    expect(settings.isSecretStorageEncrypted).toHaveBeenCalled();
    expect((await wiring(true)).oauth.secrets.canStoreEncrypted()).toBe(true);
  });

  it("refuses credential writes when the settings store cannot encrypt", async () => {
    const { settings, oauth } = await wiring(false);
    await expect(oauth.secrets.setSecret("mcp.oauth.record", "throwaway-secret")).rejects.toThrow("MCP authorization requires encrypted storage");
    expect(settings.setSecret).not.toHaveBeenCalled();
  });

  it("stores credentials through the existing secret store and opens only the host browser surface", async () => {
    const { settings, shellOpenExternal, openOAuthLogin, oauth } = await wiring();
    await oauth.secrets.setSecret("mcp.oauth.record", "throwaway-secret");
    expect(settings.setSecret).toHaveBeenCalledWith("mcp.oauth.record", "throwaway-secret", { requireEncrypted: true });
    await oauth.secrets.deleteSecret("mcp.oauth.record");
    expect(settings.deleteSecret).toHaveBeenCalledWith("mcp.oauth.record");
    const login = { completion: Promise.resolve(), onCancel: vi.fn(), timeoutMs: 10_000 };
    await oauth.openAuthorizationUrl("https://auth.example.test/authorize", login);
    expect(openOAuthLogin).toHaveBeenCalledWith("https://auth.example.test/authorize", login);
    expect(shellOpenExternal).not.toHaveBeenCalled();
  });
});
