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
  egressGrantScopesFor,
  EgressGrantFileError,
  EgressGrantStore,
  isValidEgressPort,
} from "../egress-grants.js";
import { egressIdentityStrength } from "../egress-identity.js";
import { setWorkerEgressAllowlists, workerEgressAllowedDomains } from "../egress-runtime.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const ALL = ["once", "conversation", "workspace", "always"] as const;
const subject = { token: "1".repeat(32), sessionId: "session-1", workspaceRoot: "/work/project" };
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
    const elsewhere = { token: "4".repeat(32), sessionId: undefined, workspaceRoot: "/work/other" };
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
    expect(await store.revokePersistent({ scope: "workspace", host: "github.com", port: 443, workspaceRoot: "/work/other" }))
      .toBe(false);
    expect(await store.revokePersistent({ scope: "workspace", host: "github.com", port: 443, workspaceRoot: "/work/project" }))
      .toBe(true);
    expect(await store.matchingScope(subject, github)).toBe("always");
    expect(await store.revokePersistent({ scope: "always", host: "github.com", port: 443, workspaceRoot: undefined })).toBe(true);
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
      expect(egressIdentityStrength()).toBe("shared");
      for (const platform of ["darwin", "linux"] as const) {
        setProcessPlatform(platform);
        expect(egressIdentityStrength()).toBe("kernel-channel");
      }
    } finally {
      setProcessPlatform(original);
    }
    expect(egressGrantScopesFor("kernel-channel")).toEqual(ALL);
    expect(egressGrantScopesFor("shared")).toEqual(["once", "conversation"]);
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
