import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fileSystem } from "node:fs";
import { McpManager } from "../mcp-manager.js";
import { McpGovernance } from "../mcp-governance.js";
import { ToolRegistry } from "../../tools/registry.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { userServerApproval, userServerFingerprint, userServerTrustSecretId } from "../user-server-trust.js";
import { bundledCredentialKey } from "../bundled-credential.js";
import type { McpServerConfig } from "../types.js";

const { connect, disconnect, constructed } = vi.hoisted(() => ({ connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined), constructed: [] as McpServerConfig[] }));
vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    connect = connect;
    disconnect = disconnect;
    constructor(config: McpServerConfig) { constructed.push(config); }
    getState() { return { id: "local-notes", status: "connected", registeredTools: [] }; }
  },
  scrubSecrets: (value: string) => value,
}));

let root: string;
let configPath: string;
let policyPath: string;
const stored = new Map<string, string>();
const secrets = { getSecret: vi.fn(async (key: string) => stored.get(key) ?? null),
  setSecret: vi.fn(async (key: string, value: string) => { stored.set(key, value); }),
  deleteSecret: vi.fn(async (key: string) => { stored.delete(key); }) };
const appendAudit = vi.fn(async (_entry: unknown) => undefined);
const config: McpServerConfig = { id: "local-notes", transport: "stdio", command: "notes-server", args: ["--profile", "team alpha"], env: { PROFILE: "team" } };
function manager() {
  return new McpManager(new McpGovernance(policyPath), new ToolRegistry(), unusedNetworkFetch, configPath,
    { append: appendAudit, log: vi.fn() } as never, undefined, undefined, secrets);
}

beforeEach(async () => {
  vi.clearAllMocks();
  secrets.setSecret.mockReset().mockImplementation(async (key, value) => { stored.set(key, value); });
  secrets.deleteSecret.mockReset().mockImplementation(async (key) => { stored.delete(key); });
  appendAudit.mockReset().mockResolvedValue(undefined);
  constructed.length = 0;
  stored.clear();
  root = await mkdtemp(join(tmpdir(), "ave-mcp-user-trust-"));
  configPath = join(root, "servers.json");
  policyPath = join(root, "policy.json");
});
afterEach(async () => rm(root, { recursive: true, force: true }));

function policy(allowUserApprovedServers: boolean, servers: unknown[] = []) {
  return { version: "1.0", defaultPolicy: "deny", servers,
    globalRules: { maxServersTotal: 10, blockedUrlPatterns: [], allowedUrlPatterns: [], policyRefreshIntervalMs: 1800000, allowUserApprovedServers } };
}

describe("user server launch trust", () => {
  it("saves a valid server without starting it and presents its exact launch identity", async () => {
    const owner = manager();
    await expect(owner.addConfig(config)).resolves.toEqual({ connected: false, requiresTrust: true });
    expect(connect).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ servers: [config] });
    expect(await owner.getManagementState()).toEqual({ policyPath, policyStatus: "absent", userServersAllowed: true, managedServerIds: [], hasApiKey: { [config.id]: false }, servers: {
      [config.id]: { fingerprint: userServerFingerprint(config), trusted: false, arguments: config.args,
        argumentCount: 2, environmentKeys: ["PROFILE"] } } });
    await expect(owner.startServer(config.id)).rejects.toThrow("mcp-trust-required");
  });

  it("starts after one exact trust decision and restores trust across host restarts", async () => {
    const owner = manager();
    await owner.addConfig(config);
    await expect(owner.startServer(config.id, userServerFingerprint(config))).resolves.toEqual({ connected: true });
    expect(connect).toHaveBeenCalledOnce();
    expect(stored.get(userServerTrustSecretId(config.id))).toBe(userServerFingerprint(config));
    const restarted = manager();
    await expect(restarted.startServer(config.id)).resolves.toEqual({ connected: true });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("requires a new trust decision after arguments change and refuses a stale review", async () => {
    const owner = manager();
    await owner.addConfig(config);
    await owner.startServer(config.id, userServerFingerprint(config));
    const changed = { ...config, args: ["--profile", "different"] };
    await writeFile(configPath, JSON.stringify({ servers: [changed] }));
    await expect(owner.startServer(config.id)).rejects.toThrow("mcp-trust-required");
    await expect(owner.startServer(config.id, userServerFingerprint(config))).rejects.toThrow("mcp-trust-stale");
    expect(connect).toHaveBeenCalledOnce();
  });

  it("lets an organization policy prohibit user trust and override an existing grant", async () => {
    const owner = manager();
    await owner.addConfig(config);
    await owner.startServer(config.id, userServerFingerprint(config));
    await writeFile(policyPath, JSON.stringify(policy(false)));
    const restricted = manager();
    await expect(restricted.startServer(config.id)).rejects.toThrow("runtime approval not admitted by policy");
    await expect(restricted.startServer(config.id, userServerFingerprint(config))).rejects.toThrow("mcp-policy-refused");
    expect(connect).toHaveBeenCalledOnce();
    expect((await restricted.getManagementState()).userServersAllowed).toBe(false);
  });

  it("never replaces an explicit managed revocation with user trust", async () => {
    await writeFile(policyPath, JSON.stringify(policy(true, [{ id: config.id, status: "revoked", transport: "stdio" }])));
    const owner = manager();
    await expect(owner.addConfig(config)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it("reconnects after a kill with the existing trust", async () => {
    const owner = manager();
    await owner.addConfig(config);
    await owner.startServer(config.id, userServerFingerprint(config));
    await owner.killSwitch(config.id);
    await expect(owner.startServer(config.id)).resolves.toEqual({ connected: true });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("undoes remove without exposing the configuration secrets to the renderer", async () => {
    const keyed: McpServerConfig = { ...config, auth: "api-key", apiKeyEnv: "NOTES_API_KEY", apiKey: "throwaway-secret" };
    const owner = manager();
    await owner.addConfig(keyed);
    await owner.startServer(config.id, userServerFingerprint(keyed));
    await owner.removeConfig(config.id);
    expect(await owner.getConfigs()).toEqual([]);
    await owner.undoRemove(config.id);
    expect((await owner.loadFromConfig())[0]).toEqual(keyed);
    expect(await readFile(configPath, "utf8")).not.toContain("throwaway-secret");
    await expect(owner.undoRemove(config.id)).rejects.toThrow("mcp-undo-unavailable");
    expect(connect).toHaveBeenCalledOnce();
  });

  it("redacts a bundled server credential from a user server launch preview", async () => {
    const owner = manager();
    const ref = { kind: "plugin" as const, name: "remote-kit" };
    owner.registerBundledCredentialSource("plugin", { list: () => [{ packageName: ref.name, serverName: "remote", transport: "http",
      url: "https://example.test/mcp", auth: "api-key", apiKeyHeader: "X-Key" }], reconnect: async () => undefined,
      installedPackages: async () => new Set([ref.name]) });
    stored.set(bundledCredentialKey(ref, "remote"), "throwaway-bundled-secret");
    await owner.addConfig({ ...config, args: ["--token=throwaway-bundled-secret"] });
    expect((await owner.getManagementState()).servers[config.id].arguments).toEqual(["[redacted]"]);
  });

  it("redacts a stored credential from arguments in the launch preview", async () => {
    const keyed: McpServerConfig = { ...config, auth: "api-key", apiKeyEnv: "NOTES_API_KEY", apiKey: "throwaway-secret",
      args: ["--token=throwaway-secret", "--encoded=throwaway%2Dsecret"] };
    const owner = manager();
    await owner.addConfig(keyed);
    expect((await owner.getManagementState()).servers[config.id].arguments).toEqual(["[redacted]", "[redacted]"]);
  });
});


describe("user server configuration transactions", () => {
  const keyed: McpServerConfig = { ...config, auth: "api-key", apiKeyEnv: "NOTES_API_KEY", apiKey: "throwaway-original-key" };
  const apiKeyId = "mcp.server.apiKey.local-notes";

  async function connectedOwner() {
    const owner = manager();
    await owner.addConfig(keyed);
    await owner.startServer(keyed.id, userServerFingerprint(keyed));
    return owner;
  }

  it.each(["before", "after"] as const)("rolls back a failed add %s replacement before the identifier can be reused", async (failure) => {
    const owner = manager();
    const writer = owner as unknown as { saveConfigs(configs: McpServerConfig[]): Promise<void> };
    const save = writer.saveConfigs.bind(owner);
    const rename = failure === "before" ? vi.spyOn(fileSystem, "rename").mockRejectedValueOnce(new Error("Configuration write refused"))
      : vi.spyOn(writer, "saveConfigs").mockImplementationOnce(async (configs) => {
        await save(configs); throw new Error("Configuration write refused");
      });
    try {
      await expect(owner.addConfig(keyed)).rejects.toThrow("Configuration write refused");
      expect(stored.has(apiKeyId)).toBe(false);
      expect(stored.has(userServerTrustSecretId(keyed.id))).toBe(false);
      await expect(readFile(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(constructed).toEqual([]);
    } finally { rename.mockRestore(); }
    const replacement: McpServerConfig = { id: keyed.id, transport: "http", url: "https://different.example.test/mcp" };
    await owner.addConfig(replacement);
    await owner.startServer(replacement.id, userServerFingerprint(replacement));
    expect(constructed.at(-1)).toMatchObject({ url: replacement.url });
    expect(constructed.at(-1)).not.toHaveProperty("apiKey");
  });

  it("restores the old key, trust, exact file and connected runtime after a failed key rotation save", async () => {
    const owner = await connectedOwner();
    const before = await readFile(configPath, "utf8");
    const trust = stored.get(userServerTrustSecretId(keyed.id));
    const rename = vi.spyOn(fileSystem, "rename").mockRejectedValueOnce(new Error("Configuration write refused"));
    try {
      await expect(owner.setApiKey(keyed.id, "throwaway-new-key")).rejects.toThrow("Configuration write refused");
      expect(await readFile(configPath, "utf8")).toBe(before);
      expect(stored.get(apiKeyId)).toBe(keyed.apiKey);
      expect(stored.get(userServerTrustSecretId(keyed.id))).toBe(trust);
      expect(disconnect).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledOnce();
      expect(owner.listServers()).toMatchObject([{ id: keyed.id, status: "connected" }]);
    } finally { rename.mockRestore(); }
  });

  it.each(["secret", "config"] as const)("restores key, trust, file and runtime after remove %s failure", async (failure) => {
    const owner = await connectedOwner();
    const before = await readFile(configPath, "utf8");
    const trust = stored.get(userServerTrustSecretId(keyed.id));
    const rename = failure === "config" ? vi.spyOn(fileSystem, "rename").mockRejectedValueOnce(new Error("Configuration write refused")) : undefined;
    if (failure === "secret") secrets.deleteSecret.mockImplementationOnce(async (key) => { stored.delete(key); throw new Error("Secret delete refused"); });
    try {
      await expect(owner.removeConfig(keyed.id)).rejects.toThrow(failure === "config" ? "Configuration write refused" : "Secret delete refused");
      expect(await readFile(configPath, "utf8")).toBe(before);
      expect(stored.get(apiKeyId)).toBe(keyed.apiKey);
      expect(stored.get(userServerTrustSecretId(keyed.id))).toBe(trust);
      expect(disconnect).not.toHaveBeenCalled();
      expect(owner.listServers()).toMatchObject([{ id: keyed.id, status: "connected" }]);
    } finally { rename?.mockRestore(); }
  });

  it.each(["secret", "config"] as const)("leaves a removed server removed after undo %s failure", async (failure) => {
    const owner = await connectedOwner();
    await owner.removeConfig(keyed.id);
    const before = await readFile(configPath, "utf8");
    const rename = failure === "config" ? vi.spyOn(fileSystem, "rename").mockRejectedValueOnce(new Error("Configuration write refused")) : undefined;
    if (failure === "secret") secrets.setSecret.mockImplementationOnce(async (key, value) => { stored.set(key, value); })
      .mockImplementationOnce(async () => { throw new Error("Trust write refused"); });
    try {
      await expect(owner.undoRemove(keyed.id)).rejects.toThrow(failure === "config" ? "Configuration write refused" : "Trust write refused");
      expect(await readFile(configPath, "utf8")).toBe(before);
      expect(stored.has(apiKeyId)).toBe(false);
      expect(stored.has(userServerTrustSecretId(keyed.id))).toBe(false);
      expect(owner.listServers()).toEqual([]);
      expect(connect).toHaveBeenCalledOnce();
    } finally { rename?.mockRestore(); }
  });

  it("restores exact file bytes when a replacement completed before its failure was reported", async () => {
    const owner = await connectedOwner();
    const before = `\n${JSON.stringify({ servers: [{ ...keyed, apiKey: undefined }] })}\n`;
    await writeFile(configPath, before);
    const trust = stored.get(userServerTrustSecretId(keyed.id));
    const writer = owner as unknown as { saveConfigs(configs: McpServerConfig[]): Promise<void> };
    const save = writer.saveConfigs.bind(owner);
    const spy = vi.spyOn(writer, "saveConfigs").mockImplementationOnce(async (configs) => {
      await save(configs);
      throw new Error("Configuration durability failed");
    });
    try {
      await expect(owner.removeConfig(keyed.id)).rejects.toThrow("Configuration durability failed");
      expect(await readFile(configPath, "utf8")).toBe(before);
      expect(stored.get(apiKeyId)).toBe(keyed.apiKey);
      expect(stored.get(userServerTrustSecretId(keyed.id))).toBe(trust);
      expect(disconnect).not.toHaveBeenCalled();
      expect(owner.listServers()).toMatchObject([{ id: keyed.id, status: "connected" }]);
    } finally { spy.mockRestore(); }
  });

  it("records durable user consent before storing trust and refuses an audit failure", async () => {
    const owner = manager();
    await owner.addConfig(config);
    appendAudit.mockRejectedValueOnce(new Error("Audit append refused"));
    await expect(owner.startServer(config.id, userServerFingerprint(config))).rejects.toThrow("Audit append refused");
    expect(stored.has(userServerTrustSecretId(config.id))).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    await owner.startServer(config.id, userServerFingerprint(config));
    expect(appendAudit).toHaveBeenLastCalledWith(expect.objectContaining({ type: "approval", input: expect.stringContaining("mcp_server_trust_requested") }));
    const auditOrder = appendAudit.mock.invocationCallOrder.at(-1);
    const secretOrder = secrets.setSecret.mock.invocationCallOrder.at(-1);
    if (auditOrder === undefined || secretOrder === undefined) throw new Error("Both audit and credential writes must execute");
    expect(auditOrder).toBeLessThan(secretOrder);
  });

  it("never restores an orphan key into a surviving replacement when file recovery fails, including after restart", async () => {
    const replacement: McpServerConfig = { id: config.id, transport: "http", url: "https://different.example.test/mcp", auth: "api-key" };
    const approval = { ...userServerApproval(replacement), userConfigFingerprint: undefined, provenance: undefined, requiredAuth: "none" };
    await writeFile(policyPath, JSON.stringify(policy(true, [approval])));
    stored.set(apiKeyId, "throwaway-orphan-key");
    await writeFile(configPath, JSON.stringify({ servers: [] }));
    const owner = manager();
    const writer = owner as unknown as { saveConfigs(configs: McpServerConfig[]): Promise<void> };
    const save = writer.saveConfigs.bind(owner);
    const saveSpy = vi.spyOn(writer, "saveConfigs").mockImplementationOnce(async (configs) => {
      await save(configs); throw new Error("Configuration durability failed");
    });
    const originalRename = fileSystem.rename.bind(fileSystem);
    const renameSpy = vi.spyOn(fileSystem, "rename").mockImplementationOnce(originalRename)
      .mockRejectedValueOnce(new Error("Configuration recovery refused"));
    try {
      await expect(owner.addConfig(replacement)).rejects.toThrow("mcp-config-recovery-required");
      expect(stored.has(apiKeyId)).toBe(false);
      expect(stored.has(userServerTrustSecretId(replacement.id))).toBe(false);
    } finally { saveSpy.mockRestore(); renameSpy.mockRestore(); }
    const restarted = manager();
    expect(await restarted.loadFromConfig()).toEqual([replacement]);
    await expect(restarted.startServer(replacement.id)).rejects.toThrow("mcp-api-key-required");
    expect(constructed).toEqual([]);
  });

  it("blocks further mutations and connections when compensation cannot restore a secret", async () => {
    const owner = await connectedOwner();
    const before = await readFile(configPath, "utf8");
    secrets.setSecret.mockRejectedValue(new Error("Secret storage unavailable"));
    await expect(owner.setApiKey(keyed.id, "throwaway-new-key")).rejects.toThrow("mcp-config-recovery-required");
    expect(await readFile(configPath, "utf8")).toBe(before);
    await expect(owner.addConfig({ id: "other", transport: "http", url: "https://different.example.test/mcp" })).rejects.toThrow("mcp-config-recovery-required");
    await expect(owner.connectServer(keyed)).rejects.toThrow("mcp-config-recovery-required");
    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });
});

describe("user server credential clearing", () => {
  const keyed: McpServerConfig = { ...config, auth: "api-key", apiKeyEnv: "NOTES_API_KEY", apiKey: "throwaway-reset-key" };
  it("exposes presence only, clears the key, stops the server and preserves reviewed launch trust", async () => {
    const owner = manager();
    await owner.addConfig(keyed);
    await owner.startServer(keyed.id, userServerFingerprint(keyed));
    const trust = stored.get(userServerTrustSecretId(keyed.id));
    const management = await owner.getManagementState();
    expect(management.hasApiKey[keyed.id]).toBe(true);
    expect(JSON.stringify(management)).not.toContain(keyed.apiKey);
    await owner.clearApiKey(keyed.id);
    expect(stored.has("mcp.server.apiKey.local-notes")).toBe(false);
    expect(stored.get(userServerTrustSecretId(keyed.id))).toBe(trust);
    expect((await owner.getManagementState()).hasApiKey[keyed.id]).toBe(false);
    expect(owner.listServers()).toEqual([]);
    expect(disconnect).toHaveBeenCalledOnce();
    await expect(owner.startServer(keyed.id)).rejects.toThrow("mcp-api-key-required");
    await expect(owner.setApiKey(keyed.id, "throwaway-replacement-key")).resolves.toEqual({ connected: true });
    expect(stored.get(userServerTrustSecretId(keyed.id))).toBe(trust);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("preserves the credential and running server if a clear transaction cannot save", async () => {
    const owner = manager();
    await owner.addConfig(keyed);
    await owner.startServer(keyed.id, userServerFingerprint(keyed));
    const before = await readFile(configPath, "utf8");
    const rename = vi.spyOn(fileSystem, "rename").mockRejectedValueOnce(new Error("Configuration write refused"));
    try {
      await expect(owner.clearApiKey(keyed.id)).rejects.toThrow("Configuration write refused");
      expect(await readFile(configPath, "utf8")).toBe(before);
      expect(stored.get("mcp.server.apiKey.local-notes")).toBe(keyed.apiKey);
      expect(disconnect).not.toHaveBeenCalled();
      expect(owner.listServers()).toMatchObject([{ id: keyed.id, status: "connected" }]);
    } finally { rename.mockRestore(); }
  });
});
