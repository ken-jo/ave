import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { listenFetchLoopback } from "../../shared/fetch-loopback-listener.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthRedirectCatchers } from "../../main/auth-redirect-catcher.js";
import { MCP_CLIENT_METADATA_DOCUMENT_URL, McpOAuthSession, type McpOAuthSecrets } from "../mcp-oauth.js";
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
  endpointPath: string;
  declaredResource?: string;
  requiredScope?: string;
  deniedScopes: string[];
  clients: Map<string, string[]>;
  authorizedRedirects: string[];
  tokenScopes: Map<string, string>;
  cimd: boolean;
  tokenAuthMethods: string[];
  cimdFetches: string[];
  cimdDocument?: Record<string, unknown>;
  rejectMetadataDocument?: "callback" | "token";
  preregistered: Map<string, string[]>;
  registrationResponse?: Record<string, unknown>;
}

const PUBLISHED_CLIENT_DOCUMENT = join(__dirname, "..", "..", "..", "web", "public", "oauth", "mcp-client.json");

/** Client metadata binds the client id and registered redirect; loopback literals may vary only by port. */
function validateClientDocument(clientId: string, redirectUri: string, document: Record<string, unknown>): boolean {
  if (document.client_id !== clientId || typeof document.client_name !== "string" ||
    !Array.isArray(document.redirect_uris) || document.redirect_uris.length === 0) return false;
  return redirectMatches(document.redirect_uris, redirectUri);
}

/** Exact redirect matching, except that a loopback IP literal ignores the port (RFC 8252 §7.3). */
function redirectMatches(registered: unknown[], redirectUri: string): boolean {
  const requested = new URL(redirectUri);
  return registered.some((candidate) => {
    if (typeof candidate !== "string") return false;
    const listed = new URL(candidate);
    const loopbackIp = listed.protocol === "http:" && (listed.hostname === "127.0.0.1" || listed.hostname === "[::1]");
    if (!loopbackIp) return candidate === redirectUri;
    return requested.protocol === listed.protocol && requested.hostname === listed.hostname &&
      requested.pathname === listed.pathname && requested.search === listed.search;
  });
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
    endpointPath: "/mcp", deniedScopes: [], clients: new Map(), authorizedRedirects: [], tokenScopes: new Map(),
    cimd: false, tokenAuthMethods: ["none"], cimdFetches: [], preregistered: new Map(),
  } as unknown as Fixture;
  let lastAuthorizedScope = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", state.base);
    const json = (body: unknown, status = 200): void => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
    };
    if (url.pathname === state.endpointPath) {
      state.bearer.push(request.headers.authorization);
      if (state.resourceFailure) { json({ error: "access-secret-1" }, state.resourceFailure); return; }
      const bearer = request.headers.authorization?.replace(/^Bearer /u, "");
      if (bearer && !state.rejectAccess && state.requiredScope &&
        !(state.tokenScopes.get(bearer) ?? "").split(" ").includes(state.requiredScope)) {
        response.writeHead(403, { "www-authenticate": `Bearer error="insufficient_scope", scope="${state.requiredScope}", resource_metadata="${state.base}${state.challengePath}"` });
        response.end("upstream credential-bearing diagnostic"); return;
      }
      if (state.allowAnonymous || (request.headers.authorization && !state.rejectAccess)) { json({ ok: true }); return; }
      response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${state.base}${state.challengePath}", scope="${state.challengeScope}"` });
      response.end("upstream credential-bearing diagnostic"); return;
    }
    const wellKnownResource = state.endpointPath === "/" ? "/.well-known/oauth-protected-resource" : `/.well-known/oauth-protected-resource${state.endpointPath}`;
    if (url.pathname === "/metadata" || url.pathname === wellKnownResource) {
      state.discoveryVersions.push(request.headers["mcp-protocol-version"] as string | undefined);
      if (!state.resourceMetadataAvailable || (state.wellKnownMetadataUnavailable && url.pathname.startsWith("/.well-known/"))) { json({}, 404); return; }
      if (state.redirectMetadata) { response.writeHead(302, { location: `${state.base}/untrusted` }); response.end(); return; }
      json({ resource: state.declaredResource ?? state.resource, authorization_servers: [state.authorizationServer ?? state.base], scopes_supported: ["tools"] }); return;
    }
    if (state.oidc && url.pathname === "/.well-known/oauth-authorization-server") { json({}, 404); return; }
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      state.discoveryVersions.push(request.headers["mcp-protocol-version"] as string | undefined);
      json({ issuer: state.issuer, authorization_endpoint: `${state.base}/authorize`, token_endpoint: `${state.base}/token`,
        registration_endpoint: state.dcr ? `${state.base}/register` : undefined, response_types_supported: ["code"],
        code_challenge_methods_supported: state.methods, token_endpoint_auth_methods_supported: state.tokenAuthMethods,
        ...(state.cimd ? { client_id_metadata_document_supported: true } : {}),
        authorization_response_iss_parameter_supported: true, jwks_uri: `${state.base}/jwks`, subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"] }); return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (url.pathname === "/register") {
      const registration = JSON.parse(body) as Record<string, unknown>;
      state.registrations.push(registration);
      const clientId = `native-client-${state.registrations.length}`;
      state.clients.set(clientId, registration.redirect_uris as string[]);
      json({ ...registration, client_id: clientId, token_endpoint_auth_method: "none", ...state.registrationResponse }, 201); return;
    }
    if (url.pathname === "/authorize") {
      state.authorizations.push(url);
      const requestedClient = url.searchParams.get("client_id") ?? "";
      if (state.cimd && requestedClient.startsWith("https://")) {
        state.cimdFetches.push(requestedClient);
        const document = state.cimdDocument ?? (requestedClient === MCP_CLIENT_METADATA_DOCUMENT_URL
          ? JSON.parse(readFileSync(PUBLISHED_CLIENT_DOCUMENT, "utf8")) as Record<string, unknown> : undefined);
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (!document || !validateClientDocument(requestedClient, redirectUri, document)) { json({ error: "invalid_client" }, 400); return; }
        state.clients.set(requestedClient, [redirectUri]);
        if (state.rejectMetadataDocument === "callback") {
          const refused = new URL(redirectUri);
          refused.searchParams.set("error", "invalid_client");
          refused.searchParams.set("state", url.searchParams.get("state") ?? "");
          // RFC 9207: the issuer accompanies error responses too.
          if (state.callbackIssuer !== null) refused.searchParams.set("iss", state.callbackIssuer ?? state.base);
          response.writeHead(302, { location: refused.href }); response.end(); return;
        }
      }
      const preregistered = state.preregistered.get(requestedClient);
      if (preregistered) {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (!redirectMatches(preregistered, redirectUri)) { json({ error: "invalid_request" }, 400); return; }
        state.clients.set(requestedClient, [redirectUri]);
      }
      const registered = state.clients.get(requestedClient);
      if (!registered?.includes(url.searchParams.get("redirect_uri") ?? "")) { json({ error: "invalid_request" }, 400); return; }
      state.authorizedRedirects.push(url.searchParams.get("redirect_uri") ?? "");
      lastAuthorizedScope = (url.searchParams.get("scope") ?? "").split(" ").filter((scope) => !state.deniedScopes.includes(scope)).join(" ");
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
      if (grant.get("resource") !== (state.declaredResource ?? state.resource)) { json({ error: "invalid_target" }, 400); return; }
      if (grant.get("grant_type") === "refresh_token" && state.refreshRevoked) {
        json({ error: "invalid_grant", error_description: "secret-refresh-credential" }, 400); return;
      }
      if (!state.clients.has(grant.get("client_id") ?? "") ||
        (state.rejectMetadataDocument === "token" && grant.get("client_id")?.startsWith("https://"))) {
        json({ error: "invalid_client" }, 401); return;
      }
      if (grant.get("grant_type") === "authorization_code") {
        const challenge = createHash("sha256").update(grant.get("code_verifier") ?? "").digest("base64url");
        if (!state.pkce.includes(challenge)) { json({ error: "invalid_grant" }, 400); return; }
        if (grant.get("redirect_uri") !== state.authorizedRedirects.at(-1)) { json({ error: "invalid_grant" }, 400); return; }
      }
      const refreshedIndex = grant.get("refresh_token")?.replace(/^refresh-secret-/u, "");
      const previousScope = state.tokenScopes.get(`access-secret-${refreshedIndex}`) ?? "";
      state.tokenScopes.set(`access-secret-${tokenIndex}`, grant.get("grant_type") === "authorization_code" ? lastAuthorizedScope : previousScope);
      json({ access_token: `access-secret-${tokenIndex}`, refresh_token: `refresh-secret-${tokenIndex}`,
        token_type: "Bearer", expires_in: state.expiresIn, scope: state.tokenScope }); return;
    }
    json({ error: "not_found" }, 404);
  });
  const port = await listenFetchLoopback(server);
  state.server = server;
  state.base = `http://127.0.0.1:${port}`;
  state.issuer = state.base;
  state.resource = `${state.base}/mcp`;
  servers.push(server);
  return state;
}

function createSession(state: Fixture, options: { store?: Map<string, string>; config?: Partial<McpHttpServerConfig>; getSecret?: McpOAuthSecrets["getSecret"]; canStoreEncrypted?: McpOAuthSecrets["canStoreEncrypted"] } = {}) {
  const store = options.store ?? new Map<string, string>();
  const secrets: McpOAuthSecrets = {
    getSecret: options.getSecret ?? ((key) => store.get(key) ?? null),
    setSecret: async (key, value) => { store.set(key, value); },
    deleteSecret: async (key) => { store.delete(key); },
    canStoreEncrypted: options.canStoreEncrypted ?? (() => true),
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
    // Registration and resource mismatches are distinct outcomes; other failures remain generic.
    await expect(session.authenticate()).rejects.toThrow(kind === "registration"
      ? /^MCP client registration mode is not supported$/u
      : kind === "resource" ? /^MCP authorization metadata names a different resource$/u : /^MCP authentication failed$/u);
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

  it.each(["preregistration", "manual"] as const)("rejects unsupported %s registration before network activity", async (clientRegistration) => {
    const state = await fixture();
    const { session, openAuthorizationUrl } = createSession(state, { config: { oauth: { clientRegistration } } });
    expect(session.getStatus()).toBe("error");
    expect(session.getBlockedCode()).toBe("mcp-auth-registration-unsupported");
    await expect(session.authenticate()).rejects.toMatchObject({ code: "mcp-auth-registration-unsupported" });
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication failed$/u);
    expect(openAuthorizationUrl).not.toHaveBeenCalled();
    expect(state.bearer).toHaveLength(0);
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
    await expect(session.authenticate()).rejects.toMatchObject({ code: "mcp-auth-resource-mismatch" });
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

  it("blocks authentication with a distinct code when encrypted storage cannot be read and permits a healthy retry", async () => {
    const state = await fixture();
    let readable = false;
    const store = new Map<string, string>();
    const { session } = createSession(state, { store, getSecret: (key) => {
      if (!readable) throw new Error("private-storage-diagnostic");
      return store.get(key) ?? null;
    } });
    expect(session.getStatus()).toBe("error");
    const failure = await session.authenticate().catch((error: unknown) => error as Error & { code?: string });
    expect(failure).toMatchObject({ code: "mcp-auth-storage-unreadable", message: "MCP authorization storage cannot be read" });
    expect(String(failure)).not.toContain("private-storage-diagnostic");
    expect(state.discoveryVersions).toHaveLength(0);
    expect(state.registrations).toHaveLength(0);
    expect(state.authorizations).toHaveLength(0);
    readable = true;
    await session.authenticate();
    expect(session.getStatus()).toBe("authenticated");
  });

  it("refuses before discovery, the redirect listener or registration when encrypted storage is unavailable", async () => {
    const state = await fixture();
    const { session, catchers, openAuthorizationUrl } = createSession(state, { canStoreEncrypted: () => false });
    const open = vi.spyOn(catchers, "open");
    await expect(session.authenticate()).rejects.toMatchObject({ code: "mcp-auth-storage-unavailable" });
    expect(open).not.toHaveBeenCalled();
    expect(openAuthorizationUrl).not.toHaveBeenCalled();
    expect(state.discoveryVersions).toHaveLength(0);
    expect(state.registrations).toHaveLength(0);
    expect(session.getStatus()).toBe("error");
  });

  it("registers again for a new loopback port after revocation and completes a second strict flow", async () => {
    const state = await fixture();
    const { session, openAuthorizationUrl } = createSession(state);
    await session.authenticate();
    state.rejectAccess = true;
    state.refreshRevoked = true;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    expect(session.getStatus()).toBe("required");
    state.rejectAccess = false;
    state.refreshRevoked = false;
    await session.authenticate();
    expect(session.getStatus()).toBe("authenticated");
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(2);
    expect(state.registrations).toHaveLength(2);
    const [first, second] = state.authorizations.map((url) => url.searchParams.get("redirect_uri"));
    expect(second).not.toBe(first);
    expect(state.authorizations[1].searchParams.get("client_id")).toBe("native-client-2");
    expect(state.grants.at(-1)?.get("client_id")).toBe("native-client-2");
    expect((await session.fetch(state.resource)).ok).toBe(true);
  });

  it("reuses a registered client only when it lists the live redirect URI", async () => {
    const state = await fixture();
    const { session, catchers } = createSession(state);
    await session.authenticate();
    const registeredRedirect = state.authorizations[0].searchParams.get("redirect_uri")!;
    vi.spyOn(catchers, "open").mockImplementationOnce(async function (this: typeof catchers, ownerKey: string) {
      const opened = await (Object.getPrototypeOf(catchers) as typeof catchers).open.call(catchers, ownerKey);
      return { ...opened, redirectUri: registeredRedirect };
    });
    state.rejectAccess = true;
    state.refreshRevoked = true;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    state.rejectAccess = false;
    state.refreshRevoked = false;
    await session.authenticate().catch(() => undefined);
    expect(state.registrations).toHaveLength(1);
    expect(state.authorizations[1].searchParams.get("client_id")).toBe("native-client-1");
  });

  it("uses the published client metadata document when the server advertises support, without registering", async () => {
    const state = await fixture();
    state.cimd = true;
    const { session } = createSession(state);
    await session.authenticate();
    expect(state.registrations).toHaveLength(0);
    expect(state.cimdFetches).toEqual([MCP_CLIENT_METADATA_DOCUMENT_URL]);
    expect(state.authorizations[0].searchParams.get("client_id")).toBe(MCP_CLIENT_METADATA_DOCUMENT_URL);
    expect(state.authorizations[0].searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(state.grants[0].get("client_id")).toBe(MCP_CLIENT_METADATA_DOCUMENT_URL);
    expect((await session.fetch(state.resource)).ok).toBe(true);
    state.rejectAccess = true;
    state.refreshRevoked = true;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    state.rejectAccess = false;
    state.refreshRevoked = false;
    await session.authenticate();
    const [first, second] = state.authorizations.map((url) => url.searchParams.get("redirect_uri"));
    expect(second).not.toBe(first);
    expect(state.registrations).toHaveLength(0);
    expect(session.getStatus()).toBe("authenticated");
  });

  it("publishes a client_id document that matches the app's client_id", () => {
    const document = JSON.parse(readFileSync(PUBLISHED_CLIENT_DOCUMENT, "utf8")) as Record<string, unknown>;
    expect(document).toMatchObject({ client_id: MCP_CLIENT_METADATA_DOCUMENT_URL, client_name: "Ave",
      redirect_uris: ["http://127.0.0.1"], token_endpoint_auth_method: "none" });
    expect(MCP_CLIENT_METADATA_DOCUMENT_URL).toBe("https://ave.agent-connector.ai/oauth/mcp-client.json");
  });

  it.each([
    ["a different client_id", { client_id: "https://elsewhere.example.test/client.json" }],
    ["a localhost redirect", { redirect_uris: ["http://localhost"] }],
    ["a redirect with another path", { redirect_uris: ["http://127.0.0.1/callback"] }],
  ])("is rejected by a strict server when the document has %s", async (_label, change) => {
    const state = await fixture();
    state.cimd = true;
    state.cimdDocument = { ...JSON.parse(readFileSync(PUBLISHED_CLIENT_DOCUMENT, "utf8")) as Record<string, unknown>, ...change };
    const { session } = createSession(state);
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(state.grants).toHaveLength(0);
  });

  it("registers dynamically when the server advertises documents but not public clients", async () => {
    const state = await fixture();
    state.cimd = true;
    state.tokenAuthMethods = ["client_secret_basic"];
    const { session } = createSession(state);
    await session.authenticate().catch(() => undefined);
    expect(state.cimdFetches).toHaveLength(0);
    expect(state.registrations).toHaveLength(1);
  });

  it("accepts a public client the registration issued when the token endpoint lists only secret methods", async () => {
    const state = await fixture();
    state.tokenAuthMethods = ["client_secret_basic", "client_secret_post"];
    const { session } = createSession(state);
    await session.authenticate();
    expect(session.getStatus()).toBe("authenticated");
    expect(state.registrations).toHaveLength(1);
    expect(state.grants[0].get("client_id")).toBe("native-client-1");
    expect(state.grants[0].has("client_secret")).toBe(false);
  });

  it("refuses a registered secret method the token endpoint does not advertise", async () => {
    const state = await fixture();
    state.tokenAuthMethods = ["client_secret_basic"];
    state.registrationResponse = { token_endpoint_auth_method: "client_secret_post", client_secret: "registered-secret-1" };
    const { session } = createSession(state);
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(state.registrations).toHaveLength(1);
    expect(state.grants).toHaveLength(0);
  });

  it("fails clearly when the configuration requires a metadata document the server does not support", async () => {
    const state = await fixture();
    const { session, openAuthorizationUrl } = createSession(state, { config: { oauth: { clientRegistration: "client-id-metadata-document" } } });
    await expect(session.authenticate()).rejects.toMatchObject({ code: "mcp-auth-registration-unsupported" });
    expect(state.registrations).toHaveLength(0);
    expect(openAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("uses a pre-registered client before a metadata document or registration, on every new port", async () => {
    const state = await fixture();
    state.cimd = true;
    state.preregistered.set("ave-operator-client", ["http://127.0.0.1/"]);
    const { session } = createSession(state, { config: { oauth: { clientId: "ave-operator-client" } } });
    await session.authenticate();
    expect(state.registrations).toHaveLength(0);
    expect(state.cimdFetches).toHaveLength(0);
    expect(state.authorizations[0].searchParams.get("client_id")).toBe("ave-operator-client");
    expect(state.grants[0].get("client_id")).toBe("ave-operator-client");
    expect((await session.fetch(state.resource)).ok).toBe(true);
    state.rejectAccess = true;
    state.refreshRevoked = true;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    state.rejectAccess = false;
    state.refreshRevoked = false;
    await session.authenticate();
    const [first, second] = state.authorizations.map((url) => url.searchParams.get("redirect_uri"));
    expect(second).not.toBe(first);
    expect(state.authorizations[1].searchParams.get("client_id")).toBe("ave-operator-client");
    expect(state.registrations).toHaveLength(0);
    expect(session.getStatus()).toBe("authenticated");
  });

  it("restores a pre-registered client after restart without registering", async () => {
    const state = await fixture();
    state.preregistered.set("ave-operator-client", ["http://127.0.0.1/"]);
    const config = { oauth: { clientId: "ave-operator-client" } };
    const first = createSession(state, { config });
    await first.session.authenticate();
    first.session.dispose();
    const restored = createSession(state, { store: first.store, config });
    expect(restored.session.getStatus()).toBe("authenticated");
    expect((await restored.session.fetch(state.resource)).ok).toBe(true);
    expect(state.registrations).toHaveLength(0);
  });

  it("is rejected by a strict server when the pre-registered client lacks the loopback redirect", async () => {
    const state = await fixture();
    state.preregistered.set("ave-operator-client", ["http://localhost/"]);
    const { session } = createSession(state, { config: { oauth: { clientId: "ave-operator-client" } } });
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(state.grants).toHaveLength(0);
    expect(state.registrations).toHaveLength(0);
  });

  it.each([
    ["an empty client ID", { clientId: "" }],
    ["a client ID with spaces", { clientId: "ave operator" }],
    ["a client ID that is too long", { clientId: "a".repeat(257) }],
    ["a client ID with dynamic registration", { clientId: "ave-operator-client", clientRegistration: "dynamic" as const }],
    ["a client ID with a metadata document", { clientId: "ave-operator-client", clientRegistration: "client-id-metadata-document" as const }],
  ])("fails clearly before any browser or registration step for %s", async (_label, oauth) => {
    const state = await fixture();
    const { session, openAuthorizationUrl, catchers } = createSession(state, { config: { oauth } });
    const open = vi.spyOn(catchers, "open");
    expect(session.getStatus()).toBe("error");
    expect(session.getBlockedCode()).toBe("mcp-auth-registration-unsupported");
    await expect(session.authenticate()).rejects.toMatchObject({ code: "mcp-auth-registration-unsupported" });
    expect(open).not.toHaveBeenCalled();
    expect(openAuthorizationUrl).not.toHaveBeenCalled();
    expect(state.registrations).toHaveLength(0);
  });

  it.each(["preregistration", "manual"] as const)("accepts the %s registration mode with a client ID", async (clientRegistration) => {
    const state = await fixture();
    state.preregistered.set("ave-operator-client", ["http://127.0.0.1/"]);
    const { session } = createSession(state, { config: { oauth: { clientId: "ave-operator-client", clientRegistration } } });
    await session.authenticate();
    expect(state.registrations).toHaveLength(0);
    expect(session.getStatus()).toBe("authenticated");
  });

  it("marks a 403 insufficient_scope as step-up without opening the browser, then requests the scope union", async () => {
    const state = await fixture();
    const { session, openAuthorizationUrl } = createSession(state);
    await session.authenticate();
    expect(state.authorizations[0].searchParams.get("scope")).toBe("tools");
    state.requiredScope = "write";
    const denied = await session.fetch(state.resource);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("MCP request failed");
    expect(session.getStatus()).toBe("insufficient_scope");
    expect((await session.fetch(state.resource)).status).toBe(403);
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(1);
    await session.authenticate();
    expect(state.authorizations[1].searchParams.get("scope")?.split(" ").sort()).toEqual(["tools", "write"]);
    expect(session.getStatus()).toBe("authenticated");
    expect((await session.fetch(state.resource)).ok).toBe(true);
  });

  it("keeps the working grant when a step-up attempt fails", async () => {
    const state = await fixture();
    const { session } = createSession(state);
    await session.authenticate();
    state.requiredScope = "write";
    await session.fetch(state.resource);
    expect(session.getStatus()).toBe("insufficient_scope");
    state.callbackState = "wrong-state";
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(session.getStatus()).toBe("insufficient_scope");
    state.requiredScope = undefined;
    expect((await session.fetch(state.resource)).ok).toBe(true);
  });

  it("validates a step-up token response before it can replace the working grant", async () => {
    const state = await fixture();
    const { session, store } = createSession(state);
    await session.authenticate();
    const saved = [...store.values()][0];
    state.requiredScope = "write";
    await session.fetch(state.resource);
    expect(session.getStatus()).toBe("insufficient_scope");
    state.tokenResponseBody = JSON.stringify({ access_token: "access-secret-mac", token_type: "MAC", expires_in: 3600 });
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    state.tokenResponseBody = undefined;
    expect(session.getStatus()).toBe("insufficient_scope");
    expect([...store.values()][0]).toBe(saved);
    state.requiredScope = undefined;
    expect((await session.fetch(state.resource)).ok).toBe(true);
    expect(state.bearer.at(-1)).toBe("Bearer access-secret-1");
  });

  it.each(["token", "callback"] as const)("registers once and retries when the server refuses the metadata document at the %s", async (where) => {
    const state = await fixture();
    state.cimd = true;
    state.rejectMetadataDocument = where;
    const { session, openAuthorizationUrl } = createSession(state);
    await session.authenticate();
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(2);
    expect(state.authorizations.map((url) => url.searchParams.get("client_id"))).toEqual([MCP_CLIENT_METADATA_DOCUMENT_URL, "native-client-1"]);
    expect(state.registrations).toHaveLength(1);
    expect(session.getStatus()).toBe("authenticated");
    expect((await session.fetch(state.resource)).ok).toBe(true);
    state.rejectAccess = true;
    state.refreshRevoked = true;
    await expect(session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    state.rejectAccess = false;
    state.refreshRevoked = false;
    await session.authenticate();
    expect(state.authorizations.at(-1)?.searchParams.get("client_id")).toMatch(/^native-client-/u);
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a different issuer", "wrong"],
    ["no issuer although the server advertises one", "missing"],
  ] as const)("does not act on a client refusal that carries %s", async (_label, issuer) => {
    const state = await fixture();
    state.cimd = true;
    state.rejectMetadataDocument = "callback";
    state.callbackIssuer = issuer === "wrong" ? `${state.base}/wrong` : null;
    const { session, openAuthorizationUrl } = createSession(state);
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(1);
    expect(state.registrations).toHaveLength(0);
    expect(state.grants).toHaveLength(0);
  });

  it("stays strict when the configuration requires the metadata document and the server refuses it", async () => {
    const state = await fixture();
    state.cimd = true;
    state.rejectMetadataDocument = "token";
    const { session, openAuthorizationUrl } = createSession(state, { config: { oauth: { clientRegistration: "client-id-metadata-document" } } });
    await expect(session.authenticate()).rejects.toThrow(/^MCP authentication failed$/u);
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(1);
    expect(state.registrations).toHaveLength(0);
    expect(session.getStatus()).toBe("error");
  });

  it("hands a same-key successor the refresh token its predecessor rotated in flight", async () => {
    const state = await fixture();
    state.expiresIn = 0;
    const first = createSession(state);
    await first.session.authenticate();
    state.expiresIn = 3600;
    let release!: () => void;
    state.refreshGate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { started = resolve; });
    state.onRefreshStarted = started;
    const inFlight = first.session.fetch(state.resource).catch(() => undefined);
    await refreshStarted;
    const successor = new McpOAuthSession({ id: "remote", transport: "http", url: state.resource, auth: "oauth", allowPrivateNetworks: true },
      { secrets: first.secrets, redirectCatchers: first.catchers, openAuthorizationUrl: first.openAuthorizationUrl, networkFetch: first.networkFetch },
      { after: first.session.handOff(), initialStatus: first.session.getStatus() });
    sessions.push(successor);
    expect(successor.getStatus()).toBe("authenticated");
    release();
    await inFlight;
    expect((await successor.fetch(state.resource)).ok).toBe(true);
    expect(state.grants.map((grant) => grant.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    expect(state.bearer.at(-1)).toBe("Bearer access-secret-2");
    expect(JSON.parse([...first.store.values()][0]).tokens.refresh_token).toBe("refresh-secret-2");
  });

  it("stops offering step-up for a scope after the retry limit", async () => {
    const state = await fixture();
    state.deniedScopes = ["admin"];
    const { session, openAuthorizationUrl } = createSession(state);
    await session.authenticate();
    state.requiredScope = "admin";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await session.fetch(state.resource)).status).toBe(403);
      expect(session.getStatus()).toBe("insufficient_scope");
      await session.authenticate();
    }
    expect((await session.fetch(state.resource)).status).toBe(403);
    expect(session.getStatus()).toBe("authenticated");
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(3);
  });

  it("sends an origin-only resource without a trailing slash", async () => {
    const state = await fixture();
    state.endpointPath = "/";
    state.resource = state.base;
    const { session } = createSession(state, { config: { url: state.base } });
    await expect(session.fetch(`${state.base}/`)).rejects.toThrow(/^MCP authentication required$/u);
    await session.authenticate();
    expect(state.authorizations[0].searchParams.get("resource")).toBe(state.base);
    expect(state.grants[0].get("resource")).toBe(state.base);
    expect(state.base.endsWith("/")).toBe(false);
    expect((await session.fetch(`${state.base}/`)).ok).toBe(true);
  });

  it("refreshes an origin-only resource without a trailing slash", async () => {
    const state = await fixture();
    state.endpointPath = "/";
    state.resource = state.base;
    state.expiresIn = 0;
    const { session } = createSession(state, { config: { url: state.base } });
    await expect(session.fetch(`${state.base}/`)).rejects.toThrow(/^MCP authentication required$/u);
    await session.authenticate();
    state.expiresIn = 3600;
    expect((await session.fetch(`${state.base}/`)).ok).toBe(true);
    expect(state.grants.map((grant) => grant.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    expect(state.grants[1].get("resource")).toBe(state.base);
  });

  it("requires metadata named by a challenge to describe exactly the challenged resource", async () => {
    const state = await fixture();
    state.declaredResource = state.base;
    const challenged = createSession(state);
    await expect(challenged.session.fetch(state.resource)).rejects.toThrow(/^MCP authentication required$/u);
    await expect(challenged.session.authenticate()).rejects.toMatchObject({ code: "mcp-auth-resource-mismatch",
      message: "MCP authorization metadata names a different resource" });
    expect(challenged.session.getStatus()).toBe("error");
    expect(state.registrations).toHaveLength(0);
    const discovered = createSession(state);
    await discovered.session.authenticate();
    expect(state.authorizations[0].searchParams.get("resource")).toBe(state.base);
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
