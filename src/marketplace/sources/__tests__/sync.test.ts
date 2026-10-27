import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promises as dnsPromises } from "node:dns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyFixtureRepo,
  createFixtureRepo,
  type FixtureRepo,
  type GitHttpServer,
  removeFixtureRepo,
  startGitHttpServer,
} from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { cachedFixtureGit } from "../../__tests__/fixtures/cached-git.js";
import { aggregateCatalog, versionExclusions } from "../../catalog/aggregate.js";
import { MarketplaceError } from "../../errors.js";
import { NetworkGate } from "../../net/network-gate.js";
import { createPinnedFetch } from "../../net/pinned-fetch.js";
import { normalizeSourceUrl, parseSourcePattern } from "../../net/source-url.js";
import type { OfficialMarketplace } from "../official.js";
import { FIXTURE_POLICY_PATH, policyLoad as policyWith, policySource } from "../../__tests__/fixtures/policy.js";
import type { PolicyLoad } from "../policy.js";
import { SourceRegistry } from "../registry.js";
import { SourceSyncer, shouldSyncSource, type SyncResult } from "../sync.js";
import { sourceStatus } from "../../app/views.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { gitFixtureEnv } from "../../../__tests__/support/git-fixture-env.mjs";
import { nodeFolders } from "../../__tests__/fixtures/folder-fs.js";

const AT = "2026-09-23T00:00:00.000Z";
const OTHER_COMMIT = "c".repeat(40);

const skill = (name: string, version = "1.0.0", patch: Record<string, unknown> = {}) =>
  `${JSON.stringify({ schemaVersion: 2, kind: "skill", name, version, minAppVersion: "0.12.0", payload: { entry: "SKILL.md" }, ...patch })}\n`;

const index = (name: string, packages: unknown[]) =>
  `${JSON.stringify({ schemaVersion: 2, name, displayName: `${name} market`, packages })}\n`;

const revocations = (entries: unknown[]) => `${JSON.stringify({ schemaVersion: 1, revocations: entries })}\n`;

function workGit(repo: FixtureRepo, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo.work,
    env: { ...gitFixtureEnv(repo.work), LC_ALL: "C" },
    encoding: "utf8",
  }).trim();
}

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

function fixtureContents(path: string): string {
  const stat = lstatSync(path);
  if (stat.isDirectory()) return JSON.stringify([stat.mode, readdirSync(path).sort().map((name) => [name, fixtureContents(join(path, name))])]);
  if (!stat.isFile()) throw new Error("fixture contains a non-file entry");
  return JSON.stringify([stat.mode, readFileSync(path).toString("base64")]);
}

describe("SourceSyncer", () => {
  let serverRoot: string;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let fixtureGit: ReturnType<typeof cachedFixtureGit>;
  let emptyRepo: FixtureRepo;
  let root: string;
  let repos: FixtureRepo[] = [];
  let counter = 0;
  const initialPublications = new Map<string, { repo: FixtureRepo; commit: string }>();
  const seedRepos: FixtureRepo[] = [];
  let emptyContents: string;

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-sync-served-"));
    emptyRepo = createFixtureRepo(serverRoot, "empty-seed");
    emptyContents = JSON.stringify([fixtureContents(emptyRepo.bare), fixtureContents(emptyRepo.work)]);
    server = await startGitHttpServer({ root: serverRoot });
    git = await createTestGitRunner();
    fixtureGit = cachedFixtureGit(git.runner, serverRoot, server.origin, join(serverRoot, "command-cache"));
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    for (const seed of seedRepos) await removeFixtureRepo(seed);
    await removeFixtureRepo(emptyRepo);
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
    const repo = copyFixtureRepo(serverRoot, name, emptyRepo, { publishByCopy: true });
    repos.push(repo);
    const commit = repo.commit.bind(repo);
    let initial = true;
    // Only the untouched copy's first publication is shared; later history stays private.
    repo.commit = (files, message) => {
      if (!initial) return commit(files, message);
      if (JSON.stringify([fixtureContents(repo.bare), fixtureContents(repo.work)]) !== emptyContents) {
        throw new Error("initial publication requires an untouched fixture");
      }
      const key = JSON.stringify([files, message]);
      const prepared = initialPublications.get(key);
      if (prepared) {
        cpSync(prepared.repo.bare, repo.bare, { recursive: true });
        cpSync(prepared.repo.work, repo.work, { recursive: true, filter: (path) => path !== join(prepared.repo.work, ".git", "config") });
        initial = false;
        return prepared.commit;
      }
      const head = commit(files, message);
      const seed = copyFixtureRepo(serverRoot, `seed-${++counter}`, repo, { publishByCopy: true });
      seedRepos.push(seed);
      initialPublications.set(key, { repo: seed, commit: head });
      initial = false;
      return head;
    };
    return { repo, name };
  }

  async function setup(options: { policy?: PolicyLoad; official?: OfficialMarketplace; retained?: string[]; runner?: typeof fixtureGit } = {}) {
    const policy = policySource(options.policy ?? policyWith({}));
    const registry = await SourceRegistry.open({ root, policy, ...(options.official ? { official: options.official } : {}) });
    const changed: string[] = [];
    const syncer = new SourceSyncer({
      folders: nodeFolders(),
      registry,
      gate: new NetworkGate({ policy, allowLoopback: true, transport: createPinnedFetch() }),
      runner: options.runner ?? fixtureGit,
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

  it("refuses an initial publication over independently changed repository metadata", () => {
    const files = { "marketplace.json": index("acme", []) };
    fixture().repo.commit(files, "base");
    const { repo } = fixture();
    const ref = join(repo.work, ".git", "refs", "heads", "main");
    writeFileSync(ref, OTHER_COMMIT);
    expect(() => repo.commit(files, "base")).toThrow("initial publication requires an untouched fixture");
    expect(readFileSync(ref, "utf8")).toBe(OTHER_COMMIT);
  });

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
    const { registry, syncer, changed } = await setup({ runner: git.runner });
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

    const fourth = repo.commit(files("2.1.0"), "v2.1");
    await syncer.sync("acme");
    expect(snapshotFiles("acme")).toEqual([`${first}.json`, `${third}.json`, `${fourth}.json`].sort());
  });

  it("re-proves ancestry from a fresh fetch when the local repository is lost", async () => {
    const { repo, name } = fixture();
    const base = repo.commit({ "marketplace.json": index("acme", []) }, "base");
    repo.commit({ "README.md": "v2\n" }, "second");
    const { registry, syncer } = await setup({ runner: git.runner });
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");

    await cleanupTmpDir(join(root, "acme", "repo.git"));
    const moved = repo.commit({ "README.md": "v3\n" }, "third");
    expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: moved, changed: true });

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
    await expect(syncer.sync("acme")).rejects.toMatchObject({
      code: "SOURCE_LOCAL_DATA_DAMAGED",
      message: "state.json of source acme is missing while its synced data remains",
      detail: { reason: "state-missing", sourceId: "acme" },
    });
  });

  it("resets a damaged source's downloaded copy without following a link, then syncs it from scratch", async () => {
    const { repo, name } = fixture();
    const first = repo.commit({ "marketplace.json": index("acme", []) }, "first");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");
    rmSync(join(root, "acme", "state.json"));
    const outside = mkdtempSync(join(tmpdir(), "ave-sync-outside-"));
    try {
      writeFileSync(join(outside, "canary"), "kept\n");
      symlinkSync(outside, join(root, "acme", "linked"), process.platform === "win32" ? "junction" : "dir");
      // A file link needs a privilege on Windows; a junction does not.
      if (process.platform !== "win32") symlinkSync(join(outside, "canary"), join(root, "acme", "snapshots", "file-link"));

      await syncer.resetLocalData("acme");
      expect(existsSync(join(root, "acme"))).toBe(false);
      expect(readdirSync(root).filter((entry) => entry.startsWith(".trash-"))).toEqual([]);
      expect(readdirSync(outside)).toEqual(["canary"]);
      expect(readFileSync(join(outside, "canary"), "utf8")).toBe("kept\n");
      expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: first, changed: true });
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("names an unreadable state file as damaged, by its error code and not its path", async () => {
    const { repo, name } = fixture();
    repo.commit({ "marketplace.json": index("acme", []) }, "first");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");
    chmodSync(join(root, "acme", "state.json"), 0o000);
    await expect(registry.readState("acme")).rejects.toMatchObject({
      code: "SOURCE_LOCAL_DATA_DAMAGED",
      message: "state.json of source acme cannot be read (EACCES)",
      detail: { reason: "state-unreadable", sourceId: "acme" },
    });
    await syncer.resetLocalData("acme");
    expect(await registry.readState("acme")).toEqual({ pinnedCommit: null, enabled: true });
  });

  async function damagedSnapshot() {
    const { repo, name } = fixture();
    const base = repo.commit({ "marketplace.json": index("acme", []) }, "base");
    const pinned = repo.commit({ "README.md": "v2\n" }, "second");
    const context = await setup({ runner: git.runner });
    await context.registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    expect(await context.syncer.sync("acme")).toMatchObject({ status: "ok", pinnedCommit: pinned });
    writeFileSync(join(root, "acme", "snapshots", `${pinned}.json`), "{ not json");
    return { ...context, repo, base, pinned };
  }

  const trashLeft = () => readdirSync(root).filter((name) => name.startsWith(".trash-"));

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("names an unreadable snapshot apart from an unreadable state, since Repair keeps that pin", async () => {
    const { syncer, registry, pinned } = await damagedSnapshot();
    writeFileSync(join(root, "acme", "snapshots", `${pinned}.json`), "{}");
    chmodSync(join(root, "acme", "snapshots", `${pinned}.json`), 0o000);
    await expect(syncer.readSnapshot("acme")).rejects.toMatchObject({
      code: "SOURCE_LOCAL_DATA_DAMAGED",
      message: `snapshot ${pinned}.json of source acme cannot be read (EACCES)`,
      detail: { reason: "snapshot-unreadable", sourceId: "acme" },
    });
    await syncer.resetLocalData("acme");
    expect(await registry.readState("acme")).toEqual({ pinnedCommit: pinned, enabled: true });
  });

  it("keeps the pin and the damage when writing the kept pin back fails, and says it was the write", async () => {
    const { syncer, registry, repo, base, pinned } = await damagedSnapshot();
    const before = await registry.readState("acme");
    vi.spyOn(registry, "writeState").mockRejectedValueOnce(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));

    await expect(syncer.resetLocalData("acme")).rejects.toMatchObject({
      code: "SOURCE_LOCAL_DATA_DAMAGED",
      message: "could not write the kept pin of source acme (ENOSPC)",
      detail: { reason: "repair-write-failed", sourceId: "acme" },
    });
    expect(await registry.readState("acme")).toEqual(before);
    await expect(syncer.readSnapshot("acme")).rejects.toMatchObject({ detail: { reason: "snapshot-invalid" } });
    expect(existsSync(join(root, "acme", "repo.git", "HEAD"))).toBe(true);
    rewrite(repo, base, { "README.md": "other\n" });
    expectFailed(await syncer.sync("acme"), "SOURCE_HISTORY_REWRITTEN");
    expect((await registry.readState("acme")).pinnedCommit).toBe(pinned);
  });

  it("keeps the pin when a Repair stops right after moving the first entry aside, and a later Repair finishes", async () => {
    const { syncer, registry, repo, base, pinned } = await damagedSnapshot();
    const move = vi.spyOn(registry as unknown as { moveAside(from: string, to: string): Promise<void> }, "moveAside");
    move.mockImplementationOnce(async (from, to) => {
      await (await import("node:fs/promises")).rename(from, to);
      throw Object.assign(new Error("interrupted"), { code: "EINTR" });
    });

    await expect(syncer.resetLocalData("acme")).rejects.toMatchObject({ detail: { reason: "repair-failed", sourceId: "acme" } });
    expect(await registry.readState("acme")).toEqual({ pinnedCommit: pinned, enabled: true });
    move.mockRestore();
    await syncer.resetLocalData("acme");
    expect(trashLeft()).toEqual([]);
    rewrite(repo, base, { "README.md": "other\n" });
    expectFailed(await syncer.sync("acme"), "SOURCE_HISTORY_REWRITTEN");
    expect((await registry.readState("acme")).pinnedCommit).toBe(pinned);
  });

  it("walks a real repository's read-only git objects away when Repair moves the copy aside", async () => {
    const { syncer, registry, pinned } = await damagedSnapshot();
    const objects = join(root, "acme", "repo.git", "objects");
    const files = (readdirSync(objects, { recursive: true }) as string[]).map((name) => join(objects, name)).filter((path) => statSync(path).isFile());
    // Git object files carry the read-only attribute on Windows.
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((path) => (statSync(path).mode & 0o200) === 0).length).toBeGreaterThan(0);

    await syncer.resetLocalData("acme");
    expect(trashLeft()).toEqual([]);
    expect(readdirSync(join(root, "acme"))).toEqual(["state.json"]);
    expect(await registry.readState("acme")).toEqual({ pinnedCommit: pinned, enabled: true });
    expect(await syncer.sync("acme")).toMatchObject({ status: "ok", pinnedCommit: pinned });
  });

  it("moves a damaged copy aside before walking it, and sweeps what an interrupted walk left on the next open", async () => {
    const { syncer, registry, pinned } = await damagedSnapshot();
    mkdirSync(join(root, ".trash-acme-left"), { recursive: true });
    writeFileSync(join(root, ".trash-acme-left", "stale"), "x");
    await syncer.resetLocalData("acme");
    expect(trashLeft()).toEqual([]);
    expect(readdirSync(join(root, "acme"))).toEqual(["state.json"]);
    expect(await registry.readState("acme")).toEqual({ pinnedCommit: pinned, enabled: true });

    mkdirSync(join(root, ".trash-acme-crashed", "repo.git"), { recursive: true });
    await SourceRegistry.open({ root, policy: policySource(policyWith({})) });
    expect(trashLeft()).toEqual([]);
  });

  it("offers Repair, not network advice, when the source's own repository is half removed", async () => {
    const { repo, name } = fixture();
    repo.commit({ "marketplace.json": index("acme", []) }, "first");
    const { registry, syncer } = await setup({ runner: git.runner });
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    const first = await syncer.sync("acme");
    // Simulate missing objects without synchronous recursive removal of read-only Windows files.
    await cleanupTmpDir(join(root, "acme", "repo.git", "objects"));
    await cleanupTmpDir(join(root, "acme", "repo.git", "refs"));

    expect(await syncer.sync("acme")).toMatchObject({
      status: "failed",
      code: "SOURCE_LOCAL_DATA_DAMAGED",
      message: "repo.git of source acme is not a repository git can open",
      detail: { reason: "repository-damaged", sourceId: "acme" },
    });
    expect((await registry.readState("acme")).lastSync).toMatchObject({ result: "SOURCE_LOCAL_DATA_DAMAGED", detail: { reason: "repository-damaged" } });
    await syncer.resetLocalData("acme");
    expect(await syncer.sync("acme")).toMatchObject({ status: "ok", pinnedCommit: (first as { pinnedCommit: string }).pinnedCommit });
  });

  it("offers Repair, not a dead review, when a held rewrite sits on a half-removed repository", async () => {
    const { repo, name } = fixture();
    const base = repo.commit({ "marketplace.json": index("acme", []) }, "base");
    repo.commit({ "README.md": "v2\n" }, "second");
    const { registry, syncer } = await setup({ runner: git.runner });
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");
    const rewritten = rewrite(repo, base, { "README.md": "other\n" });
    expectFailed(await syncer.sync("acme"), "SOURCE_HISTORY_REWRITTEN");
    expect((await registry.readState("acme")).pendingRewrite).toMatchObject({ candidate: rewritten });

    await cleanupTmpDir(join(root, "acme", "repo.git", "objects"));
    await cleanupTmpDir(join(root, "acme", "repo.git", "refs"));
    expect(await syncer.sync("acme")).toMatchObject({ code: "SOURCE_LOCAL_DATA_DAMAGED", detail: { reason: "repository-damaged" } });
    const state = await registry.readState("acme");
    expect(state.pendingRewrite).toBeDefined();
    expect(sourceStatus(state, false, true, true)).toMatchObject({ state: "broken", detail: { reason: "repository-damaged", sourceId: "acme" } });

    const refused = await syncer.acceptRewrite("acme", rewritten).then(
      () => null,
      (error: unknown) => error as MarketplaceError,
    );
    expect(refused).toBeInstanceOf(MarketplaceError);
    expect(refused).toMatchObject({ code: "SOURCE_LOCAL_DATA_DAMAGED", message: "repo.git of source acme is not a repository git can open", detail: { reason: "repository-damaged" } });
    expect(refused!.message).not.toContain(root);
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

  it("rebuilds legacy snapshots at the same pin and evaluates the retained raw policy", async () => {
    const { repo, name } = fixture();
    const entry = { kind: "plugin", name: "retired-fixture", versions: "*", appVersions: "0.12.0", reason: "Replaced", at: AT,
      action: "uninstall", successors: { plugins: [{ pluginId: "successor-fixture" }], hostKinds: [] } };
    const commit = repo.commit({ "marketplace.json": index("acme", []), "policy/revocations-by-app.json": revocations([entry]) }, "conditional policy");
    const { registry, syncer, changed } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");
    const snapshot = (await syncer.readSnapshot("acme"))!;
    expect(snapshot).toMatchObject({ formatVersion: 2, conditionalRevocations: [entry] });
    for (const formatVersion of [undefined, 1]) {
      writeFileSync(join(root, "acme", "snapshots", commit + ".json"), JSON.stringify({ ...snapshot, formatVersion, conditionalRevocations: undefined }));
      expect(await syncer.sync("acme")).toMatchObject({ changed: true, pinnedCommit: commit });
      expect((await syncer.readSnapshot("acme"))?.conditionalRevocations).toEqual([entry]);
    }
    expect(changed).toEqual(["acme", "acme", "acme"]);
    expect(await syncer.readRevocations("acme", "0.11.0")).toEqual([]);
    expect(await syncer.readRevocations("acme", "0.12.0")).toEqual([entry]);
    repo.commit({ "policy/revocations-by-app.json": revocations([{ ...entry, appVersions: "bad" }]) }, "invalid conditional policy");
    expect(await syncer.sync("acme")).toMatchObject({ status: "failed", code: "SOURCE_INDEX_INVALID", pinnedCommit: commit });
    expect(await syncer.readRevocations("acme", "0.12.0")).toEqual([entry]);
    expect(server.seen.some((request) => request.path.startsWith(`/${name}/`))).toBe(false);
  });

  it("repairs damaged snapshots at the same pin before accepting a no-op", async () => {
    const { repo, name } = fixture();
    const entry = { kind: "plugin", name: "retired-fixture", versions: "*", appVersions: "0.12.0", reason: "Replaced", at: AT,
      action: "uninstall", successors: { plugins: [{ pluginId: "successor-fixture" }], hostKinds: [] } };
    const commit = repo.commit({ "marketplace.json": index("acme", []), "policy/revocations-by-app.json": revocations([entry]) }, "conditional policy");
    const { registry, syncer, changed } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");
    const snapshot = (await syncer.readSnapshot("acme"))!;
    const patches = [
      { conditionalRevocations: {} }, { conditionalRevocations: undefined }, { revocations: {} },
      { conditionalRevocations: [{ ...entry, versions: "invalid range" }] },
      { conditionalRevocations: [{ ...entry, successors: null }] },
      { packages: {} }, { packages: [{ kind: "skill", name: "alpha", path: "skills/alpha", versions: [{}] }] },
      { marketplace: null }, { diagnostics: {} }, { sourceId: "other-source" }, { commit: OTHER_COMMIT },
    ];
    const damaged = ["{", "null", ...patches.map((patch) => JSON.stringify({ ...snapshot, ...patch }))];
    for (const text of damaged) {
      writeFileSync(join(root, "acme", "snapshots", commit + ".json"), text);
      changed.length = 0;
      expect(await syncer.sync("acme"), text).toEqual({ status: "ok", pinnedCommit: commit, changed: true });
      expect(await syncer.readSnapshot("acme")).toEqual(snapshot);
      expect(await syncer.readRevocations("acme", "0.12.0")).toEqual([entry]);
      expect(await syncer.readRevocations("acme", "0.11.0")).toEqual([]);
      expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: commit, changed: false });
      expect(changed).toEqual(["acme"]);
    }
  });

  it("serves a snapshot stored before identifier admission without its credential-shaped package, offline and after a same-commit refresh (§18.8)", async () => {
    const { repo, name } = fixture();
    // Assembled here so no whole token sits in the source.
    const token = `glp${"at-"}${"abcd1234".repeat(3)}`;
    const entry = { kind: "plugin", name: "retired-fixture", versions: "*", appVersions: "0.12.0", reason: "Replaced", at: AT,
      action: "uninstall", successors: { plugins: [{ pluginId: "successor-fixture" }], hostKinds: [] } };
    const commit = repo.commit({
      "marketplace.json": index("acme", [{ kind: "skill", name: "alpha", path: "skills/alpha" }, { kind: "skill", name: token, path: "skills/held" }]),
      "skills/alpha/ave-package.json": skill("alpha"),
      "skills/held/ave-package.json": skill(token),
      "policy/revocations-by-app.json": revocations([entry]),
    }, "a package named like a token");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    await syncer.sync("acme");
    const fresh = (await syncer.readSnapshot("acme"))!;
    expect(fresh.packages.map((item) => item.name)).toEqual(["alpha"]);
    const alpha = fresh.packages[0]!;
    const held = { ...alpha, name: token, path: "skills/held" };
    const stored = { ...fresh, packages: [alpha, held], diagnostics: [] };
    const path = join(root, "acme", "snapshots", `${commit}.json`);
    writeFileSync(path, JSON.stringify(stored));

    for (const step of ["offline", "refresh"] as const) {
      if (step === "refresh") expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: commit, changed: false });
      const served = (await syncer.readSnapshot("acme"))!;
      expect(served.packages.map((item) => item.name), step).toEqual(["alpha"]);
      expect(served.diagnostics).toEqual([{ subject: "packages[1]", message: "its name uses the reserved prefix glpat-, which looks like a GitLab token; choose a different one" }]);
      expect(JSON.stringify(served)).not.toContain(token);
      expect(await syncer.readRevocations("acme", "0.12.0")).toEqual([entry]);
    }
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify(stored));
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
    expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: commit, changed: true });
    expect((await syncer.readSnapshot("acme"))!.commit).toBe(commit);
    expect(changed).toEqual(["acme", "acme"]);
  });

  it("refuses rewritten history on a managed source and keeps the pin", async () => {
    const { repo, name } = fixture();
    const base = repo.commit({ "marketplace.json": index("corp", []) }, "base");
    const pinned = repo.commit({ "README.md": "v2\n" }, "second");
    const policy = policyWith({
      additional: [{ transport: "git", id: "corp", url: normalizeSourceUrl(server.url(name)), auth: { kind: "none" } }],
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
    const { registry, syncer } = await setup({ official, runner: git.runner });
    expect(await syncer.sync("ave")).toEqual({ status: "ok", pinnedCommit: commit, changed: true });

    const unreachable: OfficialMarketplace = { ...official, mirrors: [server.url("also-missing")] };
    const { syncer: offline } = await setup({ official: unreachable, runner: git.runner });
    expectFailed(await offline.sync("ave"), "SOURCE_UNREACHABLE");
    expect((await registry.readState("ave")).pinnedCommit).toBe(commit);
    expect((await offline.readSnapshot("ave"))!.commit).toBe(commit);

    rewrite(repo, base, { "README.md": "forked\n" });
    expectFailed(await syncer.sync("ave"), "SOURCE_HISTORY_REWRITTEN");
    expect((await registry.readState("ave")).pinnedCommit).toBe(commit);
  });

  it("persists why a background sync failed, and the reason survives reopening the registry", async () => {
    const lookup = dnsPromises.lookup.bind(dnsPromises);
    const spy = vi.spyOn(dnsPromises, "lookup").mockImplementation(((host: string, options: unknown) => {
      if (host === "nowhere.invalid") return Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
      return (lookup as (host: string, options: unknown) => Promise<unknown>)(host, options);
    }) as typeof dnsPromises.lookup);
    try {
      const { registry, syncer } = await setup();
      await registry.add({ id: "acme", origin: "custom", url: "https://nowhere.invalid/acme/market", auth: { kind: "none" } });

      expect(await syncer.sync("acme")).toMatchObject({
        status: "failed",
        code: "SOURCE_UNREACHABLE",
        detail: { reason: "dns", host: "nowhere.invalid" },
      });

      const reopened = await SourceRegistry.open({ root, policy: policySource(policyWith({})) });
      expect((await reopened.readState("acme")).lastSync).toEqual({ at: AT, result: "SOURCE_UNREACHABLE", detail: { reason: "dns", host: "nowhere.invalid" } });
    } finally {
      spy.mockRestore();
    }
  });

  it("stores and returns a detail's diagnostic text scrubbed", async () => {
    const { registry } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: "https://1.1.1.1/acme/market", auth: { kind: "none" } });
    const broken: PolicyLoad = { ok: false, error: '/fixture/ave-policy.json: duplicate key "https://alice:detail-canary@example.com/x"', path: FIXTURE_POLICY_PATH };
    const syncer = new SourceSyncer({
      folders: nodeFolders(),
      registry,
      gate: new NetworkGate({ policy: policySource(broken), allowLoopback: true, transport: createPinnedFetch() }),
      runner: git.runner,
      root,
      now: () => new Date(AT),
      retainedCommits: async () => new Set(),
      onCatalogChanged: () => undefined,
    });

    const result = await syncer.sync("acme");
    const scrubbed = { reason: "policy-invalid", error: '/fixture/ave-policy.json: duplicate key "https://[REDACTED:CREDENTIALS]@example.com/x"' };
    expect(result).toMatchObject({ status: "failed", code: "SOURCE_POLICY_BLOCKED", detail: scrubbed });
    expect(readFileSync(join(root, "acme", "state.json"), "utf8")).not.toContain("detail-canary");
    expect((await registry.readState("acme")).lastSync).toEqual({ at: AT, result: "SOURCE_POLICY_BLOCKED", detail: scrubbed });
  });

  it("keeps the code but drops a stored detail that does not belong to it", async () => {
    const { registry } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: "https://nowhere.invalid/acme/market", auth: { kind: "none" } });
    const stateFile = join(root, "acme", "state.json");
    mkdirSync(dirname(stateFile), { recursive: true });
    const lastSync = { at: AT, result: "SOURCE_UNREACHABLE", detail: { reason: "token", host: "nowhere.invalid" } };
    writeFileSync(stateFile, `${JSON.stringify({ pinnedCommit: null, enabled: true, lastSync })}\n`);

    expect((await registry.readState("acme")).lastSync).toEqual({ at: AT, result: "SOURCE_UNREACHABLE" });
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
    const { registry } = await setup({ runner: git.runner });
    await registry.add({ id: "acme", origin: "custom", url, auth: { kind: "none" } });
    const { syncer } = await setup({ policy: policyWith({ block: [parseSourcePattern(url)] }), runner: git.runner });
    const before = server.seen.length;
    expectFailed(await syncer.sync("acme"), "SOURCE_POLICY_BLOCKED");
    expect(server.seen.length).toBe(before);
    expect(existsSync(join(root, "acme", "snapshots"))).toBe(false);
  });

  it("refuses a marketplace.json at another schemaVersion by naming it, whatever layout the descriptors use", async () => {
    const { repo, name } = fixture();
    repo.commit({ "README.md": "start\n" }, "start");
    // Use tree entries because Windows cannot create this path on disk.
    repo.commitEntries(
      Object.entries({
        "marketplace.json": `${JSON.stringify({ schemaVersion: 1, name: "acme", displayName: "Legacy", packages: [] })}\n`,
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
    expect(await syncer.sync("acme")).toMatchObject({
      status: "failed",
      code: "SOURCE_INDEX_INVALID",
      message: expect.stringContaining("marketplace.json: schemaVersion 1 is not supported; this app reads schemaVersion 2"),
      pinnedCommit: null,
    });
    expect(await syncer.readSnapshot("acme")).toBeNull();
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
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "tree-tool",
      version: "1.2.0",
      description: "Tools from a built tree",
      extensions: { "ai.agent-connector.ave": { entry: "dist/index.js", tools: [], capabilities: ["host:overlay"], requires: { minAppVersion: "0.10.0" } } },
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
      versions: [{ version: "1.2.0", minAppVersion: "0.10.0", artifact: { tree: "plugins/tree-tool" }, authority: { capabilities: ["host:overlay"], requires: { minAppVersion: "0.10.0" } } }],
    });
    expect(await only("skill-src")).toMatchObject({
      kind: "skill",
      name: "proofread",
      description: "Checks Korean spelling",
      versions: [{ version: `0.0.0+g${commit.slice(0, 12)}`, minAppVersion: "0.0.0" }],
    });
    expect(await only("versioned-src")).toMatchObject({ kind: "skill", name: "versioned", latest: "3.0.0" });
    expect(await only("agent-src")).toMatchObject({ kind: "agent", name: "release-captain" });
    expect(await only("mcp-src")).toMatchObject({ kind: "mcp", name: "weather", latest: "0.5.0" });
  });

  it("synthesizes a plugin at a direct source's root with the default tree rung, and refuses one without minAppVersion", async () => {
    const good = fixture();
    const extensions = { "ai.agent-connector.ave": { entry: "dist/index.js", tools: [], capabilities: [], requires: { minAppVersion: "0.10.0" } } };
    good.repo.commit({ "plugin.json": `${JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "root-tool", version: "0.1.0", description: "Root tool", extensions })}\n` }, "root");
    const bad = fixture();
    bad.repo.commit({ "plugin.json": `${JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "loose", version: "0.1.0", description: "Loose tool", extensions: { "ai.agent-connector.ave": { entry: "dist/index.js", tools: [], capabilities: [] } } })}\n` }, "root");
    const { registry, syncer } = await setup();
    await registry.add({ id: "good-src", origin: "direct", url: server.url(good.name), auth: { kind: "none" } });
    await registry.add({ id: "bad-src", origin: "direct", url: server.url(bad.name), auth: { kind: "none" } });

    expect(await syncer.sync("good-src")).toMatchObject({ status: "ok" });
    expect(await syncer.sync("good-src")).toMatchObject({ status: "ok", changed: false });
    expect((await syncer.readSnapshot("good-src"))!.packages).toMatchObject([{ kind: "plugin", name: "root-tool", path: "", versions: [{ artifact: {} }] }]);
    expectFailed(await syncer.sync("bad-src"), "PACKAGE_COMPAT_UNDECLARED");
  });

  it("detects a portable manifest without an executable marker as an agent-plugin", async () => {
    const { repo, name } = fixture();
    const manifest = { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "writer-plugin", version: "1.0.0", description: "Writing tools" };
    repo.commit({
      "plugin.json": `${JSON.stringify(manifest)}\n`,
      "skills/draft/SKILL.md": "---\nname: draft\ndescription: Write a draft\n---\nWrite a draft.\n",
    }, "portable package");
    const { registry, syncer } = await setup();
    await registry.add({ id: "writer-src", origin: "direct", url: server.url(name), auth: { kind: "none" } });
    expect(await syncer.sync("writer-src")).toMatchObject({ status: "ok" });
    expect((await syncer.readSnapshot("writer-src"))!.packages).toMatchObject([{
      kind: "agent-plugin", name: "writer-plugin", versions: [{ minAppVersion: "0.12.0", components: { skills: [{ name: "draft" }] } }],
    }]);
  });

  it("refuses a direct process extension without classifying it as an agent-plugin", async () => {
    const { repo, name } = fixture();
    repo.commit({ "plugin.json": `${JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "process-kit", version: "1.0.0", description: "Process extension",
      extensions: { "ai.agent-connector.ave": {
        process: { command: "./bin/plugin" }, tools: [], requires: { minAppVersion: "0.13.0", hostProtocol: "4" },
      } },
    })}\n`, "bin/plugin": "#!/bin/sh\n" }, "process package");
    const { registry, syncer } = await setup();
    await registry.add({ id: "process-src", origin: "direct", url: server.url(name), auth: { kind: "none" } });
    expectFailed(await syncer.sync("process-src"), "process-entry-requires-pinned-artifact");
    expect(await syncer.readSnapshot("process-src")).toBeNull();
  });

  it("lists a process-entry package with a pinned release, which a win32 app excludes by platforms (§9.7 P4)", async () => {
    const { repo, name } = fixture();
    const authority = { capabilities: [], requires: { minAppVersion: "0.13.0", hostProtocol: "4" } };
    const artifact = { release: { repo: "acme/process-kit", sha256: "e".repeat(64) } };
    repo.commit({
      "marketplace.json": index("acme", [{ kind: "plugin", name: "process-kit", path: "plugins/process-kit" }]),
      "plugins/process-kit/ave-package.json": `${JSON.stringify({
        schemaVersion: 2, kind: "plugin", name: "process-kit", version: "1.0.0", minAppVersion: "0.13.0", hostProtocol: "4",
        platforms: ["darwin", "linux"], payload: { authority, artifact },
      })}\n`,
    }, "publish process-kit");
    const { registry, syncer } = await setup();
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    expect(await syncer.sync("acme")).toMatchObject({ status: "ok" });
    const snapshot = (await syncer.readSnapshot("acme"))!;
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.packages).toMatchObject([{
      kind: "plugin", name: "process-kit", versions: [{ version: "1.0.0", minAppVersion: "0.13.0", platforms: ["darwin", "linux"], artifact }],
    }]);
    const offer = (platform: "darwin" | "win32") => aggregateCatalog([{ sourceId: "acme", sourceOrigin: "custom", snapshot }], {
      appVersion: "0.13.0", platform, canaryOptIn: false, installationId: "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b",
    })[0]!;
    expect(offer("darwin").choice).toMatchObject({ state: "candidate", version: { version: "1.0.0" } });
    const [listed] = snapshot.packages[0]!.versions!;
    expect(versionExclusions("acme", "plugin", "process-kit", listed!, [], {
      appVersion: "0.13.0", platform: "win32", canaryOptIn: false, installationId: "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b",
    })).toEqual(["platform"]);
    expect(offer("win32").choice).toEqual({ state: "unavailable", reason: "withheld" });
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
    const { registry, syncer } = await setup({ runner: git.runner });
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

describe("SourceSyncer and source auth", () => {
  // Assembled here so no whole credential sits in the source.
  const TOKEN = ["fixture", "secret", "value"].join("-");
  let serverRoot: string;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let root: string;
  let repo: FixtureRepo;
  let privateRepo: FixtureRepo;
  let commit: string;
  let privateCommit: string;

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-sync-auth-served-"));
    repo = createFixtureRepo(serverRoot, "guarded");
    commit = repo.commit({ "marketplace.json": index("ave", []) }, "initial");
    privateRepo = createFixtureRepo(serverRoot, "private-tools");
    privateCommit = privateRepo.commit({ "marketplace.json": index("acme", []) }, "initial");
    server = await startGitHttpServer({ root: serverRoot, token: TOKEN });
    git = await createTestGitRunner({ tokens: { "127.0.0.1": TOKEN } });
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    await removeFixtureRepo(repo);
    await removeFixtureRepo(privateRepo);
    await cleanupTmpDir(serverRoot);
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-sync-auth-root-"));
    server.seen.length = 0;
  });

  afterEach(async () => {
    await cleanupTmpDir(root);
  });

  async function setup(auth: OfficialMarketplace["auth"]) {
    const policy = policySource(policyWith({}));
    const official: OfficialMarketplace = { id: "ave", url: server.url("guarded"), mirrors: [], auth };
    const registry = await SourceRegistry.open({ root, policy, official });
    // The loopback fixture permits plaintext credentials so the source auth setting alone decides token use.
    await registry.acknowledge("ave", ["token-unencrypted"]);
    const syncer = new SourceSyncer({
      folders: nodeFolders(),
      registry,
      gate: new NetworkGate({ policy, allowLoopback: true, transport: createPinnedFetch() }),
      runner: git.runner,
      root,
      now: () => new Date(AT),
      retainedCommits: async () => new Set(),
      onCatalogChanged: () => undefined,
    });
    return { registry, syncer };
  }

  const authorized = () => server.seen.filter((request) => request.authorization !== undefined);

  it("never offers a stored token to an official source whose auth is none, even when its host asks for one", async () => {
    const { syncer } = await setup({ kind: "none" });
    expectFailed(await syncer.sync("ave"), "SOURCE_AUTH_REQUIRED");
    expect(server.seen.length).toBeGreaterThan(0);
    expect(authorized()).toEqual([]);
  });

  it("offers the stored token to a source whose auth is token (the control for the case above)", async () => {
    const { syncer } = await setup({ kind: "token", host: "127.0.0.1" });
    expect(await syncer.sync("ave")).toEqual({ status: "ok", pinnedCommit: commit, changed: true });
    expect(authorized().length).toBeGreaterThan(0);
  });

  it("keeps token auth for a private source the user added", async () => {
    const { registry, syncer } = await setup({ kind: "none" });
    await registry.add({
      id: "acme",
      origin: "custom",
      url: server.url("private-tools"),
      auth: { kind: "token", host: "127.0.0.1" },
      acknowledged: ["token-unencrypted"],
    });
    server.seen.length = 0;
    expect(await syncer.sync("acme")).toEqual({ status: "ok", pinnedCommit: privateCommit, changed: true });
    expect(authorized().length).toBeGreaterThan(0);
    expect(authorized().every((request) => request.path.startsWith("/private-tools/"))).toBe(true);
  });
});
