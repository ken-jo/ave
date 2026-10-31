import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { listenFetchLoopback } from "../../shared/fetch-loopback-listener.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretDocumentStore, type SecretEncryption } from "../../data/secret-document-store.js";
import { AuthRedirectCatchers } from "../../main/auth-redirect-catcher.js";
import { ToolRegistry } from "../../tools/registry.js";
import { McpGovernance } from "../mcp-governance.js";
import { McpManager } from "../mcp-manager.js";
import type { McpGovernancePolicy, McpHttpServerConfig } from "../types.js";

const lookupMock = vi.hoisted(() => vi.fn(async (_host: string, _options: unknown) => [{ address: "93.184.216.34", family: 4 }]));
vi.mock("node:dns", () => ({ promises: { lookup: (host: string, options: unknown) => lookupMock(host, options) } }));

interface WireFixture {
  origin: string;
  listenOrigin: string;
  endpoint: string;
  acceptedAccessToken: string;
  refreshRevoked: boolean;
  wrongResource: boolean;
  allowAnonymous: boolean;
  authorizationRequests: URL[];
  tokenRequests: URLSearchParams[];
  registrationRequests: Array<Record<string, unknown>>;
  rpcMethods: string[];
  resourceChallenges: number;
  pkceAccepted: number;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Integration fixture cleanup failed");
});

async function startWireFixture(options: { publicOrigin?: string } = {}): Promise<WireFixture> {
  const fixture: WireFixture = {
    origin: "", listenOrigin: "", endpoint: "",
    acceptedAccessToken: "", refreshRevoked: false, wrongResource: false, allowAnonymous: false,
    authorizationRequests: [], tokenRequests: [], registrationRequests: [],
    rpcMethods: [], resourceChallenges: 0, pkceAccepted: 0,
  };
  let challenge = "";
  let redirectUri = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", fixture.origin);
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/protected-metadata") {
      json(200, {
        resource: fixture.wrongResource ? `${fixture.origin}/different-resource` : fixture.endpoint,
        authorization_servers: [fixture.origin], scopes_supported: ["tools"],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(200, {
        issuer: fixture.origin, authorization_endpoint: `${fixture.origin}/authorize`,
        token_endpoint: `${fixture.origin}/token`, registration_endpoint: `${fixture.origin}/register`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (url.pathname === "/register") {
      const metadata = JSON.parse(body) as Record<string, unknown>;
      fixture.registrationRequests.push(metadata);
      const redirects = metadata.redirect_uris;
      if (!Array.isArray(redirects) || typeof redirects[0] !== "string") {
        json(400, { error: "invalid_client_metadata" });
        return;
      }
      redirectUri = redirects[0];
      json(201, { ...metadata, client_id: "local-native-client", token_endpoint_auth_method: "none" });
      return;
    }
    if (url.pathname === "/authorize") {
      fixture.authorizationRequests.push(url);
      challenge = url.searchParams.get("code_challenge") ?? "";
      if (url.searchParams.get("resource") !== fixture.endpoint ||
        url.searchParams.get("client_id") !== "local-native-client" ||
        url.searchParams.get("redirect_uri") !== redirectUri ||
        url.searchParams.get("code_challenge_method") !== "S256" || !challenge) {
        json(400, { error: "invalid_request" });
        return;
      }
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "local-authorization-code");
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", fixture.origin);
      response.writeHead(302, { location: callback.href });
      response.end();
      return;
    }
    if (url.pathname === "/token") {
      const grant = new URLSearchParams(body);
      fixture.tokenRequests.push(grant);
      if (grant.get("resource") !== fixture.endpoint) {
        json(400, { error: "invalid_target" });
        return;
      }
      if (grant.get("client_id") !== "local-native-client") {
        json(400, { error: "invalid_client" });
        return;
      }
      if (grant.get("grant_type") === "authorization_code") {
        const verifier = grant.get("code_verifier") ?? "";
        if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) ||
          createHash("sha256").update(verifier).digest("base64url") !== challenge ||
          grant.get("redirect_uri") !== redirectUri || grant.get("code") !== "local-authorization-code") {
          json(400, { error: "invalid_grant" });
          return;
        }
        fixture.pkceAccepted += 1;
      } else if (grant.get("grant_type") === "refresh_token") {
        if (fixture.refreshRevoked || grant.get("refresh_token") !== "local-refresh-secret") {
          json(400, { error: "invalid_grant" });
          return;
        }
      } else {
        json(400, { error: "unsupported_grant_type" });
        return;
      }
      fixture.acceptedAccessToken = `local-access-secret-${fixture.tokenRequests.length}`;
      json(200, { access_token: fixture.acceptedAccessToken, refresh_token: "local-refresh-secret",
        token_type: "Bearer", expires_in: 3600 });
      return;
    }
    if (url.pathname === "/mcp") {
      if (!fixture.allowAnonymous && (!fixture.acceptedAccessToken || request.headers.authorization !== `Bearer ${fixture.acceptedAccessToken}`)) {
        fixture.resourceChallenges += 1;
        response.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${fixture.origin}/protected-metadata", scope="tools"`,
        });
        response.end();
        return;
      }
      const message = JSON.parse(body) as { id: number; method: string; params?: { name?: string; arguments?: { text?: string } } };
      fixture.rpcMethods.push(message.method);
      let result: unknown;
      switch (message.method) {
        case "server/discover":
          result = { resultType: "complete", ttlMs: 60000, cacheScope: "private",
            supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
            serverInfo: { name: "local-tools", version: "1.0.0" } };
          break;
        case "tools/list":
          result = { tools: [{ name: "echo", description: "Return input text",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
          break;
        case "tools/call":
          if (message.params?.name !== "echo") {
            json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool" } });
            return;
          }
          result = { resultType: "complete", content: [{ type: "text", text: message.params.arguments?.text ?? "" }] };
          break;
        default:
          json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } });
          return;
      }
      json(200, { jsonrpc: "2.0", id: message.id, result });
      return;
    }
    json(404, { error: "not_found" });
  });
  const port = await listenFetchLoopback(server);
  fixture.listenOrigin = `http://127.0.0.1:${port}`;
  fixture.origin = options.publicOrigin ?? fixture.listenOrigin;
  fixture.endpoint = `${fixture.origin}/mcp`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return fixture;
}

function createEncryption(): SecretEncryption {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "external_key",
    encryptString(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

async function fetchFixture(fixture: WireFixture, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  if (!request.url.startsWith(fixture.origin)) return fetch(request);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return fetch(`${fixture.listenOrigin}${request.url.slice(fixture.origin.length)}`, {
    method: request.method, headers: request.headers, body, redirect: request.redirect, signal: request.signal,
  });
}

async function createManager(fixture: WireFixture) {
  const publicNetwork = fixture.origin !== fixture.listenOrigin;
  const directory = await mkdtemp(join(tmpdir(), "ave-mcp-oauth-integration-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config: McpHttpServerConfig = { id: "remote-tools", transport: "http", url: fixture.endpoint,
    auth: "oauth", ...(publicNetwork ? {} : { allowPrivateNetworks: true }) };
  const policy: McpGovernancePolicy = {
    version: "1.0", defaultPolicy: "deny",
    servers: [{ id: config.id, name: "Remote tools", status: "approved", transport: "http",
      allowedUrls: [new URL(fixture.origin).hostname], requiredAuth: "oauth", tlsRequired: publicNetwork, allowedCapabilities: ["tools"],
      maxTools: 2, toolNamePrefix: "remote", connectionTimeoutMs: 5000,
      maxConcurrentRequests: 2, allowPrivateNetworks: !publicNetwork }],
    globalRules: { maxServersTotal: 2, blockedUrlPatterns: [], allowedUrlPatterns: [], policyRefreshIntervalMs: 60000 },
  };
  const policyPath = join(directory, "policy.json");
  const configPath = join(directory, "servers.json");
  const secretPath = join(directory, "secrets.json");
  await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(configPath, JSON.stringify({ servers: [config] }));
  const document = new SecretDocumentStore({ path: secretPath, policy: "packaged", encryption: createEncryption() });
  const secrets = { getSecret: (key: string) => document.getEncrypted(key),
    setSecret: (key: string, value: string) => document.set(key, value),
    deleteSecret: async (key: string) => { await document.delete(key); },
    canStoreEncrypted: () => document.canStoreEncrypted() };
  const registry = new ToolRegistry();
  const egressPaths: string[] = [];
  const networkFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    egressPaths.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
    return fetchFixture(fixture, input, init);
  }) as typeof fetch;
  let browserOpens = 0;
  const manager = new McpManager(new McpGovernance(policyPath), registry, networkFetch, configPath,
    undefined, undefined, undefined, secrets, {
      secrets,
      redirectCatchers: new AuthRedirectCatchers(),
      openAuthorizationUrl: async (url) => {
        browserOpens += 1;
        const response = await fetchFixture(fixture, url, { redirect: "manual" });
        const location = response.headers.get("location");
        if (response.status !== 302 || !location) throw new Error("Authorization rejected");
        const callback = new URL(location);
        callback.hostname = "127.0.0.1";
        await fetch(callback, { redirect: "manual" });
      },
    });
  cleanups.push(() => manager.disconnectAll());
  return { manager, registry, config, secretPath, egressPaths, browserOpens: () => browserOpens };
}

describe("remote authorization over the real client transport", () => {
  it("discovers a challenged resource, connects tools, refreshes and withdraws access after revocation", async () => {
    const fixture = await startWireFixture();
    const { manager, registry, config, secretPath, egressPaths, browserOpens } = await createManager(fixture);
    await expect(manager.connectServer(config)).rejects.toThrow();
    expect(manager.getServerState(config.id)?.authStatus).toBe("required");
    expect(browserOpens()).toBe(0);
    expect(registry.listAll()).toEqual([]);

    expect(await manager.authenticate(config.id)).toEqual({ connected: true });
    expect(manager.getServerState(config.id)).toMatchObject({ status: "connected", authStatus: "authenticated",
      registeredTools: ["mcp_remote_echo"] });
    expect(registry.findByName("mcp_remote_echo")?.mcpServerId).toBe(config.id);
    expect(fixture.rpcMethods).toEqual(["server/discover", "tools/list"]);
    expect(fixture.registrationRequests).toHaveLength(1);
    expect(fixture.registrationRequests[0]).toMatchObject({ application_type: "native", token_endpoint_auth_method: "none" });
    expect(fixture.pkceAccepted).toBe(1);
    expect(fixture.authorizationRequests[0].searchParams.get("resource")).toBe(fixture.endpoint);
    expect(fixture.tokenRequests[0].get("resource")).toBe(fixture.endpoint);
    expect(await manager.callTool(config.id, "echo", { text: "first call" })).toMatchObject({ text: "first call" });
    const stored = await readFile(secretPath, "utf8");
    expect(stored).not.toContain("local-access-secret");
    expect(stored).not.toContain("local-refresh-secret");
    expect(JSON.stringify([manager.listServers(), await manager.getConfigs()])).not.toContain("local-access-secret");
    expect(JSON.stringify([manager.listServers(), await manager.getConfigs()])).not.toContain("local-refresh-secret");

    fixture.acceptedAccessToken = "expired-access";
    expect(await manager.callTool(config.id, "echo", { text: "after refresh" })).toMatchObject({ text: "after refresh" });
    expect(fixture.tokenRequests).toHaveLength(2);
    expect(fixture.tokenRequests[1].get("grant_type")).toBe("refresh_token");
    expect(fixture.tokenRequests[1].get("resource")).toBe(fixture.endpoint);
    expect(browserOpens()).toBe(1);
    expect(manager.getServerState(config.id)?.authStatus).toBe("authenticated");
    expect(egressPaths).toEqual(expect.arrayContaining([
      "/mcp", "/protected-metadata", "/.well-known/oauth-authorization-server", "/register", "/token",
    ]));

    fixture.acceptedAccessToken = "revoked-access";
    fixture.refreshRevoked = true;
    await expect(manager.callTool(config.id, "echo", { text: "revoked" })).rejects.toThrow();
    expect(fixture.tokenRequests).toHaveLength(3);
    expect(fixture.tokenRequests[2].get("grant_type")).toBe("refresh_token");
    expect(fixture.tokenRequests[2].get("resource")).toBe(fixture.endpoint);
    await expect.poll(() => manager.getServerState(config.id)).toMatchObject({ status: "disconnected", authStatus: "required", registeredTools: [] });
    expect(registry.findByName("mcp_remote_echo")).toBeUndefined();
    expect(browserOpens()).toBe(1);
    expect(fixture.resourceChallenges).toBe(3);
  });

  it("authorizes a public HTTPS endpoint through the network-guarded transport without private-network access", async () => {
    const fixture = await startWireFixture({ publicOrigin: "https://mcp.example.test" });
    lookupMock.mockClear();
    const { manager, registry, config, egressPaths, browserOpens } = await createManager(fixture);
    expect(config.allowPrivateNetworks).toBeUndefined();
    await expect(manager.connectServer(config)).rejects.toThrow();
    expect(manager.getServerState(config.id)?.authStatus).toBe("required");

    expect(await manager.authenticate(config.id)).toEqual({ connected: true });
    expect(registry.findByName("mcp_remote_echo")?.mcpServerId).toBe(config.id);
    expect(await manager.callTool(config.id, "echo", { text: "public call" })).toMatchObject({ text: "public call" });
    expect(fixture.pkceAccepted).toBe(1);
    expect(fixture.tokenRequests[0].get("resource")).toBe("https://mcp.example.test/mcp");
    expect(browserOpens()).toBe(1);
    expect(lookupMock.mock.calls.map(([host]) => host)).toEqual(expect.arrayContaining(["mcp.example.test"]));
    expect(lookupMock.mock.calls.every(([host]) => host === "mcp.example.test")).toBe(true);
    expect(egressPaths).toEqual(expect.arrayContaining([
      "/mcp", "/protected-metadata", "/.well-known/oauth-authorization-server", "/register", "/token",
    ]));
  });

  it("rejects discovery for a different resource before registration or browser interaction", async () => {
    const fixture = await startWireFixture();
    fixture.wrongResource = true;
    const { manager, registry, config, browserOpens } = await createManager(fixture);
    await expect(manager.connectServer(config)).rejects.toThrow();
    expect(await manager.authenticate(config.id)).toEqual({ connected: false, errorCode: "mcp-auth-resource-mismatch" });
    expect(fixture.registrationRequests).toEqual([]);
    expect(fixture.tokenRequests).toEqual([]);
    expect(fixture.rpcMethods).toEqual([]);
    expect(registry.listAll()).toEqual([]);
    expect(browserOpens()).toBe(0);
  });

  it("prevents anonymous tool publication when an authorization-configured server accepts requests without a grant", async () => {
    const fixture = await startWireFixture();
    fixture.allowAnonymous = true;
    const { manager, registry, config, browserOpens } = await createManager(fixture);
    const register = vi.spyOn(registry, "register");
    await expect(manager.connectServer(config)).rejects.toThrow();
    expect(fixture.rpcMethods).toEqual(["server/discover"]);
    expect(register).not.toHaveBeenCalled();
    expect(manager.getServerState(config.id)?.authStatus).toBe("required");
    expect(registry.listAll()).toEqual([]);
    expect(browserOpens()).toBe(0);
    expect(fixture.tokenRequests).toEqual([]);
  });
});
