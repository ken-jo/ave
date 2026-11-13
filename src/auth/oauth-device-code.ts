import { buildDiscoveryUrls } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthTokensSchema, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { MAX_TIMER_DELAY_MS, TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { runWithCeiling } from "../tools/executor-ceiling.js";

export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
}

export interface DeviceCodePresentation {
  available(): boolean;
  show(prompt: DeviceCodePrompt, controller: AbortController): Promise<() => void>;
}

export type DeviceAuthorizationErrorCode =
  | "oauth-device-headless"
  | "oauth-device-unsupported"
  | "oauth-device-denied"
  | "oauth-device-expired"
  | "oauth-device-canceled"
  | "oauth-device-failed";

const MESSAGES: Record<DeviceAuthorizationErrorCode, string> = {
  "oauth-device-headless": "Device authorization requires a human; authenticate interactively before running unattended",
  "oauth-device-unsupported": "Device authorization is not supported by this authorization server",
  "oauth-device-denied": "Device authorization was denied",
  "oauth-device-expired": "Device authorization expired; start authentication again",
  "oauth-device-canceled": "Device authorization was canceled",
  "oauth-device-failed": "Device authorization failed",
};
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_SECONDS = 5;
const CONNECTION_TIMEOUT_CODES = new Set([
  "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
const MAX_ERROR_CAUSE_DEPTH = 8;

export class DeviceAuthorizationError extends Error {
  constructor(readonly code: DeviceAuthorizationErrorCode) {
    super(MESSAGES[code]);
    this.name = "DeviceAuthorizationError";
  }
}

interface DeviceAuthorizationOptions {
  metadata: { device_authorization_endpoint?: unknown; token_endpoint?: unknown };
  clientId: string;
  scope?: string;
  resource?: string;
  fetchFn: typeof fetch;
  presentation: DeviceCodePresentation;
  signal: AbortSignal;
  allowLoopback?: boolean;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  body: string;
}

function endpointUrl(raw: unknown, allowLoopback: boolean): string {
  if (typeof raw !== "string") throw new DeviceAuthorizationError("oauth-device-failed");
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new DeviceAuthorizationError("oauth-device-failed"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash ||
    (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))) {
    throw new DeviceAuthorizationError("oauth-device-failed");
  }
  return url.href;
}

function boundedText(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= MAX_RESPONSE_BYTES;
}

function positiveSeconds(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 &&
    Number.isSafeInteger(raw * 1000 + Date.now());
}

function abortError(controller: AbortController): DeviceAuthorizationError {
  const reason: unknown = controller.signal.reason;
  return reason instanceof DeviceAuthorizationError ? reason : new DeviceAuthorizationError("oauth-device-canceled");
}

function assertActive(controller: AbortController): void {
  if (controller.signal.aborted) throw abortError(controller);
}

/** Protocol deadlines may exceed a native timer's maximum delay. */
function expireAt(controller: AbortController, deadline: number): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (): void => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      controller.abort(new DeviceAuthorizationError("oauth-device-expired"));
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  schedule();
  return () => clearTimeout(timer);
}

async function waitUntil(deadline: number, controller: AbortController): Promise<void> {
  assertActive(controller);
  while (deadline > Date.now()) {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        reject(abortError(controller));
      };
      const timer = setTimeout(() => {
        controller.signal.removeEventListener("abort", abort);
        resolve();
      }, Math.min(deadline - Date.now(), MAX_TIMER_DELAY_MS));
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    assertActive(controller);
  }
}

function parseJsonRecord(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DeviceAuthorizationError("oauth-device-failed");
  }
  return parsed as Record<string, unknown>;
}

/** Only explicit timeout identities reduce polling frequency; cancellation and ordinary network failures stop it. */
export function isOAuthConnectionTimeout(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    const details = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (details.name === "AbortError") return false;
    if (details.name === "TimeoutError" ||
      (typeof details.code === "string" && CONNECTION_TIMEOUT_CODES.has(details.code))) return true;
    current = details.cause;
  }
  return false;
}

/** Both headers and body reads are bounded by the host network policy. */
async function requestBody(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  controller: AbortController,
): Promise<JsonResponse | "timeout"> {
  assertActive(controller);
  const outcome = await runWithCeiling(async (signal): Promise<JsonResponse> => {
    const response = await fetchFn(url, { ...init, redirect: "error", signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new DeviceAuthorizationError("oauth-device-failed");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (reader) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw new DeviceAuthorizationError("oauth-device-failed");
        chunks.push(next.value);
      }
    } finally {
      await reader?.cancel().catch(() => {});
    }
    return { ok: response.ok, status: response.status, body: Buffer.concat(chunks).toString("utf8") };
  }, TOOL_TIMEOUT_POLICY.networkFetchDefaultMs, controller.signal, "Device authorization");
  assertActive(controller);
  if (outcome.ok) return outcome.value;
  if (outcome.reason === "ceiling" || isOAuthConnectionTimeout(outcome.error)) return "timeout";
  throw new DeviceAuthorizationError("oauth-device-failed");
}

/** The caller selects this grant explicitly; the host owns all polling and cancellation. */
export async function authorizeDeviceCode(options: DeviceAuthorizationOptions): Promise<OAuthTokens> {
  if (!options.presentation.available()) throw new DeviceAuthorizationError("oauth-device-headless");
  if (options.metadata.device_authorization_endpoint === undefined) {
    throw new DeviceAuthorizationError("oauth-device-unsupported");
  }
  const allowLoopback = options.allowLoopback === true;
  const deviceEndpoint = endpointUrl(options.metadata.device_authorization_endpoint, allowLoopback);
  const tokenEndpoint = endpointUrl(options.metadata.token_endpoint, allowLoopback);
  if (!boundedText(options.clientId)) throw new DeviceAuthorizationError("oauth-device-failed");
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new DeviceAuthorizationError("oauth-device-canceled"));
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  let dismiss: (() => void) | undefined;
  let stopExpiry: (() => void) | undefined;
  const closePresentation = (): void => {
    const close = dismiss;
    dismiss = undefined;
    close?.();
  };
  try {
    assertActive(controller);
    const authorizationBody = new URLSearchParams({ client_id: options.clientId });
    if (options.scope !== undefined) authorizationBody.set("scope", options.scope);
    if (options.resource !== undefined) authorizationBody.set("resource", options.resource);
    const response = await requestBody(options.fetchFn, deviceEndpoint, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: authorizationBody }, controller);
    if (response === "timeout" || !response.ok) throw new DeviceAuthorizationError("oauth-device-failed");
    const data = parseJsonRecord(response.body);
    if (!boundedText(data.device_code) || !boundedText(data.user_code) || !positiveSeconds(data.expires_in) ||
      (data.interval !== undefined && !positiveSeconds(data.interval))) {
      throw new DeviceAuthorizationError("oauth-device-failed");
    }
    const expiresAt = Date.now() + data.expires_in * 1000;
    const prompt: DeviceCodePrompt = {
      userCode: data.user_code,
      verificationUri: endpointUrl(data.verification_uri, allowLoopback),
      expiresAt,
    };
    if (data.verification_uri_complete !== undefined) {
      prompt.verificationUriComplete = endpointUrl(data.verification_uri_complete, allowLoopback);
    }
    stopExpiry = expireAt(controller, expiresAt);
    const shown = await runWithCeiling(async () => {
      dismiss = await options.presentation.show(prompt, controller);
      if (controller.signal.aborted) closePresentation();
    }, Math.min(expiresAt - Date.now(), MAX_TIMER_DELAY_MS), controller.signal, "Device authorization presentation");
    assertActive(controller);
    if (!shown.ok) throw new DeviceAuthorizationError("oauth-device-failed");
    let interval = (data.interval === undefined ? DEFAULT_INTERVAL_SECONDS : data.interval as number) * 1000;
    const tokenBody = new URLSearchParams({ grant_type: DEVICE_CODE_GRANT_TYPE, device_code: data.device_code, client_id: options.clientId });
    if (options.resource !== undefined) tokenBody.set("resource", options.resource);
    while (true) {
      await waitUntil(Date.now() + interval, controller);
      const tokenResponse = await requestBody(options.fetchFn, tokenEndpoint, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenBody }, controller);
      if (tokenResponse === "timeout") {
        interval *= 2;
        continue;
      }
      if (tokenResponse.ok) {
        const parsed = OAuthTokensSchema.safeParse(parseJsonRecord(tokenResponse.body));
        if (!parsed.success || !boundedText(parsed.data.access_token) ||
          !/^(?:bearer|dpop)$/iu.test(parsed.data.token_type) ||
          (parsed.data.expires_in !== undefined && (!Number.isSafeInteger(parsed.data.expires_in) || parsed.data.expires_in < 0)) ||
          (parsed.data.refresh_token !== undefined && !boundedText(parsed.data.refresh_token))) {
          throw new DeviceAuthorizationError("oauth-device-failed");
        }
        return parsed.data;
      }
      switch (parseJsonRecord(tokenResponse.body).error) {
        case "authorization_pending": break;
        case "slow_down": interval += SLOW_DOWN_SECONDS * 1000; break;
        case "access_denied": throw new DeviceAuthorizationError("oauth-device-denied");
        case "expired_token": throw new DeviceAuthorizationError("oauth-device-expired");
        default: throw new DeviceAuthorizationError("oauth-device-failed");
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw abortError(controller);
    if (error instanceof DeviceAuthorizationError) throw error;
    throw new DeviceAuthorizationError("oauth-device-failed");
  } finally {
    stopExpiry?.();
    options.signal.removeEventListener("abort", cancel);
    try { closePresentation(); }
    finally { controller.abort(new DeviceAuthorizationError("oauth-device-canceled")); }
  }
}

export interface DeviceAuthorizationMetadata {
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  registration_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  dpop_signing_alg_values_supported?: string[];
}

function metadataStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((value: unknown) => boundedText(value))) {
    throw new DeviceAuthorizationError("oauth-device-failed");
  }
  return raw as string[];
}

/** The shared discovery URL builder also supports servers offering only the device grant. */
export async function discoverDeviceAuthorizationMetadata(
  issuer: string,
  fetchFn: typeof fetch,
  options: { allowLoopback?: boolean; signal?: AbortSignal } = {},
): Promise<DeviceAuthorizationMetadata> {
  const allowLoopback = options.allowLoopback === true;
  const issuerUrl = endpointUrl(issuer, allowLoopback);
  if (new URL(issuerUrl).search) throw new DeviceAuthorizationError("oauth-device-failed");
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new DeviceAuthorizationError("oauth-device-canceled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    for (const { url } of buildDiscoveryUrls(issuerUrl)) {
      const response = await requestBody(fetchFn, url.href, { headers: { accept: "application/json" } }, controller);
      if (response === "timeout") throw new DeviceAuthorizationError("oauth-device-failed");
      if (!response.ok) {
        if (response.status === 404 || response.status === 405) continue;
        throw new DeviceAuthorizationError("oauth-device-failed");
      }
      const raw = parseJsonRecord(response.body);
      if (raw.issuer !== issuer) throw new DeviceAuthorizationError("oauth-device-failed");
      if (raw.device_authorization_endpoint === undefined) throw new DeviceAuthorizationError("oauth-device-unsupported");
      const metadata: DeviceAuthorizationMetadata = {
        issuer,
        token_endpoint: endpointUrl(raw.token_endpoint, allowLoopback),
        device_authorization_endpoint: endpointUrl(raw.device_authorization_endpoint, allowLoopback),
      };
      if (raw.registration_endpoint !== undefined) metadata.registration_endpoint = endpointUrl(raw.registration_endpoint, allowLoopback);
      if (raw.token_endpoint_auth_methods_supported !== undefined) {
        metadata.token_endpoint_auth_methods_supported = metadataStringArray(raw.token_endpoint_auth_methods_supported);
      }
      if (raw.dpop_signing_alg_values_supported !== undefined) {
        metadata.dpop_signing_alg_values_supported = metadataStringArray(raw.dpop_signing_alg_values_supported);
      }
      return metadata;
    }
    throw new DeviceAuthorizationError("oauth-device-unsupported");
  } catch (error) {
    if (controller.signal.aborted) throw abortError(controller);
    if (error instanceof DeviceAuthorizationError) throw error;
    throw new DeviceAuthorizationError("oauth-device-failed");
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}
