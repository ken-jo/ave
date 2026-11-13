import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginDeviceAuth, type PluginDeviceAuthDependencies } from "../plugin-device-auth.js";
import type { DeviceCodeAuthorizationOptions } from "../../plugins/public-contract.js";

const ISSUER = "https://issuer.example.test";
const RESOURCE = "https://api.example.test/resource";
const OPTIONS: DeviceCodeAuthorizationOptions = { issuer: ISSUER, clientId: "public-client", resource: RESOURCE };
const liveManagers: PluginDeviceAuth[] = [];
afterEach(() => { for (const manager of liveManagers.splice(0)) manager.dispose(); });

function fixture(options: { dpop?: boolean; storage?: Map<string, string> } = {}) {
  const storage = options.storage ?? new Map<string, string>();
  const requests: Request[] = [];
  let tokenType = options.dpop ? "DPoP" : "Bearer";
  let accessToken = "initial-token";
  let refreshCount = 0;
  let tokenEndpointPath = "/token";
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname.includes(".well-known")) return json({
      issuer: ISSUER, device_authorization_endpoint: `${ISSUER}/device`, token_endpoint: `${ISSUER}${tokenEndpointPath}`,
      ...(options.dpop ? { dpop_signing_alg_values_supported: ["ES256"] } : {}),
    });
    if (url.pathname === "/device") return json({ device_code: "private-device-code", user_code: "ABCD-EFGH",
      verification_uri: `${ISSUER}/verify`, expires_in: 60, interval: 1 });
    if (url.pathname === tokenEndpointPath) {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") === "refresh_token") {
        refreshCount += 1;
        if (body.get("refresh_token") !== "bound-refresh") return json({ error: "invalid_grant" }, 400);
        accessToken = "rotated-token";
        return json({ access_token: accessToken, token_type: tokenType, expires_in: 60 });
      }
      return json({ access_token: accessToken, token_type: tokenType, refresh_token: "bound-refresh", expires_in: 0 });
    }
    if (request.url === RESOURCE) return new Response("resource-body", { status: 200 });
    throw new Error("Unexpected fixture request");
  });
  const show = vi.fn(async () => () => {});
  const dependencies: PluginDeviceAuthDependencies = {
    fetch: fetch as typeof globalThis.fetch,
    fetchAuthorization: ((input, init) => fetch(input, init)) as typeof globalThis.fetch,
    presentation: { available: () => true, show },
    enabled: () => true, headless: () => false,
    canStoreEncrypted: async () => true,
    getSecret: async key => storage.get(key) ?? null,
    setSecret: async (key, value) => { storage.set(key, value); },
    deleteSecret: async key => { storage.delete(key); },
  };
  const manager = (overrides: Partial<PluginDeviceAuthDependencies> = {}, pluginId = "device-plugin") => {
    const service = new PluginDeviceAuth(pluginId, { ...dependencies, ...overrides });
    liveManagers.push(service);
    return service;
  };
  return { storage, requests, fetch, show, manager, setTokenType: (value: string) => { tokenType = value; }, refreshCount: () => refreshCount,
    setTokenEndpoint: (path: string) => { tokenEndpointPath = path; } };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value was absent");
  return value;
}

function proof(request: Request): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const value = request.headers.get("dpop");
  expect(value).toBeTruthy();
  if (!value) throw new Error("Proof header was absent");
  const [header, payload] = value.split(".");
  if (!header || !payload) throw new Error("Proof serialization was invalid");
  return { header: JSON.parse(Buffer.from(header, "base64url").toString()), payload: JSON.parse(Buffer.from(payload, "base64url").toString()) };
}

describe("plugin device credentials", () => {
  it("requires explicit configuration and encrypted storage before egress", async () => {
    const f = fixture();
    await expect(f.manager({ enabled: () => false }).authorize(OPTIONS)).rejects.toThrow("oauth-device-not-enabled");
    await expect(f.manager({ canStoreEncrypted: async () => false }).authorize(OPTIONS)).rejects.toMatchObject({ code: "oauth-device-encrypted-storage-unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.show).not.toHaveBeenCalled();
  });

  it("denies headless device initiation without egress or a modal", async () => {
    const f = fixture();
    await expect(f.manager({ headless: () => true }).authorize(OPTIONS)).rejects.toThrow("Authenticate interactively");
    await expect(f.manager({ presentation: undefined }).authorize(OPTIONS)).rejects.toThrow("Authenticate interactively");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("denies required proof binding when metadata does not advertise it", async () => {
    const f = fixture();
    await expect(f.manager().authorize({ ...OPTIONS, dpop: "required" })).rejects.toMatchObject({ code: "oauth-device-unsupported" });
    expect(f.requests.map(request => new URL(request.url).pathname)).not.toContain("/device");
    expect(f.storage.size).toBe(0);
  });

  it("keeps token and key material in encrypted host persistence and uses the same key after restart and refresh", async () => {
    const f = fixture({ dpop: true });
    const first = f.manager();
    const result = await first.authorize(OPTIONS);
    expect(Object.keys(result)).toEqual(["handle"]);
    const loginToken = required(f.requests.find(request => new URL(request.url).pathname === "/token"));
    const loginKey = proof(loginToken).header.jwk;
    expect(f.storage.size).toBe(1);
    expect([...f.storage.keys()][0]).toMatch(/^oauth\.plugin-device\./u);
    const deviceRequest = required(f.requests.find(request => new URL(request.url).pathname === "/device"));
    expect(deviceRequest.headers.has("dpop")).toBe(false);
    first.dispose();

    const second = f.manager();
    const resumed = await second.authorize(OPTIONS);
    expect(f.show).toHaveBeenCalledTimes(1);
    expect(await (await second.fetch({ handle: resumed.handle, url: RESOURCE })).text()).toBe("resource-body");
    const tokens = f.requests.filter(request => new URL(request.url).pathname === "/token");
    expect(tokens).toHaveLength(2);
    expect(proof(required(tokens[1])).header.jwk).toEqual(loginKey);
    expect(new URLSearchParams(await required(tokens[1]).clone().text()).get("refresh_token")).toBe("bound-refresh");
    const resource = required(f.requests.find(request => request.url === RESOURCE));
    expect(resource.headers.get("authorization")).toBe("DPoP rotated-token");
    expect(proof(resource).header.jwk).toEqual(loginKey);
    expect(proof(resource).payload.ath).toBeTypeOf("string");
    expect(f.refreshCount()).toBe(1);
    expect(JSON.parse(required([...f.storage.values()][0])).tokens.refresh_token).toBe("bound-refresh");
  });

  it("binds handles to their incarnation and exact resource, and refuses competing credential headers", async () => {
    const f = fixture();
    const first = f.manager();
    const { handle } = await first.authorize(OPTIONS);
    const before = f.fetch.mock.calls.length;
    await expect(f.manager({}, "other-plugin").fetch({ handle, url: RESOURCE })).rejects.toThrow("unknown-handle");
    await expect(first.fetch({ handle, url: `${RESOURCE}/child` })).rejects.toThrow("audience-denied");
    await expect(first.fetch({ handle, url: RESOURCE, headers: { Authorization: "override" } })).rejects.toThrow("credential-conflict");
    expect(f.fetch).toHaveBeenCalledTimes(before);
    await first.clear({ handle });
    expect(f.storage.size).toBe(0);
    await expect(first.fetch({ handle, url: RESOURCE })).rejects.toThrow("unknown-handle");
  });

  it("refuses a bearer token after proof negotiation without persisting it", async () => {
    const f = fixture({ dpop: true });
    f.setTokenType("Bearer");
    await expect(f.manager().authorize(OPTIONS)).rejects.toThrow("token-binding-failed");
    expect(f.storage.size).toBe(0);
  });

  it("shares one refresh across concurrent resource calls", async () => {
    const f = fixture();
    const manager = f.manager();
    const { handle } = await manager.authorize(OPTIONS);
    const responses = await Promise.all([manager.fetch({ handle, url: RESOURCE }), manager.fetch({ handle, url: RESOURCE })]);
    expect(responses.every(response => response.ok)).toBe(true);
    expect(f.refreshCount()).toBe(1);
  });

  it("shares rotated credentials and refresh work across multiple handles for the same binding", async () => {
    const f = fixture();
    const manager = f.manager();
    const first = await manager.authorize(OPTIONS);
    const second = await manager.authorize(OPTIONS);
    expect(first.handle).not.toBe(second.handle);
    expect(f.show).toHaveBeenCalledTimes(1);
    const responses = await Promise.all([
      manager.fetch({ handle: first.handle, url: RESOURCE }), manager.fetch({ handle: second.handle, url: RESOURCE }),
    ]);
    expect(responses.every(response => response.ok)).toBe(true);
    expect(f.refreshCount()).toBe(1);
    await manager.clear(first);
    await expect(manager.fetch({ handle: second.handle, url: RESOURCE })).rejects.toThrow("unknown-handle");
  });

  it("signs a newly advertised token endpoint when refresh metadata changes", async () => {
    const f = fixture({ dpop: true });
    const manager = f.manager();
    const { handle } = await manager.authorize(OPTIONS);
    f.setTokenEndpoint("/rotated-endpoint");
    await manager.fetch({ handle, url: RESOURCE });
    const refreshed = required(f.requests.find(request => new URL(request.url).pathname === "/rotated-endpoint"));
    expect(proof(refreshed).payload.htu).toBe(`${ISSUER}/rotated-endpoint`);
  });

  it("aborts a refresh request when its resource caller cancels", async () => {
    const f = fixture();
    const manager = f.manager();
    const { handle } = await manager.authorize(OPTIONS);
    const implementation = required(f.fetch.getMockImplementation());
    let refreshSignal: AbortSignal | undefined;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/token") {
        refreshSignal = request.signal;
        return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError")), { once: true }));
      }
      return implementation(input, init);
    });
    const controller = new AbortController();
    const pending = manager.fetch({ handle, url: RESOURCE }, controller.signal);
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(refreshSignal).toBeDefined());
    controller.abort();
    await rejection;
    expect(refreshSignal?.aborted).toBe(true);
    expect(f.requests.some(request => request.url === RESOURCE)).toBe(false);
  });

  it("lets a new explicit authorization proceed after a failed persistence write", async () => {
    const f = fixture();
    let fail = true;
    const manager = f.manager({ setSecret: async (key, value) => {
      if (fail) throw new Error("Storage write failed");
      f.storage.set(key, value);
    } });
    await expect(manager.authorize(OPTIONS)).rejects.toThrow("Storage write failed");
    fail = false;
    const { handle } = await manager.authorize(OPTIONS);
    expect(handle).toBeTypeOf("string");
    expect(f.storage.size).toBe(1);
  });

  it("clears persisted credentials even when the last refresh write failed", async () => {
    const f = fixture();
    let fail = false;
    const manager = f.manager({ setSecret: async (key, value) => {
      if (fail) throw new Error("Storage write failed");
      f.storage.set(key, value);
    } });
    const { handle } = await manager.authorize(OPTIONS);
    fail = true;
    await expect(manager.fetch({ handle, url: RESOURCE })).rejects.toThrow("Storage write failed");
    await manager.clear({ handle });
    expect(f.storage.size).toBe(0);
  });

  it("rejects corrupt persisted credentials without opening another device flow", async () => {
    const f = fixture();
    const manager = f.manager();
    await manager.authorize(OPTIONS);
    const key = required([...f.storage.keys()][0]);
    f.storage.set(key, JSON.stringify({ binding: "wrong" }));
    await expect(f.manager().authorize(OPTIONS)).rejects.toThrow("storage-unreadable");
    expect(f.show).toHaveBeenCalledTimes(1);
  });
});
