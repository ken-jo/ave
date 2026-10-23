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
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { runWithCeiling } from "../tools/executor-ceiling.js";
import type { McpAuthErrorCode, McpAuthStatus, McpHttpServerConfig } from "./types.js";
import { isValidOAuthClientId } from "./safe-names.js";
import { MCP_PROTOCOL_VERSION } from "./protocol-constants.js";

export interface McpOAuthSecrets {
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  /** Whether a secret written now is encrypted at rest (the settings store's single answer). */
  canStoreEncrypted(): boolean;
}

export interface McpOAuthDependencies {
  networkFetch: typeof fetch;
  secrets: McpOAuthSecrets;
  redirectCatchers: AuthRedirectCatchers;
  openAuthorizationUrl(url: string): Promise<void>;
}

export interface McpOAuthSessionOptions {
  /**
   * Settles when a session this one replaces under the SAME credential key has
   * finished writing. The stored record is read only after it, so a refresh
   * the old session had in flight (a rotated refresh token) is not lost.
   */
  after?: Promise<void>;
  /** Status to show until the stored record has been read. */
  initialStatus?: McpAuthStatus;
}

type ClientSource = "preregistered" | "metadata-document" | "dynamic";

/**
 * Ave's OAuth Client ID Metadata Document, published by the web site from
 * `web/public/oauth/mcp-client.json`. The URL is the client_id itself, so it
 * must never move. It lists the RFC 8252 loopback IP redirect without a port.
 */
export const MCP_CLIENT_METADATA_DOCUMENT_URL = `${AVE_SERVICE_BASE_URL}/oauth/mcp-client.json`;

interface Discovery {
  issuer: string;
  /** Canonical RFC 8707 resource identifier sent on the wire. */
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
/** Spec step-up guidance: retry "no more than a few times" per scope challenge. */
const MAX_STEP_UP_ATTEMPTS = 2;

/** A typed authorization failure whose message is a fixed string (never provider text). */
export class McpOAuthError extends Error {
  constructor(readonly code: McpAuthErrorCode) {
    super(MESSAGES[code]);
    this.name = "McpOAuthError";
  }
}

class McpOAuthBindingChangedError extends Error {
  constructor() { super(AUTH_REQUIRED); }
}

/** Internal: the server refused Ave's client metadata document; the caller may register instead. */
class MetadataDocumentRejectedError extends Error {
  constructor(readonly issuer: string) { super(AUTH_FAILED); }
}

/** A bearer token response Ave can attach and schedule; anything else is refused before it is stored. */
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

/** SDK path-boundary containment, narrowed so a resource carrying a query only matches the exact endpoint. */
function resourceContainsEndpoint(resource: URL, endpoint: URL): boolean {
  return resource.href === endpoint.href ||
    (!resource.search && checkResourceAllowed({ requestedResource: endpoint, configuredResource: resource }));
}

function scopeSet(...values: Array<string | undefined>): string[] {
  return [...new Set(values.join(" ").split(/\s+/u).filter(Boolean))];
}

/** The fields that identify one credential record; any other config edit keeps the grant. */
function credentialKeyInputs(config: McpHttpServerConfig): string {
  const serverUrl = secureUrl(config.url, config.allowPrivateNetworks === true).href;
  return JSON.stringify([config.id, serverUrl, config.oauth]);
}

/** Encrypted-store key for this endpoint's credentials; throws when the endpoint can never hold any. */
function mcpOAuthCredentialKey(config: McpHttpServerConfig): string {
  return `mcp.oauth.${createHash("sha256").update(credentialKeyInputs(config)).digest("hex")}`;
}

/** Credential key, or undefined for an endpoint that is not a valid OAuth target (so it cannot have stored credentials). */
export function tryMcpOAuthCredentialKey(config: McpHttpServerConfig): string | undefined {
  try { return mcpOAuthCredentialKey(config); }
  catch { return undefined; }
}

/**
 * Whether the configured registration can ever complete. A client ID goes with
 * no mode or a pre-registration mode; those modes need one; any malformed or
 * contradictory combination fails clearly instead of picking a mode silently.
 */
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

/** Host-owned credentials and browser flow for one exact remote endpoint. */
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
  /** Issuers that rejected the client metadata document in this session; flows there register instead. */
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

  /** The renderer-safe reason this session cannot authenticate, if any. */
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
    } catch { /* An invalid record requires a new interactive grant. */ }
  }

  authenticate(): Promise<void> {
    if (!this.login) {
      this.login = this.authenticateOnce().finally(() => { this.login = undefined; });
    }
    return this.login;
  }

  /**
   * Retire this session for a successor that keeps the same credential key:
   * let a refresh already in flight finish and persist its (possibly rotated)
   * tokens, then dispose. The successor reads the record after this settles.
   */
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

  /**
   * Token-endpoint fetch that carries the canonical RFC 8707 resource. The SDK
   * serializes a `URL` (which always gains a trailing slash for an origin), so
   * the resource is set on the form body here instead.
   */
  private tokenFetch(resource: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!(init?.body instanceof URLSearchParams)) throw new Error(AUTH_FAILED);
      init.body.set("resource", resource);
      return this.authFetch(input, init);
    }) as typeof fetch;
  }

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
    // RFC 9728 §3.3: metadata named by the resource's own challenge must describe exactly that resource.
    // Otherwise it may name a containing resource path, but never an unrelated origin or sibling.
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

  /**
   * The client for this interactive flow. A registered client is reused only
   * when it already lists this flow's loopback redirect URI: the catcher binds
   * a fresh port each time, and a strict authorization server rejects any
   * redirect_uri the client did not register.
   */
  private async selectClient(discovery: Discovery, redirectUri: string): Promise<{ client: OAuthClientInformationFull; source: ClientSource }> {
    const mode = this.config.oauth?.clientRegistration;
    // Spec order: a pre-registered client, then a Client ID Metadata Document when the server
    // advertises it, then dynamic registration. registrationBlock() already vetted the combination.
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
    if (method && (!["none", "client_secret_basic", "client_secret_post"].includes(method) ||
      (method !== "none" && !client.client_secret) ||
      (discovery.metadata.token_endpoint_auth_methods_supported && !discovery.metadata.token_endpoint_auth_methods_supported.includes(method)))) {
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
      // Registration mode unset and the server refused Ave's metadata document:
      // run the flow once more with dynamic registration. An explicit mode stays strict.
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
      // The loopback IP literal: RFC 8252 §7.3 obliges the server to accept any port for it.
      const catcher = await this.dependencies.redirectCatchers.open(this.ownerKey, { redirectHost: "127.0.0.1" });
      handle = catcher.handle;
      this.assertActive();
      issuer = discovery.issuer;
      ({ client, source } = await this.selectClient(discovery, catcher.redirectUri));
      this.assertActive();
      const state = randomBytes(32).toString("base64url");
      const authorization = await startAuthorization(discovery.issuer, { metadata: discovery.metadata, clientInformation: client,
        redirectUrl: catcher.redirectUri, state, scope: discovery.scope });
      authorization.authorizationUrl.searchParams.set("resource", discovery.resource);
      await ensurePublicHttpUrl(authorization.authorizationUrl.href, {
        allowPrivateNetworks: this.config.allowPrivateNetworks === true,
        allowLoopback: this.config.allowPrivateNetworks === true,
      });
      this.assertActive();
      const opened = await runWithCeiling(
        () => this.dependencies.openAuthorizationUrl(authorization.authorizationUrl.href),
        TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs, this.controller.signal, "MCP authentication",
      );
      if (!opened.ok) throw new Error(AUTH_FAILED);
      this.assertActive();
      const params = await this.dependencies.redirectCatchers.wait(this.ownerKey, handle, TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs);
      if (params.state === state && (params.error === "invalid_client" || params.error === "unauthorized_client")) {
        throw new InvalidClientError("authorization response rejected the client");
      }
      if (!params.code || params.error !== undefined || params.state !== state ||
        (params.iss !== undefined && params.iss !== discovery.issuer) ||
        (discovery.requireIssuerResponse && !params.iss)) throw new Error(AUTH_FAILED);
      const tokens = await exchangeAuthorization(discovery.issuer, { metadata: discovery.metadata, clientInformation: client,
        authorizationCode: params.code, codeVerifier: authorization.codeVerifier, redirectUri: catcher.redirectUri,
        fetchFn: this.tokenFetch(discovery.resource) });
      this.assertActive();
      // Refuse a malformed token response before it can displace a working grant.
      validateTokens(tokens);
      // The grant belongs to this client; only now does it replace the stored binding.
      this.credentials = {
        serverUrl: this.serverUrl, issuer: discovery.issuer, resource: discovery.resource,
        resourceMetadataUrl: discovery.resourceMetadataUrl, resourceMetadataFromChallenge: discovery.resourceMetadataFromChallenge,
        client, clientSource: source,
        grantedScope: this.credentials?.issuer === discovery.issuer ? this.credentials.grantedScope : undefined,
      };
      if (stepUp) {
        // Count the attempt before accepting, so the new grant is not reported as still needing step-up.
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
        refreshToken, fetchFn: this.tokenFetch(discovery.resource) });
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

  /**
   * A 403 `insufficient_scope` keeps the working grant and marks the session
   * as needing step-up; the explicit Authenticate action then requests the
   * union of granted and challenged scopes. The browser never opens here. A
   * challenge whose scope set has already been stepped up the maximum number
   * of times is a permanent failure of that request, not another prompt.
   */
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
