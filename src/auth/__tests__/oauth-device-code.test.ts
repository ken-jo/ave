import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeDeviceCode, DEVICE_CODE_GRANT_TYPE, isOAuthConnectionTimeout, type DeviceCodePresentation, type DeviceCodePrompt } from "../oauth-device-code.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

const ORIGIN = "https://authorization.example.test";
const DEVICE_RESPONSE = {
  device_code: "secret-device-code", user_code: "ABCD-EFGH", verification_uri: `${ORIGIN}/verify`,
  verification_uri_complete: `${ORIGIN}/verify?code=ABCD-EFGH`, expires_in: 600, interval: 1,
};
const TOKENS = { access_token: "access-token", token_type: "Bearer", refresh_token: "refresh-token" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function fixture(options: { response?: Record<string, unknown>; human?: boolean } = {}) {
  const controller = new AbortController();
  const prompts: DeviceCodePrompt[] = [];
  const requests: Array<{ url: string; body: URLSearchParams; signal: AbortSignal }> = [];
  const dismiss = vi.fn();
  let modalController: AbortController | undefined;
  const presentation: DeviceCodePresentation = {
    available: () => options.human !== false,
    show: vi.fn(async (prompt, currentController) => {
      prompts.push(prompt);
      modalController = currentController;
      return dismiss;
    }),
  };
  const polls: Array<() => Promise<Response>> = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, body: new URLSearchParams(String(init?.body)), signal: init?.signal as AbortSignal });
    if (url === `${ORIGIN}/device`) return json(options.response ?? DEVICE_RESPONSE);
    const next = polls.shift();
    if (!next) throw new Error("Unexpected fixture poll");
    return next();
  }) as unknown as typeof fetch;
  const args = {
    metadata: { device_authorization_endpoint: `${ORIGIN}/device`, token_endpoint: `${ORIGIN}/token` },
    clientId: "public-client", scope: "tools", resource: "https://resource.example.test/mcp",
    fetchFn, presentation, signal: controller.signal,
  };
  return { args, controller, prompts, requests, dismiss, polls, fetchFn, presentation, cancel: () => modalController?.abort() };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

async function start(f: ReturnType<typeof fixture>) {
  const pending = authorizeDeviceCode(f.args);
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  return { pending };
}

describe("device authorization", () => {
  it("shows host-owned code and complete link, then sends only the device grant to the token endpoint", async () => {
    const f = fixture();
    f.polls.push(async () => json(TOKENS));
    const { pending } = await start(f);
    expect(f.prompts).toEqual([{
      userCode: DEVICE_RESPONSE.user_code, verificationUri: DEVICE_RESPONSE.verification_uri,
      verificationUriComplete: DEVICE_RESPONSE.verification_uri_complete, expiresAt: Date.now() + 600_000,
    }]);
    expect(f.prompts[0]).not.toHaveProperty("deviceCode");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].body.get("scope")).toBe("tools");
    await vi.advanceTimersByTimeAsync(999);
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(TOKENS);
    expect(f.requests[1].body.get("grant_type")).toBe(DEVICE_CODE_GRANT_TYPE);
    expect(f.requests[1].body.get("device_code")).toBe(DEVICE_RESPONSE.device_code);
    expect(f.requests[1].body.get("client_id")).toBe("public-client");
    expect(f.requests[1].body.get("resource")).toBe(f.args.resource);
    expect(f.dismiss).toHaveBeenCalledOnce();
  });

  it("uses the RFC default interval only when it is absent", async () => {
    const response: Record<string, unknown> = { ...DEVICE_RESPONSE };
    delete response.interval;
    const f = fixture({ response });
    f.polls.push(async () => json(TOKENS));
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(TOKENS);
  });

  it("keeps polling authorization_pending and permanently adds five seconds for each slow_down", async () => {
    const f = fixture();
    f.polls.push(
      async () => json({ error: "authorization_pending" }, 400),
      async () => json({ error: "slow_down" }, 400),
      async () => json({ error: "authorization_pending" }, 400),
      async () => json({ error: "slow_down" }, 400),
      async () => json(TOKENS),
    );
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5999);
    expect(f.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.requests).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.requests).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(10_999);
    expect(f.requests).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(TOKENS);
  });

  it.each([
    ["access_denied", "oauth-device-denied"],
    ["expired_token", "oauth-device-expired"],
    ["invalid_request", "oauth-device-failed"],
    ["invalid_client", "oauth-device-failed"],
    ["invalid_grant", "oauth-device-failed"],
    ["unauthorized_client", "oauth-device-failed"],
    ["unsupported_grant_type", "oauth-device-failed"],
    ["invalid_scope", "oauth-device-failed"],
    ["server_error", "oauth-device-failed"],
    ["unknown_error", "oauth-device-failed"],
    ["invalid_dpop_proof", "oauth-device-failed"],
    ["use_dpop_nonce", "oauth-device-failed"],
  ])("stops on %s without leaking provider error details", async (error, code) => {
    const f = fixture();
    f.polls.push(async () => json({ error, error_description: "secret-provider-value" }, 400));
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).rejects.toMatchObject({ code });
    await expect(pending).rejects.not.toThrow("secret-provider-value");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.requests).toHaveLength(2);
    expect(f.dismiss).toHaveBeenCalledOnce();
  });

  it("rejects an unavailable human surface before any egress", async () => {
    const f = fixture({ human: false });
    await expect(authorizeDeviceCode(f.args)).rejects.toMatchObject({ code: "oauth-device-headless" });
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("requires an advertised device endpoint before egress", async () => {
    const f = fixture();
    await expect(authorizeDeviceCode({ ...f.args, metadata: { token_endpoint: `${ORIGIN}/token` } })).rejects.toMatchObject({ code: "oauth-device-unsupported" });
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, 0.5, "1", Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])("rejects invalid expires_in %s", async (expires_in) => {
    const f = fixture({ response: { ...DEVICE_RESPONSE, expires_in } });
    await expect(authorizeDeviceCode(f.args)).rejects.toMatchObject({ code: "oauth-device-failed" });
    expect(f.requests).toHaveLength(1);
    expect(f.presentation.show).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, "1", Number.POSITIVE_INFINITY])("rejects invalid interval %s", async (interval) => {
    const f = fixture({ response: { ...DEVICE_RESPONSE, interval } });
    await expect(authorizeDeviceCode(f.args)).rejects.toMatchObject({ code: "oauth-device-failed" });
    expect(f.presentation.show).not.toHaveBeenCalled();
  });

  it.each(["http://authorization.example.test/device", "https://u:p@example.test/device", "https://example.test/device#fragment", "file:///device"]) ("rejects unsafe endpoint %s before egress", async (endpoint) => {
    const f = fixture();
    await expect(authorizeDeviceCode({ ...f.args, metadata: { ...f.args.metadata, device_authorization_endpoint: endpoint } })).rejects.toMatchObject({ code: "oauth-device-failed" });
    expect(f.requests).toHaveLength(0);
  });

  it.each(["verification_uri", "verification_uri_complete"]) ("rejects unsafe displayed %s", async (field) => {
    const f = fixture({ response: { ...DEVICE_RESPONSE, [field]: "javascript:alert(1)" } });
    await expect(authorizeDeviceCode(f.args)).rejects.toMatchObject({ code: "oauth-device-failed" });
    expect(f.presentation.show).not.toHaveBeenCalled();
  });

  it("permits cleartext loopback only when the host explicitly enables it", async () => {
    const f = fixture({ response: { ...DEVICE_RESPONSE, verification_uri: "http://127.0.0.1/verify" } });
    await expect(authorizeDeviceCode(f.args)).rejects.toMatchObject({ code: "oauth-device-failed" });
    const allowed = fixture({ response: { ...DEVICE_RESPONSE, verification_uri: "http://127.0.0.1/verify" } });
    allowed.polls.push(async () => json(TOKENS));
    const pending = authorizeDeviceCode({ ...allowed.args, allowLoopback: true });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual(TOKENS);
  });

  it("does not poll after local expiry", async () => {
    const f = fixture({ response: { ...DEVICE_RESPONSE, expires_in: 1, interval: 2 } });
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).rejects.toMatchObject({ code: "oauth-device-expired" });
    expect(f.requests).toHaveLength(1);
    expect(f.dismiss).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight poll at expiry even when the transport never settles", async () => {
    const f = fixture({ response: { ...DEVICE_RESPONSE, expires_in: 2 } });
    f.polls.push(() => new Promise<Response>(() => {}));
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).rejects.toMatchObject({ code: "oauth-device-expired" });
    expect(f.requests[1].signal.aborted).toBe(true);
  });

  it.each(["parent", "modal"]) ("cancels through the %s controller", async (source) => {
    const f = fixture();
    const { pending } = await start(f);
    if (source === "parent") f.controller.abort();
    else f.cancel();
    await expect(pending).rejects.toMatchObject({ code: "oauth-device-canceled" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.requests).toHaveLength(1);
    expect(f.dismiss).toHaveBeenCalledOnce();
  });

  it("rejects already-canceled requests without egress", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(authorizeDeviceCode(f.args)).rejects.toMatchObject({ code: "oauth-device-canceled" });
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("reduces frequency after connection timeouts", async () => {
    const f = fixture();
    f.polls.push(async () => { throw new DOMException("secret transport details", "TimeoutError"); }, async () => json(TOKENS));
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(TOKENS);
  });

  it("uses the host network deadline and aborts a stalled transport before reducing polling frequency", async () => {
    const f = fixture();
    f.polls.push(() => new Promise<Response>(() => {}), async () => json(TOKENS));
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.networkFetchDefaultMs);
    expect(f.requests[1].signal.aborted).toBe(true);
    expect(f.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toEqual(TOKENS);
  });

  it("stops on connection errors other than timeout", async () => {
    const f = fixture();
    f.polls.push(async () => { throw new TypeError("private network details"); });
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).rejects.toMatchObject({ code: "oauth-device-failed" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.requests).toHaveLength(2);
  });

  it("rejects malformed tokens and never returns provider error text", async () => {
    const f = fixture();
    f.polls.push(async () => json({ token_type: "Bearer", error_description: "secret-provider-value" }));
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).rejects.toMatchObject({ code: "oauth-device-failed" });
  });
});

describe("device authorization discovery", () => {
  const metadata = {
    issuer: ORIGIN, token_endpoint: `${ORIGIN}/token`, device_authorization_endpoint: `${ORIGIN}/device`,
    dpop_signing_alg_values_supported: ["ES256"], token_endpoint_auth_methods_supported: ["none"],
  };

  it("discovers a device-only server without an authorization endpoint", async () => {
    const { discoverDeviceAuthorizationMetadata } = await import("../oauth-device-code.js");
    const fetchFn = vi.fn(async () => json(metadata)) as unknown as typeof fetch;
    await expect(discoverDeviceAuthorizationMetadata(ORIGIN, fetchFn)).resolves.toEqual(metadata);
    expect(fetchFn).toHaveBeenCalledWith(`${ORIGIN}/.well-known/oauth-authorization-server`, expect.objectContaining({ redirect: "error" }));
  });

  it("places well-known before an issuer path and supports the alternate metadata URL styles", async () => {
    const { discoverDeviceAuthorizationMetadata } = await import("../oauth-device-code.js");
    const urls: string[] = [];
    const issuer = `${ORIGIN}/tenant`;
    const fetchFn = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length < 3) return new Response("not found", { status: 404 });
      return json({ ...metadata, issuer });
    }) as typeof fetch;
    await expect(discoverDeviceAuthorizationMetadata(issuer, fetchFn)).resolves.toMatchObject({ issuer });
    expect(urls).toEqual([
      `${ORIGIN}/.well-known/oauth-authorization-server/tenant`,
      `${ORIGIN}/.well-known/openid-configuration/tenant`,
      `${ORIGIN}/tenant/.well-known/openid-configuration`,
    ]);
  });

  it("rejects a different issuer without trying another metadata source", async () => {
    const { discoverDeviceAuthorizationMetadata } = await import("../oauth-device-code.js");
    const fetchFn = vi.fn(async () => json({ ...metadata, issuer: "https://other.example.test" })) as unknown as typeof fetch;
    await expect(discoverDeviceAuthorizationMetadata(ORIGIN, fetchFn)).rejects.toMatchObject({ code: "oauth-device-failed" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([
    { token_endpoint: undefined },
    { token_endpoint: "http://authorization.example.test/token" },
    { device_authorization_endpoint: "https://u:p@example.test/device" },
    { token_endpoint_auth_methods_supported: "none" },
    { token_endpoint_auth_methods_supported: [1] },
    { dpop_signing_alg_values_supported: "ES256" },
    { dpop_signing_alg_values_supported: [null] },
    { registration_endpoint: false },
  ])("rejects malformed metadata %o", async (patch) => {
    const { discoverDeviceAuthorizationMetadata } = await import("../oauth-device-code.js");
    const fetchFn = (async () => json({ ...metadata, ...patch })) as typeof fetch;
    await expect(discoverDeviceAuthorizationMetadata(ORIGIN, fetchFn)).rejects.toMatchObject({ code: "oauth-device-failed" });
  });

  it("rejects missing device metadata clearly", async () => {
    const { discoverDeviceAuthorizationMetadata } = await import("../oauth-device-code.js");
    const fetchFn = (async () => json({ issuer: ORIGIN, token_endpoint: metadata.token_endpoint })) as typeof fetch;
    await expect(discoverDeviceAuthorizationMetadata(ORIGIN, fetchFn)).rejects.toMatchObject({ code: "oauth-device-unsupported" });
  });

  it("does not try another metadata endpoint after a server failure", async () => {
    const { discoverDeviceAuthorizationMetadata } = await import("../oauth-device-code.js");
    const fetchFn = vi.fn(async () => json({ error: "server_error" }, 500)) as unknown as typeof fetch;
    await expect(discoverDeviceAuthorizationMetadata(ORIGIN, fetchFn)).rejects.toMatchObject({ code: "oauth-device-failed" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("refuses loopback discovery unless explicitly enabled", async () => {
    const { discoverDeviceAuthorizationMetadata } = await import("../oauth-device-code.js");
    const issuer = "http://127.0.0.1:12345";
    const fetchFn = vi.fn(async () => json({ issuer, token_endpoint: `${issuer}/token`, device_authorization_endpoint: `${issuer}/device` })) as unknown as typeof fetch;
    await expect(discoverDeviceAuthorizationMetadata(issuer, fetchFn)).rejects.toMatchObject({ code: "oauth-device-failed" });
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(discoverDeviceAuthorizationMetadata(issuer, fetchFn, { allowLoopback: true })).resolves.toMatchObject({ issuer });
  });
});

describe("device authorization cleanup", () => {
  it("releases a modal that finishes opening after cancellation exactly once", async () => {
    const f = fixture();
    let opened: (() => void) | undefined;
    f.presentation.show = async () => new Promise<() => void>((resolve) => { opened = () => resolve(f.dismiss); });
    const { pending } = await start(f);
    f.controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "oauth-device-canceled" });
    opened?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dismiss).toHaveBeenCalledOnce();
  });

  it("aborts a stalled initial authorization request on cancellation", async () => {
    const f = fixture();
    let networkSignal: AbortSignal | undefined;
    f.args.fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      networkSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const { pending } = await start(f);
    f.controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "oauth-device-canceled" });
    expect(networkSignal?.aborted).toBe(true);
    expect(f.presentation.show).not.toHaveBeenCalled();
  });

  it.each([
    { access_token: "", token_type: "Bearer" },
    { access_token: "token", token_type: "unknown" },
    { access_token: "token", token_type: "Bearer", expires_in: -1 },
    { access_token: "token", token_type: "Bearer", refresh_token: "" },
  ])("rejects invalid successful token response %o", async (tokens) => {
    const f = fixture();
    f.polls.push(async () => json(tokens));
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).rejects.toMatchObject({ code: "oauth-device-failed" });
  });
});

describe("authorization connection timeout identity", () => {
  it.each(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])("recognizes transport cause %s and doubles polling interval", async (code) => {
    const error = new TypeError("fetch failed", { cause: { code } });
    expect(isOAuthConnectionTimeout(error)).toBe(true);
    const f = fixture();
    f.polls.push(async () => { throw error; }, async () => json(TOKENS));
    const { pending } = await start(f);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(TOKENS);
  });

  it.each([
    new TypeError("fetch failed"),
    new DOMException("The request was aborted", "AbortError"),
    new Error("ETIMEDOUT text is not timeout identity"),
    { cause: { code: "ECONNREFUSED" } },
    { name: "AbortError", cause: { code: "ETIMEDOUT" } },
    undefined,
    null,
  ])("refuses generic failures and cancellation %o", (error) => {
    expect(isOAuthConnectionTimeout(error)).toBe(false);
  });

  it("recognizes a nested cause and stops at cycles or the cause depth limit", () => {
    expect(isOAuthConnectionTimeout(new Error("outer", { cause: new Error("inner", { cause: { code: "ETIMEDOUT" } }) }))).toBe(true);
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(isOAuthConnectionTimeout(cycle)).toBe(false);
    let deep: unknown = { code: "ETIMEDOUT" };
    for (let depth = 0; depth < 9; depth += 1) deep = { cause: deep };
    expect(isOAuthConnectionTimeout(deep)).toBe(false);
  });
});
