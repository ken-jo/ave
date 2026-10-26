import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  CHATGPT_PLAN_AUTHORIZE_URL,
  CHATGPT_PLAN_DISCOVERY_URL,
  CHATGPT_PLAN_JWKS_URL,
  CHATGPT_PLAN_MODELS_URL,
  CHATGPT_PLAN_REVOCATION_URL,
  CHATGPT_PLAN_TOKEN_URL,
} from "../endpoints.js";
import { ChatGptPlanIdTokenError } from "../id-token.js";
import { startChatGptPlanCallbackListener, type ChatGptPlanCallbackListener } from "../loopback.js";
import {
  CHATGPT_PLAN_ACCOUNT_SECRET_KEY,
  ChatGptPlanSession,
  type ChatGptPlanSessionEvent,
  type ChatGptPlanSecretStore,
} from "../session.js";

const PLAN_SCOPES = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
const IDENTITY_SCOPES = "email offline_access openid profile";
const HOST_ID = "urn:uuid:7d3c1f2e-8a4b-4c5d-9e6f-0a1b2c3d4e5f";
const DISCOVERY = {
  issuer: "https://auth.openai.com",
  authorization_endpoint: CHATGPT_PLAN_AUTHORIZE_URL,
  token_endpoint: CHATGPT_PLAN_TOKEN_URL,
  jwks_uri: CHATGPT_PLAN_JWKS_URL,
  revocation_endpoint: CHATGPT_PLAN_REVOCATION_URL,
};

type Route = (body: URLSearchParams | null, init?: RequestInit) => Response | Promise<Response>;

class FakeSecrets implements ChatGptPlanSecretStore {
  readonly values = new Map<string, string>();
  encrypted = true;
  writes = 0;
  isSecretStorageEncrypted(): boolean { return this.encrypted; }
  getEncryptedSecret(key: string): string | null { return this.values.get(key) ?? null; }
  async setSecret(key: string, value: string): Promise<void> { this.writes += 1; this.values.set(key, value); }
  async deleteSecret(key: string): Promise<void> { this.values.delete(key); }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function harness(options: {
  token?: Route[];
  revoke?: Route[];
  models?: Route;
  verifyFails?: boolean;
  /** The failure a refresh's rotated ID token (verified without a nonce) meets. */
  refreshVerify?: { failure: ConstructorParameters<typeof ChatGptPlanIdTokenError>[0] | null };
  subject?: string;
  now?: () => number;
  startListener?: (expectedState: string) => Promise<ChatGptPlanCallbackListener>;
} = {}) {
  const secrets = new FakeSecrets();
  const requests: { url: string; body: URLSearchParams | null; authorization: string | null }[] = [];
  // Shared by reference: a test may queue routes after building the harness.
  const tokenRoutes = options.token ?? [];
  const revokeRoutes = options.revoke ?? [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" && url !== CHATGPT_PLAN_MODELS_URL ? new URLSearchParams(init.body) : null;
    requests.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
    if (url === CHATGPT_PLAN_DISCOVERY_URL) return json(200, DISCOVERY);
    if (url === CHATGPT_PLAN_TOKEN_URL) {
      const route = tokenRoutes.shift();
      if (!route) throw new Error("unexpected token request");
      return route(body, init);
    }
    if (url === CHATGPT_PLAN_REVOCATION_URL) {
      const route = revokeRoutes.shift();
      if (!route) throw new Error("unexpected revocation request");
      return route(body, init);
    }
    if (url === CHATGPT_PLAN_MODELS_URL && options.models) return options.models(null, init);
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  let deliver: (query: string) => void = () => undefined;
  let closed = 0;
  const opened: string[] = [];
  const loginWindows: import("../../oauth-login.js").OAuthLoginOptions[] = [];
  const events: ChatGptPlanSessionEvent[] = [];
  const session = new ChatGptPlanSession({
    fetch: fetchImpl,
    secrets,
    hostId: async () => HOST_ID,
    openAuthorizationUrl: async (url, login) => { opened.push(url); loginWindows.push(login); await login.completion; },
    startListener: options.startListener ?? (async (): Promise<ChatGptPlanCallbackListener> => {
      let resolve: (url: URL) => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const callback = new Promise<URL>((res, rej) => { resolve = res; reject = rej; });
      deliver = (query) => resolve(new URL(`http://127.0.0.1:1455/auth/callback?${query}`));
      return {
        redirectUri: "http://127.0.0.1:1455/auth/callback",
        callback,
        close: () => { closed += 1; reject(new Error("closed")); },
      };
    }),
    verifier: {
      verify: async (idToken, expected) => {
        if (options.verifyFails) throw new ChatGptPlanIdTokenError("signature");
        if (expected.nonce === undefined && options.refreshVerify?.failure) {
          throw new ChatGptPlanIdTokenError(options.refreshVerify.failure);
        }
        if (expected.nonce !== undefined && !idToken.endsWith(expected.nonce)) throw new ChatGptPlanIdTokenError("nonce");
        return { issuer: "https://auth.openai.com", subject: options.subject ?? "user-sub", email: "user@example.com" };
      },
    },
    now: options.now ?? (() => 1_000_000),
    sleep: async () => undefined,
    onEvent: (event) => events.push(event),
  });
  const authorizeParams = () => new URL(opened.at(-1)!).searchParams;
  return { session, secrets, requests, events, loginWindows, deliver: (query: string) => deliver(query), authorizeParams, closed: () => closed };
}

function tokens(n: number, scope = PLAN_SCOPES, nonce = ""): Route {
  return () => json(200, {
    access_token: `access-${n}`,
    refresh_token: `refresh-${n}`,
    id_token: `id-${n}.${nonce}`,
    token_type: "Bearer",
    expires_in: 3600,
    scope,
  });
}

async function signIn(h: ReturnType<typeof harness>, query: (params: URLSearchParams) => string) {
  const { completion } = await h.session.startSignIn();
  h.deliver(query(h.authorizeParams()));
  return completion;
}

/** Token route that echoes the attempt nonce into the ID token so verification can check it. */
function tokensFor(h: { authorizeParams: () => URLSearchParams }, n: number, scope = PLAN_SCOPES): Route {
  return (...args) => tokens(n, scope, h.authorizeParams().get("nonce")!)(...args);
}

describe("plan-usage sign-in state machine", () => {
  it("completes its login with a real ephemeral callback listener and verifies the proof key", async () => {
    const tokenRoutes: Route[] = [];
    const h = harness({ token: tokenRoutes, startListener: startChatGptPlanCallbackListener });
    tokenRoutes.push(tokensFor(h, 1));
    const { completion } = await h.session.startSignIn();
    const params = h.authorizeParams();
    const redirect = new URL(params.get("redirect_uri")!);
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(params.get("code_challenge_method")).toBe("S256");
    try {
      redirect.search = "code=forged&state=wrong-state&client_id=oaiapp_1";
      expect((await fetch(redirect)).status).toBe(404);
      expect(h.requests.filter(request => request.url === CHATGPT_PLAN_TOKEN_URL)).toHaveLength(0);
      redirect.search = new URLSearchParams({ code: "accepted-code", state: params.get("state")!, client_id: "oaiapp_1" }).toString();
      expect((await fetch(redirect)).status).toBe(200);
      await completion;
      await expect(h.loginWindows[0].completion).resolves.toBeInstanceOf(URL);
      const exchange = h.requests.find(request => request.url === CHATGPT_PLAN_TOKEN_URL)!;
      expect(exchange.body!.get("code")).toBe("accepted-code");
      expect(createHash("sha256").update(exchange.body!.get("code_verifier")!).digest("base64url")).toBe(params.get("code_challenge"));
      expect(h.session.status().connection).toBe("connected");
      await expect(fetch(redirect)).rejects.toThrow();
    } finally { h.loginWindows[0].onCancel(); await completion.catch(() => undefined); }
  });

  it("releases the callback listener and shows a failure when its login window closes", async () => {
    const h = harness();
    const { completion } = await h.session.startSignIn();
    expect(h.loginWindows).toHaveLength(1);
    h.loginWindows[0].onCancel();
    await expect(completion).rejects.toMatchObject({ failure: "sign-in-failed" });
    expect(h.closed()).toBeGreaterThan(0);
    expect(h.session.status()).toMatchObject({ connection: "signed-out", notice: "sign-in-failed" });
  });
  it("registers, validates and stores one encrypted record, then shows the welcome once", async () => {
    const tokenRoutes: Route[] = [];
    const routed = harness({ token: tokenRoutes });
    tokenRoutes.push(tokensFor(routed, 1));
    expect(routed.session.status()).toEqual({ connection: "signed-out", planUsage: null, accountLabel: null, notice: null });
    const { completion } = await routed.session.startSignIn();
    expect(routed.session.status().connection).toBe("pending");
    const params = routed.authorizeParams();
    routed.deliver(`code=c1&state=${params.get("state")}&client_id=oaiapp_1&scope=${encodeURIComponent(PLAN_SCOPES)}`);
    await completion;
    await expect(routed.loginWindows[0].completion).resolves.toBeInstanceOf(URL);
    expect(routed.authorizeParams().get("client_id")).toBe("dynamic_agent_client");
    expect(routed.authorizeParams().get("ext_agent_host_id")).toBe(HOST_ID);
    const exchange = routed.requests.find((request) => request.url === CHATGPT_PLAN_TOKEN_URL)!;
    expect(exchange.body!.get("client_id")).toBe("oaiapp_1");
    expect(routed.session.status()).toEqual({
      connection: "connected", planUsage: "enabled", accountLabel: "user@example.com", notice: "welcome",
    });
    const stored = JSON.parse(routed.secrets.values.get(CHATGPT_PLAN_ACCOUNT_SECRET_KEY)!);
    expect(stored).toMatchObject({ clientId: "oaiapp_1", subject: "user-sub", welcomed: true });
    expect(stored.tokens.scopes).toContain("chatgpt.tokens.use.direct");
    routed.session.acknowledgeNotice();
    expect(routed.session.status().notice).toBeNull();
    expect(routed.closed()).toBe(1);
  });

  it("stops without exchanging a code when consent is declined", async () => {
    const h = harness();
    await expect(signIn(h, (p) => `error=access_denied&state=${p.get("state")}`)).rejects.toMatchObject({ failure: "declined" });
    expect(h.requests.some((request) => request.url === CHATGPT_PLAN_TOKEN_URL)).toBe(false);
    expect(h.secrets.writes).toBe(0);
    expect(h.session.status().notice).toBe("declined");
    h.session.acknowledgeNotice();
    expect(h.session.status().notice).toBeNull();
  });

  it("explains a callback that does not belong to the attempt, and says nothing after a cancel", async () => {
    const h = harness();
    // The real listener ignores such a callback; the session still checks state itself.
    await expect(signIn(h, () => "code=c1&state=forged")).rejects.toMatchObject({ failure: "sign-in-failed" });
    expect(h.session.status().notice).toBe("state-mismatch");
    const { completion } = await h.session.startSignIn();
    h.session.cancelSignIn();
    await expect(completion).rejects.toBeDefined();
    expect(h.session.status()).toMatchObject({ connection: "signed-out", notice: null });
  });

  it("refuses to start without encrypted secret storage", async () => {
    const h = harness();
    h.secrets.encrypted = false;
    await expect(h.session.startSignIn()).rejects.toMatchObject({ failure: "secure-storage-unavailable" });
  });

  it("keeps a sign-in without plan permission but never issues an access token for it", async () => {
    const routes: Route[] = [];
    const h = harness({ token: routes });
    routes.push(tokensFor(h, 1, IDENTITY_SCOPES));
    await signIn(h, (p) => `code=c1&state=${p.get("state")}&client_id=oaiapp_1`);
    expect(h.session.status()).toMatchObject({ connection: "connected", planUsage: "disabled", notice: "plan-usage-disabled" });
    await expect(h.session.accessToken()).rejects.toMatchObject({ failure: "plan-usage-disabled" });
  });

  it("reauthorizes the saved client with hints and consent when plan usage is enabled later", async () => {
    const routes: Route[] = [];
    const h = harness({ token: routes });
    routes.push(tokensFor(h, 1, IDENTITY_SCOPES));
    await signIn(h, (p) => `code=c1&state=${p.get("state")}&client_id=oaiapp_1`);
    routes.push(tokensFor(h, 2));
    const { completion } = await h.session.startSignIn({ requestConsent: true });
    const params = h.authorizeParams();
    expect(params.get("client_id")).toBe("oaiapp_1");
    expect(params.has("agent_name_hint")).toBe(false);
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("login_hint")).toBe("user@example.com");
    expect(params.get("id_token_hint")).toMatch(/^id-1\./);
    h.deliver(`code=c2&state=${params.get("state")}`);
    await completion;
    expect(h.session.status()).toMatchObject({ planUsage: "enabled", notice: "welcome" });
  });

  it("rejects a returning sign-in that comes back as a different account", async () => {
    const routes: Route[] = [];
    const h = harness({ token: routes });
    routes.push(tokensFor(h, 1));
    await signIn(h, (p) => `code=c1&state=${p.get("state")}&client_id=oaiapp_1`);
    const otherRoutes: Route[] = [];
    const replay = harness({ token: otherRoutes, subject: "someone-else" });
    replay.secrets.values.set(CHATGPT_PLAN_ACCOUNT_SECRET_KEY, h.secrets.values.get(CHATGPT_PLAN_ACCOUNT_SECRET_KEY)!);
    otherRoutes.push(tokensFor(replay, 2));
    await expect(signIn(replay, (p) => `code=c2&state=${p.get("state")}`)).rejects.toMatchObject({ failure: "account-mismatch" });
    expect(replay.session.status().notice).toBe("account-mismatch");
    expect(JSON.parse(replay.secrets.values.get(CHATGPT_PLAN_ACCOUNT_SECRET_KEY)!).tokens.accessToken).toBe("access-1");
  });

  it("keeps a newly issued client when its code is refused, and reauthorizes it next time", async () => {
    const h = harness({ token: [() => json(400, { error: "invalid_grant" })] });
    await expect(signIn(h, (p) => `code=c1&state=${p.get("state")}&client_id=oaiapp_7`)).rejects.toMatchObject({ failure: "sign-in-failed" });
    expect(h.session.status().connection).toBe("signed-out");
    await h.session.startSignIn();
    expect(h.authorizeParams().get("client_id")).toBe("oaiapp_7");
    h.session.cancelSignIn();
  });

  it("does not store anything when the ID token fails validation", async () => {
    const h = harness({ token: [tokens(1)], verifyFails: true });
    await expect(signIn(h, (p) => `code=c1&state=${p.get("state")}&client_id=oaiapp_1`)).rejects.toMatchObject({ failure: "sign-in-failed" });
    expect(h.secrets.values.has(CHATGPT_PLAN_ACCOUNT_SECRET_KEY)).toBe(false);
  });
});

async function connected(extra: {
  token?: Route[]; revoke?: Route[]; models?: Route; clock?: { now: number };
  refreshVerify?: { failure: ConstructorParameters<typeof ChatGptPlanIdTokenError>[0] | null };
} = {}) {
  const clock = extra.clock ?? { now: 1_000_000 };
  const routes: Route[] = [];
  const h = harness({
    token: routes, ...(extra.revoke ? { revoke: extra.revoke } : {}), ...(extra.models ? { models: extra.models } : {}),
    ...(extra.refreshVerify ? { refreshVerify: extra.refreshVerify } : {}), now: () => clock.now,
  });
  routes.push(tokensFor(h, 1));
  await signIn(h, (p) => `code=c1&state=${p.get("state")}&client_id=oaiapp_1`);
  routes.push(...(extra.token ?? []));
  return { ...h, clock };
}

describe("plan-usage token refresh", () => {
  it("serializes concurrent refreshes so a rotating token is presented once", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await connected({ token: [async (...args) => { await gate; return tokens(2)(...args); }] });
    h.clock.now += 3600_000;
    const first = h.session.accessToken();
    const second = h.session.accessToken();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["access-2", "access-2"]);
    const refreshes = h.requests.filter((request) => request.body?.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.body!.get("client_id")).toBe("oaiapp_1");
    expect(refreshes[0]!.body!.get("refresh_token")).toBe("refresh-1");
    expect(refreshes[0]!.body!.has("scope")).toBe(false);
    expect(JSON.parse(h.secrets.values.get(CHATGPT_PLAN_ACCOUNT_SECRET_KEY)!).tokens.refreshToken).toBe("refresh-2");
  });

  it("does not refresh a token that is not near expiry", async () => {
    const h = await connected();
    await expect(h.session.accessToken()).resolves.toBe("access-1");
  });

  it("clears tokens and asks for sign-in after refresh_token_reused", async () => {
    const h = await connected({ token: [() => json(400, { error: "refresh_token_reused" })] });
    h.clock.now += 3600_000;
    await expect(h.session.accessToken()).rejects.toMatchObject({ failure: "reconnect-required" });
    expect(h.session.status()).toMatchObject({ connection: "signed-out", notice: "reconnect-required" });
    const stored = JSON.parse(h.secrets.values.get(CHATGPT_PLAN_ACCOUNT_SECRET_KEY)!);
    expect(stored.tokens).toBeNull();
    expect(stored.clientId).toBe("oaiapp_1");
  });

  it("keeps the rotated tokens and the previous ID token when the issuer's keys are unavailable", async () => {
    const h = await connected({ token: [tokens(2)], refreshVerify: { failure: "jwks-unavailable" } });
    h.clock.now += 3600_000;
    await expect(h.session.accessToken()).resolves.toBe("access-2");
    const stored = JSON.parse(h.secrets.values.get(CHATGPT_PLAN_ACCOUNT_SECRET_KEY)!);
    expect(stored.tokens).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    // The unverified rotated ID token is not kept; the last verified one still serves as the sign-in hint.
    expect(stored.tokens.idToken).toBe(`id-1.${h.authorizeParams().get("nonce")}`);
    expect(h.session.status().connection).toBe("connected");
  });

  it.each(["signature", "issuer", "audience", "subject"] as const)(
    "fails closed when the rotated ID token fails its %s check",
    async (failure) => {
      const h = await connected({ token: [tokens(2)], refreshVerify: { failure } });
      h.clock.now += 3600_000;
      await expect(h.session.accessToken()).rejects.toMatchObject({ failure: "reconnect-required" });
      const stored = JSON.parse(h.secrets.values.get(CHATGPT_PLAN_ACCOUNT_SECRET_KEY)!);
      expect(stored.tokens).toBeNull();
      expect(JSON.stringify(stored)).not.toContain("refresh-2");
      expect(h.session.status()).toMatchObject({ connection: "signed-out", notice: "reconnect-required" });
    },
  );

  it("keeps credentials through a temporary refresh failure", async () => {
    const h = await connected({ token: [() => json(503, {})] });
    h.clock.now += 3600_000;
    await expect(h.session.accessToken()).rejects.toMatchObject({ failure: "temporarily-unavailable" });
    expect(h.session.status().connection).toBe("connected");
  });

  it("lists the account's models with the session's bearer token", async () => {
    const h = await connected({
      models: () => json(200, { models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }] }),
    });
    await expect(h.session.listModels()).resolves.toEqual([{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }]);
    expect(h.requests.find((request) => request.url === CHATGPT_PLAN_MODELS_URL)!.authorization).toBe("Bearer access-1");
  });
});

describe("plan-usage sign-out", () => {
  it("revokes the refresh token, retries a 5xx, then clears tokens but keeps the registration", async () => {
    const h = await connected({ revoke: [() => new Response("", { status: 503 }), () => new Response("", { status: 200 })] });
    await h.session.signOut();
    const revocations = h.requests.filter((request) => request.url === CHATGPT_PLAN_REVOCATION_URL);
    expect(revocations).toHaveLength(2);
    expect(revocations[0]!.body!.get("token")).toBe("refresh-1");
    expect(h.session.status()).toEqual({ connection: "signed-out", planUsage: null, accountLabel: null, notice: null });
    expect(JSON.parse(h.secrets.values.get(CHATGPT_PLAN_ACCOUNT_SECRET_KEY)!)).toMatchObject({ clientId: "oaiapp_1", tokens: null });
  });

  it("clears local tokens and reports an unconfirmed revocation", async () => {
    const down = () => new Response("", { status: 502 });
    const h = await connected({ revoke: [down, down, down, down] });
    await h.session.signOut();
    expect(h.session.status()).toMatchObject({ connection: "signed-out", notice: "revocation-unconfirmed" });
  });
});

describe("plan-usage credential redaction", () => {
  it("never exposes a token in status, events or errors", async () => {
    const h = await connected({
      token: [() => json(400, { error: "refresh_token_reused", error_description: "refresh-1 reused" })],
      revoke: [],
    });
    h.clock.now += 3600_000;
    const error = await h.session.accessToken().then(
      () => { throw new Error("expected the refresh to fail"); },
      (caught: unknown) => caught as Error,
    );
    const surfaces = JSON.stringify({
      status: h.session.status(),
      events: h.events,
      error: { name: error.name, message: error.message },
    });
    for (const secret of ["access-1", "refresh-1", "id-1", HOST_ID, "oaiapp_1"]) {
      expect(surfaces).not.toContain(secret);
    }
  });
});
