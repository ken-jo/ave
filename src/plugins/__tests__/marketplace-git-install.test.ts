/**
 * Git install entry (design §6.2, §2.3): a staged, already-verified artifact
 * goes through the same stage → receipt → registry → generation pipeline as
 * a catalog install, with a v4 receipt and the registry `origin`, and
 * without envelope verification.
 */
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import type { PluginAuthority } from "../../marketplace/catalog/types.js";
import type { PluginInstallPlan, StagedPluginArtifact } from "../../marketplace/resolve/plugin-ladder.js";
import { preparePendingPluginUpdate, recoverPendingPluginUpdates } from "../marketplace-update-recovery.js";
import type { PluginPaths } from "../plugin-paths.js";
import { installReceiptPath, verifyInstallReceipt } from "../plugin-install-receipt.js";
import { readPluginRegistry, updatePluginRegistry } from "../registry.js";
import { MissingDependenciesError, MissingPluginDependenciesError } from "../types.js";
import {
  activateAndCommitPreparedPluginForTest,
  agentPluginsDocument,
  makeTestPluginPaths,
  PLUGIN_DATA_FIXTURE,
  preparedActivationOptionsForTest,
  readPluginDataFixture,
  seedPluginDataFixture,
  TestPluginMarketplaceService,
} from "./test-helpers.js";

const SNAPSHOT = "a".repeat(40);
const VERSION_COMMIT = "b".repeat(40);
const ENTRY_JS = "export default {};\n";

const authority = (patch: Partial<PluginAuthority> = {}): PluginAuthority => ({
  capabilities: [],
  pluginAccess: { plugins: [{ pluginId: "notes" }] },
  requires: { minAppVersion: "0.12.0" },
  ...patch,
});

function plan(version = "1.0.0", patch: Partial<PluginInstallPlan> = {}): PluginInstallPlan {
  return {
    sourceId: "acme",
    sourceOrigin: "custom",
    snapshotCommit: SNAPSHOT,
    versionCommit: VERSION_COMMIT,
    packagePath: "plugins/alpha",
    kind: "plugin",
    name: "alpha",
    version,
    minAppVersion: "0.12.0",
    authority: authority(),
    artifact: { tree: "plugins/alpha" },
    ...patch,
  };
}

function pluginDocument(version: string, auth: PluginAuthority = authority()): Record<string, unknown> {
  return { name: "alpha", version, description: "alpha", extensions: { "ai.agent-connector.ave": { displayName: "Alpha", entry: "dist/index.js", ...auth } } };
}

function staged(forPlan: PluginInstallPlan, document = pluginDocument(forPlan.version, forPlan.authority)): StagedPluginArtifact {
  const zip = new AdmZip();
  zip.addFile("plugin.json", Buffer.from(JSON.stringify(document)));
  zip.addFile("dist/index.js", Buffer.from(ENTRY_JS));
  const zipBuffer = zip.toBuffer();
  return {
    plan: forPlan,
    zipBuffer,
    artifactSha256: createHash("sha256").update(zipBuffer).digest("hex"),
    rung: "archive",
    rungs: [
      { rung: "release", outcome: "skipped", reason: "NOT_DECLARED" },
      { rung: "archive", outcome: "used" },
    ],
    manifestDocument: document,
  };
}

describe("PluginMarketplaceService.installGitPlugin", () => {
  let testDir: string;
  let pluginsDir: string;
  let cacheRoot: string;
  let registryPath: string;
  let service: TestPluginMarketplaceService;
  let paths: PluginPaths;
  let priorEnv: string | undefined;

  beforeEach(async () => {
    setIsPackaged(false);
    priorEnv = process.env.AVE_DEV;
    process.env.AVE_DEV = "1";
    testDir = mkdtempSync(join(tmpdir(), "ave-git-install-"));
    pluginsDir = join(testDir, "plugins");
    cacheRoot = join(pluginsDir, ".cache");
    registryPath = join(pluginsDir, "registry.json");
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
    paths = makeTestPluginPaths({ rootDir: testDir, cacheRoot });
    service = new TestPluginMarketplaceService(paths);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    if (priorEnv === undefined) delete process.env.AVE_DEV;
    else process.env.AVE_DEV = priorEnv;
    _resetForTest();
  });

  const install = (forPlan: PluginInstallPlan, artifact = staged(forPlan), activate = activateAndCommitPreparedPluginForTest) =>
    service.installGitPlugin(forPlan, { stage: async () => artifact, activatePreparedArtifact: activate });

  const entry = async () => (await readPluginRegistry(registryPath)).plugins.find((item) => item.id === "alpha");

  it("installs the staged zip with a v4 receipt and the registry origin", async () => {
    const forPlan = plan();
    const artifact = staged(forPlan);
    await expect(install(forPlan, artifact)).resolves.toMatchObject({ pluginId: "alpha", installed: true, version: "1.0.0" });

    expect(await entry()).toMatchObject({
      id: "alpha",
      enabled: true,
      installSource: "user",
      approvedPluginAccess: { plugins: [{ pluginId: "notes" }] },
      origin: {
        sourceId: "acme",
        sourceOrigin: "custom",
        commit: SNAPSHOT,
        packagePath: "plugins/alpha",
        version: "1.0.0",
        rung: "archive",
        artifactSha256: artifact.artifactSha256,
        installedAt: expect.any(String),
      },
    });
    expect(await readFile(join(pluginsDir, "alpha", "dist", "index.js"), "utf8")).toBe(ENTRY_JS);
    const receipt = await verifyInstallReceipt(cacheRoot, "alpha", join(pluginsDir, "alpha"));
    expect(receipt).toMatchObject({
      ok: true,
      receipt: {
        schemaVersion: 4,
        installSource: "git",
        artifactSha256: artifact.artifactSha256,
        git: { sourceId: "acme", snapshotCommit: SNAPSHOT, versionCommit: VERSION_COMMIT, rung: "archive", rungs: artifact.rungs },
      },
    });
    if (receipt.ok) expect(receipt.receipt.reviewedAppVersion).toBeUndefined();
  });

  it("carries an explicit review version into the verified install receipt", async () => {
    const forPlan = plan();
    await service.installGitPlugin(forPlan, {
      stage: async () => staged(forPlan),
      activatePreparedArtifact: activateAndCommitPreparedPluginForTest,
      reviewedAppVersion: "0.12.0",
    });
    const receipt = await verifyInstallReceipt(cacheRoot, "alpha", join(pluginsDir, "alpha"));
    expect(receipt).toMatchObject({ ok: true, receipt: { reviewedAppVersion: "0.12.0" } });
  });

  it("checks dependencies on the plan's authority before staging anything", async () => {
    let staging = 0;
    const needsCapability = plan("1.0.0", { authority: authority({ requires: { minAppVersion: "0.12.0", capabilities: ["notes:read"] } }) });
    await expect(service.installGitPlugin(needsCapability, {
      stage: async (p) => {
        staging += 1;
        return staged(p);
      },
      activatePreparedArtifact: activateAndCommitPreparedPluginForTest,
    })).rejects.toBeInstanceOf(MissingDependenciesError);
    const needsPlugin = plan("1.0.0", { authority: authority({ dependencies: [{ pluginId: "notes" }] }) });
    await expect(install(needsPlugin)).rejects.toBeInstanceOf(MissingPluginDependenciesError);
    expect(staging).toBe(0);
    expect(await entry()).toBeUndefined();
  });

  it("installs past an absent optional dependency, but not past an absent required one", async () => {
    const optional = plan("1.0.0", { authority: authority({ dependencies: [{ pluginId: "notes", required: false }] }) });
    await expect(install(optional)).resolves.toMatchObject({ pluginId: "alpha", installed: true });
    const mixed = plan("1.0.1", { authority: authority({ dependencies: [{ pluginId: "notes", required: false }, { pluginId: "calendar" }] }) });
    await expect(install(mixed)).rejects.toMatchObject({ missing: ["calendar"] });
  });

  it("refuses an extracted plugin.json that differs from the plan, leaving nothing behind", async () => {
    const forPlan = plan();
    const lying = staged(forPlan, pluginDocument("1.0.0", authority({ capabilities: ["notes:write"] })));
    await expect(install(forPlan, lying)).rejects.toMatchObject({ code: "MANIFEST_MISMATCH" });
    expect(await entry()).toBeUndefined();
    expect(existsSync(join(pluginsDir, "alpha"))).toBe(false);
    expect(existsSync(installReceiptPath(cacheRoot, "alpha"))).toBe(false);
  });

  it("refuses a staged artifact made for another plan", async () => {
    await expect(install(plan(), staged(plan("1.0.0")))).rejects.toThrow("belongs to another plan");
  });

  it("updates in place through the recovery journal and keeps the plugin data", async () => {
    await install(plan("1.0.0"));
    await seedPluginDataFixture(join(pluginsDir, "alpha"));
    const next = plan("1.1.0", { snapshotCommit: "c".repeat(40) });
    await install(next);
    expect(await entry()).toMatchObject({ origin: { version: "1.1.0", commit: "c".repeat(40) } });
    expect((await entry())?.pendingUpdate).toBeUndefined();
    expect(await readPluginDataFixture(join(pluginsDir, "alpha"))).toEqual(PLUGIN_DATA_FIXTURE);
  });

  it("refuses the same name from another source unless switching, and a switch keeps the plugin data", async () => {
    await install(plan("1.0.0"));
    await seedPluginDataFixture(join(pluginsDir, "alpha"));
    const official = plan("1.0.0", { sourceId: "ave", sourceOrigin: "official" });
    await expect(install(official)).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
    expect(await entry()).toMatchObject({ origin: { sourceId: "acme" } });

    const switched = await service.installGitPlugin(official, {
      stage: async () => staged(official),
      activatePreparedArtifact: activateAndCommitPreparedPluginForTest,
      switchSource: true,
    });
    expect(switched.action).toEqual({ action: "switch", fromSource: "acme", from: "1.0.0" });
    expect(await entry()).toMatchObject({ origin: { sourceId: "ave", sourceOrigin: "official" } });
    expect(await readPluginDataFixture(join(pluginsDir, "alpha"))).toEqual(PLUGIN_DATA_FIXTURE);
  });

  it("replaces a legacy admin-installed plugin like any other, and records the install as the user's", async () => {
    await install(plan("1.0.0", { sourceId: "ave", sourceOrigin: "official" }));
    await updatePluginRegistry(registryPath, (registry) => {
      registry.plugins[0]!.installSource = "admin";
      delete registry.plugins[0]!.origin;
    });
    const custom = plan("1.1.0");
    await service.installGitPlugin(custom, {
      stage: async () => staged(custom),
      activatePreparedArtifact: activateAndCommitPreparedPluginForTest,
      switchSource: true,
    });
    expect(await entry()).toMatchObject({ installSource: "user", origin: { sourceId: custom.sourceId, version: "1.1.0" } });
  });

  it("replaces an install without a source binding only as a switch", async () => {
    await install(plan("1.0.0"));
    await seedPluginDataFixture(join(pluginsDir, "alpha"));
    // A catalog install from before this design: no origin.
    await updatePluginRegistry(registryPath, (registry) => {
      delete registry.plugins[0]!.origin;
    });
    await expect(install(plan("1.1.0"))).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT", message: expect.stringContaining("without a source") });
    const switched = await service.installGitPlugin(plan("1.1.0"), {
      stage: async (p) => staged(p),
      activatePreparedArtifact: activateAndCommitPreparedPluginForTest,
      switchSource: true,
    });
    expect(switched.action).toEqual({ action: "switch", fromSource: null, from: "1.0.0" });
    expect(await entry()).toMatchObject({ origin: { sourceId: "acme", version: "1.1.0" } });
    expect(await readPluginDataFixture(join(pluginsDir, "alpha"))).toEqual(PLUGIN_DATA_FIXTURE);
  });

  it("restores a git install's v4 receipt and origin after a post-promotion crash", async () => {
    await install(plan("1.0.0"));
    const before = (await entry())!;
    const receiptBefore = await readFile(installReceiptPath(cacheRoot, "alpha"), "utf8");
    // The crash hits after the 1.1.0 tree was promoted, before its commit.
    const backupDir = join(pluginsDir, ".alpha.old-00000000-0000-4000-8000-000000000001");
    await preparePendingPluginUpdate(paths, before, { kind: "marketplace", recoveryBackupDir: backupDir, recoveryBackupMode: "rename" });
    await rename(join(pluginsDir, "alpha"), backupDir);
    await mkdir(join(pluginsDir, "alpha"), { recursive: true });
    await writeFile(join(pluginsDir, "alpha", "plugin.json"), JSON.stringify(pluginDocument("1.1.0")));
    await writeFile(installReceiptPath(cacheRoot, "alpha"), JSON.stringify({ pluginId: "alpha", version: "1.1.0" }));

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: ["alpha"], unresolved: [] });
    expect(await readFile(installReceiptPath(cacheRoot, "alpha"), "utf8")).toBe(receiptBefore);
    const restored = (await entry())!;
    expect(restored.pendingUpdate).toBeUndefined();
    expect(restored.origin).toEqual(before.origin);
    expect(await verifyInstallReceipt(cacheRoot, "alpha", join(pluginsDir, "alpha"))).toMatchObject({
      ok: true,
      receipt: { schemaVersion: 4, installSource: "git", version: "1.0.0" },
    });
  });

  it("reports the replacement direction within the bound source", async () => {
    await expect(install(plan("1.0.0"))).resolves.toMatchObject({ action: { action: "install" } });
    await expect(install(plan("1.1.0"))).resolves.toMatchObject({ action: { action: "replace", direction: "upgrade", from: "1.0.0" } });
    await expect(install(plan("1.0.0"))).resolves.toMatchObject({ action: { action: "replace", direction: "downgrade", from: "1.1.0" } });
  });

  it("restores the previous install, receipt and origin when activation fails", async () => {
    await install(plan("1.0.0"));
    const before = await entry();
    const receiptBefore = await readFile(installReceiptPath(cacheRoot, "alpha"), "utf8");
    await expect(install(plan("1.1.0"), undefined, async () => {
      throw new Error("activation refused");
    })).rejects.toThrow("activation refused");
    expect(await entry()).toEqual(before);
    expect(await readFile(installReceiptPath(cacheRoot, "alpha"), "utf8")).toBe(receiptBefore);
    expect(JSON.parse(await readFile(join(pluginsDir, "alpha", "plugin.json"), "utf8"))).toMatchObject({ version: "1.0.0" });
  });

  it("drops the origin when a local build replaces a git install", async () => {
    await install(plan());
    const source = join(testDir, "src-alpha");
    await mkdir(join(source, "dist"), { recursive: true });
    await writeFile(
      join(source, "plugin.json"),
      JSON.stringify(agentPluginsDocument({ id: "alpha", name: "Alpha", version: "2.0.0", description: "local", entry: "dist/index.js" })),
    );
    await writeFile(join(source, "dist", "index.js"), ENTRY_JS);
    await service.installLocal(source, preparedActivationOptionsForTest);
    const local = await entry();
    expect(local).toMatchObject({ installSource: "local-dev" });
    expect(local?.origin).toBeUndefined();
  });

  it.each([
    ["a legacy rung with a digest", { rung: "legacy", artifactSha256: "d".repeat(64) }],
    ["a tree rung without a digest", { rung: "tree", artifactSha256: null }],
    ["an unknown source kind", { sourceOrigin: "admin" }],
    ["a short commit", { commit: "abc" }],
    ["an extra field", { extra: true }],
  ])("refuses a registry origin with %s", async (_label, patch) => {
    const origin = {
      sourceId: "ave",
      sourceOrigin: "official",
      commit: SNAPSHOT,
      packagePath: "plugins/alpha",
      version: "1.0.0",
      rung: "release",
      artifactSha256: "d".repeat(64),
      installedAt: "2026-09-23T00:00:00.000Z",
    };
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [{ id: "alpha", manifestPath: "alpha/plugin.json", origin }] }));
    await expect(readPluginRegistry(registryPath)).resolves.toMatchObject({ plugins: [{ origin }] });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [{ id: "alpha", manifestPath: "alpha/plugin.json", origin: { ...origin, ...patch } }] }));
    await expect(readPluginRegistry(registryPath)).rejects.toThrow("origin");
  });
});
