import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeSourceUrl } from "../../net/source-url.js";
import {
  EMPTY_MARKETPLACE_POLICY,
  FilePolicySource,
  folderPolicyBlock,
  isBlockedByPolicy,
  loadMarketplacePolicy,
  type MarketplacePolicy,
  type PolicyFileAccess,
} from "../policy.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-mkt-policy-"));
  path = join(dir, "policy.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePolicy(marketplaces: unknown): void {
  writeFileSync(path, JSON.stringify({ version: 1, requireExplicitApproval: true, managed: true, updatedAt: "2026-09-23T00:00:00Z", marketplaces }));
}

async function loaded(marketplaces: unknown, platform: NodeJS.Platform = process.platform): Promise<MarketplacePolicy> {
  writePolicy(marketplaces);
  const result = await loadMarketplacePolicy(path, platform);
  if (!result.ok) throw new Error(`expected a valid policy, got: ${result.error}`);
  return result.policy;
}

async function rejected(marketplaces: unknown, platform: NodeJS.Platform = process.platform): Promise<string> {
  writePolicy(marketplaces);
  const result = await loadMarketplacePolicy(path, platform);
  if (result.ok) throw new Error("expected the policy to be rejected");
  return result.error;
}

const DESIGN_EXAMPLE = {
  allow: ["https://github.com/acme/*", "host:git.corp.example", "https://github.com/ken-jo/agent-marketplace"],
  block: ["host:git.example.org"],
  allowHttpHosts: ["git.corp.example"],
  allowDirectInstall: true,
  allowDisablingOfficial: false,
  additional: [{ id: "corp", url: "https://git.corp.example/ave/marketplace.git" }],
  defaultInstalls: [
    { kind: "plugin", name: "docs-search", source: "corp" },
    { kind: "plugin", name: "sampleportal", source: "corp" },
  ],
  requiredInstalls: [{ kind: "plugin", name: "sampleportal", source: "corp" }],
};

describe("loadMarketplacePolicy", () => {
  it("means no restrictions when the file is missing or has no marketplaces section", async () => {
    expect(await loadMarketplacePolicy(join(dir, "absent.json"))).toEqual({ ok: true, policy: EMPTY_MARKETPLACE_POLICY, path: join(dir, "absent.json") });
    writeFileSync(path, JSON.stringify({ version: 1, requireExplicitApproval: true, managed: false, updatedAt: "x" }));
    expect(await loadMarketplacePolicy(path)).toEqual({ ok: true, policy: EMPTY_MARKETPLACE_POLICY, path });
  });

  it("treats an ENOTDIR policy path as unreadable rather than unrestricted", async () => {
    const parent = join(dir, "admin");
    writeFileSync(parent, "not a directory");
    expect(await loadMarketplacePolicy(join(parent, "policy.json"))).toMatchObject({ ok: false });
  });

  it("treats a dangling policy symlink as unreadable rather than unrestricted", async () => {
    symlinkSync(join(dir, "missing-target.json"), path, "file");
    expect(await loadMarketplacePolicy(path)).toMatchObject({ ok: false });
  });

  it("reads the design example and keeps a key listed in both lists as required only", async () => {
    const policy = await loaded(DESIGN_EXAMPLE);
    expect(policy.allow?.map((pattern) => pattern.text)).toEqual(DESIGN_EXAMPLE.allow);
    expect([...policy.allowHttpHosts]).toEqual(["git.corp.example"]);
    expect(policy.additional).toEqual([
      {
        transport: "git",
        id: "corp",
        url: normalizeSourceUrl("https://git.corp.example/ave/marketplace"),
        auth: { kind: "none" },
      },
    ]);
    expect(policy.requiredInstalls).toEqual([{ kind: "plugin", name: "sampleportal", source: "corp" }]);
    expect(policy.defaultInstalls).toEqual([{ kind: "plugin", name: "docs-search", source: "corp" }]);
    expect(policy.allowDirectInstall).toBe(true);
    expect(policy.allowDisablingOfficial).toBe(false);
  });

  it("defaults allowDirectInstall to true and allowDisablingOfficial to false", async () => {
    const policy = await loaded({});
    expect(policy.allow).toBeNull();
    expect(policy.allowDirectInstall).toBe(true);
    expect(policy.allowDisablingOfficial).toBe(false);
    expect(policy.requireHttps).toBe(false);
    expect(policy.blockPrivateNetworks).toBe(false);
  });

  it("reads requireHttps and blockPrivateNetworks exactly (§18.6)", async () => {
    expect(await loaded({ requireHttps: true, blockPrivateNetworks: false })).toMatchObject({ requireHttps: true, blockPrivateNetworks: false });
    expect(await loaded({ requireHttps: false, blockPrivateNetworks: true })).toMatchObject({ requireHttps: false, blockPrivateNetworks: true });
    expect(await rejected({ requireHttps: "yes" })).toContain("requireHttps: must be true or false");
    expect(await rejected({ blockPrivateNetworks: 1 })).toContain("blockPrivateNetworks: must be true or false");
    // A near miss is not one of them: the section is invalid, not unrestricted.
    expect(await rejected({ requireHTTPS: true })).toContain("marketplaces.requireHTTPS: is not a known key");
  });

  it("gives an ssh additional source ssh auth and normalizes a token host", async () => {
    const policy = await loaded({
      additional: [
        { id: "corp-ssh", url: "git@git.corp.example:ave/market.git" },
        { id: "corp-web", url: "https://git.corp.example/ave/other", auth: { kind: "token", host: "GIT.Corp.Example." }, ref: "release/v1", label: "Corp" },
      ],
    });
    expect(policy.additional[0]).toMatchObject({ transport: "git", auth: { kind: "ssh" } });
    expect(policy.additional[1]).toMatchObject({ auth: { kind: "token", host: "git.corp.example" }, ref: "release/v1", label: "Corp" });
  });

  it.each([
    ["an unknown key (a typo must not fail open)", { blok: ["host:x.example"] }, "marketplaces.blok: is not a known key"],
    ["a pattern that does not parse", { block: ["ftp://x.example/*"] }, "marketplaces.block[0]"],
    ["a wildcard in the middle", { allow: ["https://github.com/*/repo"] }, "marketplaces.allow[0]"],
    ["a non-boolean switch", { allowDirectInstall: "yes" }, "allowDirectInstall: must be true or false"],
    ["a reserved managed id", { additional: [{ id: "ave-corp", url: "https://git.corp.example/a" }] }, "ave-corp is reserved"],
    ["a managed id used twice", { additional: [{ id: "corp", url: "https://git.corp.example/a" }, { id: "corp", url: "https://git.corp.example/b" }] }, "corp is used twice"],
    ["the same repository twice", { additional: [{ id: "one", url: "https://git.corp.example/a" }, { id: "two", url: "https://GIT.corp.example/a.git" }] }, "already a source"],
    ["the official repository as a managed source", { additional: [{ id: "corp", url: "ken-jo/agent-marketplace" }] }, "already a source"],
    ["plain http under requireHttps without allowHttpHosts", { requireHttps: true, additional: [{ id: "corp", url: "http://git.corp.example/a" }] }, "requireHttps is true needs git.corp.example in allowHttpHosts"],
    ["a managed source its own policy blocks", { block: ["host:git.corp.example"], additional: [{ id: "corp", url: "https://git.corp.example/a" }] }, "blocked by this policy"],
    ["token auth on an ssh URL", { additional: [{ id: "corp", url: "ssh://git@git.corp.example/a", auth: { kind: "token", host: "git.corp.example" } }] }, "token auth needs an http(s) URL"],
    ["an unsafe ref", { additional: [{ id: "corp", url: "https://git.corp.example/a", ref: "main..evil" }] }, "is not a branch or tag name"],
    ["an install naming a custom source", { defaultInstalls: [{ kind: "plugin", name: "wiki", source: "someone" }] }, "must name the official source or an additional source"],
    ["an install with an unknown kind", { requiredInstalls: [{ kind: "widget", name: "wiki", source: "ave" }] }, "is not a package kind"],
    ["null for a list (a typo must not mean \"nothing\")", { block: null }, "marketplaces.block: must be an array of strings"],
    ["null for required installs", { requiredInstalls: null }, "marketplaces.requiredInstalls: must be an array"],
    ["a port on an allowHttpHosts entry", { allowHttpHosts: ["git.corp.example:8080"] }, "a host takes no port"],
    ["a token host other than the source's", { additional: [{ id: "corp", url: "https://git.corp.example/a", auth: { kind: "token", host: "github.com" } }] }, "must be the source's host git.corp.example"],
    ["an install listed twice", { requiredInstalls: [{ kind: "plugin", name: "wiki", source: "ave" }, { kind: "plugin", name: "wiki", source: "ave" }] }, "is listed twice"],
  ])("fails closed on %s", async (_label, section, message) => {
    expect(await rejected(section)).toContain(message);
  });

  it("fails closed on a package required from two sources, naming both entries, and keeps defaults and other packages free to (§18.7.2)", async () => {
    const corp = { id: "corp", url: "https://git.corp.example/a" };
    const error = await rejected({
      additional: [corp],
      requiredInstalls: [
        { kind: "plugin", name: "wiki", source: "ave" },
        { kind: "skill", name: "wiki", source: "corp" },
        { kind: "plugin", name: "wiki", source: "corp" },
      ],
    });
    expect(error).toContain("marketplaces.requiredInstalls[2]: requires plugin/wiki from corp, but marketplaces.requiredInstalls[0] requires it from ave; a package is installed from one source");
    // Another kind of the same name, and defaults naming a package from two sources, are not a conflict.
    const policy = await loaded({
      additional: [corp],
      defaultInstalls: [{ kind: "plugin", name: "wiki", source: "ave" }, { kind: "plugin", name: "wiki", source: "corp" }],
      requiredInstalls: [{ kind: "plugin", name: "wiki", source: "ave" }, { kind: "skill", name: "wiki", source: "corp" }],
    });
    expect(policy.requiredInstalls).toEqual([{ kind: "plugin", name: "wiki", source: "ave" }, { kind: "skill", name: "wiki", source: "corp" }]);
  });

  it("takes an http additional source as its own listing, and under requireHttps with its host in allowHttpHosts (§18.2.2)", async () => {
    const plain = await loaded({ requireHttps: false, additional: [{ id: "team-tools", url: "http://git.example.test/catalog" }] });
    expect(plain.additional.map((spec) => (spec.transport === "git" ? spec.url.url : spec.path))).toEqual(["http://git.example.test/catalog"]);
    const excepted = await loaded({ requireHttps: true, allowHttpHosts: ["git.example.test"], additional: [{ id: "team-tools", url: "http://git.example.test/catalog" }] });
    expect(excepted.additional).toHaveLength(1);
  });

  it("fails closed on duplicate keys and unparseable JSON", async () => {
    writeFileSync(path, '{"version":1,"marketplaces":{"block":[],"block":["host:x.example"]}}');
    const duplicate = await loadMarketplacePolicy(path);
    expect(duplicate.ok).toBe(false);
    writeFileSync(path, "{ not json");
    expect((await loadMarketplacePolicy(path)).ok).toBe(false);
  });

  it("fails closed when the file cannot be read", async () => {
    const result = await loadMarketplacePolicy(dir);
    expect(result.ok).toBe(false);
  });
});

describe("isBlockedByPolicy", () => {
  it("lets block win over allow and treats a present allow list as exhaustive", async () => {
    const policy = await loaded({
      allow: ["https://github.com/acme/*", "host:git.corp.example"],
      block: ["https://github.com/acme/secret"],
    });
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("acme/market"))).toBe(false);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("https://github.com/ACME/Market.git"))).toBe(false);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("acme/secret"))).toBe(true);
    // Neither case nor another scheme sidesteps the block.
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("git@github.com:ACME/Secret.git"))).toBe(true);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("https://github.com:443/Acme/secret/"))).toBe(true);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("acme-corp/market"))).toBe(true);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("ssh://git@git.corp.example/any/repo"))).toBe(false);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("https://gitlab.com/acme/market"))).toBe(true);
  });

  it("allows everything not blocked when there is no allow list", async () => {
    const policy = await loaded({ block: ["host:git.example.org"] });
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("https://git.example.org/a/b"))).toBe(true);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("git@git.example.org:a/b"))).toBe(true);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("acme/market"))).toBe(false);
  });
});

describe("FilePolicySource (§18.6)", () => {
  it("reports a rewritten file once, and nothing while it is unchanged", async () => {
    writePolicy({ requireHttps: false });
    const source = await FilePolicySource.open(path);
    expect(source.load).toMatchObject({ ok: true, policy: { requireHttps: false } });
    expect(await source.check()).toBeNull();

    writePolicy({ requireHttps: true, block: ["host:git.example.org"] });
    const update = await source.check();
    expect(update?.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
    expect(update?.digest).not.toBe(source.digest);
    source.apply(update!);
    expect(source.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
    expect(await source.check()).toBeNull();
  });

  it("goes invalid when the file breaks, and back when it is fixed", async () => {
    writePolicy({});
    const source = await FilePolicySource.open(path);
    writeFileSync(path, "{ not json, and longer than before so the size differs");
    const broken = await source.check();
    expect(broken?.load.ok).toBe(false);
    source.apply(broken!);
    writePolicy({ blockPrivateNetworks: true });
    const fixed = await source.check();
    expect(fixed?.load).toMatchObject({ ok: true, policy: { blockPrivateNetworks: true } });
  });

  const FIRST = JSON.stringify({ version: 1, marketplaces: { requireHttps: false } });
  // Other content of the same length.
  const SECOND = JSON.stringify({ version: 1, marketplaces: { requireHttps: true } }).padEnd(FIRST.length, " ");

  it("notices a rewrite that keeps the size and the modification time", async () => {
    const fixed = new Date(Date.UTC(2026, 0, 1));
    writeFileSync(path, FIRST);
    utimesSync(path, fixed, fixed);
    const source = await FilePolicySource.open(path);
    // The modification time put back: only the status-change time can move, and on a coarse clock (NTFS) it often
    // does not within one tick. The read above began within the racy window of that change, so the check reads
    // the file again whatever the clock did.
    expect(SECOND.length).toBe(FIRST.length);
    writeFileSync(path, SECOND);
    utimesSync(path, fixed, fixed);
    expect(statSync(path).mtimeMs).toBe(fixed.getTime());
    expect((await source.check())?.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
  });

  /**
   * node's file system under a clock that does not tick on its own: every write is stamped `clock.stamp`, and a
   * read begins at `clock.now`. Counts the reads of the file's content.
   */
  function coarseClock(clock: { stamp: number; now: number }) {
    const counts = { reads: 0 };
    const access: PolicyFileAccess = {
      lstat: (file) => lstat(file),
      stat: async (file) => {
        const info = await stat(file);
        return { size: info.size, ino: info.ino, dev: info.dev, mtimeMs: clock.stamp, ctimeMs: clock.stamp };
      },
      readFile: async (file) => {
        counts.reads += 1;
        return readFile(file, "utf8");
      },
      now: () => clock.now,
    };
    return { access, counts };
  }

  const T = Date.UTC(2026, 0, 1);

  it("reads again after a read in the same clock tick as the change it saw", async () => {
    // The change and the read land in one tick; so does the rewrite after it, with the same size and times:
    // the stat is identical, and only the content tells the rewrite apart.
    const clock = { stamp: T, now: T + 1 };
    const { access, counts } = coarseClock(clock);
    writeFileSync(path, FIRST);
    const source = await FilePolicySource.open(path, access);
    writeFileSync(path, SECOND);
    const update = await source.check();
    expect(update?.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
    expect(counts.reads).toBe(2);
  });

  it("trusts the stat without reading once a read began clearly after the change, and reads again on a new one", async () => {
    const clock = { stamp: T, now: T + 3_000 };
    const { access, counts } = coarseClock(clock);
    writeFileSync(path, FIRST);
    const source = await FilePolicySource.open(path, access);
    expect(counts.reads).toBe(1);
    expect(await source.check()).toBeNull();
    expect(await source.check()).toBeNull();
    expect(counts.reads).toBe(1);
    // A later write is stamped by a clock that has moved on since the read.
    clock.stamp = T + 3_500;
    writeFileSync(path, SECOND);
    expect((await source.check())?.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
    expect(counts.reads).toBe(2);
  });

  it("reads again while the last read was racy, and trusts the stat again after a read outside the window", async () => {
    const clock = { stamp: T, now: T + 2_999 };
    const { access, counts } = coarseClock(clock);
    writeFileSync(path, FIRST);
    const source = await FilePolicySource.open(path, access);
    // Same content: nothing to apply, but each check reads, since the times cannot tell a same-tick rewrite apart.
    expect(await source.check()).toBeNull();
    expect(await source.check()).toBeNull();
    expect(counts.reads).toBe(3);
    clock.now = T + 3_000;
    expect(await source.check()).toBeNull();
    expect(counts.reads).toBe(4);
    expect(await source.check()).toBeNull();
    expect(counts.reads).toBe(4);
  });

  it("reads again when the clock has stepped back behind the read that recorded the stat", async () => {
    const clock = { stamp: T, now: T + 5_000 };
    const { access, counts } = coarseClock(clock);
    writeFileSync(path, FIRST);
    const source = await FilePolicySource.open(path, access);
    expect(await source.check()).toBeNull();
    expect(counts.reads).toBe(1);
    // The clock steps back to the recorded change, and a rewrite carries the recorded times again.
    clock.now = T;
    writeFileSync(path, SECOND);
    expect((await source.check())?.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
    expect(counts.reads).toBe(2);
  });

  it("treats a change time ahead of the clock as racy until the clock passes it", async () => {
    // A file server whose clock runs ahead of this one, or a modification time set forward.
    const clock = { stamp: T + 60_000, now: T };
    const { access, counts } = coarseClock(clock);
    writeFileSync(path, FIRST);
    const source = await FilePolicySource.open(path, access);
    writeFileSync(path, SECOND);
    const update = await source.check();
    expect(update?.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
    source.apply(update!);
    expect(await source.check()).toBeNull();
    expect(counts.reads).toBe(3);
    clock.now = T + 63_000;
    expect(await source.check()).toBeNull();
    expect(await source.check()).toBeNull();
    expect(counts.reads).toBe(4);
  });

  it("goes unreadable when the file can no longer be read, and back when it can (§12 fail closed)", async () => {
    writePolicy({ requireHttps: false });
    const source = await FilePolicySource.open(path);
    // A directory where the file was: present, but not readable as a file, on every platform.
    rmSync(path);
    mkdirSync(path);
    const gone = await source.check();
    expect(gone?.load.ok).toBe(false);
    expect(gone?.digest).toMatch(/^unreadable:/u);
    source.apply(gone!);
    expect(source.load.ok).toBe(false);
    rmSync(path, { recursive: true });
    writePolicy({ requireHttps: false });
    const back = await source.check();
    expect(back?.load).toMatchObject({ ok: true, policy: { requireHttps: false } });
    source.apply(back!);
    // A quiet check records the file as it stands, as between two operations.
    expect(await source.check()).toBeNull();
    // The reproduction: permissions taken away leave size and modification time alone.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      chmodSync(path, 0o000);
      try {
        const denied = await source.check();
        expect(denied?.load.ok).toBe(false);
        expect(denied?.digest).toBe("unreadable:EACCES");
      } finally {
        chmodSync(path, 0o644);
      }
    }
  });

  it("names an absent file apart from an empty policy, and reads one that appears", async () => {
    const source = await FilePolicySource.open(join(dir, "absent.json"));
    expect(source.load).toMatchObject({ ok: true, policy: EMPTY_MARKETPLACE_POLICY });
    expect(source.digest).toBe("absent");
    writeFileSync(join(dir, "absent.json"), JSON.stringify({ version: 1, marketplaces: { requireHttps: true } }));
    expect((await source.check())?.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
  });

  it("refreshes an absent policy to unreadable when a parent becomes a file", async () => {
    const parent = join(dir, "admin");
    const source = await FilePolicySource.open(join(parent, "policy.json"));
    expect(source.digest).toBe("absent");
    writeFileSync(parent, "not a directory");

    const update = await source.check();

    expect(update?.load).toMatchObject({ ok: false });
    expect(update?.digest).toBe("unreadable:ENOTDIR");
    source.apply(update!);
    expect(source.load.ok).toBe(false);
  });

  it("refreshes an absent policy to unreadable when a dangling symlink appears", async () => {
    const source = await FilePolicySource.open(path);
    expect(source.digest).toBe("absent");
    symlinkSync(join(dir, "missing-target.json"), path, "file");

    const update = await source.check();

    expect(update?.load).toMatchObject({ ok: false });
    expect(update?.digest).toBe("unreadable:ENOENT");
    source.apply(update!);
    expect(source.load.ok).toBe(false);
  });
});

describe("folder sources in the policy (§18.6)", () => {
  it("blocks every folder under allowLocalSources: false, and allows folders by default", async () => {
    expect(EMPTY_MARKETPLACE_POLICY.allowLocalSources).toBe(true);
    expect(folderPolicyBlock(await loaded({}), "/opt/market")).toBeNull();
    const closed = await loaded({ allowLocalSources: false }, "linux");
    expect(folderPolicyBlock(closed, "/opt/market")).toEqual({ reason: "local-sources-blocked" });
    expect(await rejected({ allowLocalSources: "no" }, "linux")).toContain("allowLocalSources");
  });

  it("blocks a folder under an allow list with no path: pattern, and admits one under a path: prefix", async () => {
    const gitOnly = await loaded({ allow: ["host:git.corp.example"] }, "linux");
    expect(folderPolicyBlock(gitOnly, "/opt/a/b")).toEqual({ reason: "not-in-allow-list" });
    const folders = await loaded({ allow: ["path:/opt/a/*"] }, "linux");
    expect(folderPolicyBlock(folders, "/opt/a/b")).toBeNull();
    expect(folderPolicyBlock(folders, "/opt/a")).toEqual({ reason: "not-in-allow-list" });
    expect(folderPolicyBlock(folders, "/opt/ab")).toEqual({ reason: "not-in-allow-list" });
    expect(folderPolicyBlock(await loaded({ allow: ["path:*"] }), "/anything")).toBeNull();
  });

  it("keeps path: patterns to folders and host or URL patterns to git", async () => {
    const policy = await loaded({ block: ["path:*", "host:git.example.org"], allow: ["path:/opt/*", "https://github.com/acme/*"] }, "linux");
    // A folder pattern never matches a git address, and a git pattern never matches a folder.
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("acme/market"))).toBe(false);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("https://git.example.org/a/b"))).toBe(true);
    expect(folderPolicyBlock(policy, "/opt/market")).toEqual({ reason: "blocked-by-pattern", pattern: "path:*" });
    expect(folderPolicyBlock(await loaded({ block: ["host:git.example.org"] }), "/git.example.org")).toBeNull();
  });

  it("reads Windows path: patterns with either separator and any drive-letter case", async () => {
    writePolicy({ block: ["path:c:/Shared/*"] });
    const result = await loadMarketplacePolicy(path, "win32");
    if (!result.ok) throw new Error(result.error);
    expect(folderPolicyBlock(result.policy, "C:\\shared\\tools")).toEqual({ reason: "blocked-by-pattern", pattern: "path:c:/Shared/*" });
    expect(folderPolicyBlock(result.policy, "D:\\shared\\tools")).toBeNull();
  });

  it("refuses an additional source whose id has a credential's shape, and reads one that only looks alike (§18.8)", async () => {
    // Assembled here so no whole token sits in the source.
    const token = `glp${"at-"}${"abcd1234".repeat(3)}`;
    const error = await rejected({ additional: [{ id: token, path: "/srv/team" }] }, "linux");
    expect(error).toContain("additional[0].id: looks like a password or token");
    expect(error).not.toContain(token);
    const policy = await loaded({ additional: [{ id: "test-marketplace2026", path: "/srv/team" }] }, "linux");
    expect(policy.additional).toMatchObject([{ id: "test-marketplace2026" }]);
  });

  it("reads an additional folder with path and refuses what a folder cannot have", async () => {
    const policy = await loaded({ additional: [{ id: "team", path: "/srv/team/market", label: "Team" }] }, "linux");
    expect(policy.additional).toEqual([{ transport: "folder", id: "team", path: "/srv/team/market", label: "Team" }]);
    expect(await rejected({ additional: [{ id: "team", path: "/srv/team", url: "https://git.corp.example/a/b" }] }, "linux")).toContain("url or path, not both");
    expect(await rejected({ additional: [{ id: "team", path: "/srv/team", ref: "main" }] }, "linux")).toContain("no branch or tag");
    expect(await rejected({ additional: [{ id: "team", path: "/srv/team", auth: "ssh" }] }, "linux")).toContain("no sign-in");
    expect(await rejected({ additional: [{ id: "team", path: "~/market" }] }, "linux")).toContain("~ names no home");
    expect(await rejected({ additional: [{ id: "team", path: "market" }] }, "linux")).toContain("additional[0].path");
  });

  it("refuses an additional folder under allowLocalSources: false, blocked by its own lists, or nested in another", async () => {
    expect(await rejected({ allowLocalSources: false, additional: [{ id: "team", path: "/srv/team" }] }, "linux")).toContain("allowLocalSources is false");
    expect(await rejected({ block: ["path:/srv/*"], additional: [{ id: "team", path: "/srv/team" }] }, "linux")).toContain("blocked by this policy's own allow/block lists");
    const nested = await rejected({ additional: [{ id: "outer", path: "/srv/team" }, { id: "inner", path: "/srv/team/market" }] }, "linux");
    expect(nested).toContain("lies inside the folder of outer");
    expect(await rejected({ additional: [{ id: "alpha", path: "/srv/team/market" }, { id: "beta", path: "/srv/team" }] }, "linux")).toContain("folder of alpha");
    // Siblings that share a prefix are not nested.
    expect((await loaded({ additional: [{ id: "alpha", path: "/srv/team" }, { id: "beta", path: "/srv/teams" }] }, "linux")).additional).toHaveLength(2);
  });
});
