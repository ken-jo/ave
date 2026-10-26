// Pinned process artifacts pass provenance admission, then fail spawn without active confinement.
// The spawn refusal distinguishes admitted artifacts from provenance refusals.
import AdmZip from "adm-zip";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import {
  createFixtureRepo,
  type FixtureRepo,
  type GitHttpServer,
  removeFixtureRepo,
  startGitHttpServer,
} from "../../marketplace/__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../marketplace/__tests__/fixtures/git-runner.js";
import { sha256Hex as sha } from "../../marketplace/__tests__/fixtures/package-files.js";
import { policySource } from "../../marketplace/__tests__/fixtures/policy.js";
import { aggregateCatalog } from "../../marketplace/catalog/aggregate.js";
import type { PluginAuthority } from "../../marketplace/catalog/types.js";
import { NetworkGate } from "../../marketplace/net/network-gate.js";
import { createPinnedFetch } from "../../marketplace/net/pinned-fetch.js";
import { NO_ARTIFACT_CACHE } from "../../marketplace/resolve/artifact-cache.js";
import { planPluginInstall, runPluginLadder, type PluginInstallPlan } from "../../marketplace/resolve/plugin-ladder.js";
import { SourceRegistry } from "../../marketplace/sources/registry.js";
import { SourceSyncer } from "../../marketplace/sources/sync.js";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../marketplace-artifact-limits.js";
import { PluginArtifactStore } from "../plugin-artifact-store.js";
import { installReceiptPath, verifyInstallReceipt } from "../plugin-install-receipt.js";
import { ProcessEntryUnconfinedError } from "../process-entry.js";
import { readPluginRegistry } from "../registry.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  activateAndCommitPreparedPluginForTest,
  makeTestPluginPaths,
  makeTestPluginRuntime,
  TestPluginMarketplaceService,
} from "./test-helpers.js";
import { nodeFolders } from "../../marketplace/__tests__/fixtures/folder-fs.js";
import { gitAccess } from "../../marketplace/sources/source-tree.js";
import { UNREACHABLE_OFFICIAL } from "../../marketplace/__tests__/fixtures/official.js";

const AT = "2026-10-01T00:00:00.000Z";
const INSTALLATION = "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b";
const RELEASE_PATH = "/acme/alpha/releases/download/v1.0.0/alpha-1.0.0.zip";

const authority: PluginAuthority = { capabilities: [], requires: { minAppVersion: "0.15.0", hostProtocol: "4" } };

function processZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile("plugin.json", Buffer.from(`${JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "alpha",
    version: "1.0.0",
    description: "A process entry admitted through a pinned release.",
    extensions: { "ai.agent-connector.ave": { displayName: "Alpha", process: { command: "./bin/plugin" }, tools: [], ...authority } },
  }, null, 2)}\n`));
  zip.addFile("bin/plugin", Buffer.from("#!/bin/sh\nexit 0\n"), "", 0o755);
  return zip.toBuffer();
}

describe("a process entry from a pinned git release (§9.7 P4)", () => {
  let serverRoot: string;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let testDir: string;
  let repo: FixtureRepo;
  let repoName: string;
  let counter = 0;
  let priorDev: string | undefined;

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-process-admission-served-"));
    server = await startGitHttpServer({ root: serverRoot });
    git = await createTestGitRunner();
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    await cleanupTmpDir(serverRoot);
  });

  beforeEach(async () => {
    setIsPackaged(false);
    priorDev = process.env.AVE_DEV;
    process.env.AVE_DEV = "1";
    testDir = mkdtempSync(join(tmpdir(), "ave-process-admission-"));
    counter += 1;
    repoName = `process-market-${counter}`;
    repo = createFixtureRepo(serverRoot, repoName);
  });

  afterEach(async () => {
    server.file(RELEASE_PATH, null);
    await removeFixtureRepo(repo);
    await rm(testDir, { recursive: true, force: true });
    if (priorDev === undefined) delete process.env.AVE_DEV;
    else process.env.AVE_DEV = priorDev;
    _resetForTest();
  });

  /** Serve the same descriptor through catalog and direct sources; staging uses the real artifact ladder. */
  async function publish(origin: "custom" | "direct" = "custom") {
    const zip = processZip();
    server.file(RELEASE_PATH, zip);
    const described = `${JSON.stringify({
      schemaVersion: 2, kind: "plugin", name: "alpha", version: "1.0.0", minAppVersion: "0.15.0", hostProtocol: "4",
      platforms: ["darwin", "linux"],
      payload: { authority, artifact: { release: { repo: "acme/alpha", sha256: sha(zip) } } },
    })}\n`;
    repo.commit(origin === "direct" ? { "ave-package.json": described } : {
      "marketplace.json": `${JSON.stringify({ schemaVersion: 2, name: "acme", displayName: "Acme", packages: [{ kind: "plugin", name: "alpha", path: "plugins/alpha" }] })}\n`,
      "plugins/alpha/ave-package.json": described,
    }, "publish alpha");
    const policy = policySource({});
    const gate = new NetworkGate({ policy, allowLoopback: true, transport: createPinnedFetch() });
    const marketplaces = join(testDir, "marketplaces");
    await mkdir(marketplaces, { recursive: true });
    const registry = await SourceRegistry.open({ root: marketplaces, policy, official: UNREACHABLE_OFFICIAL });
    await registry.add({ id: "acme", origin, url: server.url(repoName), auth: { kind: "none" } });
    const syncer = new SourceSyncer({ registry, gate, runner: git.runner, root: marketplaces, now: () => new Date(AT), retainedCommits: async () => new Set(), folders: nodeFolders() });
    expect(await syncer.sync("acme")).toMatchObject({ status: "ok" });
    const snapshot = (await syncer.readSnapshot("acme"))!;
    const [row] = aggregateCatalog([{ sourceId: "acme", sourceOrigin: origin, snapshot }], {
      appVersion: "0.15.0",
      platform: "darwin",
      canaryOptIn: false,
      installationId: INSTALLATION,
    });
    const plan = planPluginInstall(row!);
    const workRoot = join(testDir, "ladder-work");
    await mkdir(workRoot, { recursive: true });
    const stage = (forPlan: PluginInstallPlan) => syncer.withRepository("acme", ({ repo: bare, remote, source }) =>
      runPluginLadder(forPlan, {
        ...gitAccess(bare, remote, source.origin === "direct"),
        repo: bare,
        remote,
        sourceUrl: source.url,
        gate,
        catalog: { id: "acme", label: "acme", url: source.url, acknowledged: new Set() },
        sourceToken: null,
        tokenMissing: false,
        zip: new PluginArtifactStore({ installRoot: join(testDir, "ladder-store"), cacheRoot: join(testDir, "ladder-store", ".cache") }),
        limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
        workRoot,
        artifacts: NO_ARTIFACT_CACHE,
      }));
    return { plan, stage, zip };
  }

  function installer() {
    const pluginsDir = join(testDir, "plugins");
    const cacheRoot = join(pluginsDir, ".cache");
    const registryPath = join(pluginsDir, "registry.json");
    const service = new TestPluginMarketplaceService(makeTestPluginPaths({ rootDir: testDir, cacheRoot }));
    const runtime = () => makeTestPluginRuntime({ rootDir: testDir, pluginsRoot: pluginsDir, registryPath }, { installReceiptCacheRoot: cacheRoot });
    return { pluginsDir, cacheRoot, registryPath, service, runtime };
  }

  it("installs it with a receipt at the release rung, and boot admits it through the provenance gate", async () => {
    const { plan, stage, zip } = await publish();
    const { pluginsDir, cacheRoot, registryPath, service, runtime } = installer();
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");

    const installed = await service.installGitPlugin(plan, { stage, activatePreparedArtifact: activateAndCommitPreparedPluginForTest });
    expect(installed).toMatchObject({ pluginId: "alpha", installed: true, staged: { rung: "release", artifactSha256: sha(zip) } });
    expect(await verifyInstallReceipt(cacheRoot, "alpha", join(pluginsDir, "alpha"))).toMatchObject({
      ok: true,
      receipt: { installSource: "git", artifactSha256: sha(zip), git: { rung: "release", rungs: [{ rung: "release", outcome: "used" }] } },
    });

    const booted = runtime();
    await booted.startAll();
    expect(booted.listPluginCards().find((card) => card.id === "alpha")).toMatchObject({
      loadStatus: "failed",
      installFailureKind: "process-entry-unconfined",
    });
  });

  it("refuses it from a direct source that serves its own descriptor with the same pinned release", async () => {
    const { plan, stage } = await publish("direct");
    expect(plan).toMatchObject({ sourceOrigin: "direct", packagePath: "" });
    const { pluginsDir, cacheRoot, registryPath, service, runtime } = installer();
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
    const live = runtime();

    await expect(service.installGitPlugin(plan, {
      stage,
      activatePreparedArtifact: (prepared) => live.activatePreparedArtifact(prepared),
    })).rejects.toMatchObject({ code: "process-entry-requires-pinned-artifact" });
    expect((await readPluginRegistry(registryPath)).plugins).toEqual([]);
    expect(existsSync(installReceiptPath(cacheRoot, "alpha"))).toBe(false);
    expect(existsSync(join(pluginsDir, "alpha", "plugin.json"))).toBe(false);
  });

  it("reaches the factory through the runtime's own prepared activation, and is refused only for confinement", async () => {
    const { plan, stage } = await publish();
    const { pluginsDir, cacheRoot, registryPath, service, runtime } = installer();
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
    const live = runtime();

    await expect(service.installGitPlugin(plan, {
      stage,
      activatePreparedArtifact: (prepared) => live.activatePreparedArtifact(prepared),
    })).rejects.toBeInstanceOf(ProcessEntryUnconfinedError);
    // A pre-commit refusal leaves no registry, receipt or payload; runtime directories are separate.
    expect((await readPluginRegistry(registryPath)).plugins).toEqual([]);
    expect(existsSync(installReceiptPath(cacheRoot, "alpha"))).toBe(false);
    expect(existsSync(join(pluginsDir, "alpha", "plugin.json"))).toBe(false);
    expect(existsSync(join(pluginsDir, "alpha", "bin"))).toBe(false);
  });
});
