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
    handOff: ReturnType<typeof vi.fn>;
    credentialKey: string;
    options?: { after?: Promise<void>; initialStatus?: McpAuthStatus };
  }>,
  clients: [] as Array<{ disconnect: ReturnType<typeof vi.fn>; fetch: typeof fetch; state: { id: string; status: string; registeredTools: string[] } }>,
  login: async () => {},
  connect: async () => {},
}));

vi.mock("../mcp-oauth.js", async (importOriginal) => ({
  McpOAuthError: (await importOriginal<typeof import("../mcp-oauth.js")>()).McpOAuthError,
  tryMcpOAuthCredentialKey: (value: McpHttpServerConfig) => value.url.startsWith("https://")
    ? `mcp.oauth.${JSON.stringify([value.id, value.url, value.oauth])}` : undefined,
  McpOAuthSession: class {
    static clearStoredCredentials = harness.clearStoredCredentials;
    status: McpAuthStatus = "required";
    readonly credentialKey: string;
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
    handOff = vi.fn(async () => { this.status = "required"; });
    getStatus() { return this.status; }
    getBlockedCode() { return undefined; }
    constructor(value: McpHttpServerConfig, _dependencies: unknown, readonly options?: { after?: Promise<void>; initialStatus?: McpAuthStatus }) {
      this.credentialKey = `mcp.oauth.${JSON.stringify([value.id, value.url, value.oauth])}`;
      if (options?.initialStatus) this.status = options.initialStatus;
      harness.sessions.push(this);
    }
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
const secretStore = new Map<string, string>();
const secrets = {
  getSecret: vi.fn((key: string) => secretStore.get(key) ?? null),
  setSecret: vi.fn(async (key: string, value: string) => { secretStore.set(key, value); }),
  deleteSecret: vi.fn(async (key: string) => { secretStore.delete(key); }),
  canStoreEncrypted: vi.fn(() => true),
};
const keyOf = (value: McpHttpServerConfig) => `mcp.oauth.${JSON.stringify([value.id, value.url, value.oauth])}`;
const hostFetch = vi.fn(async () => new Response(null, { status: 200 }));

function manager(onDisconnected?: (serverId: string) => void) {
  return new McpManager(
    { validateServer } as unknown as McpGovernance,
    { unregisterByMcp } as unknown as ToolRegistry,
    hostFetch as typeof fetch, path, undefined, undefined, onDisconnected, secrets,
    { redirectCatchers: new AuthRedirectCatchers(), openAuthorizationUrl: async () => {}, secrets },
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  secretStore.clear();
  secrets.canStoreEncrypted.mockReturnValue(true);
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

  it("deletes the previous credential record only when the credential identity changes", async () => {
    const owner = manager();
    await owner.authenticate(config.id);
    const previous = harness.sessions[0];
    secretStore.set(keyOf(config), "grant");
    await owner.connectServer({ ...config, headers: { "x-team": "a" } }, { force: true }).catch(() => undefined);
    await vi.waitFor(() => expect(secretStore.get("mcp.oauth.index")).toBeDefined());
    expect(harness.sessions).toHaveLength(2);
    // Same-identity sessions hand off refresh persistence before the successor reads credentials.
    expect(previous.handOff).toHaveBeenCalledTimes(1);
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(harness.sessions[1].options?.after).toBeInstanceOf(Promise);
    expect(previous.clear).not.toHaveBeenCalled();
    expect(secretStore.get(keyOf(config))).toBe("grant");
    const moved = { ...config, url: "https://other.example.test/mcp" };
    await expect(owner.connectServer(moved, { force: true })).rejects.toThrow("MCP authentication required");
    await vi.waitFor(() => expect(secretStore.has(keyOf(config))).toBe(false));
    expect(harness.sessions[1].dispose).toHaveBeenCalled();
    expect(harness.sessions[1].handOff).not.toHaveBeenCalled();
    expect(harness.sessions[2].options?.after).toBeUndefined();
    expect(JSON.parse(secretStore.get("mcp.oauth.index")!)).toEqual({ [config.id]: keyOf(moved) });
  });

  it("finishes queued credential index writes before shutdown completes", async () => {
    let release!: () => void;
    vi.mocked(secrets.setSecret).mockImplementationOnce(async (key: string, value: string) => {
      await new Promise<void>((resolve) => { release = resolve; });
      secretStore.set(key, value);
    });
    const owner = manager();
    await owner.connectServer(config).catch(() => undefined);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    let finished = false;
    const shutdown = owner.disconnectAll().then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    release();
    await shutdown;
    expect(JSON.parse(secretStore.get("mcp.oauth.index")!)).toEqual({ [config.id]: keyOf(config) });
  });

  it.each([
    ["a trailing comma", '{ "servers": [] , }'],
    ["an empty file", ""],
    ["a non-object servers value", '{ "servers": 3 }'],
    ["no servers key", "{}"],
    ["another app's mcpServers map", '{ "mcpServers": {} }'],
    ["a misspelled servers key", '{ "server": [] }'],
    ["a top-level array", "[]"],
    ["a null document", "null"],
  ])("keeps every stored grant when the configuration file has %s", async (_label, content) => {
    const index = { [config.id]: keyOf(config), other: "mcp.oauth.other" };
    secretStore.set("mcp.oauth.index", JSON.stringify(index));
    secretStore.set(keyOf(config), "grant");
    secretStore.set("mcp.oauth.other", "other grant");
    await writeFile(path, content);
    const owner = manager();
    await owner.connectAll();
    await owner.disconnectAll();
    expect(secretStore.get(keyOf(config))).toBe("grant");
    expect(secretStore.get("mcp.oauth.other")).toBe("other grant");
    expect(JSON.parse(secretStore.get("mcp.oauth.index")!)).toEqual(index);
    expect(secrets.deleteSecret).not.toHaveBeenCalled();
  });

  it("deletes nothing when the configuration file is missing", async () => {
    // A missing installed-set file with existing index state cannot authorize credential deletion.
    secretStore.set("mcp.oauth.index", JSON.stringify({ [config.id]: keyOf(config) }));
    secretStore.set(keyOf(config), "grant");
    await rm(path);
    const owner = manager();
    await owner.connectAll();
    await owner.disconnectAll();
    expect(secretStore.get(keyOf(config))).toBe("grant");
    expect(secrets.deleteSecret).not.toHaveBeenCalled();
    await rm(directory, { recursive: true, force: true });
    const fresh = manager();
    await fresh.connectAll();
    await fresh.disconnectAll();
    expect(secrets.deleteSecret).not.toHaveBeenCalled();
  });

  it("reports a malformed index, deletes nothing on its account, and rebuilds it only after a successful load", async () => {
    secretStore.set("mcp.oauth.index", "{ not json");
    secretStore.set(keyOf(config), "grant");
    secretStore.set("mcp.oauth.orphan", "orphan grant");
    await writeFile(path, "{ broken");
    const owner = manager();
    await owner.connectAll();
    await expect(owner.connectServer(config)).rejects.toThrow();
    await vi.waitFor(() => expect(owner.getServerState(config.id)?.authError).toBe("mcp-auth-index-unreadable"));
    expect(owner.listServers().find((state) => state.id === config.id)?.authError).toBe("mcp-auth-index-unreadable");
    expect(secretStore.get("mcp.oauth.index")).toBe("{ not json");
    expect(secrets.deleteSecret).not.toHaveBeenCalled();
    await writeFile(path, JSON.stringify({ servers: [config] }));
    await owner.connectAll();
    await owner.disconnectAll();
    expect(JSON.parse(secretStore.get("mcp.oauth.index")!)).toEqual({ [config.id]: keyOf(config) });
    expect(secretStore.get(keyOf(config))).toBe("grant");
    expect(secretStore.get("mcp.oauth.orphan")).toBe("orphan grant");
    expect(secrets.deleteSecret).not.toHaveBeenCalled();
    const restarted = manager();
    await restarted.connectServer(config).catch(() => undefined);
    expect(restarted.getServerState(config.id)?.authError).toBeUndefined();
  });

  it("defers bundled pruning while a package transaction is open, re-checking when the work runs", async () => {
    const stableId = `bundled:${JSON.stringify(["plugin", "updating-kit", "remote"])}`;
    secretStore.set("mcp.oauth.index", JSON.stringify({ [stableId]: "mcp.oauth.updating" }));
    secretStore.set("mcp.oauth.updating", "grant");
    let idle = false;
    const owner = manager();
    owner.setPackageTransactionProbe(() => idle);
    // Reconcile only with a stable installed set outside package transactions.
    const source = { installedPackages: async () => new Set<string>(), list: () => [], reconnect: async () => {} };
    owner.registerBundledCredentialSource("plugin", source);
    await owner.disconnectAll();
    expect(secretStore.get("mcp.oauth.updating")).toBe("grant");
    let reads = 0;
    owner.setPackageTransactionProbe(() => reads === 0);
    owner.registerBundledCredentialSource("plugin", { ...source, installedPackages: async () => { reads += 1; return new Set<string>(); } });
    await owner.disconnectAll();
    expect(reads).toBe(1);
    expect(secretStore.get("mcp.oauth.updating")).toBe("grant");
    expect(secrets.deleteSecret).not.toHaveBeenCalled();
    idle = true;
    owner.setPackageTransactionProbe(() => idle);
    owner.registerBundledCredentialSource("plugin", source);
    await owner.disconnectAll();
    expect(secretStore.has("mcp.oauth.updating")).toBe(false);
  });

  it("retires bundled grants only of packages gone from the installed set, or of servers a listed package dropped", async () => {
    const stableId = (name: string, server = "remote") => `bundled:${JSON.stringify(["plugin", name, server])}`;
    const index = { [stableId("active-kit")]: "mcp.oauth.active", [stableId("active-kit", "dropped")]: "mcp.oauth.dropped",
      [stableId("disabled-kit")]: "mcp.oauth.disabled", [stableId("removed-kit")]: "mcp.oauth.removed",
      [`bundled:${JSON.stringify(["agent-plugin", "other-kind", "remote"])}`]: "mcp.oauth.agent-kind", [config.id]: keyOf(config) };
    secretStore.set("mcp.oauth.index", JSON.stringify(index));
    for (const key of Object.values(index)) secretStore.set(key, "grant");
    const declaration = (name: string) => ({ packageName: name, serverName: "remote", transport: "http" as const,
      url: "https://example.test/mcp", auth: "oauth" as const });
    const owner = manager();
    // Unreadable or unverifiable installed inventories must delete no grants.
    owner.registerBundledCredentialSource("plugin", { installedPackages: async () => undefined, list: () => [declaration("active-kit")], reconnect: async () => {} });
    owner.registerBundledCredentialSource("plugin", { installedPackages: async () => { throw new Error("registry unreadable"); }, list: () => [], reconnect: async () => {} });
    owner.registerBundledCredentialSource("plugin", { installedPackages: async () => new Set(["active-kit", "disabled-kit"]), list: () => { throw new Error("unavailable"); }, reconnect: async () => {} });
    await owner.disconnectAll();
    expect(secrets.deleteSecret).not.toHaveBeenCalled();
    owner.registerBundledCredentialSource("plugin", { installedPackages: async () => new Set(["active-kit", "disabled-kit"]),
      list: () => [declaration("active-kit")], reconnect: async () => {} });
    await owner.disconnectAll();
    expect(secretStore.has("mcp.oauth.removed")).toBe(false);
    expect(secretStore.has("mcp.oauth.dropped")).toBe(false);
    expect(secretStore.get("mcp.oauth.active")).toBe("grant");
    expect(secretStore.get("mcp.oauth.disabled")).toBe("grant");
    expect(secretStore.get("mcp.oauth.agent-kind")).toBe("grant");
    expect(secretStore.get(keyOf(config))).toBe("grant");
    const { [stableId("removed-kit")]: _removed, [stableId("active-kit", "dropped")]: _dropped, ...remaining } = index;
    expect(JSON.parse(secretStore.get("mcp.oauth.index")!)).toEqual(remaining);
  });

  it("deletes records left under keys the configuration no longer names when it loads", async () => {
    secretStore.set("mcp.oauth.index", JSON.stringify({ [config.id]: "mcp.oauth.edited-offline", gone: "mcp.oauth.removed-offline" }));
    secretStore.set("mcp.oauth.edited-offline", "old grant");
    secretStore.set("mcp.oauth.removed-offline", "old grant");
    secretStore.set(keyOf(config), "current grant");
    const owner = manager();
    await owner.connectAll();
    expect(secretStore.has("mcp.oauth.edited-offline")).toBe(false);
    expect(secretStore.has("mcp.oauth.removed-offline")).toBe(false);
    expect(secretStore.get(keyOf(config))).toBe("current grant");
    expect(JSON.parse(secretStore.get("mcp.oauth.index")!)).toEqual({ [config.id]: keyOf(config) });
  });

  it("shares one session between concurrent connections and authentication for the same server", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    harness.connect = () => gate;
    const owner = manager();
    const connections = [owner.connectServer(config, { force: true }), owner.connectServer(config, { force: true })];
    const authentication = owner.authenticate(config.id);
    await vi.waitFor(() => expect(harness.clients.length).toBeGreaterThan(0));
    finish();
    await Promise.allSettled(connections);
    await authentication;
    expect(harness.sessions).toHaveLength(1);
  });

  it("removes a configuration that can never hold credentials without failing after the file is rewritten", async () => {
    const insecure = { id: "insecure", transport: "http" as const, url: "http://intranet.example.test/mcp", auth: "oauth" as const };
    await writeFile(path, JSON.stringify({ servers: [config, insecure] }));
    const owner = manager();
    await expect(owner.removeConfig(insecure.id)).resolves.toBeUndefined();
    expect(await owner.getConfigs()).toEqual([config]);
    expect(secrets.deleteSecret).not.toHaveBeenCalledWith(expect.stringContaining("insecure"));
  });

  it("keeps tools and a connected state while a server asks for step-up", async () => {
    const owner = manager();
    await owner.authenticate(config.id);
    harness.sessions[0].status = "insufficient_scope";
    expect(owner.getServerState(config.id)).toMatchObject({ status: "connected", authStatus: "insufficient_scope", registeredTools: ["mcp_team_read"] });
  });

  it.each(["mcp-auth-storage-unavailable", "mcp-auth-storage-unreadable", "mcp-auth-registration-unsupported"] as const)(
    "reports %s distinctly", async (code) => {
      const { McpOAuthError } = await vi.importActual<typeof import("../mcp-oauth.js")>("../mcp-oauth.js");
      harness.login = async () => { throw new McpOAuthError(code); };
      expect(await manager().authenticate(config.id)).toEqual({ connected: false, errorCode: code });
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
    secretStore.set(keyOf(config), "grant");
    const owner = manager();
    await owner.removeConfig(config.id);
    expect(harness.sessions).toHaveLength(0);
    expect(secretStore.has(keyOf(config))).toBe(false);
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
