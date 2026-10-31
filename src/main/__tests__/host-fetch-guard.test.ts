// Stub DNS to exercise private-address rejection even for allow-listed names.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { REDIRECT_STATUSES } from "../host-fetch-guard.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { CredentialLeaseRegistry } from "../../plugins/secret-access/credential-lease-registry.js";
import { directHostFetchTransport } from "../../__tests__/support/host-fetch-transport.js";

const lookupMock = vi.fn<
  (host: string, opts: unknown) => Promise<Array<{ address: string; family: number }>>
>();

vi.mock("node:dns", () => ({
  promises: {
    lookup: (host: string, opts: unknown) => lookupMock(host, opts),
  },
}));

// Module under test imported AFTER the mock so network-guard's `import { promises as dns } from "node:dns"` binds to the stub.
const { evaluateHostFetch, runHostFetchHops, MAX_REDIRECT_HOPS } = await import(
  "../host-fetch-guard.js",
);

beforeEach(() => {
  lookupMock.mockReset();
});

const ALLOW = ["api.example.com"];

describe("evaluateHostFetch — allow-list + scheme gating", () => {
  it("denies a host not in the allow-list before any DNS lookup", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://evil.com/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-allowlisted");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("reports allow-list denials by hostname, not host:port", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://evil.com:8443/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("not-allowlisted");
      expect(decision.detail).toBe("https://evil.com not in networkAccess.allowedDomains");
      expect(decision.message).toContain("evil.com is not in networkAccess.allowedDomains");
      expect(decision.detail).not.toContain(":8443");
      expect(decision.message).not.toContain(":8443");
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("denies cleartext http even for an allow-listed host", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://api.example.com/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
  });

  it("denies an empty allow-list (deny-by-default)", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: [],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-allowlisted");
  });

  it("allows an allow-listed host resolving to a public address", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/v1/me",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.url.href).toBe("https://api.example.com/v1/me");
    expect(lookupMock).toHaveBeenCalledOnce();
  });
});

describe("evaluateHostFetch — method-awareness (host-observed effect)", () => {
  async function allowedWithMethod(method?: string) {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    return evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
      ...(method !== undefined ? { method } : {}),
    });
  }

  it.each(["GET", "HEAD", "OPTIONS", "get", "head", "options"])(
    "classifies safe verb %s as effect=read",
    async (method) => {
      const decision = await allowedWithMethod(method);
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.effect).toBe("read");
        expect(decision.method).toBe(method.toUpperCase());
      }
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "post", "put", "patch", "delete"])(
    "classifies mutating verb %s as effect=write",
    async (method) => {
      const decision = await allowedWithMethod(method);
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.effect).toBe("write");
        expect(decision.method).toBe(method.toUpperCase());
      }
    },
  );

  it("defaults to GET / effect=read when method is omitted", async () => {
    const decision = await allowedWithMethod(undefined);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.method).toBe("GET");
      expect(decision.effect).toBe("read");
    }
  });

  it("method does NOT change a deny decision — allow-list still wins (byte-for-byte)", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://evil.com/x",
      allowedDomains: ALLOW,
      method: "POST",
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-allowlisted");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("method does NOT bypass the SSRF guard — a POST to a private IP is still blocked", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
      method: "POST",
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });
});

describe("evaluateHostFetch — SSRF guard on allow-listed names", () => {
  it("rejects an allow-listed name resolving to the AWS metadata IP", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/latest/meta-data/",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });

  it("rejects an allow-listed name resolving to loopback (127.0.0.1)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });

  it("rejects an allow-listed name resolving to an RFC1918 address (DNS rebinding)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "192.168.1.10", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });
});

describe("evaluateHostFetch — allowPrivateNetworks governance opt-in", () => {
  it("permits an RFC1918 target only when the manifest opts in", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.10.1.209", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(true);
  });

  it("still rejects loopback even with allowPrivateNetworks (not a private LAN range)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });

  it("still rejects the metadata IP even with allowPrivateNetworks", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });
});

describe("evaluateHostFetch — declared loopback endpoint (local inference server)", () => {
  // What a user pointing a plugin at LM Studio / LiteLLM / a local proxy has: a manifest that names the local machine, and a server that speaks http.
  const LOCAL = ["localhost", "127.0.0.1", "::1", "api.example.com"];

  it("allows cleartext http to a declared 127.0.0.1 endpoint", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://127.0.0.1:1234/v1/embeddings",
      method: "POST",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.effect).toBe("write");
    // An IP literal is its own resolution — no name to rebind, no lookup.
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("allows cleartext http to a declared localhost that resolves to loopback", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://localhost:1234/v1/embeddings",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(true);
  });

  it("allows https to the same declared loopback endpoint", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://127.0.0.1:8443/v1/embeddings",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(true);
  });

  it("matches a declared `::1` against the bracketed URL host", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://[::1]:1234/v1/embeddings",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(true);
  });

  it("denies cleartext http to loopback the manifest never declared", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://127.0.0.1:1234/v1/embeddings",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("denies https to loopback the manifest never declared", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://127.0.0.1:8443/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-allowlisted");
  });

  it("denies cleartext http to a declared localhost that resolves off-machine", async () => {
    // Poisoned hosts file / rebinding answer: the literal was declared, but the request would leave the machine, so the https rule applies again.
    lookupMock.mockResolvedValue([{ address: "203.0.113.7", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://localhost:1234/v1/embeddings",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("non-https");
      expect(decision.detail).toContain("does not resolve to loopback");
    }
  });

  it("denies cleartext http to a declared localhost that resolves to loopback AND a routable address", async () => {
    lookupMock.mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
      { address: "203.0.113.7", family: 4 },
    ]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://localhost:1234/v1/embeddings",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
  });

  it("denies cleartext http to a sub-label of a declared localhost", async () => {
    // `foo.localhost` dot-boundary-matches the allow-list entry, but it is not the loopback literal — the exemption is by name, not by suffix.
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://foo.localhost/x",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
  });

  it("cleartext to an ordinary allow-listed host still needs the private PROOF — a public answer stays denied", async () => {
    // Private-network approval alone is insufficient: every resolved address must prove private before cleartext is allowed.
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://api.example.com/x",
      allowedDomains: LOCAL,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("non-https");
      expect(decision.message).toContain("requires every resolved address to be private");
    }
  });

  it("does not let a declared loopback endpoint open the LAN for other hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });

  it("does not let a declared loopback endpoint rebind an ordinary host onto the machine", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });
});

// Public addresses for every lookup: the SSRF layer approves, the loop decides.
function publicDns(): void {
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
}

// A scripted single-hop transport. Each entry answers one hop; the snapshots are taken AT CALL TIME because the loop mutates one shared Headers object
// across hops — reading it afterwards would show every call the final state.
function scriptedTransport(responses: Response[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
    });
    const next = responses.shift();
    if (!next) throw new Error("scripted transport ran out of responses");
    return next;
  }) as unknown as typeof fetch;
  const transport = directHostFetchTransport(fetchImpl);
  return { transport, calls };
}

const redirect = (status: number, location: string): Response =>
  new Response(null, { status, headers: { location } });

async function firstAllow(rawUrl: string, method = "GET") {
  const decision = await evaluateHostFetch({
    pluginId: "p",
    rawUrl,
    method,
    allowedDomains: ["api.example.com", "sso.example.com"],
  });
  if (!decision.ok) throw new Error(`test setup: first hop denied: ${decision.message}`);
  return decision;
}

function hopOptions(
  first: Awaited<ReturnType<typeof firstAllow>>,
  init: Omit<RequestInit, "method">,
  transport: typeof fetch,
) {
  const denials: Array<{ reason: string; detail: string }> = [];
  const hops: string[] = [];
  return {
    options: {
      pluginId: "p",
      first,
      init,
      transport,
      allowedDomains: ["api.example.com", "sso.example.com"],
      allowPrivateNetworks: false,
      auditHop: (line: string) => hops.push(line),
      auditDeny: (reason: string, detail: string) => denials.push({ reason, detail }),
    },
    denials,
    hops,
  };
}

function registeredCredentialUse() {
  let revision = 0;
  const listeners = new Set<() => void>();
  const registry = new CredentialLeaseRegistry({
    getProviderConfigRevision: () => revision,
    getSecretGeneration: () => 0,
    onLeaseStateChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  const incarnation = {};
  const permission = new AbortController();
  const reservation = registry.reserve("p", incarnation, ["key"], permission.signal, "lease");
  if (!reservation) throw new Error("reservation missing");
  const result = registry.register(reservation, {
    key: "key", vendor: "source", secret: "synthetic-secret", scheme: "bearer",
    audience: (url) => url.origin === "https://api.example.com",
    permissionSignal: permission.signal,
  });
  if (!result || result.exposure !== "lease") throw new Error("lease missing");
  return {
    use: registry.beginUse(result.leaseId, "p", incarnation),
    revoke: () => { revision += 1; for (const listener of listeners) listener(); },
  };
}

it("refuses a credential use when the transport has no handoff contract", async () => {
  publicDns();
  const lease = registeredCredentialUse();
  const transport = vi.fn(async () => new Response(null)) as unknown as typeof fetch;
  const { options } = hopOptions(await firstAllow("https://api.example.com/a"), {}, transport);
  await expect(runHostFetchHops({ ...options, credentialUse: lease.use }))
    .rejects.toThrow("hostFetch internal error: credential transport lacks sendWithHandoff");
  expect(transport).not.toHaveBeenCalled();
});

describe("runHostFetchHops — hop deadline", () => {
  // A server that accepts the connection and then says nothing, ever.
  function silentTransport() {
    const aborted: string[] = [];
    const transport = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const give = () => {
          aborted.push(String(input));
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        // A real transport checks the signal before it opens the socket, so a signal that is ALREADY aborted must reject rather than wait for an event that has been and gone.
        if (init?.signal?.aborted) give();
        else init?.signal?.addEventListener("abort", give);
      })) as unknown as typeof fetch;
    return { transport, aborted };
  }

  it("gives up on a hop that never produces headers", async () => {
    // The plugin lane's one missing bound. Without it this call is held open for as long as the app runs, and the plugin looks merely slow.
    vi.useFakeTimers();
    try {
      publicDns();
      const { transport, aborted } = silentTransport();
      const { options } = hopOptions(await firstAllow("https://api.example.com/a"), {}, transport);
      const pending = runHostFetchHops(options);
      const settled = expect(pending).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.pluginFetchResponseCeilingMs);
      await settled;
      expect(aborted).toEqual(["https://api.example.com/a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the plugin's own signal able to cancel sooner", async () => {
    // The ceiling is an upper bound, not a replacement: a plugin that cancels at its own moment still cancels then.
    publicDns();
    const { transport, aborted } = silentTransport();
    const pluginAbort = new AbortController();
    const { options } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { signal: pluginAbort.signal },
      transport,
    );
    const pending = runHostFetchHops(options);
    const settled = expect(pending).rejects.toThrow(/abort/i);
    pluginAbort.abort();
    await settled;
    expect(aborted).toEqual(["https://api.example.com/a"]);
  });
});

describe("runHostFetchHops — redirect policy", () => {
  it("stops a followed redirect when the registry revokes during the first response", async () => {
    publicDns();
    const lease = registeredCredentialUse();
    const transport = vi.fn(async () => {
      lease.revoke();
      return redirect(302, "https://api.example.com/next");
    }) as unknown as typeof fetch;
    const { options } = hopOptions(await firstAllow("https://api.example.com/a"), { redirect: "follow" }, directHostFetchTransport(transport));
    await expect(runHostFetchHops({ ...options, credentialUse: lease.use }))
      .rejects.toMatchObject({ code: "lease-unavailable" });
    expect(transport).toHaveBeenCalledOnce();
  });
  it("checks the lease audience again on a followed redirect before a second send", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "https://sso.example.com/next")]);
    const { options } = hopOptions(await firstAllow("https://api.example.com/a"), { redirect: "follow" }, transport);
    const lease = registeredCredentialUse();
    const finish = vi.spyOn(lease.use, "finish");
    await expect(runHostFetchHops({ ...options, credentialUse: lease.use })).rejects.toMatchObject({
      code: "lease-audience-denied", detail: { hop: 1 },
    });
    expect(calls).toHaveLength(1);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("rechecks a lease after the asynchronous cookie lookup and before transport", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([new Response("unused")]);
    const { options } = hopOptions(await firstAllow("https://api.example.com/a"), {}, transport);
    const lease = registeredCredentialUse();
    const finish = vi.spyOn(lease.use, "finish");
    await expect(runHostFetchHops({
      ...options, credentialUse: lease.use,
      injectSessionCookie: async () => { lease.revoke(); return "sid=synthetic"; },
    })).rejects.toMatchObject({ code: "lease-unavailable" });
    expect(calls).toHaveLength(0);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("drops a response body when the lease closes before it is drained", async () => {
    publicDns();
    const { transport } = scriptedTransport([new Response("body")]);
    const { options } = hopOptions(await firstAllow("https://api.example.com/a"), {}, transport);
    const lease = registeredCredentialUse();
    const finish = vi.spyOn(lease.use, "finish");
    const onResponseBodyError = vi.fn(() => { throw new Error("audit sink failed"); });
    const response = await runHostFetchHops({ ...options, credentialUse: lease.use, onResponseBodyError });
    lease.revoke();
    await expect(response.text()).rejects.toMatchObject({ code: "lease-unavailable" });
    expect(onResponseBodyError).toHaveBeenCalledWith(expect.objectContaining({ code: "lease-unavailable" }));
    expect(finish).toHaveBeenCalledOnce();
  });
  it("default (no redirect field) refuses a redirect, after one hop only", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "https://api.example.com/next")]);
    const { options, denials } = hopOptions(await firstAllow("https://api.example.com/a"), {}, transport);
    await expect(runHostFetchHops(options)).rejects.toThrow(/redirect refused/);
    expect(calls).toHaveLength(1);
    expect(denials[0]?.reason).toBe("redirect-cap");
  });

  it("an unrecognized policy value fails closed to the refusal", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "https://api.example.com/next")]);
    const { options } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "totally-new-mode" as RequestRedirect },
      transport,
    );
    await expect(runHostFetchHops(options)).rejects.toThrow(/redirect refused/);
    expect(calls).toHaveLength(1);
  });

  it("manual RETURNS the 3xx with its location readable — the SSO-detection case", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([
      redirect(302, "https://sso.example.com/login?from=api"),
    ]);
    const { options } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "manual" },
      transport,
    );
    const response = await runHostFetchHops(options);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://sso.example.com/login?from=api");
    expect(calls).toHaveLength(1);
  });

  it("follow takes the hop when the next URL passes the gate, and audits it", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([
      redirect(302, "https://sso.example.com/token"),
      new Response("landed", { status: 200 }),
    ]);
    const { options, hops } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow" },
      transport,
    );
    const response = await runHostFetchHops(options);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("landed");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.example.com/a",
      "https://sso.example.com/token",
    ]);
    expect(hops).toEqual(["host_fetch https://sso.example.com method=GET effect=read hop=1"]);
  });

  it("follow REFUSES a hop to a host outside the allow-list — the gate runs per hop", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "https://evil.com/steal")]);
    const { options, denials } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow" },
      transport,
    );
    await expect(runHostFetchHops(options)).rejects.toThrow(/not in networkAccess.allowedDomains/);
    expect(calls).toHaveLength(1);
    expect(denials[0]).toEqual({
      reason: "not-allowlisted",
      detail: "redirect hop 1: https://evil.com not in networkAccess.allowedDomains",
    });
  });

  it("follow refuses a downgrade to cleartext on a later hop — scheme is re-gated too", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "http://api.example.com/a")]);
    const { options, denials } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow" },
      transport,
    );
    await expect(runHostFetchHops(options)).rejects.toThrow(/only https is permitted/);
    expect(calls).toHaveLength(1);
    expect(denials[0]?.reason).toBe("non-https");
  });

  it("stops at the hop cap instead of looping", async () => {
    publicDns();
    const bounce = () => redirect(302, "https://api.example.com/again");
    const { transport, calls } = scriptedTransport([
      bounce(), bounce(), bounce(), bounce(), bounce(), bounce(),
    ]);
    const { options, denials } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow" },
      transport,
    );
    await expect(runHostFetchHops(options)).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(MAX_REDIRECT_HOPS + 1);
    expect(denials[0]?.reason).toBe("redirect-cap");
  });

  it("a 3xx without a location is a final response, not a hop", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([new Response(null, { status: 302 })]);
    const { options } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow" },
      transport,
    );
    const response = await runHostFetchHops(options);
    expect(response.status).toBe(302);
    expect(calls).toHaveLength(1);
  });
});

describe("runHostFetchHops — method, body, and credentials across a followed hop", () => {
  it("303 turns POST into a bodyless GET, per fetch", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([
      redirect(303, "https://api.example.com/created"),
      new Response("ok", { status: 200 }),
    ]);
    const first = await firstAllow("https://api.example.com/submit", "POST");
    const { options } = hopOptions(
      first,
      { redirect: "follow", body: "payload", headers: { "content-type": "application/json" } },
      transport,
    );
    await runHostFetchHops(options);
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[1]).toMatchObject({ method: "GET", url: "https://api.example.com/created" });
    expect(calls[1]!.headers["content-type"]).toBeUndefined();
  });

  it("307 keeps the verb and the body", async () => {
    publicDns();
    let secondHopBody: unknown;
    const inner = scriptedTransport([
      redirect(307, "https://api.example.com/moved"),
      new Response("ok", { status: 200 }),
    ]);
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/moved")) secondHopBody = init?.body;
      return (inner.transport as unknown as typeof fetch)(input as string, init);
    }) as typeof fetch;
    const first = await firstAllow("https://api.example.com/submit", "PUT");
    const { options } = hopOptions(first, { redirect: "follow", body: "payload" }, transport);
    await runHostFetchHops(options);
    expect(inner.calls[1]).toMatchObject({ method: "PUT" });
    expect(secondHopBody).toBe("payload");
  });

  it("a cross-origin hop drops authorization and cookie; a same-origin hop keeps them", async () => {
    publicDns();
    const crossOrigin = scriptedTransport([
      redirect(302, "https://sso.example.com/login"),
      new Response("ok", { status: 200 }),
    ]);
    const { options: crossOptions } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      {
        redirect: "follow",
        headers: { authorization: "Bearer t", cookie: "sid=1", "api-key": "secret-a", "x-api-key": "secret-b", "ocp-apim-subscription-key": "secret-c", "x-app": "keep" },
      },
      crossOrigin.transport,
    );
    await runHostFetchHops(crossOptions);
    expect(crossOrigin.calls[0]!.headers.authorization).toBe("Bearer t");
    expect(crossOrigin.calls[1]!.headers.authorization).toBeUndefined();
    expect(crossOrigin.calls[1]!.headers.cookie).toBeUndefined();
    expect(crossOrigin.calls[1]!.headers["api-key"]).toBeUndefined();
    expect(crossOrigin.calls[1]!.headers["x-api-key"]).toBeUndefined();
    expect(crossOrigin.calls[1]!.headers["ocp-apim-subscription-key"]).toBeUndefined();
    expect(crossOrigin.calls[1]!.headers["x-app"]).toBe("keep");

    const sameOrigin = scriptedTransport([
      redirect(302, "https://api.example.com/b"),
      new Response("ok", { status: 200 }),
    ]);
    const { options: sameOptions } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow", headers: { authorization: "Bearer t" } },
      sameOrigin.transport,
    );
    await runHostFetchHops(sameOptions);
    expect(sameOrigin.calls[1]!.headers.authorization).toBe("Bearer t");
  });

  // Range slices must survive cross-origin redirects within WIRE_BYTES_MAX and retain the upstream 206 response.
  it("keeps range on a cross-origin hop and returns the 206 with its content-range", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([
      redirect(302, "https://sso.example.com/asset"),
      new Response(new Uint8Array(4), {
        status: 206,
        headers: { "content-range": "bytes 8388608-8388611/41943163" },
      }),
    ]);
    const { options } = hopOptions(
      await firstAllow("https://api.example.com/releases/download/latest/a.zip"),
      { redirect: "follow", headers: { range: "bytes=8388608-16777215" } },
      transport,
    );
    const response = await runHostFetchHops(options);
    expect(calls[0]!.headers.range).toBe("bytes=8388608-16777215");
    expect(calls[1]).toMatchObject({ url: "https://sso.example.com/asset" });
    expect(calls[1]!.headers.range).toBe("bytes=8388608-16777215");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 8388608-8388611/41943163");
  });

  it("refuses to replay a stream body across a 307 instead of sending it empty", async () => {
    publicDns();
    const { transport } = scriptedTransport([redirect(307, "https://api.example.com/moved")]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    const first = await firstAllow("https://api.example.com/submit", "PUT");
    const { options } = hopOptions(first, { redirect: "follow", body: stream }, transport);
    await expect(runHostFetchHops(options)).rejects.toThrow(/cannot replay a stream body/);
  });
});

describe("evaluateHostFetch — cleartext to a proven-private intranet host", () => {
  const INTRANET = ["portal.internal.example"];

  it("allows http when the host is allow-listed, the manifest opts in, and every address is private", async () => {
    lookupMock.mockResolvedValue([{ address: "10.20.30.40", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://portal.internal.example/api",
      allowedDomains: INTRANET,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(true);
  });

  it("split-horizon with a loopback answer ends DENIED — the SSRF layer owns loopback, not this flag", async () => {
    // Loopback may pass the private-only cleartext proof but still needs its separate literal-host grant at the SSRF layer.
    lookupMock.mockResolvedValue([
      { address: "10.20.30.40", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://portal.internal.example/api",
      allowedDomains: INTRANET,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });

  it("without the allowPrivateNetworks opt-in, http stays denied — the flag is the user's approval", async () => {
    lookupMock.mockResolvedValue([{ address: "10.20.30.40", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://portal.internal.example/api",
      allowedDomains: INTRANET,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("non-https");
      expect(decision.message).toContain("only https is permitted");
    }
  });

  it("a name with ONE public address puts cleartext on the open wire — denied", async () => {
    lookupMock.mockResolvedValue([
      { address: "10.20.30.40", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://portal.internal.example/api",
      allowedDomains: INTRANET,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("non-https");
      expect(decision.message).toContain("requires every resolved address to be private");
    }
  });

  it("link-local is not the intranet: the metadata address flunks the proof", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://portal.internal.example/api",
      allowedDomains: INTRANET,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
  });

  it("an unresolvable name is unproven, and unproven fails closed", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://portal.internal.example/api",
      allowedDomains: INTRANET,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
  });

  it("https to the same intranet host never needed any of this and still just works", async () => {
    lookupMock.mockResolvedValue([{ address: "10.20.30.40", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://portal.internal.example/api",
      allowedDomains: INTRANET,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(true);
  });
});

describe("runHostFetchHops — a followed hop into the intranet exemption", () => {
  it("follows an https→http hop when the target proves private and the manifest opted in", async () => {
    lookupMock.mockResolvedValue([{ address: "10.20.30.40", family: 4 }]);
    const { transport, calls } = scriptedTransport([
      redirect(302, "http://portal.internal.example/landing"),
      new Response("landed", { status: 200 }),
    ]);
    const first = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://portal.internal.example/a",
      allowedDomains: ["portal.internal.example"],
      allowPrivateNetworks: true,
    });
    if (!first.ok) throw new Error("test setup: first hop denied");
    const response = await runHostFetchHops({
      pluginId: "p",
      first,
      init: { redirect: "follow" },
      transport,
      allowedDomains: ["portal.internal.example"],
      allowPrivateNetworks: true,
    });
    expect(response.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "https://portal.internal.example/a",
      "http://portal.internal.example/landing",
    ]);
  });

  it("the same hop WITHOUT the opt-in stays a refused downgrade", async () => {
    // Hop 0 starts from a PUBLIC host: without allowPrivateNetworks a private-resolving origin would not clear the SSRF layer even over https, and this case
    // is about the hop, not the origin.
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const { transport, calls } = scriptedTransport([
      redirect(302, "http://portal.internal.example/landing"),
    ]);
    const first = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/a",
      allowedDomains: ["api.example.com", "portal.internal.example"],
      allowPrivateNetworks: false,
    });
    if (!first.ok) throw new Error("test setup: first hop denied");
    await expect(
      runHostFetchHops({
        pluginId: "p",
        first,
        init: { redirect: "follow" },
        transport,
        allowedDomains: ["api.example.com", "portal.internal.example"],
        allowPrivateNetworks: false,
      }),
    ).rejects.toThrow(/only https is permitted/);
    expect(calls).toHaveLength(1);
  });
});

describe("runHostFetchHops — session-cookie injection", () => {
  it("attaches the vault's cookie for the first hop", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([new Response("ok", { status: 200 })]);
    const first = await firstAllow("https://api.example.com/me");
    const { options } = hopOptions(first, {}, transport);
    await runHostFetchHops({
      ...options,
      injectSessionCookie: async (url) =>
        url.hostname === "api.example.com" ? "SMSESSION=sso" : "",
    });
    expect(calls[0]?.headers.cookie).toBe("SMSESSION=sso");
  });

  it("re-scopes per hop — a followed redirect gets ITS OWN cookie, not the previous hop's", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([
      redirect(302, "https://sso.example.com/bounce"),
      new Response("ok", { status: 200 }),
    ]);
    const first = await firstAllow("https://api.example.com/me");
    const { options } = hopOptions(first, { redirect: "follow" }, transport);
    await runHostFetchHops({
      ...options,
      // Distinct per host: proves the injector is consulted again with the hop's own URL rather than the header surviving from hop 0.
      injectSessionCookie: async (url) =>
        url.hostname === "api.example.com" ? "API=1" : "SSO=2",
    });
    expect(calls[0]?.headers.cookie).toBe("API=1");
    expect(calls[1]?.headers.cookie).toBe("SSO=2");
  });

  it("clears the header on a hop the vault scopes nothing to", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([
      redirect(302, "https://sso.example.com/bounce"),
      new Response("ok", { status: 200 }),
    ]);
    const first = await firstAllow("https://api.example.com/me");
    const { options } = hopOptions(first, { redirect: "follow" }, transport);
    await runHostFetchHops({
      ...options,
      injectSessionCookie: async (url) => (url.hostname === "api.example.com" ? "API=1" : ""),
    });
    expect(calls[0]?.headers.cookie).toBe("API=1");
    expect(calls[1]?.headers.cookie).toBeUndefined();
  });

  it("leaves requests untouched when no injector is supplied", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([new Response("ok", { status: 200 })]);
    const first = await firstAllow("https://api.example.com/me");
    const { options } = hopOptions(first, { headers: { cookie: "PLUGIN=own" } }, transport);
    await runHostFetchHops(options);
    expect(calls[0]?.headers.cookie).toBe("PLUGIN=own");
  });
});

describe("REDIRECT_STATUSES", () => {
  it("names exactly the statuses that point elsewhere", () => {
    expect([...REDIRECT_STATUSES].sort()).toEqual([301, 302, 303, 307, 308]);
    expect(REDIRECT_STATUSES.has(304)).toBe(false);
  });
});

describe("runHostFetchHops exact-hop authorization", () => {
  it("authorizes each actual destination and rewritten verb before sending", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(303, "https://sso.example.com/next"), new Response("done")]);
    const { options } = hopOptions(await firstAllow("https://api.example.com/start", "POST"), { redirect: "follow", body: "payload" }, transport);
    const authorized: unknown[] = [];
    await runHostFetchHops({ ...options, authorizeHop: async (hop) => {
      expect(calls).toHaveLength(hop.index);
      authorized.push({ url: hop.url.toString(), method: hop.method, body: hop.body });
    } });
    expect(authorized).toEqual([{ url: "https://api.example.com/start", method: "POST", body: "payload" }, { url: "https://sso.example.com/next", method: "GET", body: undefined }]);
  });

  it("a denied redirect permission never reaches its transport", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "https://sso.example.com/next"), new Response("unused")]);
    const { options } = hopOptions(await firstAllow("https://api.example.com/start"), { redirect: "follow" }, transport);
    await expect(runHostFetchHops({ ...options, authorizeHop: async (hop) => {
      if (hop.index === 1) throw new Error("Destination permission denied");
    } })).rejects.toThrow("Destination permission denied");
    expect(calls).toHaveLength(1);
  });

  it("manifest destination denial precedes permission for a redirect", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "https://off-list.example/next")]);
    const { options } = hopOptions(await firstAllow("https://api.example.com/start"), { redirect: "follow" }, transport);
    const authorizeHop = vi.fn(async () => {});
    await expect(runHostFetchHops({ ...options, authorizeHop })).rejects.toThrow(/not in networkAccess.allowedDomains/u);
    expect(authorizeHop).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
  });
});
