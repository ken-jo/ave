import { deferred } from "../../../__tests__/support/deferred.js";
vi.mock("../../../shared/windows-path-facts.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../../shared/windows-configuration-handles.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

/** Service orchestration uses isolated repositories; named boundary cases retain real HTTP transport. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readPayloadFiles } from "../../../plugins/contribution-approval-digest.js";
import { requiresPackage } from "../../updates/eligibility.js";
import { descriptorText as descriptor, jsonText as text } from "../../__tests__/fixtures/package-files.js";
import type { McpServerConfig } from "../../../mcp/types.js";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../../plugins/marketplace-artifact-limits.js";
import { PluginArtifactStore } from "../../../plugins/plugin-artifact-store.js";
import { copyFixtureRepo, createFixtureRepo, type FixtureRepo, type GitHttpServer, removeFixtureRepo, startGitHttpServer } from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { cachedFixtureGit } from "../../__tests__/fixtures/cached-git.js";
import { policyLoad, policySource } from "../../__tests__/fixtures/policy.js";
import type { GitRunner } from "../../git/run-git.js";
import { ContentStore } from "../../content/store.js";
import { NetworkGate } from "../../net/network-gate.js";
import { createPinnedFetch } from "../../net/pinned-fetch.js";
import type { SourcePreviewResultView } from "../../../shared/git-marketplace.js";
import { NO_ARTIFACT_CACHE } from "../../resolve/artifact-cache.js";
import { migrateLegacyContent, type LegacyActivations, type LegacyContentReport } from "../../migration/legacy-content.js";
import type { LegacyPluginReport, OfficialPlugin } from "../../migration/legacy-plugins.js";
import { moonstoneBundle } from "../../../ui/renderer/theme/bundles/moonstone.js";
import type { MarketplaceError } from "../../errors.js";
import { OFFICIAL_MARKETPLACE, type OfficialMarketplace } from "../../sources/official.js";
import { EMPTY_MARKETPLACE_POLICY, FilePolicySource, type PolicyLoad, type PolicySource } from "../../sources/policy.js";
import { AppliedDefaults } from "../../boot-installs/applied.js";
import { normalizeSourceUrl } from "../../net/source-url.js";
import { SourceRegistry } from "../../sources/registry.js";
import { SourceSyncer } from "../../sources/sync.js";
import { McpInstaller } from "../mcp-installer.js";
import { createPluginRetirementPort } from "../../../plugins/retired-config.js";
import type { RetiredPluginConfigRecord } from "../../../shared/alerts-types.js";
import type { InstallerPorts, PluginInstallerPort, TokenStore } from "../ports.js";
import type { RevocationFeed } from "../revocations.js";
import { MarketplaceService } from "../service.js";
import { hasMarketplaceInstallInFlight } from "../install-lifecycle.js";
import { setAppRelaunchRequested } from "../../../main/app-relaunch-state.js";
import { marketplaceEvents, startMarketplaceBackground, type BackgroundService } from "../background.js";
import { emptyUpdateHistory, type UpdateHistory } from "../../updates/history.js";
import type { SyncProgressView } from "../../../shared/git-marketplace.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { nodeFolders } from "../../__tests__/fixtures/folder-fs.js";
import { UNREACHABLE_OFFICIAL } from "../../__tests__/fixtures/official.js";
import { setProcessPlatform } from "../../../__tests__/support/process-platform.js";
import { setAveHomePrivacyAtBoot, _resetAveHomePrivacyForTest } from "../../../shared/ave-home.js";
import { configureHostResources } from "../../../main/host-resources.js";
import { setPluginWorkerConfinementRequestedAtBoot, __resetSandboxRequestedAtBootForTest } from "../../../permissions/sandbox-capability.js";


vi.mock("../../../lib/admin-policy-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/admin-policy-file.js")>()),
  readAdminPolicyFile: (path: string) => import("node:fs/promises").then(({ readFile }) => readFile(path)),
}));

function previewIdOf(view: SourcePreviewResultView): string {
  if (view.type === "confirm") throw new Error(`preview asked for ${view.warnings.map((item) => item.warning).join(", ")}`);
  return view.previewId;
}

const AT = new Date("2026-09-24T00:00:00.000Z");
const ORIGINAL_PLATFORM = process.platform;
const SURFACES = { "surface-sunken": "228 30% 97%", surface: "0 0% 100%", "surface-raised": "0 0% 100%", "surface-overlay": "0 0% 100%", "border-subtle": "228 24% 94%", "border-strong": "228 18% 84%" };
const INSTALLATION = "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b";
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} things.\n---\n${body}\n`;

class FakeManager {
  configs = new Map<string, McpServerConfig>();
  blocked = new Set<string>();
  validateConfig(config: McpServerConfig) {
    return this.blocked.has(config.id) ? { valid: false as const, reason: `Unapproved server: '${config.id}'`, layer: 1 } : { valid: true as const };
  }
  async getConfigs() {
    return [...this.configs.values()];
  }
  async addConfig(config: McpServerConfig) {
    this.configs.set(config.id, config);
    return { connected: true };
  }
  async removeConfig(id: string) {
    this.configs.delete(id);
  }
}

describe("MarketplaceService", () => {
  let serverRoot: string;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let fixtureGit: Pick<GitRunner, "run" | "preflight">;
  let emptyRepo: FixtureRepo;
  const marketSeeds = new Map<string, FixtureRepo>();
  const publishedSeeds = new Map<string, FixtureRepo>();
  let root: string;
  let repos: FixtureRepo[] = [];
  let counter = 0;
  let now: Date;
  let manager: FakeManager;
  let service: MarketplaceService;
  let store: ContentStore;
  let catalogChanged: number;
  let afterCatalogChanged: (() => void) | null;
  let afterSourceSynced: ((sourceId: string) => void) | null;
  let legacyRuns: Array<(name: string) => OfficialPlugin | null>;
  let legacyReport: LegacyPluginReport;
  let legacyActivations: LegacyActivations;
  let released: Array<{ themes: string[]; locales: string[] }>;
  let contentReports: LegacyContentReport[];
  let adopting: boolean[];
  let feeds: RevocationFeed[];
  let feedFails: boolean;
  let helperAnswers: boolean;
  let pluginPort: PluginInstallerPort;
  let warnings: string[];
  let progress: SyncProgressView[];
  let feedCalls: number;
  let feedHold: { at: number; wait: () => Promise<void> } | null;
  /** Events cross the same abort boundary as the IPC domain. */
  let shutdown: AbortController;
  let sent: { syncProgress: number; installProgress: number; catalogChanged: number };
  /** Counts pre-boundary sends to catch effects after abort. */
  let emitted: { syncProgress: number; installProgress: number; catalogChanged: number };
  let pruneHold: (() => Promise<void>) | null;
  let activateHold: (() => Promise<void>) | null;
  /** Runs between the first revocation check and the content-store write. */
  let duringContentInstall: (() => Promise<void>) | null;
  let deactivateHold: (() => Promise<void>) | null;

  beforeAll(async () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    serverRoot = mkdtempSync(join(tmpdir(), "ave-service-served-"));
    emptyRepo = createFixtureRepo(serverRoot, "empty-seed");
    server = await startGitHttpServer({ root: serverRoot });
    git = await createTestGitRunner();
    fixtureGit = cachedFixtureGit(git.runner, serverRoot, server.origin, join(serverRoot, "command-cache"));
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    for (const seed of marketSeeds.values()) await removeFixtureRepo(seed);
    for (const seed of publishedSeeds.values()) await removeFixtureRepo(seed);
    await removeFixtureRepo(emptyRepo);
    await cleanupTmpDir(serverRoot);
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ave-service-root-"));
    now = AT;
    catalogChanged = 0;
    afterCatalogChanged = null;
    afterSourceSynced = null;
    legacyRuns = [];
    legacyReport = { bound: [], unmanaged: [], lostGrants: [], failed: [] };
    legacyActivations = { themes: [], locales: [], providers: [] };
    released = [];
    contentReports = [];
    adopting = [];
    feeds = [];
    feedFails = false;
    helperAnswers = false;
    warnings = [];
    progress = [];
    feedCalls = 0;
    feedHold = null;
    shutdown = new AbortController();
    sent = { syncProgress: 0, installProgress: 0, catalogChanged: 0 };
    emitted = { syncProgress: 0, installProgress: 0, catalogChanged: 0 };
    pruneHold = null;
    activateHold = null;
    duringContentInstall = null;
    deactivateHold = null;
    await build();
  });

  async function build(load: PolicyLoad | PolicySource = policyLoad({}), official?: OfficialMarketplace, runner: Pick<GitRunner, "run" | "preflight"> = fixtureGit) {
    manager = new FakeManager();
    const policy = "check" in load ? load : policySource(load);
    const gate = new NetworkGate({ policy, allowLoopback: true, transport: createPinnedFetch() });
    const marketplaces = join(root, "marketplaces");
    const registry = await SourceRegistry.open({ root: marketplaces, policy, now: () => now, official: official ?? UNREACHABLE_OFFICIAL });
    const events = marketplaceEvents(shutdown.signal, {
      syncProgress: (item) => {
        sent.syncProgress += 1;
        progress.push(item);
      },
      installProgress: () => {
        sent.installProgress += 1;
      },
      catalogChanged: () => {
        sent.catalogChanged += 1;
        catalogChanged += 1;
      },
    });
    const takeHold = async (hold: "prune" | "activate") => {
      const wait = hold === "prune" ? pruneHold : activateHold;
      if (hold === "prune") pruneHold = null;
      else activateHold = null;
      if (wait) await wait();
    };
    const syncer = new SourceSyncer({
      folders: nodeFolders(),
      registry,
      gate,
      runner,
      root: marketplaces,
      now: () => now,
      retainedCommits: async () => {
        await takeHold("prune");
        return new Set();
      },
      onCatalogChanged: (sourceId) => {
        events.onCatalogChanged();
        afterSourceSynced?.(sourceId);
      },
    });
    store = await ContentStore.open({
      root: join(root, "packages"),
      english: {},
      activation: {
        activate: async (_content, _entry, _previous, adopt) => {
          await takeHold("activate");
          adopting.push(adopt);
          return { retired: Promise.resolve() };
        },
        deactivate: async () => { await deactivateHold?.(); },
        approveComponents: async () => {},
      },
      now: () => now,
    });
    const artifacts = new PluginArtifactStore({
      installRoot: join(root, "mcp"),
      cacheRoot: join(root, "mcp", ".cache"),
    });
    const stored = new Map<string, string>();
    const tokens: TokenStore = {
      get: (host) => stored.get(host) ?? null,
      has: (host) => stored.has(host),
      set: async (host, token) => void stored.set(host, token),
      delete: async (host) => void stored.delete(host),
    };
    const installers: InstallerPorts = {
      plugin: {
        list: async () => [],
        installedAuthority: async () => null,
        install: vi.fn(async () => {
          throw new Error("no plugin installs in this suite");
        }),
        baseline: async () => null,
        stagedFiles: () => [],
        componentApprovals: () => [],
        running: () => true,
        retire: vi.fn(async () => {}),
        uninstall: vi.fn(async () => {}),
      },
      content: {
        list: async () => store.list().map((entry) => ({ kind: entry.kind, name: entry.name, version: entry.version, sourceId: entry.origin.sourceId, originCommit: entry.origin.commit, digest: entry.origin.contentSha256 })),
        installedComponents: async (name) => {
          const content = (await store.load()).loaded.find((item) => item.entry.kind === "agent-plugin" && item.entry.name === name)?.content;
          if (content?.kind !== "agent-plugin") throw new Error(`installed agent-plugin ${name} has no verified components`);
          return content.components;
        },
        install: async (staged, options) => {
          await duringContentInstall?.();
          return { action: (await store.install(staged, options)).action };
        },
        baseline: async (kind, name, descriptor) => {
          if (kind === "plugin" || kind === "mcp") throw new Error("not content");
          return store.installedConsent(kind, name, (entry) =>
            descriptor({ sourceId: entry.origin.sourceId, commit: entry.origin.commit, packagePath: entry.origin.packagePath, version: entry.version }));
        },
        installedFiles: async (kind, name) => {
          const found = (await store.load()).loaded.find((item) => item.entry.kind === kind && item.entry.name === name);
          return found ? readPayloadFiles(found.dir) : null;
        },
        installId: async (kind, name) => store.list().find((entry) => entry.kind === kind && entry.name === name)?.origin.installId ?? null,
        componentApprovals: async () => [],
        callsInFlight: async () => false,
        approveComponents: (name, installId, consents) => store.approveComponents(name, installId, consents),
        uninstall: async (kind, name) => {
          if (kind === "plugin" || kind === "mcp") throw new Error("not content");
          await store.uninstall(kind, name, EMPTY_MARKETPLACE_POLICY);
        },
      },
      mcp: new McpInstaller({ recordsPath: join(root, "packages", "mcp-installs.json"), dataRoot: join(root, "mcp-data"), files: artifacts, manager, nodePath: "/usr/bin/node" }),
    };
    pluginPort = installers.plugin;
    service = new MarketplaceService({
      registry,
      syncer,
      git: { commands: runner, credentialHelperFor: async () => helperAnswers, preflight: (remote) => runner.preflight(remote) },
      gate,
      root: marketplaces,
      workRoot: mkdtempSync(join(root, "work-")),
      policy,
      tokens,
      previewTokens: new Map(),
      versionContext: () => ({ appVersion: "0.14.0", platform: process.platform, canaryOptIn: false, installationId: INSTALLATION }),
      installers,
      ladder: { zip: artifacts, limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS, artifacts: NO_ARTIFACT_CACHE },
      mcpLimits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
      folders: { ...nodeFolders(), home: root },
      english: {},
      onCatalogChanged: () => {
        emitted.catalogChanged += 1;
        events.onCatalogChanged();
        afterCatalogChanged?.();
      },
      onSyncProgress: (item) => {
        emitted.syncProgress += 1;
        events.onSyncProgress(item);
      },
      onInstallProgress: (item) => {
        emitted.installProgress += 1;
        events.onInstallProgress(item);
      },
      now: () => now,
      revocations: {
        apply: async (feed) => {
          feedCalls += 1;
          if (feedHold && feedHold.at === feedCalls) await feedHold.wait();
          if (feedFails) throw new Error("revocation registry unwritable");
          feeds.push(feed);
        },
      },
      log: { warn: (message) => void warnings.push(message) },
      legacyMigration: {
        markerPath: join(root, "packages", "legacy-migration.json"),
        plugins: async (officialPlugin) => {
          legacyRuns.push(officialPlugin);
          return legacyReport;
        },
        content: async (ports) => {
          const report = await migrateLegacyContent({
            ...ports,
            activations: legacyActivations,
            release: async (provided) => void released.push(provided),
            log: { warn: () => {} },
          });
          contentReports.push(report);
          return report;
        },
      },
    });
  }

  afterEach(async () => {
    setAppRelaunchRequested(false);
    _resetAveHomePrivacyForTest();
    __resetSandboxRequestedAtBootForTest();
    setProcessPlatform(ORIGINAL_PLATFORM);
    service.close();
    for (const repo of repos) await removeFixtureRepo(repo);
    repos = [];
    await cleanupTmpDir(root);
  });

  function market(skillVersion = "1.0.0", indexName = "acme-tools", options: { theme?: boolean } = {}) {
    counter += 1;
    const name = `market-${counter}`;
    const files = (version: string) => ({
      "marketplace.json": text({
        schemaVersion: 2,
        name: indexName,
        displayName: "Acme Tools",
        packages: [
          { kind: "skill", name: "review", path: "skills/review" },
          { kind: "mcp", name: "notes", path: "mcp/notes" },
          ...(options.theme ? [{ kind: "theme", name: "harbor", path: "themes/harbor" }] : []),
        ],
      }),
      ...(options.theme
        ? {
            "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
            "themes/harbor/theme.json": text({ name: "Harbor", description: "Harbor theme.", shell: "light", highContrast: false, tokens: moonstoneBundle.tokens, surfaces: SURFACES }),
          }
        : {}),
      "skills/review/ave-package.json": descriptor("skill", "review", version, { entry: "SKILL.md" }),
      "skills/review/SKILL.md": skill("review", `Review the change (${version}).`),
      "mcp/notes/ave-package.json": descriptor("mcp", "notes", "2.0.0", { server: { transport: "stdio", command: "npx", args: ["-y", "@acme/notes@2.0.0", "--db", "$DATA_DIR/notes.db"] } }),
    });
    const key = JSON.stringify([skillVersion, indexName, options.theme ?? false]);
    let seed = marketSeeds.get(key);
    if (!seed) {
      seed = copyFixtureRepo(serverRoot, `seed-${counter}`, emptyRepo, { publishByCopy: true });
      seed.commit(files(skillVersion), `publish ${skillVersion}`);
      marketSeeds.set(key, seed);
    }
    // The seed is read-only; every test publishes into its own copied history.
    const repo = copyFixtureRepo(serverRoot, name, seed, { publishByCopy: true });
    repos.push(repo);
    const publish = (version: string) => {
      const head = join(".git", "refs", "heads", "main");
      const key = JSON.stringify([readFileSync(join(repo.work, head), "utf8"), files(version)]);
      const published = publishedSeeds.get(key);
      if (published) {
        const filter = (source: string, target: string) => {
          if (source === join(published.work, ".git", "config")) return false;
          const object = source.startsWith(`${join(published.bare, "objects")}${sep}`) || source.startsWith(`${join(published.work, ".git", "objects")}${sep}`);
          return !(object && existsSync(target) && statSync(source).isFile());
        };
        cpSync(published.bare, repo.bare, { recursive: true, filter });
        cpSync(published.work, repo.work, { recursive: true, filter });
        return readFileSync(join(repo.work, head), "utf8").trim();
      }
      const commit = repo.commit(files(version), `publish ${version}`);
      publishedSeeds.set(key, copyFixtureRepo(serverRoot, `published-${++counter}`, repo));
      return commit;
    };
    return { name, url: server.url(name), publish, repo };
  }

  function createRevocations(market: { repo: FixtureRepo }, revocations: unknown[]) {
    market.repo.commit({ "policy/revocations.json": text({ schemaVersion: 1, revocations }) }, "revoke");
  }

  async function installPackage<Kind extends "skill" | "mcp">(kind: Kind) {
    const source = market();
    await addMarket(source.url);
    const key = { sourceId: "acme-tools", kind, name: kind === "mcp" ? "notes" : "review" };
    await service.executeInstall((await service.planInstall(key)).planId);
    return { source, key };
  }

  async function installedForRemoval(kind: "skill" | "mcp") {
    const { source, key } = await installPackage(kind);
    const recordPath = join(root, "packages", kind === "mcp" ? "mcp-installs.json" : "ledger.json");
    return { source, key, recordPath, before: readFileSync(recordPath, "utf8") };
  }

  it("refuses content uninstall after reservation without changing the installed ledger", async () => {
    const { key, recordPath, before } = await installedForRemoval("skill");
    setAppRelaunchRequested(true);
    await expect(service.uninstall(key)).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(readFileSync(recordPath, "utf8")).toBe(before);
    expect(store.list()).toHaveLength(1);
  });

  it("refuses server uninstall after reservation without changing records or config", async () => {
    const { key, recordPath, before } = await installedForRemoval("mcp");
    setAppRelaunchRequested(true);
    await expect(service.uninstall(key)).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(readFileSync(recordPath, "utf8")).toBe(before);
    expect(manager.configs.has("notes")).toBe(true);
  });

  it("keeps content installed when a catalog sync revokes it after relaunch reservation", async () => {
    const { source, recordPath, before } = await installedForRemoval("skill");
    createRevocations(source, [{ kind: "skill", name: "review", versions: "*", reason: "unsafe", at: AT.toISOString(), action: "uninstall" }]);
    setAppRelaunchRequested(true);
    await service.refresh();
    expect(readFileSync(recordPath, "utf8")).toBe(before);
    expect(service.takeRevocationNotice()?.revoked).toEqual([expect.objectContaining({ outcome: "failed", message: expect.stringMatching(/restart/i) })]);
  });

  it("keeps server records when a catalog sync revokes them after relaunch reservation", async () => {
    const { source, recordPath, before } = await installedForRemoval("mcp");
    createRevocations(source, [{ kind: "mcp", name: "notes", versions: "*", reason: "unsafe", at: AT.toISOString(), action: "uninstall" }]);
    setAppRelaunchRequested(true);
    await service.refresh();
    expect(readFileSync(recordPath, "utf8")).toBe(before);
    expect(manager.configs.has("notes")).toBe(true);
    expect(service.takeRevocationNotice()?.revoked).toEqual([expect.objectContaining({ outcome: "failed", message: expect.stringMatching(/restart/i) })]);
  });

  async function heldRemoval(kind: "skill" | "mcp", revoke: boolean) {
    const { source, key, recordPath, before } = await installedForRemoval(kind);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hold = async () => { entered(); await held; };
    if (kind === "skill") deactivateHold = hold;
    else vi.spyOn(manager, "removeConfig").mockImplementationOnce(async (id) => { await hold(); manager.configs.delete(id); });
    if (revoke) createRevocations(source, [{ kind, name: key.name, versions: "*", reason: "unsafe", at: AT.toISOString(), action: "uninstall" }]);
    const pending = revoke ? service.refresh() : service.uninstall(key);
    await started;
    try {
      expect(hasMarketplaceInstallInFlight()).toBe(true);
      expect(readFileSync(recordPath, "utf8")).toBe(before);
    } finally {
      release();
      await pending;
    }
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  }

  it("keeps relaunch busy across content deactivation and ledger removal", async () => {
    await heldRemoval("skill", false);
  });

  it("keeps relaunch busy across server disconnect and record removal", async () => {
    await heldRemoval("mcp", false);
  });

  it("keeps relaunch busy during catalog content revocation", async () => {
    await heldRemoval("skill", true);
  });

  it("keeps relaunch busy during catalog server revocation", async () => {
    await heldRemoval("mcp", true);
  });

  async function addMarket(url: string) {
    const preview = await service.previewSource({ input: url, auth: "none" });
    expect(preview.type).toBe("marketplace");
    return service.addSource({ previewId: previewIdOf(preview) });
  }

  it("refuses boot installs before legacy migration while relaunch is reserved", async () => {
    const applied = await AppliedDefaults.open(join(root, "packages", "default-installs.json"));
    setAppRelaunchRequested(true);
    await expect(service.applyBootInstalls([], applied)).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(legacyRuns).toEqual([]);
    expect(contentReports).toEqual([]);
    expect(existsSync(join(root, "packages", "legacy-migration.json"))).toBe(false);
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  });

  it("registers boot installs before yielding and releases the reservation on completion", async () => {
    const applied = await AppliedDefaults.open(join(root, "packages", "default-installs.json"));
    const pending = service.applyBootInstalls([], applied);
    try {
      expect(hasMarketplaceInstallInFlight()).toBe(true);
    } finally {
      await pending;
    }
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  });

  it("refuses automatic updates before reading installed state while relaunch is reserved", async () => {
    setAppRelaunchRequested(true);
    await expect(service.applyUpdate({ key: { sourceId: "acme-tools", kind: "language", name: "french" }, from: "1.0.0", to: "2.0.0", switchSource: false }, () => true)).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(feedCalls).toBe(0);
    expect(store.list()).toEqual([]);
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  });

  it("registers automatic updates before yielding and releases superseded work", async () => {
    const pending = service.applyUpdate({ key: { sourceId: "acme-tools", kind: "language", name: "french" }, from: "1.0.0", to: "2.0.0", switchSource: false }, () => true);
    try {
      expect(hasMarketplaceInstallInFlight()).toBe(true);
    } finally {
      await expect(pending).resolves.toEqual({ state: "superseded" });
    }
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  });

  it("returns an install plan while home privacy refuses extension starts", async () => {
    const { url } = market();
    await addMarket(url);
    setProcessPlatform("win32");
    setPluginWorkerConfinementRequestedAtBoot(true);
    setAveHomePrivacyAtBoot({ enforcement: "none", home: root, category: "read-back-failed", reason: "fixture" });
    await expect(service.planInstall({ sourceId: "acme-tools", kind: "skill", name: "review" }))
      .resolves.toMatchObject({ hookConfinement: "user-permissions", version: "1.0.0" });
  });

  it("previews a marketplace, adds it under the suggested id, and lists its packages", async () => {
    await build(policyLoad({}), undefined, git.runner);
    const { url } = market();
    const preview = await service.previewSource({ input: url, auth: "none" });
    expect(preview).toMatchObject({
      type: "marketplace",
      marketplace: { name: "acme-tools", displayName: "Acme Tools" },
      counts: { skill: 1, mcp: 1 },
      codeRunning: 1,
      diagnostics: [],
      credentialHelper: false,
      suggestedId: "acme-tools",
    });
    const added = await service.addSource({ previewId: previewIdOf(preview) });
    expect(added).toMatchObject({ id: "acme-tools", origin: "custom", packageCount: 2, status: { state: "up-to-date" }, canRemove: true });
    await expect(service.addSource({ previewId: previewIdOf(preview) })).rejects.toMatchObject({ code: "PLAN_EXPIRED" });

    const catalog = await service.catalog({});
    expect(catalog.entries.map((entry) => [entry.key.kind, entry.key.name, entry.state]).sort()).toEqual([
      ["mcp", "notes", { state: "install", version: "2.0.0" }],
      ["skill", "review", { state: "install", version: "1.0.0" }],
    ]);
    expect(catalog.counts).toMatchObject({ skill: 1, mcp: 1, plugin: 0 });
    expect((await service.catalog({ kind: "mcp", query: "not" })).entries.map((entry) => entry.key.name)).toEqual(["notes"]);
    expect((await service.catalog({ query: "nothing-matches" })).entries).toEqual([]);
  });

  it("installs a skill from its plan, offers the update after a new publish, and uninstalls it", async () => {
    await build(policyLoad({}), undefined, git.runner);
    const { url, publish } = market();
    await addMarket(url);
    const key = { sourceId: "acme-tools", kind: "skill" as const, name: "review" };
    const plan = await service.planInstall(key);
    expect(plan).toMatchObject({ version: "1.0.0", action: { action: "install" }, runsCode: false, authority: null, mcp: null });
    const changedBefore = catalogChanged;
    await expect(service.executeInstall(plan.planId)).resolves.toEqual({ key, version: "1.0.0", action: { action: "install" }, rungs: [], connectionWarning: null });
    expect(catalogChanged).toBe(changedBefore + 1);
    await expect(service.executeInstall(plan.planId)).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
    expect(store.list().map((entry) => `${entry.kind}:${entry.name}@${entry.version}`)).toEqual(["skill:review@1.0.0"]);
    expect((await service.catalog({ installedOnly: true })).entries.map((entry) => entry.state)).toEqual([{ state: "installed", version: "1.0.0" }]);

    publish("1.1.0");
    await service.refresh("acme-tools");
    expect((await service.catalog({ kind: "skill" })).entries[0]!.state).toEqual({ state: "update", from: "1.0.0", to: "1.1.0" });
    const update = await service.planUpdate(key);
    expect(update).toMatchObject({ from: "1.0.0", version: "1.1.0", action: { action: "replace", direction: "upgrade", from: "1.0.0" }, authorityDelta: null, historyRewritten: null, needsConfirmation: false });
    expect(update.commitRange.from).toMatch(/^[0-9a-f]{40}$/u);
    expect(update.commitRange.to).not.toBe(update.commitRange.from);
    await service.executeInstall(update.planId);
    expect(store.list()[0]!.version).toBe("1.1.0");

    await expect(service.uninstall({ ...key, sourceId: "other" })).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
    await expect(service.uninstall(key)).resolves.toEqual({ key, keptDataDir: null });
    expect(store.list()).toEqual([]);
  });

  it("lists the updates of installed packages, from a hidden source too (design §7.3)", async () => {
    const { url, publish } = market();
    await addMarket(url);
    const key = { sourceId: "acme-tools", kind: "skill" as const, name: "review" };
    await service.executeInstall((await service.planInstall(key)).planId);
    expect(await service.updates()).toEqual([]);

    publish("1.1.0");
    await service.refresh("acme-tools");
    expect(await service.updates()).toEqual([{ key, displayName: "review", from: "1.0.0", to: "1.1.0" }]);

    await service.setEnabled("acme-tools", false);
    expect((await service.catalog({})).entries).toEqual([]);
    expect(await service.updates()).toEqual([{ key, displayName: "review", from: "1.0.0", to: "1.1.0" }]);

    expect((await service.catalog({ installedOnly: true })).entries.map((entry) => [entry.key.name, entry.state])).toEqual([["review", { state: "update", from: "1.0.0", to: "1.1.0" }]]);
    expect((await service.detail(key)).entry.key).toEqual(key);
    await expect(service.planUpdate(key)).rejects.toMatchObject({ code: "SOURCE_DISABLED", message: "source acme-tools is hidden; show it again to install or update from it" });
    await expect(service.planInstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" })).rejects.toMatchObject({ code: "PACKAGE_INCOMPATIBLE" });

    await service.setEnabled("acme-tools", true);
    await service.executeInstall((await service.planUpdate(key)).planId);
    expect(await service.updates()).toEqual([]);
  });

  it("applies a default install from a managed source through the plan, once", async () => {
    const { url } = market();
    service.close();
    await build(policyLoad({ additional: [{ transport: "git", id: "corp", url: normalizeSourceUrl(url), auth: { kind: "none" } }] }));
    await service.refresh();
    const applied = await AppliedDefaults.open(join(root, "packages", "default-installs.json"));
    const defaults = [
      { kind: "skill" as const, name: "review", source: "corp" },
      { kind: "skill" as const, name: "missing", source: "corp" },
    ];

    const first = await service.applyBootInstalls(defaults, applied);
    expect(first.report.installed).toEqual([defaults[0]]);
    expect(first.report.skipped).toEqual([{ key: defaults[1], reason: "corp does not list skill missing" }]);
    expect(first.notice).toEqual({ forYou: [{ sourceId: "corp", kind: "skill", name: "review" }], required: [], unmanaged: [], lostGrants: [], revoked: [] , autoUpdated: [] });
    expect(legacyRuns).toEqual([]);
    expect(store.list().map((entry) => `${entry.kind}:${entry.name}@${entry.origin.sourceId}`)).toEqual(["skill:review@corp"]);

    await service.uninstall({ sourceId: "corp", kind: "skill", name: "review" });
    const second = await service.applyBootInstalls(defaults, applied);
    expect(second.report).toEqual({ installed: [], skipped: [], failed: [] });
    expect(second.notice).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it("tells how far a discovery got: every source, some, or none because the computer is offline (§18.7.1)", async () => {
    const { url } = market();
    service.close();
    await build(policyLoad({ additional: [{ transport: "git", id: "corp", url: normalizeSourceUrl(url), auth: { kind: "none" } }] }));
    await service.refresh("corp");
    const synced = { status: "ok" as const, pinnedCommit: "a".repeat(40), changed: false };
    const offline = { status: "failed" as const, code: "SOURCE_UNREACHABLE" as const, message: "network is unreachable", detail: { reason: "offline" as const }, pinnedCommit: null };
    const dns = { status: "failed" as const, code: "SOURCE_UNREACHABLE" as const, message: "could not resolve", detail: { reason: "dns" as const, host: "corp.example" }, pinnedCommit: null };
    const sync = vi.spyOn(SourceSyncer.prototype, "sync");
    try {
      sync.mockImplementation(async () => synced);
      const all = await service.discover();
      expect(all.result).toBe("ok");
      expect([...all.reached].sort()).toEqual(["corp", OFFICIAL_MARKETPLACE.id].sort());

      sync.mockImplementation(async (id) => (id === "corp" ? dns : synced));
      expect(await service.discover()).toEqual({ result: "partial", reached: [OFFICIAL_MARKETPLACE.id] });

      sync.mockImplementation(async () => offline);
      expect(await service.discover()).toEqual({ result: "offline", reached: [] });

      sync.mockImplementation(async (id) => (id === "corp" ? dns : offline));
      expect(await service.discover()).toEqual({ result: "partial", reached: [] });

      rmSync(join(root, "marketplaces", "corp", "state.json"));
      expect((await service.listSources()).find((item) => item.id === "corp")!.status).toMatchObject({ state: "broken" });
      sync.mockImplementation(async () => offline);
      expect(await service.discover()).toEqual({ result: "partial", reached: [] });
    } finally {
      sync.mockRestore();
    }
  });

  it("migrates existing installs once the official snapshot exists, once, and names what it unlocked", async () => {
    const { url } = market("1.0.0", "ave");
    service.close();
    await build(policyLoad({}), { id: "ave", url, mirrors: [], auth: { kind: "none" } });
    const applied = await AppliedDefaults.open(join(root, "packages", "default-installs.json"));
    legacyReport = { bound: ["meeting"], unmanaged: ["sampleportal"], lostGrants: [{ plugin: "meeting", keys: ["llm.apiKey.openai"] }], failed: [] };

    const before = await service.applyBootInstalls([], applied);
    expect(legacyRuns).toEqual([]);
    expect(before.notice).toBeNull();

    await service.refresh();
    const first = await service.applyBootInstalls([], applied);
    expect(legacyRuns).toHaveLength(1);
    expect(legacyRuns[0]!("review")).toBeNull();
    expect(first.notice).toEqual({ forYou: [], required: [], unmanaged: ["sampleportal"], lostGrants: [{ plugin: "meeting", keys: ["llm.apiKey.openai"] }], revoked: [] , autoUpdated: [] });

    const second = await service.applyBootInstalls([], applied);
    expect(legacyRuns).toHaveLength(1);
    expect(second.notice).toBeNull();
  });

  it("adopts a legacy theme from the official source during the migration, and drops it from the legacy list", async () => {
    const { url } = market("1.0.0", "ave", { theme: true });
    service.close();
    await build(policyLoad({}), { id: "ave", url, mirrors: [], auth: { kind: "none" } });
    await service.refresh();
    const applied = await AppliedDefaults.open(join(root, "packages", "default-installs.json"));
    legacyActivations = { themes: ["harbor", "retired"], locales: [], providers: [] };

    const first = await service.applyBootInstalls([], applied);

    expect(contentReports).toEqual([{ adopted: [{ source: "ave", kind: "theme", name: "harbor" }], failed: [] }]);
    expect(store.list().map((entry) => `${entry.kind}:${entry.name}@${entry.origin.sourceId}`)).toEqual(["theme:harbor@ave"]);
    expect(adopting).toEqual([true]);
    expect(released).toEqual([{ themes: ["harbor"], locales: [] }]);
    expect(first.notice).toBeNull();

    await service.applyBootInstalls([], applied);
    expect(contentReports).toHaveLength(1);
  });

  it("runs the migration again on the next boot while an entry could not be read", async () => {
    const { url } = market("1.0.0", "ave");
    service.close();
    await build(policyLoad({}), { id: "ave", url, mirrors: [], auth: { kind: "none" } });
    await service.refresh();
    const applied = await AppliedDefaults.open(join(root, "packages", "default-installs.json"));
    legacyReport = { bound: [], unmanaged: [], lostGrants: [], failed: [{ plugin: "meeting", message: "plugin.json unreadable" }] };

    await service.applyBootInstalls([], applied);
    legacyReport = { bound: ["meeting"], unmanaged: [], lostGrants: [], failed: [] };
    await service.applyBootInstalls([], applied);
    await service.applyBootInstalls([], applied);
    expect(legacyRuns).toHaveLength(2);
  });

  it.each([false, true])("captures retirement before a failed uninstall or policy lock (locked=%s)", async (locked) => {
    if (locked) await build(policyLoad({ requiredInstalls: [{ kind: "plugin", name: "retired-fixture", source: "acme-tools" }] }));
    const source = market();
    const entry = { kind: "plugin", name: "retired-fixture", versions: "*", appVersions: "0.12.0", reason: "Replaced", at: AT.toISOString(),
      action: "uninstall", successors: { plugins: [{ pluginId: "successor-fixture" }], hostKinds: [] } };
    source.repo.commit({ "policy/revocations-by-app.json": text({ schemaVersion: 1, revocations: [entry] }) }, "retire fixture");
    const installed = { kind: "plugin" as const, name: entry.name, version: "1.0.0", sourceId: "acme-tools", originCommit: null };
    pluginPort.list = async () => [installed];
    let records: Record<string, RetiredPluginConfigRecord> = {};
    const set = vi.fn(async (_key: string, value: typeof records) => { records = structuredClone(value); });
    const retirement = createPluginRetirementPort({ settings: { get: () => structuredClone(records), set, getPluginConfig: () => ({ enabledIntents: ["due"] }) } as never,
      marketplace: { getInstalledConfigManifest: async () => ({ manifest: { id: entry.name } as never, enabled: false, sourceId: "acme-tools" }) },
      wildcard: () => ({}), appVersion: () => "0.12.0" });
    pluginPort.retire = async (name, retain) => retirement.writeIfAbsent(name, await retirement.capture(name, retain));
    const uninstall = vi.fn(async () => {
      expect(records[entry.name]).toMatchObject({ enabled: false, config: { enabledIntents: ["due"] } });
      throw new Error("fixture uninstall failed");
    });
    pluginPort.uninstall = uninstall;
    await addMarket(source.url);
    uninstall.mockClear();
    await service.enforceRevocations();
    const report = service.takeRevocationNotice()?.revoked;
    expect(report).toEqual([expect.objectContaining({ outcome: locked ? "required" : "failed" })]);
    expect(uninstall).toHaveBeenCalledTimes(locked ? 0 : 1);
    const record = records[entry.name]!;
    expect(record).toBeDefined();
    expect(record.successors).toEqual(entry.successors);
    record.consumedBy = ["successor-fixture"];
    const consumed = structuredClone(record);
    set.mockClear();
    await service.enforceRevocations();
    expect(set).not.toHaveBeenCalled();
    expect(records[entry.name]).toEqual(consumed);
  });

  it.each([
    ["disable", "uninstall"], ["uninstall", "uninstall"], ["uninstall", "disable"],
  ] as const)("retains config when unconditional %s overlaps conditional %s", async (plainAction, conditionalAction) => {
    const source = market();
    const entry = { kind: "plugin", name: "retired-fixture", versions: "*", appVersions: "0.12.0", reason: "Replaced", at: AT.toISOString(),
      action: conditionalAction, successors: { plugins: [{ pluginId: "successor-fixture" }], hostKinds: [] } };
    const { successors: _successors, appVersions: _appVersions, ...plain } = entry;
    source.repo.commit({
      "policy/revocations.json": text({ schemaVersion: 1, revocations: [{ ...plain, action: plainAction }] }),
      "policy/revocations-by-app.json": text({ schemaVersion: 1, revocations: [entry] }),
    }, "overlapping policies");
    await addMarket(source.url);
    pluginPort.list = async () => [{ kind: "plugin", name: entry.name, version: "1.0.0", sourceId: "acme-tools", originCommit: null }];
    const retain = { reason: "revoked", sourceId: "acme-tools", successors: entry.successors };
    const retire = vi.fn(async () => {});
    const uninstall = vi.fn(async () => {
      expect(retire).toHaveBeenCalledWith(entry.name, retain);
      pluginPort.list = async () => [];
    });
    pluginPort.retire = retire;
    pluginPort.uninstall = uninstall;
    await service.enforceRevocations();
    expect(uninstall).toHaveBeenCalledExactlyOnceWith(entry.name, retain);
    expect(service.takeRevocationNotice()?.revoked).toEqual([expect.objectContaining({ outcome: "uninstalled" })]);
  });

  it("captures and retains across schema-parsed retirement entries with reordered keys", async () => {
    const source = market();
    const entry = { kind: "plugin", name: "retired-fixture", versions: "*", appVersions: "0.12.0", reason: "Replaced", at: AT.toISOString(),
      action: "uninstall", successors: {
        plugins: [{ pluginId: "successor-fixture", anySource: true }],
        hostKinds: [{ kind: "@host:due-soon", enabled: { key: "disabled", listed: "disabled", values: ["due"] } }],
      } };
    const reordered = { ...entry, appVersions: "0.13.0", successors: {
      hostKinds: [{ enabled: { values: ["due"], listed: "disabled", key: "disabled" }, kind: "@host:due-soon" }],
      plugins: [{ anySource: true, pluginId: "successor-fixture" }],
    } };
    source.repo.commit({ "policy/revocations-by-app.json": text({ schemaVersion: 1, revocations: [entry, reordered] }) }, "equivalent retirement declarations");
    await addMarket(source.url);
    expect(await service.getRetirementEntry(entry.name)).toEqual({ sourceId: "acme-tools", successors: entry.successors });
    pluginPort.list = async () => [{ kind: "plugin", name: entry.name, version: "1.0.0", sourceId: "acme-tools", originCommit: null }];
    const retain = { reason: "revoked", sourceId: "acme-tools", successors: entry.successors };
    const retire = vi.fn(async () => {});
    const uninstall = vi.fn(async () => {
      expect(retire).toHaveBeenCalledExactlyOnceWith(entry.name, retain);
      pluginPort.list = async () => [];
    });
    pluginPort.retire = retire;
    pluginPort.uninstall = uninstall;
    await service.enforceRevocations();
    expect(uninstall).toHaveBeenCalledExactlyOnceWith(entry.name, retain);
    expect(service.takeRevocationNotice()?.revoked).toEqual([expect.objectContaining({ outcome: "uninstalled" })]);
  });

  it.each(["plugin-id", "any-source", "plugin-order"])("rejects conflicting retirement data from one source: %s", async (difference) => {
    const source = market();
    const plugins = [{ pluginId: "successor-fixture", anySource: true }, { pluginId: "second-fixture" }];
    const changed = difference === "plugin-id" ? [{ pluginId: "other-fixture" }, plugins[1]!]
      : difference === "any-source" ? [{ pluginId: "successor-fixture" }, plugins[1]!]
        : [...plugins].reverse();
    const entry = { kind: "plugin", name: "retired-fixture", versions: "*", appVersions: "0.12.0", reason: "Replaced", at: AT.toISOString(),
      action: "uninstall", successors: { plugins, hostKinds: [] } };
    source.repo.commit({ "policy/revocations-by-app.json": text({ schemaVersion: 1, revocations: [entry, { ...entry, successors: { plugins: changed, hostKinds: [] } }] }) }, "conflicting retirement declarations");
    await addMarket(source.url);
    await expect(service.getRetirementEntry(entry.name)).rejects.toThrow("Conflicting plugin retirement entries");
    pluginPort.list = async () => [{ kind: "plugin", name: entry.name, version: "1.0.0", sourceId: "acme-tools", originCommit: null }];
    const retire = vi.fn(async () => {});
    const uninstall = vi.fn(async () => {});
    pluginPort.retire = retire;
    pluginPort.uninstall = uninstall;
    await expect(service.enforceRevocations()).rejects.toThrow("Conflicting plugin retirement entries");
    expect(retire).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
  });

  it("finds retirement authority without an installed predecessor and reports source conflicts", async () => {
    expect(await service.getRetirementEntry("retired-fixture")).toBeNull();
    const entry = { kind: "plugin", name: "retired-fixture", versions: "*", appVersions: "0.12.0", reason: "Replaced", at: AT.toISOString(),
      action: "uninstall", successors: { plugins: [], hostKinds: [] } };
    const first = market();
    first.repo.commit({ "policy/revocations-by-app.json": text({ schemaVersion: 1, revocations: [entry] }) }, "retire fixture");
    await addMarket(first.url);
    expect(await service.getRetirementEntry(entry.name)).toEqual({ sourceId: "acme-tools", successors: entry.successors });
    const second = market("1.0.0", "other-tools");
    second.repo.commit({ "policy/revocations-by-app.json": text({ schemaVersion: 1, revocations: [entry] }) }, "conflicting retirement");
    await addMarket(second.url);
    await expect(service.getRetirementEntry(entry.name)).rejects.toThrow("Conflicting plugin retirement entries");
  });

  it("ignores a renderer-injected retain field and resolves retention only from a host argument", async () => {
    const source = market();
    const entry = { kind: "plugin", name: "retired-fixture", versions: "*", appVersions: "0.12.0", reason: "Replaced", at: AT.toISOString(),
      action: "uninstall", successors: { plugins: [], hostKinds: [] } };
    source.repo.commit({ "policy/revocations-by-app.json": text({ schemaVersion: 1, revocations: [entry] }) }, "retire fixture");
    await addMarket(source.url);
    pluginPort.list = async () => [{ kind: "plugin", name: entry.name, version: "1.0.0", sourceId: "acme-tools", originCommit: null }];
    const uninstall = vi.fn(async () => {});
    pluginPort.uninstall = uninstall;
    const request = { sourceId: "acme-tools", kind: "plugin" as const, name: entry.name, retain: { reason: "superseded" } };
    await service.uninstall(request);
    expect(uninstall).toHaveBeenLastCalledWith(entry.name, undefined);
    await service.uninstall(request, { retain: { reason: "superseded" } });
    expect(uninstall).toHaveBeenLastCalledWith(entry.name, { reason: "superseded", sourceId: "acme-tools", successors: entry.successors });
  });

  it("says which Ave version a chosen version needs (§18.8)", async () => {
    const source = market();
    source.repo.commit(
      { "skills/review/ave-package.json": text({ schemaVersion: 2, kind: "skill", name: "review", version: "2.0.0", minAppVersion: "9.0.0", payload: { entry: "SKILL.md" } }) },
      "needs a newer app",
    );
    await addMarket(source.url);
    const key = { sourceId: "acme-tools", kind: "skill" as const, name: "review" };
    await expect(service.planInstall({ ...key, version: "2.0.0" })).rejects.toMatchObject({
      code: "PACKAGE_INCOMPATIBLE",
      detail: { reason: "min_app_version", name: "review", version: "9.0.0" },
    });
  });

  describe("a legacy grant pin (a digest-only version at the all-zero commit, design §16.3)", () => {
    const NULL_COMMIT = "0".repeat(40);
    const pinVersion = (version: string) => ({
      version,
      commit: NULL_COMMIT,
      minAppVersion: "0.7.0",
      authority: { capabilities: [], requires: { minAppVersion: "0.7.0" } },
      artifact: { release: { repo: "acme/fixturepin", sha256: "a".repeat(64) } },
      yanked: { reason: "Legacy field pin: receipt grant evidence only. Not installable.", at: AT.toISOString() },
      publishedAt: AT.toISOString(),
    });
    async function pinned(versions: (head: string) => unknown[]) {
      const source = market();
      const head = source.repo.commit({ "notes/readme.txt": "fixture\n" }, "a commit a real version can name");
      source.repo.commit({
        "marketplace.json": text({
          schemaVersion: 2,
          name: "acme-tools",
          displayName: "Acme Tools",
          packages: [{ kind: "plugin", name: "fixturepin", path: "plugins/fixturepin", versions: versions(head) }],
        }),
      }, "list fixturepin");
      await addMarket(source.url);
      return { sourceId: "acme-tools", kind: "plugin" as const, name: "fixturepin" };
    }

    it("opens the detail without giving git the all-zero commit, and shows the pin as such", async () => {
      const key = await pinned(() => [pinVersion("0.9.0"), pinVersion("0.8.0")]);
      const detail = await service.detail(key);
      expect(detail.provenance.versionCommit).toBeNull();
      expect(detail.rungs).toEqual([]);
      expect(detail.versions.map((item) => [item.version, item.commit, item.legacyPin, item.excluded.includes("yanked")])).toEqual([
        ["0.9.0", null, true, true],
        ["0.8.0", null, true, true],
      ]);
    });

    it("shows the newest version that has a tree when nothing is offered", async () => {
      const key = await pinned((head) => [
        pinVersion("0.9.0"),
        {
          version: "0.8.0",
          commit: head,
          minAppVersion: "99.0.0",
          authority: { capabilities: [], requires: { minAppVersion: "99.0.0" } },
          artifact: { release: { repo: "acme/fixturepin", sha256: "b".repeat(64) } },
          publishedAt: AT.toISOString(),
        },
      ]);
      const detail = await service.detail(key);
      expect(detail.provenance.versionCommit).not.toBeNull();
      expect(detail.compatibility.minAppVersion).toBe("99.0.0");
      expect(detail.versions.map((item) => [item.version, item.legacyPin])).toEqual([["0.9.0", true], ["0.8.0", false]]);
    });

    it("refuses to plan the pin before any git call", async () => {
      const key = await pinned(() => [pinVersion("0.9.0")]);
      await expect(service.planInstall({ ...key, version: "0.9.0" })).rejects.toMatchObject({ code: "PACKAGE_YANKED" });
    });
  });

  it("uses conditional policies for detail and install/update review", async () => {
    const source = market();
    await addMarket(source.url);
    const key = { sourceId: "acme-tools", kind: "skill" as const, name: "review" };
    const plan = await service.planInstall(key);
    await service.executeInstall(plan.planId);
    source.repo.commit({ "policy/revocations-by-app.json": text({ schemaVersion: 1, revocations: [
      { kind: "skill", name: "review", versions: "*", appVersions: "0.14.0", reason: "Replaced", at: AT.toISOString(), action: "disable", successors: { plugins: [], hostKinds: [] } },
    ] }) }, "conditional policy");
    await service.refresh("acme-tools");
    expect((await service.detail(key)).versions[0]!.excluded).toContain("revoked");
    await expect(service.planInstall({ ...key, version: "1.0.0" })).rejects.toMatchObject({ code: "PACKAGE_REVOKED" });
    await expect(service.planUpdate(key)).rejects.toMatchObject({ code: "PACKAGE_REVOKED" });
  });

  it("feeds each installed package only its own source's revocations (design §10.4)", async () => {
    const acme = market();
    const other = market("1.0.0", "other-tools");
    await addMarket(acme.url);
    await addMarket(other.url);
    await service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "skill", name: "review" })).planId);
    await service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" })).planId);
    expect(feeds.at(-1)).toEqual({ rules: [], unreadable: [] });

    createRevocations(other, [{ kind: "skill", name: "review", versions: "*", reason: "not ours to revoke", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);
    createRevocations(acme, [
      { kind: "skill", name: "review", versions: "<2.0.0", reason: "prompt injection", at: "2026-09-24T00:00:00Z", action: "disable" },
      { kind: "mcp", name: "notes", versions: "=2.0.0", reason: "exfiltrates notes", at: "2026-09-24T00:00:00Z", action: "disable" },
      { kind: "skill", name: "unrelated", versions: "*", reason: "not installed", at: "2026-09-24T00:00:00Z", action: "uninstall" },
    ]);
    const before = feeds.length;
    await service.refresh();
    const fed = feeds[before]!;
    expect(fed.unreadable).toEqual([]);
    expect(fed.rules.map((rule) => `${rule.sourceId}/${rule.kind}/${rule.name}:${rule.action}`).sort()).toEqual([
      "acme-tools/mcp/notes:disable",
      "acme-tools/skill/review:disable",
    ]);

    const { notice } = await service.applyBootInstalls([], await AppliedDefaults.open(join(root, "packages", "default-installs.json")));
    expect(notice?.revoked).toEqual([
      { key: { sourceId: "acme-tools", kind: "mcp", name: "notes" }, version: "2.0.0", reason: "exfiltrates notes", outcome: "uninstalled" },
    ]);
    expect(manager.configs.has("notes")).toBe(false);
    expect(store.list().map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["skill:review"]);
    expect(feeds.at(-1)!.rules.map((rule) => `${rule.kind}/${rule.name}`)).toEqual(["skill/review"]);
  });

  it("keeps a revoked package a requiredInstalls entry locks, and says so", async () => {
    const acme = market();
    service.close();
    await build(policyLoad({ requiredInstalls: [{ kind: "mcp", name: "notes", source: "acme-tools" }] }));
    await addMarket(acme.url);
    await service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" })).planId);
    createRevocations(acme, [{ kind: "mcp", name: "notes", versions: "*", reason: "exfiltrates notes", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);
    await service.refresh();

    const { notice } = await service.applyBootInstalls([], await AppliedDefaults.open(join(root, "packages", "default-installs.json")));
    expect(notice?.revoked).toEqual([
      { key: { sourceId: "acme-tools", kind: "mcp", name: "notes" }, version: "2.0.0", reason: "exfiltrates notes", outcome: "required" },
    ]);
    expect(manager.configs.has("notes")).toBe(true);
  });

  it("tells the switches which installed packages are required from the policy and their identity alone, whatever their source's health", async () => {
    const acme = market();
    const required = policyLoad({ requiredInstalls: [{ kind: "mcp", name: "notes", source: "acme-tools" }] });
    service.close();
    await build(required);
    await addMarket(acme.url);
    const notes = { sourceId: "acme-tools", kind: "mcp" as const, name: "notes" };
    const review = { sourceId: "acme-tools", kind: "skill" as const, name: "review" };
    for (const key of [notes, review]) await service.executeInstall((await service.planInstall(key)).planId);
    const requiredNames = async () => {
      const context = await service.autoUpdateContext();
      return {
        acmeReads: context.sources.some((source) => source.id === "acme-tools"),
        installed: context.installed.map((key) => key.name).sort(),
        required: context.installed.filter((key) => requiresPackage(context, key)).map((key) => key.name),
      };
    };
    const withdrawn = policyLoad({});
    const healthy = { acmeReads: true, installed: ["notes", "review"] };
    expect(await requiredNames()).toEqual({ ...healthy, required: ["notes"] });
    service.close();
    await build(withdrawn);
    expect(await requiredNames()).toEqual({ ...healthy, required: [] });
    writeFileSync(join(root, "marketplaces", "acme-tools", "state.json"), "{broken");
    const damaged = { acmeReads: false, installed: ["notes", "review"] };
    expect(await requiredNames()).toEqual({ ...damaged, required: [] });
    service.close();
    await build(required);
    expect(await requiredNames()).toEqual({ ...damaged, required: ["notes"] });
  });

  it("lists each required install it cannot meet, with why, and a same-named install from another source (§10.2)", async () => {
    const acme = market("1.0.0", "acme-tools", { theme: true });
    const beta = market("1.0.0", "beta-tools");
    beta.repo.commit(
      { "skills/review/ave-package.json": text({ schemaVersion: 2, kind: "skill", name: "review", version: "1.0.0", minAppVersion: "9.0.0", payload: { entry: "SKILL.md" } }) },
      "needs a newer app",
    );
    const corp = market("1.0.0", "corp");
    const managed = (id: string, url: string) => ({ transport: "git" as const, id, url: normalizeSourceUrl(url), auth: { kind: "none" as const } });
    const additional = [managed("acme-tools", acme.url), managed("beta-tools", beta.url), managed("corp", corp.url)];
    service.close();
    await build(policyLoad({ additional }));
    await service.refresh("acme-tools");
    await service.refresh("beta-tools");
    await service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" })).planId);
    service.close();
    await build(policyLoad({
      additional,
      requiredInstalls: [
        { kind: "mcp", name: "notes", source: "nowhere" },
        { kind: "theme", name: "harbor", source: "corp" },
        { kind: "plugin", name: "absent", source: "acme-tools" },
        { kind: "skill", name: "review", source: "beta-tools" },
      ],
    }));
    const unmet = (await service.autoUpdateContext()).unmetRequired;
    expect(unmet).toEqual([
      { key: { sourceId: "nowhere", kind: "mcp", name: "notes" }, sourceLabel: "nowhere", reason: "source-missing", minAppVersion: null, installedFrom: { sourceId: "acme-tools", label: "Acme Tools", removal: "sheet" } },
      { key: { sourceId: "corp", kind: "theme", name: "harbor" }, sourceLabel: "corp", reason: "source-unreachable", minAppVersion: null, installedFrom: null },
      { key: { sourceId: "acme-tools", kind: "plugin", name: "absent" }, sourceLabel: "Acme Tools", reason: "not-in-catalog", minAppVersion: null, installedFrom: null },
      { key: { sourceId: "beta-tools", kind: "skill", name: "review" }, sourceLabel: "Acme Tools", reason: "incompatible", minAppVersion: "9.0.0", installedFrom: null },
    ]);
    const boot = await service.applyBootInstalls([], await AppliedDefaults.open(join(root, "packages", "default-installs.json")));
    expect(boot.report.skipped.map((item) => `${item.key.name}: ${item.reason}`)).toEqual([
      "notes: source nowhere is not one of the app's sources",
      "harbor: source corp has no snapshot yet",
      "absent: acme-tools does not list plugin absent",
      "review: needs Ave 9.0.0",
    ]);

    service.close();
    const met = policyLoad({
      additional,
      requiredInstalls: [
        { kind: "mcp", name: "notes", source: "acme-tools" },
        { kind: "theme", name: "harbor", source: "acme-tools" },
      ],
    });
    await build(met);
    expect((await service.autoUpdateContext()).unmetRequired).toEqual([]);
    const installed = await service.applyBootInstalls([], await AppliedDefaults.open(join(root, "packages", "default-installs.json")));
    expect(installed.report).toMatchObject({ installed: [{ kind: "theme", name: "harbor", source: "acme-tools" }], skipped: [], failed: [] });
  });

  it("lists a requirement on a hidden source as unmet, and the boot pass skips it for the same reason (§10.2, §7.3)", async () => {
    const official = market("1.0.0", "ave");
    service.close();
    await build(
      policyLoad({ allowDisablingOfficial: true, requiredInstalls: [{ source: "ave", kind: "skill", name: "review" }] }),
      { id: "ave", url: official.url, mirrors: [], auth: { kind: "none" } },
    );
    await service.refresh("ave");
    expect((await service.autoUpdateContext()).unmetRequired).toEqual([]);
    await service.setEnabled("ave", false);
    // A hidden source cannot satisfy a requirement merely through cached candidates.
    expect((await service.autoUpdateContext()).unmetRequired).toEqual([
      { key: { sourceId: "ave", kind: "skill", name: "review" }, sourceLabel: "Acme Tools", reason: "source-hidden", minAppVersion: null, installedFrom: null },
    ]);
    const boot = await service.applyBootInstalls([], await AppliedDefaults.open(join(root, "packages", "default-installs.json")));
    expect(boot.report).toEqual({ installed: [], skipped: [{ key: { source: "ave", kind: "skill", name: "review" }, reason: "source ave is hidden" }], failed: [] });
    await service.setEnabled("ave", true);
    const shown = await service.applyBootInstalls([], await AppliedDefaults.open(join(root, "packages", "default-installs.json")));
    expect(shown.report.installed).toEqual([{ source: "ave", kind: "skill", name: "review" }]);
    expect((await service.autoUpdateContext()).unmetRequired).toEqual([]);
  });

  it("removes a revoked package under its package lock: a holder of that package finishes first (§10.4, §18.6)", async () => {
    const { source: acme } = await installPackage("skill");
    createRevocations(acme, [{ kind: "skill", name: "review", versions: "*", reason: "prompt injection", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);
    const { promise: held, resolve: release } = deferred<void>();
    const { promise: inside, resolve: entered } = deferred<void>();
    const holder = service.asOneOperation(async () => {
      entered();
      await held;
    }, [{ kind: "skill", name: "review" }]);
    await inside;
    const removal = vi.spyOn(store, "uninstall");
    const fed = feeds.length;
    const refresh = service.refresh();
    while (feeds.length === fed) await new Promise<void>((resolve) => setImmediate(resolve));
    for (let i = 0; i < 50; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(removal).not.toHaveBeenCalled();
    expect(store.list().map((entry) => entry.name)).toEqual(["review"]);
    release();
    await holder;
    await refresh;
    expect(removal).toHaveBeenCalledOnce();
    expect(store.list()).toEqual([]);
  });

  /** Holds enforcement across an update; widened revocations arrive before enforcement obtains the lock. */
  async function reviseWhileRevoking(widened: boolean): Promise<{ removedVersions: string[]; done: Promise<void> }> {
    const { source: acme, key } = await installPackage("skill");
    acme.publish("2.0.0");
    await service.refresh("acme-tools");
    const plan = await service.planInstall(key);
    expect(plan).toMatchObject({ version: "2.0.0" });
    createRevocations(acme, [{ kind: "skill", name: "review", versions: "=1.0.0", reason: "old release unsafe", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);
    const { promise: held, resolve: release } = deferred<void>();
    const { promise: inside, resolve: entered } = deferred<void>();
    feedHold = { at: feedCalls + 1, wait: async () => { entered(); await held; } };
    const refresh = service.refresh("acme-tools");
    await inside;
    const installing = service.executeInstall(plan.planId);
    await vi.waitFor(() => expect((service as unknown as { pendingBindings: Map<string, unknown> }).pendingBindings.size).toBe(1));
    let widening: Promise<void> = Promise.resolve();
    if (widened) {
      createRevocations(acme, [{ kind: "skill", name: "review", versions: "*", reason: "every release unsafe", at: "2026-09-25T00:00:00Z", action: "uninstall" }]);
      const { promise: publishedNew, resolve: published } = deferred<void>();
      afterSourceSynced = () => published();
      widening = service.refresh("acme-tools").then(() => undefined);
      await publishedNew;
    }
    const removedVersions: string[] = [];
    const original = store.uninstall.bind(store);
    vi.spyOn(store, "uninstall").mockImplementation(async (...args) => {
      removedVersions.push(...store.list().filter((item) => item.name === "review").map((item) => item.version));
      return original(...args);
    });
    release();
    return { removedVersions, done: Promise.all([installing, refresh, widening]).then(() => undefined) };
  }

  it("judges a revocation again under the package lock: an update that landed while it waited stays when its version is not revoked (§10.4, §18.6)", async () => {
    const { removedVersions, done } = await reviseWhileRevoking(false);
    await done;
    expect(removedVersions).toEqual([]);
    expect(store.list().map((item) => `${item.name}@${item.version}`)).toEqual(["review@2.0.0"]);
    expect(service.takeRevocationNotice()).toBeNull();
    expect(warnings).toEqual(["revocation of acme-tools/skill/review@1.0.0 skipped: it was replaced by 2.0.0 from acme-tools, which its own source's revocations do not cover"]);
  });

  it("judges a revocation again under the package lock: one its source withdrew while it waited removes nothing (§10.4, §18.6)", async () => {
    const { source: acme } = await installPackage("skill");
    createRevocations(acme, [{ kind: "skill", name: "review", versions: "=1.0.0", reason: "withdrawn rule", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);
    const { promise: held, resolve: release } = deferred<void>();
    const { promise: inside, resolve: entered } = deferred<void>();
    const holder = service.asOneOperation(async () => { entered(); await held; }, [{ kind: "skill", name: "review" }]);
    await inside;
    const removal = vi.spyOn(store, "uninstall");
    const before = feeds.length;
    const first = service.refresh("acme-tools");
    // Real syncs can exceed the default wait on slow Windows disks.
    await vi.waitFor(() => expect(feeds.length).toBeGreaterThan(before), { timeout: 20_000 });
    createRevocations(acme, []);
    const { promise: publishedNew, resolve: published } = deferred<void>();
    afterSourceSynced = () => published();
    const second = service.refresh("acme-tools");
    await publishedNew;
    release();
    await Promise.all([holder, first, second]);
    expect(removal).not.toHaveBeenCalled();
    expect(store.list().map((item) => `${item.name}@${item.version}`)).toEqual(["review@1.0.0"]);
    expect(service.takeRevocationNotice()).toBeNull();
    expect(warnings).toEqual(["revocation of acme-tools/skill/review@1.0.0 skipped: its source no longer revokes it"]);
  });

  it("keeps an install whose source's revocations cannot be read when its turn comes, and says so, not that the rule was withdrawn (§10.4, §18.6)", async () => {
    const { source: acme } = await installPackage("skill");
    createRevocations(acme, [{ kind: "skill", name: "review", versions: "=1.0.0", reason: "still revoked", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);
    const { promise: held, resolve: release } = deferred<void>();
    const { promise: inside, resolve: entered } = deferred<void>();
    const holder = service.asOneOperation(async () => { entered(); await held; }, [{ kind: "skill", name: "review" }]);
    await inside;
    const removal = vi.spyOn(store, "uninstall");
    const before = feeds.length;
    const refresh = service.refresh("acme-tools");
    // Real syncs can exceed the default wait on slow Windows disks.
    await vi.waitFor(() => expect(feeds.length).toBeGreaterThan(before), { timeout: 20_000 });
    const syncer = (service as unknown as { options: { syncer: { readRevocations: (...args: unknown[]) => Promise<unknown> } } }).options.syncer;
    vi.spyOn(syncer, "readRevocations").mockRejectedValueOnce(new Error("snapshot is not valid JSON"));
    release();
    await Promise.all([holder, refresh]);
    expect(removal).not.toHaveBeenCalled();
    expect(store.list().map((item) => `${item.name}@${item.version}`)).toEqual(["review@1.0.0"]);
    expect(service.takeRevocationNotice()).toBeNull();
    expect(warnings).toEqual(["revocation of acme-tools/skill/review@1.0.0 skipped: its source's revocation rules could not be read; it is kept until they can be"]);
  });

  it("refuses a plan whose version its source revoked after the plan was made (§10.4, §18.6)", async () => {
    const acme = market();
    await addMarket(acme.url);
    const key = { sourceId: "acme-tools", kind: "skill" as const, name: "review" };
    const plan = await service.planInstall(key);
    expect(plan).toMatchObject({ version: "1.0.0" });
    createRevocations(acme, [{ kind: "skill", name: "review", versions: "=1.0.0", reason: "prompt injection", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);
    await service.refresh("acme-tools");
    await expect(service.executeInstall(plan.planId)).rejects.toMatchObject({ code: "PACKAGE_REVOKED" });
    expect(store.list()).toEqual([]);
  });

  it("skips a revocation whose install was removed while it waited for the package lock (§10.4, §18.6)", async () => {
    const { source: acme, key } = await installPackage("skill");
    createRevocations(acme, [{ kind: "skill", name: "review", versions: "*", reason: "prompt injection", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);
    const { promise: held, resolve: release } = deferred<void>();
    const { promise: inside, resolve: entered } = deferred<void>();
    const holder = service.asOneOperation(async (lease) => {
      entered();
      await held;
      await service.uninstallInstalled(key, { lease });
    }, [{ kind: "skill", name: "review" }]);
    await inside;
    const removal = vi.spyOn(store, "uninstall");
    const fed = feeds.length;
    const refresh = service.refresh();
    while (feeds.length === fed) await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await holder;
    await refresh;
    expect(removal).toHaveBeenCalledOnce();
    expect(store.list()).toEqual([]);
    expect(service.takeRevocationNotice()).toBeNull();
    expect(warnings).toEqual(["revocation of acme-tools/skill/review@1.0.0 skipped: it was removed before its turn"]);
  });

  it("removes the install that landed while a revocation waited when its own version is revoked too, and reports that version (§10.4, §18.6)", async () => {
    const { removedVersions, done } = await reviseWhileRevoking(true);
    await done;
    expect(removedVersions).toEqual(["2.0.0"]);
    expect(store.list()).toEqual([]);
    expect(service.takeRevocationNotice()?.revoked).toEqual([
      { key: { sourceId: "acme-tools", kind: "skill", name: "review" }, version: "2.0.0", reason: "every release unsafe", outcome: "uninstalled" },
    ]);
    expect(warnings).toEqual([]);
  });

  it("expires a reviewed update whose package was removed before it ran: the review judged the install then (§18.6, §18.7.3)", async () => {
    const { source: acme, key } = await installPackage("skill");
    acme.publish("2.0.0");
    await service.refresh("acme-tools");
    const review = await service.planUpdate(key);
    expect(review).toMatchObject({ from: "1.0.0", version: "2.0.0" });
    await service.uninstall(key);
    await expect(service.executeInstall(review.planId, [], true)).rejects.toMatchObject({ code: "PLAN_EXPIRED", detail: { reason: "package-changed" } });
    expect(store.list()).toEqual([]);
  });

  it("expires a source switch's plan whose package was updated before it ran: the switch was decided on the install then (§10.2, §18.6)", async () => {
    const acme = market();
    const other = market("1.1.0", "other-tools");
    await addMarket(acme.url);
    await addMarket(other.url);
    const key = { sourceId: "acme-tools", kind: "skill" as const, name: "review" };
    await service.executeInstall((await service.planInstall(key)).planId);
    const switching = await service.planInstall({ sourceId: "other-tools", kind: "skill", name: "review", switchSource: true });
    acme.publish("2.0.0");
    await service.refresh("acme-tools");
    await service.executeInstall((await service.planInstall(key)).planId);
    await expect(service.executeInstall(switching.planId)).rejects.toMatchObject({ code: "PLAN_EXPIRED", detail: { reason: "package-changed" } });
    expect(store.list().map((item) => `${item.name}@${item.version}:${item.origin.sourceId}`)).toEqual(["review@2.0.0:acme-tools"]);
  });

  it("judges a package mid-switch by the source it moves to, in every feed while it moves", async () => {
    const acme = market();
    const other = market("1.1.0", "other-tools");
    await addMarket(acme.url);
    await addMarket(other.url);
    await service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "skill", name: "review" })).planId);
    createRevocations(acme, [{ kind: "skill", name: "review", versions: "*", reason: "prompt injection", at: "2026-09-24T00:00:00Z", action: "disable" }]);
    await service.refresh();
    expect(feeds.at(-1)!.rules.map((rule) => `${rule.sourceId}/${rule.name}`)).toEqual(["acme-tools/review"]);

    const plan = await service.planInstall({ sourceId: "other-tools", kind: "skill", name: "review", switchSource: true });
    let fedMidSwitch: RevocationFeed | undefined;
    duringContentInstall = async () => {
      await service.enforceRevocations();
      fedMidSwitch = feeds.at(-1);
    };
    await service.executeInstall(plan.planId);

    expect(fedMidSwitch).toEqual({ rules: [], unreadable: [] });
    expect(store.list().map((entry) => `${entry.name}@${entry.version}:${entry.origin.sourceId}`)).toEqual(["review@1.1.0:other-tools"]);
    expect(feeds.at(-1)).toEqual({ rules: [], unreadable: [] });
    expect(service.takeRevocationNotice()).toBeNull();
  });

  it("feeds the gates again after an uninstall, and logs a failed feed after a finished install", async () => {
    const acme = market("1.0.0", "acme-tools", { theme: true });
    await addMarket(acme.url);
    await service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "skill", name: "review" })).planId);
    createRevocations(acme, [{ kind: "skill", name: "review", versions: "*", reason: "prompt injection", at: "2026-09-24T00:00:00Z", action: "disable" }]);
    await service.refresh();
    expect(feeds.at(-1)!.rules).toHaveLength(1);

    await service.uninstall({ sourceId: "acme-tools", kind: "skill", name: "review" });
    expect(feeds.at(-1)).toEqual({ rules: [], unreadable: [] });

    // A feed failure after the install commits must not reject the completed install.
    duringContentInstall = async () => {
      feedFails = true;
    };
    await expect(service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "theme", name: "harbor" })).planId)).resolves.toMatchObject({
      key: { sourceId: "acme-tools", kind: "theme", name: "harbor" },
    });
    expect(store.list().map((entry) => entry.name)).toEqual(["harbor"]);
    expect(warnings).toEqual([expect.stringContaining("revocation feed after theme harbor install failed")]);
  });

  it("removes what a sync revokes at once, and queues its notice once", async () => {
    const acme = market();
    await addMarket(acme.url);
    await service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" })).planId);
    createRevocations(acme, [{ kind: "mcp", name: "notes", versions: "*", reason: "exfiltrates notes", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);

    await service.refresh();
    expect(manager.configs.has("notes")).toBe(false);
    expect(service.takeRevocationNotice()).toEqual({
      forYou: [],
      required: [],
      unmanaged: [],
      lostGrants: [],
      revoked: [{ key: { sourceId: "acme-tools", kind: "mcp", name: "notes" }, version: "2.0.0", reason: "exfiltrates notes", outcome: "uninstalled" }],
      autoUpdated: [],
    });
    expect(service.takeRevocationNotice()).toBeNull();
    const { notice } = await service.applyBootInstalls([], await AppliedDefaults.open(join(root, "packages", "default-installs.json")));
    expect(notice?.revoked ?? []).toEqual([]);
  });

  it("removes a revoked package when the requiredInstalls entry for it names another source", async () => {
    const acme = market();
    service.close();
    await build(policyLoad({ requiredInstalls: [{ kind: "mcp", name: "notes", source: "other-tools" }] }));
    await addMarket(acme.url);
    await service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" })).planId);
    createRevocations(acme, [{ kind: "mcp", name: "notes", versions: "*", reason: "exfiltrates notes", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);

    await service.refresh();
    expect(manager.configs.has("notes")).toBe(false);
    expect(service.takeRevocationNotice()?.revoked).toEqual([
      { key: { sourceId: "acme-tools", kind: "mcp", name: "notes" }, version: "2.0.0", reason: "exfiltrates notes", outcome: "uninstalled" },
    ]);
  });

  it("expires a plan after ten minutes", async () => {
    const { url } = market();
    await addMarket(url);
    const plan = await service.planInstall({ sourceId: "acme-tools", kind: "skill", name: "review" });
    now = new Date(AT.getTime() + 10 * 60 * 1000 + 1);
    await expect(service.executeInstall(plan.planId)).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
    expect(store.list()).toEqual([]);
  });

  it("shows the MCP command in the plan and installs exactly that, keeping $DATA_DIR on uninstall", async () => {
    const { url } = market();
    await addMarket(url);
    const plan = await service.planInstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" });
    expect(plan.mcp).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/notes@2.0.0", "--db", "$DATA_DIR/notes.db"],
      url: null,
      env: [],
      usesDataDir: true,
    });
    expect(plan.runsCode).toBe(true);
    await service.executeInstall(plan.planId);
    // `$DATA_DIR` is replaced in the author's text, so the rest of the path keeps its `/`.
    expect(manager.configs.get("notes")).toMatchObject({ command: "npx", args: ["-y", "@acme/notes@2.0.0", "--db", `${join(root, "mcp-data", "notes")}/notes.db`] });
    await expect(service.uninstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" })).resolves.toEqual({
      key: { sourceId: "acme-tools", kind: "mcp", name: "notes" },
      keptDataDir: join(root, "mcp-data", "notes"),
    });
    expect(manager.configs.has("notes")).toBe(false);
  });

  it("refuses to plan an MCP server the governance policy does not allow", async () => {
    const { url } = market();
    await addMarket(url);
    manager.blocked.add("notes");
    await expect(service.planInstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" })).rejects.toMatchObject({ code: "PACKAGE_POLICY_BLOCKED" });
    manager.blocked.add("weather");
    expect(() => service.previewDirectMcp({
      serverJson: JSON.stringify({ name: "io.example/weather", version: "0.3.0", remotes: [{ type: "streamable-http", url: "https://weather.example/mcp" }] }),
    })).toThrow(expect.objectContaining({ code: "PACKAGE_POLICY_BLOCKED" }));
    expect(manager.configs.size).toBe(0);
  });

  it("installs a pasted server.json bound to no source and lists it as unbound until removed", async () => {
    const preview = service.previewDirectMcp({
      serverJson: JSON.stringify({ name: "io.example/weather", version: "0.3.0", remotes: [{ type: "streamable-http", url: "https://weather.example/mcp" }] }),
    });
    expect(preview).toMatchObject({ name: "weather", version: "0.3.0", runtime: { transport: "http", url: "https://weather.example/mcp" }, options: { packages: 0, remotes: 1 } });
    await expect(service.executeInstall(preview.planId)).resolves.toEqual({ key: { sourceId: null, kind: "mcp", name: "weather" }, version: null, action: { action: "install" }, rungs: [], connectionWarning: null });
    expect((await service.catalog({ installedOnly: true })).entries).toEqual([
      expect.objectContaining({ key: { sourceId: null, kind: "mcp", name: "weather" }, sourceOrigin: null, sourceLabel: null, state: { state: "unbound", version: null }, runsCode: true }),
    ]);
    await expect(service.uninstall({ sourceId: null, kind: "mcp", name: "weather", removeData: true })).resolves.toEqual({
      key: { sourceId: null, kind: "mcp", name: "weather" },
      keptDataDir: null,
    });
    expect((await service.catalog({ installedOnly: true })).entries).toEqual([]);
  });

  it("adds a repository holding one SKILL.md as a direct source with a commit-named version", async () => {
    counter += 1;
    const name = `direct-${counter}`;
    const repo = copyFixtureRepo(serverRoot, name, emptyRepo);
    repos.push(repo);
    const first = repo.commit({ "SKILL.md": skill("summarize", "Summarize the thread.") }, "skill");
    const preview = await service.previewSource({ input: server.url(name), auth: "none" });
    expect(preview).toMatchObject({ type: "package", detectedFrom: "SKILL.md", kind: "skill", name: "summarize", versionSynthesized: true, runsCode: false, subdir: null });
    expect(preview.type === "package" && preview.version).toBe(`0.0.0+g${first.slice(0, 12)}`);
    const added = await service.addSource({ previewId: previewIdOf(preview) });
    expect(added).toMatchObject({ origin: "direct", packageCount: 1 });
    const plan = await service.planInstall({ sourceId: added.id, kind: "skill", name: "summarize" });
    await service.executeInstall(plan.planId);
    expect(store.list().map((entry) => entry.name)).toEqual(["summarize"]);

    repo.commit({ "SKILL.md": skill("summarize", "Summarize the thread briefly.") }, "edit");
    await service.refresh(added.id);
    expect((await service.catalog({ sourceId: added.id })).entries[0]!.state).toMatchObject({ state: "update" });
  });

  it("refuses a repository with neither a marketplace nor a package, and removes its preview clone", async () => {
    counter += 1;
    const name = `empty-${counter}`;
    const repo = copyFixtureRepo(serverRoot, name, emptyRepo);
    repos.push(repo);
    repo.commit({ "README.md": "nothing here\n" }, "readme");
    await expect(service.previewSource({ input: server.url(name), auth: "none" })).rejects.toMatchObject({ code: "SOURCE_NOT_A_MARKETPLACE" });
    const { readdirSync, existsSync } = await import("node:fs");
    const previews = join(root, "marketplaces", ".previews");
    expect(existsSync(previews) ? readdirSync(previews) : []).toEqual([]);
  });

  describe("a source an earlier build stored under a credential-shaped id (§18.8)", () => {
    // Assembled here so no whole token sits in the source.
    const TOKEN = `glp${"at-"}${"abcd1234".repeat(3)}`;

    /** Reopens legacy token-shaped source ids with surviving installs and server configs. */
    async function storeUnderToken(options: {
      ledger?: boolean;
      mcpRecords?: boolean;
      state?: (state: Record<string, unknown>) => Record<string, unknown>;
      snapshot?: (snapshot: Record<string, unknown>) => Record<string, unknown>;
    } = {}): Promise<string> {
      const configs = new Map(manager.configs);
      service.close();
      const list = join(root, "marketplaces", "sources.json");
      writeFileSync(list, readFileSync(list, "utf8").replaceAll('"acme-tools"', JSON.stringify(TOKEN)));
      const moved = join(root, "marketplaces", TOKEN);
      renameSync(join(root, "marketplaces", "acme-tools"), moved);
      for (const file of readdirSync(join(moved, "snapshots"))) {
        const path = join(moved, "snapshots", file);
        writeFileSync(path, readFileSync(path, "utf8").replace('"sourceId":"acme-tools"', `"sourceId":${JSON.stringify(TOKEN)}`));
        if (options.snapshot) writeFileSync(path, JSON.stringify(options.snapshot(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)));
      }
      if (options.state) {
        const statePath = join(moved, "state.json");
        writeFileSync(statePath, JSON.stringify(options.state(JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>)));
      }
      if (options.ledger) {
        const ledger = join(root, "packages", "ledger.json");
        writeFileSync(ledger, readFileSync(ledger, "utf8").replaceAll('"acme-tools"', JSON.stringify(TOKEN)));
      }
      if (options.mcpRecords) {
        const records = join(root, "packages", "mcp-installs.json");
        writeFileSync(records, readFileSync(records, "utf8").replaceAll('"acme-tools"', JSON.stringify(TOKEN)));
      }
      await build();
      for (const [id, config] of configs) manager.configs.set(id, config);
      return moved;
    }

    function filesUnder(dir: string): Record<string, string> {
      const files: Record<string, string> = {};
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        files[path.slice(dir.length)] = readFileSync(path).toString("base64");
      }
      return files;
    }

    it("refuses accepting its reviewed history, by handle or by stored id, before the pin, the pending review or a snapshot moves", async () => {
      const m = market();
      await addMarket(m.url);
      const first = JSON.parse(readFileSync(join(root, "marketplaces", "acme-tools", "state.json"), "utf8")).pinnedCommit as string;
      const second = m.publish("2.0.0");
      await service.refresh("acme-tools");
      const moved = await storeUnderToken({ state: (state) => ({ ...state, pinnedCommit: first, pendingRewrite: { candidate: second, seenAt: AT.toISOString() } }) });
      const handle = (await service.listSources()).find((source) => source.status.state === "id-holds-credential")!.id;
      const before = filesUnder(moved);
      for (const id of [handle, TOKEN]) {
        await expect(service.acceptRewrite(id, second)).rejects.toMatchObject({ code: "SOURCE_ID_INVALID", detail: { reason: "stored-id-holds-credential" } });
        expect(filesUnder(moved), id).toEqual(before);
      }
      const state = JSON.parse(readFileSync(join(moved, "state.json"), "utf8"));
      expect(state).toMatchObject({ pinnedCommit: first, pendingRewrite: { candidate: second } });
    });

    it("names it by its row's handle when the same repository is added again, so Show <id> opens that row", async () => {
      const m = market();
      await addMarket(m.url);
      await storeUnderToken();
      const handle = (await service.listSources()).find((source) => source.status.state === "id-holds-credential")!.id;
      const preview = await service.previewSource({ input: m.url, auth: "none" });
      const error = await service.addSource({ previewId: previewIdOf(preview), id: "again" }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "SOURCE_ID_TAKEN", detail: { reason: "repository-already-added", existingId: handle } });
      expect(String((error as Error).message)).toContain(handle);
      expect(JSON.stringify({ message: (error as Error).message, detail: (error as { detail: unknown }).detail })).not.toContain(TOKEN);
    });

    it.each(["disable", "uninstall"] as const)("enforces a %s revocation its cached snapshot carries on a server installed from it", async (action) => {
      const { scrubMarketplaceStrings } = await import("../../errors.js");
      const m = market();
      await addMarket(m.url);
      await service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" })).planId);
      expect(manager.configs.has("notes")).toBe(true);
      const records = join(root, "packages", "mcp-installs.json");
      await storeUnderToken({
        mcpRecords: true,
        snapshot: (snapshot) => ({ ...snapshot, revocations: [{ kind: "mcp", name: "notes", versions: "=2.0.0", reason: "unsafe server", at: AT.toISOString(), action }] }),
      });
      expect(readFileSync(records, "utf8")).toContain(JSON.stringify(TOKEN));
      expect(manager.configs.has("notes")).toBe(true);
      expect((await service.listSources()).some((source) => source.status.state === "id-holds-credential")).toBe(true);

      await service.enforceRevocations();

      expect(manager.configs.has("notes")).toBe(false);
      expect(readFileSync(records, "utf8")).not.toContain('"notes"');
      const notice = service.takeRevocationNotice();
      expect(notice?.revoked).toEqual([{ key: { sourceId: expect.stringMatching(/^ave-legacy-[0-9a-f]{32}$/u), kind: "mcp", name: "notes" }, version: "2.0.0", reason: "unsafe server", outcome: "uninstalled" }]);
      expect(JSON.stringify(notice)).not.toContain(TOKEN);
      expect(scrubMarketplaceStrings(notice)).toEqual(notice);
      await expect(service.uninstall({ ...notice!.revoked[0]!.key, removeData: false })).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
    });

    it("refuses an update plan for a package installed from it, by handle or by stored id, for the declared reason and before reading what is installed", async () => {
      const m = market();
      await addMarket(m.url);
      await service.executeInstall((await service.planInstall({ sourceId: "acme-tools", kind: "skill", name: "review" })).planId);
      await storeUnderToken({ ledger: true });
      const handle = (await service.catalog({ installedOnly: true })).entries.find((entry) => entry.key.name === "review")!.key.sourceId!;
      expect(handle).toMatch(/^ave-legacy-[0-9a-f]{32}$/u);
      const lists = vi.spyOn(pluginPort, "list");
      for (const sourceId of [handle, TOKEN]) {
        await expect(service.planUpdate({ sourceId, kind: "skill", name: "review" })).rejects.toMatchObject({
          code: "SOURCE_ID_INVALID",
          detail: { reason: "stored-id-holds-credential" },
        });
      }
      expect(lists).not.toHaveBeenCalled();
    });

    it.each([
      ["while its source is listed", false],
      ["after its source is removed", true],
    ])("lets a skill installed from it be uninstalled through the key its row carries, %s", async (_label, removeFirst) => {
      const { scrubMarketplaceStrings } = await import("../../errors.js");
      const m = market();
      await addMarket(m.url);
      const plan = await service.planInstall({ sourceId: "acme-tools", kind: "skill", name: "review" });
      await service.executeInstall(plan.planId);
      expect(store.list()).toHaveLength(1);
      const moved = await storeUnderToken({ ledger: true });
      expect(store.list()[0]!.origin.sourceId).toBe(TOKEN);
      if (removeFirst) {
        const row = (await service.listSources()).find((source) => source.status.state === "id-holds-credential")!;
        await expect(service.removeSource(row.id)).resolves.toMatchObject({ orphanedPackages: [{ sourceId: row.id, kind: "skill", name: "review" }] });
        expect(existsSync(moved)).toBe(false);
        expect(store.list()).toHaveLength(1);
      }
      const raw = await service.catalog({ installedOnly: true });
      expect(JSON.stringify(raw)).not.toContain(TOKEN);
      const answer = scrubMarketplaceStrings(raw);
      const entry = answer.entries.find((item) => item.key.name === "review")!;
      expect(entry.key.sourceId).toMatch(/^ave-legacy-[0-9a-f]{32}$/u);
      expect(JSON.stringify(answer)).not.toContain(TOKEN);
      await expect(service.uninstall({ sourceId: "[REDACTED:TOKEN]", kind: "skill", name: "review" })).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
      expect(store.list()).toHaveLength(1);
      await expect(service.uninstall({ ...entry.key, sourceId: entry.key.sourceId! })).resolves.toMatchObject({ key: entry.key });
      expect(store.list()).toHaveLength(0);
    });
  });

  it("removes a source and lists what it installed as source-removed", async () => {
    const { url } = market();
    await addMarket(url);
    const plan = await service.planInstall({ sourceId: "acme-tools", kind: "skill", name: "review" });
    await service.executeInstall(plan.planId);
    await expect(service.removeSource("acme-tools")).resolves.toEqual({ orphanedPackages: [{ sourceId: "acme-tools", kind: "skill", name: "review" }] });
    expect((await service.listSources()).map((source) => source.id)).not.toContain("acme-tools");
    expect((await service.catalog({ installedOnly: true })).entries).toEqual([
      expect.objectContaining({ key: { sourceId: "acme-tools", kind: "skill", name: "review" }, state: { state: "source-removed", version: "1.0.0" } }),
    ]);
    await expect(service.removeSource(OFFICIAL_MARKETPLACE.id)).rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED" });
  });

  it("repairs an official source whose state file went missing, keeps its installs, and follows no link inside (§18.8)", async () => {
    const { url } = market("1.0.0", "ave");
    service.close();
    await build(policyLoad({}), { id: "ave", url, mirrors: [], auth: { kind: "none" } });
    await service.refresh("ave");
    const key = { sourceId: "ave", kind: "skill" as const, name: "review" };
    await service.executeInstall((await service.planInstall(key)).planId);
    const sourceDir = join(root, "marketplaces", "ave");
    rmSync(join(sourceDir, "state.json"));
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "canary"), "kept\n");
    symlinkSync(outside, join(sourceDir, "snapshots", "linked"), process.platform === "win32" ? "junction" : "dir");

    const damaged = { reason: "state-missing", sourceId: "ave" };
    expect((await service.listSources()).find((item) => item.id === "ave")!.status).toEqual({
      state: "broken",
      message: "state.json of source ave is missing while its synced data remains",
      detail: damaged,
    });
    await expect(service.refresh("ave")).rejects.toMatchObject({ code: "SOURCE_LOCAL_DATA_DAMAGED", detail: damaged });

    const repaired = (await service.repairSource("ave")).find((item) => item.id === "ave")!;
    expect(repaired).toMatchObject({ status: { state: "up-to-date" }, packageCount: 2, pinnedCommit: expect.stringMatching(/^[0-9a-f]{40}$/u) });
    expect(readFileSync(join(outside, "canary"), "utf8")).toBe("kept\n");
    expect(existsSync(join(sourceDir, "snapshots", "linked"))).toBe(false);
    expect(store.list().map((entry) => `${entry.origin.sourceId}:${entry.kind}:${entry.name}@${entry.version}`)).toEqual(["ave:skill:review@1.0.0"]);
    expect((await service.catalog({ installedOnly: true })).entries.map((entry) => [entry.key, entry.state])).toEqual([[key, { state: "installed", version: "1.0.0" }]]);
  });

  it("repairs a damaged snapshot keeping the pin, the hidden switch and sources.json", async () => {
    const { url } = market();
    await addMarket(url);
    await service.setEnabled("acme-tools", false);
    const before = (await service.listSources()).find((item) => item.id === "acme-tools")!;
    const sourcesFile = readFileSync(join(root, "marketplaces", "sources.json"), "utf8");
    writeFileSync(join(root, "marketplaces", "acme-tools", "snapshots", `${before.pinnedCommit}.json`), "{ not json");

    expect((await service.listSources()).find((item) => item.id === "acme-tools")!.status).toMatchObject({
      state: "broken",
      detail: { reason: "snapshot-invalid", sourceId: "acme-tools" },
    });
    const repaired = (await service.repairSource("acme-tools")).find((item) => item.id === "acme-tools")!;
    expect(repaired).toMatchObject({ status: { state: "up-to-date" }, pinnedCommit: before.pinnedCommit, enabled: false, packageCount: 2 });
    expect(readFileSync(join(root, "marketplaces", "sources.json"), "utf8")).toBe(sourcesFile);
    expect(readdirSync(join(root, "marketplaces", "acme-tools", "snapshots"))).toEqual([`${before.pinnedCommit}.json`]);
  });

  it("says a repair that could not move the damaged copy aside failed, without a home path", async () => {
    const { url } = market();
    await addMarket(url);
    rmSync(join(root, "marketplaces", "acme-tools", "state.json"));
    const busy = Object.assign(new Error(`EBUSY: resource busy or locked, rename '${join(root, "marketplaces", "acme-tools")}'`), { code: "EBUSY" });
    const removal = vi.spyOn(SourceRegistry.prototype as unknown as { moveAside(from: string, to: string): Promise<void> }, "moveAside").mockRejectedValueOnce(busy);
    try {
      const failure = await service.repairSource("acme-tools").then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        code: "SOURCE_LOCAL_DATA_DAMAGED",
        message: "could not move the downloaded copy of source acme-tools aside (EBUSY)",
        detail: { reason: "repair-failed-unpinned", sourceId: "acme-tools" },
      });
    } finally {
      removal.mockRestore();
    }
    expect((await service.listSources()).find((item) => item.id === "acme-tools")!.status).toMatchObject({ state: "broken", detail: { reason: "state-missing" } });
    await expect(service.repairSource("acme-tools")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "acme-tools", status: { state: "up-to-date" } })]));
  });

  it("asks before contacting an http address, stores exactly what was confirmed, and asks again when the host turns internal (§18.5)", async () => {
    let answers: readonly string[] = ["127.0.0.1"];
    const lookups: string[] = [];
    const pinned = await createTestGitRunner({
      lookup: async (host) => {
        lookups.push(host);
        return answers;
      },
    });
    try {
      await build(policyLoad({}), undefined, pinned.runner);
      const run = vi.spyOn(pinned.runner, "run");
      const { url } = market();
      // Only the pinned resolver knows this host, exposing any unpinned connection.
      const named = url.replace("127.0.0.1", "market.test");
      server.seen.length = 0;

      const asked = await service.previewSource({ input: named, auth: "none" });
      expect(asked).toEqual({ type: "confirm", warnings: [{ warning: "unencrypted", host: "market.test", address: null }] });
      expect(run).not.toHaveBeenCalled();
      expect(lookups).toEqual([]);
      expect(server.seen).toEqual([]);

      // HTTP cannot consult the credential helper without token-unencrypted consent.
      helperAnswers = true;
      const preview = await service.previewSource({ input: named, auth: "none", acknowledge: ["unencrypted"] });
      expect(preview).toMatchObject({ type: "marketplace", badges: ["unencrypted"], credentialHelper: false });
      const withSignIn = await service.previewSource({ input: named, auth: "none", acknowledge: ["unencrypted", "token-unencrypted"] });
      expect(withSignIn).toMatchObject({ type: "marketplace", credentialHelper: true });
      const added = await service.addSource({ previewId: previewIdOf(preview) });
      expect(added).toMatchObject({ acknowledged: ["unencrypted"], badges: ["unencrypted"], status: { state: "up-to-date" } });
      const stored = JSON.parse(readFileSync(join(root, "marketplaces", "sources.json"), "utf8")) as { sources: Array<{ id: string; acknowledged?: unknown }> };
      expect(stored.sources.find((entry) => entry.id === added.id)?.acknowledged).toEqual({ url: normalizeSourceUrl(named).url, warnings: ["unencrypted"] });

      answers = ["10.0.0.5"];
      server.seen.length = 0;
      const after = (await service.refresh(added.id)).find((item) => item.id === added.id)!;
      expect(after.status).toMatchObject({
        state: "unreachable",
        code: "SOURCE_CONFIRMATION_REQUIRED",
        detail: { reason: "internal-network", host: "market.test", address: "10.0.0.5" },
      });
      expect(server.seen).toEqual([]);

      answers = ["127.0.0.1"];
      const allowed = await service.acknowledgeSource(added.id, ["internal-network"]);
      expect(allowed).toMatchObject({ acknowledged: ["unencrypted", "internal-network"], badges: ["unencrypted", "internal-network"], status: { state: "up-to-date" } });
      expect((await service.catalog({})).entries.find((entry) => entry.key.name === "review")?.sourceBadges).toEqual(["unencrypted", "internal-network"]);
    } finally {
      await pinned.cleanup();
    }
  });

  it("asks for an internal address the one lookup finds before any git command runs", async () => {
    const pinned = await createTestGitRunner({ lookup: async () => ["10.0.0.5"] });
    try {
      await build(policyLoad({}), undefined, pinned.runner);
      const run = vi.spyOn(pinned.runner, "run");
      const { url } = market();
      const asked = await service.previewSource({ input: url.replace("127.0.0.1", "market.test"), auth: "none", acknowledge: ["unencrypted"] });
      expect(asked).toEqual({ type: "confirm", warnings: [{ warning: "internal-network", host: "market.test", address: "10.0.0.5" }] });
      expect(run).not.toHaveBeenCalled();
    } finally {
      await pinned.cleanup();
    }
  });

  it("applies a rewritten policy file to the next operation, and expires a plan made under the old one (§18.6)", async () => {
    const path = join(root, "ave-policy.json");
    const write = (marketplaces: unknown) => writeFileSync(path, JSON.stringify({ version: 1, managed: true, marketplaces }));
    write({});
    await build(await FilePolicySource.open(path));
    const { url } = market();
    const added = await addMarket(url);
    const plan = await service.planInstall({ sourceId: added.id, kind: "skill", name: "review" });

    write({ block: ["host:127.0.0.1"] });
    await expect(service.previewSource({ input: url, auth: "none" })).rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "blocked-by-pattern", pattern: "host:127.0.0.1" } });
    await expect(service.executeInstall(plan.planId)).rejects.toMatchObject({ code: "PLAN_EXPIRED", detail: { reason: "policy-changed" } });
    expect(store.list()).toEqual([]);

    writeFileSync(path, "{ this is not the policy any more, it does not parse }");
    await expect(service.previewSource({ input: url, auth: "none" })).rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "policy-invalid" } });
    write({ requireHttps: false });
    expect(await service.previewSource({ input: url, auth: "none" })).toMatchObject({ type: "marketplace" });
  });

  it("treats a package required from two sources as a policy it cannot read: only the official source works, and the error names both (§12, §18.7.2)", async () => {
    const path = join(root, "ave-policy.json");
    writeFileSync(path, JSON.stringify({ version: 1, managed: true, marketplaces: {
      additional: [{ id: "corp", url: "https://git.corp.example/a" }],
      requiredInstalls: [{ kind: "skill", name: "review", source: "ave" }, { kind: "skill", name: "review", source: "corp" }],
    } }));
    service.close();
    await build(await FilePolicySource.open(path));
    const { url } = market();
    const refused = service.previewSource({ input: url, auth: "none" });
    await expect(refused).rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "policy-invalid" } });
    const error = ((await refused.catch((caught: unknown) => caught)) as MarketplaceError).detail as { error: string };
    expect(error.error).toContain("marketplaces.requiredInstalls[1]: requires skill/review from corp, but marketplaces.requiredInstalls[0] requires it from ave");
    expect((await service.listSources()).map((source) => source.id)).toEqual([OFFICIAL_MARKETPLACE.id]);
    expect((await service.autoUpdateContext()).requiredInstalls).toEqual([]);
  });

  const policyPath = () => join(root, "ave-policy.json");
  const write = (marketplaces: unknown) => writeFileSync(policyPath(), JSON.stringify({ version: 1, managed: true, marketplaces }));

  describe("work an operation leaves behind (§18.6)", () => {
    const gate = () => {
      let open: () => void = () => {};
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { opened, open };
    };

    it("starts the work a catalog change asks for outside the operation, so it reads a policy changed meanwhile", async () => {
      write({});
      await build(await FilePolicySource.open(policyPath()));
      const { url } = market();
      const later = gate();
      let recheck: Promise<unknown> | null = null;
      afterCatalogChanged = () => {
        recheck ??= later.opened.then(() => service.previewSource({ input: url, auth: "none" }));
      };
      await addMarket(url);
      expect(recheck).not.toBeNull();

      write({ block: ["host:127.0.0.1"] });
      later.open();
      await expect(recheck).rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "blocked-by-pattern" } });
    });

    it("starts that work outside the operation even while the operation still runs", async () => {
      write({});
      await build(await FilePolicySource.open(policyPath()));
      const { url } = market();
      let recheck: Promise<unknown> | null = null;
      afterCatalogChanged = () => {
        if (recheck) return;
        write({ block: ["host:127.0.0.1"] });
        recheck = service.previewSource({ input: url, auth: "none" });
      };
      await addMarket(url);
      await expect(recheck).rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "blocked-by-pattern" } });
    });

    it("starts that work as another caller of the package locks, so a package lock it takes waits for the holder whose uninstall reported the change", async () => {
      const { url } = market();
      await addMarket(url);
      const key = { sourceId: "acme-tools", kind: "skill" as const, name: "review" };
      await service.executeInstall((await service.planInstall(key)).planId);
      const order: string[] = [];
      let recheck: Promise<unknown> | null = null;
      afterCatalogChanged = () => {
        // A callback-triggered operation must wait for the existing lease rather than inherit it.
        recheck ??= service.asOneOperation(async () => {
          order.push("recheck holds the package");
          return store.list().length;
        }, [{ kind: "skill", name: "review" }]);
        order.push("change reported");
      };
      await service.asOneOperation(async (lease) => {
        await service.uninstallInstalled(key, { lease });
        for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
        order.push("holder returns");
      }, [{ kind: "skill", name: "review" }]);
      expect(recheck).not.toBeNull();
      await expect(recheck).resolves.toBe(0);
      expect(order).toEqual(["change reported", "holder returns", "recheck holds the package"]);
    });

    it("runs the update check a sync's snapshot starts as its own operation, though it starts before that sync ends and outlives it", async () => {
      const { url, publish } = market();
      service.close();
      const corp = { transport: "git" as const, id: "corp", url: normalizeSourceUrl(url), auth: { kind: "none" as const } };
      const policy = policySource(policyLoad({ additional: [corp] }));
      await build(policy);
      await service.refresh();
      const key = { sourceId: "corp", kind: "skill" as const, name: "review" };
      await service.executeInstall((await service.planInstall(key)).planId);

      let entered: () => void = () => {};
      const checkEntered = new Promise<void>((resolve) => (entered = resolve));
      const published: unknown[] = [];
      const scheduled: BackgroundService = {
        enforceRevocations: (signal) => service.enforceRevocations(signal),
        takeRevocationNotice: () => service.takeRevocationNotice(),
        discover: (signal) => service.discover(signal),
        applyBootInstalls: (defaults, applied, signal) => service.applyBootInstalls(defaults, applied, signal),
        updates: () => {
          entered();
          return service.updates();
        },
        updateCandidates: (reached, signal) => service.updateCandidates(reached, signal),
        autoUpdateContext: (signal) => service.autoUpdateContext(signal),
        applyUpdate: (target, signal) => service.applyUpdate(target, signal),
        appliedState: (key, to) => service.appliedState(key, to),
        callsInFlight: (name) => service.callsInFlight(name),
        approveComponents: (key, installId, consents) => service.approveComponents(key, installId, consents),
      };
      const background = startMarketplaceBackground({
        service: async () => scheduled,
        appliedDefaults: () => AppliedDefaults.open(join(root, "packages", "default-installs.json")),
        defaults: [],
        settings: () => ({ updateNotices: true, updateCheckIntervalMs: 0 }),
        activity: { isBusy: () => false, onIdle: () => () => {} },
        history: { load: async () => ({ history: emptyUpdateHistory(), reset: false as const }), save: async () => {} },
        publishStatus: () => {},
        publishNotice: () => {},
        publishUpdates: (updates) => void published.push(...updates),
        publishUpdateStatus: () => {},
        onResume: () => () => {},
        log: { info: () => {}, warn: () => {} },
      });
      await background.started;
      expect(published).toEqual([]);
      publish("1.1.0");

      let check: Promise<void> | null = null;
      afterSourceSynced = (sourceId) => {
        if (sourceId !== "corp" || check) return;
        policy.change(policyLoad({}));
        check = background.recheck();
      };
      await service.asOneOperation(async () => {
        await service.refresh("corp");
        await checkEntered;
      });
      expect(check).not.toBeNull();
      await check;

      expect(policy.load).toMatchObject({ ok: true, policy: { additional: [] } });
      expect(published).toEqual([]);
      expect(await service.updates()).toEqual([]);
      background.stop();
    });

    it("lets work started inside an operation, still running after it, enter an operation of its own", async () => {
      write({});
      await build(await FilePolicySource.open(policyPath()));
      const { url } = market();
      const later = gate();
      let leftBehind: Promise<unknown> | null = null;
      await service.asOneOperation(async () => {
        leftBehind = later.opened.then(() => service.previewSource({ input: url, auth: "none" }));
      });

      write({ block: ["host:127.0.0.1"] });
      later.open();
      await expect(leftBehind).rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "blocked-by-pattern" } });
    });
  });

  describe("policy refresh under overlapping operations (§12)", () => {

    /** Each policy read can be held after reading, to expose overlapping refreshes. */
    function heldPolicy(file: FilePolicySource) {
      let checks = 0;
      const holds = new Map<number, { entered: () => void; wait: Promise<void> }>();
      const source: PolicySource = {
        get load() {
          return file.load;
        },
        get digest() {
          return file.digest;
        },
        async check() {
          const n = ++checks;
          const update = await file.check();
          const held = holds.get(n);
          if (held) {
            held.entered();
            await held.wait;
          }
          return update;
        },
        apply: (update) => file.apply(update),
      };
      const hold = (n: number) => {
        let release: () => void = () => {};
        let entered: () => void = () => {};
        const wait = new Promise<void>((resolve) => (release = resolve));
        const reached = new Promise<void>((resolve) => (entered = resolve));
        holds.set(n, { entered, wait });
        return { reached, release };
      };
      return { source, hold, checks: () => checks };
    }

    const preview = () =>
      service.previewSource({ input: "http://public.example.test/repo", auth: "none", acknowledge: ["unencrypted"] }).then(
        () => ({ code: "PREVIEWED" }),
        (error: { code?: string; message: string; detail?: { reason?: string } }) => ({ code: error.code ?? error.message, ...(error.detail?.reason ? { reason: error.detail.reason } : {}) }),
      );
    let preflightSpy: { mockRestore(): void } | null = null;
    afterEach(() => {
      // The runner outlives this test; put its preflight back.
      preflightSpy?.mockRestore();
      preflightSpy = null;
    });
    const REACHED_GIT = { code: "reached git" };
    const HTTPS_REQUIRED = { code: "SOURCE_POLICY_BLOCKED", reason: "https-required" };

    async function start(marketplaces: unknown) {
      write(marketplaces);
      const file = await FilePolicySource.open(policyPath());
      const held = heldPolicy(file);
      await build(held.source);
      const preflight = vi.spyOn(git.runner, "preflight").mockRejectedValue(new Error("reached git"));
      preflightSpy = preflight;
      return { file, held, preflight };
    }

    /** Holds each refresh while the next operation arrives, forcing overlapping refreshes. */
    async function overlapping(held: ReturnType<typeof heldPolicy>, rounds: number) {
      let current = held.hold(1);
      const outcomes = [preview()];
      await current.reached;
      for (let n = 2; n <= rounds; n += 1) {
        const next = held.hold(n);
        outcomes.push(preview());
        current.release();
        await next.reached;
        current = next;
      }
      current.release();
      return Promise.all(outcomes);
    }

    it("runs every operation under the policy on disk while each refresh overlaps the next operation", async () => {
      const { file, held, preflight } = await start({ requireHttps: false });
      write({ requireHttps: true });
      expect(await overlapping(held, 9)).toEqual(Array.from({ length: 9 }, () => HTTPS_REQUIRED));
      expect(preflight).not.toHaveBeenCalled();
      expect(file.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
      expect(catalogChanged).toBe(1);
    });

    function scheduler() {
      return startMarketplaceBackground({
        service: async () => service,
        appliedDefaults: () => AppliedDefaults.open(join(root, "packages", "default-installs.json")),
        defaults: [],
        settings: () => ({ updateNotices: true, updateCheckIntervalMs: 0 }),
        activity: { isBusy: () => false, onIdle: () => () => {} },
        history: { load: async () => ({ history: emptyUpdateHistory(), reset: false as const }), save: async () => {} },
        publishStatus: () => {},
        publishNotice: () => {},
        publishUpdates: () => {},
        publishUpdateStatus: () => {},
        onResume: () => () => {},
        log: { info: () => {}, warn: () => {} },
      });
    }

    it("starts no refresh and reads nothing for a Check now queued behind the boot's refresh when the scheduler stops (§18.6)", async () => {
      const { held } = await start({});
      const first = held.hold(1);
      const background = scheduler();
      await first.reached;
      const discover = vi.spyOn(service, "discover");
      const checked = background.checkNow();
      await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
      const listed = vi.spyOn(pluginPort, "list");
      background.stop();
      first.release();
      await background.started;
      await checked;
      expect({ checks: held.checks(), listed: listed.mock.calls.length }).toEqual({ checks: 1, listed: 0 });
    });

    it.each([
      ["discover", (signal: AbortSignal) => service.discover(signal)],
      ["updates", (signal: AbortSignal) => service.updates(signal)],
      ["enforceRevocations", (signal: AbortSignal) => service.enforceRevocations(signal)],
      [
        "applyBootInstalls",
        async (signal: AbortSignal) =>
          service.applyBootInstalls([], await AppliedDefaults.open(join(root, "packages", "default-installs.json")), signal),
      ],
    ] as const)("%s, cancelled while it waits for the policy, starts no refresh and never runs", async (_name, call) => {
      const { held } = await start({});
      const first = held.hold(1);
      const running = service.listSources();
      await first.reached;
      const cancel = new AbortController();
      const outcome = call(cancel.signal).then(
        () => "ran",
        (error: Error) => error.message,
      );
      cancel.abort(new Error("cancelled by its caller"));
      first.release();
      await running;
      expect(await outcome).toBe("cancelled by its caller");
      expect(held.checks()).toBe(1);
    });

    it("lists nothing installed for a recheck that waits for the policy when the scheduler stops (§18.6)", async () => {
      const { held } = await start({});
      const background = scheduler();
      await background.started;
      const next = held.hold(held.checks() + 1);
      const rechecked = background.recheck();
      await next.reached;
      const listed = vi.spyOn(pluginPort, "list");
      background.stop();
      next.release();
      await rechecked;
      expect(listed).not.toHaveBeenCalled();
    });

    it("refuses a caller cancelled before it arrives without reading the policy", async () => {
      const { held } = await start({});
      const cancel = new AbortController();
      cancel.abort(new Error("cancelled by its caller"));
      await expect(service.discover(cancel.signal)).rejects.toThrow("cancelled by its caller");
      expect(held.checks()).toBe(0);
    });

    it("still runs a queued refresh a live caller waits for when the caller that queued it is cancelled", async () => {
      const { held } = await start({});
      const first = held.hold(1);
      const running = service.listSources();
      await first.reached;
      const cancel = new AbortController();
      const cancelled = service.discover(cancel.signal).then(
        () => "discovered",
        (error: Error) => error.message,
      );
      const live = service.listSources();
      cancel.abort(new Error("cancelled by its caller"));
      first.release();
      await running;
      await expect(live).resolves.toBeInstanceOf(Array);
      expect(await cancelled).toBe("cancelled by its caller");
      expect(held.checks()).toBe(2);
    });

    it("applies a policy that became unreadable but says nothing of it once the boot that waits for it is stopped", async () => {
      const { file, held } = await start({});
      writeFileSync(policyPath(), "{ not the policy any more");
      const first = held.hold(1);
      const background = scheduler();
      await first.reached;
      background.stop();
      const before = warnings.length;
      first.release();
      await background.started;
      expect(warnings.slice(before)).toEqual([]);
      // Caller cancellation cannot undo an already-restrictive policy change.
      expect(file.load.ok).toBe(false);
    });

    it.each([
      ["malformed", () => writeFileSync(policyPath(), "{ not the policy any more")],
      [
        "unreadable",
        () => {
          // A directory where the file was: present, but not readable as a file, on every platform.
          rmSync(policyPath());
          mkdirSync(policyPath());
        },
      ],
    ])("fails every overlapping operation closed when the file turns %s, warning once", async (_case, breakFile) => {
      const { file, held, preflight } = await start({ requireHttps: false });
      breakFile();
      expect(await overlapping(held, 9)).toEqual(Array.from({ length: 9 }, () => ({ code: "SOURCE_POLICY_BLOCKED", reason: "policy-invalid" })));
      expect(preflight).not.toHaveBeenCalled();
      expect(file.load.ok).toBe(false);
      expect(warnings.filter((message) => message.startsWith("marketplace policy unreadable"))).toHaveLength(1);
      expect(catalogChanged).toBe(1);
    });

    it("runs an operation that began after the file went strict again under the strict policy, though an older refresh read it permissive", async () => {
      const { file, held, preflight } = await start({ requireHttps: true });
      write({ requireHttps: false });
      const first = held.hold(1);
      const older = preview();
      await first.reached;
      write({ requireHttps: true });
      const newer = preview();
      first.release();
      expect(await older).toEqual(REACHED_GIT);
      expect(await newer).toEqual(HTTPS_REQUIRED);
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(file.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
      expect(held.checks()).toBe(2);
    });

    it("sees a change within the one refresh queued behind the running one, however many operations keep arriving", async () => {
      const { held, preflight } = await start({ requireHttps: false });
      const first = held.hold(1);
      const early = preview();
      await first.reached;
      write({ requireHttps: true });
      const second = held.hold(2);
      const during = [preview(), preview(), preview(), preview()];
      first.release();
      await second.reached;
      const third = held.hold(3);
      const later = [preview(), preview(), preview(), preview()];
      second.release();
      await third.reached;
      third.release();

      expect(await early).toEqual(REACHED_GIT);
      expect(await Promise.all(during)).toEqual(Array.from({ length: 4 }, () => HTTPS_REQUIRED));
      expect(await Promise.all(later)).toEqual(Array.from({ length: 4 }, () => HTTPS_REQUIRED));
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(held.checks()).toBe(3);
    });
  });

  it("stores a token under its normalized host and refuses one that spans lines", async () => {
    await expect(service.setToken("GitHub.com", "ghp_x")).resolves.toEqual({ host: "github.com" });
    await expect(service.setToken("github.com", "a\nb")).rejects.toMatchObject({ code: "SOURCE_AUTH_REQUIRED" });
    await expect(service.deleteToken("github.com")).resolves.toEqual({ host: "github.com" });
  });

  /** Aborting at a service await must prevent all subsequent stages and scheduler effects. */
  const SERVICE_WAITS = [
    ["the boot's enforcement of the revocations on disk", { feed: 1 }],
    ["the discovery's sync", { sync: true }],
    ["the discovery's enforcement", { feed: 2 }],
    ["the boot installs' enforcement", { feed: 3 }],
  ] as const;
  const SERVICE_ROWS = SERVICE_WAITS.flatMap(([name, hold]) => (["fulfils", "rejects"] as const).map((ending) => [name, ending, hold] as const));

  it.each(SERVICE_ROWS)("a stopped scheduler: stopped during %s, which then %s, the service does nothing more", async (_name, ending, hold) => {
    let release: (() => void) | null = null;
    let fail: ((error: Error) => void) | null = null;
    const held = () =>
      new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
    const synced = { status: "ok" as const, pinnedCommit: "a".repeat(40), changed: false };
    let syncHeld = false;
    const sync = vi.spyOn(SourceSyncer.prototype, "sync").mockImplementation(async () => {
      if ("sync" in hold && !syncHeld) {
        syncHeld = true;
        await held();
      }
      return synced;
    });
    if ("feed" in hold) feedHold = { at: hold.feed, wait: held };
    const rows = vi.spyOn(service as unknown as { rows: () => Promise<unknown> }, "rows");
    let saves = 0;
    const history = {
      load: async () => ({ history: emptyUpdateHistory(), reset: false as const }),
      save: async (_history: UpdateHistory) => {
        saves += 1;
      },
    };
    const input = {
      service: async () => service,
      appliedDefaults: () => AppliedDefaults.open(join(root, "packages", "default-installs.json")),
      defaults: [],
      settings: () => ({ updateNotices: true }),
      activity: { isBusy: () => false, onIdle: () => () => {} },
      history,
      publishStatus: vi.fn(),
      publishNotice: vi.fn(),
      publishUpdates: vi.fn(),
      publishUpdateStatus: vi.fn(),
      onResume: () => () => {},
      log: { info: vi.fn(), warn: vi.fn() },
    };
    const background = startMarketplaceBackground(input);
    shutdown.signal.addEventListener("abort", () => background.stop(), { once: true });
    try {
      await vi.waitFor(() => expect(release).not.toBeNull());
      const counts = () => ({
        sent: { ...sent },
        emitted: { syncProgress: emitted.syncProgress, installProgress: emitted.installProgress },
        progress: progress.length,
        syncs: sync.mock.calls.length,
        feeds: feedCalls,
        catalogReads: rows.mock.calls.length,
        saves,
        published: [input.publishStatus, input.publishNotice, input.publishUpdates, input.publishUpdateStatus].map((fn) => fn.mock.calls.length),
        logged: input.log.info.mock.calls.length + input.log.warn.mock.calls.length,
      });
      const before = counts();
      shutdown.abort();
      if (ending === "fulfils") release!();
      else fail!(new Error("shutdown closed the source"));
      await background.started;
      expect(counts()).toEqual(before);
    } finally {
      background.stop();
      sync.mockRestore();
      rows.mockRestore();
    }
  });

  /** In-flight syncs and installs finish durably after shutdown, but their events must not reach the renderer. */
  const REAL_WAITS = [
    ["the official sync's pruning", "prune"],
    ["the boot's default content install", "activate"],
  ] as const;
  const REAL_ROWS = REAL_WAITS.flatMap(([name, hold]) => (["fulfils", "rejects"] as const).map((ending) => [name, ending, hold] as const));

  it.each(REAL_ROWS)("a stopped scheduler over the real syncer: stopped during %s, which then %s, nothing reaches the renderer", async (_name, ending, hold) => {
    const { url } = market("1.0.0", "ave");
    service.close();
    await build(policyLoad({}), { id: "ave", url, mirrors: [], auth: { kind: "none" } });
    let release: (() => void) | null = null;
    let fail: ((error: Error) => void) | null = null;
    const held = () =>
      new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
    if (hold === "prune") pruneHold = held;
    else activateHold = held;
    let saves = 0;
    const appliedPath = join(root, "packages", "default-installs.json");
    const input = {
      service: async () => service,
      appliedDefaults: () => AppliedDefaults.open(appliedPath),
      defaults: [{ kind: "skill" as const, name: "review", source: "ave" }],
      settings: () => ({ updateNotices: true }),
      activity: { isBusy: () => false, onIdle: () => () => {} },
      history: {
        load: async () => ({ history: emptyUpdateHistory(), reset: false as const }),
        save: async (_history: UpdateHistory) => {
          saves += 1;
        },
      },
      publishStatus: vi.fn(),
      publishNotice: vi.fn(),
      publishUpdates: vi.fn(),
      publishUpdateStatus: vi.fn(),
      onResume: () => () => {},
      log: { info: vi.fn(), warn: vi.fn() },
    };
    const background = startMarketplaceBackground(input);
    shutdown.signal.addEventListener("abort", () => background.stop(), { once: true });
    try {
      await vi.waitFor(() => expect(release).not.toBeNull(), { timeout: 20_000 });
      const counts = () => ({
        sent: { ...sent },
        saves,
        published: [input.publishStatus, input.publishNotice, input.publishUpdates, input.publishUpdateStatus].map((fn) => fn.mock.calls.length),
      });
      const before = counts();
      shutdown.abort();
      if (ending === "fulfils") release!();
      else fail!(new Error("shutdown interrupted it"));
      await background.started;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(counts()).toEqual(before);
      if (hold === "activate" && ending === "fulfils") {
        expect(store.list().map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["skill:review"]);
        expect((await AppliedDefaults.open(appliedPath)).get({ kind: "skill", name: "review", source: "ave" })).toMatchObject({ result: "installed" });
      }
    } finally {
      background.stop();
    }
  });

  it("cancels an enforcement queued behind another when its signal aborts while it waits", async () => {
    let releaseFirst: () => void = () => {};
    feedHold = {
      at: 1,
      wait: () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    };
    const first = service.enforceRevocations();
    await vi.waitFor(() => expect(feedCalls).toBe(1));
    const scheduler = new AbortController();
    const admitted = vi.spyOn(service as unknown as { enforceRevocationsNow: (signal?: AbortSignal) => Promise<void> }, "enforceRevocationsNow");
    const queued = service.enforceRevocations(scheduler.signal);
    await vi.waitFor(() => expect(admitted).toHaveBeenCalledOnce());
    const reason = new Error("the update scheduler has stopped");
    scheduler.abort(reason);
    releaseFirst();
    await first;
    await expect(queued).rejects.toBe(reason);
    expect(feedCalls).toBe(1);
  });
});
