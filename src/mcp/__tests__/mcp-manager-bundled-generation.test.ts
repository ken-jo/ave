import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";

const disconnect = vi.fn(async () => undefined);
const constructedConfigs: Array<Record<string, unknown>> = [];
const constructedFetches: unknown[] = [];
let discoveryReadOnlyHint = false;
const oauth = vi.hoisted(() => ({ sessions: [] as Array<{ config: { id: string }; credentialKey: string; status: string; fetch: unknown; authenticate: () => Promise<void> }> }));
vi.mock("../mcp-oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp-oauth.js")>();
  return {
  ...actual,
  McpOAuthSession: class {
    status = "required";
    readonly credentialKey: string;
    readonly fetch = vi.fn();
    constructor(readonly config: { id: string; url: string },
      dependencies: { secrets: { getSecret(key: string): string | null } }, options: { after?: Promise<void> } = {}) {
      this.credentialKey = actual.tryMcpOAuthCredentialKey(config as Parameters<typeof actual.tryMcpOAuthCredentialKey>[0])!;
      const loadStored = () => { if (dependencies.secrets.getSecret(this.credentialKey) === "grant") this.status = "authenticated"; };
      if (options.after) void options.after.then(loadStored);
      else loadStored();
      oauth.sessions.push(this);
    }
    authenticate = vi.fn(async () => { this.status = "authenticated"; });
    getStatus() { return this.status; }
    getBlockedCode() { return undefined; }
    dispose() { this.status = "required"; }
  },
  };
});
vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    constructor(
      private readonly config: { id: string },
      _governance: unknown,
      private readonly registry: ToolRegistry,
      networkFetch: unknown,
    ) { constructedConfigs.push(config); constructedFetches.push(networkFetch); }
    async connect() {
      this.registry.register(createDynamicTool({
        name: "mcp_sampleportal_portal_read",
        description: "read",
        source: "mcp",
        category: "network",
        mcpReadOnlyHint: discoveryReadOnlyHint,
        mcpServerId: this.config.id,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: this.config.id, isError: false }),
      }));
    }
    disconnect = disconnect;
    getState() {
      return { id: this.config.id, status: "connected" as const, registeredTools: ["mcp_sampleportal_portal_read"] };
    }
    async readResource(uri: string) { return { uri, html: "ok" }; }
    async callTool() { return { text: "ok" }; }
  },
  scrubSecrets: (value: string) => value,
}));

import { McpManager } from "../mcp-manager.js";
import { McpGovernance } from "../mcp-governance.js";
import { PluginMcpTrustStore, prepareBundledMcpProjection, preparePluginMcpGeneration as prepareWithDigests } from "../plugin-mcp-projection.js";

function preparePluginMcpGeneration(generation: ActivePluginGeneration, root: string) {
  return prepareWithDigests(generation, root, new Map(generation.contributions.map((contribution) => [contribution.localId, "d".repeat(64)])));
}
import { SecretDocumentStore } from "../../data/secret-document-store.js";
import { bundledConfigId, bundledCredentialDeclaration, bundledCredentialKey, readBoundBundledCredential } from "../bundled-credential.js";
import { AuthRedirectCatchers } from "../../main/auth-redirect-catcher.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { vouchedInstalledPluginIds } from "../../plugins/registry.js";

const root = mkdtempSync(join(tmpdir(), "ave-mcp-generation-"));

function generation(generationId: string): ActivePluginGeneration {
  return {
    pluginId: "sampleportal",
    pluginVersion: "1.0.0",
    artifactGenerationId: "a".repeat(64),
    generationId,
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [{
      ownerPluginId: "sampleportal",
      ownerVersion: "1.0.0",
      kind: "mcpServer",
      localId: "portal",
      path: "mcp/portal.json",
      fingerprint: "a".repeat(64),
      files: [{
        path: "mcp/portal.json",
        sha256: "a".repeat(64),
        content: JSON.stringify({ transport: "http", url: "https://portal.example.test/mcp" }),
      }],
    }],
  };
}

afterAll(async () => rm(root, { recursive: true, force: true }));
beforeEach(() => {
  disconnect.mockReset();
  disconnect.mockResolvedValue(undefined);
  constructedConfigs.length = 0;
  constructedFetches.length = 0;
  discoveryReadOnlyHint = false;
  oauth.sessions.length = 0;
});

describe("McpManager bundled generation", () => {
  it("withholds an app plugin's OAuth server until the Authenticate action, then connects it through its session", async () => {
    const stored = new Map<string, string>();
    const secrets = { getSecret: (key: string) => stored.get(key) ?? null, setSecret: async (key: string, value: string) => { stored.set(key, value); },
      deleteSecret: async (key: string) => { stored.delete(key); }, canStoreEncrypted: () => true };
    const manager = new McpManager(new McpGovernance(join(root, "policy-oauth.json")), new ToolRegistry(), unusedNetworkFetch,
      join(root, "servers-oauth.json"), undefined, undefined, undefined, secrets,
      { secrets, redirectCatchers: new AuthRedirectCatchers(), openAuthorizationUrl: async () => {} });
    const projection = prepareBundledMcpProjection({ pluginId: "remote-kit", pluginVersion: "1.0.0",
      generationId: "a".repeat(64), activationId: "run-oauth", localId: "remote", fingerprint: "b".repeat(64) },
    { transport: "http", url: "https://example.test/mcp", auth: "oauth", oauth: {} }, "d".repeat(64));
    const trust = new PluginMcpTrustStore();
    trust.approve(projection);
    const owner = { pluginId: "remote-kit", generationId: "run-oauth" };
    const prepared = await manager.prepareBundledGeneration(owner, [projection], trust);
    expect(prepared.degraded).toMatchObject([{ code: "credential_required", retryable: true }]);
    expect(prepared.records).toHaveLength(0);
    expect(constructedConfigs).toHaveLength(0);
    await manager.discardBundledGeneration(prepared);
    const stableId = bundledConfigId({ kind: "plugin", name: "remote-kit" }, "remote");
    expect(oauth.sessions).toHaveLength(1);
    expect(oauth.sessions[0].config.id).toBe(stableId);
    await vi.waitFor(() => expect(JSON.parse(stored.get("mcp.oauth.index") ?? "{}")).toEqual({ [stableId]: oauth.sessions[0]!.credentialKey }));
    expect(manager.listServers()).toEqual([{ id: stableId, status: "disconnected", authStatus: "required", registeredTools: [] }]);
    manager.registerBundledCredentialSource("plugin", { installedPackages: async () => new Set(["remote-kit"]),
      list: () => [{ packageName: "remote-kit", serverName: "remote", transport: "http", url: "https://example.test/mcp", auth: "oauth", oauth: {} }],
      reconnect: async () => {
        manager.publishBundledGeneration(await manager.prepareBundledGeneration(owner, [projection], trust));
      },
    });
    expect((await manager.getConfigs()).find((row) => row.id === stableId)).toMatchObject({ auth: "oauth", bundled: { name: "remote-kit" } });
    expect(await manager.authenticate(stableId)).toEqual({ connected: true });
    expect(oauth.sessions).toHaveLength(1);
    expect(constructedFetches).toEqual([oauth.sessions[0].fetch]);
    expect(manager.listServers()).toMatchObject([{ id: projection.serverId, status: "connected", authStatus: "authenticated" }]);
    expect(await manager.authenticate(projection.serverId)).toEqual({ connected: true });
    expect(oauth.sessions).toHaveLength(1);
  });

  it("indexes a declared bundled grant, under its session's key, when its source can vouch after an index rebuild", async () => {
    const stableId = bundledConfigId({ kind: "plugin", name: "rebuild-kit" }, "remote");
    const stored = new Map<string, string>([["mcp.oauth.index", "{ not json"]]);
    const deleted: string[] = [];
    const secrets = { getSecret: (key: string) => stored.get(key) ?? null, setSecret: async (key: string, value: string) => { stored.set(key, value); },
      deleteSecret: async (key: string) => { deleted.push(key); stored.delete(key); }, canStoreEncrypted: () => true };
    const configPath = join(root, "servers-rebuild.json");
    writeFileSync(configPath, JSON.stringify({ servers: [] }));
    const manager = new McpManager(new McpGovernance(join(root, "policy-rebuild.json")), new ToolRegistry(), unusedNetworkFetch,
      configPath, undefined, undefined, undefined, secrets,
      { secrets, redirectCatchers: new AuthRedirectCatchers(), openAuthorizationUrl: async () => {} });
    const declaration = { packageName: "rebuild-kit", serverName: "remote", transport: "http" as const, url: "https://example.test/mcp",
      auth: "oauth" as const, oauth: {} };
    let installed: ReadonlySet<string> | undefined;
    manager.registerBundledCredentialSource("plugin", { installedPackages: async () => installed, list: () => [declaration], reconnect: async () => {} });
    // Do not reconcile grants until the source can vouch for the installed package set.
    await manager.connectAll();
    await manager.disconnectAll();
    expect(JSON.parse(stored.get("mcp.oauth.index")!)).toEqual({});
    installed = new Set(["rebuild-kit"]);
    manager.registerBundledCredentialSource("plugin", { installedPackages: async () => installed, list: () => [declaration], reconnect: async () => {} });
    await manager.disconnectAll();
    const derived = JSON.parse(stored.get("mcp.oauth.index")!)[stableId] as string;
    expect(derived).toMatch(/^mcp\.oauth\./u);
    stored.set(derived, "grant");
    const projection = prepareBundledMcpProjection({ pluginId: "rebuild-kit", pluginVersion: "1.0.0",
      generationId: "a".repeat(64), activationId: "run-rebuild", localId: "remote", fingerprint: "b".repeat(64) },
    { transport: "http", url: "https://example.test/mcp", auth: "oauth", oauth: {} }, "d".repeat(64));
    const trust = new PluginMcpTrustStore();
    trust.approve(projection);
    await manager.discardBundledGeneration(await manager.prepareBundledGeneration({ pluginId: "rebuild-kit", generationId: "run-rebuild" }, [projection], trust));
    expect(oauth.sessions.at(-1)!.credentialKey).toBe(derived);
    await manager.disconnectAll();
    expect(stored.get(derived)).toBe("grant");
    expect(deleted).toEqual([]);
    manager.registerBundledCredentialSource("plugin", { installedPackages: async () => new Set(), list: () => [], reconnect: async () => {} });
    await manager.disconnectAll();
    expect(stored.has(derived)).toBe(false);
  });

  it("prunes app-plugin sign-ins only on the word of a plugin registry that can vouch for the installed set", async () => {
    const registryPath = join(mkdtempSync(join(root, "registry-")), "registry.json");
    const removedId = bundledConfigId({ kind: "plugin", name: "removed-kit" }, "remote");
    const disabledId = bundledConfigId({ kind: "plugin", name: "disabled-kit" }, "remote");
    const stored = new Map<string, string>([
      ["mcp.oauth.index", JSON.stringify({ [removedId]: "mcp.oauth.removed", [disabledId]: "mcp.oauth.disabled" })],
      ["mcp.oauth.removed", "grant"], ["mcp.oauth.disabled", "grant"],
    ]);
    const secrets = { getSecret: (key: string) => stored.get(key) ?? null, setSecret: async (key: string, value: string) => { stored.set(key, value); },
      deleteSecret: async (key: string) => { stored.delete(key); }, canStoreEncrypted: () => true };
    const manager = new McpManager(new McpGovernance(join(root, "policy-registry.json")), new ToolRegistry(), unusedNetworkFetch,
      join(root, "servers-registry.json"), undefined, undefined, undefined, secrets,
      { secrets, redirectCatchers: new AuthRedirectCatchers(), openAuthorizationUrl: async () => {} });
    manager.registerBundledCredentialSource("plugin", { installedPackages: () => vouchedInstalledPluginIds(registryPath),
      list: () => [], reconnect: async () => {} });
    const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, manifestPath: `plugins/${id}/plugin.json`, ...extra });
    const grants = () => [removedId, disabledId].filter((id) => JSON.parse(stored.get("mcp.oauth.index")!)[id] !== undefined);

    // A missing registry is not proof that no packages are installed.
    await manager.reconcileBundledCredentials("plugin");
    expect(grants()).toEqual([removedId, disabledId]);
    writeFileSync(registryPath, JSON.stringify({ version: 1, plugins: [entry("disabled-kit", { enabled: false }),
      entry("other-kit", { pendingUpdate: { kind: "marketplace", previousManifestFileSha256: null, previousReceiptRaw: null } })] }));
    await manager.reconcileBundledCredentials("plugin");
    expect(grants()).toEqual([removedId, disabledId]);
    // Disabled installs retain sign-in; removed packages lose it.
    writeFileSync(registryPath, JSON.stringify({ version: 1, plugins: [entry("disabled-kit", { enabled: false }), entry("other-kit")] }));
    await manager.reconcileBundledCredentials("plugin");
    expect(grants()).toEqual([disabledId]);
    expect(stored.has("mcp.oauth.removed")).toBe(false);
    expect(stored.get("mcp.oauth.disabled")).toBe("grant");
  });

  it("asks a reinstalled app plugin to authenticate again once its uninstall retired the sign-in", async () => {
    const stored = new Map<string, string>();
    const secrets = { getSecret: (key: string) => stored.get(key) ?? null, setSecret: async (key: string, value: string) => { stored.set(key, value); },
      deleteSecret: async (key: string) => { stored.delete(key); }, canStoreEncrypted: () => true };
    const manager = new McpManager(new McpGovernance(join(root, "policy-reinstall.json")), new ToolRegistry(), unusedNetworkFetch,
      join(root, "servers-reinstall.json"), undefined, undefined, undefined, secrets,
      { secrets, redirectCatchers: new AuthRedirectCatchers(), openAuthorizationUrl: async () => {} });
    let idle = true;
    manager.setPackageTransactionProbe(() => idle);
    const projectionFor = (activationId: string) => prepareBundledMcpProjection({ pluginId: "remote-kit", pluginVersion: "1.0.0",
      generationId: "a".repeat(64), activationId, localId: "remote", fingerprint: "b".repeat(64) },
    { transport: "http", url: "https://example.test/mcp", auth: "oauth", oauth: {} }, "d".repeat(64));
    const trust = new PluginMcpTrustStore();
    let installed = new Set(["remote-kit"]);
    let active: { activationId: string; projection: ReturnType<typeof projectionFor> } | null = { activationId: "run-first", projection: projectionFor("run-first") };
    trust.approve(active.projection);
    manager.registerBundledCredentialSource("plugin", {
      installedPackages: async () => installed,
      list: () => (active ? [{ packageName: "remote-kit", serverName: "remote", transport: "http", url: "https://example.test/mcp", auth: "oauth", oauth: {} }] : []),
      reconnect: async () => {
        manager.publishBundledGeneration(await manager.prepareBundledGeneration({ pluginId: "remote-kit", generationId: active!.activationId }, [active!.projection], trust));
      },
    });
    const stableId = bundledConfigId({ kind: "plugin", name: "remote-kit" }, "remote");
    await manager.discardBundledGeneration(await manager.prepareBundledGeneration({ pluginId: "remote-kit", generationId: "run-first" }, [active.projection], trust));
    expect(await manager.authenticate(stableId)).toEqual({ connected: true });
    const key = oauth.sessions[0]!.credentialKey;
    stored.set(key, "grant");
    await vi.waitFor(() => expect(JSON.parse(stored.get("mcp.oauth.index")!)).toEqual({ [stableId]: key }));

    await manager.disconnectBundledGeneration("remote-kit", "run-first");
    active = null;
    installed = new Set();
    idle = false;
    await manager.reconcileBundledCredentials("plugin");
    expect(stored.get(key)).toBe("grant");
    idle = true;
    manager.packageTransactionsSettled();
    await vi.waitFor(() => expect(stored.has(key)).toBe(false));
    expect(JSON.parse(stored.get("mcp.oauth.index")!)).toEqual({});

    installed = new Set(["remote-kit"]);
    active = { activationId: "run-second", projection: projectionFor("run-second") };
    trust.approve(active.projection);
    const reinstalled = await manager.prepareBundledGeneration({ pluginId: "remote-kit", generationId: "run-second" }, [active.projection], trust);
    expect(reinstalled.degraded).toMatchObject([{ code: "credential_required", retryable: true }]);
    expect(reinstalled.records).toHaveLength(0);
    await manager.discardBundledGeneration(reinstalled);
    expect(manager.listServers()).toEqual([{ id: stableId, status: "disconnected", authStatus: "required", registeredTools: [] }]);
    expect(await manager.authenticate(stableId)).toEqual({ connected: true });
    expect(oauth.sessions).toHaveLength(2);
    await manager.disconnectAll();
  });

  it("revokes a removed app plugin's sign-in even when its reinstall commits before the package locks settle", async () => {
    const stored = new Map<string, string>();
    let deletions: Promise<void> | undefined;
    const secrets = { getSecret: (key: string) => stored.get(key) ?? null, setSecret: async (key: string, value: string) => { stored.set(key, value); },
      deleteSecret: async (key: string) => { await deletions; stored.delete(key); }, canStoreEncrypted: () => true };
    const manager = new McpManager(new McpGovernance(join(root, "policy-race.json")), new ToolRegistry(), unusedNetworkFetch,
      join(root, "servers-race.json"), undefined, undefined, undefined, secrets,
      { secrets, redirectCatchers: new AuthRedirectCatchers(), openAuthorizationUrl: async () => {} });
    let idle = true;
    manager.setPackageTransactionProbe(() => idle);
    const projectionFor = (activationId: string) => prepareBundledMcpProjection({ pluginId: "race-kit", pluginVersion: "1.0.0",
      generationId: "a".repeat(64), activationId, localId: "remote", fingerprint: "b".repeat(64) },
    { transport: "http", url: "https://example.test/mcp", auth: "oauth", oauth: {} }, "d".repeat(64));
    const trust = new PluginMcpTrustStore();
    let active = { activationId: "run-first", projection: projectionFor("run-first") };
    trust.approve(active.projection);
    manager.registerBundledCredentialSource("plugin", {
      installedPackages: async () => new Set(["race-kit"]),
      list: () => [{ packageName: "race-kit", serverName: "remote", transport: "http", url: "https://example.test/mcp", auth: "oauth", oauth: {} }],
      reconnect: async () => {
        manager.publishBundledGeneration(await manager.prepareBundledGeneration({ pluginId: "race-kit", generationId: active.activationId }, [active.projection], trust));
      },
    });
    const stableId = bundledConfigId({ kind: "plugin", name: "race-kit" }, "remote");
    await manager.discardBundledGeneration(await manager.prepareBundledGeneration({ pluginId: "race-kit", generationId: "run-first" }, [active.projection], trust));
    expect(await manager.authenticate(stableId)).toEqual({ connected: true });
    const key = oauth.sessions[0]!.credentialKey;
    stored.set(key, "grant");
    await vi.waitFor(() => expect(JSON.parse(stored.get("mcp.oauth.index")!)).toEqual({ [stableId]: key }));

    let releaseDeletions!: () => void;
    deletions = new Promise<void>((resolve) => { releaseDeletions = resolve; });
    idle = false;
    await manager.disconnectBundledGeneration("race-kit", "run-first");
    const removal = manager.reconcileBundledCredentials("plugin", { removed: "race-kit" });
    active = { activationId: "run-second", projection: projectionFor("run-second") };
    trust.approve(active.projection);
    const reinstalled = await manager.prepareBundledGeneration({ pluginId: "race-kit", generationId: "run-second" }, [active.projection], trust);
    expect(stored.get(key)).toBe("grant");
    releaseDeletions();
    await removal;
    idle = true;
    manager.packageTransactionsSettled();
    await manager.reconcileBundledCredentials("plugin");
    expect(reinstalled.degraded).toMatchObject([{ code: "credential_required", retryable: true }]);
    expect(reinstalled.records).toHaveLength(0);
    expect(stored.has(key)).toBe(false);
    expect(manager.listServers()).toEqual([{ id: stableId, status: "disconnected", authStatus: "required", registeredTools: [] }]);
    await manager.discardBundledGeneration(reinstalled);
    expect(await manager.authenticate(stableId)).toEqual({ connected: true });
    expect(oauth.sessions).toHaveLength(2);
    await manager.disconnectAll();
  });

  it("stores a bundled key under packaged encryption and injects it only into a connection", async () => {
    const secretPath = join(root, "bundled-secrets.json");
    const encryption = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "kwallet" as const,
      encryptString: (value: string) => Buffer.from(`sealed:${value}`),
      decryptString: (value: Buffer) => value.toString().slice("sealed:".length),
    };
    const document = new SecretDocumentStore({ path: secretPath, policy: "packaged", encryption });
    const secrets = { getSecret: (key: string) => document.get(key), setSecret: (key: string, value: string) => document.set(key, value),
      deleteSecret: async (key: string) => { await document.delete(key); } };
    const manager = new McpManager(new McpGovernance(join(root, "policy-credential.json")), new ToolRegistry(),
      unusedNetworkFetch, join(root, "servers-credential.json"), undefined, undefined, undefined, secrets);
    const projection = prepareBundledMcpProjection({ pluginId: "agent-plugin/meeting-kit", pluginVersion: "1.0.0",
      generationId: "a".repeat(64), activationId: "run-1", localId: "notes", fingerprint: "b".repeat(64) },
    { transport: "http", url: "https://example.test/mcp", auth: "api-key", apiKeyHeader: "X-Token" }, "d".repeat(64));
    const trust = new PluginMcpTrustStore();
    trust.approve(projection);
    const owner = { pluginId: "agent-plugin/meeting-kit", generationId: "run-1" };
    const missing = await manager.prepareBundledGeneration(owner, [projection], trust);
    expect(missing.degraded).toMatchObject([{ code: "credential_required" }]);
    expect(constructedConfigs).toHaveLength(0);
    await manager.discardBundledGeneration(missing);
    manager.registerBundledCredentialSource("agent-plugin", { installedPackages: async () => new Set(["meeting-kit"]),
      list: () => [{ packageName: "meeting-kit", serverName: "notes", transport: "http", url: "https://example.test/mcp",
        auth: "api-key", apiKeyHeader: "X-Token" }],
      reconnect: async () => {
        const prepared = await manager.prepareBundledGeneration(owner, [projection], trust);
        manager.publishBundledGeneration(prepared);
      },
    });
    expect(await manager.setBundledApiKey({ kind: "agent-plugin", name: "meeting-kit" }, "notes", " private-value ")).toEqual({ connected: true });
    expect(constructedConfigs.at(-1)?.apiKey).toBe("private-value");
    expect(JSON.stringify(projection)).not.toContain("private-value");
    expect(JSON.stringify(await manager.getConfigs())).not.toContain("private-value");
    expect(readFileSync(secretPath, "utf8")).not.toContain("private-value");
    const key = bundledCredentialKey({ kind: "agent-plugin", name: "meeting-kit" }, "notes");
    const reopened = new SecretDocumentStore({ path: secretPath, policy: "packaged", encryption });
    expect(readBoundBundledCredential(reopened.get(key))).toEqual({
      declaration: bundledCredentialDeclaration({ transport: "http", auth: "api-key", apiKeyHeader: "X-Token" }),
      secret: "private-value",
    });
    const restarted = new McpManager(new McpGovernance(join(root, "policy-credential-restart.json")), new ToolRegistry(),
      unusedNetworkFetch, join(root, "servers-credential-restart.json"), undefined, undefined, undefined,
      { getSecret: (name) => reopened.get(name), setSecret: (name, value) => reopened.set(name, value), deleteSecret: async (name) => { await reopened.delete(name); } });
    const successor = prepareBundledMcpProjection({ ...projection.owner, activationId: "run-2" },
      { transport: "http", url: "https://example.test/mcp", auth: "api-key", apiKeyHeader: "X-Token" }, "d".repeat(64));
    expect(trust.isApproved(successor)).toBe(true);
    const resumed = await restarted.prepareBundledGeneration({ pluginId: owner.pluginId, generationId: "run-2" }, [successor], trust);
    expect(constructedConfigs.at(-1)?.apiKey).toBe("private-value");
    await restarted.discardBundledGeneration(resumed);
    const changed = prepareBundledMcpProjection({ ...projection.owner, activationId: "run-3", fingerprint: "c".repeat(64) },
      { transport: "http", url: "https://example.test/mcp", auth: "api-key", apiKeyHeader: "X-New-Token" }, "e".repeat(64));
    trust.approve(changed);
    const beforeChanged = constructedConfigs.length;
    const missingAfterChange = await restarted.prepareBundledGeneration({ pluginId: owner.pluginId, generationId: "run-3" }, [changed], trust);
    expect(missingAfterChange.degraded).toMatchObject([{ code: "credential_required" }]);
    expect(constructedConfigs).toHaveLength(beforeChanged);
    await restarted.discardBundledGeneration(missingAfterChange);
    await restarted.stageBundledCredentialDrop({ kind: "agent-plugin", name: "meeting-kit" }, "notes",
      bundledCredentialDeclaration({ transport: "http", auth: "api-key", apiKeyHeader: "X-New-Token" }));
    expect(reopened.get(key)).toBeNull();
    restarted.registerBundledCredentialSource("agent-plugin", { installedPackages: async () => new Set(["meeting-kit"]),
      list: () => [{ packageName: "meeting-kit", serverName: "notes", transport: "http", url: "https://example.test/mcp",
        auth: "api-key", apiKeyHeader: "X-New-Token" }],
      reconnect: async () => undefined,
    });
    await restarted.setBundledApiKey({ kind: "agent-plugin", name: "meeting-kit" }, "notes", "replacement-value");
    const replacement = await restarted.prepareBundledGeneration({ pluginId: owner.pluginId, generationId: "run-3" }, [changed], trust);
    expect(constructedConfigs.at(-1)?.apiKey).toBe("replacement-value");
    await restarted.discardBundledGeneration(replacement);
    await expect(manager.setApiKey(projection.serverId, "another-value")).rejects.toThrow(/setBundledApiKey/u);
  });

  it("prepares hidden, atomically swaps stable tools, and exact-gates stale calls", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(
      new McpGovernance(join(root, "policy.json")),
      registry,
      unusedNetworkFetch,
      join(root, "servers.json"),
    );
    const active = { current: "g1" };
    const acquireExact = vi.fn(async (_pluginId: string, generationId: string) => {
      if (generationId !== active.current) throw new Error("stale generation");
      return { generation: { generationId } as never, release: vi.fn() };
    });
    manager.setPluginGenerationAccess({
      getActive: vi.fn(() => undefined),
      isExactAdmitted: vi.fn(() => true),
      acquire: vi.fn(async () => { throw new Error("not used"); }),
      acquireExact,
      runWithLease: vi.fn(async (_lease, operation) => operation()),
    });

    const trust = new PluginMcpTrustStore();
    const g1Projection = preparePluginMcpGeneration(generation("g1"), root)[0];
    trust.approve(g1Projection);
    const g1 = await manager.prepareBundledGeneration(
      { pluginId: "sampleportal", generationId: "g1" },
      [g1Projection],
      trust,
    );
    expect(registry.findByName("mcp_sampleportal_portal_read")).toBeUndefined();
    manager.publishBundledGeneration(g1);
    const oldTool = registry.findByName("mcp_sampleportal_portal_read");
    expect(oldTool?.mcpServerId).toBe(g1Projection.serverId);

    const g2Projection = preparePluginMcpGeneration(generation("g2"), root)[0];
    expect(trust.isApproved(g2Projection)).toBe(true);
    const g2 = await manager.prepareBundledGeneration(
      { pluginId: "sampleportal", generationId: "g2" },
      [g2Projection],
      trust,
    );
    expect(registry.findByName("mcp_sampleportal_portal_read")?.mcpServerId).toBe(g1Projection.serverId);
    active.current = "g2";
    manager.publishBundledGeneration(g2);
    expect(registry.findByName("mcp_sampleportal_portal_read")?.mcpServerId).toBe(g2Projection.serverId);
    await expect(oldTool?.execute({}, {} as never)).rejects.toThrow(/stale generation/);
    await expect(registry.findByName("mcp_sampleportal_portal_read")?.execute({}, {} as never)).resolves.toMatchObject({ isError: false });
  });

  it("routes an agent plugin's bundled leases to its registered source, for tool execution and every other call", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(
      new McpGovernance(join(root, "policy-lease-source.json")),
      registry,
      unusedNetworkFetch,
      join(root, "servers-lease-source.json"),
    );
    const lifecycleAcquire = vi.fn(async () => { throw new Error("plugin lifecycle asked for an agent plugin lease"); });
    manager.setPluginGenerationAccess({
      getActive: vi.fn(() => undefined),
      isExactAdmitted: vi.fn(() => true),
      acquire: vi.fn(async () => { throw new Error("not used"); }),
      acquireExact: lifecycleAcquire,
      runWithLease: vi.fn(async (_lease, operation) => operation()),
    });
    const retired = new Set<string>();
    const released = vi.fn();
    const acquired: string[] = [];
    manager.registerGenerationLeaseSource("agent-plugin/", async (pluginId, activationId) => {
      if (retired.has(activationId)) throw new Error(`bundled MCP generation ${activationId} of ${pluginId} is retired`);
      acquired.push(`${pluginId}#${activationId}`);
      return { release: released };
    });
    expect(() => manager.registerGenerationLeaseSource("agent-plugin/", async () => ({ release() {} }))).toThrow(/already registered/u);

    const trust = new PluginMcpTrustStore();
    const projection = prepareBundledMcpProjection({ pluginId: "agent-plugin/meeting-kit", pluginVersion: "1.0.0",
      generationId: "a".repeat(64), activationId: "run-1", localId: "notes", fingerprint: "b".repeat(64) },
    { transport: "http", url: "https://example.test/mcp" }, "d".repeat(64));
    trust.approve(projection);
    const prepared = await manager.prepareBundledGeneration({ pluginId: "agent-plugin/meeting-kit", generationId: "run-1" }, [projection], trust);
    manager.publishBundledGeneration(prepared);

    await expect(registry.findByName("mcp_sampleportal_portal_read")?.execute({}, {} as never)).resolves.toMatchObject({ isError: false });
    await expect(manager.callTool(projection.serverId, "read", {})).resolves.toMatchObject({ text: "ok" });
    await expect(manager.readUiResource(projection.serverId, "ui://card")).resolves.toMatchObject({ uri: "ui://card" });
    expect(acquired).toEqual(["agent-plugin/meeting-kit#run-1", "agent-plugin/meeting-kit#run-1", "agent-plugin/meeting-kit#run-1"]);
    expect(released).toHaveBeenCalledTimes(3);
    expect(lifecycleAcquire).not.toHaveBeenCalled();

    retired.add("run-1");
    await expect(manager.callTool(projection.serverId, "read", {})).rejects.toThrow(/is retired/u);
    await expect(registry.findByName("mcp_sampleportal_portal_read")?.execute({}, {} as never)).rejects.toThrow(/is retired/u);
    await manager.disconnectBundledGeneration("agent-plugin/meeting-kit", "run-1");
  });

  it("hands an agent plugin's stdio server its version and data roots all the way to the client", async () => {
    // Retain the owned payload read grant when wrapping commands under the otherwise-denied package root.
    vi.stubEnv("AVE_HOME", join(root, "stdio-home"));
    try {
      const manager = new McpManager(new McpGovernance(join(root, "policy-stdio.json")), new ToolRegistry(),
        unusedNetworkFetch, join(root, "servers-stdio.json"));
      const roots = {
        pluginDataDir: join(root, "stdio-home", "agent-plugin-data", "meeting-kit"),
        bundledPayloadRoot: join(root, "stdio-home", "packages", "agent-plugin", "meeting-kit", "1.0.0"),
      };
      const projection = prepareBundledMcpProjection({ pluginId: "agent-plugin/meeting-kit", pluginVersion: "1.0.0",
        generationId: "a".repeat(64), activationId: "run-1", localId: "notes", fingerprint: "b".repeat(64) },
      { transport: "stdio", command: "/usr/bin/true" }, "d".repeat(64), roots);
      const trust = new PluginMcpTrustStore();
      trust.approve(projection);
      const prepared = await manager.prepareBundledGeneration({ pluginId: "agent-plugin/meeting-kit", generationId: "run-1" }, [projection], trust);
      expect(constructedConfigs.at(-1)).toMatchObject({ ...roots, sandboxRoot: expect.any(String) });
      await manager.discardBundledGeneration(prepared);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retains a discarded candidate handle until disconnect succeeds", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(
      new McpGovernance(join(root, "policy-retry.json")),
      registry,
      unusedNetworkFetch,
      join(root, "servers-retry.json"),
    );
    const trust = new PluginMcpTrustStore();
    const projection = preparePluginMcpGeneration(generation("g-retry"), root)[0];
    trust.approve(projection);
    const prepared = await manager.prepareBundledGeneration(
      { pluginId: "sampleportal", generationId: "g-retry" },
      [projection],
      trust,
    );

    disconnect.mockRejectedValueOnce(
      Object.assign(new Error("transport still owns child"), { code: "EBUSY" }),
    );
    await expect(manager.discardBundledGeneration(prepared)).rejects.toThrow(
      /cleanup remains pending/,
    );

    await expect(manager.discardBundledGeneration(prepared)).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});

it.each([false, true])("keeps a plugin-hosted MCP tool on the shared MCP permission row with readOnlyHint=%s", async readOnlyHint => {
  discoveryReadOnlyHint = readOnlyHint;
  const registry = new ToolRegistry();
  const manager = new McpManager(new McpGovernance(join(root, `policy-mcp-permission-${readOnlyHint}.json`)), registry, unusedNetworkFetch,
    join(root, `servers-mcp-permission-${readOnlyHint}.json`));
  const generationId = `permission-${readOnlyHint}`;
  const projection = preparePluginMcpGeneration(generation(generationId), root)[0];
  const trust = new PluginMcpTrustStore();
  trust.approve(projection);
  const prepared = await manager.prepareBundledGeneration({ pluginId: "sampleportal", generationId }, [projection], trust);
  try {
    manager.publishBundledGeneration(prepared);
    const tool = registry.findByName("mcp_sampleportal_portal_read")!;
    expect(tool).toMatchObject({ source: "mcp", mcpReadOnlyHint: readOnlyHint, mcpServerId: projection.serverId,
      pluginGeneration: { pluginId: "sampleportal", generationId } });
    const permissions = new PermissionManager(join(root, `tool-permission-${readOnlyHint}.json`));
    for (const mode of ["strict", "default", "auto", "allow"] as const) {
      permissions.setMode(mode);
      const firstUse = permissions.checkDetailed(tool.name, tool.source, tool.category, undefined, { mcpReadOnlyHint: tool.mcpReadOnlyHint });
      expect(firstUse.decision).toBe(readOnlyHint || mode === "allow" ? "allow" : "ask");
      expect(firstUse.reviewer?.route).toBe(!readOnlyHint && mode === "auto" ? "foreground-auto" : undefined);
      expect(firstUse.forceModal).toBeUndefined();
    }
    if (!readOnlyHint) {
      permissions.setMode("default");
      const firstUse = permissions.checkDetailed(tool.name, tool.source, tool.category, undefined, { mcpReadOnlyHint: false });
      expect(firstUse).toMatchObject({ decision: "ask", reasonCode: "external-tool" });
      expect(permissions.resolveRememberedPermission(firstUse, "The user approved this server and tool")).toMatchObject({ decision: "allow", reasonCode: "remembered-approval" });
      expect(permissions.checkDetailed(`${tool.name}_other`, "mcp", "network")).toMatchObject({ decision: "ask", reasonCode: "external-tool" });
    }
  } finally { await manager.disconnectAll(); }
});
