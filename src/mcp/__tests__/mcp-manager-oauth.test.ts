import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpAuthStatus, McpHttpServerConfig, McpServerConfig } from "../types.js";

const harness = vi.hoisted(() => ({
  clearStoredCredentials: vi.fn(async () => {}),
  sessions: [] as Array<{
    status: McpAuthStatus;
    authenticate: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
  }>,
  clients: [] as Array<{ disconnect: ReturnType<typeof vi.fn>; fetch: typeof fetch; state: { id: string; status: string; registeredTools: string[] } }>,
  login: async () => {},
  connect: async () => {},
}));

vi.mock("../mcp-oauth.js", () => ({
  McpOAuthSession: class {
    static clearStoredCredentials = harness.clearStoredCredentials;
    status: McpAuthStatus = "required";
    authenticate = vi.fn(async () => {
      this.status = "authenticating";
      try {
        await harness.login();
        this.status = "authenticated";
      } catch (error) {
        this.status = "error";
        throw error;
      }
    });
    dispose = vi.fn(() => { this.status = "required"; });
    clear = vi.fn(async () => {});
    fetch = vi.fn(async () => {
      this.status = "required";
      throw new Error("MCP authentication required");
    });
    getStatus() { return this.status; }
    constructor() { harness.sessions.push(this); }
  },
}));

vi.mock("../mcp-client.js", () => ({
  scrubSecrets: (value: string) => value,
  McpClient: class {
    state: { id: string; status: string; registeredTools: string[] };
    disconnect = vi.fn(async () => { this.state.status = "disconnected"; this.state.registeredTools = []; });
    constructor(config: McpServerConfig, _governance: unknown, _registry: unknown, readonly fetch: typeof globalThis.fetch) {
      this.state = { id: config.id, status: "disconnected", registeredTools: [] };
      harness.clients.push(this);
    }
    async connect() { await harness.connect(); this.state.status = "connected"; this.state.registeredTools = ["mcp_team_read"]; }
    getState() { return this.state; }
  },
}));

import { McpManager } from "../mcp-manager.js";
import type { McpGovernance } from "../mcp-governance.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { AuthRedirectCatchers } from "../../main/auth-redirect-catcher.js";

let directory: string;
let path: string;
const config: McpHttpServerConfig = { id: "team", transport: "http", url: "https://mcp.example.test/mcp", auth: "oauth" };
const validateServer = vi.fn(() => ({ valid: true }));
const unregisterByMcp = vi.fn();
const secrets = { getSecret: vi.fn(() => null), setSecret: vi.fn(async () => {}), deleteSecret: vi.fn(async () => {}) };
const hostFetch = vi.fn(async () => new Response(null, { status: 200 }));

function manager(onDisconnected?: (serverId: string) => void) {
  return new McpManager(
    { validateServer } as unknown as McpGovernance,
    { unregisterByMcp } as unknown as ToolRegistry,
    hostFetch as typeof fetch, path, undefined, undefined, undefined, onDisconnected, secrets,
    { redirectCatchers: new AuthRedirectCatchers(), openAuthorizationUrl: async () => {} },
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  validateServer.mockReturnValue({ valid: true });
  harness.sessions.length = 0;
  harness.clients.length = 0;
  harness.login = async () => {};
  harness.connect = async () => {};
  directory = await mkdtemp(join(tmpdir(), "ave-mcp-oauth-manager-"));
  path = join(directory, "servers.json");
  await writeFile(path, JSON.stringify({ servers: [config] }));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("remote authorization lifecycle", () => {
  it("refuses absent, local, or policy-denied servers before authentication", async () => {
    const owner = manager();
    expect(await owner.authenticate("missing")).toEqual({ connected: false, errorCode: "mcp-auth-failed" });
    await writeFile(path, JSON.stringify({ servers: [{ id: "local", transport: "stdio", command: "node", auth: "oauth" }] }));
    expect((await owner.authenticate("local")).connected).toBe(false);
    await writeFile(path, JSON.stringify({ servers: [config] }));
    validateServer.mockReturnValue({ valid: false });
    expect((await owner.authenticate(config.id)).connected).toBe(false);
    expect(harness.sessions).toHaveLength(0);
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("coalesces login and reconnects through the normal client without exposing credentials", async () => {
    let finish!: () => void;
    harness.login = () => new Promise<void>((resolve) => { finish = resolve; });
    const owner = manager();
    const first = owner.authenticate(config.id);
    expect(owner.authenticate(config.id)).toBe(first);
    await vi.waitFor(() => expect(harness.sessions).toHaveLength(1));
    expect(owner.listServers()).toMatchObject([{ id: config.id, authStatus: "authenticating" }]);
    finish();
    expect(await first).toEqual({ connected: true });
    expect(harness.sessions[0].authenticate).toHaveBeenCalledTimes(1);
    expect(owner.listServers()).toMatchObject([{ status: "connected", authStatus: "authenticated" }]);
    expect(await owner.getConfigs()).toEqual([config]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ servers: [config] });
  });

  it("prevents a removed server from reconnecting after a delayed browser grant", async () => {
    let finish!: () => void;
    harness.login = () => new Promise<void>((resolve) => { finish = resolve; });
    const owner = manager();
    const authentication = owner.authenticate(config.id);
    await vi.waitFor(() => expect(harness.sessions).toHaveLength(1));
    await owner.removeConfig(config.id);
    finish();
    expect((await authentication).connected).toBe(false);
    expect(harness.sessions[0].dispose).toHaveBeenCalled();
    expect(harness.sessions[0].clear).toHaveBeenCalledTimes(1);
    expect(harness.clearStoredCredentials).not.toHaveBeenCalled();
    expect(harness.clients).toHaveLength(0);
    expect(owner.listServers()).toEqual([]);
  });

  it("refuses to reconnect a changed endpoint after a pending grant", async () => {
    let finish!: () => void;
    harness.login = () => new Promise<void>((resolve) => { finish = resolve; });
    const owner = manager();
    const authentication = owner.authenticate(config.id);
    await vi.waitFor(() => expect(harness.sessions).toHaveLength(1));
    await writeFile(path, JSON.stringify({ servers: [{ ...config, url: "https://other.example.test/mcp" }] }));
    finish();
    expect((await authentication).connected).toBe(false);
    expect(harness.clients).toHaveLength(0);
    expect(harness.sessions[0].dispose).toHaveBeenCalled();
  });

  it.each(["remove", "kill", "shutdown"])("does not publish a late authenticated connection after %s", async (retirement) => {
    let finish!: () => void;
    harness.connect = () => new Promise<void>((resolve) => { finish = resolve; });
    const owner = manager();
    const authentication = owner.authenticate(config.id);
    await vi.waitFor(() => expect(harness.clients).toHaveLength(1));
    const retired = retirement === "remove" ? owner.removeConfig(config.id)
      : retirement === "kill" ? owner.killSwitch(config.id) : owner.disconnectAll();
    finish();
    expect((await authentication).connected).toBe(false);
    await retired;
    expect(owner.listServers()).toEqual([]);
    expect(harness.clients[0].disconnect).toHaveBeenCalled();
    expect(unregisterByMcp).toHaveBeenCalledWith(config.id);
  });

  it("keeps an unrelated server's kill switch responsive during authentication reconnect", async () => {
    const owner = manager();
    await owner.connectServer({ id: "public", transport: "http", url: "https://public.example.test/mcp" });
    let finish!: () => void;
    harness.connect = () => new Promise<void>((resolve) => { finish = resolve; });
    const authentication = owner.authenticate(config.id);
    await vi.waitFor(() => expect(harness.clients).toHaveLength(2));
    await owner.killSwitch("public");
    expect(harness.clients[0].disconnect).toHaveBeenCalledTimes(1);
    finish();
    expect(await authentication).toEqual({ connected: true });
  });

  it("deletes the previous configuration's credential record before creating a replacement", async () => {
    const owner = manager();
    await owner.authenticate(config.id);
    const previous = harness.sessions[0];
    await expect(owner.connectServer({ ...config, url: "https://other.example.test/mcp" }, { force: true })).rejects.toThrow("MCP authentication required");
    expect(previous.clear).toHaveBeenCalledTimes(1);
    expect(harness.sessions).toHaveLength(2);
  });

  it.each(["kill", "shutdown"])("does not restore a session when %s completes during credential replacement", async (retirement) => {
    const owner = manager();
    await owner.authenticate(config.id);
    let finish!: () => void;
    harness.sessions[0].clear.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const replacement = owner.connectServer({ ...config, url: "https://other.example.test/mcp" }, { force: true });
    await vi.waitFor(() => expect(harness.sessions[0].clear).toHaveBeenCalledTimes(1));
    await (retirement === "kill" ? owner.killSwitch(config.id) : owner.disconnectAll());
    finish();
    await expect(replacement).rejects.toThrow("MCP connection retired");
    expect(harness.sessions).toHaveLength(1);
    expect(owner.listServers()).toEqual([]);
  });

  it("withholds tools until an explicitly authorized server has a grant", async () => {
    const owner = manager();
    await expect(owner.connectServer(config)).rejects.toThrow("MCP authentication required");
    expect(unregisterByMcp).toHaveBeenCalledWith(config.id);
    expect(owner.listServers()).toEqual([{ id: config.id, status: "disconnected", authStatus: "required", registeredTools: [] }]);
  });

  it("reports a saved OAuth enrollment as a typed required action without a raw warning", async () => {
    await writeFile(path, JSON.stringify({ servers: [] }));
    const owner = manager();
    expect(await owner.addConfig(config)).toEqual({ connected: false, errorCode: "mcp-auth-required" });
    expect(await owner.getConfigs()).toEqual([config]);
  });

  it("retires stale tools and surfaces required status when a live credential is revoked", async () => {
    const owner = manager();
    expect(await owner.authenticate(config.id)).toEqual({ connected: true });
    await expect(harness.clients[0].fetch(config.url)).rejects.toThrow("MCP authentication required");
    expect(unregisterByMcp).toHaveBeenCalledWith(config.id);
    expect(harness.clients[0].disconnect).toHaveBeenCalledTimes(1);
    expect(owner.getServerState(config.id)).toEqual({ id: config.id, status: "disconnected", authStatus: "required", registeredTools: [] });
  });

  it("clears stored credentials even when removing a server before its first connection", async () => {
    const owner = manager();
    await owner.removeConfig(config.id);
    expect(harness.sessions).toHaveLength(0);
    expect(harness.clearStoredCredentials).toHaveBeenCalledWith(config, secrets);
    expect(await owner.getConfigs()).toEqual([]);
  });

  it("returns stable errors when upstream authentication fails with secret-bearing text", async () => {
    harness.login = async () => { throw new Error("throwaway-access-secret"); };
    const owner = manager();
    const result = await owner.authenticate(config.id);
    expect(result).toEqual({ connected: false, errorCode: "mcp-auth-failed" });
    expect(JSON.stringify(result)).not.toContain("throwaway-access-secret");
  });

  it("withdraws a previous client's tools after an interactive authentication failure", async () => {
    const onDisconnected = vi.fn();
    const owner = manager(onDisconnected);
    await owner.authenticate(config.id);
    harness.login = async () => { throw new Error("Sign-in rejected"); };
    expect(await owner.authenticate(config.id)).toEqual({ connected: false, errorCode: "mcp-auth-failed" });
    expect(unregisterByMcp).toHaveBeenCalledWith(config.id);
    expect(harness.clients[0].disconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith(config.id);
    expect(owner.getServerState(config.id)).toEqual({ id: config.id, status: "disconnected", authStatus: "error", registeredTools: [] });
  });
});
