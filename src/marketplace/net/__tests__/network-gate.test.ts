import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressCheckedFetch } from "../../../core/network-guard.js";
import { ConfirmationRequiredError, MarketplaceError } from "../../errors.js";
import { FIXTURE_POLICY_PATH, policyLoad as policy, policySource } from "../../__tests__/fixtures/policy.js";
import type { PolicyLoad } from "../../sources/policy.js";
import type { SourceWarning } from "../../sources/warnings.js";
import { NetworkGate, downloadUrlForPolicy, type CatalogSource } from "../network-gate.js";
import { normalizeSourceUrl, parseSourcePattern } from "../source-url.js";
import { downloadBounded } from "../../resolve/download.js";

/** What the gate logs, unscrubbed: a test of what it hands the logger, not of the scrubber. */
const logged = vi.hoisted(() => ({ warn: [] as unknown[][] }));
vi.mock("../../log.js", () => ({
  createMarketplaceLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: (...args: unknown[]) => void logged.warn.push(args),
    error: () => undefined,
  }),
}));

const NONE: ReadonlySet<SourceWarning> = new Set();
const OFFICIAL = { official: true, acknowledged: NONE };
const OTHER = { official: false, acknowledged: NONE };
const holding = (...warnings: SourceWarning[]) => ({ official: false, acknowledged: new Set(warnings) });

interface RecordedCall {
  url: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
  /** The answers the gate let the connection use. */
  kept: readonly string[];
}

/**
 * A pinned transport over a route table: each hop "resolves" its host from
 * `dns` (an IP literal resolves to itself), hands the answers to the gate's
 * `select` exactly once, and records what the hop carried and kept.
 */
function fakeTransport(routes: Record<string, () => Response>, dns: Record<string, readonly string[]> = {}): { transport: AddressCheckedFetch; calls: RecordedCall[]; lookups: string[] } {
  const calls: RecordedCall[] = [];
  const lookups: string[] = [];
  const transport: AddressCheckedFetch = async (url, init, select) => {
    const host = new URL(url).hostname.replace(/^\[(.*)\]$/u, "$1");
    lookups.push(host);
    const kept = select(dns[host] ?? [host]);
    calls.push({ url, headers: new Headers(init.headers), redirect: init.redirect, kept });
    const route = routes[url];
    if (!route) return new Response("missing", { status: 404 });
    return route();
  };
  return { transport, calls, lookups };
}

function gate(load: PolicyLoad = policy(), allowLoopback = false, transport: AddressCheckedFetch = fakeTransport({}).transport): NetworkGate {
  return new NetworkGate({ policy: policySource(load), allowLoopback, transport });
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return "passed";
}

function code(run: () => unknown): string {
  const error = caught(run);
  if (error === "passed") return "passed";
  if (error instanceof MarketplaceError) return error.code;
  throw error;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketplaceError) return error.code;
    throw error;
  }
  return "passed";
}

async function failureOf(promise: Promise<unknown>): Promise<MarketplaceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketplaceError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

const remote = (text: string) => normalizeSourceUrl(text);
const hop = (text: string) => new URL(text);

describe("NetworkGate.checkRemote", () => {
  it("passes a public https remote without a lookup, and asks before plain http (§18.2.2)", () => {
    const verdict = gate().checkRemote(remote("https://1.1.1.1/acme/market"), OTHER);
    expect(verdict).toMatchObject({ allowHttp: false, credentialsAllowed: true });
    expect(verdict.addressPolicy("1.1.1.1", hop("https://1.1.1.1/"))).toBe("allow");

    const http = caught(() => gate().checkRemote(remote("http://1.1.1.1/acme/market"), OTHER));
    expect(http).toBeInstanceOf(ConfirmationRequiredError);
    expect((http as ConfirmationRequiredError).warnings).toEqual([{ warning: "unencrypted", host: "1.1.1.1", address: null }]);
    expect((http as ConfirmationRequiredError).detail).toEqual({ reason: "unencrypted", host: "1.1.1.1" });

    // Confirmed: http is allowed, but no sign-in travels over it until token-unencrypted is confirmed too.
    expect(gate().checkRemote(remote("http://1.1.1.1/acme/market"), holding("unencrypted"))).toMatchObject({ allowHttp: true, credentialsAllowed: false });
    expect(gate().checkRemote(remote("http://1.1.1.1/acme/market"), holding("unencrypted", "token-unencrypted"))).toMatchObject({ allowHttp: true, credentialsAllowed: true });
  });

  it("applies block before allow and treats a present allow list as exhaustive", () => {
    const load = policy({
      allow: [parseSourcePattern("host:1.1.1.1")],
      block: [parseSourcePattern("https://1.1.1.1/acme/secret")],
    });
    expect(code(() => gate(load).checkRemote(remote("https://1.1.1.1/acme/market"), OTHER))).toBe("passed");
    expect(code(() => gate(load).checkRemote(remote("https://1.1.1.1/acme/secret"), OTHER))).toBe("SOURCE_POLICY_BLOCKED");
    expect(code(() => gate(load).checkRemote(remote("https://1.0.0.1/acme/market"), OTHER))).toBe("SOURCE_POLICY_BLOCKED");
    // The allow list binds the official source too (§7.4: every target passes one gate).
    expect(code(() => gate(load).checkRemote(remote("https://1.0.0.1/acme/market"), OFFICIAL))).toBe("SOURCE_POLICY_BLOCKED");
  });

  it("says which rule blocked a target, and where the policy lives (§18.8)", () => {
    const load = policy({
      allow: [parseSourcePattern("host:1.1.1.1")],
      block: [parseSourcePattern("https://1.1.1.1/acme/secret")],
    });
    const detail = (run: () => unknown) => (caught(run) as MarketplaceError).detail;
    expect(detail(() => gate(load).checkRemote(remote("https://1.1.1.1/acme/secret"), OTHER))).toEqual({
      reason: "blocked-by-pattern",
      target: "https://1.1.1.1/acme/secret",
      pattern: "https://1.1.1.1/acme/secret",
      policyPath: FIXTURE_POLICY_PATH,
    });
    expect(detail(() => gate(load).checkRemote(remote("https://1.0.0.1/acme/market"), OTHER))).toEqual({
      reason: "not-in-allow-list",
      target: "https://1.0.0.1/acme/market",
      policyPath: FIXTURE_POLICY_PATH,
    });
    const broken: PolicyLoad = { ok: false, error: "/fixture/ave-policy.json: marketplaces.blok: is not a known key", path: FIXTURE_POLICY_PATH };
    expect(detail(() => gate(broken).checkRemote(remote("https://1.1.1.1/acme/market"), OTHER))).toEqual({
      reason: "policy-invalid",
      error: "/fixture/ave-policy.json: marketplaces.blok: is not a known key",
    });
  });

  it("blocks every source but the official one when the policy is unreadable", () => {
    const broken: PolicyLoad = { ok: false, error: "marketplaces.blok: is not a known key", path: "/fixture/ave-policy.json" };
    expect(code(() => gate(broken).checkRemote(remote("https://1.1.1.1/acme/market"), OTHER))).toBe("SOURCE_POLICY_BLOCKED");
    expect(code(() => gate(broken).checkRemote(remote("https://1.1.1.1/acme/market"), OFFICIAL))).toBe("passed");
  });

  it("warns, never refuses, for an internal or this-computer address the source does not hold (§18.2.2)", () => {
    for (const [url, warning, address] of [
      ["https://10.0.0.5/ave/market", "internal-network", "10.0.0.5"],
      ["https://100.64.0.9/ave/market", "internal-network", "100.64.0.9"],
      ["https://198.18.0.1/ave/market", "internal-network", "198.18.0.1"],
      ["ssh://git@[fd00::1]/ave/market", "internal-network", "fd00::1"],
      ["https://127.0.0.1/ave/market", "this-computer", "127.0.0.1"],
    ] as const) {
      const error = caught(() => gate().checkRemote(remote(url), OTHER));
      expect(error, url).toBeInstanceOf(ConfirmationRequiredError);
      expect((error as ConfirmationRequiredError).warnings, url).toEqual([{ warning, host: remote(url).host, address }]);
      expect(code(() => gate().checkRemote(remote(url), holding(warning))), url).toBe("passed");
    }
  });

  it("asks for every warning of one address at once", () => {
    const error = caught(() => gate().checkRemote(remote("http://192.168.1.20/ave/market"), OTHER)) as ConfirmationRequiredError;
    expect(error.warnings.map((view) => view.warning)).toEqual(["unencrypted", "internal-network"]);
  });

  it("refuses metadata and unroutable addresses, listed hosts included (§18.3 #3)", () => {
    const listed = policy({ allow: [parseSourcePattern("host:169.254.169.254"), parseSourcePattern("host:100.100.100.200"), parseSourcePattern("host:192.0.2.1"), parseSourcePattern("host:[fd00:ec2::254]")] });
    for (const [url, reason] of [
      ["https://169.254.169.254/ave/market", "address-metadata"],
      ["https://100.100.100.200/ave/market", "address-metadata"],
      ["https://[fd00:ec2::254]/ave/market", "address-metadata"],
      ["https://192.0.2.1/ave/market", "address-unroutable"],
    ] as const) {
      for (const load of [policy(), listed]) {
        const error = caught(() => gate(load).checkRemote(remote(url), holding("internal-network", "this-computer")));
        expect(error, url).toBeInstanceOf(MarketplaceError);
        expect((error as MarketplaceError).code, url).toBe("SOURCE_URL_REJECTED");
        expect((error as MarketplaceError).detail, url).toMatchObject({ reason });
      }
    }
  });

  it("needs no confirmation for a listed host but token-unencrypted, which is never implied", () => {
    const load = policy({ allowHttpHosts: new Set(["10.0.0.5"]), allow: [parseSourcePattern("host:10.0.0.5")] });
    expect(gate(load).checkRemote(remote("http://10.0.0.5/ave/market"), OTHER)).toMatchObject({ allowHttp: true, credentialsAllowed: false });
    const managed = policy({ additional: [{ transport: "git", id: "corp", url: remote("https://192.168.1.20/ave/market"), auth: { kind: "none" } }] });
    expect(code(() => gate(managed).checkRemote(remote("https://192.168.1.20/ave/market"), OTHER))).toBe("passed");
  });

  it("needs no this-computer or http confirmation in a dev build, and still asks for an internal one", () => {
    expect(gate(undefined, true).checkRemote(remote("http://127.0.0.1:8080/ave/market"), OTHER)).toMatchObject({ allowHttp: true });
    expect(code(() => gate(undefined, true).checkRemote(remote("https://10.0.0.5/ave/market"), OTHER))).toBe("SOURCE_CONFIRMATION_REQUIRED");
  });

  it("judges each answer a name resolves to: internal fails the connection until confirmed, metadata is dropped", () => {
    const { addressPolicy } = gate().checkRemote(remote("https://git.corp.example/ave/market"), OTHER);
    const at = hop("https://git.corp.example/");
    expect(addressPolicy("1.1.1.1", at)).toBe("allow");
    const internal = addressPolicy("10.0.0.5", at);
    expect(internal).not.toBe("allow");
    expect(internal !== "allow" && internal.fatal).toBe(true);
    expect(internal !== "allow" && internal.cause).toBeInstanceOf(ConfirmationRequiredError);
    const metadata = addressPolicy("169.254.169.254", at);
    expect(metadata !== "allow" && metadata.fatal).toBe(false);
  });

  it("blocks plain http under requireHttps even when the source confirmed it, unless the host is listed (§18.6)", () => {
    const load = policy({ requireHttps: true });
    const error = caught(() => gate(load).checkRemote(remote("http://1.1.1.1/acme/market"), holding("unencrypted")));
    expect(error).toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "https-required", target: "http://1.1.1.1/acme/market", policyPath: FIXTURE_POLICY_PATH } });
    const listed = policy({ requireHttps: true, allowHttpHosts: new Set(["1.1.1.1"]) });
    expect(code(() => gate(listed).checkRemote(remote("http://1.1.1.1/acme/market"), OTHER))).toBe("passed");
  });

  it("blocks internal and this-computer addresses under blockPrivateNetworks even when the source confirmed them (§18.6)", () => {
    const load = policy({ blockPrivateNetworks: true });
    const error = caught(() => gate(load).checkRemote(remote("https://10.0.0.5/ave/market"), holding("internal-network")));
    expect(error).toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "private-network-blocked", target: "https://10.0.0.5/ave/market", address: "10.0.0.5", policyPath: FIXTURE_POLICY_PATH } });
    expect(code(() => gate(load, true).checkRemote(remote("https://127.0.0.1/ave/market"), holding("this-computer")))).toBe("SOURCE_POLICY_BLOCKED");
  });

  it("reads the policy at each check, so a change applies to the next operation", () => {
    const source = policySource(policy());
    const live = new NetworkGate({ policy: source, allowLoopback: false, transport: fakeTransport({}).transport });
    expect(code(() => live.checkRemote(remote("https://1.1.1.1/acme/market"), OTHER))).toBe("passed");
    source.apply({ load: policy({ block: [parseSourcePattern("host:1.1.1.1")] }), digest: "next" });
    expect(code(() => live.checkRemote(remote("https://1.1.1.1/acme/market"), OTHER))).toBe("SOURCE_POLICY_BLOCKED");
  });
});

const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const ok = () => new Response("bytes", { status: 200 });

const CATALOG: CatalogSource = { id: "corp", label: "Corp tools", url: remote("https://10.0.0.5/ave/market"), acknowledged: new Set(["internal-network"]) };

describe("NetworkGate.fetch", () => {
  it("carries auth within one origin and drops it on a cross-origin redirect", async () => {
    const { transport, calls } = fakeTransport({
      "https://1.1.1.1/asset": redirect("/asset-2"),
      "https://1.1.1.1/asset-2": redirect("https://1.0.0.1/blob?sig=abc"),
      "https://1.0.0.1/blob?sig=abc": ok,
    });
    const response = await gate(undefined, false, transport).fetch("https://1.1.1.1/asset", {
      official: false,
      catalog: null,
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

  it("never carries a sign-in onto plain http, not even to the same host the https request went to (§18.2.2)", async () => {
    const { transport, calls } = fakeTransport({
      "https://1.1.1.1/asset": redirect("http://1.1.1.1/blob"),
      "http://1.1.1.1/blob": ok,
    });
    const response = await gate(undefined, false, transport).fetch("https://1.1.1.1/asset", {
      official: false,
      catalog: CATALOG,
      headers: { authorization: "Bearer secret", cookie: "a=b" },
    });
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1/asset", "http://1.1.1.1/blob"]);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
    expect(calls[1]!.headers.get("authorization")).toBeNull();
    expect(calls[1]!.headers.get("cookie")).toBeNull();
  });

  it("tells the caller of every hop it admitted, so an https download redirected to http is known to be plain http (§15.2)", async () => {
    const { transport } = fakeTransport({
      "https://1.1.1.1/asset": redirect("http://1.0.0.1/blob"),
      "http://1.0.0.1/blob": ok,
    });
    const hops: string[] = [];
    const response = await gate(undefined, false, transport).fetch("https://1.1.1.1/asset", { official: false, catalog: CATALOG, onHop: (hop) => hops.push(hop) });
    expect(response.status).toBe(200);
    expect(hops).toEqual(["https://1.1.1.1/asset", "http://1.0.0.1/blob"]);

    // A hop the gate refuses is never reported.
    const refused: string[] = [];
    const blocked = fakeTransport({ "https://1.1.1.1/asset": redirect("https://1.0.0.1/blob") });
    const load = policy({ block: [parseSourcePattern("host:1.0.0.1")] });
    expect(await codeOf(gate(load, false, blocked.transport).fetch("https://1.1.1.1/asset", { official: false, catalog: CATALOG, onHop: (hop) => refused.push(hop) }))).toBe("SOURCE_POLICY_BLOCKED");
    expect(refused).toEqual(["https://1.1.1.1/asset"]);
  });

  it("hands the observer a snapshot: mutating it changes nothing that is requested or where the sign-in goes", async () => {
    const { transport, calls } = fakeTransport({
      "https://1.1.1.1/asset": redirect("/asset-2"),
      "https://1.1.1.1/asset-2": ok,
    });
    const tamper = (hop: unknown): void => {
      // A URL object handed over would let this redirect the request (and its Authorization) elsewhere.
      try {
        (hop as { href: string }).href = "https://1.0.0.1/stolen";
      } catch {
        // A string snapshot cannot be assigned to.
      }
    };
    const response = await gate(undefined, false, transport).fetch("https://1.1.1.1/asset", {
      official: false,
      catalog: CATALOG,
      headers: { authorization: "Bearer canary", cookie: "c=canary" },
      onHop: tamper,
    });
    expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1/asset", "https://1.1.1.1/asset-2"]);
    expect(calls.every((call) => call.headers.get("authorization") === "Bearer canary")).toBe(true);
    expect(response.status).toBe(200);
  });

  it("isolates an observer that throws: the download and the gate's decision are unchanged", async () => {
    const { transport, calls } = fakeTransport({
      "https://1.1.1.1/asset": redirect("http://1.0.0.1/blob"),
      "http://1.0.0.1/blob": ok,
    });
    const seen: string[] = [];
    const response = await gate(undefined, false, transport).fetch("https://1.1.1.1/asset", {
      official: false,
      catalog: CATALOG,
      onHop: (hop) => {
        seen.push(String(hop));
        throw new Error("observer broke");
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("bytes");
    expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1/asset", "http://1.0.0.1/blob"]);
    expect(seen).toEqual(["https://1.1.1.1/asset", "http://1.0.0.1/blob"]);
  });

  describe("a failing observer", () => {
    beforeEach(() => {
      logged.warn.length = 0;
    });

    /** A body that answers once and then ends, or never ends, recording whether it was read to the end or cancelled. */
    function trackedBody(ends: boolean) {
      const state = { closed: false, cancelled: false };
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode("bytes"));
          } else if (ends) {
            controller.close();
            state.closed = true;
          }
          // An unending body stays silent after its first chunk.
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return { state, body };
    }

    const nullPrototype = (): unknown => Object.create(null);
    const throwingToString = (): unknown => ({ toString: () => { throw new Error("toString broke"); } });
    const throwingGetter = (): unknown => Object.defineProperty(new Error(), "message", { get: () => { throw new Error("getter broke"); } });
    const cases: Array<[string, () => unknown]> = [
      ["a null-prototype object", nullPrototype],
      ["a value whose toString throws", throwingToString],
      ["an Error whose message getter throws", throwingGetter],
      ["an Error quoting a credential", () => new Error("sig=canary-secret-7f3a")],
    ];

    it.each(cases)("lets the download complete when the observer throws %s, and reads the body to its end", async (_label, thrown) => {
      const tracked = trackedBody(true);
      const { transport } = fakeTransport({ "https://1.1.1.1/asset?sig=canary-secret-7f3a": () => new Response(tracked.body, { status: 200 }) });
      const bytes = await downloadBounded("https://1.1.1.1/asset?sig=canary-secret-7f3a", {
        gate: gate(undefined, false, transport),
        catalog: CATALOG,
        official: false,
        maxBytes: 1024,
        stallMs: 50,
        onHop: () => {
          throw thrown();
        },
      });
      expect(bytes.toString("utf8")).toBe("bytes");
      expect(tracked.state.closed).toBe(true);
    });

    it.each(cases)("cancels an unending body at the stall deadline when the observer throws %s", async (_label, thrown) => {
      const tracked = trackedBody(false);
      const { transport } = fakeTransport({ "https://1.1.1.1/asset": () => new Response(tracked.body, { status: 200 }) });
      const download = downloadBounded("https://1.1.1.1/asset", {
        gate: gate(undefined, false, transport),
        catalog: CATALOG,
        official: false,
        maxBytes: 1024,
        stallMs: 50,
        onHop: () => {
          throw thrown();
        },
      });
      await expect(download).rejects.toMatchObject({ code: "SOURCE_UNREACHABLE", detail: { reason: "timeout" } });
      expect(tracked.state.cancelled).toBe(true);
    });

    it("logs the hop's origin and the thrown value's class, never the signed query or the observer's message", async () => {
      const { transport } = fakeTransport({ "https://1.1.1.1/asset/path-secret?sig=canary-secret-7f3a": ok });
      const response = await gate(undefined, false, transport).fetch("https://1.1.1.1/asset/path-secret?sig=canary-secret-7f3a", {
        official: false,
        catalog: CATALOG,
        onHop: () => {
          throw new TypeError("token canary-message-91b2 rejected");
        },
      });
      expect(response.status).toBe(200);
      const text = JSON.stringify(logged.warn);
      expect(logged.warn).toHaveLength(1);
      expect(text).not.toContain("canary-secret-7f3a");
      expect(text).not.toContain("path-secret");
      expect(text).not.toContain("canary-message-91b2");
      expect(text).toContain("https://1.1.1.1");
      expect(text).toContain("TypeError");
    });
  });

  it("does not report a hop the address check refuses (§18.2.4)", async () => {
    const { transport, calls } = fakeTransport(
      { "https://1.1.1.1/asset": redirect("http://meta.example/blob"), "http://meta.example/blob": ok },
      { "meta.example": ["169.254.169.254"] },
    );
    const seen: string[] = [];
    await expect(gate(undefined, false, transport).fetch("https://1.1.1.1/asset", { official: false, catalog: CATALOG, onHop: (hop) => seen.push(String(hop)) })).rejects.toThrow();
    // The metadata hop was resolved and refused: nothing connected to it, and it is not reported.
    expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1/asset"]);
    expect(seen).toEqual(["https://1.1.1.1/asset"]);
  });

  it("resolves each hop exactly once, in the transport, and connects only to the answers the rule keeps (§18.2.4)", async () => {
    const { transport, calls, lookups } = fakeTransport(
      { "https://cdn.example/asset": redirect("https://mirror.example/asset"), "https://mirror.example/asset": ok },
      { "cdn.example": ["1.1.1.1", "169.254.169.254"], "mirror.example": ["1.0.0.1"] },
    );
    expect((await gate(undefined, false, transport).fetch("https://cdn.example/asset", { official: false, catalog: CATALOG })).status).toBe(200);
    expect(lookups).toEqual(["cdn.example", "mirror.example"]);
    // The metadata answer is dropped; the public one is used.
    expect(calls.map((call) => call.kept)).toEqual([["1.1.1.1"], ["1.0.0.1"]]);
  });

  it("refuses a redirect to a blocked host before contacting it", async () => {
    const { transport, calls } = fakeTransport({
      "https://1.1.1.1/asset": redirect("https://1.0.0.1/blob"),
      "https://1.0.0.1/blob": ok,
    });
    const load = policy({ block: [parseSourcePattern("host:1.0.0.1")] });
    expect(await codeOf(gate(load, false, transport).fetch("https://1.1.1.1/asset", { official: false, catalog: CATALOG }))).toBe("SOURCE_POLICY_BLOCKED");
    expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1/asset"]);
  });

  it("asks before an internal download hop Ave chose, and before plain http on one", async () => {
    const toPrivate = fakeTransport({ "https://1.1.1.1/asset": redirect("https://10.0.0.1/blob") });
    expect(await codeOf(gate(undefined, false, toPrivate.transport).fetch("https://1.1.1.1/asset", { official: false, catalog: null }))).toBe("SOURCE_CONFIRMATION_REQUIRED");
    expect(toPrivate.calls).toHaveLength(1);

    const toHttp = fakeTransport({ "https://1.1.1.1/asset": redirect("http://1.1.1.1/blob") });
    expect(await codeOf(gate(undefined, false, toHttp.transport).fetch("https://1.1.1.1/asset", { official: false, catalog: null }))).toBe("SOURCE_CONFIRMATION_REQUIRED");
    expect(toHttp.calls).toHaveLength(1);
  });

  it("refuses a blocked or malformed first URL without contacting anything", async () => {
    const { transport, calls } = fakeTransport({});
    const load = policy({ block: [parseSourcePattern("https://1.1.1.1/private/*")] });
    expect(await codeOf(gate(load, false, transport).fetch("https://1.1.1.1/private/x", { official: false, catalog: null }))).toBe("SOURCE_POLICY_BLOCKED");
    expect(await codeOf(gate(undefined, false, transport).fetch("not a url", { official: false, catalog: null }))).toBe("SOURCE_URL_REJECTED");
    expect(await codeOf(gate(undefined, false, transport).fetch("https://user:pw@1.1.1.1/x", { official: false, catalog: null }))).toBe("SOURCE_URL_REJECTED");
    expect(calls).toHaveLength(0);
  });

  it("reports a transport failure as unreachable", async () => {
    const failing: AddressCheckedFetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await codeOf(gate(undefined, false, failing).fetch("https://1.1.1.1/asset", { official: false, catalog: null }))).toBe("SOURCE_UNREACHABLE");
  });
});

describe("NetworkGate.fetch for a catalog's downloads (§18.2.3)", () => {
  const fetchFrom = (catalog: CatalogSource, url: string, load: PolicyLoad = policy(), dns: Record<string, readonly string[]> = {}) => {
    const { transport, calls } = fakeTransport({ [url]: ok }, dns);
    return { result: gate(load, false, transport).fetch(url, { official: false, catalog }), calls };
  };

  it("accepts a public http download: the pinned sha256 verifies it", async () => {
    const { result } = fetchFrom({ ...CATALOG, url: remote("https://1.1.1.1/acme/market"), acknowledged: NONE }, "http://1.0.0.1/x.tgz");
    expect((await result).status).toBe(200);
  });

  it("lets the source's own internal host inherit its confirmation", async () => {
    const { result } = fetchFrom(CATALOG, "https://10.0.0.5/releases/x.tgz");
    expect((await result).status).toBe(200);
    const unconfirmed = fetchFrom({ ...CATALOG, acknowledged: NONE }, "https://10.0.0.5/releases/x.tgz");
    expect(await codeOf(unconfirmed.result)).toBe("SOURCE_CONFIRMATION_REQUIRED");
    expect(unconfirmed.calls).toHaveLength(0);
  });

  it("fails another internal host with only internal-network, and passes it with internal-downloads", async () => {
    const other = fetchFrom(CATALOG, "https://10.0.0.9/x.tgz");
    const error = await failureOf(other.result);
    expect(error.code).toBe("SOURCE_CONFIRMATION_REQUIRED");
    expect(error.detail).toEqual({ reason: "internal-downloads", source: "Corp tools", host: "10.0.0.9" });
    expect(other.calls).toHaveLength(0);
    const allowed = fetchFrom({ ...CATALOG, acknowledged: new Set(["internal-network", "internal-downloads"]) }, "https://10.0.0.9/x.tgz");
    expect((await allowed.result).status).toBe(200);
  });

  it("refuses another service on this computer, and accepts the source's own port (§18.3 #4)", async () => {
    const local: CatalogSource = { id: "dev", label: "Dev market", url: remote("http://127.0.0.1:8080/ave/market"), acknowledged: new Set(["unencrypted", "this-computer"]) };
    const own = fetchFrom(local, "http://127.0.0.1:8080/releases/x.tgz");
    expect((await own.result).status).toBe(200);
    const elsewhere = fetchFrom(local, "http://127.0.0.1:9090/admin");
    const error = await failureOf(elsewhere.result);
    expect(error.code).toBe("SOURCE_URL_REJECTED");
    expect(error.detail).toEqual({ reason: "catalog-this-computer", source: "Dev market", host: "127.0.0.1" });
    expect(elsewhere.calls).toHaveLength(0);
    // internal-downloads never opens this computer.
    const anyway = fetchFrom({ ...local, acknowledged: new Set([...local.acknowledged, "internal-downloads"]) }, "http://127.0.0.1:9090/admin");
    expect(await codeOf(anyway.result)).toBe("SOURCE_URL_REJECTED");
  });

  it("refuses another service on this computer even when the policy lists that host (§18.3 #4 before any exemption)", async () => {
    const listed = policy({ allowHttpHosts: new Set(["127.0.0.1", "localhost"]) });
    // An unrelated public catalog, holding nothing.
    const publicCatalog: CatalogSource = { ...CATALOG, url: remote("https://public.test/repo"), acknowledged: NONE };
    for (const url of ["http://127.0.0.1:9555/admin", "http://localhost:9555/admin"]) {
      const attempt = fetchFrom(publicCatalog, url, listed, { localhost: ["127.0.0.1"] });
      const error = await failureOf(attempt.result);
      expect(error.code).toBe("SOURCE_URL_REJECTED");
      expect(error.detail).toMatchObject({ reason: "catalog-this-computer" });
      expect(attempt.calls).toHaveLength(0);
    }
    // A listed loopback source's own catalog: its own port inherits, another port on the same host is refused.
    const local: CatalogSource = { id: "dev", label: "Dev market", url: remote("http://127.0.0.1:8080/ave/market"), acknowledged: NONE };
    expect((await fetchFrom(local, "http://127.0.0.1:8080/releases/x.tgz", listed).result).status).toBe(200);
    expect(await codeOf(fetchFrom(local, "http://127.0.0.1:9090/admin", listed).result)).toBe("SOURCE_URL_REJECTED");
    // The listing still exempts an internal host from internal-downloads.
    expect((await fetchFrom(publicCatalog, "https://10.0.0.9/x.tgz", policy({ allowHttpHosts: new Set(["10.0.0.9"]) })).result).status).toBe(200);
  });

  it("refuses metadata for every catalog, and blocks internal hosts under blockPrivateNetworks", async () => {
    const everything = { ...CATALOG, acknowledged: new Set<SourceWarning>(["internal-network", "this-computer", "internal-downloads"]) };
    expect(await codeOf(fetchFrom(everything, "http://169.254.169.254/latest/meta-data").result)).toBe("SOURCE_URL_REJECTED");
    expect(await codeOf(fetchFrom(everything, "https://10.0.0.9/x.tgz", policy({ blockPrivateNetworks: true })).result)).toBe("SOURCE_POLICY_BLOCKED");
  });
});

describe("NetworkGate.fetch policy on download paths", () => {
  it("sees through percent-encoding and covers paths beneath an exact repository", async () => {
    const { transport, calls } = fakeTransport({});
    const block = policy({ block: [parseSourcePattern("https://1.1.1.1/evil/*"), parseSourcePattern("https://1.1.1.1/acme/secret")] });
    expect(await codeOf(gate(block, false, transport).fetch("https://1.1.1.1/%65vil/r/releases/download/v1/x.tgz", { official: false, catalog: null }))).toBe("SOURCE_POLICY_BLOCKED");
    expect(await codeOf(gate(block, false, transport).fetch("https://1.1.1.1/acme/secret/releases/download/v1/x.tgz", { official: false, catalog: null }))).toBe("SOURCE_POLICY_BLOCKED");
    expect(await codeOf(gate(block, false, transport).fetch("https://1.1.1.1//evil/r", { official: false, catalog: null }))).toBe("SOURCE_URL_REJECTED");
    expect(calls).toHaveLength(0);

    // The same exact pattern in an allow list lets that repository's downloads through.
    const allow = policy({ allow: [parseSourcePattern("https://1.1.1.1/acme/tools")] });
    const served = fakeTransport({ "https://1.1.1.1/acme/tools/releases/download/v1/x.tgz": ok });
    expect((await gate(allow, false, served.transport).fetch("https://1.1.1.1/acme/tools/releases/download/v1/x.tgz", { official: false, catalog: null })).status).toBe(200);
    expect(await codeOf(gate(allow, false, served.transport).fetch("https://1.1.1.1/acme/tools-2/x.tgz", { official: false, catalog: null }))).toBe("SOURCE_POLICY_BLOCKED");
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
    // A service endpoint at the root is a path like any other.
    expect(downloadUrlForPolicy(new URL("https://ave.corp.example/?x=1")).path).toBe("/");
  });
});
