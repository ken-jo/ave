vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

// The shell egress grant store (egress-grants.ts), the per-extension worker lists (egress-runtime.ts) and the identity strength that caps the scopes (egress-identity.ts).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import { canonicalizePathForMatch } from "../sensitive-paths.js";
import { PermissionManager } from "../permission-manager.js";
import { EGRESS_GRANT_SCOPE_LADDERS } from "../../shared/egress-grant-scopes.js";

const ALL = ["once", "session", "project", "always"] as const;
const matchingScopes = Object.values(EGRESS_GRANT_SCOPE_LADDERS).flat();
const subject = { token: "1".repeat(32), sessionId: "session-1", tabId: undefined, projectRoot: "", origin: "shell" as const };
const github = { host: "github.com", port: 443 };

let dir: string;
let file: string;
let projectRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-egress-grants-"));
  file = join(dir, "shell-egress-hosts.json");
  subject.projectRoot = join(dir, "project");
  mkdirSync(subject.projectRoot);
  projectRoot = canonicalizePathForMatch(subject.projectRoot);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EgressGrantStore", () => {
  it("filters eligible scopes before choosing a stored grant", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("once", ALL, subject, github);
    await store.grant("session", ALL, subject, github);
    await store.grant("always", ALL, subject, github);
    expect(await store.matchingScope(subject, github, ["session", "always"])).toBe("session");
    expect(await store.matchingScope(subject, github, ["always"])).toBe("always");
    expect(await store.matchingScope(subject, github, [])).toBeUndefined();
  });

  it("uses an eligible always grant when the matching workspace grant is ineligible", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("project", ALL, subject, github);
    await store.grant("always", ALL, subject, github);
    const saved = readFileSync(file, "utf8");
    const reloaded = new EgressGrantStore(file);

    expect(await reloaded.matchingScope(subject, github, ["always"])).toBe("always");
    expect(await reloaded.matchingScope(subject, github, ALL)).toBe("project");
    expect(readFileSync(file, "utf8")).toBe(saved);
  });

  it.each(["once", "session", "tab"] as const)("keeps %s grants separate for every approved network class", async (scope) => {
    const store = new EgressGrantStore(file);
    const owner = scope === "tab"
      ? { ...subject, sessionId: undefined, tabId: "terminal:0a1b2c3d-1", origin: "terminal" as const }
      : subject;
    const networks = ["public", "local", "unverified"] as const;
    for (const network of networks) {
      const destination = { ...github, network };
      expect(await store.matchingScope(owner, destination, matchingScopes)).toBeUndefined();
      await store.grant(scope, [scope], owner, destination);
      expect(await store.matchingScope(owner, destination, matchingScopes)).toBe(scope);
    }
    if (scope !== "once") {
      const listed = scope === "tab" ? store.listTab() : store.listSession();
      expect(listed.map(grant => grant.network)).toEqual(networks);
      for (const grant of listed) store.noteUse(scope, owner, grant);
      const target = listed.find(grant => grant.network === "local")!;
      expect(await store.revoke(target)).toEqual({ removed: true, tokens: [owner.token] });
      expect(await store.matchingScope(owner, { ...github, network: "local" }, matchingScopes)).toBeUndefined();
      expect(await store.matchingScope(owner, { ...github, network: "public" }, matchingScopes)).toBe(scope);
      expect(await store.matchingScope(owner, { ...github, network: "unverified" }, matchingScopes)).toBe(scope);
    }
  });

  it.each([
    ["shell", "project"], ["shell", "always"], ["terminal", "always"],
  ] as const)("loads legacy %s %s grants as public-only without crossing origins", async (origin, scope) => {
    const legacy = { scope, origin, ...github, ...(scope === "project" ? { projectRoot } : {}), grantedAt: "2026-10-19T00:00:00Z" };
    writeFileSync(file, JSON.stringify({ version: 2, grants: [legacy] }));
    const store = new EgressGrantStore(file);
    const owner = { ...subject, origin };
    expect(await store.listPersistent()).toEqual([{ ...legacy, network: "public" }]);
    expect(await store.matchingScope(owner, github, matchingScopes)).toBe(scope);
    for (const network of ["local", "unverified"] as const) {
      expect(await store.matchingScope(owner, { ...github, network }, matchingScopes)).toBeUndefined();
    }
    expect(await store.matchingScope({ ...owner, origin: origin === "shell" ? "terminal" : "shell" }, github, matchingScopes)).toBeUndefined();
    expect((await store.revoke({ ...legacy, network: "public" })).removed).toBe(true);
  });

  it("migrates a v1 grant made at a repository root exactly, and drops and reports one made in a subdirectory", async () => {
    // A v1 grant covered its exact directory; v2 keys project grants on the repository root. Carrying a subdirectory
    // grant over would either never match again or widen it to the whole repository, so it is dropped and reported.
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git", "objects"), { recursive: true });
    mkdirSync(join(repo, ".git", "refs"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(repo, "sub"));
    const repoRoot = canonicalizePathForMatch(repo);
    const subDir = canonicalizePathForMatch(join(repo, "sub"));
    const crates = { host: "crates.io", port: 443 };
    writeFileSync(file, JSON.stringify({
      version: 1,
      grants: [
        { scope: "workspace", origin: "shell", workspaceRoot: repoRoot, ...github, network: "public", grantedAt: "2026-10-19T00:00:00Z" },
        { scope: "workspace", origin: "shell", workspaceRoot: subDir, ...crates, network: "public", grantedAt: "2026-10-19T00:00:01Z" },
      ],
    }));
    const dropped: unknown[] = [];
    const store = new EgressGrantStore(file, (entry) => dropped.push(entry));
    expect(await store.listPersistent()).toEqual([
      { scope: "project", origin: "shell", projectRoot: repoRoot, ...github, network: "public", grantedAt: "2026-10-19T00:00:00Z" },
    ]);
    expect(dropped).toEqual([{ ...crates, workspaceRoot: subDir, projectRoot: repoRoot }]);
    // The root grant now means what a "This project" choice at the root means; the dropped one is asked again.
    const inSub = { ...subject, projectRoot: repoRoot };
    expect(await store.matchingScope(inSub, github, matchingScopes)).toBe("project");
    expect(await store.matchingScope(inSub, crates, matchingScopes)).toBeUndefined();
    // A re-read before the file is rewritten reports nothing twice, and the next write stores only the exact grant.
    await store.grant("always", ALL, subject, { host: "pypi.org", port: 443 }, new Date("2026-10-19T02:00:00.000Z"));
    expect(dropped).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).grants.map((g: { host: string }) => g.host)).toEqual(["github.com", "pypi.org"]);
  });

  it("migrates a v1 workspace grant to a project grant on the same root, and the next write stores version 2", async () => {
    // Owner 2026-10-25 (five-choice network card): the v1 names are migrated once, explicitly, never matched as aliases.
    const v1 = {
      version: 1,
      grants: [
        { scope: "workspace", origin: "shell", workspaceRoot: projectRoot, ...github, network: "public", grantedAt: "2026-10-19T00:00:00Z" },
        { scope: "always", origin: "terminal", host: "crates.io", port: 443, grantedAt: "2026-10-19T00:00:01Z" },
      ],
    };
    writeFileSync(file, JSON.stringify(v1));
    const store = new EgressGrantStore(file);
    expect(await store.listPersistent()).toEqual([
      { scope: "project", origin: "shell", projectRoot, ...github, network: "public", grantedAt: "2026-10-19T00:00:00Z" },
      { scope: "always", origin: "terminal", host: "crates.io", port: 443, network: "public", grantedAt: "2026-10-19T00:00:01Z" },
    ]);
    expect(await store.matchingScope(subject, github, matchingScopes)).toBe("project");
    // Reading alone does not rewrite the file; the next write does, as version 2.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(v1);
    await store.grant("always", ALL, subject, { host: "pypi.org", port: 443 }, new Date("2026-10-19T02:00:00.000Z"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 2,
      grants: [
        { scope: "project", origin: "shell", projectRoot, ...github, network: "public", grantedAt: "2026-10-19T00:00:00Z" },
        { scope: "always", origin: "terminal", host: "crates.io", port: 443, network: "public", grantedAt: "2026-10-19T00:00:01Z" },
        { scope: "always", origin: "shell", host: "pypi.org", port: 443, network: "public", grantedAt: "2026-10-19T02:00:00.000Z" },
      ],
    });
  });

  it.each([null, "reserved", "unknown", 1])("refuses an explicit invalid stored class %s", async (network) => {
    writeFileSync(file, JSON.stringify({ version: 2, grants: [{ scope: "always", origin: "shell", ...github, network, grantedAt: "2026-10-19T00:00:00Z" }] }));
    await expect(new EgressGrantStore(file).matchingScope(subject, github, matchingScopes)).rejects.toThrow(/invalid network class/u);
    await expect(new EgressGrantStore(file).grant("once", ALL, subject, { ...github, network } as never)).rejects.toThrow(/invalid network class/u);
  });

  it.each(["local", "unverified"] as const)("refuses to persist a %s approval even if a caller offers Always", async (network) => {
    await expect(new EgressGrantStore(file).grant("always", ALL, subject, { ...github, network })).rejects.toThrow(/scope cannot cover this network class/u);
  });

  it.each(["public", "local", "unverified"] as const)("keeps an explicit recorded %s class without widening persistent eligibility", async (network) => {
    const recorded = { scope: "always" as const, origin: "shell" as const, ...github, network, grantedAt: "2026-10-19T00:00:00Z" };
    writeFileSync(file, JSON.stringify({ version: 2, grants: [recorded] }));
    const store = new EgressGrantStore(file);
    expect(await store.listPersistent()).toEqual([recorded]);
    for (const judged of ["public", "local", "unverified"] as const) {
      expect(await store.matchingScope(subject, { ...github, network: judged }, matchingScopes)).toBe(network === "public" && judged === "public" ? "always" : undefined);
    }
    expect(await store.revoke(recorded)).toEqual({ removed: true, tokens: [] });
  });

  it("records each scope where it belongs and matches only that subject", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("once", ALL, subject, github);
    expect(await store.matchingScope(subject, github, matchingScopes)).toBe("once");
    expect(await store.matchingScope({ ...subject, token: "2".repeat(32) }, github, matchingScopes)).toBeUndefined();
    expect(await store.matchingScope(subject, { host: "github.com", port: 22 }, matchingScopes)).toBeUndefined();

    await store.grant("session", ALL, subject, { host: "registry.npmjs.org", port: 443 });
    expect(await store.matchingScope({ ...subject, token: "3".repeat(32) }, { host: "registry.npmjs.org", port: 443 }, matchingScopes))
      .toBe("session");
    expect(await store.matchingScope({ ...subject, token: "3".repeat(32), sessionId: "session-2" }, { host: "registry.npmjs.org", port: 443 }, matchingScopes))
      .toBeUndefined();

    await store.grant("project", ALL, subject, { host: "pypi.org", port: 443 }, new Date("2026-10-19T01:02:03.000Z"));
    await store.grant("always", ALL, subject, { host: "example.com", port: 443 }, new Date("2026-10-19T01:02:04.000Z"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 2,
      grants: [
        { scope: "project", origin: "shell", projectRoot, host: "pypi.org", port: 443, network: "public", grantedAt: "2026-10-19T01:02:03.000Z" },
        { scope: "always", origin: "shell", host: "example.com", port: 443, network: "public", grantedAt: "2026-10-19T01:02:04.000Z" },
      ],
    });
    const elsewhere = { token: "4".repeat(32), sessionId: undefined, tabId: undefined, projectRoot: join(dir, "other"), origin: "shell" as const };
    expect(await store.matchingScope(elsewhere, { host: "pypi.org", port: 443 }, matchingScopes)).toBeUndefined();
    expect(await store.matchingScope(elsewhere, { host: "example.com", port: 443 }, matchingScopes)).toBe("always");
    expect(await store.matchingScope({ ...elsewhere, projectRoot: `${subject.projectRoot}/` }, { host: "pypi.org", port: 443 }, matchingScopes))
      .toBe("project");
  });

  it("forgets a released call's Allow once hosts", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("once", ALL, subject, github);
    store.releaseToken(subject.token);
    expect(await store.matchingScope(subject, github, matchingScopes)).toBeUndefined();
  });

  it("refuses a scope that was not offered or that the subject cannot hold, and a non-canonical destination", async () => {
    const store = new EgressGrantStore(file);
    await expect(store.grant("always", ["once", "session"], subject, github)).rejects.toThrow(/was not offered/u);
    await expect(store.grant("session", ALL, { ...subject, sessionId: undefined }, github))
      .rejects.toThrow(/no session/u);
    await expect(store.grant("project", ALL, { ...subject, projectRoot: undefined }, github))
      .rejects.toThrow(/no project/u);
    await expect(store.grant("once", ALL, subject, { host: "GitHub.com", port: 443 })).rejects.toThrow(/not canonical/u);
    await expect(store.grant("once", ALL, subject, { host: "github.com", port: 70_000 })).rejects.toThrow(/invalid port/u);
    await expect(store.grant("forever" as never, ALL, subject, github)).rejects.toThrow(/unknown scope/u);
  });

  it("lists and revokes persistent grants", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("project", ALL, subject, github);
    await store.grant("always", ALL, subject, github);
    expect((await store.listPersistent()).map((g) => g.scope)).toEqual(["project", "always"]);
    expect((await store.revoke({ scope: "project", origin: "shell", host: "github.com", port: 443, projectRoot: canonicalizePathForMatch(join(dir, "other")) })).removed)
      .toBe(false);
    expect((await store.revoke({ scope: "project", origin: "shell", host: "github.com", port: 443, projectRoot })).removed)
      .toBe(true);
    expect(await store.matchingScope(subject, github, matchingScopes)).toBe("always");
    expect((await store.revoke({ scope: "always", origin: "terminal", host: "github.com", port: 443 })).removed).toBe(false);
    expect((await store.revoke({ scope: "always", origin: "shell", host: "github.com", port: 443 })).removed).toBe(true);
    expect(await store.matchingScope(subject, github, matchingScopes)).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 2, grants: [] });
  });

  it.each([
    ["invalid JSON", "{", /invalid JSON/u],
    ["a top-level array", "[]", /not an object/u],
    ["an unknown field", JSON.stringify({ version: 2, grants: [], extra: true }), /unknown field extra/u],
    ["another version", JSON.stringify({ version: 3, grants: [] }), /unsupported version 3/u],
    ["a once grant", JSON.stringify({ version: 2, grants: [{ scope: "once", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /neither project nor always/u],
    ["a relative project root", JSON.stringify({ version: 2, grants: [{ scope: "project", origin: "shell", projectRoot: "work", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /absolute, normalised projectRoot/u],
    ["an always grant with a project root", JSON.stringify({ version: 2, grants: [{ scope: "always", origin: "shell", projectRoot: "/w", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /always grant with a projectRoot/u],
    ["an upper-case host", JSON.stringify({ version: 2, grants: [{ scope: "always", origin: "shell", host: "A.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /not canonical/u],
    ["a bad port", JSON.stringify({ version: 2, grants: [{ scope: "always", origin: "shell", host: "a.com", port: "1", grantedAt: "2026-10-19T00:00:00Z" }] }), /invalid port/u],
    ["a bad timestamp", JSON.stringify({ version: 2, grants: [{ scope: "always", origin: "shell", host: "a.com", port: 1, grantedAt: "yesterday" }] }), /invalid grantedAt/u],
    ["a grant without an origin", JSON.stringify({ version: 2, grants: [{ scope: "always", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /origin that is neither shell nor terminal/u],
    ["a grant with an unknown origin", JSON.stringify({ version: 2, grants: [{ scope: "always", origin: "worker", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /origin that is neither shell nor terminal/u],
    ["a project grant from a terminal", JSON.stringify({ version: 2, grants: [{ scope: "project", origin: "terminal", projectRoot: "/w", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /project grant not made by a shell call/u],
    // No silent alias across the v1 -> v2 rename (owner 2026-10-25, five-choice network card): a v2 file never accepts the old names, a v1 file never the new ones.
    ["a v2 workspace grant", JSON.stringify({ version: 2, grants: [{ scope: "workspace", origin: "shell", projectRoot: "/w", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /neither project nor always/u],
    ["a v2 grant with a workspaceRoot", JSON.stringify({ version: 2, grants: [{ scope: "always", origin: "shell", workspaceRoot: "/w", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /unknown field workspaceRoot/u],
    ["a v2 conversation grant", JSON.stringify({ version: 2, grants: [{ scope: "conversation", origin: "shell", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /neither project nor always/u],
    ["a v1 project grant", JSON.stringify({ version: 1, grants: [{ scope: "project", origin: "shell", projectRoot: "/w", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /v2 field projectRoot in a v1 file/u],
    ["a v1 project scope", JSON.stringify({ version: 1, grants: [{ scope: "project", origin: "shell", workspaceRoot: "/w", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /v2 scope project in a v1 file/u],
    ["a v1 conversation grant", JSON.stringify({ version: 1, grants: [{ scope: "conversation", origin: "shell", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z" }] }), /neither project nor always/u],
    ["a grant with an unknown field", JSON.stringify({ version: 2, grants: [{ scope: "always", origin: "shell", host: "a.com", port: 1, grantedAt: "2026-10-19T00:00:00Z", note: "x" }] }), /unknown field note/u],
  ])("refuses a grant file with %s instead of reading it as empty", async (_label, content, problem) => {
    writeFileSync(file, content);
    const store = new EgressGrantStore(file);
    const read = store.matchingScope(subject, github, matchingScopes);
    await expect(read).rejects.toBeInstanceOf(EgressGrantFileError);
    await expect(store.listPersistent()).rejects.toThrow(problem);
    // A write never replaces a file it could not read.
    await expect(store.grant("always", ALL, subject, github)).rejects.toThrow(problem);
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});

describe("session grants and what a revoke closes", () => {
  it("lists and revokes This session grants", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("session", ALL, subject, github, new Date("2026-10-19T03:00:00.000Z"));
    expect(store.listSession()).toEqual([
      { scope: "session", sessionId: "session-1", host: "github.com", port: 443, network: "public", grantedAt: "2026-10-19T03:00:00.000Z" },
    ]);
    expect((await store.revoke({ scope: "session", sessionId: "session-2", host: "github.com", port: 443 })).removed).toBe(false);
    expect((await store.revoke({ scope: "session", sessionId: "session-1", host: "github.com", port: 443 })).removed).toBe(true);
    expect(store.listSession()).toEqual([]);
    expect(await store.matchingScope({ ...subject, token: "9".repeat(32) }, github, matchingScopes)).toBeUndefined();
  });

  it("drops only the ended session's grants and uses when its conversation is deleted", async () => {
    const store = new EgressGrantStore(file);
    const otherSession = { ...subject, token: "7".repeat(32), sessionId: "session-2" };
    await store.grant("session", ALL, subject, github, new Date("2026-10-25T01:00:00.000Z"));
    await store.grant("session", ALL, subject, { host: "pypi.org", port: 443 }, new Date("2026-10-25T01:00:01.000Z"));
    await store.grant("session", ALL, otherSession, github, new Date("2026-10-25T01:00:02.000Z"));
    await store.grant("always", ALL, subject, { host: "example.com", port: 443 });
    store.noteUse("session", subject, github);
    store.noteUse("session", otherSession, github);

    const dropped = store.releaseSessions((id) => id === "session-1");
    expect(dropped.map((g) => g.host).sort()).toEqual(["github.com", "pypi.org"]);
    expect(store.listSession()).toEqual([
      { scope: "session", sessionId: "session-2", host: "github.com", port: 443, network: "public", grantedAt: "2026-10-25T01:00:02.000Z" },
    ]);
    expect(await store.matchingScope({ ...subject, token: "8".repeat(32) }, github, matchingScopes)).toBeUndefined();
    expect(await store.matchingScope({ ...subject, token: "8".repeat(32) }, { host: "example.com", port: 443 }, matchingScopes)).toBe("always");
    expect(await store.matchingScope({ ...otherSession, token: "8".repeat(32) }, github, matchingScopes)).toBe("session");
    // The dropped grant's uses are gone; the other session's are kept for its own revoke.
    expect((await store.revoke({ scope: "session", sessionId: "session-1", host: "github.com", port: 443 })).tokens).toEqual([]);
    expect((await store.revoke({ scope: "session", sessionId: "session-2", host: "github.com", port: 443 })).tokens).toEqual([otherSession.token]);
    expect(store.releaseSessions((id) => id === "session-unknown")).toEqual([]);
  });

  it("hands back the live calls a revoked grant let through, and forgets released ones", async () => {
    const store = new EgressGrantStore(file);
    const other = { ...subject, token: "2".repeat(32) };
    const ended = { ...subject, token: "3".repeat(32) };
    await store.grant("project", ALL, subject, github);
    for (const s of [subject, other, ended]) store.noteUse("project", s, github);
    store.noteUse("always", subject, github);
    store.noteUse("once", subject, github);
    store.releaseToken(ended.token);
    const { removed, tokens } = await store.revoke({ scope: "project", origin: "shell", projectRoot, host: "github.com", port: 443 });
    expect(removed).toBe(true);
    expect([...tokens].sort()).toEqual([subject.token, other.token].sort());
    // The always grant's use is its own.
    expect((await store.revoke({ scope: "always", origin: "shell", host: "github.com", port: 443 })).tokens).toEqual([subject.token]);
  });
});

describe("terminal tab grants (design F)", () => {
  const TAB = "terminal:0a1b2c3d-1";
  const TERMINAL_LADDER = ["once", "tab", "always"] as const;
  const tabSubject = { token: "5".repeat(32), sessionId: undefined, tabId: TAB, projectRoot: undefined, origin: "terminal" as const };

  it("records This tab for that tab only, never for a conversation, and lists it", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("tab", TERMINAL_LADDER, tabSubject, github, new Date("2026-10-20T01:00:00.000Z"));
    expect(await store.matchingScope({ ...tabSubject, token: "6".repeat(32) }, github, matchingScopes)).toBe("tab");
    expect(await store.matchingScope({ ...tabSubject, tabId: "terminal:0a1b2c3d-2" }, github, matchingScopes)).toBeUndefined();
    expect(await store.matchingScope(subject, github, matchingScopes)).toBeUndefined();
    expect(store.listTab()).toEqual([
      { scope: "tab", tabId: TAB, host: "github.com", port: 443, network: "public", grantedAt: "2026-10-20T01:00:00.000Z" },
    ]);
    expect(store.listSession()).toEqual([]);
  });

  it("refuses This tab without a tab, and This session for a terminal", async () => {
    const store = new EgressGrantStore(file);
    await expect(store.grant("tab", TERMINAL_LADDER, { ...tabSubject, tabId: undefined }, github)).rejects.toThrow(/no terminal tab/u);
    await expect(store.grant("session", TERMINAL_LADDER, tabSubject, github)).rejects.toThrow(/was not offered/u);
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
    expect(await store.matchingScope(tabSubject, github, matchingScopes)).toBeUndefined();
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

  it("never holds a terminal's Allow once, and gives a terminal no This project", async () => {
    const store = new EgressGrantStore(file);
    await expect(store.grant("once", TERMINAL_LADDER, tabSubject, github)).rejects.toThrow(/Allow once is not held/u);
    await expect(store.grant("project", [...TERMINAL_LADDER, "project"], { ...tabSubject, projectRoot: "/work/project" }, github))
      .rejects.toThrow(/only a shell call can hold a project grant/u);
    expect(await store.matchingScope(tabSubject, github, matchingScopes)).toBeUndefined();
  });

  it("keeps an Always grant to its origin: a terminal's never covers a shell call, nor the reverse", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("always", TERMINAL_LADDER, tabSubject, github, new Date("2026-10-20T02:00:00.000Z"));
    expect(await store.matchingScope({ ...tabSubject, tabId: "terminal:0a1b2c3d-9", token: "7".repeat(32) }, github, matchingScopes)).toBe("always");
    expect(await store.matchingScope(subject, github, matchingScopes)).toBeUndefined();
    await store.grant("always", ALL, subject, { host: "pypi.org", port: 443 }, new Date("2026-10-20T02:00:01.000Z"));
    expect(await store.matchingScope(subject, { host: "pypi.org", port: 443 }, matchingScopes)).toBe("always");
    expect(await store.matchingScope(tabSubject, { host: "pypi.org", port: 443 }, matchingScopes)).toBeUndefined();
    // A shell workspace grant on the very directory terminals are anchored to does not reach a terminal either.
    await store.grant("project", ALL, { ...subject, projectRoot: "/work/project" }, { host: "crates.io", port: 443 });
    expect(await store.matchingScope({ ...tabSubject, projectRoot: "/work/project" }, { host: "crates.io", port: 443 }, matchingScopes)).toBeUndefined();
    expect(await store.listPersistent()).toEqual([
      { scope: "always", origin: "terminal", host: "github.com", port: 443, network: "public", grantedAt: "2026-10-20T02:00:00.000Z" },
      { scope: "always", origin: "shell", host: "pypi.org", port: 443, network: "public", grantedAt: "2026-10-20T02:00:01.000Z" },
      expect.objectContaining({ scope: "project", origin: "shell", host: "crates.io" }),
    ]);
    // Both origins may hold an Always grant for one destination; revoking one leaves the other.
    await store.grant("always", ALL, subject, github);
    expect((await store.revoke({ scope: "always", origin: "terminal", host: "github.com", port: 443 })).removed).toBe(true);
    expect(await store.matchingScope(subject, github, matchingScopes)).toBe("always");
    expect(await store.matchingScope(tabSubject, github, matchingScopes)).toBeUndefined();
  });

  it("keeps This tab to its own tab: another tab, a respawned shell's new tab id and a shell call do not use it", async () => {
    const store = new EgressGrantStore(file);
    await store.grant("tab", TERMINAL_LADDER, tabSubject, github);
    expect(await store.matchingScope({ ...tabSubject, tabId: "terminal:0a1b2c3d-2", token: "8".repeat(32) }, github, matchingScopes)).toBeUndefined();
    // A shell call carries no tab id, even inside the same conversation window.
    expect(await store.matchingScope({ ...subject, token: "9".repeat(32) }, github, matchingScopes)).toBeUndefined();
    // The tab's shell exited: its grants go with it, and the respawned shell asks again.
    store.releaseTab(TAB);
    expect(await store.matchingScope({ ...tabSubject, token: "a".repeat(32) }, github, matchingScopes)).toBeUndefined();
  });

  // Directory symlink creation may require a privilege the host does not grant.
  it.skipIf(!canCreateSymlinks("dir"))("compares working directories after the sandbox's canonicalizer (symlinks resolved)", async () => {
    const real = join(dir, "real-project");
    const link = join(dir, "linked-project");
    mkdirSync(real);
    symlinkSync(real, link, "dir");
    const store = new EgressGrantStore(file);
    await store.grant("project", ALL, { ...subject, projectRoot: link }, github);
    expect(await store.matchingScope({ ...subject, projectRoot: real }, github, matchingScopes)).toBe("project");
    expect((await store.listPersistent())[0]).toMatchObject({ projectRoot: canonicalizePathForMatch(real) });
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
    const shell = openEgressInvocation({ kind: "terminal", tabId });
    const requests: unknown[] = [];
    const callback = createEgressAskRuntimeCallback({
      approvalGate: {
        requestAndWait: async (request) => {
          requests.push(request);
          return { requestId: request.id, choice: "allow-once", egressScope: "tab" };
        },
      },
      shellAskEnabled: () => true,
    });
    // Both phases of one connection, as the patched ASRT calls them.
    const ask = async (
      destination: { host: string; port: number },
      connection: { attributionKey: string; identity: "listener"; addresses: string[]; resolution: "pinned" },
    ) => {
      const { addresses, resolution, ...who } = connection;
      const byName = await callback(destination, { ...who, phase: "name" });
      return byName === true ? callback(destination, { ...who, phase: "resolved", addresses, resolution }) : byName;
    };
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
        { scope: "tab", tabId, host: "github.com", port: 443, network: "public", grantedAt: expect.any(String) },
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

describe("shell domain grants in the running process", () => {
  it("persists Always for later calls without granting the terminal a destination", async () => {
    const { openEgressInvocation } = await import("../egress-invocations.js");
    const { createEgressAskRuntimeCallback, listEgressGrants, revokeEgressGrant } = await import("../egress-runtime.js");
    const owner = { kind: "shell" as const, toolName: "bash" as const, toolUseId: undefined,
      context: { sessionId: "domain-session", workspaceRoot: dir, approvalSurface: "interactive" as const } };
    const first = openEgressInvocation(owner);
    const second = openEgressInvocation(owner);
    const terminal = openEgressInvocation({ kind: "terminal", tabId: "terminal:0a1b2c3d-7" });
    const requests: unknown[] = [];
    const permissionManager = new PermissionManager(join(dir, "permissions.json"));
    permissionManager.setMode("strict");
    const callback = createEgressAskRuntimeCallback({ permissionManager, approvalGate: { requestAndWait: async (request) => {
      requests.push(request);
      if (request.egressHost?.terminalTabId) return { requestId: request.id, choice: "deny-once" };
      return { requestId: request.id, choice: "allow-once", egressScope: "always" };
    } }, shellAskEnabled: () => true });
    const destination = { host: "downloads.example.com", port: 443 };
    const target = { scope: "always" as const, origin: "shell" as const, ...destination, network: "public" as const };
    const ask = async (token: string) => {
      const who = { attributionKey: token, identity: "listener" as const };
      const byName = await callback(destination, { ...who, phase: "name" });
      return byName === true ? callback(destination, { ...who, phase: "resolved", addresses: ["93.184.215.14"], resolution: "pinned" }) : byName;
    };
    setWorkerEgressAllowlists({ byExtension: new Map(), modelEndpointHosts: [] });
    try {
      await revokeEgressGrant(target);
      expect(await ask(first.token)).toBe(true);
      expect(requests).toEqual([expect.objectContaining({
        // Owner 2026-10-25 (five-choice network card): the shell card offers once, session, project and always (with Deny); the ip2 once/always cap is gone.
        kind: "egress-host", egressHost: expect.objectContaining({ scopes: ["once", "session", "project", "always"] }),
      })]);
      expect(await listEgressGrants()).toContainEqual(expect.objectContaining(target));
      first.release();
      expect(await ask(second.token)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(await ask(terminal.token)).toEqual({ allow: false, reason: "denied by the user" });
      expect(requests).toHaveLength(2);
      expect((await revokeEgressGrant(target)).removed).toBe(true);
    } finally {
      await revokeEgressGrant(target);
      first.release(); second.release(); terminal.release();
    }
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
    expect(egressScopesForNetwork(ALL, "local")).toEqual(["once", "session"]);
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
  it("is kernel-channel on macOS and Linux and shared on Windows, which caps grants at This session", () => {
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
    expect(egressGrantScopesFor("shared")).toEqual(["once", "session"]);
    expect(maxEgressGrantScope("kernel-channel")).toBe("always");
    expect(maxEgressGrantScope("shared")).toBe("session");
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
    // Bare names cover their subdomains too, as the shared allowlist did (normalizeUnionForAsrt).
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
