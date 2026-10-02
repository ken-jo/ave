import { AsyncResource } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { AlertPredecessorAccess } from "../alert-predecessor.js";
import { MarketplaceService } from "../../../marketplace/app/service.js";
import { EMPTY_MARKETPLACE_POLICY, type PolicyLoad, type PolicyUpdate } from "../../../marketplace/sources/policy.js";
import { isPluginInstallLockHeld, withPluginInstallLock } from "../../../plugins/install-lifecycle.js";

/** A policy file that changes when `change` is called: the next refresh applies the change under the exclusive lock. */
function changingPolicy() {
  let pending: PolicyUpdate | null = null;
  const source = {
    load: { ok: true, policy: EMPTY_MARKETPLACE_POLICY, path: "/fixture/ave-policy.json" } as PolicyLoad,
    digest: "fixture-0",
    check: vi.fn(async () => pending),
    apply: vi.fn((update: PolicyUpdate) => {
      source.load = update.load;
      source.digest = update.digest;
      pending = null;
    }),
    change: () => {
      pending = { load: { ok: true, policy: { ...EMPTY_MARKETPLACE_POLICY, requireHttps: true }, path: "/fixture/ave-policy.json" }, digest: "fixture-1" };
    },
  };
  return source;
}

/**
 * `sourceId` is the stored id both plugins are installed from; `viewId` is the id the catalog's view
 * carries for it — the same id, or the handle a credential-shaped one goes out as (§18.8).
 */
function harness(sourceId = "trusted", viewId = sourceId) {
  const installed = [
    { kind: "plugin", name: "retired-plugin", version: "1.0.0", sourceId, originCommit: null },
    { kind: "plugin", name: "successor", version: "2.0.0", sourceId, originCommit: null },
  ];
  const row = { kindKey: "successor:reply", pluginId: "successor", blockedByPredecessor: "retired-plugin",
    declaration: { inherits: [{ pluginId: "retired-plugin", sourceId }] } };
  const successors = { plugins: [{ pluginId: "successor", anySource: false }], hostKinds: [] };
  const uninstall = vi.fn(async () => {
    expect(isPluginInstallLockHeld("successor")).toBe(true);
    expect(isPluginInstallLockHeld("retired-plugin")).toBe(true);
    expect(isPluginInstallLockHeld("successor-alias")).toBe(true);
  });
  const policy = changingPolicy();
  const market = new MarketplaceService({
    registry: { list: () => [{ id: sourceId }] },
    syncer: { readSnapshot: async () => ({ revocations: [], conditionalRevocations: [
      { kind: "plugin", name: "retired-plugin", versions: "*", appVersions: "0.12.0", action: "uninstall", successors },
    ] }), readRevocations: async () => [] },
    versionContext: () => ({ appVersion: "0.12.0" }), policy, previewTokens: new Map(),
    installers: { plugin: { list: async () => structuredClone(installed), uninstall },
      mcp: { list: async () => [] }, content: { list: async () => [] } },
    revocations: { apply: async () => {} }, log: { warn: () => {} },
  } as never);
  const listKinds = vi.fn(async () => [structuredClone(row)]);
  const catalog = vi.fn(async () => ({ entries: [{ key: { kind: "plugin", name: "retired-plugin", sourceId: viewId }, required: false }] }));
  const access = new AlertPredecessorAccess({
    alertsService: { listKinds }, pluginMarketplace: { listInstalledPackages: async () => structuredClone(installed) },
    pluginRuntime: { getPluginManifest: () => null, listPluginIds: () => [],
      resolvePluginId: (id: string) => id === "successor" ? "successor-alias" : id,
      resolvePluginInstallIdIfKnown: (id: string) => id },
  } as never, async () => ({ catalog, getRetirementEntry: market.getRetirementEntry.bind(market), uninstallInstalled: market.uninstallInstalled.bind(market),
    asOneOperation: market.asOneOperation.bind(market) }) as never);
  return { access, installed, successors, row, uninstall, listKinds, catalog, market, policy };
}

describe("predecessor removal authority at the lifecycle boundary", () => {
  it.each([false, true])("rechecks a successor source changed during the declaration read, anySource=%s", async (anySource) => {
    const h = harness(); h.successors.plugins[0]!.anySource = anySource;
    h.listKinds.mockResolvedValueOnce([h.row]).mockImplementationOnce(async () => {
      h.installed[1]!.sourceId = "foreign";
      return [h.row];
    });
    const result = await h.access.remove(h.row.kindKey);
    expect(result.ok).toBe(anySource);
    if (anySource) expect(h.uninstall).toHaveBeenCalledExactlyOnceWith("retired-plugin", {
      reason: "superseded", sourceId: "trusted", successors: h.successors,
    });
    else expect(h.uninstall).not.toHaveBeenCalled();
  });

  it("removes a predecessor installed from a credential-shaped source id by its stored identity (§18.8)", async () => {
    // Built at run time, so no whole token sits in the source.
    const stored = `glp${"at-"}${"abcd1234".repeat(3)}`;
    const h = harness(stored, "ave-legacy-0123456789abcdef0123456789abcdef");
    const [presented] = await h.access.present([structuredClone(h.row)] as never);
    expect((presented as { predecessor: unknown }).predecessor).toMatchObject({ removable: true, locked: false });
    expect(await h.access.remove(h.row.kindKey)).toMatchObject({ ok: true });
    expect(h.uninstall).toHaveBeenCalledExactlyOnceWith("retired-plugin", { reason: "superseded", sourceId: stored, successors: h.successors });
  });

  it("holds both bindings and aliases across asynchronous checks through the real uninstall", async () => {
    const h = harness(); let switchSource: Promise<void> | undefined;
    const competingRequest = new AsyncResource("source-switch-request");
    h.catalog.mockImplementationOnce(async () => {
      switchSource = competingRequest.runInAsyncScope(() => withPluginInstallLock("successor", async () => { h.installed[1]!.sourceId = "foreign"; }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.installed[1]!.sourceId).toBe("trusted");
      return { entries: [{ key: { kind: "plugin", name: "retired-plugin", sourceId: "trusted" }, required: false }] };
    });
    expect(await h.access.remove(h.row.kindKey)).toMatchObject({ ok: true });
    await switchSource;
    competingRequest.emitDestroy();
    expect(h.installed[1]!.sourceId).toBe("foreign");
    expect(h.uninstall).toHaveBeenCalledOnce();
  });
});

describe("lock order between predecessor removal and installation (§18.6)", () => {
  it("finishes both when the policy changes while removal holds the plugin locks and an install waits for one of them", async () => {
    const h = harness();
    // Removal waits inside the plugin locks, at its authority re-read, until released.
    let releaseRemoval: () => void = () => {};
    const removalMayGo = new Promise<void>((resolve) => (releaseRemoval = resolve));
    let removalHolds: () => void = () => {};
    const removalHolding = new Promise<void>((resolve) => (removalHolds = resolve));
    h.listKinds.mockImplementationOnce(async () => [structuredClone(h.row)]).mockImplementationOnce(async () => {
      removalHolds();
      await removalMayGo;
      return [structuredClone(h.row)];
    });
    // An install inside its own marketplace operation, which then needs the predecessor's plugin lock.
    let installWaits: () => void = () => {};
    const installWaiting = new Promise<void>((resolve) => (installWaits = resolve));
    Object.assign(h.market, {
      executeInstallNow: async () => {
        installWaits();
        return withPluginInstallLock("retired-plugin", async () => ({ installed: true }));
      },
    });

    const removal = h.access.remove(h.row.kindKey);
    await removalHolding;
    const install = h.market.executeInstall("fixture-plan");
    await installWaiting;
    // The policy changes now: a service call that refreshed here would wait for the install's shared hold.
    h.policy.change();
    releaseRemoval();

    const settled = await Promise.race([
      Promise.all([removal, install]).then(() => "finished"),
      new Promise((resolve) => setTimeout(() => resolve("deadlocked"), 2_000)),
    ]);
    expect(settled).toBe("finished");
    expect(await removal).toMatchObject({ ok: true });
    expect(h.uninstall).toHaveBeenCalledOnce();
    // The change applies at the next operation, once neither holds anything.
    await h.market.asOneOperation(async () => {});
    expect(h.policy.apply).toHaveBeenCalledOnce();
    expect(h.policy.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
  });
});
