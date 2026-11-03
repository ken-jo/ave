import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet } from "jose";
import { CHATGPT_PLAN_ISSUER, CHATGPT_PLAN_JWKS_URL } from "./endpoints.js";

/** Allowed difference between this machine's clock and the issuer's. */
const CLOCK_TOLERANCE_SECONDS = 5;
/** An unknown `kid` refetches the key set at most this often. */
const JWKS_REFETCH_INTERVAL_MS = 60_000;

export type ChatGptPlanIdTokenFailure =
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "nonce"
  | "subject"
  | "malformed"
  | "jwks-unavailable";

/** A key-set fetch is retried once on a network error or a server-side status. */
const JWKS_FETCH_ATTEMPTS = 2;
const JWKS_RETRY_DELAY_MS = 500;

export class ChatGptPlanIdTokenError extends Error {
  /** `detail` names why the key set was unavailable (a status or error name), never a token or body. */
  constructor(readonly failure: ChatGptPlanIdTokenFailure, readonly detail?: string) {
    super(`chatgpt-plan id token rejected: ${failure}${detail ? ` (${detail})` : ""}`);
    this.name = "ChatGptPlanIdTokenError";
  }
}

export interface ChatGptPlanVerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
}

function isJsonWebKeySet(value: unknown): value is JSONWebKeySet {
  return value !== null
    && typeof value === "object"
    && Array.isArray((value as { keys?: unknown }).keys);
}

/**
 * Verifies ID tokens against the issuer's published keys. The key set is
 * fetched through the plan connection's egress policy and cached; a token
 * signed by a key the cache does not hold triggers one rate-limited refetch.
 */
export class ChatGptPlanIdTokenVerifier {
  private keySet: ReturnType<typeof createLocalJWKSet> | null = null;
  private lastForcedRefetchAt = Number.NEGATIVE_INFINITY;
  private pendingFetch: Promise<ReturnType<typeof createLocalJWKSet>> | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Fetch the key set ahead of a sign-in, so an unreachable key set fails before the browser opens. */
  async prefetchKeys(): Promise<void> {
    try {
      await this.keys(false);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * Check signature, issuer, audience (the issued client id), expiry and, for
   * a sign-in, the attempt's nonce. A refresh response carries no nonce, so
   * `nonce` is omitted there and the subject must match the stored account.
   */
  async verify(
    idToken: string,
    expected: { readonly clientId: string; readonly nonce?: string; readonly subject?: string },
  ): Promise<ChatGptPlanVerifiedIdentity> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.verifyWithKeys(idToken, expected.clientId, false);
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw this.mapError(error);
      try {
        payload = await this.verifyWithKeys(idToken, expected.clientId, true);
      } catch (retryError) {
        throw this.mapError(retryError);
      }
    }
    if (expected.nonce !== undefined && payload.nonce !== expected.nonce) {
      throw new ChatGptPlanIdTokenError("nonce");
    }
    const subject = payload.sub;
    if (typeof subject !== "string" || subject.length === 0) throw new ChatGptPlanIdTokenError("subject");
    if (expected.subject !== undefined && subject !== expected.subject) {
      throw new ChatGptPlanIdTokenError("subject");
    }
    const email = typeof payload.email === "string" && payload.email.length > 0 ? payload.email : null;
    return Object.freeze({ issuer: CHATGPT_PLAN_ISSUER, subject, email });
  }

  private async verifyWithKeys(
    idToken: string,
    clientId: string,
    forceRefetch: boolean,
  ): Promise<Record<string, unknown>> {
    const keys = await this.keys(forceRefetch);
    const { payload } = await jwtVerify(idToken, keys, {
      // The issuer publishes only RS256 (`id_token_signing_alg_values_supported`); any other algorithm is refused.
      algorithms: ["RS256"],
      issuer: CHATGPT_PLAN_ISSUER,
      audience: clientId,
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(this.now()),
    });
    return payload as Record<string, unknown>;
  }

  private async keys(forceRefetch: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (this.keySet && !forceRefetch) return this.keySet;
    if (this.keySet && forceRefetch) {
      // An unknown `kid` may mean the issuer rotated keys; refetch, but no
      // more than once per interval however many such tokens arrive.
      if (this.now() - this.lastForcedRefetchAt < JWKS_REFETCH_INTERVAL_MS) return this.keySet;
      this.lastForcedRefetchAt = this.now();
    }
    if (!this.pendingFetch) {
      this.pendingFetch = this.fetchKeySet().finally(() => {
        this.pendingFetch = null;
      });
    }
    return this.pendingFetch;
  }

  private async fetchKeySet(): Promise<ReturnType<typeof createLocalJWKSet>> {
    let detail = "unknown";
    for (let attempt = 1; attempt <= JWKS_FETCH_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await this.sleep(JWKS_RETRY_DELAY_MS);
      let response: Response;
      try {
        response = await this.fetchImpl(CHATGPT_PLAN_JWKS_URL, {
          method: "GET",
          headers: { accept: "application/json" },
        });
      } catch (error) {
        detail = `network-${error instanceof Error ? error.name : "error"}`;
        continue;
      }
      if (response.status !== 200) {
        detail = `status-${response.status}`;
        if (response.status >= 500 || response.status === 429) continue;
        throw new ChatGptPlanIdTokenError("jwks-unavailable", detail);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ChatGptPlanIdTokenError("jwks-unavailable", "invalid-body");
      }
      if (!isJsonWebKeySet(body)) throw new ChatGptPlanIdTokenError("jwks-unavailable", "invalid-body");
      this.keySet = createLocalJWKSet(body);
      return this.keySet;
    }
    throw new ChatGptPlanIdTokenError("jwks-unavailable", detail);
  }

  private mapError(error: unknown): ChatGptPlanIdTokenError {
    if (error instanceof ChatGptPlanIdTokenError) return error;
    if (error instanceof joseErrors.JWTExpired) return new ChatGptPlanIdTokenError("expired");
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      if (error.claim === "iss") return new ChatGptPlanIdTokenError("issuer");
      if (error.claim === "aud") return new ChatGptPlanIdTokenError("audience");
      if (error.claim === "sub") return new ChatGptPlanIdTokenError("subject");
      return new ChatGptPlanIdTokenError("malformed");
    }
    if (
      error instanceof joseErrors.JWSSignatureVerificationFailed
      || error instanceof joseErrors.JWKSNoMatchingKey
      || error instanceof joseErrors.JOSEAlgNotAllowed
    ) {
      return new ChatGptPlanIdTokenError("signature");
    }
    return new ChatGptPlanIdTokenError("malformed");
  }
}
