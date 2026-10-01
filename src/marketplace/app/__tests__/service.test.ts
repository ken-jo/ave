/**
 * The marketplace service end to end against served fixture repositories
 * (design §7.2 add flow, §8.1 direct packages, §13 plans, §15 views): what
 * the user previews is what is added, what a plan shows is what installs,
 * a plan is used once, and every install lands in its kind's installer.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { descriptorText as descriptor, jsonText as text } from "../../__tests__/fixtures/package-files.js";
import type { McpServerConfig } from "../../../mcp/types.js";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../../plugins/marketplace-artifact-limits.js";
import { PluginArtifactStore } from "../../../plugins/plugin-artifact-store.js";
import { createFixtureRepo, type FixtureRepo, type GitHttpServer, removeFixtureRepo, startGitHttpServer } from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
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
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";


/** The preview's id; a confirmation step here is a test failure. */
function previewIdOf(view: SourcePreviewResultView): string {
  if (view.type === "confirm") throw new Error(`preview asked for ${view.warnings.map((item) => item.warning).join(", ")}`);
  return view.previewId;
}

const AT = new Date("2026-09-24T00:00:00.000Z");
const SURFACES = { "surface-sunken": "228 30% 97%", surface: "0 0% 100%", "surface-raised": "0 0% 100%", "surface-overlay": "0 0% 100%", "border-subtle": "228 24% 94%", "border-strong": "228 18% 84%" };
const INSTALLATION = "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b";
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} things.\n---\n${body}\n`;

class FakeManager {
  configs = new Map<string, McpServerConfig>();
  /** Server ids the governance policy refuses. */
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
  let root: string;
  let repos: FixtureRepo[] = [];
  let counter = 0;
  let now: Date;
  let manager: FakeManager;
  let service: MarketplaceService;
  let store: ContentStore;
  let catalogChanged: number;
  let legacyRuns: Array<(name: string) => OfficialPlugin | null>;
  let legacyReport: LegacyPluginReport;
  let legacyActivations: LegacyActivations;
  let released: Array<{ themes: string[]; locales: string[] }>;
  let contentReports: LegacyContentReport[];
  let adopting: boolean[];
  let feeds: RevocationFeed[];
  let feedFails: boolean;
  /** Whether an OS credential helper answers for a host (the preview's note, §9.3). */
  let helperAnswers: boolean;
  let pluginPort: PluginInstallerPort;
  let warnings: string[];
  /** Runs inside a content install, after the plan's first feed and before the store changes. */
  let duringContentInstall: (() => Promise<void>) | null;

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-service-served-"));
    server = await startGitHttpServer({ root: serverRoot });
    git = await createTestGitRunner();
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    await cleanupTmpDir(serverRoot);
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ave-service-root-"));
    now = AT;
    catalogChanged = 0;
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
    duringContentInstall = null;
    await build();
  });

  /** The service over `root`, under `policy`; a test that needs a managed or a local official source builds again. */
  async function build(load: PolicyLoad | PolicySource = policyLoad({}), official?: OfficialMarketplace, runner: GitRunner = git.runner) {
    manager = new FakeManager();
    const policy = "check" in load ? load : policySource(load);
    const gate = new NetworkGate({ policy, allowLoopback: true, transport: createPinnedFetch() });
    const marketplaces = join(root, "marketplaces");
    const registry = await SourceRegistry.open({ root: marketplaces, policy, now: () => now, ...(official ? { official } : {}) });
    const syncer = new SourceSyncer({ registry, gate, runner, root: marketplaces, now: () => now, retainedCommits: async () => new Set() });
    store = await ContentStore.open({ root: join(root, "packages"), english: {}, activation: { activate: async (_content, _entry, _previous, adopt) => void adopting.push(adopt), deactivate: async () => {} }, now: () => now });
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
        retire: vi.fn(async () => {}),
        uninstall: vi.fn(async () => {}),
      },
      content: {
        list: async () => store.list().map((entry) => ({ kind: entry.kind, name: entry.name, version: entry.version, sourceId: entry.origin.sourceId, originCommit: entry.origin.commit })),
        installedComponents: async (name) => {
          const content = (await store.load()).loaded.find((item) => item.entry.kind === "agent-plugin" && item.entry.name === name)?.content;
          if (content?.kind !== "agent-plugin") throw new Error(`installed agent-plugin ${name} has no verified components`);
          return content.components;
        },
        install: async (staged, options) => {
          await duringContentInstall?.();
          return { action: (await store.install(staged, options)).action };
        },
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
      english: {},
      onCatalogChanged: () => {
        catalogChanged += 1;
      },
      now: () => now,
      revocations: {
        apply: async (feed) => {
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
    service.close();
    for (const repo of repos) await removeFixtureRepo(repo);
    repos = [];
    await cleanupTmpDir(root);
  });

  /**
   * A marketplace listing a skill and an MCP server, and the theme `harbor`
   * when `theme`; `indexName` is `ave` when it stands in for the official source.
   */
  function market(skillVersion = "1.0.0", indexName = "acme-tools", options: { theme?: boolean } = {}) {
    counter += 1;
    const name = `market-${counter}`;
    const repo = createFixtureRepo(serverRoot, name);
    repos.push(repo);
    const publish = (version: string) =>
      repo.commit(
        {
          "marketplace.2.json": text({
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
        },
        `publish ${version}`,
      );
    publish(skillVersion);
    return { name, url: server.url(name), publish, repo };
  }

  /** Publish `policy/revocations.json` in a marketplace made by `market`. */
  function createRevocations(market: { repo: FixtureRepo }, revocations: unknown[]) {
    market.repo.commit({ "policy/revocations.json": text({ schemaVersion: 1, revocations }) }, "revoke");
  }

  async function addMarket(url: string) {
    const preview = await service.previewSource({ input: url, auth: "none" });
    expect(preview.type).toBe("marketplace");
    return service.addSource({ previewId: previewIdOf(preview) });
  }

  it("previews a marketplace, adds it under the suggested id, and lists its packages", async () => {
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
    // The preview is used up.
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
    const { url, publish } = market();
    await addMarket(url);
    const key = { sourceId: "acme-tools", kind: "skill" as const, name: "review" };
    const plan = await service.planInstall(key);
    expect(plan).toMatchObject({ version: "1.0.0", action: { action: "install" }, runsCode: false, authority: null, mcp: null });
    const changedBefore = catalogChanged;
    await expect(service.executeInstall(plan.planId)).resolves.toEqual({ key, version: "1.0.0", action: { action: "install" }, rungs: [], connectionWarning: null });
    expect(catalogChanged).toBe(changedBefore + 1);
    // Single use.
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

    // Hidden: the catalog stops listing it, the installed package still hears of its update.
    await service.setEnabled("acme-tools", false);
    expect((await service.catalog({})).entries).toEqual([]);
    expect(await service.updates()).toEqual([{ key, displayName: "review", from: "1.0.0", to: "1.1.0" }]);

    // The Installed view shows it with its update; the browse list does not.
    expect((await service.catalog({ installedOnly: true })).entries.map((entry) => [entry.key.name, entry.state])).toEqual([["review", { state: "update", from: "1.0.0", to: "1.1.0" }]]);
    // The offered update opens; its plan asks for the source to be shown first (§7.3).
    expect((await service.detail(key)).entry.key).toEqual(key);
    await expect(service.planUpdate(key)).rejects.toMatchObject({ code: "SOURCE_DISABLED", message: "source acme-tools is hidden; show it again to install or update from it" });
    // A package the hidden source lists but that is not installed from it is not listed at all.
    await expect(service.planInstall({ sourceId: "acme-tools", kind: "mcp", name: "notes" })).rejects.toMatchObject({ code: "PACKAGE_INCOMPATIBLE" });

    await service.setEnabled("acme-tools", true);
    await service.executeInstall((await service.planUpdate(key)).planId);
    expect(await service.updates()).toEqual([]);
  });

  it("applies a default install from a managed source through the plan, once", async () => {
    const { url } = market();
    service.close();
    await build(policyLoad({ additional: [{ id: "corp", url: normalizeSourceUrl(url), auth: { kind: "none" } }] }));
    await service.refresh();
    const applied = await AppliedDefaults.open(join(root, "packages", "default-installs.json"));
    const defaults = [
      { kind: "skill" as const, name: "review", source: "corp" },
      { kind: "skill" as const, name: "missing", source: "corp" },
    ];

    const first = await service.applyBootInstalls(defaults, applied);
    expect(first.report.installed).toEqual([defaults[0]]);
    expect(first.report.skipped).toEqual([{ key: defaults[1], reason: "corp does not list skill missing" }]);
    expect(first.notice).toEqual({ forYou: [{ sourceId: "corp", kind: "skill", name: "review" }], required: [], unmanaged: [], lostGrants: [], revoked: [] });
    // No official snapshot yet: the migration waits for one.
    expect(legacyRuns).toEqual([]);
    expect(store.list().map((entry) => `${entry.kind}:${entry.name}@${entry.origin.sourceId}`)).toEqual(["skill:review@corp"]);

    // Uninstalling a default is final: the next boot installs nothing.
    await service.uninstall({ sourceId: "corp", kind: "skill", name: "review" });
    const second = await service.applyBootInstalls(defaults, applied);
    expect(second.report).toEqual({ installed: [], updated: [], switched: [], skipped: [], failed: [] });
    expect(second.notice).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it("migrates existing installs once the official snapshot exists, once, and names what it unlocked", async () => {
    const { url } = market("1.0.0", "ave");
    service.close();
    await build(policyLoad({}), { id: "ave", url, mirrors: [], auth: { kind: "none" } });
    const applied = await AppliedDefaults.open(join(root, "packages", "default-installs.json"));
    legacyReport = { bound: ["meeting"], unmanaged: ["orion"], lostGrants: [{ plugin: "meeting", keys: ["llm.apiKey.openai"] }], failed: [] };

    const before = await service.applyBootInstalls([], applied);
    expect(legacyRuns).toEqual([]);
    expect(before.notice).toBeNull();

    await service.refresh();
    const first = await service.applyBootInstalls([], applied);
    expect(legacyRuns).toHaveLength(1);
    // The lookup reads the official snapshot: this fixture lists skills, not plugins.
    expect(legacyRuns[0]!("review")).toBeNull();
    expect(first.notice).toEqual({ forYou: [], required: [], unmanaged: ["orion"], lostGrants: [{ plugin: "meeting", keys: ["llm.apiKey.openai"] }], revoked: [] });

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
    // `retired` is not listed: it stays in the legacy list.
    expect(released).toEqual([{ themes: ["harbor"], locales: [] }]);
    // Adopting content is not news to the user.
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
    // After each install the gates are fed again from what is installed.
    expect(feeds.at(-1)).toEqual({ rules: [], unreadable: [] });

    createRevocations(other, [{ kind: "skill", name: "review", versions: "*", reason: "not ours to revoke", at: "2026-09-24T00:00:00Z", action: "uninstall" }]);
    createRevocations(acme, [
      { kind: "skill", name: "review", versions: "<2.0.0", reason: "prompt injection", at: "2026-09-24T00:00:00Z", action: "disable" },
      { kind: "mcp", name: "notes", versions: "=2.0.0", reason: "exfiltrates notes", at: "2026-09-24T00:00:00Z", action: "disable" },
      { kind: "skill", name: "unrelated", versions: "*", reason: "not installed", at: "2026-09-24T00:00:00Z", action: "uninstall" },
    ]);
    const before = feeds.length;
    await service.refresh();
    // The sync's first feed carries each package's own source's rules.
    const fed = feeds[before]!;
    expect(fed.unreadable).toEqual([]);
    expect(fed.rules.map((rule) => `${rule.sourceId}/${rule.kind}/${rule.name}:${rule.action}`).sort()).toEqual([
      "acme-tools/mcp/notes:disable",
      "acme-tools/skill/review:disable",
    ]);

    // The sync removed the MCP server (no load gate) and left the gated skill installed; the boot notice reports it.
    const { notice } = await service.applyBootInstalls([], await AppliedDefaults.open(join(root, "packages", "default-installs.json")));
    expect(notice?.revoked).toEqual([
      { key: { sourceId: "acme-tools", kind: "mcp", name: "notes" }, version: "2.0.0", reason: "exfiltrates notes", outcome: "uninstalled" },
    ]);
    expect(manager.configs.has("notes")).toBe(false);
    expect(store.list().map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["skill:review"]);
    // What stays installed keeps its rule; the removed server's is gone.
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
      // A sync finishing while the switch runs feeds and enforces again.
      await service.enforceRevocations();
      fedMidSwitch = feeds.at(-1);
    };
    await service.executeInstall(plan.planId);

    // The source being left never judged the package while it moved, and nothing removed it.
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

    // The feed before the install lands; the one after fails. The install is done, so it resolves.
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
    });
    expect(service.takeRevocationNotice()).toBeNull();
    // The boot notice does not repeat what was already reported.
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
    const repo = createFixtureRepo(serverRoot, name);
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

    // A new commit names a new version, and that is an update.
    repo.commit({ "SKILL.md": skill("summarize", "Summarize the thread briefly.") }, "edit");
    await service.refresh(added.id);
    expect((await service.catalog({ sourceId: added.id })).entries[0]!.state).toMatchObject({ state: "update" });
  });

  it("refuses a repository with neither a marketplace nor a package, and removes its preview clone", async () => {
    counter += 1;
    const name = `empty-${counter}`;
    const repo = createFixtureRepo(serverRoot, name);
    repos.push(repo);
    repo.commit({ "README.md": "nothing here\n" }, "readme");
    await expect(service.previewSource({ input: server.url(name), auth: "none" })).rejects.toMatchObject({ code: "SOURCE_NOT_A_MARKETPLACE" });
    const { readdirSync, existsSync } = await import("node:fs");
    const previews = join(root, "marketplaces", ".previews");
    expect(existsSync(previews) ? readdirSync(previews) : []).toEqual([]);
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
    // A link inside the source's directory, to data that is not the marketplace's.
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
    // Refresh cannot help, and says so with the same code.
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
    // Still damaged, still repairable.
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
      // A name the fixture's resolver answers; git cannot resolve it, so every connection goes through the pin.
      const named = url.replace("127.0.0.1", "market.test");
      server.seen.length = 0;

      const asked = await service.previewSource({ input: named, auth: "none" });
      expect(asked).toEqual({ type: "confirm", warnings: [{ warning: "unencrypted", host: "market.test", address: null }] });
      // No git command, no lookup, no request before the answer.
      expect(run).not.toHaveBeenCalled();
      expect(lookups).toEqual([]);
      expect(server.seen).toEqual([]);

      // A helper is configured for the host, but over http without token-unencrypted it is never asked (§7.4).
      helperAnswers = true;
      const preview = await service.previewSource({ input: named, auth: "none", acknowledge: ["unencrypted"] });
      expect(preview).toMatchObject({ type: "marketplace", badges: ["unencrypted"], credentialHelper: false });
      const withSignIn = await service.previewSource({ input: named, auth: "none", acknowledge: ["unencrypted", "token-unencrypted"] });
      expect(withSignIn).toMatchObject({ type: "marketplace", credentialHelper: true });
      const added = await service.addSource({ previewId: previewIdOf(preview) });
      expect(added).toMatchObject({ acknowledged: ["unencrypted"], badges: ["unencrypted"], status: { state: "up-to-date" } });
      const stored = JSON.parse(readFileSync(join(root, "marketplaces", "sources.json"), "utf8")) as { sources: Array<{ id: string; acknowledged?: unknown }> };
      expect(stored.sources.find((entry) => entry.id === added.id)?.acknowledged).toEqual({ url: normalizeSourceUrl(named).url, warnings: ["unencrypted"] });

      // The name now answers an internal address: the sync asks before connecting to it.
      answers = ["10.0.0.5"];
      server.seen.length = 0;
      const after = (await service.refresh(added.id)).find((item) => item.id === added.id)!;
      expect(after.status).toMatchObject({
        state: "unreachable",
        code: "SOURCE_CONFIRMATION_REQUIRED",
        detail: { reason: "internal-network", host: "market.test", address: "10.0.0.5" },
      });
      expect(server.seen).toEqual([]);

      // *Allow…* adds the confirmation and syncs again (the fixture answers on loopback again).
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

    // A file the organization broke leaves only the official source; fixing it brings the rest back.
    writeFileSync(path, "{ this is not the policy any more, it does not parse }");
    await expect(service.previewSource({ input: url, auth: "none" })).rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "policy-invalid" } });
    write({ requireHttps: false });
    expect(await service.previewSource({ input: url, auth: "none" })).toMatchObject({ type: "marketplace" });
  });

  it("never lets a policy check that finished late put back a policy a newer one replaced (§18.6)", async () => {
    const path = join(root, "ave-policy.json");
    const write = (marketplaces: unknown) => writeFileSync(path, JSON.stringify({ version: 1, managed: true, marketplaces }));
    write({});
    const file = await FilePolicySource.open(path);
    // The first check after `hold` is set completes its read, then waits until released.
    let hold: Promise<void> | null = null;
    let reachedHold: () => void = () => {};
    const delayed: PolicySource = {
      get load() {
        return file.load;
      },
      get digest() {
        return file.digest;
      },
      async check() {
        const update = await file.check();
        if (hold) {
          const waiting = hold;
          hold = null;
          reachedHold();
          await waiting;
        }
        return update;
      },
      apply: (update) => file.apply(update),
    };
    await build(delayed);

    write({ allowHttpHosts: ["older.example"] });
    let release: () => void = () => {};
    hold = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (reachedHold = resolve));
    const older = service.listSources();
    await reached;
    // While the older check is held, the file changes again and another operation applies it.
    write({ requireHttps: true });
    await service.listSources();
    expect(file.load).toMatchObject({ ok: true, policy: { requireHttps: true } });

    release();
    await older;
    expect(file.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
  });

  it("keeps a strict policy when a permissive read under the lock finishes after the file went strict again (§12)", async () => {
    const path = join(root, "ave-policy.json");
    const write = (marketplaces: unknown) => writeFileSync(path, JSON.stringify({ version: 1, managed: true, marketplaces }));
    write({ requireHttps: true });
    const file = await FilePolicySource.open(path);
    // Checks are counted; the one numbered `holdAt` completes its read, then waits until released.
    let checks = 0;
    let holdAt = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const waiters = new Map<number, () => void>();
    const checked = (n: number) => new Promise<void>((resolve) => waiters.set(n, resolve));
    const delayed: PolicySource = {
      get load() {
        return file.load;
      },
      get digest() {
        return file.digest;
      },
      async check() {
        const n = ++checks;
        const update = await file.check();
        waiters.get(n)?.();
        if (n === holdAt) await held;
        return update;
      },
      apply: (update) => file.apply(update),
    };
    await build(delayed);

    // Permissive on disk: the older operation's first check sees the change, and its re-read under the
    // exclusive lock reads `requireHttps: false`, then is held before it applies.
    write({ requireHttps: false });
    holdAt = checks + 2;
    const reread = checked(holdAt);
    const older = service.listSources();
    await reread;

    // Strict again before the held read applies. A newer operation looks at the file and finds the policy in force.
    write({ requireHttps: true });
    const look = checked(checks + 1);
    const newer = service.listSources();
    await look;

    release();
    await Promise.all([older, newer]);
    expect(file.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
    // The next operation agrees with the file on disk.
    await service.listSources();
    expect(file.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
  });

  it("stores a token under its normalized host and refuses one that spans lines", async () => {
    await expect(service.setToken("GitHub.com", "ghp_x")).resolves.toEqual({ host: "github.com" });
    await expect(service.setToken("github.com", "a\nb")).rejects.toMatchObject({ code: "SOURCE_AUTH_REQUIRED" });
    await expect(service.deleteToken("github.com")).resolves.toEqual({ host: "github.com" });
  });
});
