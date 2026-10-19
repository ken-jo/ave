/**
 * The shell egress grant store (egress-grants.ts), the per-extension worker
 * lists (egress-runtime.ts) and the identity strength that caps the scopes
 * (egress-identity.ts).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalEgressHost,
  egressDestinationNetwork,
  egressScopesForNetwork,
  egressGrantScopesFor,
  EgressGrantFileError,
  EgressGrantStore,
  isValidEgressPort,
} from "../egress-grants.js";
import { egressIdentityStrength, noteAsrtUnixSocketPolicy } from "../egress-identity.js";
import { maxEgressGrantScope } from "../../shared/sandbox-capability-info.js";
import { setWorkerEgressAllowlists, workerEgressAllowedDomains } from "../egress-runtime.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const ALL = ["once", "conversation", "workspace", "always"] as const;
const subject = { token: "1".repeat(32), sessionId: "session-1", tabId: undefined, workspaceRoot: "/work/project" };
const github = { host: "github.com", port: 443 };

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-egress-grants-"));
  file = join(dir, "shell-egress-hosts.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EgressGrantStore", () => {
  it("records each scope where it belongs and matches only that subject", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("once", ALL, subject, github);
    expect(await store.matchingScope(subject, github)).toBe("once");
    expect(await store.matchingScope({ ...subject, token: "2".repeat(32) }, github)).toBeUndefined();
    expect(await store.matchingScope(subject, { host: "github.com", port: 22 })).toBeUndefined();

    await store.grant("conversation", ALL, subject, { host: "registry.npmjs.org", port: 443 });
    expect(await store.matchingScope({ ...subject, token: "3".repeat(32) }, { host: "registry.npmjs.org", port: 443 }))
      .toBe("conversation");
    expect(await store.matchingScope({ ...subject, token: "3".repeat(32), sessionId: "session-2" }, { host: "registry.npmjs.org", port: 443 }))
      .toBeUndefined();

    await store.grant("workspace", ALL, subject, { host: "pypi.org", port: 443 }, new Date("2026-10-19T01:02:03.000Z"));
    await store.grant("always", ALL, subject, { host: "example.com", port: 443 }, new Date("2026-10-19T01:02:04.000Z"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      grants: [
        { scope: "workspace", workspaceRoot: "/work/project", host: "pypi.org", port: 443, grantedAt: "2026-10-19T01:02:03.000Z" },
        { scope: "always", host: "example.com", port: 443, grantedAt: "2026-10-19T01:02:04.000Z" },
      ],
    });
    const elsewhere = { token: "4".repeat(32), sessionId: undefined, tabId: undefined, workspaceRoot: "/work/other" };
    expect(await store.matchingScope(elsewhere, { host: "pypi.org", port: 443 })).toBeUndefined();
    expect(await store.matchingScope(elsewhere, { host: "example.com", port: 443 })).toBe("always");
    expect(await store.matchingScope({ ...elsewhere, workspaceRoot: "/work/project/" }, { host: "pypi.org", port: 443 }))
      .toBe("workspace");
  });

  it("forgets a released call's Allow once hosts", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("once", ALL, subject, github);
    store.releaseToken(subject.token);
    expect(await store.matchingScope(subject, github)).toBeUndefined();
  });

  it("refuses a scope that was not offered or that the subject cannot hold, and a non-canonical destination", async () => {
    const store = new EgressGrantStore(file);
    await expect(store.grant("always", ["once", "conversation"], subject, github)).rejects.toThrow(/was not offered/u);
    await expect(store.grant("conversation", ALL, { ...subject, sessionId: undefined }, github))
      .rejects.toThrow(/no conversation/u);
    await expect(store.grant("workspace", ALL, { ...subject, workspaceRoot: undefined }, github))
      .rejects.toThrow(/no workspace/u);
    await expect(store.grant("once", ALL, subject, { host: "GitHub.com", port: 443 })).rejects.toThrow(/not canonical/u);
    await expect(store.grant("once", ALL, subject, { host: "github.com", port: 70_000 })).rejects.toThrow(/invalid port/u);
    await expect(store.grant("forever" as never, ALL, subject, github)).rejects.toThrow(/unknown scope/u);
  });

  it("lists and revokes persistent grants", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("workspace", ALL, subject, github);
    await store.grant("always", ALL, subject, github);
    expect((await store.listPersistent()).map((g) => g.scope)).toEqual(["workspace", "always"]);
    expect((await store.revoke({ scope: "workspace", host: "github.com", port: 443, workspaceRoot: "/work/other" })).removed)
      .toBe(false);
    expect((await store.revoke({ scope: "workspace", host: "github.com", port: 443, workspaceRoot: "/work/project" })).removed)
      .toBe(true);
    expect(await store.matchingScope(subject, github)).toBe("always");
    expect((await store.revoke({ scope: "always", host: "github.com", port: 443 })).removed).toBe(true);
    expect(await store.matchingScope(subject, github)).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, grants: [] });
  });

  it.each([
    ["invalid JSON", "{", /invalid JSON/u],
    ["a top-level array", "[]", /not an object/u],
    ["an unknown field", JSON.stringify({ version: 1, grants: [], extra: true }), /unknown field extra/u],
    ["another version", JSON.stringify({ version: 2, grants: [] }), /unsupported version 2/u],
    ["a once grant", JSON.stringify({ version: 1, grants: [{ scope: "once", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /neither workspace nor always/u],
    ["a relative workspace", JSON.stringify({ version: 1, grants: [{ scope: "workspace", workspaceRoot: "work", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /absolute, normalised workspaceRoot/u],
    ["an always grant with a workspace", JSON.stringify({ version: 1, grants: [{ scope: "always", workspaceRoot: "/w", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /always grant with a workspaceRoot/u],
    ["an upper-case host", JSON.stringify({ version: 1, grants: [{ scope: "always", host: "A.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /not canonical/u],
    ["a bad port", JSON.stringify({ version: 1, grants: [{ scope: "always", host: "a.com", port: "1", grantedAt: "2026-10-19T00:00:00Z" }] }), /invalid port/u],
    ["a bad timestamp", JSON.stringify({ version: 1, grants: [{ scope: "always", host: "a.com", port: 1, grantedAt: "yesterday" }] }), /invalid grantedAt/u],
    ["a grant with an unknown field", JSON.stringify({ version: 1, grants: [{ scope: "always", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z", note: "x" }] }), /unknown field note/u],
  ])("refuses a grant file with %s instead of reading it as empty", async (_label, content, problem) => {
    writeFileSync(file, content);
    const store = new EgressGrantStore(file);
    const read = store.matchingScope(subject, github);
    await expect(read).rejects.toBeInstanceOf(EgressGrantFileError);
    await expect(store.listPersistent()).rejects.toThrow(problem);
    // A write never replaces a file it could not read.
    await expect(store.grant("always", ALL, subject, github)).rejects.toThrow(problem);
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});

describe("conversation grants and what a revoke closes", () => {
  it("lists and revokes This conversation grants", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("conversation", ALL, subject, github, new Date("2026-10-19T03:00:00.000Z"));
    expect(store.listConversation()).toEqual([
      { scope: "conversation", sessionId: "session-1", host: "github.com", port: 443, grantedAt: "2026-10-19T03:00:00.000Z" },
    ]);
    expect((await store.revoke({ scope: "conversation", sessionId: "session-2", host: "github.com", port: 443 })).removed).toBe(false);
    expect((await store.revoke({ scope: "conversation", sessionId: "session-1", host: "github.com", port: 443 })).removed).toBe(true);
    expect(store.listConversation()).toEqual([]);
    expect(await store.matchingScope({ ...subject, token: "9".repeat(32) }, github)).toBeUndefined();
  });

  it("hands back the live calls a revoked grant let through, and forgets released ones", async () => {
    const store = new EgressGrantStore(file);
    const other = { ...subject, token: "2".repeat(32) };
    const ended = { ...subject, token: "3".repeat(32) };
    await store.grant("workspace", ALL, subject, github);
    for (const s of [subject, other, ended]) store.noteUse("workspace", s, github);
    store.noteUse("always", subject, github);
    store.noteUse("once", subject, github);
    store.releaseToken(ended.token);
    const { removed, tokens } = await store.revoke({ scope: "workspace", workspaceRoot: "/work/project", host: "github.com", port: 443 });
    expect(removed).toBe(true);
    expect([...tokens].sort()).toEqual([subject.token, other.token].sort());
    // The always grant's use is its own.
    expect((await store.revoke({ scope: "always", host: "github.com", port: 443 })).tokens).toEqual([subject.token]);
  });
});

describe("terminal tab grants (design F)", () => {
  const TAB = "terminal:0a1b2c3d-1";
  const TERMINAL_LADDER = ["once", "tab", "workspace", "always"] as const;
  const tabSubject = { token: "5".repeat(32), sessionId: undefined, tabId: TAB, workspaceRoot: "/work/project" };

  it("records This tab for that tab only, never for a conversation, and lists it", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("tab", TERMINAL_LADDER, tabSubject, github, new Date("2026-10-20T01:00:00.000Z"));
    expect(await store.matchingScope({ ...tabSubject, token: "6".repeat(32) }, github)).toBe("tab");
    expect(await store.matchingScope({ ...tabSubject, tabId: "terminal:0a1b2c3d-2" }, github)).toBeUndefined();
    expect(await store.matchingScope(subject, github)).toBeUndefined();
    expect(store.listTab()).toEqual([
      { scope: "tab", tabId: TAB, host: "github.com", port: 443, grantedAt: "2026-10-20T01:00:00.000Z" },
    ]);
    expect(store.listConversation()).toEqual([]);
  });

  it("refuses This tab without a tab, and This conversation for a terminal", async () => {
    const store = new EgressGrantStore(file);
    await expect(store.grant("tab", TERMINAL_LADDER, { ...tabSubject, tabId: undefined }, github)).rejects.toThrow(/no terminal tab/u);
    await expect(store.grant("conversation", TERMINAL_LADDER, tabSubject, github)).rejects.toThrow(/was not offered/u);
    await expect(store.grant("tab", ALL, subject, github)).rejects.toThrow(/was not offered/u);
  });

  it("drops a tab's grants and their uses when the tab's shell ends, and revokes one on request", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("tab", TERMINAL_LADDER, tabSubject, github);
    await store.grant("tab", TERMINAL_LADDER, tabSubject, { host: "pypi.org", port: 443 });
    await store.grant("tab", TERMINAL_LADDER, { ...tabSubject, tabId: "terminal:0a1b2c3d-2" }, github);
    store.noteUse("tab", tabSubject, github);
    expect((await store.revoke({ scope: "tab", tabId: TAB, host: "pypi.org", port: 443 })).removed).toBe(true);
    expect(store.releaseTab(TAB).map((grant) => grant.host)).toEqual(["github.com"]);
    expect(await store.matchingScope(tabSubject, github)).toBeUndefined();
    expect(store.listTab().map((grant) => grant.tabId)).toEqual(["terminal:0a1b2c3d-2"]);
    // The released tab's uses went with it: a later revoke names no live shell.
    expect((await store.revoke({ scope: "tab", tabId: TAB, host: "github.com", port: 443 }))).toEqual({ removed: false, tokens: [] });
  });

  it("hands back the tab's shell when its grant is revoked", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("tab", TERMINAL_LADDER, tabSubject, github);
    store.noteUse("tab", tabSubject, github);
    expect(await store.revoke({ scope: "tab", tabId: TAB, host: "github.com", port: 443 })).toEqual({ removed: true, tokens: [tabSubject.token] });
  });

  it("offers a terminal the tab ladder, capped like the shell's, and only in-memory scopes for a local destination", () => {
    expect(egressGrantScopesFor("kernel-channel", "terminal")).toEqual(TERMINAL_LADDER);
    expect(egressGrantScopesFor("shared", "terminal")).toEqual(["once", "tab"]);
    expect(egressGrantScopesFor("kernel-channel", "shell")).toEqual(ALL);
    expect(egressScopesForNetwork(TERMINAL_LADDER, "public")).toEqual(TERMINAL_LADDER);
    expect(egressScopesForNetwork(TERMINAL_LADDER, "local")).toEqual(["once", "tab"]);
    expect(egressScopesForNetwork(TERMINAL_LADDER, "unverified")).toEqual(["once", "tab"]);
    expect(egressScopesForNetwork(TERMINAL_LADDER, "reserved")).toEqual([]);
  });
});

describe("terminal tab grants in the running process (egress-runtime)", () => {
  it("lists a tab grant beside the others and drops it when the tab's shell is released", async () => {
    const { openEgressInvocation } = await import("../egress-invocations.js");
    const { createEgressAskRuntimeCallback, listEgressGrants, revokeEgressGrant } = await import("../egress-runtime.js");
    const tabId = "terminal:0a1b2c3d-7";
    const shell = openEgressInvocation({ kind: "terminal", tabId, workspaceRoot: "/work/project" });
    const requests: unknown[] = [];
    const ask = createEgressAskRuntimeCallback({
      approvalGate: {
        requestAndWait: async (request) => {
          requests.push(request);
          return { requestId: request.id, choice: "allow-once", egressScope: "tab" };
        },
      },
      shellAskEnabled: () => true,
    });
    try {
      const context = { attributionKey: shell.token, identity: "listener" as const, addresses: ["140.82.112.3"], resolution: "pinned" as const };
      expect(await ask({ host: "github.com", port: 443 }, context)).toBe(true);
      expect(requests).toEqual([expect.objectContaining({
        kind: "egress-host",
        toolName: "terminal",
        egressHost: expect.objectContaining({ host: "github.com", port: 443, terminalTabId: tabId, scopes: expect.arrayContaining(["once", "tab"]) }),
      })]);
      expect(requests[0]).not.toHaveProperty("sessionId");
      expect((await listEgressGrants()).filter((grant) => grant.scope === "tab")).toEqual([
        { scope: "tab", tabId, host: "github.com", port: 443, grantedAt: expect.any(String) },
      ]);
      // Revoking from Settings works on a tab grant too.
      await ask({ host: "pypi.org", port: 443 }, { ...context, addresses: ["151.101.0.223"] });
      expect((await revokeEgressGrant({ scope: "tab", tabId, host: "pypi.org", port: 443 })).removed).toBe(true);
    } finally {
      shell.release();
    }
    expect((await listEgressGrants()).filter((grant) => grant.scope === "tab")).toEqual([]);
  });
});

describe("destination networks", () => {
  it.each([
    ["github.com", "public"], ["8.8.8.8", "public"], ["2606:4700::1111", "public"],
    ["127.0.0.1", "local"], ["::1", "local"], ["localhost", "local"], ["api.localhost", "local"],
    ["10.0.0.1", "local"], ["172.16.5.5", "local"], ["192.168.0.1", "local"], ["100.64.1.1", "local"], ["fd12::1", "local"],
    ["169.254.169.254", "reserved"], ["fe80::1", "reserved"], ["0.0.0.0", "reserved"], ["::", "reserved"],
    ["224.0.0.1", "reserved"], ["255.255.255.255", "reserved"], ["168.63.129.16", "reserved"], ["fd00:ec2::254", "reserved"],
    ["64:ff9b::a9fe:a9fe", "reserved"], ["fec0::1", "local"],
    ["nas.local", "local"], ["localhost.localdomain", "local"], ["ip6-localhost", "local"], ["router.home.arpa", "local"],
  ] as const)("%s is %s", (host, network) => {
    expect(egressDestinationNetwork(host)).toBe(network);
  });

  it.each([
    ["files.corp.example", ["10.1.2.3"], "local"],
    ["mixed.example", ["93.184.215.14", "192.168.1.5"], "local"],
    ["v6.example", ["fec0::5"], "local"],
    ["meta.example", ["93.184.215.14", "169.254.169.254"], "reserved"],
    ["example.com", ["93.184.215.14"], "public"],
  ] as const)("judges %s by what it resolved to (%j): %s", (host, addresses, network) => {
    expect(egressDestinationNetwork(host, addresses)).toBe(network);
  });

  it("refuses a resolved address that is not an IP address", () => {
    expect(() => egressDestinationNetwork("example.com", ["example.org"])).toThrow(/not an IP address/u);
  });

  it("caps the scopes for a local destination and offers none for a reserved one", () => {
    expect(egressScopesForNetwork(ALL, "public")).toEqual(ALL);
    expect(egressScopesForNetwork(ALL, "local")).toEqual(["once", "conversation"]);
    expect(egressScopesForNetwork(ALL, "reserved")).toEqual([]);
  });
});

describe("destination canonicalisation", () => {
  it("canonicalises hosts the way ASRT compares them", () => {
    expect(canonicalEgressHost("GitHub.COM.")).toBe("github.com");
    expect(canonicalEgressHost("[::1]")).toBe("::1");
    expect(canonicalEgressHost("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(canonicalEgressHost("2130706433")).toBe("127.0.0.1");
    expect(canonicalEgressHost("")).toBeUndefined();
    expect(canonicalEgressHost("exa mple.com")).toBeUndefined();
    expect(canonicalEgressHost("a".repeat(254))).toBeUndefined();
  });

  it("accepts only integer ports 1-65535", () => {
    expect([1, 443, 65535].every(isValidEgressPort)).toBe(true);
    expect([0, 65536, 1.5, "443", undefined].some(isValidEgressPort)).toBe(false);
  });
});

describe("identity strength and the scopes it allows", () => {
  it("is kernel-channel on macOS and Linux and shared on Windows, which caps grants at This conversation", () => {
    const original = process.platform;
    try {
      setProcessPlatform("win32");
      expect(egressIdentityStrength("shell")).toBe("shared");
      expect(egressIdentityStrength("extension")).toBe("shared");
      for (const platform of ["darwin", "linux"] as const) {
        setProcessPlatform(platform);
        expect(egressIdentityStrength("shell")).toBe("kernel-channel");
        expect(egressIdentityStrength("extension")).toBe("kernel-channel");
      }
    } finally {
      setProcessPlatform(original);
    }
    expect(egressGrantScopesFor("kernel-channel")).toEqual(ALL);
    expect(egressGrantScopesFor("shared")).toEqual(["once", "conversation"]);
    expect(maxEgressGrantScope("kernel-channel")).toBe("always");
    expect(maxEgressGrantScope("shared")).toBe("conversation");
  });

  it("is shared on macOS when the session allows every Unix socket (the proxy's own sockets included)", () => {
    const original = process.platform;
    try {
      setProcessPlatform("darwin");
      noteAsrtUnixSocketPolicy(true);
      expect(egressIdentityStrength("shell")).toBe("shared");
      setProcessPlatform("linux");
      noteAsrtUnixSocketPolicy(true);
      // Linux wraps hide the proxy's socket directory whatever the flag says.
      expect(egressIdentityStrength("shell")).toBe("kernel-channel");
    } finally {
      noteAsrtUnixSocketPolicy(false);
      setProcessPlatform(original);
    }
  });
});

describe("worker egress lists", () => {
  it("gives a worker its own extension's domains and the model endpoints, never another extension's", () => {
    // Bare names cover their subdomains too, as the shared allowlist did
    // (normalizeUnionForAsrt).
    setWorkerEgressAllowlists({
      byExtension: new Map([
        ["ext_a", ["api.a.example", "*.cdn.a.example"]],
        ["ext_b", ["api.b.example"]],
      ]),
      modelEndpointHosts: ["models.example"],
    });
    expect(workerEgressAllowedDomains("ext_a")).toEqual([
      "api.a.example", "*.api.a.example", "*.cdn.a.example", "models.example", "*.models.example",
    ]);
    expect(workerEgressAllowedDomains("ext_a")).not.toContain("api.b.example");
    expect(workerEgressAllowedDomains("ext_unknown")).toEqual(["models.example", "*.models.example"]);
    expect(workerEgressAllowedDomains(undefined)).toEqual(["models.example", "*.models.example"]);
    setWorkerEgressAllowlists({ byExtension: new Map(), modelEndpointHosts: [] });
    expect(workerEgressAllowedDomains("ext_a")).toEqual([]);
  });
});
