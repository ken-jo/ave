import { createHash, randomBytes } from "node:crypto";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  isHttpsUrl,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
  type AuthorizationServerMetadata,
  type OAuthClientInformationFull,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ensurePublicHttpUrl } from "../core/network-guard.js";
import { AVE_SERVICE_BASE_URL } from "../marketplace/service/client.js";
import type { AuthRedirectCatchers } from "../main/auth-redirect-catcher.js";
import type { OpenOAuthLogin } from "../main/oauth-login.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { runWithCeiling } from "../tools/executor-ceiling.js";
import type { McpAuthErrorCode, McpAuthStatus, McpHttpServerConfig } from "./types.js";
import { isValidOAuthClientId } from "./safe-names.js";
import { MCP_PROTOCOL_VERSION } from "./protocol-constants.js";

export interface McpOAuthSecrets {
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  canStoreEncrypted(): boolean;
}

export interface McpOAuthDependencies {
  networkFetch: typeof fetch;
  secrets: McpOAuthSecrets;
  redirectCatchers: AuthRedirectCatchers;
  openAuthorizationUrl: OpenOAuthLogin;
}

export interface McpOAuthSessionOptions {
  /** Wait for same-key predecessor writes before loading rotated refresh tokens. */
  after?: Promise<void>;
  initialStatus?: McpAuthStatus;
}

type ClientSource = "preregistered" | "metadata-document" | "dynamic";

/** Published client metadata URL is the stable client_id and must never move. */
export const MCP_CLIENT_METADATA_DOCUMENT_URL = `${AVE_SERVICE_BASE_URL}/oauth/mcp-client.json`;

interface Discovery {
  issuer: string;
  resource: string;
  resourceMetadataUrl?: string;
  resourceMetadataFromChallenge: boolean;
  metadata: AuthorizationServerMetadata;
  requireIssuerResponse: boolean;
  scope?: string;
}

interface Credentials {
  serverUrl: string;
  issuer: string;
  resource: string;
  resourceMetadataUrl?: string;
  resourceMetadataFromChallenge?: boolean;
  client: OAuthClientInformationFull;
  clientSource: ClientSource;
  tokens?: OAuthTokens;
  expiresAt?: number;
  grantedScope?: string;
}

const MESSAGES: Record<McpAuthErrorCode, string> = {
  "mcp-auth-required": "MCP authentication required",
  "mcp-auth-failed": "MCP authentication failed",
  "mcp-auth-storage-unavailable": "MCP authorization requires encrypted storage",
  "mcp-auth-storage-unreadable": "MCP authorization storage cannot be read",
  "mcp-auth-registration-unsupported": "MCP client registration mode is not supported",
  "mcp-auth-resource-mismatch": "MCP authorization metadata names a different resource",
  "mcp-auth-index-unreadable": "MCP authorization credential index cannot be read",
};
const AUTH_FAILED = MESSAGES["mcp-auth-failed"];
const AUTH_REQUIRED = MESSAGES["mcp-auth-required"];
const MAX_AUTH_RESPONSE_BYTES = 1024 * 1024;
const MAX_STEP_UP_ATTEMPTS = 2;

/** Authorization failures use fixed messages, never provider-controlled text. */
export class McpOAuthError extends Error {
  constructor(readonly code: McpAuthErrorCode) {
    super(MESSAGES[code]);
    this.name = "McpOAuthError";
  }
}

class McpOAuthBindingChangedError extends Error {
  constructor() { super(AUTH_REQUIRED); }
}

class MetadataDocumentRejectedError extends Error {
  constructor(readonly issuer: string) { super(AUTH_FAILED); }
}

/** Validate token responses before storing or attaching them. */
function validateTokens(tokens: OAuthTokens): void {
  if (tokens.token_type.toLowerCase() !== "bearer" || !/^[A-Za-z0-9._~+/-]+=*$/u.test(tokens.access_token) ||
    (tokens.expires_in !== undefined && (!Number.isSafeInteger(tokens.expires_in) || tokens.expires_in < 0))) {
    throw new Error(AUTH_FAILED);
  }
}

function secureUrl(raw: string, allowLoopback: boolean): URL {
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash ||
      (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))) {
      throw new Error(AUTH_FAILED);
    }
    return url;
  } catch {
    throw new Error(AUTH_FAILED);
  }
}

/** RFC 8707 canonical form: no trailing slash for an origin-only resource. */
function canonicalResource(url: URL): string {
  return url.pathname === "/" && !url.search ? url.origin : url.href;
}

/** Query-bearing resources match only the exact endpoint, not containing paths. */
function resourceContainsEndpoint(resource: URL, endpoint: URL): boolean {
  return resource.href === endpoint.href ||
    (!resource.search && checkResourceAllowed({ requestedResource: endpoint, configuredResource: resource }));
}

function scopeSet(...values: Array<string | undefined>): string[] {
  return [...new Set(values.join(" ").split(/\s+/u).filter(Boolean))];
}

/** Only credential identity fields revoke grants; unrelated config edits retain them. */
function credentialKeyInputs(config: McpHttpServerConfig): string {
  const serverUrl = secureUrl(config.url, config.allowPrivateNetworks === true).href;
  return JSON.stringify([config.id, serverUrl, config.oauth]);
}

/** Invalid OAuth targets cannot create credential keys. */
function mcpOAuthCredentialKey(config: McpHttpServerConfig): string {
  return `mcp.oauth.${createHash("sha256").update(credentialKeyInputs(config)).digest("hex")}`;
}

export function tryMcpOAuthCredentialKey(config: McpHttpServerConfig): string | undefined {
  try { return mcpOAuthCredentialKey(config); }
  catch { return undefined; }
}

/** Reject contradictory registration modes rather than silently selecting one. */
function registrationBlock(config: McpHttpServerConfig): McpAuthErrorCode | undefined {
  const mode = config.oauth?.clientRegistration;
  const clientId = config.oauth?.clientId;
  if (clientId !== undefined) {
    return isValidOAuthClientId(clientId) && (mode === undefined || mode === "preregistration" || mode === "manual")
      ? undefined : "mcp-auth-registration-unsupported";
  }
  return mode === undefined || mode === "dynamic" || mode === "client-id-metadata-document"
    ? undefined : "mcp-auth-registration-unsupported";
}

export class McpOAuthSession {
  static async clearStoredCredentials(config: McpHttpServerConfig, secrets: McpOAuthSecrets): Promise<void> {
    const key = tryMcpOAuthCredentialKey(config);
    if (!key) return;
    try { await secrets.deleteSecret(key); }
    catch { throw new Error(AUTH_FAILED); }
  }

  readonly fetch: typeof fetch;
  readonly credentialKey: string;
  private readonly serverUrl: string;
  private readonly endpointResource: string;
  private readonly ownerKey = `mcp-oauth:${randomBytes(16).toString("hex")}`;
  private readonly controller = new AbortController();
  private status: McpAuthStatus = "required";
  private blocked?: McpAuthErrorCode;
  private credentials?: Credentials;
  private challengeMetadataUrl?: URL;
  private challengeScope?: string;
  private pendingStepUp?: string;
  private readonly stepUpAttempts = new Map<string, number>();
  private login?: Promise<void>;
  private refresh?: Promise<boolean>;
  private pendingWrite: Promise<void> = Promise.resolve();
  private credentialGeneration = 0;
  private challengeProbeAvailable = true;
  private readonly metadataDocumentRejected = new Set<string>();
  private readonly ready: Promise<void>;

  constructor(private readonly config: McpHttpServerConfig, private readonly dependencies: McpOAuthDependencies,
    options: McpOAuthSessionOptions = {}) {
    this.serverUrl = secureUrl(config.url, config.allowPrivateNetworks === true).href;
    this.endpointResource = canonicalResource(new URL(this.serverUrl));
    this.credentialKey = mcpOAuthCredentialKey(config);
    this.blocked = registrationBlock(config);
    if (this.blocked) {
      this.status = "error";
      this.ready = Promise.resolve();
    } else if (options.after) {
      this.status = options.initialStatus ?? "required";
      this.ready = options.after.catch(() => {}).then(() => {
        if (!this.controller.signal.aborted) {
          this.status = "required";
          this.loadStored();
        }
      });
    } else {
      this.loadStored();
      this.ready = Promise.resolve();
    }
    this.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => this.fetchResource(input, init)) as typeof fetch;
  }

  getStatus(): McpAuthStatus { return this.status; }

  getBlockedCode(): McpAuthErrorCode | undefined { return this.blocked; }

  private loadStored(): void {
    let raw: string | null;
    try { raw = this.dependencies.secrets.getSecret(this.credentialKey); }
    catch {
      this.blocked = "mcp-auth-storage-unreadable";
      this.status = "error";
      return;
    }
    if (this.blocked === "mcp-auth-storage-unreadable") {
      this.blocked = undefined;
      this.status = "required";
    }
    const allowPrivate = this.config.allowPrivateNetworks === true;
    try {
      if (!raw) return;
      const saved = JSON.parse(raw) as Credentials;
      if (saved.serverUrl !== this.serverUrl || typeof saved.issuer !== "string" || typeof saved.resource !== "string" ||
        !["preregistered", "metadata-document", "dynamic"].includes(saved.clientSource)) return;
      if (secureUrl(saved.issuer, allowPrivate).search ||
        (this.config.oauth?.authorizationServers?.length && !this.config.oauth.authorizationServers.includes(saved.issuer))) return;
      const resource = secureUrl(saved.resource, allowPrivate);
      const resourceId = canonicalResource(resource);
      if (!resourceContainsEndpoint(resource, new URL(this.serverUrl)) ||
        (saved.resourceMetadataFromChallenge === true && resourceId !== this.endpointResource) ||
        (this.config.oauth?.resource && resourceId !== canonicalResource(secureUrl(this.config.oauth.resource, allowPrivate)))) return;
      const credentials: Credentials = {
        serverUrl: saved.serverUrl, issuer: saved.issuer, resource: resourceId,
        client: OAuthClientInformationFullSchema.parse(saved.client),
        clientSource: saved.clientSource,
        tokens: saved.tokens ? OAuthTokensSchema.parse(saved.tokens) : undefined,
        expiresAt: typeof saved.expiresAt === "number" && Number.isFinite(saved.expiresAt) ? saved.expiresAt : undefined,
        resourceMetadataUrl: typeof saved.resourceMetadataUrl === "string"
          ? secureUrl(saved.resourceMetadataUrl, allowPrivate).href : undefined,
        resourceMetadataFromChallenge: saved.resourceMetadataFromChallenge === true,
      };
      credentials.grantedScope = typeof saved.grantedScope === "string" ? saved.grantedScope : credentials.tokens?.scope;
      this.credentials = credentials;
      if (credentials.tokens) {
        this.status = "authenticated";
        this.challengeProbeAvailable = false;
      }
    } catch {  }
  }

  authenticate(): Promise<void> {
    if (!this.login) {
      this.login = this.authenticateOnce().finally(() => { this.login = undefined; });
    }
    return this.login;
  }

  /** Let same-key refreshes finish and persist before disposal so the successor reads rotated tokens. */
  async handOff(): Promise<void> {
    for (;;) {
      const refresh = this.refresh;
      const write = this.pendingWrite;
      await Promise.allSettled([refresh, write]);
      if (this.refresh === undefined && this.pendingWrite === write) break;
    }
    this.dispose();
  }

  dispose(): void {
    this.credentialGeneration += 1;
    this.controller.abort();
    this.dependencies.redirectCatchers.closeAllFor(this.ownerKey);
    this.credentials = undefined;
    this.status = "required";
  }

  async clear(): Promise<void> {
    this.dispose();
    await this.pendingWrite.catch(() => {});
    try { await this.dependencies.secrets.deleteSecret(this.credentialKey); }
    catch { throw new Error(AUTH_FAILED); }
  }

  private assertActive(): void {
    if (this.controller.signal.aborted) throw new Error(AUTH_FAILED);
  }

  private async save(): Promise<void> {
    this.assertActive();
    const serialized = JSON.stringify(this.credentials);
    this.pendingWrite = this.pendingWrite.catch(() => {}).then(async () => {
      this.assertActive();
      await this.dependencies.secrets.setSecret(this.credentialKey, serialized);
    });
    await this.pendingWrite;
    this.assertActive();
  }

  private readonly authFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.assertActive();
    const raw = input instanceof Request ? input.url : String(input);
    const url = secureUrl(raw, this.config.allowPrivateNetworks === true);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? AbortSignal.any([this.controller.signal, callerSignal]) : this.controller.signal;
    const outcome = await runWithCeiling(async (abortSignal) => {
      await ensurePublicHttpUrl(url.href, {
        allowPrivateNetworks: this.config.allowPrivateNetworks === true,
        allowLoopback: this.config.allowPrivateNetworks === true,
      });
      const response = await this.dependencies.networkFetch(input, { ...init, redirect: "error", signal: abortSignal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error(AUTH_FAILED);
      }
      if (response.status >= 500 || response.status === 429 || response.status === 408) {
        await response.body?.cancel();
        return new Response(JSON.stringify({ error: "server_error" }), {
          status: response.status, headers: { "content-type": "application/json" },
        });
      }
      // Consume metadata/token bodies inside the ceiling, including stalled bodies.
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (reader) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > MAX_AUTH_RESPONSE_BYTES) throw new Error(AUTH_FAILED);
          chunks.push(next.value);
        }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      return new Response(new Uint8Array(Buffer.concat(chunks)), { status: response.status, headers: response.headers });
    }, TOOL_TIMEOUT_POLICY.networkFetchDefaultMs, signal, "MCP authorization");
    if (!outcome.ok) throw new Error(AUTH_FAILED);
    this.assertActive();
    return outcome.value;
  }) as typeof fetch;

  private async discover(interactive = false): Promise<Discovery> {
    const allowPrivate = this.config.allowPrivateNetworks === true;
    let resourceMetadataUrl: URL | undefined;
    let resourceMetadataFromChallenge = false;
    if (this.challengeMetadataUrl) {
      resourceMetadataUrl = this.challengeMetadataUrl;
      resourceMetadataFromChallenge = true;
    } else if (this.config.oauth?.resourceMetadataUrl) {
      resourceMetadataUrl = secureUrl(this.config.oauth.resourceMetadataUrl, allowPrivate);
    } else if (this.credentials?.resourceMetadataUrl) {
      resourceMetadataUrl = secureUrl(this.credentials.resourceMetadataUrl, allowPrivate);
      resourceMetadataFromChallenge = this.credentials.resourceMetadataFromChallenge === true;
    }
    const resource = await discoverOAuthProtectedResourceMetadata(this.serverUrl, { resourceMetadataUrl, protocolVersion: MCP_PROTOCOL_VERSION }, this.authFetch);
    const resourceUrl = secureUrl(resource.resource, allowPrivate);
    const resourceId = canonicalResource(resourceUrl);
    // Challenge metadata must match the exact resource; well-known metadata may describe a containing path.
    if (resourceMetadataFromChallenge
      ? resourceId !== this.endpointResource
      : !resourceContainsEndpoint(resourceUrl, new URL(this.serverUrl))) throw new McpOAuthError("mcp-auth-resource-mismatch");
    if (this.config.oauth?.resource && resourceId !== canonicalResource(secureUrl(this.config.oauth.resource, allowPrivate))) {
      throw new McpOAuthError("mcp-auth-resource-mismatch");
    }
    const configuredIssuers = this.config.oauth?.authorizationServers;
    const issuer = resource.authorization_servers?.find((candidate) => !configuredIssuers?.length || configuredIssuers.includes(candidate));
    if (!issuer) throw new Error(AUTH_FAILED);
    if (secureUrl(issuer, allowPrivate).search) throw new Error(AUTH_FAILED);
    // Discovery parsing may strip extension fields, so retain this security capability before parsing.
    let requireIssuerResponse = false;
    const metadataFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await this.authFetch(input, init);
      if (response.ok) {
        const raw = await response.clone().json() as Record<string, unknown>;
        if (raw.authorization_response_iss_parameter_supported !== undefined &&
          typeof raw.authorization_response_iss_parameter_supported !== "boolean") throw new Error(AUTH_FAILED);
        requireIssuerResponse = raw.authorization_response_iss_parameter_supported === true;
      }
      return response;
    }) as typeof fetch;
    const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: metadataFetch, protocolVersion: MCP_PROTOCOL_VERSION });
    if (!metadata || metadata.issuer !== issuer || !metadata.code_challenge_methods_supported?.includes("S256")) throw new Error(AUTH_FAILED);
    secureUrl(metadata.authorization_endpoint, allowPrivate);
    if (!metadata.token_endpoint) throw new Error(AUTH_FAILED);
    secureUrl(metadata.token_endpoint, allowPrivate);
    if (metadata.registration_endpoint) secureUrl(metadata.registration_endpoint, allowPrivate);
    if (this.credentials && (this.credentials.resource !== resourceId || this.credentials.issuer !== issuer)) {
      if (!interactive) throw new McpOAuthBindingChangedError();
      this.credentials = undefined;
      const generation = ++this.credentialGeneration;
      await this.removeStoredCredentials(generation);
    }
    const selectedScope = this.challengeScope || this.config.oauth?.scopes?.join(" ") || resource.scopes_supported?.join(" ");
    const scope = scopeSet(selectedScope, this.credentials?.grantedScope).join(" ") || undefined;
    return { issuer, resource: resourceId, resourceMetadataUrl: resourceMetadataUrl?.href, resourceMetadataFromChallenge,
      metadata, requireIssuerResponse, scope };
  }

  /** Reuse registration only if it covers this flow loopback redirect, whose port changes each time. */
  private async selectClient(discovery: Discovery, redirectUri: string): Promise<{ client: OAuthClientInformationFull; source: ClientSource }> {
    const mode = this.config.oauth?.clientRegistration;
    // Prefer pre-registration, then advertised client metadata, then dynamic registration.
    const clientId = this.config.oauth?.clientId;
    if (clientId !== undefined) {
      return { source: "preregistered", client: { client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" } };
    }
    const metadataDocumentUsable = discovery.metadata.client_id_metadata_document_supported === true &&
      (!discovery.metadata.token_endpoint_auth_methods_supported || discovery.metadata.token_endpoint_auth_methods_supported.includes("none"));
    if ((mode === "client-id-metadata-document" || (mode === undefined && !this.metadataDocumentRejected.has(discovery.issuer))) &&
      metadataDocumentUsable) {
      if (!isHttpsUrl(MCP_CLIENT_METADATA_DOCUMENT_URL)) throw new Error(AUTH_FAILED);
      return { source: "metadata-document", client: { client_id: MCP_CLIENT_METADATA_DOCUMENT_URL,
        redirect_uris: [redirectUri], token_endpoint_auth_method: "none" } };
    }
    if (mode === "client-id-metadata-document") throw new McpOAuthError("mcp-auth-registration-unsupported");
    const stored = this.credentials;
    const secretExpiresAt = stored?.client.client_secret_expires_at;
    const storedUsable = stored && stored.clientSource === "dynamic" && stored.issuer === discovery.issuer &&
      !(secretExpiresAt && secretExpiresAt <= Date.now() / 1000) &&
      stored.client.redirect_uris.includes(redirectUri);
    if (storedUsable) return { client: stored.client, source: stored.clientSource };
    if (!discovery.metadata.registration_endpoint) throw new McpOAuthError("mcp-auth-registration-unsupported");
    const clientMetadata = { client_name: "Ave", redirect_uris: [redirectUri], application_type: "native",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
    const client = await registerClient(discovery.issuer, {
      metadata: discovery.metadata,
      clientMetadata,
      scope: discovery.scope, fetchFn: this.authFetch,
    });
    const method = client.token_endpoint_auth_method;
    // A secret-bearing method must be one the token endpoint advertises. "none" is exempt: the server
    // just issued this public client, and some servers (GitLab) list only their secret methods.
    if (method && (!["none", "client_secret_basic", "client_secret_post"].includes(method) ||
      (method !== "none" && !client.client_secret) ||
      (method !== "none" && discovery.metadata.token_endpoint_auth_methods_supported &&
        !discovery.metadata.token_endpoint_auth_methods_supported.includes(method)))) {
      throw new Error(AUTH_FAILED);
    }
    if (!client.redirect_uris.includes(redirectUri)) throw new Error(AUTH_FAILED);
    return { client, source: "dynamic" };
  }

  private async authenticateOnce(): Promise<void> {
    await this.ready;
    try {
      await this.authorizeInteractively();
    } catch (error) {
      // Only an unspecified mode may retry rejected client metadata through dynamic registration.
      if (!(error instanceof MetadataDocumentRejectedError)) throw error;
      this.metadataDocumentRejected.add(error.issuer);
      await this.authorizeInteractively();
    }
  }

  private async authorizeInteractively(): Promise<void> {
    const previousStatus = this.status;
    const stepUp = this.pendingStepUp;
    let handle: string | undefined;
    let client: OAuthClientInformationFull | undefined;
    let source: ClientSource | undefined;
    let issuer: string | undefined;
    try {
      this.assertActive();
      if (this.blocked === "mcp-auth-storage-unreadable") this.loadStored();
      if (this.blocked) throw new McpOAuthError(this.blocked);
      // Refuse before any network activity, browser, or registration that could not be persisted.
      if (!this.dependencies.secrets.canStoreEncrypted()) throw new McpOAuthError("mcp-auth-storage-unavailable");
      this.credentialGeneration += 1;
      this.status = "authenticating";
      const discovery = await this.discover(true);
      const state = randomBytes(32).toString("base64url");
      // The loopback IP literal: RFC 8252 §7.3 obliges the server to accept any port for it.
      const catcher = await this.dependencies.redirectCatchers.open(this.ownerKey, { state, redirectHost: "127.0.0.1" });
      handle = catcher.handle;
      this.assertActive();
      issuer = discovery.issuer;
      ({ client, source } = await this.selectClient(discovery, catcher.redirectUri));
      this.assertActive();
      const authorization = await startAuthorization(discovery.issuer, { metadata: discovery.metadata, clientInformation: client,
        redirectUrl: catcher.redirectUri, state, scope: discovery.scope, resource: discovery.resource });
      await ensurePublicHttpUrl(authorization.authorizationUrl.href, {
        allowPrivateNetworks: this.config.allowPrivateNetworks === true,
        allowLoopback: this.config.allowPrivateNetworks === true,
      });
      this.assertActive();
      const callback = this.dependencies.redirectCatchers.wait(this.ownerKey, handle, TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs);
      void callback.catch(() => undefined);
      const closeCatcher = () => this.dependencies.redirectCatchers.close(this.ownerKey, catcher.handle);
      const opened = await runWithCeiling(
        async (signal) => {
          signal.addEventListener("abort", closeCatcher, { once: true });
          try {
            await this.dependencies.openAuthorizationUrl(authorization.authorizationUrl.href, {
              completion: callback, onCancel: closeCatcher, timeoutMs: TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs,
            });
          } finally {
            signal.removeEventListener("abort", closeCatcher);
          }
        },
        TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs, this.controller.signal, "MCP authentication",
      );
      if (!opened.ok) throw new Error(AUTH_FAILED);
      this.assertActive();
      const params = await callback;
      // Verify state and issuer before acting on any callback, including errors.
      if (params.state !== state || (params.iss !== undefined && params.iss !== discovery.issuer) ||
        (discovery.requireIssuerResponse && !params.iss)) throw new Error(AUTH_FAILED);
      if (params.error === "invalid_client" || params.error === "unauthorized_client") {
        throw new InvalidClientError("authorization response rejected the client");
      }
      if (!params.code || params.error !== undefined) throw new Error(AUTH_FAILED);
      const tokens = await exchangeAuthorization(discovery.issuer, { metadata: discovery.metadata, clientInformation: client,
        authorizationCode: params.code, codeVerifier: authorization.codeVerifier, redirectUri: catcher.redirectUri,
        resource: discovery.resource, fetchFn: this.authFetch });
      this.assertActive();
      // Refuse a malformed token response before it can displace a working grant.
      validateTokens(tokens);
      this.credentials = {
        serverUrl: this.serverUrl, issuer: discovery.issuer, resource: discovery.resource,
        resourceMetadataUrl: discovery.resourceMetadataUrl, resourceMetadataFromChallenge: discovery.resourceMetadataFromChallenge,
        client, clientSource: source,
        grantedScope: this.credentials?.issuer === discovery.issuer ? this.credentials.grantedScope : undefined,
      };
      if (stepUp) {
        this.stepUpAttempts.set(stepUp, (this.stepUpAttempts.get(stepUp) ?? 0) + 1);
        if (this.pendingStepUp === stepUp) this.pendingStepUp = undefined;
      }
      await this.acceptTokens(tokens, discovery.scope);
    } catch (error) {
      if (this.controller.signal.aborted) this.status = "required";
      else if (this.credentials?.tokens && (previousStatus === "authenticated" || previousStatus === "insufficient_scope")) {
        // A cancelled or failed step-up leaves the working grant (and its tools) in place.
        this.status = previousStatus;
      } else this.status = "error";
      if (!this.controller.signal.aborted && source === "metadata-document" && issuer &&
        this.config.oauth?.clientRegistration === undefined && !this.metadataDocumentRejected.has(issuer) &&
        (error instanceof InvalidClientError || error instanceof UnauthorizedClientError)) {
        this.status = previousStatus;
        throw new MetadataDocumentRejectedError(issuer);
      }
      if (error instanceof McpOAuthError && error.code !== "mcp-auth-required" && error.code !== "mcp-auth-failed") throw error;
      throw new Error(AUTH_FAILED);
    } finally {
      if (handle) this.dependencies.redirectCatchers.close(this.ownerKey, handle);
    }
  }

  private async acceptTokens(tokens: OAuthTokens, requestedScope?: string): Promise<void> {
    this.assertActive();
    if (!this.credentials) throw new Error(AUTH_FAILED);
    validateTokens(tokens);
    const generation = ++this.credentialGeneration;
    this.challengeProbeAvailable = false;
    this.credentials.grantedScope = tokens.scope ?? requestedScope ?? this.credentials.grantedScope;
    this.credentials.tokens = tokens;
    this.credentials.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
    await this.save();
    if (this.credentialGeneration === generation) this.status = this.pendingStepUp ? "insufficient_scope" : "authenticated";
  }

  private refreshTokens(): Promise<boolean> {
    if (!this.refresh) this.refresh = this.refreshOnce().finally(() => { this.refresh = undefined; });
    return this.refresh;
  }

  private async refreshOnce(): Promise<boolean> {
    const credentials = this.credentials;
    const generation = this.credentialGeneration;
    const refreshToken = credentials?.tokens?.refresh_token;
    let acceptedGeneration: number | undefined;
    const isCurrent = (): boolean => this.credentialGeneration === generation && credentials === this.credentials &&
      refreshToken === this.credentials?.tokens?.refresh_token;
    try {
      if (!credentials || !refreshToken) {
        this.status = "required";
        return false;
      }
      const discovery = await this.discover();
      if (!isCurrent()) return Boolean(this.credentials?.tokens);
      credentials.resourceMetadataUrl = discovery.resourceMetadataUrl;
      credentials.resourceMetadataFromChallenge = discovery.resourceMetadataFromChallenge;
      const tokens = await refreshAuthorization(discovery.issuer, { metadata: discovery.metadata, clientInformation: credentials.client,
        refreshToken, resource: discovery.resource, fetchFn: this.authFetch });
      if (!isCurrent()) return Boolean(this.credentials?.tokens);
      const accepted = this.acceptTokens(tokens);
      acceptedGeneration = this.credentialGeneration;
      await accepted;
      return true;
    } catch (error) {
      if (!isCurrent() && this.credentialGeneration !== acceptedGeneration) return Boolean(this.credentials?.tokens);
      if (error instanceof InvalidGrantError || error instanceof InvalidClientError || error instanceof UnauthorizedClientError || error instanceof McpOAuthBindingChangedError) {
        this.credentialGeneration += 1;
        this.status = "required";
        if (error instanceof InvalidClientError || error instanceof UnauthorizedClientError) {
          this.credentials = undefined;
          const clearedGeneration = this.credentialGeneration;
          await this.removeStoredCredentials(clearedGeneration).catch(() => {});
        } else if (this.credentials) {
          this.credentials.tokens = undefined;
          this.credentials.expiresAt = undefined;
          if (!this.controller.signal.aborted) await this.save().catch(() => {});
        }
      } else {
        this.status = this.controller.signal.aborted ? "required" : "error";
      }
      return false;
    }
  }

  private async removeStoredCredentials(generation: number): Promise<void> {
    this.pendingWrite = this.pendingWrite.catch(() => {}).then(async () => {
      if (this.credentialGeneration === generation) await this.dependencies.secrets.deleteSecret(this.credentialKey);
    });
    await this.pendingWrite;
    this.assertActive();
  }

  private async fetchResource(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      await this.ready;
      this.assertActive();
      if (this.blocked) throw new McpOAuthError(this.blocked);
      const request = new Request(input, init);
      if (new URL(request.url).href !== this.serverUrl) throw new Error(AUTH_FAILED);
      let refreshed = false;
      if (this.credentials?.tokens && this.credentials.expiresAt !== undefined && this.credentials.expiresAt <= Date.now()) {
        refreshed = true;
        if (!await this.refreshTokens()) throw new Error(AUTH_REQUIRED);
      }
      let sentGeneration = this.credentialGeneration;
      let sentToken = false;
      const send = async (): Promise<Response> => {
        this.assertActive();
        sentGeneration = this.credentialGeneration;
        const generation = sentGeneration;
        const accessToken = this.credentials?.tokens?.access_token;
        if (!accessToken && !this.challengeProbeAvailable) throw new Error(AUTH_REQUIRED);
        this.challengeProbeAvailable = false;
        sentToken = Boolean(accessToken);
        const headers = new Headers(request.headers);
        headers.delete("authorization");
        if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
        let response: Response;
        try {
          response = await this.dependencies.networkFetch(new Request(request.clone(), { headers, redirect: "error",
            signal: AbortSignal.any([this.controller.signal, request.signal]) }));
        } catch (error) {
          if (!accessToken && this.credentialGeneration === generation) this.challengeProbeAvailable = true;
          throw error;
        }
        // The initial unauthenticated request can discover a challenge, never publish capabilities.
        if (!accessToken && response.ok) {
          await response.body?.cancel();
          throw new Error(AUTH_REQUIRED);
        }
        return response;
      };
      const settle = async (response: Response): Promise<Response> => {
        if (response.status === 403 && sentToken) this.captureStepUp(response);
        return this.sanitizedResourceResponse(response);
      };
      let response = await send();
      if (response.status !== 401) return await settle(response);
      this.captureChallenge(response);
      await response.body?.cancel();
      if (!refreshed && this.credentials?.tokens && sentGeneration !== this.credentialGeneration) {
        refreshed = true;
        response = await send();
        if (response.status !== 401) return await settle(response);
        this.captureChallenge(response);
        await response.body?.cancel();
      }
      if (!refreshed && this.credentials?.tokens?.refresh_token) {
        if (!await this.refreshTokens()) throw new Error(AUTH_REQUIRED);
        response = await send();
        if (response.status !== 401) return await settle(response);
        this.captureChallenge(response);
        await response.body?.cancel();
      }
      if (sentGeneration !== this.credentialGeneration && this.credentials?.tokens) throw new Error(AUTH_FAILED);
      this.credentialGeneration += 1;
      this.status = "required";
      if (this.credentials?.tokens) {
        this.credentials.tokens = undefined;
        this.credentials.expiresAt = undefined;
        await this.save();
      }
      throw new Error(AUTH_REQUIRED);
    } catch {
      throw new Error(this.status === "required" ? AUTH_REQUIRED : AUTH_FAILED);
    }
  }

  private captureChallenge(response: Response): void {
    const challenge = extractWWWAuthenticateParams(response);
    this.challengeMetadataUrl = challenge.resourceMetadataUrl;
    this.challengeScope = challenge.scope;
  }

  /** Scope challenges preserve working grants and require explicit authentication for step-up.
     * Repeated identical challenges are bounded and never open a browser automatically. */
  private captureStepUp(response: Response): void {
    const challenge = extractWWWAuthenticateParams(response);
    if (challenge.error !== "insufficient_scope" || !challenge.scope) return;
    const key = scopeSet(challenge.scope).sort().join(" ");
    if ((this.stepUpAttempts.get(key) ?? 0) >= MAX_STEP_UP_ATTEMPTS) return;
    if (challenge.resourceMetadataUrl) this.challengeMetadataUrl = challenge.resourceMetadataUrl;
    this.challengeScope = challenge.scope;
    this.pendingStepUp = key;
    if (this.status === "authenticated") this.status = "insufficient_scope";
  }

  private async sanitizedResourceResponse(response: Response): Promise<Response> {
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error(AUTH_FAILED);
    }
    if (response.ok) return response;
    await response.body?.cancel();
    return new Response("MCP request failed", { status: response.status });
  }
}
