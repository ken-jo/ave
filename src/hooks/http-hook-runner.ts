import { evaluateHostFetch, runHostFetchHops, type HostFetchTransport } from "../main/host-fetch-guard.js";
import { runWithCeiling } from "../tools/executor-ceiling.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { isRecord } from "../shared/is-record.js";
import { hasControlChars } from "../shared/display-safe-text.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { DEFAULT_HOOK_TIMEOUT_MS, MAX_HOOK_STDOUT_BYTES } from "./script-hook-types.js";
import { HOOK_EVENT_TYPES } from "./hook-contract.js";

class HttpHookError extends Error {}

export interface HttpHookDefinition {
  url: string;
  method: "POST";
  headers?: Record<string, string>;
}

export interface HttpHookRuntime {
  transport: HostFetchTransport;
  allowedUrls: readonly string[];
  allowedEnvVars: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  auditTarget(entry: {
    type: "hook_http_request";
    hookId: string;
    target: string;
    routeDigest: string;
    method: "POST";
    outcome: "allowed" | "denied";
  }): void | Promise<void>;
}

export const MAX_HTTP_HOOK_BODY_BYTES = 64 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "proxy-authorization"]);

function parseTarget(raw: string): URL {
  let target: URL;
  try { target = new URL(raw); } catch { throw new HttpHookError("HTTP hook URL is invalid"); }
  if ((target.protocol !== "https:" && target.protocol !== "http:") || target.username || target.password
      || target.hash || target.hostname.includes("*") || hasControlChars(raw) || raw.includes(" ")) {
    throw new HttpHookError("HTTP hook URL is invalid");
  }
  return target;
}

export function parseHttpHookDefinition(raw: unknown): HttpHookDefinition {
  if (!isRecord(raw) || typeof raw.url !== "string") throw new HttpHookError("HTTP hook URL is required");
  parseTarget(raw.url);
  if (raw.method !== undefined && raw.method !== "POST") throw new HttpHookError("HTTP hooks require POST");
  let headers: Record<string, string> | undefined;
  if (raw.headers !== undefined) {
    if (!isRecord(raw.headers)) throw new HttpHookError("HTTP hook headers are invalid");
    headers = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(raw.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || RESERVED_HEADERS.has(name.toLowerCase())
          || typeof value !== "string" || hasControlChars(value)) {
        throw new HttpHookError("HTTP hook headers are invalid");
      }
      headers[name] = value;
    }
  }
  return { url: raw.url, method: "POST", ...(headers ? { headers } : {}) };
}

// URL entries match the complete URL. Bare hosts match that exact hostname only.
function allowlisted(target: URL, configured: readonly string[]): boolean {
  if (configured.length === 0) return false;
  let matches = false;
  for (const entry of configured) {
    if (typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry || entry.includes("*")) {
      throw new HttpHookError("HTTP hook allowlist is invalid");
    }
    if (entry.includes("://")) {
      const allowed = parseTarget(entry);
      if (allowed.href === target.href) matches = true;
    } else {
      const authority = /^(\[[^\]]+\]|[^:/?#@]+)(?::([0-9]+))?$/u.exec(entry);
      if (!authority) throw new HttpHookError("HTTP hook allowlist is invalid");
      const allowed = parseTarget(`https://${entry}`);
      if (allowed.pathname !== "/" || allowed.search) {
        throw new HttpHookError("HTTP hook allowlist is invalid");
      }
      const configuredPort = authority[2];
      const targetPort = target.port || (target.protocol === "https:" ? "443" : "80");
      if (allowed.hostname === target.hostname && (configuredPort === undefined || String(Number(configuredPort)) === targetPort)) matches = true;
    }
  }
  return matches;
}

function interpolatedHeaders(definition: HttpHookDefinition, runtime: HttpHookRuntime): { headers: Headers; secrets: string[] } {
  if (runtime.allowedEnvVars.some((name) => !ENV_NAME.test(name))) throw new HttpHookError("HTTP hook environment allowlist is invalid");
  const allowed = new Set(runtime.allowedEnvVars);
  const environment = runtime.environment ?? process.env;
  const headers = new Headers({ "content-type": "application/json" });
  const secrets: string[] = [];
  for (const [name, template] of Object.entries(definition.headers ?? {})) {
    const value = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, braced: string | undefined, bare: string | undefined) => {
      const key = braced ?? bare;
      const value = key === undefined ? undefined : environment[key];
      if (key === undefined || !allowed.has(key) || value === undefined) throw new HttpHookError("HTTP hook header environment variable is unavailable");
      if (value.length > 0) secrets.push(value);
      return value;
    });
    if (hasControlChars(value)) throw new HttpHookError("HTTP hook header value is invalid");
    headers.set(name, value);
    if (value.length > 0) {
      secrets.push(value);
      const credential = /^(?:Bearer|Basic)\s+(.+)$/iu.exec(value)?.[1];
      if (credential) secrets.push(credential);
      if (/cookie/iu.test(name)) {
        for (const part of value.split(";")) {
          const token = part.slice(part.indexOf("=") + 1).trim();
          if (token) secrets.push(token);
        }
      }
    }
  }
  return { headers, secrets };
}

// Endpoint feedback is untrusted: a response may reflect credentials received in a header.
function redactHeaderFeedback(stdout: string, secrets: readonly string[]): string {
  if (stdout.trim().length === 0) return stdout;
  const ordered = [...new Set(secrets)].sort((left, right) => right.length - left.length);
  const redact = (value: string): string => ordered.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
  const isProtocolLiteral = (path: readonly string[], value: string): boolean => {
    if (path.length === 1 && path[0] === "action") return value === "allow" || value === "deny" || value === "modify";
    if (path.length === 1 && path[0] === "decision") return value === "allow" || value === "block";
    if (path[0] !== "hookSpecificOutput") return false;
    if (path.length === 2 && path[1] === "hookEventName") return Object.hasOwn(HOOK_EVENT_TYPES, value);
    if (path.length === 2 && path[1] === "permissionDecision") return value === "allow" || value === "deny";
    return path.length === 3 && path[1] === "decision" && path[2] === "behavior" && (value === "allow" || value === "deny");
  };
  const visit = (value: unknown, path: readonly string[]): unknown => {
    if (typeof value === "string") return isProtocolLiteral(path, value) ? value : redact(value);
    if (Array.isArray(value)) return value.map((child, index) => visit(child, [...path, String(index)]));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [redact(key), visit(child, [...path, key])]));
    return value;
  };
  try { return JSON.stringify(visit(JSON.parse(stdout), [])); } catch { throw new HttpHookError("HTTP hook response is invalid"); }
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_HOOK_STDOUT_BYTES)) {
    await response.body?.cancel();
    throw new HttpHookError("HTTP hook response exceeds size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_HOOK_STDOUT_BYTES) {
        await reader.cancel();
        throw new HttpHookError("HTTP hook response exceeds size limit");
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function runHttpHook(
  definition: HttpHookDefinition,
  payload: unknown,
  options: { hookId: string; runtime?: HttpHookRuntime; timeoutMs?: number; signal?: AbortSignal; validateTrust?: () => boolean },
): Promise<{ stdout: string }> {
  const runtime = options.runtime;
  if (!runtime || typeof runtime.transport?.sendWithHandoff !== "function") throw new HttpHookError("HTTP hook network policy is not configured");
  const requestedTimeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs <= 0) throw new HttpHookError("HTTP hook timeout is invalid");
  const target = parseTarget(definition.url);
  const assertTrust = (): void => {
    if (options.validateTrust && !options.validateTrust()) throw new HttpHookError("HTTP hook definition changed; review required");
  };
  const audit = (outcome: "allowed" | "denied"): void | Promise<void> => runtime.auditTarget({
    type: "hook_http_request", hookId: options.hookId, target: target.origin,
    routeDigest: sha256Hex(target.pathname + target.search), method: "POST", outcome,
  });
  const outcome = await runWithCeiling(async (signal) => {
    try {
      parseHttpHookDefinition(definition);
      if (!allowlisted(target, runtime.allowedUrls)) throw new HttpHookError("HTTP hook target is not allowlisted");
      const { headers, secrets } = interpolatedHeaders(definition, runtime);
      let body: string;
      try { body = JSON.stringify(payload); if (typeof body !== "string") throw new Error(); } catch { throw new HttpHookError("HTTP hook payload is invalid"); }
      if (Buffer.byteLength(body, "utf8") > MAX_HTTP_HOOK_BODY_BYTES) throw new HttpHookError("HTTP hook request exceeds size limit");
      const decision = await evaluateHostFetch({ pluginId: "hook", rawUrl: target.href, method: "POST", allowedDomains: [target.hostname] });
      signal.throwIfAborted();
      assertTrust();
      if (!decision.ok) throw new HttpHookError("HTTP hook target failed network policy");
      await audit("allowed");
      signal.throwIfAborted();
      assertTrust();
      const response = await runHostFetchHops({
        pluginId: "hook", first: decision, transport: runtime.transport,
        allowedDomains: [target.hostname], allowPrivateNetworks: false,
        init: { headers, body, redirect: "manual", signal },
        assertSendAllowed: () => { signal.throwIfAborted(); assertTrust(); },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new HttpHookError("HTTP hook redirects are refused");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpHookError("HTTP hook request failed");
      }
      return { stdout: redactHeaderFeedback(await readBoundedResponse(response, signal), secrets) };
    } catch (error) {
      try { await audit("denied"); } catch { throw new HttpHookError("HTTP hook audit failed"); }
      if (error instanceof HttpHookError) throw error;
      throw new HttpHookError("HTTP hook request failed");
    }
  }, Math.min(requestedTimeoutMs, DEFAULT_HOOK_TIMEOUT_MS, TOOL_TIMEOUT_POLICY.networkFetchDefaultMs), options.signal, "HTTP hook");
  if (!outcome.ok) {
    if (outcome.reason === "ceiling") throw new HttpHookError("HTTP hook timed out");
    if (outcome.reason === "user-abort") throw new HttpHookError("HTTP hook cancelled");
    throw outcome.error;
  }
  return outcome.value;
}
