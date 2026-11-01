// Every host fetch passes URL validation, HTTPS policy, manifest allowlisting, and DNS-aware SSRF checks. Private-network approval and literal loopback
// declarations are independent grants; neither implies the other.
import { isLoopbackHost, urlHostMatchesAllowList } from "./host-allow-list.js";
import {
  validateHttpUrl,
  ensurePublicHttpUrl,
  resolvesToLoopbackOnly,
  resolvesToPrivateNetworkOnly,
  NetworkGuardError,
} from "../core/network-guard.js";
import { methodEffect, type Effect } from "../permissions/effect-kind.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

// Reason buckets used for egress-denial telemetry + audit detail.
export type HostFetchDenyReason =
  | "invalid-url"
  | "non-https"
  | "malformed-allowlist"
  | "not-allowlisted"
  | "ssrf-blocked";

// A denied request — the caller emits audit/telemetry then throws `message`.
export interface HostFetchDeny {
  ok: false;
  reason: HostFetchDenyReason;
  // Audit-line detail (no secrets).
  detail: string;
  // Error message surfaced to the calling plugin.
  message: string;
}

// An allowed request — the caller egresses to `url`.
export interface HostFetchAllow {
  ok: true;
  url: URL;
  // Normalized HTTP method this decision was evaluated for (uppercased).
  method: string;
  // Derive read/write effect from the host-observed method for audit only; it changes no egress permission decision.
  effect: Effect;
}

export type HostFetchDecision = HostFetchAllow | HostFetchDeny;

export interface HostFetchGuardInput {
  pluginId: string;
  // Raw target passed by the plugin (string or URL, already stringified).
  rawUrl: string;
  // HTTP method of the request — defaults to `"GET"` when omitted (matches the `init.method` default at the hostFetch chokepoint). Used ONLY to compute
  // the host-observed {@link HostFetchAllow.effect}; it does not gate egress.
  method?: string;
  // Normalized `manifest.networkAccess.allowedDomains`, validated at manifest load / host API creation. Deny-by-default when empty.
  allowedDomains: string[];
  // `manifest.networkAccess.allowPrivateNetworks` — the declarative, user-approved governance opt-in for reaching RFC1918 / ULA endpoints.
  // Deny-by-default: absent/false rejects private targets. Loopback is NOT this flag — see the loopback axis in the file header.
  allowPrivateNetworks?: boolean;
  // Injectable SSRF resolver — defaults to {@link ensurePublicHttpUrl}. Tests inject a resolver backed by a mocked `node:dns` so the layered decision can
  // be exercised without live DNS. Production passes nothing.
  ensurePublicUrl?: typeof ensurePublicHttpUrl;
  // Injectable loopback proof — defaults to {@link resolvesToLoopbackOnly}. Same seam, same reason as {@link ensurePublicUrl}.
  resolveLoopbackOnly?: typeof resolvesToLoopbackOnly;
  // Injectable private-network proof — defaults to {@link resolvesToPrivateNetworkOnly}. Same seam, same reason.
  resolvePrivateOnly?: typeof resolvesToPrivateNetworkOnly;
}

function deny(
  pluginId: string,
  reason: HostFetchDenyReason,
  detail: string,
  message: string,
): HostFetchDeny {
  return { ok: false, reason, detail, message: `[plugin:${pluginId}] ${message}` };
}

// Evaluate per-call egress without audit side effects; DNS resolution is the only impure step, and callers own reporting.
export async function evaluateHostFetch(
  input: HostFetchGuardInput,
): Promise<HostFetchDecision> {
  const {
    pluginId,
    rawUrl,
    method = "GET",
    allowedDomains,
    allowPrivateNetworks = false,
    ensurePublicUrl = ensurePublicHttpUrl,
    resolveLoopbackOnly = resolvesToLoopbackOnly,
    resolvePrivateOnly = resolvesToPrivateNetworkOnly,
  } = input;
  // Host-observed effect — derived from the verb the host holds at the chokepoint, not from anything the plugin self-declares. Recorded on the allow
  // decision; it does not participate in any deny branch below.
  const normalizedMethod = method.toUpperCase();
  const effect: Effect = methodEffect(normalizedMethod);

  let url: URL;
  try {
    url = validateHttpUrl(rawUrl);
  } catch (err) {
    const reason = err instanceof NetworkGuardError ? err.message : "invalid URL";
    return deny(pluginId, "invalid-url", `invalid URL: ${reason}`, `hostFetch rejected: ${reason}`);
  }

  // Local reach requires both a loopback literal and its user-approved manifest declaration; DNS resolution alone cannot grant it.
  const allowListed = urlHostMatchesAllowList(url.hostname, allowedDomains);
  const declaredLoopback = allowListed && isLoopbackHost(url.hostname);

  // Allow cleartext declared loopback only after every resolved address proves local; poisoned hosts entries must not put credentials on the wire.
  if (url.protocol !== "https:") {
    const provenLocal = declaredLoopback && (await resolveLoopbackOnly(url.hostname));
    // Cleartext intranet requires an allowlisted host, private-network opt-in, and exclusively private DNS answers.
    // Hostile private DNS can still redirect within the LAN; that exposure is part of the explicit opt-in.
    const provenPrivate =
      !provenLocal
      && allowListed
      && allowPrivateNetworks
      && (await resolvePrivateOnly(url.hostname));
    if (!provenLocal && !provenPrivate) {
      const suffix = declaredLoopback
        ? " (declared loopback host does not resolve to loopback)"
        : allowListed && allowPrivateNetworks
          ? " (allowPrivateNetworks is declared but the host does not resolve to private addresses only)"
          : "";
      return deny(
        pluginId,
        "non-https",
        `non-https scheme ${url.protocol}//${url.hostname}${suffix}`,
        declaredLoopback
          ? `hostFetch denied: ${url.hostname} is declared as loopback but does not resolve to a loopback address`
          : allowListed && allowPrivateNetworks
            ? `hostFetch denied: cleartext to ${url.hostname} requires every resolved address to be private (got a non-private answer or no answer)`
            : `hostFetch denied: only https is permitted (got ${url.protocol})`,
      );
    }
  }

  // Deny-by-default allow-list (complete mediation): the plugin may only reach hosts declared in `manifest.networkAccess.allowedDomains`. The list has
  // already been normalized/validated before this hot path.
  if (!allowListed) {
    return deny(
      pluginId,
      "not-allowlisted",
      `${url.protocol}//${url.hostname} not in networkAccess.allowedDomains`,
      `hostFetch denied: ${url.hostname} is not in networkAccess.allowedDomains (deny-by-default)`,
    );
  }

  // Recheck resolved addresses for every request; allowlisting alone cannot stop private, metadata, or rebinding pivots.
  try {
    // `allowLoopback` is scoped to the declared-literal decision above and is never derived from `allowPrivateNetworks`: an RFC1918 grant cannot reach
    // 127.0.0.1, and a local-endpoint grant cannot reach the LAN.
    await ensurePublicUrl(url.toString(), {
      allowPrivateNetworks,
      allowLoopback: declaredLoopback,
    });
  } catch (err) {
    const reason = err instanceof NetworkGuardError ? err.message : "SSRF check failed";
    return deny(
      pluginId,
      "ssrf-blocked",
      `${url.protocol}//${url.hostname} ${reason}`,
      `hostFetch denied: ${reason}`,
    );
  }

  return { ok: true, url, method: normalizedMethod, effect };
}

// Statuses that name another location instead of answering.
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

// How many gated hops a `redirect: "follow"` request may take after the first.
export const MAX_REDIRECT_HOPS = 5;
export const CREDENTIAL_HEADERS = [
  "authorization", "proxy-authorization", "cookie", "api-key", "x-api-key",
  "ocp-apim-subscription-key",
] as const;

// The callback runs synchronously at the first header-emitting operation.
export type HostFetchTransport = typeof fetch & {
  sendWithHandoff(input: string, init: RequestInit, beforeSend: () => void): Promise<Response>;
};

export interface HostFetchHopOptions {
  // The plugin whose manifest governs every hop.
  pluginId: string;
  // The first request, already evaluated and allowed by {@link evaluateHostFetch}.
  first: HostFetchAllow;
  // Everything from the plugin's `init` except `method` (verb-snapshot rule).
  init: Omit<RequestInit, "method">;
  // The single-hop transport (`createSingleHopFetch`). CONTRACT: it never follows a redirect — a 3xx comes back as a Response with `location` set. A
  // transport that followed on its own would move requests past this gate, which is the exact failure this loop exists to close.
  transport: HostFetchTransport | typeof fetch;
  // `manifest.networkAccess.allowedDomains`, same list every hop.
  allowedDomains: string[];
  // `manifest.networkAccess.allowPrivateNetworks`, same flag every hop.
  allowPrivateNetworks: boolean;
  // Inject vault cookies per hop using that URL’s scope, after stripping prior cross-origin credentials.
  // Plugins cannot supply Cookie alongside vault injection; an empty result leaves the header unset.
  injectSessionCookie?: (url: URL) => Promise<string>;
  credentialUse?: {
    signal: AbortSignal;
    assertLive(stage: "before-send" | "redirect" | "after-await"): void;
    headersFor(url: URL, hop: number): Headers;
    finish(): void;
  };
  // Authorize the exact actual hop after destination and credential checks, before any transport send.
  authorizeHop?: (hop: { url: URL; method: string; body: BodyInit | null | undefined; headers: Headers; index: number }) => Promise<void>;
  // Recheck synchronous authority immediately before transport and again after any deferred body preparation at handoff.
  assertSendAllowed?: () => void;
  // Audit sink for an allowed hop (hop >= 1; the caller logged hop 0).
  auditHop?: (line: string) => void;
  // Audit sink for a denied hop — same shape the caller uses for hop 0.
  auditDeny?: (reason: HostFetchDenyReason | "redirect-cap", detail: string) => void;
  // The response body can fail after this function has returned to its caller.
  onResponseBodyError?: (error: unknown) => void;
  // Test seams, forwarded into {@link evaluateHostFetch} per hop.
  ensurePublicUrl?: HostFetchGuardInput["ensurePublicUrl"];
  resolveLoopbackOnly?: HostFetchGuardInput["resolveLoopbackOnly"];
  resolvePrivateOnly?: HostFetchGuardInput["resolvePrivateOnly"];
}

// The host follows redirects only after full gating at every hop; manual returns 3xx and unknown policy fails closed.
// Use fetch method-rewrite rules, refuse replay of drained streams, and drop authorization, proxy-authorization, and cookie across origins.
export async function runHostFetchHops(options: HostFetchHopOptions): Promise<Response> {
  const {
    pluginId,
    first,
    init,
    transport,
    allowedDomains,
    allowPrivateNetworks,
    auditHop,
    auditDeny,
    onResponseBodyError,
    ensurePublicUrl,
    resolveLoopbackOnly,
    resolvePrivateOnly,
    injectSessionCookie,
    credentialUse,
    authorizeHop,
    assertSendAllowed,
  } = options;
  const requestedPolicy = init.redirect;
  const policy: "error" | "manual" | "follow" =
    requestedPolicy === "manual" || requestedPolicy === "follow" ? requestedPolicy : "error";
  // Normalized ONCE so per-hop credential stripping operates on one object rather than on whatever shape (Headers / entries / record) the plugin sent.
  const headers = new Headers((init.headers as HeadersInit | undefined) ?? {});
  let url = first.url;
  let method = first.method;
  let body = init.body;
  const handoffTransport = "sendWithHandoff" in transport && typeof transport.sendWithHandoff === "function"
    ? transport : null;
  // Recompute cookies for each redirect hop’s URL to prevent cross-origin reuse; remove the header when no cookie applies.
  const applyInjectedCookie = async (target: URL): Promise<void> => {
    if (!injectSessionCookie) return;
    const header = await injectSessionCookie(target);
    if (header.length > 0) headers.set("cookie", header);
    else headers.delete("cookie");
  };
  const finishResponse = (response: Response): Response => {
    if (!credentialUse) return response;
    if (!response.body) { credentialUse.finish(); return response; }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          credentialUse.assertLive("after-await");
          if (next.done) { credentialUse.finish(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) {
          try { onResponseBodyError?.(error); } catch { /* preserve the original body failure */ }
          credentialUse.finish();
          controller.error(error);
        }
      },
      async cancel(reason) { credentialUse.finish(); await reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  try {
  if (credentialUse && handoffTransport === null) {
    throw new Error("hostFetch internal error: credential transport lacks sendWithHandoff");
  }
  await applyInjectedCookie(url);
  for (let hop = 0; ; hop++) {
    credentialUse?.assertLive(hop === 0 ? "after-await" : "redirect");
    for (const [key, value] of credentialUse?.headersFor(url, hop) ?? []) headers.set(key, value);
    await authorizeHop?.({ url: new URL(url), method, body, headers: new Headers(headers), index: hop });
    credentialUse?.assertLive("after-await");
    // Bound each hop until response headers arrive, then clear the timer; body consumption belongs to the caller.
    const hopDeadline = new AbortController();
    const hopTimer = setTimeout(() => hopDeadline.abort(), TOOL_TIMEOUT_POLICY.pluginFetchResponseCeilingMs);
    let response: Response;
    // The first header-emitting operation was attempted; wire delivery is not inferred from this flag. It only selects the error stage after abort.
    let handedOff = false;
    try {
      const transportInit: RequestInit = {
        ...init,
        headers,
        body,
        method,
        // The plugin's own signal still cancels; the ceiling only adds an upper bound it cannot raise.
        signal: AbortSignal.any([
          hopDeadline.signal,
          ...(init.signal ? [init.signal] : []),
          ...(credentialUse ? [credentialUse.signal] : []),
        ]),
        // The transport ignores this by contract; pinned so a call site reads true and a future fetch-shaped transport fails toward NOT following.
        redirect: "manual",
      };
      // A transport with a deferred body must recheck at the first write/end. Plain fetch-shaped test transports hand off at their synchronous call.
      const beforeSend = (): void => {
        assertSendAllowed?.();
        credentialUse?.assertLive("before-send");
        handedOff = true;
      };
      assertSendAllowed?.();
      response = handoffTransport
        ? await handoffTransport.sendWithHandoff(url.toString(), transportInit, beforeSend)
        : await transport(url.toString(), transportInit);
    } catch (error) {
      // A cross-process observation can abort the active use while the transport is waiting for a body chunk. Preserve the lease error axis.
      if (credentialUse?.signal.aborted) credentialUse.assertLive(handedOff ? "after-await" : "before-send");
      throw error;
    } finally {
      clearTimeout(hopTimer);
    }
    credentialUse?.assertLive("after-await");
    if (!REDIRECT_STATUSES.has(response.status)) return finishResponse(response);
    const location = response.headers.get("location");
    // A 3xx without a location names nowhere; per fetch it is a final response.
    if (location === null) return finishResponse(response);
    if (policy === "error") {
      auditDeny?.(
        "redirect-cap",
        `redirect refused (policy error): ${response.status} at ${url.origin}`,
      );
      throw new Error(
        `[plugin:${pluginId}] hostFetch: redirect refused — ${response.status} from ${url.origin} `
          + `(init.redirect is "error"; pass "manual" to see the redirect or "follow" for gated hops)`,
      );
    }
    if (policy === "manual") return finishResponse(response);
    if (hop >= MAX_REDIRECT_HOPS) {
      auditDeny?.("redirect-cap", `redirect cap exceeded after ${MAX_REDIRECT_HOPS} hops at ${url.origin}`);
      throw new Error(
        `[plugin:${pluginId}] hostFetch: too many redirects (limit ${MAX_REDIRECT_HOPS})`,
      );
    }
    let nextRaw: string;
    try {
      nextRaw = new URL(location, url).toString();
    } catch {
      throw new Error(`[plugin:${pluginId}] hostFetch: unparseable redirect location`);
    }
    // THE point of this loop: the next hop faces the same complete gate the first request did. `net.fetch`'s own follow mode is refused as the transport
    // precisely because it cannot stop here.
    const decision = await evaluateHostFetch({
      pluginId,
      rawUrl: nextRaw,
      method,
      allowedDomains,
      allowPrivateNetworks,
      ...(ensurePublicUrl ? { ensurePublicUrl } : {}),
      ...(resolveLoopbackOnly ? { resolveLoopbackOnly } : {}),
      ...(resolvePrivateOnly ? { resolvePrivateOnly } : {}),
    });
    credentialUse?.assertLive("after-await");
    if (!decision.ok) {
      auditDeny?.(decision.reason, `redirect hop ${hop + 1}: ${decision.detail}`);
      throw new Error(decision.message);
    }
    if (
      response.status === 303
      || ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    } else if (
      (response.status === 307 || response.status === 308)
      && body !== null
      && body !== undefined
      && typeof (body as ReadableStream).getReader === "function"
    ) {
      // The stream was consumed sending hop N; replaying it would send an empty body and call it the same request.
      throw new Error(
        `[plugin:${pluginId}] hostFetch: ${response.status} redirect cannot replay a stream body`,
      );
    }
    if (decision.url.origin !== url.origin) {
      for (const header of CREDENTIAL_HEADERS) headers.delete(header);
      headers.delete("anthropic-version");
    }
    url = decision.url;
    // Re-scope the vault's cookies to the NEW hop URL. Placed after the cross-origin strip so a same-origin hop refreshes its cookie and a cross-origin hop
    // — whose prior `cookie` was just dropped — receives only what the vault scopes to the new origin (empty ⇒ header stays removed).
    await applyInjectedCookie(url);
    credentialUse?.assertLive("after-await");
    auditHop?.(`host_fetch ${url.origin} method=${method} effect=${decision.effect} hop=${hop + 1}`);
  }
  } catch (error) {
    credentialUse?.finish();
    throw error;
  }
}
