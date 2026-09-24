/**
 * The marketplace service end to end against served fixture repositories
 * (design §7.2 add flow, §8.1 direct packages, §13 plans, §15 views): what
 * the user previews is what is added, what a plan shows is what installs,
 * a plan is used once, and every install lands in its kind's installer.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { descriptorText as descriptor, jsonText as text } from "../../__tests__/fixtures/package-files.js";
import type { McpServerConfig } from "../../../mcp/types.js";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../../plugins/marketplace-artifact-limits.js";
import { DisabledMarketplaceFetcher } from "../../../plugins/marketplace.js";
import { PluginArtifactStore } from "../../../plugins/plugin-artifact-store.js";
import { createFixtureRepo, type FixtureRepo, type GitHttpServer, removeFixtureRepo, startGitHttpServer } from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { policyLoad } from "../../__tests__/fixtures/policy.js";
import { ContentStore } from "../../content/store.js";
import { NetworkGate } from "../../net/network-gate.js";
import { NO_ARTIFACT_CACHE } from "../../resolve/artifact-cache.js";
import { migrateLegacyContent, type LegacyActivations, type LegacyContentReport } from "../../migration/legacy-content.js";
import type { LegacyPluginReport, OfficialPlugin } from "../../migration/legacy-plugins.js";
import { moonstoneBundle } from "../../../ui/renderer/theme/bundles/moonstone.js";
import { OFFICIAL_MARKETPLACE, type OfficialMarketplace } from "../../sources/official.js";
import { EMPTY_MARKETPLACE_POLICY, type PolicyLoad } from "../../sources/policy.js";
import { AppliedDefaults } from "../../boot-installs/applied.js";
import { normalizeSourceUrl } from "../../net/source-url.js";
import { SourceRegistry } from "../../sources/registry.js";
import { SourceSyncer } from "../../sources/sync.js";
import { McpInstaller } from "../mcp-installer.js";
import type { InstallerPorts, TokenStore } from "../ports.js";
import type { RevocationFeed } from "../revocations.js";
import { MarketplaceService } from "../service.js";

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

describe.skipIf(process.platform === "win32")("MarketplaceService", () => {
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

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-service-served-"));
    server = await startGitHttpServer({ root: serverRoot });
    git = await createTestGitRunner();
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    rmSync(serverRoot, { recursive: true, force: true });
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
    await build();
  });

  /** The service over `root`, under `policy`; a test that needs a managed or a local official source builds again. */
  async function build(policy: PolicyLoad = policyLoad({}), official?: OfficialMarketplace) {
    manager = new FakeManager();
    const gate = new NetworkGate({ policy, allowLoopback: true });
    const marketplaces = join(root, "marketplaces");
    const registry = await SourceRegistry.open({ root: marketplaces, policy, now: () => now, ...(official ? { official } : {}) });
    const syncer = new SourceSyncer({ registry, gate, runner: git.runner, root: marketplaces, now: () => now, retainedCommits: async () => new Set() });
    store = await ContentStore.open({ root: join(root, "packages"), english: {}, activation: { activate: async (_content, _entry, _previous, adopt) => void adopting.push(adopt), deactivate: async () => {} }, now: () => now });
    const artifacts = new PluginArtifactStore({
      installRoot: join(root, "mcp"),
      cacheRoot: join(root, "mcp", ".cache"),
      fetcher: new DisabledMarketplaceFetcher(),
      publicKeys: {},
      tarballCacheBase: null,
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
        uninstall: vi.fn(async () => {}),
      },
      content: {
        list: async () => store.list().map((entry) => ({ kind: entry.kind, name: entry.name, version: entry.version, sourceId: entry.origin.sourceId, originCommit: entry.origin.commit })),
        install: async (staged, options) => ({ action: (await store.install(staged, options)).action }),
        uninstall: async (kind, name) => {
          if (kind === "plugin" || kind === "mcp") throw new Error("not content");
          await store.uninstall(kind, name, EMPTY_MARKETPLACE_POLICY);
        },
      },
      mcp: new McpInstaller({ recordsPath: join(root, "packages", "mcp-installs.json"), dataRoot: join(root, "mcp-data"), files: artifacts, manager, nodePath: "/usr/bin/node" }),
    };
    service = new MarketplaceService({
      registry,
      syncer,
      git: { commands: git.runner, credentialHelperFor: async () => false },
      gate,
      root: marketplaces,
      workRoot: mkdtempSync(join(root, "work-")),
      policy: policy.ok ? policy.policy : EMPTY_MARKETPLACE_POLICY,
      tokens,
      previewTokens: new Map(),
      versionContext: () => ({ appVersion: "0.14.0", platform: process.platform, canaryOptIn: false, installationId: INSTALLATION }),
      installers,
      ladder: { fetchImpl: fetch, zip: artifacts, limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS, artifacts: NO_ARTIFACT_CACHE },
      mcpLimits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
      english: {},
      onCatalogChanged: () => {
        catalogChanged += 1;
      },
      now: () => now,
      revocations: { apply: async (feed) => void feeds.push(feed) },
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

  afterEach(() => {
    service.close();
    for (const repo of repos) removeFixtureRepo(repo);
    repos = [];
    rmSync(root, { recursive: true, force: true });
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
          "marketplace.json": text({
            schemaVersion: 1,
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
    return service.addSource({ previewId: preview.previewId });
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
    const added = await service.addSource({ previewId: preview.previewId });
    expect(added).toMatchObject({ id: "acme-tools", origin: "custom", packageCount: 2, status: { state: "up-to-date" }, canRemove: true });
    // The preview is used up.
    await expect(service.addSource({ previewId: preview.previewId })).rejects.toMatchObject({ code: "PLAN_EXPIRED" });

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
    await service.refresh();
    const fed = feeds.at(-1)!;
    expect(fed.unreadable).toEqual([]);
    expect(fed.rules.map((rule) => `${rule.sourceId}/${rule.kind}/${rule.name}:${rule.action}`).sort()).toEqual([
      "acme-tools/mcp/notes:disable",
      "acme-tools/skill/review:disable",
    ]);

    // The boot pass removes the MCP server (no load gate) and leaves the gated skill installed.
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
    expect(manager.configs.get("notes")).toMatchObject({ command: "npx", args: ["-y", "@acme/notes@2.0.0", "--db", join(root, "mcp-data", "notes", "notes.db")] });
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
    const added = await service.addSource({ previewId: preview.previewId });
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

  it("stores a token under its normalized host and refuses one that spans lines", async () => {
    await expect(service.setToken("GitHub.com", "ghp_x")).resolves.toEqual({ host: "github.com" });
    await expect(service.setToken("github.com", "a\nb")).rejects.toMatchObject({ code: "SOURCE_AUTH_REQUIRED" });
    await expect(service.deleteToken("github.com")).resolves.toEqual({ host: "github.com" });
  });
});
