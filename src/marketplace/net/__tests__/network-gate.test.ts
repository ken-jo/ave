import { describe, expect, it } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PolicyLoad } from "../../sources/policy.js";
import { NetworkGate, downloadUrlForPolicy } from "../network-gate.js";
import { normalizeSourceUrl, parseSourcePattern } from "../source-url.js";

const OFFICIAL = { official: true };
const OTHER = { official: false };

function policy(overrides: Partial<MarketplacePolicy>): PolicyLoad {
  return { ok: true, policy: { ...EMPTY_MARKETPLACE_POLICY, ...overrides } };
}

function gate(load: PolicyLoad = { ok: true, policy: EMPTY_MARKETPLACE_POLICY }, allowLoopback = false): NetworkGate {
  return new NetworkGate({ policy: load, allowLoopback });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketplaceError) return error.code;
    throw error;
  }
  return "passed";
}

// IP literals keep these tests off DNS: the guard only resolves names.
const remote = (text: string) => normalizeSourceUrl(text);

describe("NetworkGate.checkRemote", () => {
  it("passes a public https remote and reports plain http as not allowed", async () => {
    expect(await gate().checkRemote(remote("https://1.1.1.1/acme/market"), OTHER)).toEqual({ allowHttp: false });
    expect(await code(gate().checkRemote(remote("http://1.1.1.1/acme/market"), OTHER))).toBe("SOURCE_URL_REJECTED");
  });

  it("applies block before allow and treats a present allow list as exhaustive", async () => {
    const load = policy({
      allow: [parseSourcePattern("host:1.1.1.1")],
      block: [parseSourcePattern("https://1.1.1.1/acme/secret")],
    });
    expect(await code(gate(load).checkRemote(remote("https://1.1.1.1/acme/market"), OTHER))).toBe("passed");
    expect(await code(gate(load).checkRemote(remote("https://1.1.1.1/acme/secret"), OTHER))).toBe("SOURCE_POLICY_BLOCKED");
    expect(await code(gate(load).checkRemote(remote("https://1.0.0.1/acme/market"), OTHER))).toBe("SOURCE_POLICY_BLOCKED");
    // The allow list binds the official source too (§7.4: every target passes one gate).
    expect(await code(gate(load).checkRemote(remote("https://1.0.0.1/acme/market"), OFFICIAL))).toBe("SOURCE_POLICY_BLOCKED");
  });

  it("blocks every source but the official one when the policy is unreadable", async () => {
    const broken: PolicyLoad = { ok: false, error: "marketplaces.blok: is not a known key" };
    expect(await code(gate(broken).checkRemote(remote("https://1.1.1.1/acme/market"), OTHER))).toBe("SOURCE_POLICY_BLOCKED");
    expect(await code(gate(broken).checkRemote(remote("https://1.1.1.1/acme/market"), OFFICIAL))).toBe("passed");
  });

  it("refuses private, loopback and metadata targets unless listed or allowed", async () => {
    expect(await code(gate().checkRemote(remote("https://10.0.0.5/ave/market"), OTHER))).toBe("SOURCE_URL_REJECTED");
    expect(await code(gate().checkRemote(remote("https://100.64.0.9/ave/market"), OTHER))).toBe("SOURCE_URL_REJECTED");
    expect(await code(gate().checkRemote(remote("https://127.0.0.1/ave/market"), OTHER))).toBe("SOURCE_URL_REJECTED");
    expect(await code(gate().checkRemote(remote("ssh://git@[fd00::1]/ave/market"), OTHER))).toBe("SOURCE_URL_REJECTED");

    const listed = policy({ allow: [parseSourcePattern("host:10.0.0.5"), parseSourcePattern("host:100.64.0.9"), parseSourcePattern("host:169.254.169.254")] });
    expect(await code(gate(listed).checkRemote(remote("https://10.0.0.5/ave/market"), OTHER))).toBe("passed");
    expect(await code(gate(listed).checkRemote(remote("https://100.64.0.9/ave/market"), OTHER))).toBe("passed");
    // Listing never opens link-local or metadata addresses.
    expect(await code(gate(listed).checkRemote(remote("https://169.254.169.254/ave/market"), OTHER))).toBe("SOURCE_URL_REJECTED");

    expect(await code(gate(undefined, true).checkRemote(remote("https://127.0.0.1/ave/market"), OTHER))).toBe("passed");
    expect(await code(gate(undefined, true).checkRemote(remote("https://10.0.0.5/ave/market"), OTHER))).toBe("SOURCE_URL_REJECTED");
  });

  it("lists a managed source's host for the private-network guard", async () => {
    const load = policy({ additional: [{ id: "corp", url: remote("https://192.168.1.20/ave/market"), auth: { kind: "none" } }] });
    expect(await code(gate(load).checkRemote(remote("https://192.168.1.20/ave/market"), OTHER))).toBe("passed");
  });

  it("allows plain http for allowHttpHosts, and for loopback only in a dev build", async () => {
    const load = policy({ allowHttpHosts: new Set(["10.0.0.5"]), allow: [parseSourcePattern("host:10.0.0.5")] });
    expect(await gate(load).checkRemote(remote("http://10.0.0.5/ave/market"), OTHER)).toEqual({ allowHttp: true });
    expect(await gate(undefined, true).checkRemote(remote("http://127.0.0.1:8080/ave/market"), OTHER)).toEqual({ allowHttp: true });
    expect(await code(gate().checkRemote(remote("http://127.0.0.1:8080/ave/market"), OTHER))).toBe("SOURCE_URL_REJECTED");
  });
});

interface RecordedCall {
  url: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
}

/** A transport that answers from a route table and records what each hop carried. */
function fakeTransport(routes: Record<string, () => Response>): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    const route = routes[url];
    if (!route) return new Response("missing", { status: 404 });
    return route();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const ok = () => new Response("bytes", { status: 200 });

describe("NetworkGate.fetch", () => {
  it("carries auth within one origin and drops it on a cross-origin redirect", async () => {
    const { fetchImpl, calls } = fakeTransport({
      "https://1.1.1.1/asset": redirect("/asset-2"),
      "https://1.1.1.1/asset-2": redirect("https://1.0.0.1/blob?sig=abc"),
      "https://1.0.0.1/blob?sig=abc": ok,
    });
    const response = await gate().fetch("https://1.1.1.1/asset", {
      fetchImpl,
      official: false,
      headers: { authorization: "Bearer secret", cookie: "a=b", accept: "application/octet-stream" },
    });
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1/asset", "https://1.1.1.1/asset-2", "https://1.0.0.1/blob?sig=abc"]);
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer secret");
    expect(calls[2]!.headers.get("authorization")).toBeNull();
    expect(calls[2]!.headers.get("cookie")).toBeNull();
    expect(calls[2]!.headers.get("accept")).toBe("application/octet-stream");
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
  });

  it("refuses a redirect to a blocked host before contacting it", async () => {
    const { fetchImpl, calls } = fakeTransport({
      "https://1.1.1.1/asset": redirect("https://1.0.0.1/blob"),
      "https://1.0.0.1/blob": ok,
    });
    const load = policy({ block: [parseSourcePattern("host:1.0.0.1")] });
    expect(await code(gate(load).fetch("https://1.1.1.1/asset", { fetchImpl, official: false }))).toBe("SOURCE_POLICY_BLOCKED");
    expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1/asset"]);
  });

  it("refuses a redirect to a private address or to plain http", async () => {
    const toPrivate = fakeTransport({ "https://1.1.1.1/asset": redirect("https://10.0.0.1/blob") });
    expect(await code(gate().fetch("https://1.1.1.1/asset", { fetchImpl: toPrivate.fetchImpl, official: false }))).toBe("SOURCE_URL_REJECTED");
    expect(toPrivate.calls).toHaveLength(1);

    const toHttp = fakeTransport({ "https://1.1.1.1/asset": redirect("http://1.1.1.1/blob") });
    expect(await code(gate().fetch("https://1.1.1.1/asset", { fetchImpl: toHttp.fetchImpl, official: false }))).toBe("SOURCE_URL_REJECTED");
    expect(toHttp.calls).toHaveLength(1);
  });

  it("refuses a blocked or malformed first URL without contacting anything", async () => {
    const { fetchImpl, calls } = fakeTransport({});
    const load = policy({ block: [parseSourcePattern("https://1.1.1.1/private/*")] });
    expect(await code(gate(load).fetch("https://1.1.1.1/private/x", { fetchImpl, official: false }))).toBe("SOURCE_POLICY_BLOCKED");
    expect(await code(gate().fetch("not a url", { fetchImpl, official: false }))).toBe("SOURCE_URL_REJECTED");
    expect(await code(gate().fetch("https://user:pw@1.1.1.1/x", { fetchImpl, official: false }))).toBe("SOURCE_URL_REJECTED");
    expect(calls).toHaveLength(0);
  });

  it("reports a transport failure as unreachable", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await code(gate().fetch("https://1.1.1.1/asset", { fetchImpl: failing, official: false }))).toBe("SOURCE_UNREACHABLE");
  });
});

describe("downloadUrlForPolicy", () => {
  it("normalizes the host, drops the query and a trailing slash, and keeps the port", () => {
    expect(downloadUrlForPolicy(new URL("https://GitHub.COM./acme/market/releases/?x=1#f"))).toMatchObject({
      scheme: "https",
      host: "github.com",
      port: null,
      path: "/acme/market/releases",
      url: "https://github.com/acme/market/releases",
    });
    expect(downloadUrlForPolicy(new URL("http://git.corp.example:8080/a")).url).toBe("http://git.corp.example:8080/a");
  });
});
