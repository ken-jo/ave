import { describe, expect, it, vi } from "vitest";
import {
  bypassesProxy,
  createUpstreamProxyRouter,
  describeUpstreamProxy,
  environmentProxyConfigured,
  environmentProxyFor,
  limitConcurrency,
  parseProxyUrl,
  parseStoredProxyCredentials,
  upstreamRoutesFor,
  type UpstreamProxyRouterDeps,
} from "../upstream-proxy.js";
import { parsePacAnswer } from "../../shared/pac-proxy.js";
import { DEFAULT_UPSTREAM_PROXY, type UpstreamProxySettings } from "../../shared/upstream-proxy.js";

function deps(overrides: Omit<Partial<UpstreamProxyRouterDeps>, "settings"> & { settings?: Partial<UpstreamProxySettings>; envVars?: NodeJS.ProcessEnv } = {}): UpstreamProxyRouterDeps {
  const { settings, envVars, ...rest } = overrides;
  return {
    settings: () => ({ ...DEFAULT_UPSTREAM_PROXY, ...settings }),
    manualCredentials: () => null,
    env: () => envVars ?? {},
    ...rest,
  };
}

const https = (host: string, port = 443) => ({ host, port, scheme: "https" as const });
const http = (host: string, port = 80) => ({ host, port, scheme: "http" as const });

describe("parsePacAnswer", () => {
  it("reads every entry in order: PROXY, HTTPS, DIRECT, bracketed IPv6", () => {
    expect(parsePacAnswer("PROXY a.example:8080; HTTPS [2001:db8::1]:443 ;DIRECT")).toEqual([
      { kind: "proxy", scheme: "http", host: "a.example", port: 8080 },
      { kind: "proxy", scheme: "https", host: "2001:db8::1", port: 443 },
      { kind: "direct" },
    ]);
  });

  it("treats an empty answer as DIRECT, ignores empty tokens, and is case-insensitive on the kind", () => {
    expect(parsePacAnswer("")).toEqual([{ kind: "direct" }]);
    expect(parsePacAnswer("  ;  ")).toEqual([{ kind: "direct" }]);
    expect(parsePacAnswer("proxy p:1;;direct")).toEqual([{ kind: "proxy", scheme: "http", host: "p", port: 1 }, { kind: "direct" }]);
  });

  it("keeps SOCKS, unknown kinds and malformed entries as skipped, with the reason", () => {
    expect(parsePacAnswer("SOCKS s:1080; SOCKS5 s:1080; SOCKS4 s:1; QUIC q:443; PROXY nohost; PROXY h:0; PROXY h:70000; PROXY a b:1; DIRECT x; PROXY bad host:1")).toEqual([
      { kind: "skipped", entry: "SOCKS s:1080", reason: "socks" },
      { kind: "skipped", entry: "SOCKS5 s:1080", reason: "socks" },
      { kind: "skipped", entry: "SOCKS4 s:1", reason: "socks" },
      { kind: "skipped", entry: "QUIC q:443", reason: "unsupported" },
      { kind: "skipped", entry: "PROXY nohost", reason: "malformed" },
      { kind: "skipped", entry: "PROXY h:0", reason: "malformed" },
      { kind: "skipped", entry: "PROXY h:70000", reason: "malformed" },
      { kind: "skipped", entry: "PROXY a b:1", reason: "malformed" },
      { kind: "skipped", entry: "DIRECT x", reason: "malformed" },
      { kind: "skipped", entry: "PROXY bad host:1", reason: "malformed" },
    ]);
  });
});

describe("parseProxyUrl", () => {
  it.each<[string, "http" | "https", string, number]>([
    ["http://proxy.test:80", "http", "proxy.test", 80],
    ["http://proxy.test:443", "http", "proxy.test", 443],
    ["http://proxy.test:1080", "http", "proxy.test", 1080],
    ["http://proxy.test", "http", "proxy.test", 1080],
    ["https://proxy.test:80", "https", "proxy.test", 80],
    ["https://proxy.test:443", "https", "proxy.test", 443],
    ["https://proxy.test:1080", "https", "proxy.test", 1080],
    ["https://proxy.test", "https", "proxy.test", 443],
    ["http://[2001:db8::1]:80", "http", "2001:db8::1", 80],
    ["http://[2001:db8::1]:443", "http", "2001:db8::1", 443],
    ["http://[2001:db8::1]:1080", "http", "2001:db8::1", 1080],
    ["http://[2001:db8::1]", "http", "2001:db8::1", 1080],
    ["https://[2001:db8::1]:443", "https", "2001:db8::1", 443],
    ["https://[2001:db8::1]:80", "https", "2001:db8::1", 80],
    ["https://[2001:db8::1]:1080", "https", "2001:db8::1", 1080],
    ["https://[2001:db8::1]", "https", "2001:db8::1", 443],
    ["proxy.test:80", "http", "proxy.test", 80],
    ["proxy.test:443", "http", "proxy.test", 443],
    ["proxy.test:1080", "http", "proxy.test", 1080],
    ["proxy.test", "http", "proxy.test", 1080],
    ["[2001:db8::1]:80", "http", "2001:db8::1", 80],
    ["[2001:db8::1]:443", "http", "2001:db8::1", 443],
    ["[2001:db8::1]:1080", "http", "2001:db8::1", 1080],
    ["[2001:db8::1]", "http", "2001:db8::1", 1080],
  ])("preserves the effective service for %s", (raw, scheme, host, port) => {
    expect(parseProxyUrl(raw)).toEqual({ ok: true, scheme, host, port });
  });

  it("reads curl's forms: scheme-less is HTTP, default ports 1080/443, credentials percent-decoded", () => {
    expect(parseProxyUrl("proxy.example:3128")).toEqual({ ok: true, scheme: "http", host: "proxy.example", port: 3128 });
    expect(parseProxyUrl("http://proxy.example")).toEqual({ ok: true, scheme: "http", host: "proxy.example", port: 1080 });
    expect(parseProxyUrl("https://Proxy.Example./")).toEqual({ ok: true, scheme: "https", host: "proxy.example", port: 443 });
    expect(parseProxyUrl("http://us%40er:p%3Ass@[::1]:8080")).toEqual({
      ok: true, scheme: "http", host: "::1", port: 8080, auth: { username: "us@er", password: "p:ss" },
    });
  });

  it("refuses SOCKS, other schemes, paths and garbage", () => {
    expect(parseProxyUrl("socks5://s:1080")).toEqual({ ok: false, reason: "socks" });
    expect(parseProxyUrl("socks5h://s:1080")).toEqual({ ok: false, reason: "socks" });
    expect(parseProxyUrl("ftp://p:21")).toEqual({ ok: false, reason: "unsupported-scheme" });
    expect(parseProxyUrl("http://p:8080/path")).toEqual({ ok: false, reason: "malformed" });
    expect(parseProxyUrl("http://p:8080/?q")).toEqual({ ok: false, reason: "malformed" });
    expect(parseProxyUrl("")).toEqual({ ok: false, reason: "malformed" });
    expect(parseProxyUrl("http://exa mple:1")).toEqual({ ok: false, reason: "malformed" });
    expect(parseProxyUrl("http://p:99999")).toEqual({ ok: false, reason: "malformed" });
    expect(parseProxyUrl("http:///proxy.test:80")).toEqual({ ok: false, reason: "malformed" });
    expect(parseProxyUrl("http://proxy.test:")).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("environment proxy (curl order, both cases)", () => {
  it("picks <scheme>_proxy over ALL_PROXY, lower case over upper case, and ignores empty values", () => {
    const env = { HTTPS_PROXY: "http://upper:1", https_proxy: "http://lower:1", ALL_PROXY: "http://all:1", HTTP_PROXY: "  " };
    expect(environmentProxyFor(env, "https")).toEqual({ name: "https_proxy", value: "http://lower:1" });
    expect(environmentProxyFor(env, "http")).toEqual({ name: "ALL_PROXY", value: "http://all:1" });
    expect(environmentProxyFor({ HTTP_PROXY: "http://h:1" }, "http")).toEqual({ name: "HTTP_PROXY", value: "http://h:1" });
    expect(environmentProxyFor({ HTTP_PROXY: "http://h:1" }, "https")).toBeUndefined();
    expect(environmentProxyConfigured({ NO_PROXY: "*" })).toBe(false);
    expect(environmentProxyConfigured({ all_proxy: "http://a:1" })).toBe(true);
    expect(environmentProxyConfigured({ HTTPS_PROXY: "" })).toBe(false);
  });

  it.each<[string, string, boolean]>([
    ["example.com", "example.com", true],
    ["example.com", "api.example.com", true],
    ["example.com", "notexample.com", false],
    [".example.com", "example.com", true],
    ["*.example.com", "api.example.com", false],
    ["EXAMPLE.com.", "API.example.com", true],
    ["example.com", "example.com.", true],
    ["..example.com", "api.example.com", false],
    ["*", "anything.test", true],
    [" *", "anything.test", false],
    ["* ", "anything.test", false],
    ["other.example, *", "anything.test", false],
    ["*, example.com", "api.example.com", true],
    ["*, example.com", "anything.test", false],
    ["a.test b.test,, c.test", "b.test", false],
    ["a.test b.test,, c.test", "c.test", false],
    ["a.test, \tb.test,, c.test", "b.test", true],
    ["a.test\nb.test, c.test", "c.test", true],
    ["a.test\nb.test", "b.test", false],
    ["10.0.0.0/8", "10.1.2.3", true],
    ["10.0.0.0/8", "11.1.2.3", false],
    ["10.0.0.0/99, bad host", "10.1.2.3", false],
    ["10.0.0.0/0", "10.1.2.3", false],
    ["10.0.0.0/0", "10.0.0.0", true],
    ["0.0.0.0/0", "192.0.2.7", true],
    ["192.0.2.7/32", "192.0.2.7", true],
    ["192.0.2.7/", "192.0.2.7", false],
    ["192.0.2.7/-1", "192.0.2.7", false],
    ["192.0.2.7/+32", "192.0.2.7", false],
    ["192.0.2.7/032", "192.0.2.7", true],
    ["2001:db8::/32", "2001:db8::5", true],
    ["2001:db8::/32", "2001:db9::5", false],
    ["2001:db8::/0", "2001:db9::5", true],
    ["::/0", "2001:db8::5", true],
    ["2001:db8::1/129", "2001:db8::1", false],
    ["fe80::/10", "fe80::1%lo0", false],
    ["fe80::1%lo0", "fe80::1", false],
    ["2001:db8::1", "2001:0db8:0:0:0:0:0:1", true],
    ["[2001:db8::1]", "2001:db8::1", false],
    ["[2001:db8::]/32", "2001:db8::1", false],
    ["192.0.2.7", "192.0.2.7.example", false],
    ["example.com", "192.0.2.7", false],
    ["192.0.2.0/24", "::ffff:192.0.2.7", false],
    ["::ffff:192.0.2.0/120", "::ffff:192.0.2.7", true],
    ["::ffff:192.0.2.0/120", "192.0.2.7", false],
    ["intranet:8080", "intranet", false],
    ["example.com:8443", "api.example.com", false],
    ["192.0.2.7:80", "192.0.2.7", false],
    ["[2001:db8::1]:8080", "2001:db8::1", false],
    ["2001:db8::80", "2001:db8::80", true],
    ["", "127.0.0.1", false],
    ["", "localhost", false],
    ["", "example.com", false],
    ["*", "", false],
  ])("matches bypass list %j for %j as %s", (list, host, expected) => {
    expect(bypassesProxy(list, host)).toBe(expected);
  });

});

describe("upstreamRoutesFor", () => {
  it.each([80, 443, 1080])("sends environment credentials only to the explicit port %i", async (port) => {
    const result = await upstreamRoutesFor(deps({ envVars: { HTTPS_PROXY: `http://u:p@proxy.test:${port}` } }), https("example.com"));
    expect(result.routes).toEqual([{ kind: "http", host: "proxy.test", port, auth: { username: "u", password: "p" } }]);
  });

  it.each(["localhost", "127.0.0.1", "::1"])("keeps local destination %s direct independently of bypass matching", async (host) => {
    const environment = deps({ envVars: { HTTPS_PROXY: "http://proxy.test:80" } });
    const manual = deps({ settings: { mode: "manual", manualUrl: "http://proxy.test:80", bypass: "" } });
    expect(await upstreamRoutesFor(environment, https(host))).toMatchObject({ source: "environment-bypass", routes: [{ kind: "direct" }] });
    expect(await upstreamRoutesFor(manual, https(host))).toMatchObject({ source: "manual-bypass", routes: [{ kind: "direct" }] });
  });

  it("off: direct, whatever the environment says", async () => {
    const result = await upstreamRoutesFor(deps({ settings: { mode: "off" }, envVars: { HTTPS_PROXY: "http://p:1" } }), https("example.com"));
    expect(result.routes).toEqual([{ kind: "direct" }]);
    expect(result.source).toBe("off");
  });

  it("system with a proxy environment: the environment decides, with credentials, NO_PROXY and the trusted opt-in", async () => {
    const env = { https_proxy: "http://u:p%40ss@proxy.test:3128", no_proxy: ".internal.test", HTTP_PROXY: "" };
    const resolveProxy = vi.fn(async () => "DIRECT");
    const d = deps({ envVars: env, resolveProxy, settings: { resolvesNames: true } });
    expect(await upstreamRoutesFor(d, https("example.com"))).toMatchObject({
      routes: [{ kind: "http", host: "proxy.test", port: 3128, auth: { username: "u", password: "p@ss" }, resolvesNames: true }],
      views: [{ kind: "http", endpoint: "proxy.test:3128", credentials: true }],
      source: "environment",
      envVar: "https_proxy",
    });
    expect(await upstreamRoutesFor(d, https("wiki.internal.test"))).toMatchObject({ routes: [{ kind: "direct" }], source: "environment-bypass" });
    // No variable for plain HTTP: direct, as curl does — never the OS settings.
    expect(await upstreamRoutesFor(d, http("example.com"))).toMatchObject({ routes: [{ kind: "direct" }], source: "environment" });
    expect(resolveProxy).not.toHaveBeenCalled();
  });

  it.each([" ", "\t", " * "])("preserves nonempty lowercase bypass value %j over uppercase", async (noProxy) => {
    const d = deps({ envVars: { HTTPS_PROXY: "http://proxy.test:80", no_proxy: noProxy, NO_PROXY: "*" } });
    expect(await upstreamRoutesFor(d, https("example.com"))).toMatchObject({ source: "environment", routes: [{ kind: "http", host: "proxy.test", port: 80 }] });
  });

  it("uses the uppercase bypass value when the lowercase value is empty", async () => {
    const d = deps({ envVars: { HTTPS_PROXY: "http://proxy.test:80", no_proxy: "", NO_PROXY: "*" } });
    expect(await upstreamRoutesFor(d, https("example.com"))).toMatchObject({ source: "environment-bypass", routes: [{ kind: "direct" }] });
  });

  it("never trusts a proxy from the OS settings or PAC to resolve names, even with the opt-in on", async () => {
    const d = deps({ resolveProxy: async () => "PROXY 127.0.0.1:3128", settings: { resolvesNames: true } });
    expect((await upstreamRoutesFor(d, https("example.com"))).routes).toEqual([{ kind: "http", host: "127.0.0.1", port: 3128 }]);
    // The opt-in still covers a proxy the person named (manual or environment).
    const manual = deps({ settings: { mode: "manual", manualUrl: "http://127.0.0.1:3128", resolvesNames: true } });
    expect((await upstreamRoutesFor(manual, https("example.com"))).routes).toEqual([{ kind: "http", host: "127.0.0.1", port: 3128, resolvesNames: true }]);
  });

  it("does not interpret a port suffix as a bypass extension", async () => {
    const d = deps({ envVars: { HTTPS_PROXY: "http://proxy.test:3128", NO_PROXY: "git.internal.test:8443" } });
    expect(await upstreamRoutesFor(d, https("git.internal.test", 8443))).toMatchObject({ routes: [{ kind: "http", host: "proxy.test", port: 3128 }], source: "environment" });
    expect(await upstreamRoutesFor(d, https("git.internal.test", 443))).toMatchObject({ routes: [{ kind: "http", host: "proxy.test", port: 3128 }], source: "environment" });
  });

  it("system with a SOCKS environment proxy: refused with the reason, not direct", async () => {
    const result = await upstreamRoutesFor(deps({ envVars: { ALL_PROXY: "socks5h://user:pw@s:1080" } }), https("example.com"));
    expect(result.routes).toEqual([]);
    expect(result.reason).toBe("the proxy in ALL_PROXY is a SOCKS proxy, which the sandbox cannot use as an upstream");
    expect(result.skipped).toEqual(["ALL_PROXY (a SOCKS proxy, which the sandbox cannot use as an upstream)"]);
    expect(JSON.stringify(result)).not.toContain("pw");
  });

  it("system without a proxy environment: Chromium's answer per destination, asked with the canonical URL only", async () => {
    const resolveProxy = vi.fn(async (url: string) => {
      if (url === "https://example.com/") return "PROXY p1.test:8080; DIRECT";
      if (url === "https://[2001:db8::5]:8443/") return "HTTPS p2.test:443";
      if (url === "http://intranet.test/") return "DIRECT";
      return "SOCKS5 s:1080; PROXY bad";
    });
    const d = deps({ resolveProxy });
    expect((await upstreamRoutesFor(d, https("example.com"))).routes).toEqual([{ kind: "http", host: "p1.test", port: 8080 }, { kind: "direct" }]);
    expect((await upstreamRoutesFor(d, https("2001:db8::5", 8443))).routes).toEqual([{ kind: "https", host: "p2.test", port: 443 }]);
    expect((await upstreamRoutesFor(d, http("intranet.test"))).routes).toEqual([{ kind: "direct" }]);
    const nothing = await upstreamRoutesFor(d, https("socks.test"));
    expect(nothing.routes).toEqual([]);
    expect(nothing.reason).toBe("the system proxy settings offer no route the sandbox can use (SOCKS proxies are not supported)");
    expect(nothing.skipped).toEqual([
      "SOCKS5 s:1080 (a SOCKS proxy, which the sandbox cannot use as an upstream)",
      "PROXY bad (not a usable entry)",
    ]);
    expect(resolveProxy.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/", "https://[2001:db8::5]:8443/", "http://intranet.test/", "https://socks.test/",
    ]);
  });

  it("refuses a destination that is not canonical before asking anybody", async () => {
    const resolveProxy = vi.fn(async () => "DIRECT");
    for (const host of ["Example.com", "example.com.", "a b", "x/y", "127.1"]) {
      const result = await upstreamRoutesFor(deps({ resolveProxy }), https(host));
      expect(result.routes, host).toEqual([]);
      expect(result.reason, host).toBe("the destination is not a canonical host and port");
    }
    expect(resolveProxy).not.toHaveBeenCalled();
  });

  it("system without a resolver (headless host): direct", async () => {
    expect(await upstreamRoutesFor(deps(), https("example.com"))).toMatchObject({ routes: [{ kind: "direct" }], source: "system-unavailable" });
  });

  it("manual: sends stored credentials only to the proxy they were saved for", async () => {
    for (const origin of ["https://other.test:8443", "https://proxy.test:443", "http://proxy.test:8443"]) {
      const manual = deps({
        settings: { mode: "manual", manualUrl: "https://proxy.test:8443" },
        manualCredentials: () => ({ username: "me", password: "pw", origin }),
      });
      const result = await upstreamRoutesFor(manual, https("example.com"));
      expect(result.routes, origin).toEqual([{ kind: "https", host: "proxy.test", port: 8443 }]);
      expect(result.views, origin).toEqual([{ kind: "https", endpoint: "proxy.test:8443" }]);
    }
  });

  it("a resolver that throws refuses with a reason", async () => {
    const result = await upstreamRoutesFor(deps({ resolveProxy: async () => { throw new Error("boom"); } }), https("example.com"));
    expect(result).toMatchObject({ routes: [], reason: "the system proxy configuration could not be read", transient: true });
  });

  it("manual: the configured proxy with stored credentials, the bypass list direct, an unusable URL refused", async () => {
    const manual = deps({
      settings: { mode: "manual", manualUrl: "https://proxy.test:8443", bypass: "10.0.0.0/8, .lan" },
      manualCredentials: () => ({ username: "me", password: "pw", origin: "https://proxy.test:8443" }),
      envVars: { HTTPS_PROXY: "http://env:1" },
    });
    expect(await upstreamRoutesFor(manual, https("example.com"))).toMatchObject({
      routes: [{ kind: "https", host: "proxy.test", port: 8443, auth: { username: "me", password: "pw" } }],
      source: "manual",
    });
    expect(await upstreamRoutesFor(manual, https("10.2.3.4"))).toMatchObject({ routes: [{ kind: "direct" }], source: "manual-bypass" });
    expect(await upstreamRoutesFor(manual, https("nas.lan"))).toMatchObject({ routes: [{ kind: "direct" }], source: "manual-bypass" });
    expect(await upstreamRoutesFor(deps({ settings: { mode: "manual", manualUrl: "socks5://s:1" } }), https("example.com")))
      .toMatchObject({ routes: [], reason: "the upstream proxy in Settings is a SOCKS proxy, which the sandbox cannot use as an upstream" });
    expect(await upstreamRoutesFor(deps({ settings: { mode: "manual", manualUrl: "" } }), https("example.com")))
      .toMatchObject({ routes: [], reason: "the upstream proxy URL in Settings is not usable" });
  });
});

describe("createUpstreamProxyRouter", () => {
  it("retries a pending route lookup after configuration changes", async () => {
    let release!: (answer: string) => void;
    const resolveProxy = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    let settings: UpstreamProxySettings = { ...DEFAULT_UPSTREAM_PROXY };
    const { router, invalidate } = createUpstreamProxyRouter({ ...deps({ resolveProxy }), settings: () => settings });
    const pending = router(https("example.com"));
    settings = { ...settings, mode: "manual", manualUrl: "http://new.test:80" };
    invalidate();
    release("PROXY old.test:3128");
    expect(await pending).toEqual({ routes: [{ kind: "http", host: "new.test", port: 80 }] });
    expect(await router(https("example.com"))).toEqual({ routes: [{ kind: "http", host: "new.test", port: 80 }] });
    expect(resolveProxy).toHaveBeenCalledTimes(1);
  });

  it("exposes the active generation and the policy's resolved decision class", () => {
    const { router, invalidate } = createUpstreamProxyRouter(deps());
    expect(router.generation?.()).toBe(0);
    invalidate();
    expect(router.generation?.()).toBe(1);
    expect(router.decisionClass?.("example.com", ["93.184.216.34"], "pinned")).toBe("public");
    expect(router.decisionClass?.("example.com", [], "upstream")).toBe("unverified");
    expect(router.decisionClass?.("example.com", ["10.0.0.1"], "pinned")).toBe("local");
    expect(router.decisionClass?.("localhost", [], "upstream")).toBe("local");
    expect(router.decisionClass?.("0.0.0.0", [], "upstream")).toBe("reserved");
  });

  it("caches a destination's answer for the TTL, per scheme/host/port, and drops it on invalidate()", async () => {
    let now = 0;
    let answer = "PROXY a.test:1";
    const resolveProxy = vi.fn(async () => answer);
    const { router, invalidate } = createUpstreamProxyRouter(deps({ resolveProxy, now: () => now, ttlMs: 45_000 }));
    expect(await router(https("example.com"))).toEqual({ routes: [{ kind: "http", host: "a.test", port: 1 }] });
    answer = "PROXY b.test:2";
    now = 44_999;
    expect(await router(https("example.com"))).toEqual({ routes: [{ kind: "http", host: "a.test", port: 1 }] });
    expect(await router(https("example.com", 8443))).toEqual({ routes: [{ kind: "http", host: "b.test", port: 2 }] });
    expect(await router(http("example.com"))).toEqual({ routes: [{ kind: "http", host: "b.test", port: 2 }] });
    now = 45_000;
    expect(await router(https("example.com"))).toEqual({ routes: [{ kind: "http", host: "b.test", port: 2 }] });
    answer = "DIRECT";
    invalidate();
    expect(await router(https("example.com"))).toEqual({ routes: [{ kind: "direct" }] });
    expect(resolveProxy).toHaveBeenCalledTimes(5);
  });

  it("reads the settings live: a mode change applies on the next lookup after invalidate()", async () => {
    let settings: UpstreamProxySettings = { ...DEFAULT_UPSTREAM_PROXY, mode: "off" };
    const { router, invalidate } = createUpstreamProxyRouter({ ...deps(), settings: () => settings });
    expect(await router(https("example.com"))).toEqual({ routes: [{ kind: "direct" }] });
    settings = { ...settings, mode: "manual", manualUrl: "http://m.test:3128" };
    invalidate();
    expect(await router(https("example.com"))).toEqual({ routes: [{ kind: "http", host: "m.test", port: 3128 }] });
  });

  it("does not cache a failed lookup, and coalesces concurrent ones", async () => {
    let fail = true;
    const resolveProxy = vi.fn(async () => {
      if (fail) throw new Error("not ready");
      return "DIRECT";
    });
    const { router } = createUpstreamProxyRouter(deps({ resolveProxy }));
    expect(await router(https("example.com"))).toEqual({ routes: [], reason: "the system proxy configuration could not be read" });
    fail = false;
    const [a, b] = await Promise.all([router(https("example.com")), router(https("example.com"))]);
    expect(a).toEqual({ routes: [{ kind: "direct" }] });
    expect(b).toEqual(a);
    expect(resolveProxy).toHaveBeenCalledTimes(2);
  });

  it("bounds the cache", async () => {
    const resolveProxy = vi.fn(async () => "DIRECT");
    const { router } = createUpstreamProxyRouter(deps({ resolveProxy, maxEntries: 2 }));
    await router(https("a.test"));
    await router(https("b.test"));
    await router(https("c.test"));
    await router(https("a.test"));
    expect(resolveProxy).toHaveBeenCalledTimes(4);
  });

  it("reports passed-over entries once per lookup", async () => {
    const onSkipped = vi.fn();
    const { router } = createUpstreamProxyRouter(deps({ resolveProxy: async () => "SOCKS5 s:1; DIRECT", onSkipped }));
    await router(https("example.com"));
    await router(https("example.com"));
    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalledWith({
      host: "example.com", port: 443, source: "system",
      skipped: ["SOCKS5 s:1 (a SOCKS proxy, which the sandbox cannot use as an upstream)"],
    });
  });
});

describe("limitConcurrency (resolveProxy calls)", () => {
  it("runs at most `max` at once, queues the rest in order, and refuses beyond the queue", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const limited = limitConcurrency(async (n: number) => {
      started.push(n);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return n * 10;
    }, 2, 2);
    const results = [1, 2, 3, 4].map((n) => limited(n));
    await expect(limited(5)).rejects.toThrow("too many proxy lookups waiting");
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    while (releases.length > 0 || started.length < 4) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await Promise.all(results)).toEqual([10, 20, 30, 40]);
    expect(started).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("caps the router's concurrent resolveProxy calls across distinct destinations", async () => {
    let active = 0;
    let peak = 0;
    const router = createUpstreamProxyRouter({
      settings: () => ({ ...DEFAULT_UPSTREAM_PROXY }),
      manualCredentials: () => null,
      env: () => ({}),
      maxConcurrentResolves: 3,
      resolveProxy: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return "DIRECT";
      },
    });
    await Promise.all(Array.from({ length: 12 }, (_, i) => router.router({ host: `h${i}.example.test`, port: 443, scheme: "https" })));
    expect(peak).toBe(3);
  });
});

describe("describeUpstreamProxy (Settings diagnostic)", () => {
  it("shows the route with credentials flagged, never their values", async () => {
    const diagnostic = await describeUpstreamProxy(
      deps({ envVars: { HTTPS_PROXY: "http://alice:hunter2@proxy.test:3128" } }),
      "https://example.com/",
    );
    expect(diagnostic).toEqual({
      url: "https://example.com/",
      source: "environment",
      envVar: "HTTPS_PROXY",
      routes: [{ kind: "http", endpoint: "proxy.test:3128", credentials: true }],
      skipped: [],
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/alice|hunter2/u);
  });

  it("keeps credentials out of a refusal from an environment proxy it cannot use", async () => {
    for (const value of ["socks5h://alice:hunter2@s.test:1080", "ftp://alice:hunter2@f.test:21", "http://alice:hunter2@bad host:1"]) {
      const diagnostic = await describeUpstreamProxy(deps({ envVars: { https_proxy: value } }), "https://example.com/");
      expect(diagnostic.routes).toEqual([]);
      expect(diagnostic.refusal).toMatch(/^the proxy in https_proxy is /u);
      expect(JSON.stringify(diagnostic)).not.toMatch(/alice|hunter2/u);
    }
  });

  it("names a refusal", async () => {
    const diagnostic = await describeUpstreamProxy(deps({ resolveProxy: async () => "SOCKS s:1" }), "https://example.com/");
    expect(diagnostic.refusal).toBe("the system proxy settings offer no route the sandbox can use (SOCKS proxies are not supported)");
    expect(diagnostic.routes).toEqual([]);
  });
});

describe("parseStoredProxyCredentials", () => {
  it("reads the stored JSON and treats anything else as absent", () => {
    expect(parseStoredProxyCredentials(JSON.stringify({ username: "u", password: "p", origin: "http://p.test:1" }))).toEqual({ username: "u", password: "p", origin: "http://p.test:1" });
    // Without the origin it was saved for, an entry is never sent anywhere.
    expect(parseStoredProxyCredentials(JSON.stringify({ username: "u", password: "p" }))).toBeNull();
    expect(parseStoredProxyCredentials(null)).toBeNull();
    expect(parseStoredProxyCredentials("not json")).toBeNull();
    expect(parseStoredProxyCredentials(JSON.stringify({ username: "u" }))).toBeNull();
  });
});
