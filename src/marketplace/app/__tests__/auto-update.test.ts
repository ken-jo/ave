/**
 * Automatic updates through the real service (design §18.7.2-§18.7.6), over a
 * folder source: a folder's refresh is offered and classified, an automatic
 * update runs checkpoint two against the installed baseline, a manual review
 * stages before approval and installs exactly what it staged, a required
 * update is reviewed by the policy and may leave a component waiting, an
 * update whose package changed since it was classified does nothing, and
 * nothing it was queued with authorizes it: the policy, the switches and
 * shutdown are read again when its turn comes.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAveAppVersion } from "../../../shared/app-version.js";
import { nodeFolders, writeFolderFiles } from "../../__tests__/fixtures/folder-fs.js";
import { folderService, type FolderServiceHarness } from "../../__tests__/fixtures/folder-service.js";
import { sha256Hex as sha } from "../../__tests__/fixtures/package-files.js";
import { policyLoad, policySource } from "../../__tests__/fixtures/policy.js";
import { classifyUpdate, type AutoUpdateSettings } from "../../updates/eligibility.js";
import type { ApplyDecision } from "../service.js";

// A release is declared: the folder rung never tries it.
const RELEASE = { release: { repo: "acme/alpha", sha256: sha("never fetched") } };

const ENTRY_JS = "export default { version: 1 };\n";
const KEY = { sourceId: "team", kind: "plugin" as const, name: "alpha" };
// A folder plugin installs plugin.json and dist/ only (§18.4.2).
const HOOK = {
  "plugins/alpha/dist/hooks/audit.json": JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["node", "${PLUGIN_ROOT}/dist/hooks/audit.js"] }] }] } }),
  "plugins/alpha/dist/hooks/audit.js": "process.exit(0)\n",
};

function authority(capabilities: string[]) {
  return { capabilities, requires: { minAppVersion: "0.12.0", hostProtocol: "2" } };
}

function pluginFiles(options: { capabilities?: string[]; hook?: boolean } = {}): Record<string, string> {
  const auth = authority(options.capabilities ?? ["notes:read"]);
  const extension = { displayName: "alpha", entry: "dist/index.js", ...auth, ...(options.hook ? { hooks: [{ id: "audit", path: "dist/hooks/audit.json" }] } : {}) };
  return {
    "plugins/alpha/plugin.json": `${JSON.stringify({ name: "alpha", version: "1.0.0", description: "alpha", extensions: { "ai.agent-connector.ave": extension } }, null, 2)}\n`,
    "plugins/alpha/ave-package.json": `${JSON.stringify({ schemaVersion: 2, kind: "plugin", name: "alpha", version: "1.0.0", minAppVersion: "0.12.0", hostProtocol: "2", payload: { authority: auth, artifact: RELEASE } })}\n`,
    ...(options.hook ? HOOK : {}),
  };
}

const index = `${JSON.stringify({ schemaVersion: 2, name: "team", displayName: "Team tools", packages: [{ kind: "plugin", name: "alpha", path: "plugins/alpha" }] })}\n`;

let root: string;
let folder: string;
let harness: FolderServiceHarness;

/** A user-added folder source "team" with alpha installed, or the same folder managed by a policy that requires alpha. */
async function setUp(managed: "user" | "required"): Promise<void> {
  root = mkdtempSync(join(tmpdir(), "ave-auto-update-"));
  folder = join(mkdtempSync(join(tmpdir(), "ave-auto-update-src-")), "market");
  writeFolderFiles(folder, { "marketplace.2.json": index, ...pluginFiles(), "plugins/alpha/dist/index.js": ENTRY_JS });
  if (managed === "required") {
    folder = realpathSync(folder);
    harness = await folderService({ root, folders: nodeFolders(), policy: policySource(requiredPolicy(true)) });
    await harness.service.refresh("team");
  } else {
    harness = await folderService({ root, folders: nodeFolders() });
    const preview = await harness.service.previewSource({ input: folder, auth: "none" });
    if (preview.type !== "marketplace") throw new Error(`expected a marketplace preview, got ${preview.type}`);
    await harness.service.addSource({ previewId: preview.previewId, id: "team" });
  }
  // Installed by a reviewed install: its receipt records this app version's review.
  await harness.service.executeInstall((await harness.service.planInstall(KEY)).planId, [], true);
}

function requiredPolicy(required: boolean) {
  return {
    additional: [{ transport: "folder" as const, id: "team", path: folder }],
    requiredInstalls: required ? [{ source: "team", kind: "plugin" as const, name: "alpha" }] : [],
  };
}

/** The scheduler's judgement with the switches in `settings`, as it would read them when the update's turn comes. */
function decideWith(settings: AutoUpdateSettings): ApplyDecision {
  return (facts, policy) => classifyUpdate(facts, { policy, settings, memory: null, skipped: false })?.state === "automatic";
}
const automatic = decideWith({});

beforeEach(async () => {
  await setUp("user");
});

afterEach(() => {
  harness.service.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(dirname(folder), { recursive: true, force: true });
});

async function edit(files: Record<string, string>): Promise<void> {
  writeFolderFiles(folder, files);
  await harness.service.refresh("team");
}

const target = { key: KEY, from: "1.0.0", to: "1.0.0", switchSource: false };

describe("a folder's refresh (§18.7.6)", () => {
  it("is offered when the tree changes at the same version, applies by itself, and is gone once applied", async () => {
    expect(await harness.service.updates()).toEqual([]);
    await edit({ "plugins/alpha/dist/index.js": "export default { version: 2 };\n" });
    expect(await harness.service.updates()).toEqual([{ key: KEY, displayName: "alpha", from: "1.0.0", to: "1.0.0" }]);
    const [candidate] = await harness.service.updateCandidates(new Set(["team"]));
    expect(candidate).toMatchObject({ facts: { change: "refresh", consent: [], unconfirmedApprovals: [], required: false, enabled: true, policyBlocked: false } });

    await expect(harness.service.applyUpdate(target, automatic)).resolves.toEqual({ state: "applied" });
    // An automatic update keeps the review the installed receipt recorded.
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
    // The catalog cannot see a bundled hook: checkpoint one finds nothing.
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
    // The reviewed bytes, not a second staging, and the approved component with them.
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
    // The uninstall holds the package: the update has not read it, staged or installed anything.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(harness.plugins.length).toBe(installs);
    resume();
    await uninstall;
    await expect(update).resolves.toEqual({ state: "superseded" });
    expect(harness.installed.has("alpha")).toBe(false);
    expect(harness.plugins.length).toBe(installs);
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
    // A user uninstall holds the package's lock.
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
  beforeEach(async () => {
    harness.service.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(folder), { recursive: true, force: true });
    await setUp("required");
  });

  it("is reviewed by the policy, skips checkpoint two, and leaves a new hook waiting as approval-pending", async () => {
    await edit({ ...pluginFiles({ hook: true }) });
    harness.onInstalled.current = (name) => {
      harness.approvals.set(name, [{ field: "hook:audit", approvalDigest: "a".repeat(64), approved: false, recordDigest: null }]);
    };
    // Even with every switch off: the policy stands for the consent.
    await expect(harness.service.applyUpdate(target, decideWith({ autoUpdate: false }))).resolves.toEqual({ state: "approval-pending" });
    expect(harness.installed.get("alpha")).toMatchObject({ reviewedAppVersion: getAveAppVersion() });
    await expect(harness.service.appliedState(KEY, "1.0.0")).resolves.toEqual({ state: "approval-pending", pendingApproval: null });
    // Approved: the state clears.
    harness.approvals.set("alpha", [{ field: "hook:audit", approvalDigest: "a".repeat(64), approved: true, recordDigest: "a".repeat(64) }]);
    await expect(harness.service.appliedState(KEY, "1.0.0")).resolves.toEqual({ state: "applied" });
  });

  it("once the policy no longer requires it, a queued update that asks for more is held for review, not applied", async () => {
    await edit(pluginFiles({ capabilities: ["notes:read", "notes:write"] }));
    const [candidate] = await harness.service.updateCandidates(new Set(["team"]));
    expect(candidate?.facts).toMatchObject({ required: true, consent: [expect.objectContaining({ field: "authority.capabilities" })] });
    const before = harness.installed.get("alpha");
    // The entry is removed, the source stays managed: the next operation applies the change.
    harness.policy.change(policyLoad(requiredPolicy(false)));
    await expect(harness.service.applyUpdate(target, automatic)).resolves.toEqual({ state: "superseded" });
    expect(harness.policy.load).toMatchObject({ ok: true, policy: { requiredInstalls: [] } });
    expect(harness.installed.get("alpha")).toBe(before);
  });
});
