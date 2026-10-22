import { createHash, randomBytes } from "node:crypto";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
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
import type { AuthRedirectCatchers } from "../main/auth-redirect-catcher.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { runWithCeiling } from "../tools/executor-ceiling.js";
import type { McpAuthStatus, McpHttpServerConfig } from "./types.js";
import { MCP_PROTOCOL_VERSION } from "./protocol-constants.js";

export interface McpOAuthSecrets {
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export interface McpOAuthDependencies {
  networkFetch: typeof fetch;
  secrets: McpOAuthSecrets;
  redirectCatchers: AuthRedirectCatchers;
  openAuthorizationUrl(url: string): Promise<void>;
}

interface Discovery {
  issuer: string;
  resource: string;
  resourceMetadataUrl?: string;
  metadata: AuthorizationServerMetadata;
  requireIssuerResponse: boolean;
  scope?: string;
}

interface Credentials {
  serverUrl: string;
  issuer: string;
  resource: string;
  resourceMetadataUrl?: string;
  client: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  expiresAt?: number;
  grantedScope?: string;
}

const AUTH_FAILED = "MCP authentication failed";
const AUTH_REQUIRED = "MCP authentication required";
const MAX_AUTH_RESPONSE_BYTES = 1024 * 1024;

class McpOAuthBindingChangedError extends Error {
  constructor() { super(AUTH_REQUIRED); }
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

/** SDK path-boundary containment, narrowed so a resource carrying a query only matches the exact endpoint. */
function resourceContainsEndpoint(resource: URL, endpoint: URL): boolean {
  return resource.href === endpoint.href ||
    (!resource.search && checkResourceAllowed({ requestedResource: endpoint, configuredResource: resource }));
}

function credentialKey(config: McpHttpServerConfig): string {
  const serverUrl = secureUrl(config.url, config.allowPrivateNetworks === true).href;
  return `mcp.oauth.${createHash("sha256").update(JSON.stringify([config.id, serverUrl, config.oauth])).digest("hex")}`;
}

/** Host-owned credentials and browser flow for one exact remote endpoint. */
export class McpOAuthSession {
  static async clearStoredCredentials(config: McpHttpServerConfig, secrets: McpOAuthSecrets): Promise<void> {
    try { await secrets.deleteSecret(credentialKey(config)); }
    catch { throw new Error(AUTH_FAILED); }
  }

  readonly fetch: typeof fetch;
  private readonly serverUrl: string;
  private readonly secretKey: string;
  private readonly ownerKey = `mcp-oauth:${randomBytes(16).toString("hex")}`;
  private readonly controller = new AbortController();
  private status: McpAuthStatus = "required";
  private credentials?: Credentials;
  private challengeMetadataUrl?: URL;
  private challengeScope?: string;
  private login?: Promise<void>;
  private refresh?: Promise<boolean>;
  private pendingWrite: Promise<void> = Promise.resolve();
  private credentialGeneration = 0;
  private challengeProbeAvailable = true;

  constructor(private readonly config: McpHttpServerConfig, private readonly dependencies: McpOAuthDependencies) {
    if (config.oauth?.clientRegistration && config.oauth.clientRegistration !== "dynamic") throw new Error(AUTH_FAILED);
    this.serverUrl = secureUrl(config.url, config.allowPrivateNetworks === true).href;
    this.secretKey = credentialKey(config);
    let raw: string | null;
    try { raw = dependencies.secrets.getSecret(this.secretKey); }
    catch { throw new Error(AUTH_FAILED); }
    try {
      if (raw) {
        const saved = JSON.parse(raw) as Credentials;
        if (saved.serverUrl === this.serverUrl && typeof saved.issuer === "string" && typeof saved.resource === "string") {
          if (secureUrl(saved.issuer, config.allowPrivateNetworks === true).search ||
            (config.oauth?.authorizationServers?.length && !config.oauth.authorizationServers.includes(saved.issuer))) throw new Error(AUTH_FAILED);
          const resource = secureUrl(saved.resource, config.allowPrivateNetworks === true);
          if (!resourceContainsEndpoint(resource, new URL(this.serverUrl)) ||
            (config.oauth?.resource && resource.href !== secureUrl(config.oauth.resource, config.allowPrivateNetworks === true).href)) throw new Error(AUTH_FAILED);
          this.credentials = {
            serverUrl: saved.serverUrl, issuer: saved.issuer, resource: saved.resource,
            client: OAuthClientInformationFullSchema.parse(saved.client),
            tokens: saved.tokens ? OAuthTokensSchema.parse(saved.tokens) : undefined,
            expiresAt: typeof saved.expiresAt === "number" && Number.isFinite(saved.expiresAt) ? saved.expiresAt : undefined,
            resourceMetadataUrl: typeof saved.resourceMetadataUrl === "string"
              ? secureUrl(saved.resourceMetadataUrl, config.allowPrivateNetworks === true).href : undefined,
          };
          this.credentials.grantedScope = typeof saved.grantedScope === "string" ? saved.grantedScope : this.credentials.tokens?.scope;
          if (this.credentials.tokens) {
            this.status = "authenticated";
            this.challengeProbeAvailable = false;
          }
        }
      }
    } catch { /* Invalid encrypted state requires a new interactive grant. */ }
    this.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => this.fetchResource(input, init)) as typeof fetch;
  }

  getStatus(): McpAuthStatus { return this.status; }

  authenticate(): Promise<void> {
    if (!this.login) {
      this.login = this.authenticateOnce().finally(() => { this.login = undefined; });
    }
    return this.login;
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
    try { await this.dependencies.secrets.deleteSecret(this.secretKey); }
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
      await this.dependencies.secrets.setSecret(this.secretKey, serialized);
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
    const metadataHint = this.config.oauth?.resourceMetadataUrl ?? this.credentials?.resourceMetadataUrl;
    const resourceMetadataUrl = this.challengeMetadataUrl ?? (metadataHint
      ? secureUrl(metadataHint, this.config.allowPrivateNetworks === true) : undefined);
    const resource = await discoverOAuthProtectedResourceMetadata(this.serverUrl, { resourceMetadataUrl, protocolVersion: MCP_PROTOCOL_VERSION }, this.authFetch);
    const resourceUrl = secureUrl(resource.resource, this.config.allowPrivateNetworks === true);
    const expected = this.config.oauth?.resource ? secureUrl(this.config.oauth.resource, this.config.allowPrivateNetworks === true).href : this.serverUrl;
    // Metadata may name a containing resource path, but never an unrelated origin or sibling.
    const server = new URL(this.serverUrl);
    if (!resourceContainsEndpoint(resourceUrl, server) || (this.config.oauth?.resource && resourceUrl.href !== expected)) throw new Error(AUTH_FAILED);
    const configuredIssuers = this.config.oauth?.authorizationServers;
    const issuer = resource.authorization_servers?.find((candidate) => !configuredIssuers?.length || configuredIssuers.includes(candidate));
    if (!issuer) throw new Error(AUTH_FAILED);
    if (secureUrl(issuer, this.config.allowPrivateNetworks === true).search) throw new Error(AUTH_FAILED);
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
    secureUrl(metadata.authorization_endpoint, this.config.allowPrivateNetworks === true);
    if (!metadata.token_endpoint) throw new Error(AUTH_FAILED);
    secureUrl(metadata.token_endpoint, this.config.allowPrivateNetworks === true);
    if (metadata.registration_endpoint) secureUrl(metadata.registration_endpoint, this.config.allowPrivateNetworks === true);
    if (this.credentials && (this.credentials.resource !== resourceUrl.href || this.credentials.issuer !== issuer)) {
      if (!interactive) throw new McpOAuthBindingChangedError();
      this.credentials = undefined;
      const generation = ++this.credentialGeneration;
      await this.removeStoredCredentials(generation);
    }
    const selectedScope = this.challengeScope || this.config.oauth?.scopes?.join(" ") || resource.scopes_supported?.join(" ");
    const scope = [...new Set(`${selectedScope ?? ""} ${this.credentials?.grantedScope ?? ""}`.split(/\s+/u).filter(Boolean))].join(" ") || undefined;
    return { issuer, resource: resourceUrl.href, resourceMetadataUrl: resourceMetadataUrl?.href, metadata, requireIssuerResponse, scope };
  }

  private async authenticateOnce(): Promise<void> {
    this.credentialGeneration += 1;
    this.status = "authenticating";
    let handle: string | undefined;
    try {
      this.assertActive();
      const discovery = await this.discover(true);
      const catcher = await this.dependencies.redirectCatchers.open(this.ownerKey);
      handle = catcher.handle;
      this.assertActive();
      const secretExpiresAt = this.credentials?.client.client_secret_expires_at;
      if (secretExpiresAt && secretExpiresAt <= Date.now() / 1000) {
        this.credentials = undefined;
        await this.dependencies.secrets.deleteSecret(this.secretKey);
      }
      let client = this.credentials?.client;
      if (!client) {
        if (!discovery.metadata.registration_endpoint) throw new Error(AUTH_FAILED);
        const clientMetadata = { client_name: "Ave", redirect_uris: [catcher.redirectUri], application_type: "native",
          grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
        client = await registerClient(discovery.issuer, {
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
        this.credentials = { serverUrl: this.serverUrl, resource: discovery.resource, issuer: discovery.issuer, client };
        await this.save();
      }
      this.credentials!.resourceMetadataUrl = discovery.resourceMetadataUrl;
      const state = randomBytes(32).toString("base64url");
      const authorization = await startAuthorization(discovery.issuer, { metadata: discovery.metadata, clientInformation: client,
        redirectUrl: catcher.redirectUri, state, scope: discovery.scope, resource: new URL(discovery.resource) });
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
      if (!params.code || params.error !== undefined || params.state !== state ||
        (params.iss !== undefined && params.iss !== discovery.issuer) ||
        (discovery.requireIssuerResponse && !params.iss)) throw new Error(AUTH_FAILED);
      const tokens = await exchangeAuthorization(discovery.issuer, { metadata: discovery.metadata, clientInformation: client,
        authorizationCode: params.code, codeVerifier: authorization.codeVerifier, redirectUri: catcher.redirectUri,
        resource: new URL(discovery.resource), fetchFn: this.authFetch });
      await this.acceptTokens(tokens, discovery.scope);
    } catch {
      this.status = this.controller.signal.aborted ? "required" : "error";
      throw new Error(AUTH_FAILED);
    } finally {
      if (handle) this.dependencies.redirectCatchers.close(this.ownerKey, handle);
    }
  }

  private async acceptTokens(tokens: OAuthTokens, requestedScope?: string): Promise<void> {
    this.assertActive();
    if (!this.credentials || tokens.token_type.toLowerCase() !== "bearer" || !/^[A-Za-z0-9._~+/-]+=*$/u.test(tokens.access_token) ||
      (tokens.expires_in !== undefined && (!Number.isSafeInteger(tokens.expires_in) || tokens.expires_in < 0))) throw new Error(AUTH_FAILED);
    const generation = ++this.credentialGeneration;
    this.challengeProbeAvailable = false;
    this.credentials.grantedScope = tokens.scope ?? requestedScope ?? this.credentials.grantedScope;
    this.credentials.tokens = tokens;
    this.credentials.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
    await this.save();
    if (this.credentialGeneration === generation) this.status = "authenticated";
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
      const tokens = await refreshAuthorization(discovery.issuer, { metadata: discovery.metadata, clientInformation: credentials.client,
        refreshToken, resource: new URL(discovery.resource), fetchFn: this.authFetch });
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
      if (this.credentialGeneration === generation) await this.dependencies.secrets.deleteSecret(this.secretKey);
    });
    await this.pendingWrite;
    this.assertActive();
  }

  private async fetchResource(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      this.assertActive();
      const request = new Request(input, init);
      if (new URL(request.url).href !== this.serverUrl) throw new Error(AUTH_FAILED);
      let refreshed = false;
      if (this.credentials?.tokens && this.credentials.expiresAt !== undefined && this.credentials.expiresAt <= Date.now()) {
        refreshed = true;
        if (!await this.refreshTokens()) throw new Error(AUTH_REQUIRED);
      }
      let sentGeneration = this.credentialGeneration;
      const send = async (): Promise<Response> => {
        this.assertActive();
        sentGeneration = this.credentialGeneration;
        const generation = sentGeneration;
        const accessToken = this.credentials?.tokens?.access_token;
        if (!accessToken && !this.challengeProbeAvailable) throw new Error(AUTH_REQUIRED);
        this.challengeProbeAvailable = false;
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
      let response = await send();
      if (response.status !== 401) return await this.sanitizedResourceResponse(response);
      this.captureChallenge(response);
      await response.body?.cancel();
      if (!refreshed && this.credentials?.tokens && sentGeneration !== this.credentialGeneration) {
        refreshed = true;
        response = await send();
        if (response.status !== 401) return await this.sanitizedResourceResponse(response);
        this.captureChallenge(response);
        await response.body?.cancel();
      }
      if (!refreshed && this.credentials?.tokens?.refresh_token) {
        if (!await this.refreshTokens()) throw new Error(AUTH_REQUIRED);
        response = await send();
        if (response.status !== 401) return await this.sanitizedResourceResponse(response);
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
