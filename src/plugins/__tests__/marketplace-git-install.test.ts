/** Git installs use the artifact transaction and v4 provenance receipt without envelope verification. */
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import type { PluginAuthority } from "../../marketplace/catalog/types.js";
import type { PluginInstallPlan, StagedPluginArtifact } from "../../marketplace/resolve/plugin-ladder.js";
import { preparePendingPluginUpdate, recoverPendingPluginUpdates } from "../marketplace-update-recovery.js";
import type { PluginPaths } from "../plugin-paths.js";
import { installReceiptPath, verifyInstallReceipt } from "../plugin-install-receipt.js";
import * as receiptStore from "../plugin-install-receipt.js";
import * as updateRecovery from "../marketplace-update-recovery.js";
import { readPluginRegistry, updatePluginRegistry } from "../registry.js";
import { MissingDependenciesError, MissingPluginDependenciesError } from "../types.js";
import { MarketplaceError } from "../../marketplace/errors.js";
import { IncompatibleHostProtocolError } from "../isolation/host-api-wire.js";
import { pluginConsent, requireConsentEqual, UpdateNeedsReviewError } from "../../marketplace/updates/consent.js";
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

/** A bundled command hook and its additional payload files. */
const HOOK_FILES: Record<string, string> = {
  "hooks/audit.json": JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["node", "${PLUGIN_ROOT}/hooks/audit.js"] }] }] } }),
  "hooks/audit.js": "process.exit(0)",
};

function withHook(document: Record<string, unknown>): Record<string, unknown> {
  const extensions = document.extensions as Record<string, Record<string, unknown>>;
  return { ...document, extensions: { "ai.agent-connector.ave": { ...extensions["ai.agent-connector.ave"], hooks: [{ id: "audit", path: "hooks/audit.json" }] } } };
}

function staged(forPlan: PluginInstallPlan, document = pluginDocument(forPlan.version, forPlan.authority), extra: Record<string, string> = {}): StagedPluginArtifact {
  const zip = new AdmZip();
  zip.addFile("plugin.json", Buffer.from(JSON.stringify(document)));
  zip.addFile("dist/index.js", Buffer.from(ENTRY_JS));
  for (const [path, text] of Object.entries(extra)) zip.addFile(path, Buffer.from(text));
  const zipBuffer = zip.toBuffer();
  return {
    plan: forPlan,
    zipBuffer,
    artifactSha256: createHash("sha256").update(zipBuffer).digest("hex"),
    rung: "archive",
    unencrypted: false,
    notInstalled: [],
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
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
    if (priorEnv === undefined) delete process.env.AVE_DEV;
    else process.env.AVE_DEV = priorEnv;
    _resetForTest();
  });

  const install = (forPlan: PluginInstallPlan, artifact = staged(forPlan), activate = activateAndCommitPreparedPluginForTest) =>
    service.installGitPlugin(forPlan, { stage: async () => artifact, activatePreparedArtifact: activate });

  const entry = async () => (await readPluginRegistry(registryPath)).plugins.find((item) => item.id === "alpha");

  it.each(["receipt", "registry"] as const)("preserves the install error when %s recovery fails", async (phase) => {
    await install(plan());
    const primary = new Error("registry commit refused");
    const secondary = new Error("secondary recovery refused");
    const internals = service as unknown as { commitGitRegistryEntry(...args: unknown[]): Promise<void> };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const commit = vi.spyOn(internals, "commitGitRegistryEntry").mockImplementationOnce(async () => {
      if (phase === "receipt") {
        vi.spyOn(receiptStore, "restoreInstallReceiptRaw").mockRejectedValueOnce(secondary);
      } else {
        vi.spyOn(updateRecovery, "recoverPendingPluginUpdate").mockRejectedValueOnce(secondary);
      }
      throw primary;
    });
    await expect(install(plan("2.0.0"))).rejects.toBe(primary);
    expect(commit).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls.map((args) => args.join(" ")).some((message) => message.includes(secondary.message))).toBe(true);
  });

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

  it("keeps the planned host protocol at the extracted manifest gate", async () => {
    const forPlan = plan("1.0.0", {
      minAppVersion: "0.15.0",
      hostProtocol: "4",
      authority: authority({ requires: { minAppVersion: "0.15.0", hostProtocol: "4" } }),
    });
    await expect(install(forPlan)).resolves.toMatchObject({ pluginId: "alpha", installed: true });
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

  describe("a process entry: the zip transaction admits the verified rung (§9.7 P4)", () => {
    const processAuthority = authority({ requires: { minAppVersion: "0.15.0", hostProtocol: "4" } });

    function processZip(): Buffer {
      const document = {
        name: "alpha", version: "1.0.0", description: "alpha",
        extensions: { "ai.agent-connector.ave": { displayName: "Alpha", process: { command: "./bin/plugin" }, tools: [], ...processAuthority } },
      };
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(document)));
      zip.addFile("bin/plugin", Buffer.from("#!/bin/sh\nexit 0\n"), "", 0o755);
      return zip.toBuffer();
    }

    /** The release pin defaults to the archive digest; rung identifies the staged artifact source. */
    function processInstall(rung: "release" | "tree", patch: Partial<PluginInstallPlan> = {}, pin?: string) {
      const zipBuffer = processZip();
      const digest = createHash("sha256").update(zipBuffer).digest("hex");
      const forPlan = plan("1.0.0", {
        minAppVersion: "0.15.0",
        hostProtocol: "4",
        platforms: ["darwin", "linux"],
        authority: processAuthority,
        artifact: { release: { repo: "acme/alpha", sha256: pin ?? digest } },
        ...patch,
      });
      const artifact: StagedPluginArtifact = {
        plan: forPlan,
        zipBuffer,
        artifactSha256: digest,
        rung,
        unencrypted: false,
        notInstalled: [],
        rungs: rung === "release"
          ? [{ rung: "release", outcome: "used" }]
          : [
            { rung: "release", outcome: "failed", code: "SOURCE_UNREACHABLE", message: "HTTP 404" },
            { rung: "archive", outcome: "skipped", reason: "NOT_DECLARED" },
            { rung: "tree", outcome: "used" },
          ],
        manifestDocument: JSON.parse(new AdmZip(zipBuffer).readAsText("plugin.json")) as unknown,
      };
      return { forPlan, artifact };
    }

    async function nothingLeft(): Promise<void> {
      expect(await entry()).toBeUndefined();
      expect(existsSync(join(pluginsDir, "alpha"))).toBe(false);
      expect(existsSync(installReceiptPath(cacheRoot, "alpha"))).toBe(false);
    }

    it("installs one staged from a pinned release, and its receipt records the release rung", async () => {
      const { forPlan, artifact } = processInstall("release");
      await expect(install(forPlan, artifact)).resolves.toMatchObject({ pluginId: "alpha", installed: true });
      expect(await entry()).toMatchObject({ origin: { rung: "release", artifactSha256: artifact.artifactSha256 } });
      expect(await verifyInstallReceipt(cacheRoot, "alpha", join(pluginsDir, "alpha"))).toMatchObject({
        ok: true,
        receipt: { installSource: "git", artifactSha256: artifact.artifactSha256, git: { rung: "release", sourceOrigin: "custom" } },
      });
    });

    it("refuses one the transaction would commit from the tree rung, leaving nothing behind", async () => {
      const { forPlan, artifact } = processInstall("tree");
      await expect(install(forPlan, artifact)).rejects.toMatchObject({ code: "process-entry-requires-pinned-artifact" });
      await nothingLeft();
    });

    it("refuses one whose receipt names a direct source, even from a pinned release", async () => {
      const { forPlan, artifact } = processInstall("release", { sourceOrigin: "direct", packagePath: "" });
      await expect(install(forPlan, artifact)).rejects.toMatchObject({ code: "process-entry-requires-pinned-artifact" });
      await nothingLeft();
    });

    it("refuses one whose staged digest is not the pin the plan carries, before activation", async () => {
      const { forPlan, artifact } = processInstall("release", {}, "d".repeat(64));
      let activated = false;
      await expect(install(forPlan, artifact, async (prepared) => {
        activated = true;
        return activateAndCommitPreparedPluginForTest(prepared);
      })).rejects.toMatchObject({ code: "ARTIFACT_DIGEST_MISMATCH", message: expect.stringContaining(`the catalog pins ${"d".repeat(64)}`) });
      expect(activated).toBe(false);
      await nothingLeft();
    });

    it("refuses one whose prepared receipt does not verify against the staged payload, before activation", async () => {
      const { forPlan, artifact } = processInstall("release");
      const receipts = service as unknown as { prepareGitInstallReceipt: (...args: unknown[]) => Promise<string> };
      const prepare = receipts.prepareGitInstallReceipt.bind(service);
      // Valid provenance does not imply the payload digest matches.
      receipts.prepareGitInstallReceipt = async (...args) => {
        const receipt = JSON.parse(await prepare(...args)) as { files: Array<{ sha256: string }> };
        receipt.files[0]!.sha256 = "0".repeat(64);
        return JSON.stringify(receipt);
      };
      let activated = false;
      await expect(install(forPlan, artifact, async (prepared) => {
        activated = true;
        return activateAndCommitPreparedPluginForTest(prepared);
      })).rejects.toThrow("prepared receipt does not verify against its staged payload");
      expect(activated).toBe(false);
      await nothingLeft();
    });

    it("refuses at the extracted manifest when the plan lets it run on Windows", async () => {
      const { forPlan, artifact } = processInstall("release", { platforms: ["darwin", "win32", "linux"] });
      await expect(install(forPlan, artifact)).rejects.toMatchObject({ code: "MANIFEST_MISMATCH" });
      await nothingLeft();
    });
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
    // Catalog receipts may predate origin metadata.
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
    // Crash after promotion but before commit.
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

  it("stores the consent it installed with in the receipt, and reads the baseline from there (§18.7.3)", async () => {
    await install(plan());
    const expected = pluginConsent(pluginDocument("1.0.0"), [
      { path: "plugin.json", data: Buffer.from(JSON.stringify(pluginDocument("1.0.0"))) },
      { path: "dist/index.js", data: Buffer.from(ENTRY_JS) },
    ]);
    const receipt = await verifyInstallReceipt(cacheRoot, "alpha", join(pluginsDir, "alpha"));
    expect(receipt.ok && "git" in receipt.receipt ? receipt.receipt.git.consent : null).toEqual(expected);
    await expect(service.getInstalledConsentBaseline("alpha")).resolves.toMatchObject({ consent: expected, enabled: true, reviewedAppVersion: null });
  });

  it("computes a baseline for a receipt from before slice F from the receipt-covered bytes, and none from bytes that no longer match", async () => {
    await install(plan());
    const path = installReceiptPath(cacheRoot, "alpha");
    const raw = JSON.parse(await readFile(path, "utf8")) as { git: Record<string, unknown> };
    const stored = raw.git.consent;
    delete raw.git.consent;
    await writeFile(path, JSON.stringify(raw));
    await expect(service.getInstalledConsentBaseline("alpha")).resolves.toMatchObject({ consent: stored });
    await writeFile(join(pluginsDir, "alpha", "dist", "index.js"), "export default 'changed';\n");
    await expect(service.getInstalledConsentBaseline("alpha")).resolves.toMatchObject({ consent: { kind: "plugin", fields: {}, unknown: ["*"] }, files: null });
  });

  it("checkpoint two: a staged plugin.json with a new bundled hook throws UpdateNeedsReviewError before activation, and installs nothing", async () => {
    await install(plan("1.0.0"));
    const before = await entry();
    const baseline = (await service.getInstalledConsentBaseline("alpha"))!.consent;
    const next = plan("1.1.0");
    let activated = false;
    const attempt = service.installGitPlugin(next, {
      stage: async () => staged(next, withHook(pluginDocument("1.1.0")), HOOK_FILES),
      assertConsent: requireConsentEqual("alpha", baseline),
      activatePreparedArtifact: async (prepared) => {
        activated = true;
        return activateAndCommitPreparedPluginForTest(prepared);
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(UpdateNeedsReviewError);
    await expect(attempt).rejects.toMatchObject({ delta: [expect.objectContaining({ field: "contributionKinds" }), expect.objectContaining({ field: "hook:audit", before: null })] });
    expect(activated).toBe(false);
    expect(await entry()).toEqual(before);
    expect(JSON.parse(await readFile(join(pluginsDir, "alpha", "plugin.json"), "utf8"))).toMatchObject({ version: "1.0.0" });

    await expect(service.installGitPlugin(next, { stage: async () => staged(next), assertConsent: requireConsentEqual("alpha", baseline), activatePreparedArtifact: activateAndCommitPreparedPluginForTest }))
      .resolves.toMatchObject({ version: "1.1.0" });
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

  it("reports a host-protocol refusal at activation as the update's PACKAGE_INCOMPATIBLE failure", async () => {
    await install(plan("1.0.0"));
    const before = await entry();
    const refusal = new IncompatibleHostProtocolError("alpha", { declared: null });
    const failure = await install(plan("1.1.0"), undefined, async () => {
      throw refusal;
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketplaceError);
    expect(failure).toMatchObject({
      code: "PACKAGE_INCOMPATIBLE",
      message: refusal.message,
      detail: { reason: "host_protocol", name: "alpha" },
    });
    expect((failure as Error).cause).toBe(refusal);
    expect(await entry()).toEqual(before);
    expect(JSON.parse(await readFile(join(pluginsDir, "alpha", "plugin.json"), "utf8"))).toMatchObject({ version: "1.0.0" });
  });

  it("passes any other activation failure through untranslated", async () => {
    await install(plan("1.0.0"));
    const other = new Error("activation refused");
    const failure = await install(plan("1.1.0"), undefined, async () => {
      throw other;
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBe(other);
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
