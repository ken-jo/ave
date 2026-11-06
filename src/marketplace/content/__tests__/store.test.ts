const trust = vi.hoisted(() => ({ pending: new Set<string>() }));
vi.mock("../../../shared/ave-home-trust.js", async (original) => {
  const actual = await original<typeof import("../../../shared/ave-home-trust.js")>();
  // A path listed here reads as pending review in the home content trust manifest, as a boot would report it.
  const readAveHomeInput = async (path: string) => {
    const input = await actual.readAveHomeInput(path);
    return trust.pending.has(path) && input.status === "trusted" ? { status: "untrusted" as const, bytes: input.bytes, reason: "changed" as const } : input;
  };
  return { ...actual, readAveHomeInput };
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { descriptorText as descriptor, jsonText as text } from "../../__tests__/fixtures/package-files.js";
import { policySource } from "../../__tests__/fixtures/policy.js";
import { aggregateCatalog, type CatalogRow } from "../../catalog/aggregate.js";
import { NetworkGate } from "../../net/network-gate.js";
import { createPinnedFetch } from "../../net/pinned-fetch.js";
import { candidateVersion, planPackage, type PackagePlan } from "../../resolve/descriptor.js";
import { EMPTY_MARKETPLACE_POLICY } from "../../sources/policy.js";
import { SourceRegistry } from "../../sources/registry.js";
import { SourceSyncer } from "../../sources/sync.js";
import type { ParsedContent } from "../kinds.js";
import { ContentLedger, contentLedgerOrigins, type LedgerEntry } from "../ledger.js";
import { ContentStore, stageContentPackage, type ContentActivation } from "../store.js";
import { deriveAgentPluginComponents } from "../agent-plugin-components.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { nodeFolders } from "../../__tests__/fixtures/folder-fs.js";
import { gitAccess } from "../../sources/source-tree.js";
import { agentPluginComponentDigests } from "../../../plugins/contribution-approval-digest.js";
import { UNREACHABLE_OFFICIAL } from "../../__tests__/fixtures/official.js";

const AT = "2026-09-23T00:00:00.000Z";
const INSTALLATION = "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b";
const ENGLISH = { "app.title": "Ave", "chat.send": "Send" };

const instruction = (name: string) => `---\nname: harbor\ndescription: ${name} instructions.\n---\n${name} instructions.\n`;

describe("content package store", () => {
  let serverRoot: string;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let fixtureGit: ReturnType<typeof cachedFixtureGit>;
  let emptyRepo: FixtureRepo;
  let root: string;
  let repos: FixtureRepo[] = [];
  let counter = 0;
  const marketSeeds = new Map<string, { repo: FixtureRepo; first: string }>();
  const seedRepos: FixtureRepo[] = [];
  let activated: Array<{ op: "activate" | "deactivate" | "approve"; key: string; content: ParsedContent | null; previous?: string | null; adopt?: boolean }>;
  let failActivation: boolean;
  let retirement: Promise<void>;

  const activation: ContentActivation = {
    async activate(content, entry, previous, adopt) {
      if (failActivation) throw new Error("settings write failed");
      activated.push({ op: "activate", key: `${entry.kind}:${entry.name}@${entry.version}`, content, previous: previous ? previous.version : null, adopt });
      return { retired: retirement };
    },
    async approveComponents(entry) {
      activated.push({ op: "approve", key: `${entry.kind}:${entry.name}@${entry.version}`, content: null });
    },
    async deactivate(entry, content) {
      activated.push({ op: "deactivate", key: `${entry.kind}:${entry.name}@${entry.version}`, content });
    },
  };

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-content-served-"));
    emptyRepo = createFixtureRepo(serverRoot, "empty-seed");
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
    root = mkdtempSync(join(tmpdir(), "ave-content-root-"));
    activated = [];
    failActivation = false;
    retirement = Promise.resolve();
  });

  afterEach(async () => {
    for (const repo of repos) await removeFixtureRepo(repo);
    repos = [];
    await cleanupTmpDir(root);
  });

  function market(packages: Array<{ kind: string; name: string; path: string }>, files: Record<string, string | Buffer>) {
    const listing = { "marketplace.json": text({ schemaVersion: 2, name: "acme", displayName: "Acme", packages }) };
    const key = JSON.stringify([packages, files]);
    let seed = marketSeeds.get(key);
    if (!seed) {
      const repo = copyFixtureRepo(serverRoot, `seed-${++counter}`, emptyRepo, { publishByCopy: true });
      seedRepos.push(repo);
      seed = { repo, first: repo.commit({ ...listing, ...files }, "publish") };
      marketSeeds.set(key, seed);
    }
    const name = `content-${++counter}`;
    // Only the per-case copy is published again; seeds live through afterAll.
    const repo = copyFixtureRepo(serverRoot, name, seed.repo, { publishByCopy: true });
    repos.push(repo);
    const commit = (patch: Record<string, string | Buffer>) =>
      repo.commit({ ...listing, ...patch }, "publish");
    return { repo, name, commit, first: seed.first };
  }

  async function open(repoName: string, sourceId = "acme", runner = fixtureGit) {
    const policy = policySource({});
    const gate = new NetworkGate({ policy, allowLoopback: true, transport: createPinnedFetch() });
    const marketplaces = mkdtempSync(join(root, "marketplaces-"));
    const registry = await SourceRegistry.open({ root: marketplaces, policy, official: UNREACHABLE_OFFICIAL });
    await registry.add({ id: sourceId, origin: "custom", url: server.url(repoName), auth: { kind: "none" } });
    const syncer = new SourceSyncer({ registry, gate, runner, root: marketplaces, now: () => new Date(AT), retainedCommits: async () => new Set(), folders: nodeFolders() });
    return syncer;
  }

  async function rows(syncer: SourceSyncer, sourceId = "acme"): Promise<CatalogRow[]> {
    expect(await syncer.sync(sourceId)).toMatchObject({ status: "ok" });
    const snapshot = (await syncer.readSnapshot(sourceId))!;
    expect(snapshot.diagnostics).toEqual([]);
    return aggregateCatalog([{ sourceId, sourceOrigin: "custom", snapshot }], { appVersion: "0.14.0", platform: process.platform, canaryOptIn: false, installationId: INSTALLATION });
  }

  async function stage(syncer: SourceSyncer, row: CatalogRow, sourceId = "acme") {
    const plan = planPackage(row, candidateVersion(row));
    return syncer.withRepository(sourceId, ({ repo, remote }) =>
      stageContentPackage(plan, gitAccess(repo, remote, false), { workRoot: join(root, "work"), english: ENGLISH }));
  }

  const harborFiles = () => ({
    "skills/harbor/ave-package.json": descriptor("skill", "harbor", "1.0.0", { entry: "SKILL.md" }),
    "skills/harbor/SKILL.md": instruction("Harbor"),
  });

  const openStore = () => ContentStore.open({ root: join(root, "packages"), english: ENGLISH, activation, now: () => new Date(AT) });
  async function openHarborMarket() {
    const fixture = market([{ kind: "skill", name: "harbor", path: "skills/harbor" }], harborFiles());
    const syncer = await open(fixture.name);
    const store = await openStore();
    return { ...fixture, syncer, store };
  }

  const installs = (kind: string, name: string): string[] => {
    const dir = join(root, "packages", kind, name, ".installs");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };

  it("installs an unchanged agent-plugin tree with its component authority and ledger digest", async () => {
    const pluginJson = text({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "draft-plugin", version: "1.0.0", description: "Draft writing" });
    const skill = "---\nname: draft\ndescription: Draft writing\n---\nWrite a draft.\n";
    const files = [
      { path: "plugin.json", data: Buffer.from(pluginJson) },
      { path: "skills/draft/SKILL.md", data: Buffer.from(skill) },
    ];
    const components = deriveAgentPluginComponents(files);
    const path = "agent-plugins/draft-plugin";
    const { name } = market([{ kind: "agent-plugin", name: "draft-plugin", path }], {
      [`${path}/ave-package.json`]: descriptor("agent-plugin", "draft-plugin", "1.0.0", { manifest: "plugin.json", components }),
      [`${path}/plugin.json`]: pluginJson,
      [`${path}/skills/draft/SKILL.md`]: skill,
    });
    const syncer = await open(name);
    const [row] = await rows(syncer);
    const staged = await stage(syncer, row!);
    const store = await openStore();
    const installed = await store.install(staged);
    expect(installed.entry).toMatchObject({ kind: "agent-plugin", name: "draft-plugin", origin: { contentSha256: staged.contentSha256 } });
    expect((await store.load()).loaded[0]?.content).toMatchObject({ kind: "agent-plugin", components });
    expect(existsSync(join(store.packageDir(installed.entry), "skills", "draft", "SKILL.md"))).toBe(true);
    expect(server.seen.some((request) => request.path.startsWith(`/${name}/`))).toBe(false);
  });

  it.runIf(process.platform !== "win32")("retains an executable package hook through staging and reload", async () => {
    const packagePath = "agent-plugins/hook-plugin";
    const pluginJson = text({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "hook-plugin", version: "1.0.0", description: "Event review" });
    const hooksJson = text({ version: 1, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["./server/hook.sh"] }] }] } });
    const program = "#!/bin/sh\nprintf 'hook-ran\\n'\n";
    const components = deriveAgentPluginComponents([
      { path: "plugin.json", data: Buffer.from(pluginJson) },
      { path: "ai.agent-connector.ave/hooks.json", data: Buffer.from(hooksJson) },
      { path: "server/hook.sh", data: Buffer.from(program), executable: true },
    ]);
    const name = `content-${++counter}`;
    const repo = copyFixtureRepo(serverRoot, name, emptyRepo);
    repos.push(repo);
    repo.commit({}, "seed");
    repo.commitEntries([
      { path: "marketplace.json", mode: "100644", content: text({ schemaVersion: 2, name: "acme", displayName: "Acme", packages: [{ kind: "agent-plugin", name: "hook-plugin", path: packagePath }] }) },
      { path: `${packagePath}/ave-package.json`, mode: "100644", content: descriptor("agent-plugin", "hook-plugin", "1.0.0", { manifest: "plugin.json", components }) },
      { path: `${packagePath}/plugin.json`, mode: "100644", content: pluginJson },
      { path: `${packagePath}/ai.agent-connector.ave/hooks.json`, mode: "100644", content: hooksJson },
      { path: `${packagePath}/server/hook.sh`, mode: "100755", content: program },
    ], "publish");
    const syncer = await open(name, "acme", git.runner);
    const [row] = await rows(syncer);
    const staged = await stage(syncer, row!);
    expect(staged.files.find((file) => file.path === "server/hook.sh")?.executable).toBe(true);
    const store = await openStore();
    const { entry } = await store.install(staged);
    const installed = join(store.packageDir(entry), "server", "hook.sh");
    expect(statSync(installed).mode & 0o111).not.toBe(0);
    expect(execFileSync(installed, { encoding: "utf8" })).toBe("hook-ran\n");
    expect((await store.load()).loaded[0]?.content).toMatchObject({ kind: "agent-plugin", components });
  });

  it("installs a skill, records its origin, reloads it from disk and uninstalls it", async () => {
    const { name, first } = market([{ kind: "skill", name: "harbor", path: "skills/harbor" }], harborFiles());
    const syncer = await open(name, "acme", git.runner);
    const [row] = await rows(syncer);
    const staged = await stage(syncer, row!);
    const store = await openStore();
    const { action, entry } = await store.install(staged);
    expect(action).toEqual({ action: "install" });
    const installId = entry.origin.installId!;
    expect(installId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(entry).toEqual({
      kind: "skill",
      name: "harbor",
      version: "1.0.0",
      origin: {
        sourceId: "acme", sourceOrigin: "custom", commit: first, packagePath: "skills/harbor", version: "1.0.0", contentSha256: staged.contentSha256, installedAt: AT,
        installId, payloadDir: `skill/harbor/.installs/${installId}`,
        consent: { kind: "skill", fields: { minAppVersion: staged.minAppVersion }, unknown: [] },
      },
    });
    expect(store.packageDir(entry)).toBe(join(root, "packages", "skill", "harbor", ".installs", installId));
    expect(existsSync(join(store.packageDir(entry), "SKILL.md"))).toBe(true);
    expect(existsSync(join(store.packageDir(entry), "ave-package.json"))).toBe(false);
    expect(activated.map((call) => [call.key, call.adopt])).toEqual([["skill:harbor@1.0.0", false]]);

    const reopened = await openStore();
    const { loaded, broken } = await reopened.load();
    expect(broken).toEqual([]);
    expect(loaded.map((item) => item.content)).toEqual([staged.content]);
    expect(await contentLedgerOrigins(join(root, "packages", "ledger.json"))()).toEqual([{ kind: "skill", name: "harbor", sourceId: "acme", commit: first }]);

    await expect(reopened.uninstall("skill", "harbor", { ...EMPTY_MARKETPLACE_POLICY, requiredInstalls: [{ kind: "skill", name: "harbor", source: "acme" }] }))
      .rejects.toMatchObject({ code: "PACKAGE_REQUIRED_BY_POLICY" });
    expect(await reopened.uninstall("skill", "harbor", EMPTY_MARKETPLACE_POLICY)).toEqual(entry);
    expect(activated.at(-1)).toMatchObject({ op: "deactivate", key: "skill:harbor@1.0.0", content: staged.content });
    expect(existsSync(join(root, "packages", "skill", "harbor"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "packages", "ledger.json"), "utf8"))).toEqual({ version: 1, packages: [] });
    expect(await reopened.uninstall("skill", "harbor", EMPTY_MARKETPLACE_POLICY)).toBeNull();

    await reopened.install(staged, { adopt: true });
    expect(activated.at(-1)).toMatchObject({ op: "activate", key: "skill:harbor@1.0.0", adopt: true });
  });

  it("replaces an older version in place and removes its directory", async () => {
    const packages = [{ kind: "skill", name: "harbor", path: "skills/harbor" }];
    const { name, commit } = market(packages, harborFiles());
    const syncer = await open(name);
    const store = await openStore();
    const first = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    commit({
      "skills/harbor/ave-package.json": descriptor("skill", "harbor", "1.1.0", { entry: "SKILL.md" }),
      "skills/harbor/SKILL.md": instruction("Harbor Two"),
    });
    // The replaced activation is still draining: its directory stays until it has retired.
    let retire!: () => void;
    retirement = new Promise<void>((resolve) => { retire = resolve; });
    const { action, entry } = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    expect(action).toEqual({ action: "replace", direction: "upgrade", from: "1.0.0" });
    expect(activated.map((call) => call.previous)).toEqual([null, "1.0.0"]);
    expect(existsSync(join(store.packageDir(first.entry), "SKILL.md"))).toBe(true);
    expect(installs("skill", "harbor")).toEqual([first.entry.origin.installId, entry.origin.installId].sort());
    retire();
    await vi.waitFor(() => expect(existsSync(store.packageDir(first.entry))).toBe(false));
    expect(installs("skill", "harbor")).toEqual([entry.origin.installId]);
    expect((await store.load()).loaded[0]!.content).toMatchObject({ name: "harbor", description: "Harbor Two instructions." });
  });

  it("puts the previous install back when activation fails", async () => {
    const { commit, syncer, store } = await openHarborMarket();
    const first = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    commit({ "skills/harbor/ave-package.json": descriptor("skill", "harbor", "1.1.0", { entry: "SKILL.md" }) });
    failActivation = true;
    await expect(store.install(await stage(syncer, (await rows(syncer))[0]!))).rejects.toThrow("settings write failed");
    expect(store.list()).toEqual([first.entry]);
    expect(installs("skill", "harbor")).toEqual([first.entry.origin.installId]);
    expect((await (await openStore()).load()).loaded.map((item) => item.entry)).toEqual([first.entry]);
  });

  it("leaves nothing behind when a first install's activation fails", async () => {
    const { syncer, store } = await openHarborMarket();
    failActivation = true;
    await expect(store.install(await stage(syncer, (await rows(syncer))[0]!))).rejects.toThrow("settings write failed");
    expect(store.list()).toEqual([]);
    expect(installs("skill", "harbor")).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "packages", "ledger.json"), "utf8"))).toEqual({ version: 1, packages: [] });
  });

  it("puts the live directory back when reinstalling the same version fails to activate", async () => {
    const { syncer, store } = await openHarborMarket();
    const first = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    failActivation = true;
    await expect(store.install(await stage(syncer, (await rows(syncer))[0]!))).rejects.toThrow("settings write failed");
    expect(store.list()).toEqual([first.entry]);
    const { loaded, broken } = await (await openStore()).load();
    expect(broken).toEqual([]);
    expect(loaded.map((item) => item.entry)).toEqual([first.entry]);
    expect(installs("skill", "harbor")).toEqual([first.entry.origin.installId]);
  });

  it("rethrows the activation error when the rollback's own ledger write fails too", async () => {
    const { commit, syncer, store } = await openHarborMarket();
    const first = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    commit({ "skills/harbor/ave-package.json": descriptor("skill", "harbor", "1.1.0", { entry: "SKILL.md" }) });
    const staged = await stage(syncer, (await rows(syncer))[0]!);
    const put = ContentLedger.prototype.put;
    let calls = 0;
    vi.spyOn(ContentLedger.prototype, "put").mockImplementation(function (this: ContentLedger, entry: LedgerEntry) {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error("disk full")) : put.call(this, entry);
    });
    failActivation = true;
    try {
      await expect(store.install(staged)).rejects.toThrow("settings write failed");
    } finally {
      vi.restoreAllMocks();
    }
    expect(calls).toBe(2);
    expect(installs("skill", "harbor")).toEqual([first.entry.origin.installId]);
  });

  it("refuses language staging and forged installs before any writes", async () => {
    const plan = { kind: "language", name: "french" } as PackagePlan;
    await expect(stageContentPackage(plan, {} as never, { workRoot: join(root, "work"), english: ENGLISH }))
      .rejects.toMatchObject({ code: "CONTENT_RULE_VIOLATION", message: "Language packages are no longer supported" });
    expect(existsSync(join(root, "work"))).toBe(false);
    const store = await openStore();
    await expect(store.install({ plan } as never)).rejects.toMatchObject({ code: "CONTENT_RULE_VIOLATION" });
    expect(store.list()).toEqual([]);
    expect(existsSync(join(root, "packages"))).toBe(false);
    expect(activated).toEqual([]);
  });
  it("keeps mixed legacy ledger entries and payloads readable and inert until explicit uninstall", async () => {
    const { syncer, store } = await openHarborMarket();
    await store.install(await stage(syncer, (await rows(syncer))[0]!));
    const active = store.list()[0]!;
    const legacy: LedgerEntry = { ...active, kind: "language", name: "french", origin: { ...active.origin, installId: undefined, payloadDir: undefined, consent: undefined } };
    const ledgerPath = join(root, "packages", "ledger.json");
    const ledger = await ContentLedger.open(ledgerPath);
    await ledger.put(legacy);
    const bytes = readFileSync(ledgerPath, "utf8");
    const payload = join(root, "packages", "language", "french", "1.0.0");
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, "messages.json"), "unparsed legacy bytes");
    const reopened = await openStore();
    expect(reopened.list().map(entry => entry.kind).sort()).toEqual(["language", "skill"]);
    expect((await reopened.load()).loaded.map(item => item.entry.kind)).toEqual(["skill"]);
    expect((await reopened.load()).broken).toMatchObject([{ entry: { kind: "language" }, problem: "language packages are not applied by this build" }]);
    await reopened.sweep();
    expect(readFileSync(ledgerPath, "utf8")).toBe(bytes);
    expect(readFileSync(join(payload, "messages.json"), "utf8")).toBe("unparsed legacy bytes");
    await reopened.uninstall("language", "french", EMPTY_MARKETPLACE_POLICY);
    expect(reopened.list().map(entry => entry.kind)).toEqual(["skill"]);
    expect(existsSync(payload)).toBe(false);
    expect(activated.at(-1)).toMatchObject({ op: "deactivate", content: null });
  });
  it("refuses the same name from another source unless the install switches source", async () => {
    const files = harborFiles();
    const packages = [{ kind: "skill", name: "harbor", path: "skills/harbor" }];
    const a = market(packages, files);
    const b = market(packages, files);
    const acme = await open(a.name, "acme");
    const other = await open(b.name, "other");
    const store = await openStore();
    await store.install(await stage(acme, (await rows(acme, "acme"))[0]!, "acme"));
    const staged = await stage(other, (await rows(other, "other"))[0]!, "other");
    await expect(store.install(staged)).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
    const switched = await store.install(staged, { switchSource: true });
    expect(switched.action).toMatchObject({ action: "switch", fromSource: "acme" });
    expect(store.installed("skill", "harbor")).toMatchObject({ sourceId: "other" });
  });

  it("refuses SVG, files outside the kind's layout, oversize packages and symlinks", async () => {
    const svg = market([{ kind: "skill", name: "harbor", path: "skills/harbor" }], {
      "skills/harbor/ave-package.json": descriptor("skill", "harbor", "1.0.0", { entry: "SKILL.md" }),
      "skills/harbor/SKILL.md": instruction("Harbor"),
      "skills/harbor/preview.svg": "<svg/>",
    });
    const svgSyncer = await open(svg.name);
    await expect(stage(svgSyncer, (await rows(svgSyncer))[0]!)).rejects.toThrow("SVG is not allowed: preview.svg");

    const big = market([{ kind: "provider", name: "harbor-llm", path: "providers/harbor-llm" }], {
      "providers/harbor-llm/ave-package.json": descriptor("provider", "harbor-llm", "1.0.0", { entry: "provider.json" }),
      "providers/harbor-llm/provider.json": `{"providerId":"harbor-llm","pad":"${"x".repeat(70 * 1024)}"}`,
    });
    const bigSyncer = await open(big.name);
    await expect(stage(bigSyncer, (await rows(bigSyncer))[0]!)).rejects.toMatchObject({ code: "CONTENT_RULE_VIOLATION" });

    const linked = market([{ kind: "skill", name: "harbor", path: "skills/harbor" }], harborFiles());
    linked.repo.commitEntries([
      { path: "marketplace.json", mode: "100644", content: text({ schemaVersion: 2, name: "acme", displayName: "Acme", packages: [{ kind: "skill", name: "harbor", path: "skills/harbor" }] }) },
      { path: "skills/harbor/ave-package.json", mode: "100644", content: descriptor("skill", "harbor", "1.0.0", { entry: "SKILL.md" }) },
      { path: "skills/harbor/SKILL.md", mode: "120000", content: "../../secret.json" },
    ], "link");
    const linkSyncer = await open(linked.name);
    await expect(stage(linkSyncer, (await rows(linkSyncer))[0]!)).rejects.toThrow(/only regular files are allowed/u);
  });

  it("lists a package whose files changed after install as broken and never applies it", async () => {
    const { syncer, store } = await openHarborMarket();
    const { entry } = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    writeFileSync(join(store.packageDir(entry), "SKILL.md"), instruction("Tampered"));
    const { loaded, broken } = await store.load();
    expect(loaded).toEqual([]);
    expect(broken).toEqual([{ entry: expect.objectContaining({ name: "harbor" }) as LedgerEntry, problem: "the installed files changed after install" }]);
    await store.uninstall("skill", "harbor", EMPTY_MARKETPLACE_POLICY);
    expect(activated.at(-1)).toMatchObject({ op: "deactivate", content: null });
  });

  /** Converts to a legacy version-directory install without an install id or consent baseline. */
  function makeLegacy(entry: LedgerEntry): LedgerEntry {
    const { installId: _installId, payloadDir: _payloadDir, consent: _consent, ...origin } = entry.origin;
    const legacy = { ...entry, origin };
    renameSync(join(root, "packages", ...entry.origin.payloadDir!.split("/")), join(root, "packages", entry.kind, entry.name, entry.version));
    writeFileSync(join(root, "packages", "ledger.json"), text({ version: 1, packages: [legacy] }));
    return legacy;
  }

  it("loads a legacy install from its version directory, and an update moves it to an install directory of its own", async () => {
    const { name, commit } = market([{ kind: "skill", name: "harbor", path: "skills/harbor" }], harborFiles());
    const syncer = await open(name);
    const legacy = makeLegacy((await (await openStore()).install(await stage(syncer, (await rows(syncer))[0]!))).entry);
    const store = await openStore();
    expect(store.packageDir(legacy)).toBe(join(root, "packages", "skill", "harbor", "1.0.0"));
    expect((await store.load()).loaded.map((item) => item.entry)).toEqual([legacy]);

    const refreshed = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    expect(refreshed.entry.origin.payloadDir).toBe(`skill/harbor/.installs/${refreshed.entry.origin.installId}`);
    await vi.waitFor(() => expect(existsSync(join(root, "packages", "skill", "harbor", "1.0.0"))).toBe(false));
    commit({
      "skills/harbor/ave-package.json": descriptor("skill", "harbor", "1.1.0", { entry: "SKILL.md" }),
      "skills/harbor/SKILL.md": instruction("Harbor Two"),
    });
    const updated = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    await vi.waitFor(() => expect(installs("skill", "harbor")).toEqual([updated.entry.origin.installId]));
    expect((await (await openStore()).load()).loaded[0]!.content).toMatchObject({ name: "harbor", description: "Harbor Two instructions." });
  });

  it("a boot sweep removes only the install directories no entry names", async () => {
    const { commit, syncer, store } = await openHarborMarket();
    const first = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    commit({ "skills/harbor/ave-package.json": descriptor("skill", "harbor", "1.1.0", { entry: "SKILL.md" }) });
    retirement = new Promise<void>(() => undefined);
    const second = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    mkdirSync(join(root, "packages", "skill", "harbor", "0.9.0"), { recursive: true });
    mkdirSync(join(root, "packages", "skill", "harbor", ".installs", "00000000-0000-4000-8000-000000000000"), { recursive: true });
    expect(installs("skill", "harbor")).toHaveLength(3);

    const reopened = await openStore();
    const removed = await reopened.sweep();
    expect(removed.sort()).toEqual([
      reopened.packageDir(first.entry),
      join(root, "packages", "skill", "harbor", ".installs", "00000000-0000-4000-8000-000000000000"),
      join(root, "packages", "skill", "harbor", "0.9.0"),
    ].sort());
    expect(installs("skill", "harbor")).toEqual([second.entry.origin.installId]);
    expect((await reopened.load()).loaded.map((item) => item.entry)).toEqual([second.entry]);
    expect(await reopened.sweep()).toEqual([]);
  });

  it("sweeps nothing while the ledger is pending review, and keeps every record once it is approved", async () => {
    const { commit, syncer, store } = await openHarborMarket();
    const first = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    const ledgerPath = join(root, "packages", "ledger.json");
    trust.pending.add(ledgerPath);
    try {
      const pending = await openStore();
      expect(pending.list()).toEqual([]);
      expect(await pending.sweep()).toEqual([]);
      expect(installs("skill", "harbor")).toEqual([first.entry.origin.installId]);
      // Still pending: a change through the empty view is refused, never written over the real records.
      commit({ "skills/harbor/ave-package.json": descriptor("skill", "harbor", "1.1.0", { entry: "SKILL.md" }) });
      await expect(pending.install(await stage(syncer, (await rows(syncer))[0]!))).rejects.toThrow(/waiting for review|review/i);
      expect(JSON.parse(readFileSync(ledgerPath, "utf8")).packages).toHaveLength(1);
      // Approved: the same store re-reads the ledger before its next change.
      trust.pending.delete(ledgerPath);
      const ledger = await ContentLedger.open(ledgerPath);
      expect(ledger.list()).toHaveLength(1);
    } finally {
      trust.pending.delete(ledgerPath);
    }
  });

  it("a ledger opened while pending re-reads the file before a change, so an approval made since keeps its records", async () => {
    const { syncer, store } = await openHarborMarket();
    const first = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    const ledgerPath = join(root, "packages", "ledger.json");
    trust.pending.add(ledgerPath);
    const ledger = await ContentLedger.open(ledgerPath);
    expect(ledger.pendingReview).toBe(true);
    const other = { ...first.entry, name: "other", origin: { ...first.entry.origin, payloadDir: first.entry.origin.payloadDir!.replace("/harbor/", "/other/") } };
    await expect(ledger.put(other)).rejects.toThrow();
    trust.pending.delete(ledgerPath);
    await ledger.put(other);
    expect(ledger.pendingReview).toBe(false);
    expect(ledger.list().map((entry) => entry.name).sort()).toEqual(["harbor", "other"]);
    expect((await ContentLedger.open(ledgerPath)).list().map((entry) => entry.name).sort()).toEqual(["harbor", "other"]);
  });

  it("a legacy install's version directory survives the sweep", async () => {
    const { name } = market([{ kind: "skill", name: "harbor", path: "skills/harbor" }], harborFiles());
    const syncer = await open(name);
    const legacy = makeLegacy((await (await openStore()).install(await stage(syncer, (await rows(syncer))[0]!))).entry);
    const store = await openStore();
    expect(await store.sweep()).toEqual([]);
    expect((await store.load()).loaded.map((item) => item.entry)).toEqual([legacy]);
  });

  it("checkpoint two: a consent assertion that throws installs nothing", async () => {
    const { syncer, store } = await openHarborMarket();
    const seen: unknown[] = [];
    await expect(store.install(await stage(syncer, (await rows(syncer))[0]!), {
      assertConsent: (consent) => { seen.push(consent); throw new Error("needs review"); },
    })).rejects.toThrow("needs review");
    expect(seen).toEqual([expect.objectContaining({ kind: "skill" })]);
    expect(store.list()).toEqual([]);
    expect(installs("skill", "harbor")).toEqual([]);
    expect(activated).toEqual([]);
  });

  describe("components:approve is bound to the reviewed install (§18.7.5)", () => {
    const packagePath = "agent-plugins/review-plugin";
    const pluginJson = (version: string) => text({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "review-plugin", version, description: "Review" });

    async function publish(store: ContentStore, version: string, rules: string, component: "hook") {
      const hooksJson = text({ version: 1, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["./server/hook.sh"] }] }] } });
      const program = "#!/bin/sh\nexit 0\n";
      const files = [
        { path: "plugin.json", data: Buffer.from(pluginJson(version)) },
        { path: `ai.agent-connector.ave/${component}s.json`, data: Buffer.from(hooksJson) },
        // Windows drops executable bits during install; this binding does not need one.
        { path: "server/hook.sh", data: Buffer.from(program) },
        { path: "skills/helper/assets/rules.txt", data: Buffer.from(rules) },
        { path: "skills/helper/SKILL.md", data: Buffer.from("---\nname: helper\ndescription: Helper\n---\nHelp.\n") },
      ];
      const components = deriveAgentPluginComponents(files);
      const { name } = market([{ kind: "agent-plugin", name: "review-plugin", path: packagePath }], {
        [`${packagePath}/ave-package.json`]: descriptor("agent-plugin", "review-plugin", version, { manifest: "plugin.json", components }),
        ...Object.fromEntries(files.map((file) => [`${packagePath}/${file.path}`, file.data])),
      });
      const syncer = await open(name);
      const staged = await stage(syncer, (await rows(syncer))[0]!);
      const { entry } = await store.install(staged);
      const consent = { kind: "hook" as const, index: 0, digest: components.hooks[0]!.digest, approvalDigest: agentPluginComponentDigests(components, files).hooks[0]! };
      return { entry, consent, staged };
    }

    const approvals = () => activated.filter((item) => item.op === "approve").map((item) => item.key);

    it("approves an unchanged install's components; after a replacement, the old review approves nothing", async () => {
      const store = await openStore();
      const a = await publish(store, "1.0.0", "rule one", "hook");
      expect(a.consent.approvalDigest).toMatch(/^[a-f0-9]{64}$/u);
      await store.approveComponents("review-plugin", a.entry.origin.installId!, [a.consent]);
      expect(approvals()).toEqual(["agent-plugin:review-plugin@1.0.0"]);

      const b = await publish(store, "1.0.1", "rule two", "hook");
      expect(b.consent.digest).toBe(a.consent.digest);
      expect(b.consent.approvalDigest).not.toBe(a.consent.approvalDigest);
      const stale = { code: "PLAN_EXPIRED", detail: { reason: "package-changed" } };
      await expect(store.approveComponents("review-plugin", a.entry.origin.installId!, [a.consent])).rejects.toMatchObject(stale);
      await expect(store.approveComponents("review-plugin", b.entry.origin.installId!, [a.consent])).rejects.toMatchObject(stale);
      expect(approvals()).toEqual(["agent-plugin:review-plugin@1.0.0"]);
      await store.approveComponents("review-plugin", b.entry.origin.installId!, [b.consent]);
      expect(approvals()).toEqual(["agent-plugin:review-plugin@1.0.0", "agent-plugin:review-plugin@1.0.1"]);
    });

    it("binds by the generation alone: the same bytes installed again are another install, and the old review approves nothing", async () => {
      const store = await openStore();
      const a = await publish(store, "1.0.0", "rule one", "hook");
      const { entry: b } = await store.install(a.staged);
      expect(b.origin.installId).not.toBe(a.entry.origin.installId);
      await expect(store.approveComponents("review-plugin", a.entry.origin.installId!, [a.consent])).rejects.toMatchObject({ code: "PLAN_EXPIRED", detail: { reason: "package-changed" } });
      expect(approvals()).toEqual([]);
      await store.approveComponents("review-plugin", b.origin.installId!, [a.consent]);
      expect(approvals()).toEqual(["agent-plugin:review-plugin@1.0.0"]);
    });
  });

  it("refuses to open over a ledger it cannot read", async () => {
    const packages = join(root, "packages");
    mkdirSync(packages);
    writeFileSync(join(packages, "ledger.json"), text({ version: 1, packages: [{ kind: "plugin", name: "x", version: "1.0.0", origin: {} }] }));
    await expect(openStore()).rejects.toThrow("packages[0].kind is not a content kind");
    writeFileSync(join(packages, "ledger.json"), "not json");
    await expect(openStore()).rejects.toThrow();
  });

  describe("ledger strictness", () => {
    const origin = (patch: Record<string, unknown> = {}) => ({
      sourceId: "acme",
      sourceOrigin: "custom",
      commit: "a".repeat(40),
      packagePath: "skills/harbor",
      version: "1.0.0",
      contentSha256: "b".repeat(64),
      installedAt: AT,
      ...patch,
    });
    const entry = (patch: Record<string, unknown> = {}) => ({ kind: "skill", name: "harbor", version: "1.0.0", origin: origin(), ...patch });

    it.each([
      ["the same package twice", [entry(), entry()], "skill:harbor is recorded twice"],
      ["an origin version other than the entry's", [entry({ origin: origin({ version: "1.1.0" }) })], "packages[0].origin is malformed"],
      ["an unknown entry field", [entry({ pinned: true })], "packages[0] has an unknown field"],
      ["an unknown origin field", [entry({ origin: origin({ signer: "x" }) })], "packages[0].origin has an unknown field"],
      ["an install id without its directory", [entry({ origin: origin({ installId: "00000000-0000-4000-8000-000000000000" }) })], "packages[0].origin names an install directory only in part"],
      ["an install directory that is not the install's", [entry({ origin: origin({ installId: "00000000-0000-4000-8000-000000000000", payloadDir: "skill/other/.installs/00000000-0000-4000-8000-000000000000" }) })], "packages[0].origin.payloadDir is not its install directory"],
      ["an install directory that escapes", [entry({ origin: origin({ installId: "../../x", payloadDir: "skill/harbor/.installs/../../x" }) })], "packages[0].origin.payloadDir is not its install directory"],
      ["a consent baseline of another kind", [entry({ origin: origin({ consent: { kind: "font", fields: { minAppVersion: null }, unknown: ["minAppVersion"] } }) })], "packages[0].origin.consent is not a skill fingerprint"],
    ])("refuses %s", async (_label, packages, message) => {
      const dir = join(root, "packages");
      mkdirSync(dir);
      writeFileSync(join(dir, "ledger.json"), text({ version: 1, packages }));
      await expect(openStore()).rejects.toThrow(message);
    });
  });
});
