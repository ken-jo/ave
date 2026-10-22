import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthRedirectCatchers } from "../../main/auth-redirect-catcher.js";
import { McpOAuthSession, type McpOAuthSecrets } from "../mcp-oauth.js";
import type { McpHttpServerConfig } from "../types.js";
import { MCP_PROTOCOL_VERSION } from "../protocol-constants.js";

interface Fixture {
  base: string;
  server: Server;
  resource: string;
  issuer: string;
  challengePath: string;
  pkce: string[];
  registrations: Array<Record<string, unknown>>;
  grants: URLSearchParams[];
  bearer: Array<string | undefined>;
  authorizations: URL[];
  refreshRevoked: boolean;
  rejectAccess: boolean;
  expiresIn: number;
  callbackState?: string;
  callbackIssuer?: string | null;
  methods?: string[];
  dcr: boolean;
  redirectMetadata: boolean;
  resourceMetadataAvailable: boolean;
  wellKnownMetadataUnavailable?: boolean;
  tokenRedirect: boolean;
  tokenResponseBody?: string;
  resourceFailure?: number;
  oidc: boolean;
  discoveryVersions: Array<string | undefined>;
  refreshFailure?: number;
  refreshDropConnection?: boolean;
  refreshGate?: Promise<void>;
  onRefreshStarted?: () => void;
  authorizationServer?: string;
  tokenScope?: string;
  challengeScope: string;
  allowAnonymous?: boolean;
}

const sessions: McpOAuthSession[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

async function fixture(): Promise<Fixture> {
  const state = {
    base: "", resource: "", issuer: "", challengePath: "/metadata", pkce: [], registrations: [], grants: [], bearer: [],
    authorizations: [], refreshRevoked: false, rejectAccess: false, expiresIn: 3600, methods: ["S256"],
    dcr: true, redirectMetadata: false, resourceMetadataAvailable: true, tokenRedirect: false, oidc: false, discoveryVersions: [], challengeScope: "tools",
  } as unknown as Fixture;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", state.base);
    const json = (body: unknown, status = 200): void => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
    };
    if (url.pathname === "/mcp") {
      state.bearer.push(request.headers.authorization);
      if (state.resourceFailure) { json({ error: "access-secret-1" }, state.resourceFailure); return; }
      if (state.allowAnonymous || (request.headers.authorization && !state.rejectAccess)) { json({ ok: true }); return; }
      response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${state.base}${state.challengePath}", scope="${state.challengeScope}"` });
      response.end("upstream credential-bearing diagnostic"); return;
    }
    if (url.pathname === "/metadata" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      state.discoveryVersions.push(request.headers["mcp-protocol-version"] as string | undefined);
      if (!state.resourceMetadataAvailable || (state.wellKnownMetadataUnavailable && url.pathname.startsWith("/.well-known/"))) { json({}, 404); return; }
      if (state.redirectMetadata) { response.writeHead(302, { location: `${state.base}/untrusted` }); response.end(); return; }
      json({ resource: state.resource, authorization_servers: [state.authorizationServer ?? state.base], scopes_supported: ["tools"] }); return;
    }
    if (state.oidc && url.pathname === "/.well-known/oauth-authorization-server") { json({}, 404); return; }
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      state.discoveryVersions.push(request.headers["mcp-protocol-version"] as string | undefined);
      json({ issuer: state.issuer, authorization_endpoint: `${state.base}/authorize`, token_endpoint: `${state.base}/token`,
        registration_endpoint: state.dcr ? `${state.base}/register` : undefined, response_types_supported: ["code"],
        code_challenge_methods_supported: state.methods, token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true, jwks_uri: `${state.base}/jwks`, subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"] }); return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (url.pathname === "/register") {
      const registration = JSON.parse(body) as Record<string, unknown>;
      state.registrations.push(registration);
      json({ ...registration, client_id: "native-client", token_endpoint_auth_method: "none" }, 201); return;
    }
    if (url.pathname === "/authorize") {
      state.authorizations.push(url);
      state.pkce.push(url.searchParams.get("code_challenge") ?? "");
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("state", state.callbackState ?? url.searchParams.get("state") ?? "");
      redirect.searchParams.set("code", "authorization-code");
      if (state.callbackIssuer !== null) redirect.searchParams.set("iss", state.callbackIssuer ?? state.base);
      response.writeHead(302, { location: redirect.href }); response.end(); return;
    }
    if (url.pathname === "/token") {
      const grant = new URLSearchParams(body);
      state.grants.push(grant);
      const tokenIndex = state.grants.length;
      if (grant.get("grant_type") === "refresh_token") {
        state.onRefreshStarted?.();
        await state.refreshGate;
        if (state.refreshDropConnection) { request.socket.destroy(); return; }
        if (state.refreshFailure) { json({ error: "server_error", error_description: "secret-refresh-credential" }, state.refreshFailure); return; }
      }
      if (state.tokenRedirect) { response.writeHead(302, { location: `${state.base}/untrusted` }); response.end(); return; }
      if (state.tokenResponseBody) { response.end(state.tokenResponseBody); return; }
      if (grant.get("resource") !== state.resource) { json({ error: "invalid_target" }, 400); return; }
      if (grant.get("grant_type") === "refresh_token" && state.refreshRevoked) {
        json({ error: "invalid_grant", error_description: "secret-refresh-credential" }, 400); return;
      }
      if (grant.get("grant_type") === "authorization_code") {
        const challenge = createHash("sha256").update(grant.get("code_verifier") ?? "").digest("base64url");
        if (!state.pkce.includes(challenge)) { json({ error: "invalid_grant" }, 400); return; }
      }
      json({ access_token: `access-secret-${tokenIndex}`, refresh_token: `refresh-secret-${tokenIndex}`,
        token_type: "Bearer", expires_in: state.expiresIn, scope: state.tokenScope }); return;
    }
    json({ error: "not_found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.server = server;
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.issuer = state.base;
  state.resource = `${state.base}/mcp`;
  servers.push(server);
  return state;
}

function createSession(state: Fixture, options: { store?: Map<string, string>; config?: Partial<McpHttpServerConfig>; getSecret?: McpOAuthSecrets["getSecret"] } = {}) {
  const store = options.store ?? new Map<string, string>();
  const secrets: McpOAuthSecrets = {
    getSecret: options.getSecret ?? ((key) => store.get(key) ?? null),
    setSecret: async (key, value) => { store.set(key, value); },
    deleteSecret: async (key) => { store.delete(key); },
  };
  const catchers = new AuthRedirectCatchers();
  const openAuthorizationUrl = vi.fn(async (url: string) => {
    const auth = await fetch(url, { redirect: "manual" });
    const redirect = new URL(auth.headers.get("location") ?? "");
    redirect.hostname = "127.0.0.1";
    await fetch(redirect, { redirect: "manual" });
  });
  const networkFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch;
  const config: McpHttpServerConfig = { id: "remote", transport: "http", url: state.resource, auth: "oauth",
    allowPrivateNetworks: true, ...options.config };
  const session = new McpOAuthSession(config, { secrets, redirectCatchers: catchers, openAuthorizationUrl, networkFetch });
  sessions.push(session);
  return { session, store, openAuthorizationUrl, networkFetch, catchers, secrets };
}

describe("remote authorization", () => {
  it("restores the challenged metadata location for an expired grant after restart", async () => {
    const state = await fixture();
    state.wellKnownMetadataUnavailable = true;
    state.expiresIn = 0;
    const first = createSession(state);
    await expect(first.session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    await first.session.authenticate();
    first.session.dispose();
    const restored = createSession(state, { store: first.store });
    expect((await restored.session.fetch(state.resource)).ok).toBe(true);
    expect(state.grants.map((grant) => grant.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    expect(restored.openAuthorizationUrl).not.toHaveBeenCalled();
    expect(restored.session.getStatus()).toBe("authenticated");
  });

  it("rejects anonymous success before exposing resource responses and permits only one challenge probe", async () => {
    const state = await fixture();
    state.allowAnonymous = true;
    const { session } = createSession(state);
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    expect(state.bearer).toEqual([undefined]);
    expect(session.getStatus()).toBe("required");
  });

  it("permits a new challenge probe after the initial network request fails", async () => {
    const state = await fixture();
    const { session, networkFetch } = createSession(state);
    vi.mocked(networkFetch).mockRejectedValueOnce(new Error("Network unavailable"));
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    expect(networkFetch).toHaveBeenCalledTimes(2);
    expect(state.bearer).toEqual([undefined]);
  });

  it("rejects a delayed anonymous response after a concurrent login completes", async () => {
    const state = await fixture();
    const { session, networkFetch } = createSession(state);
    let respond!: (response: Response) => void;
    vi.mocked(networkFetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { respond = resolve; }));
    const rejected = expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication failed$/u);
    await session.authenticate();
    respond(new Response(JSON.stringify({ anonymous: true }), { status: 200 }));
    await rejected;
    expect(session.getStatus()).toBe("authenticated");
    expect((await session.fetch(state.resource)).ok).toBe(true);
  });

  it("does not fall back to anonymous access when a grant is revoked before its first resource request", async () => {
    const state = await fixture();
    state.expiresIn = 0;
    const { session } = createSession(state);
    await session.authenticate();
    state.refreshRevoked = true;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    state.allowAnonymous = true;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    expect(state.bearer).toEqual([]);
  });

  it("discovers metadata, registers a native client and exchanges a S256 grant with resource indicators", async () => {
    const state = await fixture();
    const { session, store } = createSession(state);
    await session.authenticate();
    expect(session.getStatus()).toBe("authenticated");
    expect(state.registrations[0]).toMatchObject({ application_type: "native", token_endpoint_auth_method: "none" });
    expect(state.authorizations[0].searchParams.get("code_challenge_method")).toBe("S256");
    expect(state.authorizations[0].searchParams.get("resource")).toBe(state.resource);
    expect(state.grants[0].get("resource")).toBe(state.resource);
    expect(state.discoveryVersions).toEqual([MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION]);
    expect(state.grants[0].get("code_verifier")).toMatch(/^[A-Za-z0-9._~-]{43,128}$/u);
    expect(await (await session.fetch(state.resource)).json()).toEqual({ ok: true });
    expect(state.bearer).toEqual(["Bearer access-secret-1"]);
    expect([...store.values()][0]).toContain("refresh-secret-1");
  });

  it("captures a 401 challenge without opening the browser and uses its metadata URL interactively", async () => {
    const state = await fixture();
    const { session, openAuthorizationUrl, networkFetch } = createSession(state, { config: { oauth: { scopes: ["configured"] } } });
    await expect(session.fetch(state.resource)).rejects.toThrow("MCP authentication required");
    expect(openAuthorizationUrl).not.toHaveBeenCalled();
    expect(session.getStatus()).toBe("required");
    await session.authenticate();
    const calls = vi.mocked(networkFetch).mock.calls;
    expect(calls.some(([url]) => String(url) === `${state.base}/metadata`)).toBe(true);
    expect(state.authorizations[0].searchParams.get("scope")).toBe("tools");
  });

  it("refreshes expired credentials once for concurrent requests and persists rotation", async () => {
    const state = await fixture();
    state.expiresIn = 0;
    const { session, store, openAuthorizationUrl } = createSession(state);
    await session.authenticate();
    state.expiresIn = 3600;
    await Promise.all([session.fetch(state.resource), session.fetch(state.resource)]);
    expect(state.grants.map((grant) => grant.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    expect(state.grants[1].get("resource")).toBe(state.resource);
    expect([...store.values()][0]).toContain("refresh-secret-2");
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(1);
  });

  it("refreshes after 401 and bounds resource retries to one", async () => {
    const state = await fixture();
    const { session } = createSession(state);
    await session.authenticate();
    state.rejectAccess = true;
    await expect(session.fetch(state.resource)).rejects.toThrow("MCP authentication required");
    expect(state.grants).toHaveLength(2);
    expect(state.bearer).toHaveLength(2);
    expect(session.getStatus()).toBe("required");
  });

  it("clears revoked refresh tokens and requires user reauthentication without upstream error leakage", async () => {
    const state = await fixture();
    const { session, store, openAuthorizationUrl } = createSession(state);
    await session.authenticate();
    state.rejectAccess = true;
    state.refreshRevoked = true;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    expect([...store.values()][0]).not.toContain("access-secret");
    expect([...store.values()][0]).not.toContain("refresh-secret");
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(1);
    state.allowAnonymous = true;
    const requestCount = state.bearer.length;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    expect(state.bearer).toHaveLength(requestCount);
    state.allowAnonymous = false;
    state.rejectAccess = false;
    await session.authenticate();
    expect(session.getStatus()).toBe("authenticated");
  });

  it.each(["resource", "issuer", "pkce", "registration", "redirect"])("rejects invalid %s discovery before opening authorization", async (kind) => {
    const state = await fixture();
    if (kind === "resource") state.resource = `${state.base}/other`;
    if (kind === "issuer") state.issuer = `${state.base}/other`;
    if (kind === "pkce") state.methods = ["plain"];
    if (kind === "registration") state.dcr = false;
    if (kind === "redirect") state.redirectMetadata = true;
    const { session, openAuthorizationUrl } = createSession(state, { config: { url: `${state.base}/mcp` } });
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(openAuthorizationUrl).not.toHaveBeenCalled();
    expect(state.registrations).toHaveLength(0);
    expect(state.grants).toHaveLength(0);
  });

  it.each(["state", "issuer", "missing issuer"])("rejects a callback with invalid %s before sending the code", async (kind) => {
    const state = await fixture();
    if (kind === "state") state.callbackState = "wrong-state";
    if (kind === "issuer") state.callbackIssuer = `${state.base}/wrong`;
    if (kind === "missing issuer") state.callbackIssuer = null;
    const { session, catchers } = createSession(state);
    const close = vi.spyOn(catchers, "close");
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(state.grants).toHaveLength(0);
    expect(close).toHaveBeenCalled();
  });

  it("deduplicates concurrent authentication and never attaches credentials to another resource", async () => {
    const state = await fixture();
    const { session, openAuthorizationUrl } = createSession(state);
    await Promise.all([session.authenticate(), session.authenticate()]);
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(1);
    await expect(session.fetch(`${state.base}/other`)).rejects.toThrow("MCP authentication failed");
    expect(state.bearer).toHaveLength(0);
    expect(JSON.stringify({ status: session.getStatus() })).not.toContain("secret");
  });

  it("reuses only credentials bound to the unchanged configuration", async () => {
    const state = await fixture();
    const { session, store } = createSession(state);
    await session.authenticate();
    const reused = createSession(state, { store }).session;
    await reused.fetch(state.resource);
    expect(reused.getStatus()).toBe("authenticated");
    const changed = createSession(state, { store, config: { oauth: { scopes: ["different"] } } }).session;
    expect(changed.getStatus()).toBe("required");
    await expect(changed.fetch(state.resource)).rejects.toThrow("MCP authentication required");
    expect(state.bearer.at(-1)).toBeUndefined();
  });

  it("rejects stored credentials whose resource does not contain the configured endpoint", async () => {
    const state = await fixture();
    const { session, store } = createSession(state);
    await session.authenticate();
    for (const [key, value] of store) {
      const record = JSON.parse(value) as Record<string, unknown>;
      store.set(key, JSON.stringify({ ...record, resource: `${state.base}/other` }));
    }
    const restored = createSession(state, { store }).session;
    expect(restored.getStatus()).toBe("required");
    await expect(restored.fetch(state.resource)).rejects.toThrow("MCP authentication required");
    expect(state.bearer).toEqual([undefined]);
  });

  it("cancels a pending browser flow and deletes saved credentials on removal", async () => {
    const state = await fixture();
    const { session, store, catchers, openAuthorizationUrl } = createSession(state);
    const closeAll = vi.spyOn(catchers, "closeAllFor");
    openAuthorizationUrl.mockImplementation(async () => { await session.clear(); });
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(store.size).toBe(0);
    expect(closeAll).toHaveBeenCalled();
    expect(session.getStatus()).toBe("required");
    expect(state.grants).toHaveLength(0);
  });

  it("settles authentication on disposal even when the browser opener never settles", async () => {
    const state = await fixture();
    const { session, openAuthorizationUrl } = createSession(state);
    openAuthorizationUrl.mockImplementation(() => new Promise<void>(() => {}));
    const login = session.authenticate();
    await vi.waitFor(() => expect(openAuthorizationUrl).toHaveBeenCalledTimes(1));
    session.dispose();
    await expect(login).rejects.toThrow(/^MCP authentication failed$/u);
    expect(session.getStatus()).toBe("required");
    expect(state.grants).toHaveLength(0);
  });

  it("rejects insecure non-loopback endpoints even when private networks are enabled", () => {
    expect(() => createSession({ resource: "http://192.168.1.10/mcp" } as Fixture)).toThrow("MCP authentication failed");
  });

  it.each(["client-id-metadata-document", "preregistration", "manual"] as const)("rejects unsupported %s registration before network activity", async (clientRegistration) => {
    const state = await fixture();
    expect(() => createSession(state, { config: { oauth: { clientRegistration } } })).toThrow(/^MCP authentication failed$/u);
    expect(state.discoveryVersions).toHaveLength(0);
    expect(state.authorizations).toHaveLength(0);
    expect(state.registrations).toHaveLength(0);
  });

  it("requires protected resource metadata without falling back to the resource as issuer", async () => {
    const state = await fixture();
    state.resourceMetadataAvailable = false;
    const { session, openAuthorizationUrl } = createSession(state);
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(state.registrations).toHaveLength(0);
    expect(openAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("rejects a configured resource different from discovered metadata before registration", async () => {
    const state = await fixture();
    const { session } = createSession(state, { config: { oauth: { resource: `${state.base}/other` } } });
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(state.registrations).toHaveLength(0);
  });

  it("does not follow token redirects or leak token endpoint errors", async () => {
    const state = await fixture();
    state.tokenRedirect = true;
    const { session, networkFetch } = createSession(state);
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(vi.mocked(networkFetch).mock.calls.some(([url]) => String(url).includes("untrusted"))).toBe(false);
    expect(session.getStatus()).toBe("error");
  });

  it("bounds token response bodies before parsing", async () => {
    const state = await fixture();
    state.tokenResponseBody = "credential".repeat(150000);
    const { session } = createSession(state);
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(session.getStatus()).toBe("error");
  });

  it("sanitizes resource error bodies that echo a credential", async () => {
    const state = await fixture();
    const { session } = createSession(state);
    await session.authenticate();
    state.resourceFailure = 403;
    const response = await session.fetch(state.resource);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("MCP request failed");
  });

  it("preserves issuer-response requirements when discovery parsing strips extension fields", async () => {
    const state = await fixture();
    state.oidc = true;
    state.callbackIssuer = null;
    const { session } = createSession(state);
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(state.authorizations).toHaveLength(1);
    expect(state.grants).toHaveLength(0);
  });

  it.each(["server error", "connection failure"])("preserves refresh credentials after a transient %s", async (failure) => {
    const state = await fixture();
    state.expiresIn = 0;
    const { session, store } = createSession(state);
    await session.authenticate();
    const saved = [...store.values()][0];
    if (failure === "server error") state.refreshFailure = 503;
    else state.refreshDropConnection = true;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication failed$/u);
    expect(session.getStatus()).toBe("error");
    expect([...store.values()][0]).toBe(saved);
  });

  it.each(["success", "revoked"])("keeps a new interactive grant when an older refresh settles with %s", async (outcome) => {
    const state = await fixture();
    state.expiresIn = 0;
    const { session, store } = createSession(state);
    await session.authenticate();
    let releaseRefresh: () => void = () => {};
    let notifyStarted: () => void = () => {};
    state.refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    state.onRefreshStarted = notifyStarted;
    const resourceRequest = session.fetch(state.resource);
    await started;
    state.expiresIn = 3600;
    await session.authenticate();
    expect([...store.values()][0]).toContain("access-secret-3");
    state.refreshRevoked = outcome === "revoked";
    releaseRefresh();
    expect((await resourceRequest).status).toBe(200);
    expect(session.getStatus()).toBe("authenticated");
    expect([...store.values()][0]).toContain("refresh-secret-3");
    expect([...store.values()][0]).not.toContain("refresh-secret-2");
    expect(state.bearer.at(-1)).toBe("Bearer access-secret-3");
  });

  it("requires new registration after issuer rotation without sending old refresh credentials to the new issuer", async () => {
    const resourceServer = await fixture();
    resourceServer.expiresIn = 0;
    const newIssuer = await fixture();
    newIssuer.resource = resourceServer.resource;
    const { session } = createSession(resourceServer);
    await session.authenticate();
    resourceServer.authorizationServer = newIssuer.base;
    await expect(session.fetch(resourceServer.resource)).rejects.toThrow(/^MCP authentication required$/u);
    expect(newIssuer.grants).toHaveLength(0);
    await session.authenticate();
    expect(newIssuer.registrations).toHaveLength(1);
    expect(newIssuer.authorizations).toHaveLength(1);
    expect(newIssuer.grants.map((grant) => grant.get("grant_type"))).toEqual(["authorization_code"]);
    expect(newIssuer.grants[0].get("refresh_token")).toBeNull();
    expect(session.getStatus()).toBe("authenticated");
  });

  it("blocks authentication when encrypted storage cannot be read and permits a healthy retry", async () => {
    const state = await fixture();
    expect(() => createSession(state, { getSecret: () => { throw new Error("private-storage-diagnostic"); } })).toThrow(/^MCP authentication failed$/u);
    expect(state.discoveryVersions).toHaveLength(0);
    expect(state.registrations).toHaveLength(0);
    expect(state.authorizations).toHaveLength(0);
    const { session } = createSession(state);
    await session.authenticate();
    expect(session.getStatus()).toBe("authenticated");
  });

  it("deletes stored credentials without reading or decrypting them", async () => {
    const state = await fixture();
    const { session, store, secrets } = createSession(state);
    await session.authenticate();
    expect(store.size).toBe(1);
    const getSecret = vi.fn(() => { throw new Error("private-storage-diagnostic"); });
    await McpOAuthSession.clearStoredCredentials({
      id: "remote", transport: "http", url: state.resource, auth: "oauth", allowPrivateNetworks: true,
    }, { ...secrets, getSecret });
    expect(getSecret).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("preserves prior granted scopes when a new challenge requires additional scopes", async () => {
    const state = await fixture();
    state.tokenScope = "read tools";
    const { session } = createSession(state, { config: { oauth: { scopes: ["read", "tools"] } } });
    await session.authenticate();
    state.challengeScope = "write tools";
    state.rejectAccess = true;
    state.refreshRevoked = true;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    state.rejectAccess = false;
    await session.authenticate();
    expect(state.authorizations[1].searchParams.get("scope")?.split(" ")).toEqual(["write", "tools", "read"]);
  });
});
