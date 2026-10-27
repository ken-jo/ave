/** Exercises queued updates against current policy, consent and staged bytes. */
import { mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getAveAppVersion } from "../../../shared/app-version.js";
import { FakeVolume, nodeFolders, writeFolderFiles } from "../../__tests__/fixtures/folder-fs.js";
import { folderService, type FolderServiceHarness } from "../../__tests__/fixtures/folder-service.js";
import { sha256Hex as sha } from "../../__tests__/fixtures/package-files.js";
import { policyLoad, policySource } from "../../__tests__/fixtures/policy.js";
import { scrubMarketplaceStrings } from "../../errors.js";
import { classifyUpdate, type AutoUpdateSettings } from "../../updates/eligibility.js";
import type { ApplyDecision } from "../service.js";

const RELEASE = { release: { repo: "acme/alpha", sha256: sha("never fetched") } };

const ENTRY_JS = "export default { version: 1 };\n";
const KEY = { sourceId: "team", kind: "plugin" as const, name: "alpha" };
const HOOK = {
  "plugins/alpha/dist/hooks/audit.json": JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["node", "${PLUGIN_ROOT}/dist/hooks/audit.js"] }] }] } }),
  "plugins/alpha/dist/hooks/audit.js": "process.exit(0)\n",
};

function authority(capabilities: string[]) {
  return { capabilities, requires: { minAppVersion: "0.14.0", hostProtocol: "4" } };
}

function pluginFiles(options: { capabilities?: string[]; hook?: boolean } = {}): Record<string, string> {
  const auth = authority(options.capabilities ?? ["notes:read"]);
  const extension = { displayName: "alpha", entry: "dist/index.js", ...auth, ...(options.hook ? { hooks: [{ id: "audit", path: "dist/hooks/audit.json" }] } : {}) };
  return {
    "plugins/alpha/plugin.json": `${JSON.stringify({ name: "alpha", version: "1.0.0", description: "alpha", extensions: { "ai.agent-connector.ave": extension } }, null, 2)}\n`,
    "plugins/alpha/ave-package.json": `${JSON.stringify({ schemaVersion: 2, kind: "plugin", name: "alpha", version: "1.0.0", minAppVersion: "0.14.0", hostProtocol: "4", payload: { authority: auth, artifact: RELEASE } })}\n`,
    ...(options.hook ? HOOK : {}),
  };
}

const index = `${JSON.stringify({ schemaVersion: 2, name: "team", displayName: "Team tools", packages: [{ kind: "plugin", name: "alpha", path: "plugins/alpha" }] })}\n`;

let root: string;
let folder: string;
let harness: FolderServiceHarness;
let ownership: "user" | "required" = "user";
let sourceStorage: "disk" | "volume" = "volume";
let sourceFolders: ReturnType<typeof nodeFolders>;
let sourceVolume: FakeVolume | null;

function writeSourceFiles(files: Record<string, string>): void {
  if (!sourceVolume) {
    writeFolderFiles(folder, files);
    return;
  }
  for (const [path, contents] of Object.entries(files)) sourceVolume.file(join(folder, path), contents);
}

async function setUp(managed: "user" | "required"): Promise<void> {
  root = mkdtempSync(join(tmpdir(), "ave-auto-update-"));
  folder = join(mkdtempSync(join(tmpdir(), "ave-auto-update-src-")), "market");
  sourceVolume = sourceStorage === "volume" ? new FakeVolume(process.platform, { drives: { [tmpdir().slice(0, 2).toUpperCase()]: "\\Device\\HarddiskVolume1" } }) : null;
  sourceFolders = sourceVolume ? { ...nodeFolders(), fs: sourceVolume } : nodeFolders();
  writeSourceFiles({ "marketplace.json": index, ...pluginFiles(), "plugins/alpha/dist/index.js": ENTRY_JS });
  if (managed === "required") {
    if (!sourceVolume) folder = realpathSync(folder);
    harness = await folderService({ root, folders: sourceFolders, policy: policySource(requiredPolicy(true)) });
    await harness.service.refresh("team");
  } else {
    harness = await folderService({ root, folders: sourceFolders });
    const preview = await harness.service.previewSource({ input: folder, auth: "none" });
    if (preview.type !== "marketplace") throw new Error(`expected a marketplace preview, got ${preview.type}`);
    await harness.service.addSource({ previewId: preview.previewId, id: "team" });
  }
  await harness.service.executeInstall((await harness.service.planInstall(KEY)).planId, [], true);
}

function requiredPolicy(required: boolean) {
  return {
    additional: [{ transport: "folder" as const, id: "team", path: folder }],
    requiredInstalls: required ? [{ source: "team", kind: "plugin" as const, name: "alpha" }] : [],
  };
}

function decideWith(settings: AutoUpdateSettings): ApplyDecision {
  return (facts, policy) => classifyUpdate(facts, { policy, settings, memory: null, skipped: false })?.state === "automatic";
}
const automatic = decideWith({});

beforeEach(async () => {
  await setUp(ownership);
});

afterEach(() => {
  harness.service.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(dirname(folder), { recursive: true, force: true });
});

async function edit(files: Record<string, string>): Promise<void> {
  writeSourceFiles(files);
  await harness.service.refresh("team");
}

const target = { key: KEY, from: "1.0.0", to: "1.0.0", switchSource: false };

describe("a folder's refresh (§18.7.6)", () => {
  beforeAll(() => { sourceStorage = "disk"; });
  afterAll(() => { sourceStorage = "volume"; });
  it("is offered when the tree changes at the same version, applies by itself, and is gone once applied", async () => {
    expect(await harness.service.updates()).toEqual([]);
    await edit({ "plugins/alpha/dist/index.js": "export default { version: 2 };\n" });
    expect(await harness.service.updates()).toEqual([{ key: KEY, displayName: "alpha", from: "1.0.0", to: "1.0.0" }]);
    const [candidate] = await harness.service.updateCandidates(new Set(["team"]));
    expect(candidate).toMatchObject({ facts: { change: "refresh", consent: [], unconfirmedApprovals: [], required: false, enabled: true, policyBlocked: false } });

    await expect(harness.service.applyUpdate(target, automatic)).resolves.toEqual({ state: "applied" });
    expect(harness.installed.get("alpha")).toMatchObject({ reviewedAppVersion: getAveAppVersion() });
    expect(await harness.service.updates()).toEqual([]);
    await expect(harness.service.appliedState(KEY, "1.0.0")).resolves.toEqual({ state: "applied" });
  });
});

describe("checkpoint two (§18.7.3)", () => {
  it("defers an automatic update whose staged bytes add a bundled hook: needs-review, nothing installed", async () => {
    const before = harness.installed.get("alpha");
    await edit({ ...pluginFiles({ hook: true }) });
    const [candidate] = await harness.service.updateCandidates(new Set(["team"]));
    // Bundled hooks are invisible to the catalog, so checkpoint one cannot detect them.
    expect(candidate?.facts.consent).toEqual([]);
    const outcome = await harness.service.applyUpdate(target, automatic);
    expect(outcome).toMatchObject({ state: "needs-review", delta: expect.arrayContaining([expect.objectContaining({ field: "hook:audit", before: null })]) });
    expect(harness.installed.get("alpha")).toBe(before);
  });

  it("an update that changes nothing it was accepted with applies", async () => {
    await edit({ "plugins/alpha/dist/index.js": "export default { version: 3 };\n" });
    await expect(harness.service.applyUpdate(target, automatic)).resolves.toEqual({ state: "applied" });
  });
});

describe("the update review (§18.7.3)", () => {
  it("stages before approval and shows a catalog-visible capability and a bundled hook together; executing installs the staged bytes once", async () => {
    await edit({ ...pluginFiles({ capabilities: ["notes:read", "notes:write"], hook: true }) });
    const stage = vi.spyOn(harness.service as unknown as { stagePlugin: (...args: unknown[]) => Promise<unknown> }, "stagePlugin");
    const review = await harness.service.planUpdate(KEY);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(review.consentDelta).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "authority.capabilities", checkpoint: "catalog", before: ["notes:read"], after: ["notes:read", "notes:write"] }),
      expect.objectContaining({ field: "hook:audit", checkpoint: "staged", before: null }),
    ]));
    expect(review.codeFreeChange).toBe(false);
    const hook = review.reviewComponents.find((component) => component.field === "hook:audit");
    expect(hook).toMatchObject({ kind: "extension", consent: { kind: "extension", component: "hook", localId: "audit", approvalDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) } });

    await harness.service.executeInstall(review.planId, [hook!.consent], true);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(harness.installed.get("alpha")?.componentConsents).toEqual([hook!.consent]);
  });

  it("a code-free release of a package with a hook is the one-row review", async () => {
    await edit({ ...pluginFiles({ hook: true }) });
    await harness.service.executeInstall((await harness.service.planUpdate(KEY)).planId, [], true);
    await edit({ "plugins/alpha/dist/README.md": "# alpha\n\nBetter words.\n" });
    const review = await harness.service.planUpdate(KEY);
    expect(review.consentDelta).toEqual([expect.objectContaining({ field: "hook:audit", changedFiles: { code: [], nonCode: ["dist/README.md"] } })]);
    expect(review.codeFreeChange).toBe(true);
  });
});

describe("required and superseded updates (§18.7.2, §18.7.4)", () => {
  it("does nothing for an update whose package changed since it was classified", async () => {
    await edit({ "plugins/alpha/dist/index.js": "export default { version: 2 };\n" });
    const installs = harness.plugins.length;
    await expect(harness.service.applyUpdate({ ...target, from: "0.9.0" }, automatic)).resolves.toEqual({ state: "superseded" });
    await expect(harness.service.applyUpdate({ ...target, key: { ...KEY, sourceId: "other" } }, automatic)).resolves.toEqual({ state: "superseded" });
    expect(harness.plugins.length).toBe(installs);
  });

  it("never races a user uninstall: the update started after it waits, finds the package gone, and installs nothing", async () => {
    await edit({ "plugins/alpha/dist/index.js": "export default { version: 2 };\n" });
    const installs = harness.plugins.length;
    let resume!: () => void;
    harness.onUninstall.current = () => new Promise<void>((resolve) => { resume = resolve; });
    const uninstall = harness.service.uninstall({ sourceId: "team", kind: "plugin", name: "alpha" });
    await vi.waitFor(() => expect(resume).toBeTypeOf("function"));
    const update = harness.service.applyUpdate(target, automatic);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(harness.plugins.length).toBe(installs);
    resume();
    await uninstall;
    await expect(update).resolves.toEqual({ state: "superseded" });
    expect(harness.installed.has("alpha")).toBe(false);
    expect(harness.plugins.length).toBe(installs);
  });

  it("reports package transactions idle only once the last package lock is released", async () => {
    const idle: boolean[] = [];
    const observedRoot = mkdtempSync(join(tmpdir(), "ave-auto-update-idle-"));
    const observed = await folderService({ root: observedRoot, folders: sourceFolders,
      onPackageTransactionsIdle: () => idle.push(observed.service.packageTransactionsIdle) });
    onTestFinished(() => {
      observed.service.close();
      rmSync(observedRoot, { recursive: true, force: true });
    });
    const preview = await observed.service.previewSource({ input: folder, auth: "none" });
    if (preview.type !== "marketplace") throw new Error(`expected a marketplace preview, got ${preview.type}`);
    await observed.service.addSource({ previewId: preview.previewId, id: "team" });
    await observed.service.executeInstall((await observed.service.planInstall(KEY)).planId, [], true);
    idle.length = 0;
    let resume!: () => void;
    observed.onUninstall.current = () => new Promise<void>((resolve) => { resume = resolve; });
    const uninstall = observed.service.uninstall({ sourceId: "team", kind: "plugin", name: "alpha" });
    await vi.waitFor(() => expect(resume).toBeTypeOf("function"));
    expect(observed.service.packageTransactionsIdle).toBe(false);
    expect(idle).toEqual([]);
    resume();
    await uninstall;
    expect(idle).toEqual([true]);
  });

  it("refuses to approve components through another package's key", async () => {
    await expect(harness.service.approveComponents(KEY, "11111111-2222-4333-8444-555555555555", [])).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
  });

  it("an approved component with no approval digest to carry holds the update for review", async () => {
    await edit({ "plugins/alpha/dist/index.js": "export default { version: 2 };\n" });
    harness.approvals.set("alpha", [{ field: "hook:audit", approvalDigest: "a".repeat(64), approved: true, recordDigest: null }]);
    const [candidate] = await harness.service.updateCandidates(new Set(["team"]));
    expect(candidate?.facts.unconfirmedApprovals).toEqual(["hook:audit"]);
  });
});

describe("nothing queued authorizes an update: the policy, the switches and shutdown are read when its turn comes (§18.7.4)", () => {
  it("does not apply an update queued while automatic once the switch is turned off", async () => {
    await edit({ "plugins/alpha/dist/index.js": "export default { version: 2 };\n" });
    const [candidate] = await harness.service.updateCandidates(new Set(["team"]));
    expect(automatic(candidate!.facts, "user")).toBe(true);
    const installs = harness.plugins.length;
    await expect(harness.service.applyUpdate(target, decideWith({ autoUpdatePackages: { alpha: "off" } }))).resolves.toEqual({ state: "superseded" });
    expect(harness.plugins.length).toBe(installs);
  });

  it("does not start an update cancelled while it waits for the package lock", async () => {
    await edit({ "plugins/alpha/dist/index.js": "export default { version: 22 };\n" });
    const installs = harness.plugins.length;
    let release!: () => void;
    harness.onUninstall.current = () => new Promise<void>((resolve) => { release = resolve; });
    const uninstall = harness.service.uninstall({ sourceId: "team", kind: "plugin", name: "alpha" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const shutdown = new AbortController();
    const update = harness.service.applyUpdate(target, automatic, shutdown.signal);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    shutdown.abort(new Error("shutdown"));
    await expect(update).rejects.toThrow("shutdown");
    release();
    await uninstall;
    expect(harness.plugins.length).toBe(installs);
  });
});

describe("a required update (§18.7.2)", () => {
  beforeAll(() => {
    ownership = "required";
  });
  afterAll(() => {
    ownership = "user";
  });

  describe("a required folder read and update on disk", () => {
    beforeAll(() => { sourceStorage = "disk"; });
    afterAll(() => { sourceStorage = "volume"; });
    it("is reviewed by the policy, skips checkpoint two, and leaves a new hook waiting as approval-pending", async () => {
      await edit({ ...pluginFiles({ hook: true }) });
      harness.onInstalled.current = (name) => {
        harness.approvals.set(name, [{ field: "hook:audit", approvalDigest: "a".repeat(64), approved: false, recordDigest: null }]);
      };
      // Required policy entries authorize updates even with user switches off.
      await expect(harness.service.applyUpdate(target, decideWith({ autoUpdate: false }))).resolves.toEqual({ state: "approval-pending" });
      expect(harness.installed.get("alpha")).toMatchObject({ reviewedAppVersion: getAveAppVersion() });
      await expect(harness.service.appliedState(KEY, "1.0.0")).resolves.toEqual({ state: "approval-pending", pendingApproval: null });
      harness.approvals.set("alpha", [{ field: "hook:audit", approvalDigest: "a".repeat(64), approved: true, recordDigest: "a".repeat(64) }]);
      await expect(harness.service.appliedState(KEY, "1.0.0")).resolves.toEqual({ state: "applied" });
    });
  });

  it("once the policy no longer requires it, a queued update that asks for more is held for review, not applied", async () => {
    await edit(pluginFiles({ capabilities: ["notes:read", "notes:write"] }));
    const [candidate] = await harness.service.updateCandidates(new Set(["team"]));
    expect(candidate?.facts).toMatchObject({ required: true, consent: [expect.objectContaining({ field: "authority.capabilities" })] });
    const before = harness.installed.get("alpha");
    harness.policy.change(policyLoad(requiredPolicy(false)));
    await expect(harness.service.applyUpdate(target, automatic)).resolves.toEqual({ state: "superseded" });
    expect(harness.policy.load).toMatchObject({ ok: true, policy: { requiredInstalls: [] } });
    expect(harness.installed.get("alpha")).toBe(before);
  });
});

describe("an install in a requirement's way whose package sheet cannot load (§10.2)", () => {
  const requireOfficial = () => harness.policy.change(policyLoad({ requiredInstalls: [{ source: "ave", kind: "plugin", name: "alpha" }] }));
  const unmet = async () => (await harness.service.autoUpdateContext()).unmetRequired;

  it("names an install whose source still lists it for its sheet, and one whose source stopped listing it for a direct uninstall", async () => {
    requireOfficial();
    expect(await unmet()).toEqual([
      expect.objectContaining({ key: { sourceId: "ave", kind: "plugin", name: "alpha" }, reason: "source-unreachable", installedFrom: { sourceId: "team", label: "Team tools", removal: "sheet" } }),
    ]);
    await expect(harness.service.detail(KEY)).resolves.toMatchObject({ entry: { key: KEY } });
    await edit({ "marketplace.json": `${JSON.stringify({ schemaVersion: 2, name: "team", displayName: "Team tools", packages: [] })}\n` });
    expect((await unmet())[0]!.installedFrom).toEqual({ sourceId: "team", label: "Team tools", removal: "confirm" });
    await expect(harness.service.detail(KEY)).rejects.toMatchObject({ code: "PACKAGE_INCOMPATIBLE" });
    await expect(harness.service.uninstall(KEY)).resolves.toEqual({ key: KEY, keptDataDir: null });
    expect(harness.installed.has("alpha")).toBe(false);
    expect((await unmet())[0]!.installedFrom).toBeNull();
  });

  it("refuses a removal whose install changed since the row named it, and removes nothing else", async () => {
    requireOfficial();
    const shown = (await unmet())[0]!.installedFrom!;
    expect(shown).toMatchObject({ sourceId: "team" });
    const item = harness.installed.get("alpha")!;
    harness.installed.set("alpha", { ...item, sourceId: "other-tools" });
    await expect(harness.service.uninstall({ sourceId: shown.sourceId, kind: "plugin", name: "alpha" })).rejects.toMatchObject({
      code: "PACKAGE_ID_CONFLICT",
      message: "plugin alpha is not installed from team",
    });
    expect(harness.installed.get("alpha")).toEqual({ ...item, sourceId: "other-tools" });
    harness.installed.delete("alpha");
    await expect(harness.service.uninstall({ sourceId: shown.sourceId, kind: "plugin", name: "alpha" })).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
  });

  it("names an install whose source was removed by the id its receipt holds, and uninstalls it by that id", async () => {
    expect(await harness.service.removeSource("team")).toEqual({ orphanedPackages: [KEY] });
    requireOfficial();
    expect((await unmet())[0]!.installedFrom).toEqual({ sourceId: "team", label: "team", removal: "confirm" });
    await expect(harness.service.uninstall(KEY)).resolves.toEqual({ key: KEY, keptDataDir: null });
    expect(harness.installed.has("alpha")).toBe(false);
  });
});

describe("a quarantined source (§18.8)", () => {
  it("offers no update, applies none, and leaves its id and its packages out of the switches", async () => {
    await edit({ "plugins/alpha/dist/index.js": "export default { version: 2 };\n" });
    expect(await harness.service.updates()).toHaveLength(1);
    const item = harness.installed.get("alpha")!;
    harness.service.close();
    const quarantinedId = `glp${"at-"}${"abcd1234".repeat(3)}`;
    const list = join(root, "marketplaces", "sources.json");
    writeFileSync(list, readFileSync(list, "utf8").replace('"team"', JSON.stringify(quarantinedId)));
    const data = join(root, "marketplaces", quarantinedId);
    renameSync(join(root, "marketplaces", "team"), data);
    for (const file of readdirSync(join(data, "snapshots"))) {
      const snapshot = join(data, "snapshots", file);
      writeFileSync(snapshot, readFileSync(snapshot, "utf8").replace('"sourceId":"team"', `"sourceId":${JSON.stringify(quarantinedId)}`));
    }
    harness = await folderService({ root, folders: sourceFolders });
    harness.installed.set("alpha", { ...item, sourceId: quarantinedId });

    const context = await harness.service.autoUpdateContext();
    expect(JSON.stringify(context)).not.toContain(quarantinedId);
    expect(context.installed).toEqual([]);
    expect(await harness.service.updates()).toEqual([]);
    expect(await harness.service.updateCandidates(new Set([quarantinedId]))).toEqual([]);
    const quarantined = { key: { sourceId: quarantinedId, kind: "plugin" as const, name: "alpha" }, from: "1.0.0", to: "1.0.0", switchSource: false };
    await expect(harness.service.applyUpdate(quarantined, automatic)).resolves.toEqual({ state: "superseded" });
    expect(harness.installed.get("alpha")).toEqual({ ...item, sourceId: quarantinedId });
  });
  async function quarantineTeam(): Promise<string> {
    const item = harness.installed.get("alpha")!;
    harness.service.close();
    const quarantinedId = `glp${"at-"}${"abcd1234".repeat(3)}`;
    const list = join(root, "marketplaces", "sources.json");
    writeFileSync(list, readFileSync(list, "utf8").replace('"team"', JSON.stringify(quarantinedId)));
    renameSync(join(root, "marketplaces", "team"), join(root, "marketplaces", quarantinedId));
    harness = await folderService({ root, folders: sourceFolders, policy: policySource({ requiredInstalls: [{ source: "ave", kind: "plugin", name: "alpha" }] }) });
    harness.installed.set("alpha", { ...item, sourceId: quarantinedId });
    return quarantinedId;
  }

  const published = async () => scrubMarketplaceStrings((await harness.service.autoUpdateContext()).unmetRequired);

  it("names an install bound to it in a requirement's way by the handle its Sources row carries, and uninstalls it by that handle", async () => {
    const quarantinedId = await quarantineTeam();
    const [unmet] = await published();
    const handle = (await harness.service.listSources()).find((source) => source.status.state === "id-holds-credential")!.id;
    expect(handle).toMatch(/^ave-legacy-[0-9a-f]{32}$/u);
    expect(unmet!.installedFrom).toEqual({ sourceId: handle, label: handle, removal: "confirm" });
    expect(JSON.stringify(unmet)).not.toContain(quarantinedId);
    const key = { sourceId: handle, kind: "plugin" as const, name: "alpha" };
    await expect(harness.service.uninstall(key)).resolves.toEqual({ key, keptDataDir: null });
    expect(harness.installed.has("alpha")).toBe(false);
  });

  it("keeps that handle usable once the quarantined source is removed, so the published row still uninstalls the package", async () => {
    const quarantinedId = await quarantineTeam();
    const [before] = await published();
    const handle = before!.installedFrom!.sourceId;
    expect(await harness.service.removeSource(handle)).toEqual({ orphanedPackages: [{ sourceId: handle, kind: "plugin", name: "alpha" }] });
    expect(harness.installed.get("alpha")?.sourceId).toBe(quarantinedId);
    // Derive the removed source view id from the receipt; no registry entry remains.
    const [after] = await published();
    expect(after!.installedFrom).toEqual({ sourceId: handle, label: handle, removal: "confirm" });
    const key = { sourceId: after!.installedFrom!.sourceId, kind: "plugin" as const, name: "alpha" };
    await expect(harness.service.uninstall(key)).resolves.toEqual({ key, keptDataDir: null });
    expect(harness.installed.has("alpha")).toBe(false);
    expect((await published())[0]!.installedFrom).toBeNull();
  });
});
