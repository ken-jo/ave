import { describe, expect, it } from "vitest";
import { classifyChatGptPlanError } from "../../../shared/chatgpt-plan.js";
import { ChatGptPlanEgressError, createChatGptPlanFetch, isAllowedChatGptPlanRequest } from "../egress.js";
import {
  CHATGPT_PLAN_AUTHORIZE_URL,
  CHATGPT_PLAN_DISCOVERY_URL,
  CHATGPT_PLAN_JWKS_URL,
  CHATGPT_PLAN_MODELS_URL,
  CHATGPT_PLAN_RESPONSES_URL,
  CHATGPT_PLAN_REVOCATION_URL,
  CHATGPT_PLAN_TOKEN_URL,
} from "../endpoints.js";
import { parseChatGptPlanModels } from "../models.js";
import {
  buildAuthorizationUrl,
  ChatGptPlanOAuthError,
  createAuthorizationAttempt,
  exchangeAuthorizationCode,
  parseAuthorizationCallback,
  pkceChallengeFor,
  refreshAccessToken,
  revokeRefreshToken,
  verifyDiscoveryDocument,
} from "../oauth.js";

const HOST_ID = "urn:uuid:7d3c1f2e-8a4b-4c5d-9e6f-0a1b2c3d4e5f";
const REDIRECT = "http://127.0.0.1:1455/auth/callback";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchReturning(...responses: Response[]): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const TOKEN_BODY = {
  access_token: "at-1",
  refresh_token: "rt-1",
  id_token: "it-1",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  earliest_refresh_at: 1790035000,
};

describe("plan-usage authorization request", () => {
  it("derives an unpadded base64url SHA-256 challenge from a fresh verifier", async () => {
    const verifier = "verifier-with-43-or-more-unreserved-characters";
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    expect(pkceChallengeFor(verifier)).toBe(digest.toString("base64url"));
    expect(pkceChallengeFor(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const one = createAuthorizationAttempt();
    const two = createAuthorizationAttempt();
    expect(one.state).not.toBe(two.state);
    expect(one.nonce).not.toBe(two.nonce);
    expect(one.codeChallenge).toBe(pkceChallengeFor(one.codeVerifier));
  });

  it("registers a new client with the agent name hint and the host id", () => {
    const attempt = createAuthorizationAttempt();
    const url = new URL(buildAuthorizationUrl({ attempt, redirectUri: REDIRECT, hostId: HOST_ID, target: { kind: "register" } }));
    expect(`${url.origin}${url.pathname}`).toBe(CHATGPT_PLAN_AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Ave",
      ext_agent_host_id: HOST_ID,
      response_type: "code",
      redirect_uri: REDIRECT,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: "S256",
      code_challenge: attempt.codeChallenge,
    });
  });

  it("reauthorizes with the issued client id and hints, never the name hint", () => {
    const attempt = createAuthorizationAttempt();
    const url = new URL(buildAuthorizationUrl({
      attempt,
      redirectUri: "http://127.0.0.1:54321/auth/callback",
      hostId: HOST_ID,
      target: { kind: "reauthorize", clientId: "oaiapp_123", idTokenHint: "old-id-token", loginHint: "user@example.com" },
    }));
    expect(url.searchParams.get("client_id")).toBe("oaiapp_123");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    expect(url.searchParams.get("id_token_hint")).toBe("old-id-token");
    expect(url.searchParams.get("login_hint")).toBe("user@example.com");
    expect(url.searchParams.has("prompt")).toBe(false);
    const consent = new URL(buildAuthorizationUrl({
      attempt, redirectUri: REDIRECT, hostId: HOST_ID,
      target: { kind: "reauthorize", clientId: "oaiapp_123", requestConsent: true },
    }));
    expect(consent.searchParams.get("prompt")).toBe("consent");
  });
});

describe("plan-usage callback", () => {
  const callback = (query: string) => new URL(`${REDIRECT}?${query}`);

  it("validates state before reading an error", () => {
    expect(() => parseAuthorizationCallback(callback("state=other&error=access_denied"), {
      state: "s1", target: { kind: "register" },
    })).toThrow(expect.objectContaining({ failure: "state-mismatch" }));
    expect(parseAuthorizationCallback(callback("state=s1&error=access_denied"), {
      state: "s1", target: { kind: "register" },
    })).toEqual({ kind: "declined" });
  });

  it("requires the issued client id for a new registration", () => {
    expect(parseAuthorizationCallback(callback("state=s1&code=c1&client_id=oaiapp_9"), {
      state: "s1", target: { kind: "register" },
    })).toEqual({ kind: "code", code: "c1", clientId: "oaiapp_9" });
    expect(() => parseAuthorizationCallback(callback("state=s1&code=c1"), {
      state: "s1", target: { kind: "register" },
    })).toThrow(expect.objectContaining({ failure: "registration-incomplete" }));
    expect(() => parseAuthorizationCallback(callback("state=s1&code=c1&client_id=dynamic_agent_client"), {
      state: "s1", target: { kind: "register" },
    })).toThrow(expect.objectContaining({ failure: "registration-incomplete" }));
  });

  it("keeps a returning registration's client id and rejects a different one", () => {
    const target = { kind: "reauthorize" as const, clientId: "oaiapp_1" };
    expect(parseAuthorizationCallback(callback("state=s1&code=c1"), { state: "s1", target }))
      .toEqual({ kind: "code", code: "c1", clientId: "oaiapp_1" });
    expect(() => parseAuthorizationCallback(callback("state=s1&code=c1&client_id=oaiapp_2"), { state: "s1", target }))
      .toThrow(expect.objectContaining({ failure: "client-mismatch" }));
  });
});

describe("plan-usage token endpoint", () => {
  it("exchanges the code with the issued client id, verifier, redirect and resource", async () => {
    const { fetch, calls } = fetchReturning(jsonResponse(200, TOKEN_BODY));
    const tokens = await exchangeAuthorizationCode(fetch, {
      clientId: "oaiapp_1", code: "c1", codeVerifier: "v1", redirectUri: REDIRECT,
    });
    expect(calls[0]!.url).toBe(CHATGPT_PLAN_TOKEN_URL);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init!.body)))).toEqual({
      grant_type: "authorization_code",
      client_id: "oaiapp_1",
      code: "c1",
      code_verifier: "v1",
      redirect_uri: REDIRECT,
      resource: "https://api.openai.com/v1",
    });
    expect(tokens.scopes).toContain("chatgpt.tokens.use.direct");
    expect(tokens.earliestRefreshAt).toBe(1790035000);
  });

  it("refuses a token response without a refresh token or bearer type", async () => {
    const { refresh_token: _omit, ...withoutRefresh } = TOKEN_BODY;
    await expect(exchangeAuthorizationCode(fetchReturning(jsonResponse(200, withoutRefresh)).fetch, {
      clientId: "oaiapp_1", code: "c", codeVerifier: "v", redirectUri: REDIRECT,
    })).rejects.toMatchObject({ failure: "protocol" });
    await expect(exchangeAuthorizationCode(fetchReturning(jsonResponse(200, { ...TOKEN_BODY, token_type: "mac" })).fetch, {
      clientId: "oaiapp_1", code: "c", codeVerifier: "v", redirectUri: REDIRECT,
    })).rejects.toMatchObject({ failure: "protocol" });
  });

  it("maps invalid_grant on exchange to a fresh authorization", async () => {
    await expect(exchangeAuthorizationCode(fetchReturning(jsonResponse(400, { error: "invalid_grant" })).fetch, {
      clientId: "oaiapp_1", code: "c", codeVerifier: "v", redirectUri: REDIRECT,
    })).rejects.toMatchObject({ failure: "invalid-grant" });
  });

  it("refreshes without scope and maps every unusable refresh token code", async () => {
    const ok = fetchReturning(jsonResponse(200, { ...TOKEN_BODY, id_token: undefined }));
    const tokens = await refreshAccessToken(ok.fetch, { clientId: "oaiapp_1", refreshToken: "rt-1" });
    expect(tokens.idToken).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(String(ok.calls[0]!.init!.body)))).toEqual({
      grant_type: "refresh_token",
      client_id: "oaiapp_1",
      refresh_token: "rt-1",
      resource: "https://api.openai.com/v1",
    });
    for (const code of [
      "invalid_grant", "invalid_refresh_token", "token_expired",
      "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused",
    ]) {
      await expect(refreshAccessToken(fetchReturning(jsonResponse(400, { error: code })).fetch, {
        clientId: "oaiapp_1", refreshToken: "rt",
      })).rejects.toMatchObject({ failure: "refresh-token-unusable", oauthError: code });
    }
    await expect(refreshAccessToken(fetchReturning(jsonResponse(401, { error: "invalid_client" })).fetch, {
      clientId: "oaiapp_1", refreshToken: "rt",
    })).rejects.toMatchObject({ failure: "invalid-client" });
    await expect(refreshAccessToken(fetchReturning(jsonResponse(503, {})).fetch, {
      clientId: "oaiapp_1", refreshToken: "rt",
    })).rejects.toMatchObject({ failure: "transient" });
  });

  it("revokes with the refresh token hint and treats an empty 200 as success", async () => {
    const ok = fetchReturning(new Response("", { status: 200 }));
    await revokeRefreshToken(ok.fetch, { clientId: "oaiapp_1", refreshToken: "rt-1" });
    expect(ok.calls[0]!.url).toBe(CHATGPT_PLAN_REVOCATION_URL);
    expect(Object.fromEntries(new URLSearchParams(String(ok.calls[0]!.init!.body)))).toEqual({
      token: "rt-1", token_type_hint: "refresh_token", client_id: "oaiapp_1",
    });
    await expect(revokeRefreshToken(fetchReturning(new Response("", { status: 502 })).fetch, {
      clientId: "oaiapp_1", refreshToken: "rt",
    })).rejects.toMatchObject({ failure: "transient" });
  });

  it("never puts a token in an error message", async () => {
    const error: unknown = await refreshAccessToken(
      fetchReturning(jsonResponse(400, { error: "refresh_token_reused", error_description: "rt-secret was reused" })).fetch,
      { clientId: "oaiapp_1", refreshToken: "rt-secret" },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatGptPlanOAuthError);
    expect((error as ChatGptPlanOAuthError).message).not.toContain("rt-secret");
  });

  it("requires discovery to name the pinned endpoints", async () => {
    const document = {
      issuer: "https://auth.openai.com",
      authorization_endpoint: CHATGPT_PLAN_AUTHORIZE_URL,
      token_endpoint: CHATGPT_PLAN_TOKEN_URL,
      jwks_uri: CHATGPT_PLAN_JWKS_URL,
      revocation_endpoint: CHATGPT_PLAN_REVOCATION_URL,
    };
    await expect(verifyDiscoveryDocument(fetchReturning(jsonResponse(200, document)).fetch)).resolves.toBeUndefined();
    await expect(verifyDiscoveryDocument(fetchReturning(jsonResponse(200, {
      ...document, token_endpoint: "https://auth.example.com/token",
    })).fetch)).rejects.toMatchObject({ failure: "discovery-mismatch" });
  });
});

describe("plan-usage egress policy", () => {
  it("admits only the documented method and URL pairs", () => {
    expect(isAllowedChatGptPlanRequest("POST", CHATGPT_PLAN_RESPONSES_URL)).toBe(true);
    expect(isAllowedChatGptPlanRequest("GET", CHATGPT_PLAN_MODELS_URL)).toBe(true);
    expect(isAllowedChatGptPlanRequest("GET", CHATGPT_PLAN_DISCOVERY_URL)).toBe(true);
    expect(isAllowedChatGptPlanRequest("GET", CHATGPT_PLAN_RESPONSES_URL)).toBe(false);
    expect(isAllowedChatGptPlanRequest("POST", "https://chatgpt.com/backend-api/codex/responses")).toBe(false);
    expect(isAllowedChatGptPlanRequest("POST", `${CHATGPT_PLAN_RESPONSES_URL}?x=1`)).toBe(false);
    expect(isAllowedChatGptPlanRequest("POST", "http://api.openai.com/v1/responses")).toBe(false);
  });

  it("refuses before sending and never follows a redirect", async () => {
    const seen: RequestInit[] = [];
    const guarded = createChatGptPlanFetch((async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    await expect(guarded("https://api.openai.com/v1/files", { method: "POST" })).rejects.toBeInstanceOf(ChatGptPlanEgressError);
    await guarded(CHATGPT_PLAN_MODELS_URL, { method: "GET" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("error");
  });
});

describe("plan-usage model list", () => {
  it("keeps listed models in server order with slug and display name", () => {
    expect(parseChatGptPlanModels({
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
        { slug: "internal-x", display_name: "Hidden", visibility: "hide" },
        { slug: "gpt-6.1-mini", display_name: "GPT-6.1 mini", visibility: "list" },
        { slug: "gpt-6.1-sol", display_name: "dup", visibility: "list" },
      ],
    })).toEqual([
      { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
      { id: "gpt-6.1-mini", displayName: "GPT-6.1 mini" },
    ]);
    expect(() => parseChatGptPlanModels({ data: [{ id: "gpt-4o" }] })).toThrow();
  });
});

describe("plan-usage error classification", () => {
  it("maps each documented code to its recovery", () => {
    expect(classifyChatGptPlanError({ status: 403, code: "subscription_sharing_user_not_eligible" }))
      .toEqual({ code: "chatgpt-plan-not-eligible", retryable: false });
    expect(classifyChatGptPlanError({ status: 429, code: "subscription_sharing_usage_limit_exceeded" }))
      .toEqual({ code: "chatgpt-plan-usage-limit", retryable: false });
    expect(classifyChatGptPlanError({ status: 503, code: "subscription_sharing_usage_unavailable" }).retryable).toBe(true);
    expect(classifyChatGptPlanError({ status: 503, code: "subscription_sharing_user_unavailable" }).retryable).toBe(true);
    expect(classifyChatGptPlanError({ status: 400, code: "subscription_sharing_unsupported_capability" }).code)
      .toBe("chatgpt-plan-unsupported-capability");
    expect(classifyChatGptPlanError({ status: 401, code: "subscription_sharing_invalid_user" }))
      .toEqual({ code: "chatgpt-plan-permission-denied", retryable: false, confirmSession: true });
    expect(classifyChatGptPlanError({ status: 403, code: "chatpass_v2_scope_not_authorized" }).code)
      .toBe("chatgpt-plan-permission-denied");
    // Pre-stream admission bodies carry no code: status decides.
    expect(classifyChatGptPlanError({ status: 503 })).toEqual({ code: "chatgpt-plan-temporarily-unavailable", retryable: true });
    expect(classifyChatGptPlanError({ status: 403 }).code).toBe("chatgpt-plan-permission-denied");
  });
});
