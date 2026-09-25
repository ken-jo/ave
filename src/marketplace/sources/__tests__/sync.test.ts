import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFixtureRepo,
  type FixtureRepo,
  type GitHttpServer,
  removeFixtureRepo,
  startGitHttpServer,
} from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { MarketplaceError } from "../../errors.js";
import { NetworkGate } from "../../net/network-gate.js";
import { normalizeSourceUrl, parseSourcePattern } from "../../net/source-url.js";
import type { OfficialMarketplace } from "../official.js";
import { policyLoad as policyWith } from "../../__tests__/fixtures/policy.js";
import type { PolicyLoad } from "../policy.js";
import { SourceRegistry } from "../registry.js";
import { SourceSyncer, shouldSyncSource, type SyncResult } from "../sync.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const AT = "2026-09-23T00:00:00.000Z";
const OTHER_COMMIT = "c".repeat(40);

const skill = (name: string, version = "1.0.0", patch: Record<string, unknown> = {}) =>
  `${JSON.stringify({ schemaVersion: 1, kind: "skill", name, version, minAppVersion: "0.12.0", payload: { entry: "SKILL.md" }, ...patch })}\n`;

const index = (name: string, packages: unknown[]) =>
  `${JSON.stringify({ schemaVersion: 1, name, displayName: `${name} market`, packages })}\n`;

const revocations = (entries: unknown[]) => `${JSON.stringify({ schemaVersion: 1, revocations: entries })}\n`;

function workGit(repo: FixtureRepo, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo.work,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    encoding: "utf8",
  }).trim();
}

/** Replace the served history: reset the working clone to `base`, commit `files`, force-push. */
function rewrite(repo: FixtureRepo, base: string, files: Record<string, string>): string {
  workGit(repo, ["reset", "--quiet", "--hard", base]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.work, path)), { recursive: true });
    writeFileSync(join(repo.work, path), content);
  }
  workGit(repo, ["add", "--all"]);
  workGit(repo, ["commit", "--quiet", "-m", "rewritten"]);
  repo.forcePush();
  return workGit(repo, ["rev-parse", "HEAD"]);
}

function expectFailed(result: SyncResult, code: string): void {
  expect(result).toMatchObject({ status: "failed", code });
}

describe("SourceSyncer", () => {
  let serverRoot: string;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let root: string;
  let repos: FixtureRepo[] = [];
  let counter = 0;

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-sync-served-"));
    server = await startGitHttpServer({ root: serverRoot });
    git = await createTestGitRunner();
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    await cleanupTmpDir(serverRoot);
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-sync-root-"));
  });

  afterEach(async () => {
    for (const repo of repos) await removeFixtureRepo(repo);
    repos = [];
    await cleanupTmpDir(root);
  });

  function fixture(): { repo: FixtureRepo; name: string } {
    counter += 1;
    const name = `market-${counter}`;
    const repo = createFixtureRepo(serverRoot, name);
    repos.push(repo);
    return { repo, name };
  }

  async function setup(options: { policy?: PolicyLoad; official?: OfficialMarketplace; retained?: string[] } = {}) {
    const policy = options.policy ?? policyWith({});
    const registry = await SourceRegistry.open({ root, policy, ...(options.official ? { official: options.official } : {}) });
    const changed: string[] = [];
    const syncer = new SourceSyncer({
      registry,
      gate: new NetworkGate({ policy, allowLoopback: true }),
      runner: git.runner,
      root,
      now: () => new Date(AT),
      retainedCommits: async () => new Set(options.retained ?? []),
      onCatalogChanged: (id) => changed.push(id),
    });
    return { registry, syncer, changed };
  }

  function snapshotFiles(id: string): string[] {
    const dir = join(root, id, "snapshots");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  it("publishes the first snapshot of a custom source, reading unversioned packages from their descriptors", async () => {
    const { repo, name } = fixture();
    const commit = repo.commit(
      {
        "marketplace.json": index("acme", [
          { kind: "skill", name: "alpha", path: "skills/alpha", keywords: ["docs"] },
          {
            kind: "skill",
            name: "beta",
            path: "skills/beta",
            latest: "2.0.0",
            versions: [{ version: "2.0.0", commit: OTHER_COMMIT, minAppVersion: "0.12.0", publishedAt: AT }],
          },
          { kind: "skill", name: "gamma", path: "skills/gamma" },
          { kind: "skill", name: "delta", path: "skills/delta" },
          { kind: "skill", name: "huge", path: "skills/huge" },
        ]),
        "skills/alpha/ave-package.json": skill("alpha", "1.1.0", { icon: "icon.png" }),
        "skills/gamma/ave-package.json": skill("not-gamma"),
        "skills/huge/ave-package.json": " ".repeat(300 * 1024),
      },
      "first",
    );
    const { registry, syncer, changed } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });

    expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: commit, changed: true });
    expect(changed).toEqual(["acme"]);
    expect(await registry.readState("acme")).toEqual({ pinnedCommit: commit, enabled: true, lastSync: { at: AT, result: "ok" } });

    const snapshot = (await syncer.readSnapshot("acme"))!;
    expect(snapshot).toMatchObject({ sourceId: "acme", commit, fetchedAt: AT, marketplace: { name: "acme", displayName: "acme market" } });
    expect(snapshot.packages.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    const alpha = snapshot.packages[0]!;
    expect(alpha).toMatchObject({ path: "skills/alpha", icon: "skills/alpha/icon.png", keywords: ["docs"], latest: "1.1.0" });
    expect(alpha.versions).toEqual([{ version: "1.1.0", commit, minAppVersion: "0.12.0", publishedAt: expect.any(String) }]);
    expect(snapshot.packages[1]!.versions[0]!.commit).toBe(OTHER_COMMIT);
    expect(snapshot.diagnostics.map((item) => item.subject)).toEqual(["skill/gamma", "skill/delta", "skill/huge"]);
    expect(snapshot.diagnostics[0]!.message).toContain("index lists skill/gamma");
    expect(snapshot.diagnostics[1]!.message).toContain("is missing");
    expect(snapshot.diagnostics[2]!.message).toContain("is larger than 262144 bytes");
  });

  it("fast-forwards a pin that is far behind and prunes all but the pin, the previous pin and retained commits", async () => {
    const { repo, name } = fixture();
    const files = (version: string) => ({ "marketplace.json": index("acme", [{ kind: "skill", name: "alpha", path: "skills/alpha" }]), "skills/alpha/ave-package.json": skill("alpha", version) });
    const first = repo.commit(files("1.0.0"), "v1");
    const { registry, syncer } = await setup({ retained: [first] });
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");

    let second = "";
    for (let step = 2; step <= 6; step++) second = repo.commit(files(`1.${step}.0`), `v${step}`);
    expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: second, changed: true });
    const third = repo.commit(files("2.0.0"), "v2");
    expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: third, changed: true });

    expect(snapshotFiles("acme")).toEqual([`${first}.json`, `${second}.json`, `${third}.json`].sort());
    expect((await syncer.readSnapshot("acme"))!.packages[0]!.latest).toBe("2.0.0");

    // One more move: the old previous pin goes, the retained first commit stays.
    const fourth = repo.commit(files("2.1.0"), "v2.1");
    await syncer.sync("acme");
    expect(snapshotFiles("acme")).toEqual([`${first}.json`, `${third}.json`, `${fourth}.json`].sort());
  });

  it("re-proves ancestry from a fresh fetch when the local repository is lost", async () => {
    const { repo, name } = fixture();
    const base = repo.commit({ "marketplace.json": index("acme", []) }, "base");
    repo.commit({ "README.md": "v2\n" }, "second");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");

    // The full-history fetch brings the pinned commit back when the candidate descends from it.
    await cleanupTmpDir(join(root, "acme", "repo.git"));
    const moved = repo.commit({ "README.md": "v3\n" }, "third");
    expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: moved, changed: true });

    // When it does not, the pinned object stays missing and the move is held for review.
    await cleanupTmpDir(join(root, "acme", "repo.git"));
    const rewritten = rewrite(repo, base, { "README.md": "other\n" });
    expectFailed(await syncer.sync("acme"), "SOURCE_HISTORY_REWRITTEN");
    expect(await registry.readState("acme")).toMatchObject({ pinnedCommit: moved, pendingRewrite: { candidate: rewritten } });
  });

  it("refuses to treat a source with synced data but no state file as fresh", async () => {
    const { repo, name } = fixture();
    repo.commit({ "marketplace.json": index("acme", []) }, "first");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");
    rmSync(join(root, "acme", "state.json"));
    await expect(syncer.sync("acme")).rejects.toThrow("state.json is missing");
  });

  it("lets a running sync finish before its source is removed", async () => {
    const { repo, name } = fixture();
    repo.commit({ "marketplace.json": index("acme", []) }, "first");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    const order: string[] = [];
    const syncing = syncer.sync("acme").then((result) => {
      order.push("sync");
      return result;
    });
    const removing = syncer.removeSource("acme").then(() => order.push("remove"));
    const [result] = await Promise.all([syncing, removing]);
    expect(result.status).toBe("ok");
    expect(order).toEqual(["sync", "remove"]);
    expect(registry.get("acme")).toBeUndefined();
    expect(existsSync(join(root, "acme"))).toBe(false);
  });

  it("still syncs a hidden source, but refuses installs and updates from it with SOURCE_DISABLED", async () => {
    const { repo, name } = fixture();
    repo.commit({ "marketplace.json": index("acme", []) }, "first");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await registry.setEnabled("acme", false);
    expect((await syncer.sync("acme")).status).toBe("ok");
    await expect(syncer.withRepository("acme", async () => "read")).rejects.toMatchObject({ code: "SOURCE_DISABLED" });
    await registry.setEnabled("acme", true);
    await expect(syncer.withRepository("acme", async () => "read")).resolves.toBe("read");
  });

  it("reports no change when the ref has not moved, and rebuilds a lost snapshot at the same pin", async () => {
    const { repo, name } = fixture();
    const commit = repo.commit({ "marketplace.json": index("acme", []) }, "empty");
    const { registry, syncer, changed } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");
    expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: commit, changed: false });

    rmSync(join(root, "acme", "snapshots", `${commit}.json`));
    expect(await syncer.readSnapshot("acme")).toBeNull();
    expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: commit, changed: false });
    expect((await syncer.readSnapshot("acme"))!.commit).toBe(commit);
    expect(changed).toEqual(["acme"]);
  });

  it("refuses rewritten history on a managed source and keeps the pin", async () => {
    const { repo, name } = fixture();
    const base = repo.commit({ "marketplace.json": index("corp", []) }, "base");
    const pinned = repo.commit({ "README.md": "v2\n" }, "second");
    const policy = policyWith({
      additional: [{ id: "corp", url: normalizeSourceUrl(server.url(name)), auth: { kind: "none" } }],
    });
    const { registry, syncer } = await setup({ policy });
    expect(await syncer.sync("corp")).toMatchObject({ status: "ok", pinnedCommit: pinned });

    const rewritten = rewrite(repo, base, { "README.md": "other\n" });
    expectFailed(await syncer.sync("corp"), "SOURCE_HISTORY_REWRITTEN");
    expect(await registry.readState("corp")).toEqual({
      pinnedCommit: pinned,
      enabled: true,
      lastSync: { at: AT, result: "SOURCE_HISTORY_REWRITTEN", candidate: rewritten },
    });
    await expect(syncer.acceptRewrite("corp", rewritten)).rejects.toThrow("never accepts rewritten history");
  });

  it("holds rewritten history of a custom source for review, and moves the pin only when the reviewed commit is accepted", async () => {
    const { repo, name } = fixture();
    const base = repo.commit({ "marketplace.json": index("acme", []) }, "base");
    const pinned = repo.commit({ "README.md": "v2\n" }, "second");
    const { registry, syncer, changed } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");

    const rewritten = rewrite(repo, base, { "README.md": "other\n" });
    expectFailed(await syncer.sync("acme"), "SOURCE_HISTORY_REWRITTEN");
    expect((await registry.readState("acme")).pendingRewrite).toEqual({ candidate: rewritten, seenAt: AT });
    expect((await registry.readState("acme")).pinnedCommit).toBe(pinned);

    await expect(syncer.acceptRewrite("acme", OTHER_COMMIT)).rejects.toSatisfy(
      (error: unknown) => error instanceof MarketplaceError && error.code === "PLAN_EXPIRED",
    );

    // A sync that sees another rewrite in between expires the reviewed one.
    const rewrittenAgain = rewrite(repo, base, { "README.md": "again\n" });
    expectFailed(await syncer.sync("acme"), "SOURCE_HISTORY_REWRITTEN");
    await expect(syncer.acceptRewrite("acme", rewritten)).rejects.toSatisfy(
      (error: unknown) => error instanceof MarketplaceError && error.code === "PLAN_EXPIRED",
    );
    expect(await syncer.acceptRewrite("acme", rewrittenAgain)).toEqual({ status: "ok", pinnedCommit: rewrittenAgain, changed: true });
    const state = await registry.readState("acme");
    expect(state.pendingRewrite).toBeUndefined();
    expect(state.pinnedCommit).toBe(rewrittenAgain);
    expect(changed).toEqual(["acme", "acme"]);
  });

  it("keeps the pin when the candidate's index or revocations are invalid", async () => {
    const { repo, name } = fixture();
    const good = repo.commit({ "marketplace.json": index("acme", []) }, "good");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");

    const brokenIndex = repo.commit({ "marketplace.json": '{"schemaVersion":1,"schemaVersion":1}' }, "broken index");
    expectFailed(await syncer.sync("acme"), "SOURCE_INDEX_INVALID");
    expect(await registry.readState("acme")).toMatchObject({ pinnedCommit: good, lastSync: { result: "SOURCE_INDEX_INVALID", candidate: brokenIndex } });

    repo.commit({ "marketplace.json": index("acme", []), "policy/revocations.json": revocations([{ kind: "skill", name: "alpha" }]) }, "broken revocations");
    expectFailed(await syncer.sync("acme"), "SOURCE_INDEX_INVALID");
    expect((await registry.readState("acme")).pinnedCommit).toBe(good);
    expect((await syncer.readSnapshot("acme"))!.commit).toBe(good);

    const fixed = repo.commit(
      {
        "policy/revocations.json": revocations([
          { kind: "skill", name: "alpha", versions: ">=1.0.0 <1.2.0", reason: "leaks tokens", at: AT, action: "disable" },
        ]),
      },
      "fixed revocations",
    );
    expect(await syncer.sync("acme")).toMatchObject({ status: "ok", pinnedCommit: fixed });
    expect((await syncer.readSnapshot("acme"))!.revocations).toHaveLength(1);
  });

  it("names the official index after the official id", async () => {
    const { repo, name } = fixture();
    repo.commit({ "marketplace.json": index("acme", []) }, "wrong name");
    const official: OfficialMarketplace = { id: "ave", url: server.url(name), mirrors: [], auth: { kind: "none" } };
    const { syncer } = await setup({ official });
    expectFailed(await syncer.sync("ave"), "SOURCE_INDEX_INVALID");
  });

  it("takes the candidate from a mirror when the primary is unreachable, under the same history rule", async () => {
    const { repo, name } = fixture();
    const base = repo.commit({ "marketplace.json": index("ave", []) }, "base");
    const commit = repo.commit({ "README.md": "v2\n" }, "official");
    const official: OfficialMarketplace = { id: "ave", url: server.url("no-such-repo"), mirrors: [server.url(name)], auth: { kind: "none" } };
    const { registry, syncer } = await setup({ official });
    expect(await syncer.sync("ave")).toEqual({ status: "ok", pinnedCommit: commit, changed: true });

    const unreachable: OfficialMarketplace = { ...official, mirrors: [server.url("also-missing")] };
    const { syncer: offline } = await setup({ official: unreachable });
    expectFailed(await offline.sync("ave"), "SOURCE_UNREACHABLE");
    expect((await registry.readState("ave")).pinnedCommit).toBe(commit);
    // Offline: the last good snapshot is still served.
    expect((await offline.readSnapshot("ave"))!.commit).toBe(commit);

    // A candidate from the mirror meets the same history rule as one from the primary.
    rewrite(repo, base, { "README.md": "forked\n" });
    expectFailed(await syncer.sync("ave"), "SOURCE_HISTORY_REWRITTEN");
    expect((await registry.readState("ave")).pinnedCommit).toBe(commit);
  });

  it("reports a host that goes down while an accepted rewrite fetches its files as the sync's result", async () => {
    const { repo, name } = fixture();
    const base = repo.commit({ "marketplace.json": index("acme", []) }, "base");
    const pinned = repo.commit({ "README.md": "v2\n" }, "second");
    const second = await startGitHttpServer({ root: serverRoot });
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: second.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");
    const rewritten = rewrite(repo, base, { "marketplace.json": index("acme", [{ kind: "skill", name: "alpha", path: "skills/alpha" }]) });
    expectFailed(await syncer.sync("acme"), "SOURCE_HISTORY_REWRITTEN");
    await second.close();

    // The candidate's commits are local; its blobs are not.
    expectFailed(await syncer.acceptRewrite("acme", rewritten), "SOURCE_UNREACHABLE");
    expect(await registry.readState("acme")).toMatchObject({
      pinnedCommit: pinned,
      pendingRewrite: { candidate: rewritten },
      lastSync: { result: "SOURCE_UNREACHABLE", candidate: rewritten },
    });
  });

  it("serves the last snapshot while the host is down", async () => {
    const { repo, name } = fixture();
    const commit = repo.commit({ "marketplace.json": index("acme", []) }, "first");
    const second = await startGitHttpServer({ root: serverRoot });
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: second.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");
    await second.close();

    expectFailed(await syncer.sync("acme"), "SOURCE_UNREACHABLE");
    expect((await syncer.readSnapshot("acme"))!.commit).toBe(commit);
    expect(await registry.readState("acme")).toMatchObject({ pinnedCommit: commit, lastSync: { result: "SOURCE_UNREACHABLE" } });
  });

  it("does not contact a source the managed policy blocks", async () => {
    const { repo, name } = fixture();
    repo.commit({ "marketplace.json": index("acme", []) }, "first");
    const url = server.url(name);
    const { registry } = await setup();
    await registry.add({ id: "acme", origin: "custom", url, auth: { kind: "none" } });
    const { syncer } = await setup({ policy: policyWith({ block: [parseSourcePattern(url)] }) });
    const before = server.seen.length;
    expectFailed(await syncer.sync("acme"), "SOURCE_POLICY_BLOCKED");
    expect(server.seen.length).toBe(before);
    expect(existsSync(join(root, "acme", "snapshots"))).toBe(false);
  });

  it("reads the conventional layout when there is no index", async () => {
    const { repo, name } = fixture();
    repo.commit({ "README.md": "start\n" }, "start");
    // Tree entries, not files: Windows cannot create `odd:name` on disk.
    const commit = repo.commitEntries(
      Object.entries({
        "skills/alpha/ave-package.json": skill("alpha"),
        "skills/alpha/SKILL.md": "# alpha\n",
        "plugins/wrong/ave-package.json": skill("wrong"),
        "skills/deep/nested/ave-package.json": skill("nested"),
        "skills/one/ave-package.json": skill("twin"),
        "skills/two/ave-package.json": skill("twin"),
        "skills/odd:name/ave-package.json": skill("odd"),
      }).map(([path, content]) => ({ path, mode: "100644", content })),
      "layout",
    );
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" }, label: "Acme tools" });
    expect(await syncer.sync("acme")).toMatchObject({ status: "ok", pinnedCommit: commit });
    const snapshot = (await syncer.readSnapshot("acme"))!;
    expect(snapshot.marketplace).toEqual({ name: "acme", displayName: "Acme tools" });
    expect(snapshot.packages.map((entry) => `${entry.path}:${entry.name}`)).toEqual(["skills/alpha:alpha"]);
    expect(snapshot.diagnostics.map((item) => item.message)).toEqual([
      'invalid repository path: "skills/odd:name"',
      "declares kind skill inside plugins/",
      "more than one package declares this kind and name",
      "more than one package declares this kind and name",
    ]);
  });

  it("refuses a repository that is neither a marketplace nor a package", async () => {
    const { repo, name } = fixture();
    repo.commit({ "README.md": "hello\n" }, "readme");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    expectFailed(await syncer.sync("acme"), "SOURCE_NOT_A_MARKETPLACE");
    expect((await registry.readState("acme")).pinnedCommit).toBeNull();
  });

  it("reads a direct source's one descriptor at its subdir", async () => {
    const { repo, name } = fixture();
    const commit = repo.commit({ "tools/alpha/ave-package.json": skill("alpha", "0.3.0", { displayName: "Alpha" }) }, "direct");
    const { registry, syncer } = await setup();
    await registry.add({ id: "alpha-src", origin: "direct", url: server.url(name), subdir: "tools/alpha", auth: { kind: "none" } });
    await registry.add({ id: "beta-src", origin: "direct", url: server.url(name), subdir: "tools/beta", auth: { kind: "none" } });

    expect(await syncer.sync("alpha-src")).toMatchObject({ status: "ok", pinnedCommit: commit });
    const snapshot = (await syncer.readSnapshot("alpha-src"))!;
    expect(snapshot.marketplace).toEqual({ name: "alpha-src", displayName: "Alpha" });
    expect(snapshot.packages).toMatchObject([{ kind: "skill", name: "alpha", path: "tools/alpha", latest: "0.3.0" }]);
    expectFailed(await syncer.sync("beta-src"), "SOURCE_NOT_A_MARKETPLACE");
  });

  it("synthesizes a direct package from the first of plugin.json, SKILL.md, AGENTS.md and server.json (design §8.2)", async () => {
    const { repo, name } = fixture();
    const manifest = {
      name: "tree-tool",
      version: "1.2.0",
      description: "Tools from a built tree",
      extensions: { "ai.agent-connector.ave": { capabilities: ["host:overlay"], requires: { minAppVersion: "0.10.0" } } },
    };
    const commit = repo.commit(
      {
        "plugins/tree-tool/plugin.json": `${JSON.stringify(manifest)}\n`,
        "plugins/tree-tool/SKILL.md": "---\nname: ignored\n---\nplugin.json comes first\n",
        "skills/proofread/SKILL.md": "---\nname: proofread\ndescription: Checks Korean spelling\n---\nRead the text.\n",
        "skills/versioned/SKILL.md": "---\nname: versioned\nversion: 2.0.1\n---\nBody\n",
        "skills/versioned/ave-package.json": skill("versioned", "3.0.0"),
        "agents/release-captain/AGENTS.md": "# Release captain\n",
        "mcp/weather/server.json": `${JSON.stringify({ name: "io.github.example/weather", version: "0.5.0", description: "Weather", packages: [] })}\n`,
      },
      "direct files",
    );
    const { registry, syncer } = await setup();
    const add = (id: string, subdir: string) => registry.add({ id, origin: "direct", url: server.url(name), subdir, auth: { kind: "none" } });
    await add("tree-src", "plugins/tree-tool");
    await add("skill-src", "skills/proofread");
    await add("versioned-src", "skills/versioned");
    await add("agent-src", "agents/release-captain");
    await add("mcp-src", "mcp/weather");

    const only = async (id: string) => {
      expect(await syncer.sync(id)).toMatchObject({ status: "ok", pinnedCommit: commit });
      return (await syncer.readSnapshot(id))!.packages[0]!;
    };
    expect(await only("tree-src")).toMatchObject({
      kind: "plugin",
      name: "tree-tool",
      description: "Tools from a built tree",
      versions: [{ version: "1.2.0", minAppVersion: "0.10.0", artifact: { tree: "plugins/tree-tool" }, authority: manifest.extensions["ai.agent-connector.ave"] }],
    });
    expect(await only("skill-src")).toMatchObject({
      kind: "skill",
      name: "proofread",
      description: "Checks Korean spelling",
      versions: [{ version: `0.0.0+g${commit.slice(0, 12)}`, minAppVersion: "0.0.0" }],
    });
    // A descriptor beside SKILL.md is used as is.
    expect(await only("versioned-src")).toMatchObject({ kind: "skill", name: "versioned", latest: "3.0.0" });
    // AGENTS.md without front matter: the folder names the package.
    expect(await only("agent-src")).toMatchObject({ kind: "agent", name: "release-captain" });
    expect(await only("mcp-src")).toMatchObject({ kind: "mcp", name: "weather", latest: "0.5.0" });
  });

  it("synthesizes a plugin at a direct source's root with the default tree rung, and refuses one without minAppVersion", async () => {
    const good = fixture();
    const extensions = { "ai.agent-connector.ave": { capabilities: [], requires: { minAppVersion: "0.10.0" } } };
    good.repo.commit({ "plugin.json": `${JSON.stringify({ name: "root-tool", version: "0.1.0", extensions })}\n` }, "root");
    const bad = fixture();
    bad.repo.commit({ "plugin.json": `${JSON.stringify({ name: "loose", version: "0.1.0", extensions: { "ai.agent-connector.ave": { capabilities: [] } } })}\n` }, "root");
    const { registry, syncer } = await setup();
    await registry.add({ id: "good-src", origin: "direct", url: server.url(good.name), auth: { kind: "none" } });
    await registry.add({ id: "bad-src", origin: "direct", url: server.url(bad.name), auth: { kind: "none" } });

    expect(await syncer.sync("good-src")).toMatchObject({ status: "ok" });
    expect((await syncer.readSnapshot("good-src"))!.packages).toMatchObject([{ kind: "plugin", name: "root-tool", path: "", versions: [{ artifact: {} }] }]);
    expectFailed(await syncer.sync("bad-src"), "PACKAGE_COMPAT_UNDECLARED");
  });

  it("joins a sync that is already running for the same source", async () => {
    const { repo, name } = fixture();
    repo.commit({ "marketplace.json": index("acme", []) }, "first");
    const { registry, syncer, changed } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    const [a, b] = await Promise.all([syncer.sync("acme"), syncer.sync("acme")]);
    expect(a).toBe(b);
    expect(changed).toEqual(["acme"]);
  });

  it("keeps a joined sync running when one caller aborts, and stops it when every caller has", async () => {
    const { repo, name } = fixture();
    const commit = repo.commit({ "marketplace.json": index("acme", []) }, "first");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    const a = new AbortController();
    const b = new AbortController();
    const first = syncer.sync("acme", a.signal);
    const second = syncer.sync("acme", b.signal);
    a.abort(new Error("first caller gave up"));
    expect(await second).toEqual({ status: "ok", pinnedCommit: commit, changed: true });
    expect(await first).toBe(await second);

    const c = new AbortController();
    const lone = syncer.sync("acme", c.signal);
    c.abort(new Error("the only caller gave up"));
    // A caller arriving while the abandoned run winds down gets a run of its own.
    const late = syncer.sync("acme");
    await expect(lone).rejects.toThrow("the only caller gave up");
    expect(await late).toEqual({ status: "ok", pinnedCommit: commit, changed: false });
  });

  it("syncs a hidden source while an installed package is bound to it", async () => {
    const { registry } = await setup(policyWithDisabling());
    const official = registry.get("ave")!;
    const hidden = { pinnedCommit: null, enabled: false };
    expect(shouldSyncSource(registry, official, hidden, false)).toBe(false);
    expect(shouldSyncSource(registry, official, hidden, true)).toBe(true);
    expect(shouldSyncSource(registry, official, { ...hidden, enabled: true }, false)).toBe(true);

    function policyWithDisabling() {
      return { policy: policyWith({ allowDisablingOfficial: true }) };
    }
  });
});
