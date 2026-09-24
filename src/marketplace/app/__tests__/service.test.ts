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
import { OFFICIAL_MARKETPLACE } from "../../sources/official.js";
import { EMPTY_MARKETPLACE_POLICY } from "../../sources/policy.js";
import { SourceRegistry } from "../../sources/registry.js";
import { SourceSyncer } from "../../sources/sync.js";
import { McpInstaller } from "../mcp-installer.js";
import type { InstallerPorts, TokenStore } from "../ports.js";
import { MarketplaceService } from "../service.js";

const AT = new Date("2026-09-24T00:00:00.000Z");
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
    manager = new FakeManager();
    const policy = policyLoad({});
    const gate = new NetworkGate({ policy, allowLoopback: true });
    const marketplaces = join(root, "marketplaces");
    const registry = await SourceRegistry.open({ root: marketplaces, policy, now: () => now });
    const syncer = new SourceSyncer({ registry, gate, runner: git.runner, root: marketplaces, now: () => now, retainedCommits: async () => new Set() });
    store = await ContentStore.open({ root: join(root, "packages"), english: {}, activation: { activate: async () => {}, deactivate: async () => {} }, now: () => now });
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
      policy: EMPTY_MARKETPLACE_POLICY,
      tokens,
      previewTokens: new Map(),
      versionContext: () => ({ appVersion: "0.14.0", platform: process.platform, canaryOptIn: false, installationId: INSTALLATION }),
      installers,
      ladder: { fetchImpl: fetch, zip: artifacts, limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS },
      mcpLimits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
      english: {},
      onCatalogChanged: () => {
        catalogChanged += 1;
      },
      now: () => now,
    });
  });

  afterEach(() => {
    service.close();
    for (const repo of repos) removeFixtureRepo(repo);
    repos = [];
    rmSync(root, { recursive: true, force: true });
  });

  /** A served marketplace listing a skill and an MCP server. */
  function market(skillVersion = "1.0.0") {
    counter += 1;
    const name = `market-${counter}`;
    const repo = createFixtureRepo(serverRoot, name);
    repos.push(repo);
    const publish = (version: string) =>
      repo.commit(
        {
          "marketplace.json": text({
            schemaVersion: 1,
            name: "acme-tools",
            displayName: "Acme Tools",
            packages: [
              { kind: "skill", name: "review", path: "skills/review" },
              { kind: "mcp", name: "notes", path: "mcp/notes" },
            ],
          }),
          "skills/review/ave-package.json": descriptor("skill", "review", version, { entry: "SKILL.md" }),
          "skills/review/SKILL.md": skill("review", `Review the change (${version}).`),
          "mcp/notes/ave-package.json": descriptor("mcp", "notes", "2.0.0", { server: { transport: "stdio", command: "npx", args: ["-y", "@acme/notes@2.0.0", "--db", "$DATA_DIR/notes.db"] } }),
        },
        `publish ${version}`,
      );
    publish(skillVersion);
    return { name, url: server.url(name), publish };
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
