import { createHash, randomUUID } from "node:crypto";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthTokensSchema, type OAuthTokens, type AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { authorizeDeviceCode, discoverDeviceAuthorizationMetadata, isOAuthConnectionTimeout, type DeviceCodePresentation } from "../auth/oauth-device-code.js";
import { createDpopFetch, DpopKey, negotiateDpop } from "../auth/oauth-dpop.js";
import type { DeviceCodeAuthorizationOptions, DeviceCodeFetchOptions } from "../plugins/public-contract.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { runWithCeiling } from "../tools/executor-ceiling.js";

interface DeviceCredential {
  binding: string;
  issuer: string;
  clientId: string;
  resource: string;
  tokens: OAuthTokens;
  expiresAt?: number;
  key?: string;
}

interface LiveCredential {
  storageKey: string;
  saved: DeviceCredential;
  key?: DpopKey;
  resourceFetch?: typeof fetch;
  tokenFetch?: typeof fetch;
  tokenEndpoint?: string;
  refresh?: Promise<void>;
  revoked?: boolean;
  controller: AbortController;
}

export interface PluginDeviceAuthDependencies {
  fetch: typeof fetch;
  fetchAuthorization: typeof fetch;
  presentation?: DeviceCodePresentation;
  enabled(): boolean;
  headless(): boolean;
  canStoreEncrypted(): Promise<boolean>;
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

const MAX_AUTH_BODY_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_HANDLES = 64;

function authUrl(raw: unknown): URL {
  if (typeof raw !== "string") throw new Error("oauth-device-invalid-url");
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("oauth-device-invalid-url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("oauth-device-invalid-url");
  return url;
}

function validateOptions(options: DeviceCodeAuthorizationOptions): DeviceCodeAuthorizationOptions {
  if (!options || typeof options !== "object") throw new Error("oauth-device-invalid-options");
  const issuer = authUrl(options.issuer);
  if (issuer.search || typeof options.clientId !== "string" || !/^[\x21-\x7e]{1,256}$/u.test(options.clientId)) {
    throw new Error("oauth-device-invalid-options");
  }
  const resource = authUrl(options.resource).href;
  if (options.dpop !== undefined && options.dpop !== "required") throw new Error("oauth-device-invalid-options");
  if (options.scopes !== undefined && (!Array.isArray(options.scopes) || options.scopes.length > 128 ||
    options.scopes.some(value => typeof value !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/u.test(value)))) {
    throw new Error("oauth-device-invalid-options");
  }
  return { issuer: options.issuer, clientId: options.clientId, resource,
    ...(options.scopes !== undefined ? { scopes: [...options.scopes] } : {}),
    ...(options.dpop !== undefined ? { dpop: options.dpop } : {}) };
}

function validateTokens(tokens: OAuthTokens, bound: boolean): void {
  if (tokens.token_type.toLowerCase() !== (bound ? "dpop" : "bearer") ||
    !/^[A-Za-z0-9._~+/-]+=*$/u.test(tokens.access_token) ||
    (tokens.expires_in !== undefined && (!Number.isSafeInteger(tokens.expires_in) || tokens.expires_in < 0))) {
    throw new Error("oauth-device-token-binding-failed");
  }
}

/** Each instance belongs to one live plugin incarnation; no caller identity crosses the API. */
export class PluginDeviceAuth {
  private readonly controller = new AbortController();
  private readonly credentials = new Map<string, LiveCredential>();
  private authorization?: Promise<{ handle: string }>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly pluginId: string, private readonly dependencies: PluginDeviceAuthDependencies) {}

  private assertActive(): void { this.controller.signal.throwIfAborted(); }

  dispose(): void {
    this.controller.abort();
    for (const live of this.credentials.values()) {
      live.revoked = true;
      live.controller.abort();
    }
    this.credentials.clear();
  }

  authorize(options: DeviceCodeAuthorizationOptions, signal?: AbortSignal): Promise<{ handle: string }> {
    if (this.authorization) return Promise.reject(new Error("oauth-device-already-pending"));
    this.authorization = this.authorizeOnce(options, signal).finally(() => { this.authorization = undefined; });
    return this.authorization;
  }

  private async authorizeOnce(raw: DeviceCodeAuthorizationOptions, callerSignal?: AbortSignal): Promise<{ handle: string }> {
    this.assertActive();
    callerSignal?.throwIfAborted();
    if (!this.dependencies.enabled()) throw new Error("oauth-device-not-enabled");
    if (this.credentials.size >= MAX_CREDENTIAL_HANDLES) throw new Error("oauth-device-handle-limit");
    const options = validateOptions(raw);
    if (!await this.dependencies.canStoreEncrypted()) throw new Error("oauth-device-encrypted-storage-required");
    this.assertActive();
    const binding = JSON.stringify(options);
    const storageKey = `oauth.plugin-device.${createHash("sha256").update(JSON.stringify([this.pluginId, binding])).digest("hex")}`;
    const existing = [...this.credentials.values()].find(candidate => candidate.storageKey === storageKey && !candidate.revoked);
    if (existing) {
      const handle = randomUUID();
      this.credentials.set(handle, existing);
      return { handle };
    }
    await Promise.allSettled([this.writes]);
    let stored: string | null;
    try { stored = await this.dependencies.getSecret(storageKey); }
    catch { throw new Error("oauth-device-storage-unreadable"); }
    this.assertActive();
    callerSignal?.throwIfAborted();
    let live: LiveCredential;
    if (stored !== null) {
      let saved: DeviceCredential;
      try { saved = JSON.parse(stored) as DeviceCredential; }
      catch { throw new Error("oauth-device-storage-unreadable"); }
      if (!saved || typeof saved !== "object") throw new Error("oauth-device-storage-unreadable");
      if (saved.binding !== binding || saved.issuer !== options.issuer || saved.clientId !== options.clientId || saved.resource !== options.resource ||
        (saved.expiresAt !== undefined && (typeof saved.expiresAt !== "number" || !Number.isFinite(saved.expiresAt))) ||
        (saved.key !== undefined && typeof saved.key !== "string")) throw new Error("oauth-device-storage-unreadable");
      const parsed = OAuthTokensSchema.safeParse(saved.tokens);
      if (!parsed.success) throw new Error("oauth-device-storage-unreadable");
      saved.tokens = parsed.data;
      validateTokens(saved.tokens, saved.key !== undefined);
      if (options.dpop === "required" && !saved.key) throw new Error("oauth-device-token-binding-failed");
      live = { storageKey, saved, controller: new AbortController(), ...(saved.key !== undefined ? { key: await DpopKey.restore(saved.key) } : {}) };
    } else {
      if (this.dependencies.headless() || !this.dependencies.presentation?.available()) {
        throw new Error("oauth-device-headless: Authenticate interactively before running unattended; do not retry");
      }
      const signal = callerSignal ? AbortSignal.any([this.controller.signal, callerSignal]) : this.controller.signal;
      const metadata = await this.discover(options.issuer, signal);
      const bound = negotiateDpop(metadata, options.dpop === "required");
      const key = bound ? await DpopKey.create() : undefined;
      const tokenFetch = this.tokenFetch(key, metadata.token_endpoint);
      const tokens = await authorizeDeviceCode({
        metadata, clientId: options.clientId, scope: options.scopes?.join(" "), resource: options.resource,
        fetchFn: tokenFetch, presentation: this.dependencies.presentation, signal,
      });
      validateTokens(tokens, bound);
      const saved: DeviceCredential = { binding, issuer: options.issuer, clientId: options.clientId, resource: options.resource, tokens,
        ...(tokens.expires_in !== undefined ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
        ...(key ? { key: key.serialize() } : {}) };
      live = { storageKey, saved, key, tokenFetch, tokenEndpoint: metadata.token_endpoint, controller: new AbortController() };
      await this.persist(live);
    }
    this.assertActive();
    const handle = randomUUID();
    this.credentials.set(handle, live);
    return { handle };
  }

  private readonly authorizationFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const signal = AbortSignal.any([this.controller.signal, request.signal]);
    const result = await runWithCeiling(async abortSignal => {
      const response = await this.dependencies.fetchAuthorization(new Request(request, { signal: abortSignal, redirect: "error" }));
      if (response.status >= 300 && response.status < 400) throw new Error("oauth-device-redirect-refused");
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (reader) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_AUTH_BODY_BYTES) throw new Error("oauth-device-response-too-large");
          chunks.push(next.value);
        }
      } finally { await reader?.cancel(); }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    }, TOOL_TIMEOUT_POLICY.networkFetchDefaultMs, signal, "Device authorization");
    if (!result.ok) {
      if (result.reason === "ceiling" || isOAuthConnectionTimeout(result.error)) {
        throw new DOMException("Device authorization timed out", "TimeoutError");
      }
      throw new Error("oauth-device-request-failed");
    }
    return result.value;
  }) as typeof fetch;

  private async discover(issuer: string, signal: AbortSignal) {
    return discoverDeviceAuthorizationMetadata(issuer, this.authorizationFetch, { signal });
  }

  private tokenFetch(key: DpopKey | undefined, endpoint: string): typeof fetch {
    if (!key) return this.authorizationFetch;
    const signed = createDpopFetch(key, this.authorizationFetch, "token");
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      return (new URL(url).href === endpoint ? signed : this.authorizationFetch)(input, init);
    }) as typeof fetch;
  }

  private async persist(live: LiveCredential): Promise<void> {
    this.assertActive();
    if (live.revoked) throw new Error("oauth-device-unknown-handle");
    const serialized = JSON.stringify(live.saved);
    this.writes = this.writes.catch(() => {}).then(async () => {
      this.assertActive();
      if (!await this.dependencies.canStoreEncrypted()) throw new Error("oauth-device-encrypted-storage-required");
      this.assertActive();
      if (live.revoked) throw new Error("oauth-device-unknown-handle");
      await this.dependencies.setSecret(live.storageKey, serialized);
    });
    await this.writes;
    this.assertActive();
  }

  private async refresh(live: LiveCredential, callerSignal?: AbortSignal): Promise<void> {
    if (live.refresh) return live.refresh;
    live.refresh = (async () => {
      const previous = live.saved.tokens.refresh_token;
      if (!previous) throw new Error("oauth-device-authentication-required");
      const signal = AbortSignal.any([this.controller.signal, live.controller.signal, ...(callerSignal ? [callerSignal] : [])]);
      const metadata = await this.discover(live.saved.issuer, signal);
      if (negotiateDpop(metadata, live.key !== undefined) !== (live.key !== undefined)) throw new Error("oauth-device-token-binding-failed");
      const tokenFetch = live.tokenEndpoint === metadata.token_endpoint && live.tokenFetch
        ? live.tokenFetch : this.tokenFetch(live.key, metadata.token_endpoint);
      live.tokenFetch = tokenFetch;
      live.tokenEndpoint = metadata.token_endpoint;
      const tokens = await refreshAuthorization(live.saved.issuer, {
        // The SDK refresh path consumes token metadata only; a device-only server has no authorization endpoint.
        metadata: metadata as unknown as AuthorizationServerMetadata,
        clientInformation: { client_id: live.saved.clientId, redirect_uris: [], token_endpoint_auth_method: "none" },
        refreshToken: previous, resource: live.saved.resource,
        fetchFn: ((input, init) => tokenFetch(input, { ...init, signal })) as typeof fetch,
      });
      validateTokens(tokens, live.key !== undefined);
      this.assertActive();
      if (live.revoked) throw new Error("oauth-device-unknown-handle");
      live.saved.tokens = { ...tokens, refresh_token: tokens.refresh_token ?? previous };
      live.saved.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
      live.resourceFetch = undefined;
      await this.persist(live);
    })().finally(() => { live.refresh = undefined; });
    return live.refresh;
  }

  async fetch(options: DeviceCodeFetchOptions, signal?: AbortSignal): Promise<Response> {
    this.assertActive();
    signal?.throwIfAborted();
    if (!this.dependencies.enabled()) throw new Error("oauth-device-not-enabled");
    if (!options || typeof options !== "object" || typeof options.handle !== "string" || typeof options.url !== "string") {
      throw new Error("oauth-device-invalid-options");
    }
    const live = this.credentials.get(options.handle);
    if (!live) throw new Error("oauth-device-unknown-handle");
    const target = authUrl(options.url);
    if (target.href !== live.saved.resource) throw new Error("oauth-device-audience-denied");
    if (options.method !== undefined && (typeof options.method !== "string" || !/^[A-Za-z]+$/u.test(options.method))) {
      throw new Error("oauth-device-invalid-options");
    }
    if (options.body !== undefined && typeof options.body !== "string") throw new Error("oauth-device-invalid-options");
    let headers: Headers;
    try { headers = new Headers(options.headers); }
    catch { throw new Error("oauth-device-invalid-options"); }
    for (const name of ["authorization", "proxy-authorization", "cookie", "dpop"]) {
      if (headers.has(name)) throw new Error("oauth-device-credential-conflict");
    }
    let refreshed = false;
    if (live.saved.expiresAt !== undefined && live.saved.expiresAt <= Date.now()) {
      await this.refresh(live, signal);
      refreshed = true;
    }
    const requestSignal = AbortSignal.any([this.controller.signal, live.controller.signal, ...(signal ? [signal] : [])]);
    const send = async (): Promise<Response> => {
      this.assertActive();
      if (this.credentials.get(options.handle) !== live) throw new Error("oauth-device-unknown-handle");
      headers.set("authorization", `${live.key ? "DPoP" : "Bearer"} ${live.saved.tokens.access_token}`);
      const fetchFn = live.resourceFetch ?? (live.key
        ? createDpopFetch(live.key, this.dependencies.fetch, "resource", live.saved.tokens.access_token) : this.dependencies.fetch);
      live.resourceFetch = fetchFn;
      return fetchFn(target, { method: options.method, headers, body: options.body, redirect: "error", signal: requestSignal });
    };
    let response = await send();
    if (response.status === 401 && !refreshed && live.saved.tokens.refresh_token) {
      await response.body?.cancel();
      await this.refresh(live, signal);
      response = await send();
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("oauth-device-redirect-refused");
    }
    return response;
  }

  async clear(options: { handle: string }): Promise<void> {
    this.assertActive();
    const live = this.credentials.get(options?.handle);
    if (!live) throw new Error("oauth-device-unknown-handle");
    for (const [handle, candidate] of this.credentials) {
      if (candidate.storageKey === live.storageKey) {
        candidate.revoked = true;
        candidate.controller.abort();
        this.credentials.delete(handle);
      }
    }
    await Promise.allSettled([this.writes, live.refresh]);
    this.assertActive();
    await this.dependencies.deleteSecret(live.storageKey);
  }
}
