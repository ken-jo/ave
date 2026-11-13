import { createHash, createPublicKey, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenFetchLoopback } from "../../shared/fetch-loopback-listener.js";
import { AuthRedirectCatchers } from "../../main/auth-redirect-catcher.js";
import type { DeviceCodePresentation } from "../../auth/oauth-device-code.js";
import { McpOAuthSession } from "../mcp-oauth.js";
import type { McpOAuthConfig } from "../types.js";

const sessions: McpOAuthSession[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

function required(value: string | null | undefined): string {
  if (!value) throw new Error("Required fixture value is missing");
  return value;
}

interface Claims { htu: string; htm: string; ath?: string; nonce?: string; jti: string; iat: number }
async function fixture(options: { algorithms?: unknown; deviceEndpoint?: boolean; deviceOnly?: boolean;
  tokenType?: string; repeatedNonce?: boolean; invalidProof?: boolean; tokenExpiry?: number } = {}) {
  let origin = "";
  let boundKey: string | undefined;
  const proofs: Array<{ key: string; claims: Claims; path: string }> = [];
  const grants: URLSearchParams[] = [];
  const authorizations: URL[] = [];
  let devices = 0;
  let registrations = 0;
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(required(request.url), origin);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json({ resource: `${origin}/mcp`, authorization_servers: [origin] }); return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        json({ issuer: origin, ...(!options.deviceOnly ? { authorization_endpoint: `${origin}/authorize`,
          response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] } : {}),
          token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
          ...(options.deviceEndpoint !== false ? { device_authorization_endpoint: `${origin}/device` } : {}),
          ...(options.algorithms === undefined ? {} : { dpop_signing_alg_values_supported: options.algorithms }),
          token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true }); return;
      }
      if (url.pathname === "/authorize") {
        authorizations.push(url);
        const callback = new URL(required(url.searchParams.get("redirect_uri")));
        callback.searchParams.set("state", required(url.searchParams.get("state")));
        callback.searchParams.set("iss", origin);
        callback.searchParams.set("code", "fixture-code");
        response.writeHead(302, { location: callback.href }); response.end(); return;
      }
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      if (url.pathname === "/register") {
        registrations++;
        const registration = JSON.parse(raw) as Record<string, unknown>;
        expect(registration.grant_types).toContain("urn:ietf:params:oauth:grant-type:device_code");
        expect(registration.redirect_uris).toEqual([]);
        json({ ...registration, client_id: "registered-device-client" }, 201); return;
      }
      if (url.pathname === "/device") {
        devices++;
        expect(request.headers.dpop).toBeUndefined();
        const params = new URLSearchParams(raw);
        expect(params.get("client_id")).toMatch(/fixture-client|registered-device-client/u);
        expect(params.get("resource")).toBe(`${origin}/mcp`);
        json({ device_code: "fixture-device-secret", user_code: "SHOW-1234", verification_uri: `${origin}/verify`,
          verification_uri_complete: `${origin}/verify?user_code=SHOW-1234`, expires_in: 30, interval: 1 }); return;
      }
      if (url.pathname === "/token" || url.pathname === "/mcp") {
        let key: string | undefined;
        let claims: Claims | undefined;
        if (Array.isArray(options.algorithms) && options.algorithms.includes("ES256")) {
          const proof = request.headers.dpop;
          expect(typeof proof).toBe("string");
          const [headerPart, payloadPart, signaturePart] = (proof as string).split(".");
          const header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
          expect(header.typ).toBe("dpop+jwt"); expect(header.alg).toBe("ES256"); expect(header.jwk.d).toBeUndefined();
          expect(verify("sha256", Buffer.from(`${headerPart}.${payloadPart}`), {
            key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
          }, Buffer.from(signaturePart, "base64url"))).toBe(true);
          const { crv, kty, x, y } = header.jwk;
          key = createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url");
          claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString()) as Claims;
          expect(claims.htu).toBe(`${origin}${url.pathname}`); expect(claims.htm).toBe(request.method);
          expect(Math.abs(Date.now() / 1000 - claims.iat)).toBeLessThan(5);
          expect(proofs.some(proof => proof.claims.jti === claims?.jti)).toBe(false);
          proofs.push({ key, claims, path: url.pathname });
          if (options.invalidProof) { json({ error: "invalid_dpop_proof" }, 400); return; }
          const nonce = url.pathname === "/token" ? "token-server-nonce" : "resource-server-nonce";
          if (claims.nonce !== nonce || options.repeatedNonce) {
            json({ error: "use_dpop_nonce" }, url.pathname === "/token" ? 400 : 401,
              { "DPoP-Nonce": nonce, ...(url.pathname === "/mcp" ? { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"' } : {}) }); return;
          }
        }
        if (url.pathname === "/token") {
          const grant = new URLSearchParams(raw); grants.push(grant);
          expect(grant.get("resource")).toBe(`${origin}/mcp`);
          expect(claims?.ath).toBeUndefined();
          if (boundKey) expect(key).toBe(boundKey);
          if (key) boundKey = key;
          if (grant.get("grant_type") === "authorization_code" && key) {
            expect(authorizations.at(-1)?.searchParams.get("dpop_jkt")).toBe(key);
            expect(authorizations.at(-1)?.searchParams.get("code_challenge_method")).toBe("S256");
          }
          if (grant.get("grant_type") === "refresh_token") expect(grant.get("refresh_token")).toBe(`refresh-${grants.length - 1}`);
          json({ access_token: `access-${grants.length}`, refresh_token: `refresh-${grants.length}`,
            token_type: options.tokenType ?? (key ? "DPoP" : "Bearer"),
            expires_in: grants.length === 1 ? (options.tokenExpiry ?? 3600) : 3600 }); return;
        }
        expect(request.headers.authorization).toBe(`${key ? "DPoP" : "Bearer"} access-${grants.length}`);
        if (key) {
          expect(key).toBe(boundKey);
          expect(claims?.ath).toBe(createHash("sha256").update(`access-${grants.length}`).digest("base64url"));
        }
        json({ ok: true }); return;
      }
      json({}, 404);
    } catch (error) { failures.push(error); json({ error: "fixture_failure" }, 500); }
  });
  servers.push(server);
  origin = `http://127.0.0.1:${await listenFetchLoopback(server)}`;
  const store = new Map<string, string>();
  const prompt = vi.fn(async (shown: Parameters<DeviceCodePresentation["show"]>[0], _controller: AbortController) => {
    expect(shown.userCode).toBe("SHOW-1234"); expect(shown.verificationUri).toBe(`${origin}/verify`);
    return () => {};
  });
  function session(oauth: McpOAuthConfig, encrypted = true, human = true) {
    const catchers = new AuthRedirectCatchers();
    const networkFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch;
    const openAuthorizationUrl = vi.fn(async (url: string, login: import("../../main/oauth-login.js").OAuthLoginOptions) => {
      const response = await fetch(url, { redirect: "manual" });
      await fetch(required(response.headers.get("location")));
      await login.completion;
    });
    const value = new McpOAuthSession({ id: "proof-resource", transport: "http", auth: "oauth", url: `${origin}/mcp`,
      allowPrivateNetworks: true, oauth }, { networkFetch, redirectCatchers: catchers, openAuthorizationUrl,
      secrets: { getSecret: async key => store.get(key) ?? null, setSecret: async (key, raw) => { store.set(key, raw); },
        deleteSecret: async key => { store.delete(key); }, canStoreEncrypted: async () => encrypted },
      deviceCodePresentation: { available: () => human, show: prompt },
    });
    sessions.push(value);
    return { value, networkFetch, openAuthorizationUrl };
  }
  return { session, store, prompt, proofs, grants, authorizations, failures, origin,
    devices: () => devices, registrations: () => registrations };
}

const DEVICE_CONFIG = { grantType: "device-code", clientId: "fixture-client" } as const;
describe("device and proof authorization over local HTTP", () => {
  it("persists the credential key across restart, binds rotation and signs resource nonce retries", async () => {
    const as = await fixture({ algorithms: ["ES256"], deviceOnly: true, tokenExpiry: 0 });
    const first = as.session(DEVICE_CONFIG);
    await first.value.authenticate();
    expect(first.openAuthorizationUrl).not.toHaveBeenCalled(); expect(as.devices()).toBe(1);
    const savedKey = JSON.parse(required(as.store.get(first.value.credentialKey))).dpopKey;
    first.value.dispose();
    const restored = as.session(DEVICE_CONFIG);
    expect((await restored.value.fetch(`${as.origin}/mcp`, { method: "POST", body: "request" })).ok).toBe(true);
    expect(as.grants.map(grant => grant.get("grant_type"))).toEqual(["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]);
    expect(JSON.parse(required(as.store.get(restored.value.credentialKey))).dpopKey).toBe(savedKey);
    expect(new Set(as.proofs.map(proof => proof.key)).size).toBe(1);
    expect(as.proofs.filter(proof => proof.path === "/mcp").map(proof => proof.claims.nonce)).toEqual([undefined, "resource-server-nonce"]);
    expect(as.failures).toEqual([]);
  });

  it("keeps code plus PKCE the default and binds its authorization code to the proof key", async () => {
    const as = await fixture({ algorithms: ["ES256"] }); const { value } = as.session({ clientId: "fixture-client" });
    await value.authenticate(); expect((await value.fetch(`${as.origin}/mcp`)).ok).toBe(true);
    expect(as.devices()).toBe(0); expect(as.authorizations).toHaveLength(1); expect(as.failures).toEqual([]);
  });

  it("registers a device client with the selected grant and no invented redirect", async () => {
    const as = await fixture({ deviceOnly: true }); const { value } = as.session({ grantType: "device-code", clientRegistration: "dynamic" });
    await value.authenticate(); expect(as.registrations()).toBe(1); expect(as.failures).toEqual([]);
  });

  it("preserves bearer mode when the AS does not advertise proof support", async () => {
    const as = await fixture(); const { value } = as.session({ clientId: "fixture-client" });
    await value.authenticate(); expect((await value.fetch(`${as.origin}/mcp`)).ok).toBe(true);
    expect(as.proofs).toEqual([]); expect(as.failures).toEqual([]);
  });

  it.each([undefined, ["RS256"], []])("refuses required proof binding with unsupported metadata %j", async algorithms => {
    const as = await fixture({ algorithms }); const { value, openAuthorizationUrl } = as.session({ ...DEVICE_CONFIG, dpop: "required" });
    await expect(value.authenticate()).rejects.toMatchObject({ code: "mcp-auth-dpop-unsupported" });
    expect(as.devices()).toBe(0); expect(openAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("rejects a bearer response after negotiating proof binding", async () => {
    const as = await fixture({ algorithms: ["ES256"], tokenType: "Bearer" }); const { value } = as.session(DEVICE_CONFIG);
    await expect(value.authenticate()).rejects.toThrow(); expect(as.store.size).toBe(0); expect(as.failures).toEqual([]);
  });

  it.each(["headless", "unencrypted"] as const)("denies %s device login before any network activity", async mode => {
    const as = await fixture(); const { value, networkFetch } = as.session(DEVICE_CONFIG, mode !== "unencrypted", mode !== "headless");
    await expect(value.authenticate()).rejects.toMatchObject({ code: mode === "headless" ? "mcp-auth-device-headless" : "mcp-auth-storage-unavailable" });
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("backs off after a real transport timeout through the MCP network wrapper", async () => {
    const as = await fixture(); const { value, networkFetch } = as.session(DEVICE_CONFIG);
    let timedOut = false;
    const attempts: number[] = [];
    vi.mocked(networkFetch).mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/token") {
        attempts.push(Date.now());
        if (!timedOut) {
          timedOut = true;
          throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
        }
      }
      return fetch(input, init);
    });
    await value.authenticate();
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(2000);
    expect(as.failures).toEqual([]);
  });

  it("requires advertisement in addition to an explicit device opt-in", async () => {
    const as = await fixture({ deviceEndpoint: false }); const { value } = as.session(DEVICE_CONFIG);
    await expect(value.authenticate()).rejects.toMatchObject({ code: "mcp-auth-device-unsupported" });
    expect(as.devices()).toBe(0); expect(as.authorizations).toHaveLength(0);
  });

  it.each(["repeatedNonce", "invalidProof"] as const)("stops a terminal proof error %s without generic retries", async kind => {
    const as = await fixture({ algorithms: ["ES256"], [kind]: true }); const { value } = as.session(DEVICE_CONFIG);
    await expect(value.authenticate()).rejects.toThrow();
    expect(as.proofs).toHaveLength(kind === "repeatedNonce" ? 2 : 1); expect(as.store.size).toBe(0); expect(as.failures).toEqual([]);
  });
});
