import { createHash, randomBytes } from "node:crypto";
import {
  CHATGPT_PLAN_AGENT_NAME_HINT,
  CHATGPT_PLAN_AUTHORIZE_URL,
  CHATGPT_PLAN_DISCOVERY_URL,
  CHATGPT_PLAN_DYNAMIC_CLIENT_ID,
  CHATGPT_PLAN_ISSUER,
  CHATGPT_PLAN_JWKS_URL,
  CHATGPT_PLAN_RESOURCE,
  CHATGPT_PLAN_REVOCATION_URL,
  CHATGPT_PLAN_SCOPES,
  CHATGPT_PLAN_TOKEN_URL,
} from "./endpoints.js";

/**
 * Failures of the OAuth exchange, by recovery. Messages carry only these
 * fixed codes and the provider's machine-readable `error` value, never a
 * token, code, verifier or response body.
 */
export type ChatGptPlanOAuthFailure =
  /** The callback or token response broke the documented contract. */
  | "protocol"
  /** The callback's `state` did not belong to this attempt. */
  | "state-mismatch"
  /** The user declined consent (`error=access_denied`). */
  | "access-denied"
  /** A returning sign-in came back bound to a different issued client. */
  | "client-mismatch"
  /** A new registration's callback carried no issued client id. */
  | "registration-incomplete"
  /** The authorization code was rejected (`invalid_grant` on exchange). */
  | "invalid-grant"
  /** The refresh token can never be used again; sign in again. */
  | "refresh-token-unusable"
  /** The issued client is misconfigured (`invalid_client`). */
  | "invalid-client"
  /** A network failure or 5xx; credentials stay, try again later. */
  | "transient"
  /** The discovery document named endpoints other than the pinned ones. */
  | "discovery-mismatch"
  /** Any other OAuth error response. */
  | "rejected";

export class ChatGptPlanOAuthError extends Error {
  constructor(
    readonly failure: ChatGptPlanOAuthFailure,
    readonly oauthError?: string,
    readonly status?: number,
  ) {
    super(`chatgpt-plan oauth ${failure}${oauthError ? ` (${oauthError})` : ""}${status ? ` [${status}]` : ""}`);
    this.name = "ChatGptPlanOAuthError";
  }
}

/** One authorization attempt's secrets, kept in main until its callback completes. */
export interface ChatGptPlanAuthorizationAttempt {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallengeFor(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/** Fresh `state`, OIDC `nonce` and PKCE verifier for exactly one attempt. */
export function createAuthorizationAttempt(): ChatGptPlanAuthorizationAttempt {
  const codeVerifier = randomUrlSafe(48);
  return Object.freeze({
    state: randomUrlSafe(32),
    nonce: randomUrlSafe(32),
    codeVerifier,
    codeChallenge: pkceChallengeFor(codeVerifier),
  });
}

export type ChatGptPlanAuthorizationTarget =
  /** First sign-in for an account on this install: dynamic registration. */
  | { readonly kind: "register" }
  /** Reauthorization of a saved registration with its issued client id. */
  | {
      readonly kind: "reauthorize";
      readonly clientId: string;
      readonly idTokenHint?: string;
      readonly loginHint?: string;
      /** Only when the user explicitly enables plan usage after a decline. */
      readonly requestConsent?: boolean;
    };

/**
 * The authorization URL to open in the system browser. Every value is
 * URL-encoded by `URLSearchParams`. The result can contain `id_token_hint`, so
 * it must never be logged.
 */
export function buildAuthorizationUrl(input: {
  readonly attempt: ChatGptPlanAuthorizationAttempt;
  readonly redirectUri: string;
  readonly hostId: string;
  readonly target: ChatGptPlanAuthorizationTarget;
}): string {
  const { attempt, target } = input;
  const params = new URLSearchParams();
  params.set("client_id", target.kind === "register" ? CHATGPT_PLAN_DYNAMIC_CLIENT_ID : target.clientId);
  if (target.kind === "register") params.set("agent_name_hint", CHATGPT_PLAN_AGENT_NAME_HINT);
  params.set("ext_agent_host_id", input.hostId);
  if (target.kind === "reauthorize") {
    if (target.idTokenHint) params.set("id_token_hint", target.idTokenHint);
    if (target.loginHint) params.set("login_hint", target.loginHint);
    if (target.requestConsent) params.set("prompt", "consent");
  }
  params.set("response_type", "code");
  params.set("redirect_uri", input.redirectUri);
  params.set("scope", CHATGPT_PLAN_SCOPES.join(" "));
  params.set("resource", CHATGPT_PLAN_RESOURCE);
  params.set("state", attempt.state);
  params.set("nonce", attempt.nonce);
  params.set("code_challenge_method", "S256");
  params.set("code_challenge", attempt.codeChallenge);
  return `${CHATGPT_PLAN_AUTHORIZE_URL}?${params.toString()}`;
}

export type ChatGptPlanCallbackResult =
  | { readonly kind: "code"; readonly code: string; readonly clientId: string }
  | { readonly kind: "declined" };

/**
 * Validate a loopback callback against its pending attempt. `state` is checked
 * before any other field, including an OAuth error. A new registration must
 * return its issued client id; a returning sign-in may omit it but may never
 * name a different one.
 */
export function parseAuthorizationCallback(
  callbackUrl: URL,
  pending: { readonly state: string; readonly target: ChatGptPlanAuthorizationTarget },
): ChatGptPlanCallbackResult {
  const params = callbackUrl.searchParams;
  if (params.get("state") !== pending.state) throw new ChatGptPlanOAuthError("state-mismatch");
  const error = params.get("error");
  if (error === "access_denied") return { kind: "declined" };
  if (error !== null) throw new ChatGptPlanOAuthError("rejected", safeOAuthErrorCode(error));
  const code = params.get("code");
  if (!code) throw new ChatGptPlanOAuthError("protocol");
  const returnedClientId = params.get("client_id");
  if (pending.target.kind === "register") {
    if (!returnedClientId || returnedClientId === CHATGPT_PLAN_DYNAMIC_CLIENT_ID) {
      throw new ChatGptPlanOAuthError("registration-incomplete");
    }
    if (!isIssuedClientId(returnedClientId)) throw new ChatGptPlanOAuthError("protocol");
    return { kind: "code", code, clientId: returnedClientId };
  }
  if (returnedClientId !== null && returnedClientId !== pending.target.clientId) {
    throw new ChatGptPlanOAuthError("client-mismatch");
  }
  return { kind: "code", code, clientId: pending.target.clientId };
}

/** An issued client id: printable, bounded, and never the registration entrypoint. */
export function isIssuedClientId(value: unknown): value is string {
  return typeof value === "string"
    && value !== CHATGPT_PLAN_DYNAMIC_CLIENT_ID
    && /^[A-Za-z0-9._~-]{1,200}$/.test(value);
}

function safeOAuthErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : undefined;
}

export interface ChatGptPlanTokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Present on code exchange; a refresh may omit it. */
  readonly idToken?: string;
  readonly expiresIn: number;
  readonly scopes: readonly string[];
  /** Unix seconds before which a refresh should not be attempted, when sent. */
  readonly earliestRefreshAt?: number;
}

function parseTokenResponse(body: unknown, requireIdToken: boolean): ChatGptPlanTokenResponse {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ChatGptPlanOAuthError("protocol");
  }
  const value = body as Record<string, unknown>;
  const accessToken = value.access_token;
  const refreshToken = value.refresh_token;
  const idToken = value.id_token;
  const tokenType = value.token_type;
  const expiresIn = value.expires_in;
  const scope = value.scope;
  const earliestRefreshAt = value.earliest_refresh_at;
  if (
    typeof accessToken !== "string" || accessToken.length === 0
    || typeof refreshToken !== "string" || refreshToken.length === 0
    || (requireIdToken && (typeof idToken !== "string" || idToken.length === 0))
    || (idToken !== undefined && typeof idToken !== "string")
    || typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer"
    || typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0
    || typeof scope !== "string"
    || (earliestRefreshAt !== undefined && earliestRefreshAt !== null
      && (typeof earliestRefreshAt !== "number" || !Number.isFinite(earliestRefreshAt)))
  ) {
    throw new ChatGptPlanOAuthError("protocol");
  }
  return Object.freeze({
    accessToken,
    refreshToken,
    ...(typeof idToken === "string" && idToken.length > 0 ? { idToken } : {}),
    expiresIn,
    scopes: Object.freeze(scope.split(" ").filter((entry) => entry.length > 0).sort()),
    ...(typeof earliestRefreshAt === "number" ? { earliestRefreshAt } : {}),
  });
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function oauthErrorCodeOf(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return safeOAuthErrorCode(error);
  if (error !== null && typeof error === "object") {
    return safeOAuthErrorCode((error as { code?: unknown }).code);
  }
  return undefined;
}

const UNUSABLE_REFRESH_TOKEN_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  form: Record<string, string>,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new ChatGptPlanOAuthError("transient");
  }
}

/** Exchange an authorization code with the issued client id and the attempt's verifier. */
export async function exchangeAuthorizationCode(
  fetchImpl: typeof fetch,
  input: {
    readonly clientId: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  },
): Promise<ChatGptPlanTokenResponse> {
  const response = await postForm(fetchImpl, CHATGPT_PLAN_TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    resource: CHATGPT_PLAN_RESOURCE,
  });
  const body = await readJson(response);
  if (response.status === 200) return parseTokenResponse(body, true);
  if (response.status >= 500) throw new ChatGptPlanOAuthError("transient", undefined, response.status);
  const code = oauthErrorCodeOf(body);
  if (code === "invalid_grant") throw new ChatGptPlanOAuthError("invalid-grant", code, response.status);
  if (code === "invalid_client") throw new ChatGptPlanOAuthError("invalid-client", code, response.status);
  throw new ChatGptPlanOAuthError("rejected", code, response.status);
}

/**
 * Rotate the refresh token. `scope` is omitted so the grant is retained. The
 * caller serializes calls for one session: a second concurrent refresh would
 * present an already-rotated token and be refused as reused.
 */
export async function refreshAccessToken(
  fetchImpl: typeof fetch,
  input: { readonly clientId: string; readonly refreshToken: string },
): Promise<ChatGptPlanTokenResponse> {
  const response = await postForm(fetchImpl, CHATGPT_PLAN_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    resource: CHATGPT_PLAN_RESOURCE,
  });
  const body = await readJson(response);
  if (response.status === 200) return parseTokenResponse(body, false);
  if (response.status >= 500) throw new ChatGptPlanOAuthError("transient", undefined, response.status);
  const code = oauthErrorCodeOf(body);
  if (code !== undefined && UNUSABLE_REFRESH_TOKEN_ERRORS.has(code)) {
    throw new ChatGptPlanOAuthError("refresh-token-unusable", code, response.status);
  }
  if (code === "invalid_client") throw new ChatGptPlanOAuthError("invalid-client", code, response.status);
  throw new ChatGptPlanOAuthError("rejected", code, response.status);
}

/**
 * End the renewable session. An empty 200 is success, including for a token
 * that was already invalid. A network failure or 5xx is `transient` so the
 * caller can retry with backoff while it still holds the token.
 */
export async function revokeRefreshToken(
  fetchImpl: typeof fetch,
  input: { readonly clientId: string; readonly refreshToken: string },
): Promise<void> {
  const response = await postForm(fetchImpl, CHATGPT_PLAN_REVOCATION_URL, {
    token: input.refreshToken,
    token_type_hint: "refresh_token",
    client_id: input.clientId,
  });
  await response.text().catch(() => "");
  if (response.status === 200) return;
  if (response.status >= 500) throw new ChatGptPlanOAuthError("transient", undefined, response.status);
  throw new ChatGptPlanOAuthError("rejected", undefined, response.status);
}

/**
 * Read the discovery document and require it to name the pinned issuer and
 * endpoints. The egress policy admits only those, so a mismatch is reported
 * as such rather than followed.
 */
export async function verifyDiscoveryDocument(fetchImpl: typeof fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(CHATGPT_PLAN_DISCOVERY_URL, { method: "GET", headers: { accept: "application/json" } });
  } catch {
    throw new ChatGptPlanOAuthError("transient");
  }
  if (response.status >= 500) throw new ChatGptPlanOAuthError("transient", undefined, response.status);
  const body = await readJson(response);
  if (response.status !== 200 || body === null || typeof body !== "object") {
    throw new ChatGptPlanOAuthError("discovery-mismatch", undefined, response.status);
  }
  const document = body as Record<string, unknown>;
  if (
    document.issuer !== CHATGPT_PLAN_ISSUER
    || document.authorization_endpoint !== CHATGPT_PLAN_AUTHORIZE_URL
    || document.token_endpoint !== CHATGPT_PLAN_TOKEN_URL
    || document.jwks_uri !== CHATGPT_PLAN_JWKS_URL
    || document.revocation_endpoint !== CHATGPT_PLAN_REVOCATION_URL
  ) {
    throw new ChatGptPlanOAuthError("discovery-mismatch");
  }
}
