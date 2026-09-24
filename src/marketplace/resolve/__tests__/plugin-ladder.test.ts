import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../../plugins/marketplace-artifact-limits.js";
import { PluginArtifactStore } from "../../../plugins/plugin-artifact-store.js";
import {
  createFixtureRepo,
  type FixtureRepo,
  type GitHttpServer,
  removeFixtureRepo,
  startGitHttpServer,
} from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { policyLoad } from "../../__tests__/fixtures/policy.js";
import { aggregateCatalog, type CatalogRow } from "../../catalog/aggregate.js";
import type { PluginAuthority } from "../../catalog/types.js";
import { NetworkGate } from "../../net/network-gate.js";
import { normalizeSourceUrl, parseSourcePattern } from "../../net/source-url.js";
import { SourceRegistry } from "../../sources/registry.js";
import { SourceSyncer } from "../../sources/sync.js";
import { createArtifactCache, NO_ARTIFACT_CACHE } from "../artifact-cache.js";
import { candidateVersion } from "../descriptor.js";
import { LadderError, planPluginInstall, runPluginLadder, treeDigest, type LadderDeps, type PluginInstallPlan } from "../plugin-ladder.js";
import { sha256Hex as sha } from "../../__tests__/fixtures/package-files.js";

const AT = "2026-09-23T00:00:00.000Z";
const INSTALLATION = "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b";
const ENTRY_JS = "export default {};\n";

const authority = (patch: Partial<PluginAuthority> = {}): PluginAuthority => ({
  capabilities: ["notes:read"],
  networkAccess: { allowedDomains: ["api.example.com"] },
  requires: { minAppVersion: "0.12.0" },
  ...patch,
});

function pluginJson(name: string, version: string, auth: PluginAuthority = authority()): string {
  return `${JSON.stringify({ name, version, description: name, extensions: { "ai.agent-connector.ave": { displayName: name, entry: "dist/index.js", ...auth } } }, null, 2)}\n`;
}

function pluginZip(name: string, version: string, auth: PluginAuthority = authority()): Buffer {
  const zip = new AdmZip();
  zip.addFile("plugin.json", Buffer.from(pluginJson(name, version, auth)));
  zip.addFile("dist/index.js", Buffer.from(ENTRY_JS));
  return zip.toBuffer();
}

function descriptor(name: string, version: string, artifact: Record<string, unknown>, auth: PluginAuthority = authority()): string {
  return `${JSON.stringify({ schemaVersion: 1, kind: "plugin", name, version, minAppVersion: "0.12.0", payload: { authority: auth, artifact } })}\n`;
}

const marketIndex = (packages: unknown[]) => `${JSON.stringify({ schemaVersion: 1, name: "acme", displayName: "Acme", packages })}\n`;

describe.skipIf(process.platform === "win32")("plugin artifact ladder (design §6.2)", () => {
  let serverRoot: string;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let root: string;
  let workRoot: string;
  let repos: FixtureRepo[] = [];
  let counter = 0;
  const store = () =>
    new PluginArtifactStore({
      installRoot: join(root, "plugins"),
      cacheRoot: join(root, "plugins", ".cache"),
    });

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-ladder-served-"));
    server = await startGitHttpServer({ root: serverRoot });
    git = await createTestGitRunner();
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    rmSync(serverRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-ladder-root-"));
    workRoot = mkdtempSync(join(tmpdir(), "ave-ladder-work-"));
  });

  afterEach(() => {
    for (const repo of repos) removeFixtureRepo(repo);
    repos = [];
    rmSync(root, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  });

  function fixture(name?: string): { repo: FixtureRepo; name: string } {
    counter += 1;
    const repoName = name ?? `ladder-${counter}`;
    const repo = createFixtureRepo(serverRoot, repoName);
    repos.push(repo);
    return { repo, name: repoName };
  }

  async function open(name: string, origin: "custom" | "direct" = "custom") {
    const policy = policyLoad({});
    const gate = new NetworkGate({ policy, allowLoopback: true });
    const marketplaces = mkdtempSync(join(root, "marketplaces-"));
    const registry = await SourceRegistry.open({ root: marketplaces, policy });
    await registry.add({ id: "acme", origin, url: server.url(name), auth: { kind: "none" } });
    const syncer = new SourceSyncer({
      registry,
      gate,
      runner: git.runner,
      root: marketplaces,
      now: () => new Date(AT),
      retainedCommits: async () => new Set(),
    });
    return { gate, syncer };
  }

  async function row(syncer: SourceSyncer, origin: "custom" | "direct" = "custom"): Promise<CatalogRow> {
    const result = await syncer.sync("acme");
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    const snapshot = (await syncer.readSnapshot("acme"))!;
    expect(snapshot.diagnostics).toEqual([]);
    const [found] = aggregateCatalog([{ sourceId: "acme", sourceOrigin: origin, snapshot }], {
      appVersion: "0.14.0",
      platform: process.platform,
      canaryOptIn: false,
      installationId: INSTALLATION,
    });
    return found!;
  }

  function ladder(syncer: SourceSyncer, gate: NetworkGate, plan: PluginInstallPlan, direct = false, patch: Partial<LadderDeps> = {}) {
    return syncer.withRepository("acme", ({ repo, remote, source }) =>
      runPluginLadder(plan, {
        repo,
        remote,
        sourceUrl: source.url,
        direct,
        gate,
        // Archive URLs must be https (schema); the loopback fixture speaks http.
        fetchImpl: ((input: string, init?: RequestInit) => fetch(input.replace(/^https:\/\/127\.0\.0\.1:/u, "http://127.0.0.1:"), init)) as typeof fetch,
        sourceToken: null,
        tokenMissing: false,
        zip: store(),
        limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
        workRoot,
        artifacts: NO_ARTIFACT_CACHE,
        ...patch,
      }),
    );
  }

  /** A marketplace with one plugin `alpha` at plugins/alpha whose descriptor declares `artifact`. */
  function market(repo: FixtureRepo, artifact: Record<string, unknown>, extra: Record<string, string> = {}, auth?: PluginAuthority): string {
    return repo.commit(
      {
        "marketplace.json": marketIndex([{ kind: "plugin", name: "alpha", path: "plugins/alpha" }]),
        "plugins/alpha/ave-package.json": descriptor("alpha", "1.0.0", artifact, auth),
        ...extra,
      },
      "publish alpha",
    );
  }

  const releasePath = "/acme/alpha/releases/download/v1.0.0/alpha-1.0.0.zip";

  it("uses the pinned release asset and records it as the used rung", async () => {
    const { repo, name } = fixture();
    const zip = pluginZip("alpha", "1.0.0");
    server.file(releasePath, zip);
    const commit = market(repo, { release: { repo: "acme/alpha", sha256: sha(zip) } });
    const { gate, syncer } = await open(name);
    const plan = planPluginInstall(await row(syncer));
    expect(plan).toMatchObject({ snapshotCommit: commit, versionCommit: commit, packagePath: "plugins/alpha", version: "1.0.0" });

    const staged = await ladder(syncer, gate, plan);
    expect(staged.rung).toBe("release");
    expect(staged.rungs).toEqual([{ rung: "release", outcome: "used" }]);
    expect(staged.artifactSha256).toBe(sha(zip));
    expect(staged.zipBuffer.equals(zip)).toBe(true);
    expect(staged.manifestDocument).toMatchObject({ name: "alpha", version: "1.0.0" });
    server.file(releasePath, null);
  });

  it("keeps a downloaded pinned zip and installs it again with the release gone", async () => {
    const { repo, name } = fixture();
    const zip = pluginZip("alpha", "1.0.0");
    server.file(releasePath, zip);
    market(repo, { release: { repo: "acme/alpha", sha256: sha(zip) } });
    const { gate, syncer } = await open(name);
    const plan = planPluginInstall(await row(syncer));
    const kept = join(root, "artifacts");
    const artifacts = createArtifactCache({ dir: kept, enabled: () => true, maxFileBytes: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS.maxCompressedBytes, log: { warn: vi.fn() } });

    await ladder(syncer, gate, plan, false, { artifacts });
    expect(readdirSync(kept)).toEqual([`${sha(zip)}.zip`]);

    // Offline: the release answers 404, and the kept bytes still carry the pin.
    server.file(releasePath, null);
    const again = await ladder(syncer, gate, plan, false, { artifacts });
    expect(again.rungs).toEqual([{ rung: "release", outcome: "used" }]);
    expect(again.zipBuffer.equals(zip)).toBe(true);
    expect(again.artifactSha256).toBe(sha(zip));
  });

  it("keeps nothing from the tree rung", async () => {
    const { repo, name } = fixture();
    market(repo, { tree: "plugins/alpha" }, {
      "plugins/alpha/plugin.json": pluginJson("alpha", "1.0.0"),
      "plugins/alpha/dist/index.js": ENTRY_JS,
    });
    const { gate, syncer } = await open(name);
    const keep = vi.fn(async () => undefined);
    const staged = await ladder(syncer, gate, planPluginInstall(await row(syncer)), false, { artifacts: { read: async () => null, keep } });
    expect(staged.rung).toBe("tree");
    expect(keep).not.toHaveBeenCalled();
  });

  it("moves past a digest mismatch to the archive, and past a transport failure to the tree", async () => {
    const { repo, name } = fixture();
    const zip = pluginZip("alpha", "1.0.0");
    server.file(releasePath, pluginZip("alpha", "1.0.0", authority({ capabilities: ["other"] })));
    server.file("/archives/alpha-1.0.0.zip", zip);
    market(repo, {
      release: { repo: "acme/alpha", sha256: sha(zip) },
      archive: { url: `${server.origin.replace("http:", "https:")}/archives/alpha-1.0.0.zip`, sha256: sha(zip) },
    });
    const { gate, syncer } = await open(name);
    const staged = await ladder(syncer, gate, planPluginInstall(await row(syncer)));
    expect(staged.rung).toBe("archive");
    expect(staged.rungs).toEqual([
      { rung: "release", outcome: "failed", code: "ARTIFACT_DIGEST_MISMATCH", message: expect.stringContaining("the pin is") },
      { rung: "archive", outcome: "used" },
    ]);
    server.file(releasePath, null);
    server.file("/archives/alpha-1.0.0.zip", null);

    const second = fixture();
    const files = {
      "plugins/alpha/plugin.json": pluginJson("alpha", "1.0.0"),
      "plugins/alpha/dist/index.js": ENTRY_JS,
    };
    market(second.repo, { release: { repo: "acme/alpha", sha256: sha(zip) } }, files);
    const other = await open(second.name);
    const fromTree = await ladder(other.syncer, other.gate, planPluginInstall(await row(other.syncer)));
    expect(fromTree.rungs).toEqual([
      { rung: "release", outcome: "failed", code: "SOURCE_UNREACHABLE", message: expect.stringContaining("HTTP 404") },
      { rung: "archive", outcome: "skipped", reason: "NOT_DECLARED" },
      { rung: "tree", outcome: "used" },
    ]);
    // The descriptor is not installed, and the digest is the §6.4 formula over what is.
    const expected = createHash("sha256")
      .update(`100644 ${sha(ENTRY_JS)} dist/index.js\n100644 ${sha(pluginJson("alpha", "1.0.0"))} plugin.json\n`)
      .digest("hex");
    expect(fromTree.artifactSha256).toBe(expected);
    expect(new AdmZip(fromTree.zipBuffer).getEntries().map((entry) => entry.entryName).sort()).toEqual(["dist/index.js", "plugin.json"]);
  });

  it("stops at the first rung whose plugin.json differs from the descriptor, even when a lower rung would match", async () => {
    const { repo, name } = fixture();
    const wrong = pluginZip("alpha", "1.0.0", authority({ networkAccess: { allowedDomains: ["evil.example"] } }));
    server.file(releasePath, wrong);
    market(repo, { release: { repo: "acme/alpha", sha256: sha(wrong) } }, {
      "plugins/alpha/plugin.json": pluginJson("alpha", "1.0.0"),
      "plugins/alpha/dist/index.js": ENTRY_JS,
    });
    const { gate, syncer } = await open(name);
    const error = await ladder(syncer, gate, planPluginInstall(await row(syncer))).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LadderError);
    expect(error).toMatchObject({ code: "MANIFEST_MISMATCH", rungs: [{ rung: "release", outcome: "failed", code: "MANIFEST_MISMATCH" }] });
    expect((error as Error).message).toContain("networkAccess differs");
    server.file(releasePath, null);
  });

  it.each([
    ["capabilities", { capabilities: [] }],
    ["networkAccess", { networkAccess: undefined }],
    ["hostSecrets", { hostSecrets: { read: ["llm.apiKey.openai"] } }],
    ["pluginAccess", { pluginAccess: { allow: ["notes"] } }],
    ["auth", { auth: { kind: "none" } }],
    ["requires", { requires: { minAppVersion: "0.12.0", capabilities: ["notes"] } }],
    ["dependencies", { dependencies: [{ id: "notes" }] }],
  ] as Array<[string, Partial<PluginAuthority>]>)("stops on a staged %s that differs", async (field, patch) => {
    const { repo, name } = fixture();
    const staged = pluginZip("alpha", "1.0.0", { ...authority(), ...patch });
    server.file(releasePath, staged);
    market(repo, { release: { repo: "acme/alpha", sha256: sha(staged) } });
    const { gate, syncer } = await open(name);
    const error = await ladder(syncer, gate, planPluginInstall(await row(syncer))).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "MANIFEST_MISMATCH" });
    expect((error as Error).message).toContain(`${field} differs`);
    server.file(releasePath, null);
  });

  it("stops with PACKAGE_COMPAT_UNDECLARED when the staged plugin.json does not declare requires.minAppVersion", async () => {
    const { repo, name } = fixture();
    // The schema cannot express the broken manifest this test stages.
    const undeclared = pluginZip("alpha", "1.0.0", authority({ requires: {} as unknown as PluginAuthority["requires"] }));
    server.file(releasePath, undeclared);
    market(repo, { release: { repo: "acme/alpha", sha256: sha(undeclared) } });
    const { gate, syncer } = await open(name);
    const error = await ladder(syncer, gate, planPluginInstall(await row(syncer))).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "PACKAGE_COMPAT_UNDECLARED",
      rungs: [{ rung: "release", outcome: "failed", code: "PACKAGE_COMPAT_UNDECLARED", message: "plugin.json does not declare requires.minAppVersion" }],
    });
    server.file(releasePath, null);
  });

  it("skips a release or archive without a pin as ARTIFACT_NOT_PINNED and moves on", async () => {
    const { repo, name } = fixture();
    server.file(releasePath, pluginZip("alpha", "1.0.0"));
    market(repo, { release: { repo: "acme/alpha" }, archive: { url: "https://dl.example.com/alpha.zip" }, tree: "plugins/alpha" }, {
      "plugins/alpha/plugin.json": pluginJson("alpha", "1.0.0"),
      "plugins/alpha/dist/index.js": ENTRY_JS,
    });
    const { gate, syncer } = await open(name);
    const staged = await ladder(syncer, gate, planPluginInstall(await row(syncer)));
    expect(staged.rungs).toEqual([
      { rung: "release", outcome: "skipped", reason: "ARTIFACT_NOT_PINNED" },
      { rung: "archive", outcome: "skipped", reason: "ARTIFACT_NOT_PINNED" },
      { rung: "tree", outcome: "used" },
    ]);
    server.file(releasePath, null);
  });

  it("reports NO_INSTALLABLE_ARTIFACT with every rung when none yields an artifact", async () => {
    const { repo, name } = fixture();
    market(repo, { release: { repo: "acme/alpha", sha256: "0".repeat(64) }, tree: "plugins/alpha/build" }, {
      "plugins/alpha/build/plugin.json": pluginJson("alpha", "1.0.0"),
      "plugins/alpha/build/README.md": "not allowed at the top level\n",
    });
    const { gate, syncer } = await open(name);
    const error = await ladder(syncer, gate, planPluginInstall(await row(syncer))).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "NO_INSTALLABLE_ARTIFACT",
      rungs: [
        { rung: "release", outcome: "failed", code: "SOURCE_UNREACHABLE" },
        { rung: "archive", outcome: "skipped", reason: "NOT_DECLARED" },
        { rung: "tree", outcome: "failed", code: "CONTENT_RULE_VIOLATION", message: expect.stringContaining("README.md") },
      ],
    });
  });

  it("installs what the plan was bound to after a sync moves the pin", async () => {
    const { repo, name } = fixture();
    const first = market(repo, { tree: "plugins/alpha/build" }, {
      "plugins/alpha/build/plugin.json": pluginJson("alpha", "1.0.0"),
      "plugins/alpha/build/dist/index.js": ENTRY_JS,
    });
    const { gate, syncer } = await open(name);
    const plan = planPluginInstall(await row(syncer));
    const before = await ladder(syncer, gate, plan);

    repo.commit({ "plugins/alpha/build/dist/index.js": "export default { changed: true };\n" }, "change the tree");
    expect(await syncer.sync("acme")).toMatchObject({ status: "ok", changed: true });
    const after = await ladder(syncer, gate, plan);
    expect(plan.versionCommit).toBe(first);
    expect(after.artifactSha256).toBe(before.artifactSha256);
    // The zip carries entry times; the content is what must not move.
    expect(new AdmZip(after.zipBuffer).readAsText("dist/index.js")).toBe(ENTRY_JS);
  });

  it("refuses an index copy that differs from the descriptor at the version's commit", async () => {
    const { repo, name } = fixture();
    const base = repo.commit(
      {
        "plugins/alpha/ave-package.json": descriptor("alpha", "1.0.0", { tree: "plugins/alpha" }),
        "plugins/alpha/plugin.json": pluginJson("alpha", "1.0.0"),
        "plugins/alpha/dist/index.js": ENTRY_JS,
      },
      "descriptor",
    );
    repo.commit(
      {
        "marketplace.json": marketIndex([
          {
            kind: "plugin",
            name: "alpha",
            path: "plugins/alpha",
            versions: [
              {
                version: "1.0.0",
                commit: base,
                minAppVersion: "0.12.0",
                // The index widens what the descriptor at `base` declares.
                authority: authority({ capabilities: ["notes:read", "notes:write"] }),
                artifact: { tree: "plugins/alpha" },
                publishedAt: AT,
              },
            ],
          },
        ]),
      },
      "index",
    );
    const { gate, syncer } = await open(name);
    const error = await ladder(syncer, gate, planPluginInstall(await row(syncer))).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "MANIFEST_MISMATCH" });
    expect(error).not.toBeInstanceOf(LadderError);
    expect((error as Error).message).toContain("the index copy differs from plugins/alpha/ave-package.json in authority");
  });

  it("serves a direct source at the repository root: default release repo, then the root tree", async () => {
    const { repo, name } = fixture(`acme/direct-${counter + 1}`);
    const zip = pluginZip("alpha", "1.0.0");
    repo.commit(
      {
        "ave-package.json": descriptor("alpha", "1.0.0", { release: { sha256: sha(zip) } }),
        "plugin.json": pluginJson("alpha", "1.0.0"),
        "dist/index.js": ENTRY_JS,
      },
      "direct",
    );
    const { gate, syncer } = await open(name, "direct");
    const plan = planPluginInstall(await row(syncer, "direct"));
    expect(plan.packagePath).toBe("");

    server.file(`/${name}/releases/download/v1.0.0/alpha-1.0.0.zip`, zip);
    const fromRelease = await ladder(syncer, gate, plan, true);
    expect(fromRelease.rungs).toEqual([{ rung: "release", outcome: "used" }]);
    server.file(`/${name}/releases/download/v1.0.0/alpha-1.0.0.zip`, null);

    const fromTree = await ladder(syncer, gate, plan, true);
    expect(fromTree.rungs.map((item) => [item.rung, item.outcome])).toEqual([["release", "failed"], ["archive", "skipped"], ["tree", "used"]]);
    expect(fromTree.artifactSha256).toBe(
      treeDigest([
        { path: "plugin.json", data: Buffer.from(pluginJson("alpha", "1.0.0")), executable: false },
        { path: "dist/index.js", data: Buffer.from(ENTRY_JS), executable: false },
      ]),
    );
  });

  it("fetches a GitHub release asset through the REST API with the source token", async () => {
    const zip = pluginZip("alpha", "1.0.0");
    const seen: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const checked: string[] = [];
    const fakeGate = {
      checkDownloadPolicy: async (url: string) => {
        checked.push(url);
      },
      fetch: async (url: string, init: { headers?: Record<string, string> }) => {
        seen.push({ url, headers: init.headers });
        if (url.endsWith("/releases/tags/v1.0.0")) {
          return new Response(JSON.stringify({ assets: [{ id: 7, name: "other.zip" }, { id: 42, name: "alpha-1.0.0.zip" }] }));
        }
        if (url.endsWith("/releases/assets/42")) return new Response(new Uint8Array(zip));
        return new Response("", { status: 404 });
      },
    } as unknown as NetworkGate;
    const { repo, name } = fixture();
    market(repo, { release: { repo: "acme/alpha", sha256: sha(zip) } });
    const { gate, syncer } = await open(name);
    const plan = planPluginInstall(await row(syncer));
    const staged = await syncer.withRepository("acme", ({ repo: bare, remote }) =>
      runPluginLadder(plan, {
        repo: bare,
        remote,
        sourceUrl: normalizeSourceUrl("https://github.com/acme/market"),
        direct: false,
        gate: fakeGate,
        fetchImpl: fetch,
        sourceToken: "ghp_test",
        tokenMissing: false,
        zip: store(),
        limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
        workRoot,
        artifacts: NO_ARTIFACT_CACHE,
      }),
    );
    expect(staged.rungs).toEqual([{ rung: "release", outcome: "used" }]);
    expect(seen.map((request) => [request.url, request.headers?.accept, request.headers?.authorization])).toEqual([
      ["https://api.github.com/repos/acme/alpha/releases/tags/v1.0.0", "application/vnd.github+json", "Bearer ghp_test"],
      ["https://api.github.com/repos/acme/alpha/releases/assets/42", "application/octet-stream", "Bearer ghp_test"],
    ]);
    // Security review P2: the api.github.com request is governed by the repository's rules.
    expect(checked).toEqual(["https://github.com/acme/alpha/releases/download/v1.0.0/alpha-1.0.0.zip"]);
    void gate;
  });

  it("reads a hidden release asset of a token source without a stored token as sign-in required", async () => {
    const zip = pluginZip("alpha", "1.0.0");
    const hiding = { fetch: async () => new Response("", { status: 404 }) } as unknown as NetworkGate;
    const run = async (tokenMissing: boolean) => {
      const { repo, name } = fixture();
      market(repo, { release: { repo: "acme/alpha", sha256: sha(zip) } });
      const { syncer } = await open(name);
      const plan = planPluginInstall(await row(syncer));
      return syncer.withRepository("acme", ({ repo: bare, remote }) =>
        runPluginLadder(plan, {
          repo: bare,
          remote,
          sourceUrl: normalizeSourceUrl("https://github.com/acme/market"),
          direct: false,
          gate: hiding,
          fetchImpl: fetch,
          sourceToken: null,
          tokenMissing,
          zip: store(),
          limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
          workRoot,
          artifacts: NO_ARTIFACT_CACHE,
        }),
      ).catch((caught: unknown) => caught as LadderError);
    };

    const hidden = await run(true);
    expect(hidden).toBeInstanceOf(LadderError);
    expect(hidden).toMatchObject({ code: "SOURCE_AUTH_REQUIRED" });
    expect((hidden as LadderError).rungs[0]).toMatchObject({ rung: "release", outcome: "failed", code: "SOURCE_AUTH_REQUIRED" });

    // A source that signs in with no token: a 404 is a missing asset.
    const missing = await run(false);
    expect(missing).toMatchObject({ code: "NO_INSTALLABLE_ARTIFACT" });
    expect((missing as LadderError).rungs[0]).toMatchObject({ rung: "release", outcome: "failed", code: "SOURCE_UNREACHABLE" });
  });

  it("holds a token-fetched release asset to the policy for its github.com repository", async () => {
    const gate = new NetworkGate({ policy: policyLoad({ block: [parseSourcePattern("https://github.com/evil/*")] }), allowLoopback: false });
    await expect(gate.checkDownloadPolicy("https://github.com/evil/x/releases/download/v1.0.0/a.zip", { official: false }))
      .rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED" });
    await expect(gate.checkDownloadPolicy("https://github.com/acme/x/releases/download/v1.0.0/a.zip", { official: false })).resolves.toBeUndefined();
  });

  it("needs an allow list to admit api.github.com for the token path, as design §6.2 says", async () => {
    const fetchImpl = vi.fn();
    const repositoryOnly = new NetworkGate({ policy: policyLoad({ allow: [parseSourcePattern("https://github.com/acme/*")] }), allowLoopback: false });
    await expect(repositoryOnly.fetch("https://api.github.com/repos/acme/alpha/releases/tags/v1.0.0", { fetchImpl, official: false }))
      .rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED", message: expect.stringContaining("api.github.com") });
    expect(fetchImpl).not.toHaveBeenCalled();

    const withApi = new NetworkGate({ policy: policyLoad({ allow: [parseSourcePattern("https://github.com/acme/*"), parseSourcePattern("host:api.github.com")] }), allowLoopback: false });
    await expect(withApi.checkDownloadPolicy("https://api.github.com/repos/acme/alpha/releases/assets/42", { official: false })).resolves.toBeUndefined();
  });

  it("builds an ssh source's release URL over https on the default port, and refuses . and .. repository segments", async () => {
    const zip = pluginZip("alpha", "1.0.0");
    const seen: string[] = [];
    const fakeGate = {
      fetch: async (url: string) => {
        seen.push(url);
        return url.endsWith("/alpha-1.0.0.zip") ? new Response(new Uint8Array(zip)) : new Response("", { status: 404 });
      },
    } as unknown as NetworkGate;
    const planFor = async (releaseRepo: string) => {
      const { repo, name } = fixture();
      market(repo, { release: { repo: releaseRepo, sha256: sha(zip) } });
      const { syncer } = await open(name);
      return { syncer, plan: planPluginInstall(await row(syncer)) };
    };
    const run = ({ syncer, plan: forPlan }: { syncer: SourceSyncer; plan: PluginInstallPlan }) => syncer.withRepository("acme", ({ repo: bare, remote }) =>
      runPluginLadder(forPlan, {
        repo: bare,
        remote,
        sourceUrl: normalizeSourceUrl("ssh://git@git.acme.example:2222/acme/market.git"),
        direct: false,
        gate: fakeGate,
        fetchImpl: fetch,
        sourceToken: null,
        tokenMissing: false,
        zip: store(),
        limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
        workRoot,
        artifacts: NO_ARTIFACT_CACHE,
      }),
    );
    const staged = await run(await planFor("acme/alpha"));
    expect(staged.rungs).toEqual([{ rung: "release", outcome: "used" }]);
    expect(seen).toEqual(["https://git.acme.example/acme/alpha/releases/download/v1.0.0/alpha-1.0.0.zip"]);

    // The schema already refuses a leading "." segment; the ladder refuses the rest.
    for (const bad of ["acme/..", "acme/."]) {
      const error = await run(await planFor(bad)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LadderError);
      expect((error as LadderError).rungs[0]).toMatchObject({ rung: "release", outcome: "failed", code: "SOURCE_INDEX_INVALID" });
    }
    expect(seen).toHaveLength(1);
  });
});

describe("candidateVersion (design §14)", () => {
  const row = (choice: CatalogRow["choice"]) => ({ sourceId: "acme", name: "alpha", choice }) as CatalogRow;

  it.each([
    [{ state: "upgrade_required", minAppVersion: "9.0.0" }, "PACKAGE_INCOMPATIBLE"],
    [{ state: "unavailable", reason: "revoked" }, "PACKAGE_REVOKED"],
    [{ state: "unavailable", reason: "yanked" }, "PACKAGE_YANKED"],
    [{ state: "unavailable", reason: "pending" }, "PACKAGE_INCOMPATIBLE"],
    [{ state: "unavailable", reason: "withheld" }, "PACKAGE_INCOMPATIBLE"],
  ] as Array<[CatalogRow["choice"], string]>)("refuses %j with %s", (choice, code) => {
    expect(() => candidateVersion(row(choice))).toThrow(expect.objectContaining({ code }));
  });
});

describe("treeDigest (design §6.4)", () => {
  it("hashes mode, file digest and path per line, sorted by path bytes", () => {
    const run = Buffer.from("#!/bin/sh\n");
    const json = Buffer.from("{}");
    const expected = createHash("sha256")
      .update(`100755 ${sha(run)} dist/run.sh\n100644 ${sha(json)} plugin.json\n`)
      .digest("hex");
    expect(treeDigest([{ path: "plugin.json", data: json, executable: false }, { path: "dist/run.sh", data: run, executable: true }])).toBe(expected);
    expect(treeDigest([{ path: "plugin.json", data: json, executable: false }, { path: "dist/run.sh", data: run, executable: false }])).not.toBe(expected);
  });
});
