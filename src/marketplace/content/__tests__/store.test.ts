import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { moonstoneBundle } from "../../../ui/renderer/theme/bundles/moonstone.js";
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
import { NetworkGate } from "../../net/network-gate.js";
import { candidateVersion, planPackage } from "../../resolve/descriptor.js";
import { EMPTY_MARKETPLACE_POLICY } from "../../sources/policy.js";
import { SourceRegistry } from "../../sources/registry.js";
import { SourceSyncer } from "../../sources/sync.js";
import type { ParsedContent } from "../kinds.js";
import { ContentLedger, contentLedgerOrigins, type LedgerEntry } from "../ledger.js";
import { ContentStore, stageContentPackage, type ContentActivation } from "../store.js";

const AT = "2026-09-23T00:00:00.000Z";
const INSTALLATION = "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b";
const ENGLISH = { "app.title": "Ave", "chat.send": "Send" };

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const descriptor = (kind: string, name: string, version: string, payload: Record<string, unknown>) =>
  text({ schemaVersion: 1, kind, name, version, minAppVersion: "0.12.0", payload });
const SURFACES = { "surface-sunken": "228 30% 97%", surface: "0 0% 100%", "surface-raised": "0 0% 100%", "surface-overlay": "0 0% 100%", "border-subtle": "228 24% 94%", "border-strong": "228 18% 84%" };
const theme = (name: string) => text({ name, description: `${name} theme.`, shell: "light", highContrast: false, tokens: moonstoneBundle.tokens, surfaces: SURFACES });
const language = (name: string, locale: string) => ({
  [`languages/${name}/ave-package.json`]: descriptor("language", name, "1.0.0", { locale, entry: "language.json", messages: "messages.json" }),
  [`languages/${name}/language.json`]: text({ locale, nativeName: "Français", englishName: "French" }),
  [`languages/${name}/messages.json`]: text({ "chat.send": "Envoyer" }),
});

describe.skipIf(process.platform === "win32")("content package store (blueprint 3.1)", () => {
  let serverRoot: string;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let root: string;
  let repos: FixtureRepo[] = [];
  let counter = 0;
  let activated: Array<{ op: "activate" | "deactivate"; key: string; content: ParsedContent | null; previous?: string | null }>;
  let failActivation: boolean;

  const activation: ContentActivation = {
    async activate(content, entry, previous) {
      if (failActivation) throw new Error("settings write failed");
      activated.push({ op: "activate", key: `${entry.kind}:${entry.name}@${entry.version}`, content, previous: previous ? previous.version : null });
    },
    async deactivate(entry, content) {
      activated.push({ op: "deactivate", key: `${entry.kind}:${entry.name}@${entry.version}`, content });
    },
  };

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-content-served-"));
    server = await startGitHttpServer({ root: serverRoot });
    git = await createTestGitRunner();
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    rmSync(serverRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-content-root-"));
    activated = [];
    failActivation = false;
  });

  afterEach(() => {
    for (const repo of repos) removeFixtureRepo(repo);
    repos = [];
    rmSync(root, { recursive: true, force: true });
  });

  /** A marketplace repository serving `packages` (kind, name, path) with the given files. */
  function market(packages: Array<{ kind: string; name: string; path: string }>, files: Record<string, string | Buffer>) {
    counter += 1;
    const name = `content-${counter}`;
    const repo = createFixtureRepo(serverRoot, name);
    repos.push(repo);
    const commit = (patch: Record<string, string | Buffer>) =>
      repo.commit({ "marketplace.json": text({ schemaVersion: 1, name: "acme", displayName: "Acme", packages }), ...patch }, "publish");
    return { repo, name, commit, first: commit(files) };
  }

  async function open(repoName: string, sourceId = "acme") {
    const policy = policyLoad({});
    const gate = new NetworkGate({ policy, allowLoopback: true });
    const marketplaces = mkdtempSync(join(root, "marketplaces-"));
    const registry = await SourceRegistry.open({ root: marketplaces, policy });
    await registry.add({ id: sourceId, origin: "custom", url: server.url(repoName), auth: { kind: "none" } });
    const syncer = new SourceSyncer({ registry, gate, runner: git.runner, root: marketplaces, now: () => new Date(AT), retainedCommits: async () => new Set() });
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
      stageContentPackage(plan, { repo, remote, direct: false }, { workRoot: join(root, "work"), english: ENGLISH }));
  }

  const openStore = () => ContentStore.open({ root: join(root, "packages"), english: ENGLISH, activation, now: () => new Date(AT) });

  it("installs a theme, records its origin, reloads it from disk and uninstalls it", async () => {
    const { name, first } = market([{ kind: "theme", name: "harbor", path: "themes/harbor" }], {
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor"),
    });
    const syncer = await open(name);
    const [row] = await rows(syncer);
    const staged = await stage(syncer, row!);
    const store = await openStore();
    const { action, entry } = await store.install(staged);
    expect(action).toEqual({ action: "install" });
    expect(entry).toEqual({
      kind: "theme",
      name: "harbor",
      version: "1.0.0",
      origin: { sourceId: "acme", sourceOrigin: "custom", commit: first, packagePath: "themes/harbor", version: "1.0.0", contentSha256: staged.contentSha256, installedAt: AT },
    });
    // The descriptor is read at the version commit and never installed.
    expect(existsSync(join(root, "packages", "theme", "harbor", "1.0.0", "theme.json"))).toBe(true);
    expect(existsSync(join(root, "packages", "theme", "harbor", "1.0.0", "ave-package.json"))).toBe(false);
    expect(activated.map((call) => call.key)).toEqual(["theme:harbor@1.0.0"]);

    const reopened = await openStore();
    const { loaded, broken } = await reopened.load();
    expect(broken).toEqual([]);
    expect(loaded.map((item) => item.content)).toEqual([staged.content]);
    // The snapshot the install was planned from is kept while it is installed (§2.3).
    expect(await contentLedgerOrigins(join(root, "packages", "ledger.json"))()).toEqual([{ sourceId: "acme", commit: first }]);

    await expect(reopened.uninstall("theme", "harbor", { ...EMPTY_MARKETPLACE_POLICY, requiredInstalls: [{ kind: "theme", name: "harbor", source: "acme" }] }))
      .rejects.toMatchObject({ code: "PACKAGE_REQUIRED_BY_POLICY" });
    expect(await reopened.uninstall("theme", "harbor", EMPTY_MARKETPLACE_POLICY)).toEqual(entry);
    expect(activated.at(-1)).toMatchObject({ op: "deactivate", key: "theme:harbor@1.0.0", content: staged.content });
    expect(existsSync(join(root, "packages", "theme", "harbor"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "packages", "ledger.json"), "utf8"))).toEqual({ version: 1, packages: [] });
    expect(await reopened.uninstall("theme", "harbor", EMPTY_MARKETPLACE_POLICY)).toBeNull();
  });

  it("replaces an older version in place and removes its directory", async () => {
    const packages = [{ kind: "theme", name: "harbor", path: "themes/harbor" }];
    const { name, commit } = market(packages, {
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor"),
    });
    const syncer = await open(name);
    const store = await openStore();
    await store.install(await stage(syncer, (await rows(syncer))[0]!));
    commit({
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.1.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor Two"),
    });
    const { action } = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    expect(action).toEqual({ action: "replace", direction: "upgrade", from: "1.0.0" });
    // Activation is told what the install replaces.
    expect(activated.map((call) => call.previous)).toEqual([null, "1.0.0"]);
    expect(existsSync(join(root, "packages", "theme", "harbor", "1.0.0"))).toBe(false);
    expect((await store.load()).loaded[0]!.content).toMatchObject({ name: "Harbor Two" });
  });

  it("puts the previous install back when activation fails", async () => {
    const { name, commit } = market([{ kind: "theme", name: "harbor", path: "themes/harbor" }], {
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor"),
    });
    const syncer = await open(name);
    const store = await openStore();
    const first = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    commit({ "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.1.0", { entry: "theme.json" }) });
    failActivation = true;
    await expect(store.install(await stage(syncer, (await rows(syncer))[0]!))).rejects.toThrow("settings write failed");
    expect(store.list()).toEqual([first.entry]);
    expect(existsSync(join(root, "packages", "theme", "harbor", "1.1.0"))).toBe(false);
    expect((await (await openStore()).load()).loaded.map((item) => item.entry)).toEqual([first.entry]);
  });

  it("leaves nothing behind when a first install's activation fails", async () => {
    const { name } = market([{ kind: "theme", name: "harbor", path: "themes/harbor" }], {
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor"),
    });
    const syncer = await open(name);
    const store = await openStore();
    failActivation = true;
    await expect(store.install(await stage(syncer, (await rows(syncer))[0]!))).rejects.toThrow("settings write failed");
    expect(store.list()).toEqual([]);
    expect(existsSync(join(root, "packages", "theme", "harbor", "1.0.0"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "packages", "ledger.json"), "utf8"))).toEqual({ version: 1, packages: [] });
  });

  it("puts the live directory back when reinstalling the same version fails to activate", async () => {
    const { name } = market([{ kind: "theme", name: "harbor", path: "themes/harbor" }], {
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor"),
    });
    const syncer = await open(name);
    const store = await openStore();
    const first = await store.install(await stage(syncer, (await rows(syncer))[0]!));
    failActivation = true;
    await expect(store.install(await stage(syncer, (await rows(syncer))[0]!))).rejects.toThrow("settings write failed");
    expect(store.list()).toEqual([first.entry]);
    const { loaded, broken } = await (await openStore()).load();
    expect(broken).toEqual([]);
    expect(loaded.map((item) => item.entry)).toEqual([first.entry]);
    expect(readdirSync(join(root, "packages", ".staging"))).toEqual([]);
  });

  it("rethrows the activation error when the rollback's own ledger write fails too", async () => {
    const { name, commit } = market([{ kind: "theme", name: "harbor", path: "themes/harbor" }], {
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor"),
    });
    const syncer = await open(name);
    const store = await openStore();
    await store.install(await stage(syncer, (await rows(syncer))[0]!));
    commit({ "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.1.0", { entry: "theme.json" }) });
    const staged = await stage(syncer, (await rows(syncer))[0]!);
    // The first put records the new entry; the rollback's put of the previous one fails.
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
    // The new version's files are still removed.
    expect(existsSync(join(root, "packages", "theme", "harbor", "1.1.0"))).toBe(false);
  });

  it("refuses a second package for a locale another installed package provides", async () => {
    const { name } = market(
      [
        { kind: "language", name: "french", path: "languages/french" },
        { kind: "language", name: "francais", path: "languages/francais" },
      ],
      { ...language("french", "fr"), ...language("francais", "fr") },
    );
    const syncer = await open(name);
    const found = await rows(syncer);
    const store = await openStore();
    await store.install(await stage(syncer, found.find((row) => row.name === "french")!));
    await expect(store.install(await stage(syncer, found.find((row) => row.name === "francais")!)))
      .rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT", message: "french already provides the fr language" });
    expect(store.list().map((entry) => entry.name)).toEqual(["french"]);
  });

  it("refuses the same name from another source unless the install switches source", async () => {
    const files = {
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor"),
    };
    const packages = [{ kind: "theme", name: "harbor", path: "themes/harbor" }];
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
    expect(store.installed("theme", "harbor")).toMatchObject({ sourceId: "other" });
  });

  it("refuses SVG, files outside the kind's layout, oversize packages and symlinks", async () => {
    const svg = market([{ kind: "theme", name: "harbor", path: "themes/harbor" }], {
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor"),
      "themes/harbor/preview.svg": "<svg/>",
    });
    const svgSyncer = await open(svg.name);
    await expect(stage(svgSyncer, (await rows(svgSyncer))[0]!)).rejects.toThrow("SVG is not allowed: preview.svg");

    const big = market([{ kind: "provider", name: "harbor-llm", path: "providers/harbor-llm" }], {
      "providers/harbor-llm/ave-package.json": descriptor("provider", "harbor-llm", "1.0.0", { entry: "provider.json" }),
      "providers/harbor-llm/provider.json": `{"providerId":"harbor-llm","pad":"${"x".repeat(70 * 1024)}"}`,
    });
    const bigSyncer = await open(big.name);
    await expect(stage(bigSyncer, (await rows(bigSyncer))[0]!)).rejects.toMatchObject({ code: "CONTENT_RULE_VIOLATION" });

    const linked = market([{ kind: "theme", name: "harbor", path: "themes/harbor" }], {
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor"),
    });
    linked.repo.commitEntries([
      { path: "marketplace.json", mode: "100644", content: text({ schemaVersion: 1, name: "acme", displayName: "Acme", packages: [{ kind: "theme", name: "harbor", path: "themes/harbor" }] }) },
      { path: "themes/harbor/ave-package.json", mode: "100644", content: descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }) },
      { path: "themes/harbor/theme.json", mode: "120000", content: "../../secret.json" },
    ], "link");
    const linkSyncer = await open(linked.name);
    await expect(stage(linkSyncer, (await rows(linkSyncer))[0]!)).rejects.toThrow(/only regular files are allowed/u);
  });

  it("lists a package whose files changed after install as broken and never applies it", async () => {
    const { name } = market([{ kind: "theme", name: "harbor", path: "themes/harbor" }], {
      "themes/harbor/ave-package.json": descriptor("theme", "harbor", "1.0.0", { entry: "theme.json" }),
      "themes/harbor/theme.json": theme("Harbor"),
    });
    const syncer = await open(name);
    const store = await openStore();
    await store.install(await stage(syncer, (await rows(syncer))[0]!));
    writeFileSync(join(root, "packages", "theme", "harbor", "1.0.0", "theme.json"), theme("Tampered"));
    const { loaded, broken } = await store.load();
    expect(loaded).toEqual([]);
    expect(broken).toEqual([{ entry: expect.objectContaining({ name: "harbor" }) as LedgerEntry, problem: "the installed files changed after install" }]);
    // Uninstall still works, and tells activation the content is unreadable.
    await store.uninstall("theme", "harbor", EMPTY_MARKETPLACE_POLICY);
    expect(activated.at(-1)).toMatchObject({ op: "deactivate", content: null });
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
      packagePath: "themes/harbor",
      version: "1.0.0",
      contentSha256: "b".repeat(64),
      installedAt: AT,
      ...patch,
    });
    const entry = (patch: Record<string, unknown> = {}) => ({ kind: "theme", name: "harbor", version: "1.0.0", origin: origin(), ...patch });

    it.each([
      ["the same package twice", [entry(), entry()], "theme:harbor is recorded twice"],
      ["an origin version other than the entry's", [entry({ origin: origin({ version: "1.1.0" }) })], "packages[0].origin is malformed"],
      ["an unknown entry field", [entry({ pinned: true })], "packages[0] has an unknown field"],
      ["an unknown origin field", [entry({ origin: origin({ signer: "x" }) })], "packages[0].origin has an unknown field"],
    ])("refuses %s", async (_label, packages, message) => {
      const dir = join(root, "packages");
      mkdirSync(dir);
      writeFileSync(join(dir, "ledger.json"), text({ version: 1, packages }));
      await expect(openStore()).rejects.toThrow(message);
    });
  });
});
