import { CHATGPT_PLAN_ISSUER, CHATGPT_PLAN_USAGE_SCOPE } from "./endpoints.js";
import { ChatGptPlanIdTokenError, type ChatGptPlanIdTokenVerifier } from "./id-token.js";
import { fetchChatGptPlanModels, type ChatGptPlanModel } from "./models.js";
import {
  buildAuthorizationUrl,
  ChatGptPlanOAuthError,
  createAuthorizationAttempt,
  exchangeAuthorizationCode,
  isIssuedClientId,
  parseAuthorizationCallback,
  refreshAccessToken,
  revokeRefreshToken,
  verifyDiscoveryDocument,
  type ChatGptPlanAuthorizationTarget,
  type ChatGptPlanTokenResponse,
} from "./oauth.js";
import type { ChatGptPlanCallbackListener } from "./loopback.js";
import type { SubscriptionRuntimeNotice } from "../../shared/subscription-runtime.js";
import type { OpenOAuthLogin } from "../oauth-login.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

/** The settings-store surface the session needs: encrypted secrets only. */
export interface ChatGptPlanSecretStore {
  isSecretStorageEncrypted(): boolean;
  getEncryptedSecret(key: string): string | null;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

/** The one secret-store entry holding this install's account record. */
export const CHATGPT_PLAN_ACCOUNT_SECRET_KEY = "subscription.chatgptPlan.account";

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Bounded revocation retries for a network failure or 5xx. */
const REVOCATION_RETRY_DELAYS_MS = Object.freeze([500, 2_000, 5_000]);

interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly savedAt: number;
  readonly earliestRefreshAt?: number;
}

/**
 * One registration on this install. `subject` is null only for a registration
 * whose client id was issued but whose first code exchange was refused; the
 * next sign-in reauthorizes that client instead of registering again.
 */
interface AccountRecord {
  readonly version: 1;
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string | null;
  readonly email: string | null;
  readonly tokens: StoredTokens | null;
  readonly welcomed: boolean;
}

export type ChatGptPlanSessionFailure =
  | "secure-storage-unavailable"
  | "sign-in-in-progress"
  | "declined"
  | "sign-in-failed"
  | "account-mismatch"
  | "signed-out"
  | "reconnect-required"
  | "plan-usage-disabled"
  | "temporarily-unavailable"
  | "invalid-client"
  | "stored-record-invalid";

export class ChatGptPlanSessionError extends Error {
  constructor(readonly failure: ChatGptPlanSessionFailure) {
    super(`chatgpt-plan session ${failure}`);
    this.name = "ChatGptPlanSessionError";
  }
}

export type ChatGptPlanNotice = SubscriptionRuntimeNotice;

/** Renderer-safe projection: no token, client id, subject or host id. */
export interface ChatGptPlanStatus {
  readonly connection: "signed-out" | "pending" | "connected";
  readonly planUsage: "enabled" | "disabled" | null;
  readonly accountLabel: string | null;
  readonly notice: ChatGptPlanNotice | null;
}

/** Redacted observations for the audit log: codes only. */
export interface ChatGptPlanSessionEvent {
  readonly event:
    | "sign-in-started"
    | "sign-in-succeeded"
    | "sign-in-failed"
    | "refresh-failed"
    | "signed-out";
  readonly failure?: string;
}

export interface ChatGptPlanSessionOptions {
  readonly fetch: typeof fetch;
  readonly secrets: ChatGptPlanSecretStore;
  readonly hostId: () => Promise<string>;
  readonly openAuthorizationUrl: OpenOAuthLogin;
  /** Starts the loopback listener for one attempt; it completes only on a callback carrying `expectedState`. */
  readonly startListener: (expectedState: string) => Promise<ChatGptPlanCallbackListener>;
  readonly verifier: Pick<ChatGptPlanIdTokenVerifier, "verify">;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onEvent?: (event: ChatGptPlanSessionEvent) => void;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseRecord(raw: string): AccountRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ChatGptPlanSessionError("stored-record-invalid");
  }
  const record = value as Partial<AccountRecord> | null;
  const tokens = record?.tokens as Partial<StoredTokens> | null | undefined;
  const tokensValid = tokens === null || (
    tokens !== undefined
    && typeof tokens.accessToken === "string"
    && typeof tokens.refreshToken === "string"
    && typeof tokens.idToken === "string"
    && typeof tokens.expiresAt === "number"
    && typeof tokens.savedAt === "number"
    && isStringArray(tokens.scopes)
    && (tokens.earliestRefreshAt === undefined || typeof tokens.earliestRefreshAt === "number")
  );
  if (
    !record || record.version !== 1
    || record.issuer !== CHATGPT_PLAN_ISSUER
    || !isIssuedClientId(record.clientId)
    || (record.subject !== null && typeof record.subject !== "string")
    || (record.email !== null && typeof record.email !== "string")
    || typeof record.welcomed !== "boolean"
    || !tokensValid
    || (record.subject === null && record.tokens !== null)
  ) {
    throw new ChatGptPlanSessionError("stored-record-invalid");
  }
  return record as AccountRecord;
}

/**
 * Sign-in, token lifetime and sign-out for the plan connection.
 *
 * The record lives in the encrypted secret store only, replaced as a whole so
 * the access token, its expiry, the granted scopes and the rotating refresh
 * token always change together. Refreshes for the session are serialized in
 * this process; the main process is the only owner of the record.
 */
export class ChatGptPlanSession {
  private record: AccountRecord | null | undefined;
  private pending: { readonly listener: ChatGptPlanCallbackListener; readonly completion: Promise<void> } | null = null;
  private refreshing: Promise<StoredTokens> | null = null;
  private notice: ChatGptPlanNotice | null = null;
  /** The pending attempt is ending because the user cancelled it. */
  private cancelRequested = false;
  /** Set while signing out: no new refresh may start and rotate the token. */
  private signingOut = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ChatGptPlanSessionOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  status(): ChatGptPlanStatus {
    const record = this.load();
    const tokens = record?.tokens ?? null;
    const planUsage = tokens ? (tokens.scopes.includes(CHATGPT_PLAN_USAGE_SCOPE) ? "enabled" : "disabled") : null;
    const notice = this.notice ?? (planUsage === "disabled" ? "plan-usage-disabled" : null);
    return Object.freeze({
      connection: this.pending ? "pending" : tokens ? "connected" : "signed-out",
      planUsage,
      accountLabel: tokens ? record?.email ?? null : null,
      notice,
    });
  }

  /**
   * Open the system browser for sign-in. A saved registration reauthorizes
   * with its issued client id and retained hints; otherwise a new client is
   * registered. `requestConsent` asks again for a plan-usage grant the user
   * previously declined, and is set only by that explicit action.
   */
  async startSignIn(options: { readonly requestConsent?: boolean } = {}): Promise<{ readonly completion: Promise<void> }> {
    if (this.pending) throw new ChatGptPlanSessionError("sign-in-in-progress");
    if (!this.options.secrets.isSecretStorageEncrypted()) {
      throw new ChatGptPlanSessionError("secure-storage-unavailable");
    }
    const record = this.load();
    const hostId = await this.options.hostId();
    try {
      await verifyDiscoveryDocument(this.options.fetch);
    } catch (error) {
      this.emit({ event: "sign-in-failed", failure: failureCode(error) });
      throw new ChatGptPlanSessionError(
        error instanceof ChatGptPlanOAuthError && error.failure === "transient" ? "temporarily-unavailable" : "sign-in-failed",
      );
    }
    const target: ChatGptPlanAuthorizationTarget = record
      ? {
          kind: "reauthorize",
          clientId: record.clientId,
          ...(record.tokens?.idToken ? { idTokenHint: record.tokens.idToken } : {}),
          ...(record.email ? { loginHint: record.email } : {}),
          ...(options.requestConsent ? { requestConsent: true } : {}),
        }
      : { kind: "register" };
    const attempt = createAuthorizationAttempt();
    const listener = await this.options.startListener(attempt.state);
    const url = buildAuthorizationUrl({ attempt, redirectUri: listener.redirectUri, hostId, target });
    const completion = (async () => {
      try {
        const callbackUrl = await listener.callback;
        const result = parseAuthorizationCallback(callbackUrl, { state: attempt.state, target });
        if (result.kind === "declined") throw new ChatGptPlanSessionError("declined");
        let tokens: ChatGptPlanTokenResponse;
        try {
          tokens = await exchangeAuthorizationCode(this.options.fetch, {
            clientId: result.clientId,
            code: result.code,
            codeVerifier: attempt.codeVerifier,
            redirectUri: listener.redirectUri,
          });
        } catch (error) {
          // A refused code is discarded; a newly issued client is kept so the
          // next attempt reauthorizes it instead of registering again.
          if (!record && error instanceof ChatGptPlanOAuthError && error.failure === "invalid-grant") {
            await this.save({
              version: 1, issuer: CHATGPT_PLAN_ISSUER, clientId: result.clientId,
              subject: null, email: null, tokens: null, welcomed: false,
            });
          }
          throw error;
        }
        const identity = await this.options.verifier.verify(tokens.idToken!, {
          clientId: result.clientId,
          nonce: attempt.nonce,
        });
        if (record?.subject && identity.subject !== record.subject) {
          throw new ChatGptPlanSessionError("account-mismatch");
        }
        const planEnabled = tokens.scopes.includes(CHATGPT_PLAN_USAGE_SCOPE);
        const welcomed = record?.welcomed ?? false;
        await this.save({
          version: 1,
          issuer: identity.issuer,
          clientId: result.clientId,
          subject: identity.subject,
          email: identity.email,
          tokens: this.storedTokens(tokens, tokens.idToken!),
          welcomed: welcomed || planEnabled,
        });
        this.notice = planEnabled && !welcomed ? "welcome" : null;
        this.emit({ event: "sign-in-succeeded" });
      } catch (error) {
        this.emit({ event: "sign-in-failed", failure: failureCode(error) });
        // A cancelled attempt needs no explanation; any other ending says why it did not finish.
        this.notice = this.cancelRequested ? null : signInFailureNotice(error);
        throw error instanceof ChatGptPlanSessionError ? error : new ChatGptPlanSessionError("sign-in-failed");
      } finally {
        this.cancelRequested = false;
        listener.close();
        this.pending = null;
      }
    })();
    this.pending = { listener, completion };
    // The caller observes completion; an unobserved rejection must not crash main.
    completion.catch(() => undefined);
    this.emit({ event: "sign-in-started" });
    const openWindow = async () => {
      await this.options.openAuthorizationUrl(url, {
        completion: listener.callback,
        onCancel: () => listener.close(),
        timeoutMs: TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs,
      });
    };
    void openWindow().catch(async () => {
      listener.close();
      await completion.catch(() => undefined);
    });
    return { completion };
  }

  cancelSignIn(): void {
    if (!this.pending) return;
    this.cancelRequested = true;
    this.pending.listener.close();
  }

  /** Clear a notice the user dismissed. The welcome is shown once per install. */
  acknowledgeNotice(): void {
    this.notice = null;
  }

  /**
   * A current access token for plan-usage inference, refreshed near expiry.
   * Concurrent callers share one refresh so a rotating refresh token is
   * presented exactly once.
   */
  async accessToken(): Promise<string> {
    const record = this.load();
    if (!record?.tokens) throw new ChatGptPlanSessionError("signed-out");
    if (!record.tokens.scopes.includes(CHATGPT_PLAN_USAGE_SCOPE)) {
      throw new ChatGptPlanSessionError("plan-usage-disabled");
    }
    const now = this.now();
    const tokens = record.tokens;
    const expired = now >= tokens.expiresAt;
    const nearExpiry = now >= tokens.expiresAt - REFRESH_MARGIN_MS;
    const refreshAllowed = tokens.earliestRefreshAt === undefined || now >= tokens.earliestRefreshAt * 1000;
    if (!expired && !(nearExpiry && refreshAllowed)) return tokens.accessToken;
    return (await this.refresh()).accessToken;
  }

  /**
   * Refresh once to learn whether a rejected subscriber context means the
   * session is gone. A terminal refresh error ends the session; a successful
   * one leaves it connected.
   */
  async confirmSession(): Promise<void> {
    await this.refresh();
  }

  async listModels(): Promise<ChatGptPlanModel[]> {
    return fetchChatGptPlanModels(this.options.fetch, await this.accessToken());
  }

  /**
   * Stop using the session, end it at the provider, then clear the tokens.
   * The registration (client id and account) is kept for a later sign-in. A
   * revocation that could not be confirmed still clears local tokens and is
   * reported so the user can disconnect the app in ChatGPT settings.
   */
  async signOut(): Promise<void> {
    this.signingOut = true;
    try {
      this.cancelSignIn();
      // A refresh already in flight finishes and is saved first, so the token
      // revoked below is the latest rotation rather than a superseded one.
      if (this.refreshing) await this.refreshing.catch(() => undefined);
      const current = this.load();
      if (!current?.tokens) {
        this.notice = null;
        return;
      }
      const refreshToken = current.tokens.refreshToken;
      let confirmed = false;
      for (let attempt = 0; attempt <= REVOCATION_RETRY_DELAYS_MS.length && !confirmed; attempt += 1) {
        try {
          await revokeRefreshToken(this.options.fetch, { clientId: current.clientId, refreshToken });
          confirmed = true;
        } catch (error) {
          const transient = error instanceof ChatGptPlanOAuthError && error.failure === "transient";
          if (!transient || attempt === REVOCATION_RETRY_DELAYS_MS.length) break;
          await this.sleep(REVOCATION_RETRY_DELAYS_MS[attempt]!);
        }
      }
      await this.save({ ...current, tokens: null });
      this.notice = confirmed ? null : "revocation-unconfirmed";
      this.emit({ event: "signed-out", ...(confirmed ? {} : { failure: "revocation-unconfirmed" }) });
    } finally {
      this.signingOut = false;
    }
  }

  private refresh(): Promise<StoredTokens> {
    if (this.refreshing) return this.refreshing;
    if (this.signingOut) return Promise.reject(new ChatGptPlanSessionError("signed-out"));
    const run = (async () => {
      const record = this.load();
      if (!record?.tokens) throw new ChatGptPlanSessionError("signed-out");
      let response: ChatGptPlanTokenResponse;
      try {
        response = await refreshAccessToken(this.options.fetch, {
          clientId: record.clientId,
          refreshToken: record.tokens.refreshToken,
        });
      } catch (error) {
        this.emit({ event: "refresh-failed", failure: failureCode(error) });
        if (error instanceof ChatGptPlanOAuthError && error.failure === "refresh-token-unusable") {
          await this.save({ ...record, tokens: null });
          this.notice = "reconnect-required";
          throw new ChatGptPlanSessionError("reconnect-required");
        }
        if (error instanceof ChatGptPlanOAuthError && error.failure === "invalid-client") {
          throw new ChatGptPlanSessionError("invalid-client");
        }
        throw new ChatGptPlanSessionError("temporarily-unavailable");
      }
      let idToken = record.tokens.idToken;
      if (response.idToken) {
        try {
          await this.options.verifier.verify(response.idToken, {
            clientId: record.clientId,
            ...(record.subject ? { subject: record.subject } : {}),
          });
          idToken = response.idToken;
        } catch (error) {
          if (!(error instanceof ChatGptPlanIdTokenError) || error.failure !== "jwks-unavailable") {
            // A rotated ID token that fails its signature, issuer, audience or subject check is not this account's:
            // nothing from the response is stored, and the superseded refresh token cannot be reused.
            this.emit({ event: "refresh-failed", failure: failureCode(error) });
            await this.save({ ...record, tokens: null });
            this.notice = "reconnect-required";
            throw new ChatGptPlanSessionError("reconnect-required");
          }
          // The issuer's keys could not be fetched, so the new ID token is unverified. The refresh itself succeeded
          // and the old refresh token is now spent, so keep the rotated tokens and the previous, verified ID token.
          this.emit({ event: "refresh-failed", failure: "id-token-jwks-unavailable" });
        }
      }
      const tokens = this.storedTokens(response, idToken);
      await this.save({ ...record, tokens });
      return tokens;
    })();
    this.refreshing = run;
    void run.finally(() => {
      if (this.refreshing === run) this.refreshing = null;
    }).catch(() => undefined);
    return run;
  }

  private storedTokens(response: ChatGptPlanTokenResponse, idToken: string): StoredTokens {
    const savedAt = this.now();
    return Object.freeze({
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      idToken,
      expiresAt: savedAt + response.expiresIn * 1000,
      scopes: response.scopes,
      savedAt,
      ...(response.earliestRefreshAt !== undefined ? { earliestRefreshAt: response.earliestRefreshAt } : {}),
    });
  }

  private load(): AccountRecord | null {
    if (this.record !== undefined) return this.record;
    const raw = this.options.secrets.getEncryptedSecret(CHATGPT_PLAN_ACCOUNT_SECRET_KEY);
    this.record = raw === null ? null : parseRecord(raw);
    return this.record;
  }

  private async save(record: AccountRecord): Promise<void> {
    if (!this.options.secrets.isSecretStorageEncrypted()) {
      throw new ChatGptPlanSessionError("secure-storage-unavailable");
    }
    await this.options.secrets.setSecret(CHATGPT_PLAN_ACCOUNT_SECRET_KEY, JSON.stringify(record));
    this.record = record;
  }

  private emit(event: ChatGptPlanSessionEvent): void {
    try {
      this.options.onEvent?.(Object.freeze({ ...event }));
    } catch {
      // Auditing never changes a session outcome.
    }
  }
}

function signInFailureNotice(error: unknown): ChatGptPlanNotice {
  if (error instanceof ChatGptPlanSessionError) {
    if (error.failure === "declined") return "declined";
    if (error.failure === "account-mismatch") return "account-mismatch";
  }
  if (error instanceof ChatGptPlanOAuthError) {
    if (error.failure === "state-mismatch") return "state-mismatch";
    // A returning sign-in that came back bound to another workspace's client is another account here.
    if (error.failure === "client-mismatch") return "account-mismatch";
  }
  return "sign-in-failed";
}

function failureCode(error: unknown): string {
  if (error instanceof ChatGptPlanOAuthError) return `oauth-${error.failure}`;
  if (error instanceof ChatGptPlanSessionError) return error.failure;
  if (error instanceof Error && error.name === "ChatGptPlanIdTokenError") {
    return `id-token-${(error as Error & { failure?: string }).failure ?? "rejected"}`;
  }
  return "unexpected";
}
