import { AsyncResource } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { AlertPredecessorAccess } from "../alert-predecessor.js";
import { MarketplaceService } from "../../../marketplace/app/service.js";
import { EMPTY_MARKETPLACE_POLICY } from "../../../marketplace/sources/policy.js";
import { isPluginInstallLockHeld, withPluginInstallLock } from "../../../plugins/install-lifecycle.js";

function harness() {
  const installed = [
    { kind: "plugin", name: "retired-plugin", version: "1.0.0", sourceId: "trusted", originCommit: null },
    { kind: "plugin", name: "successor", version: "2.0.0", sourceId: "trusted", originCommit: null },
  ];
  const row = { kindKey: "successor:reply", pluginId: "successor", blockedByPredecessor: "retired-plugin",
    declaration: { inherits: [{ pluginId: "retired-plugin", sourceId: "trusted" }] } };
  const successors = { plugins: [{ pluginId: "successor", anySource: false }], hostKinds: [] };
  const uninstall = vi.fn(async () => {
    expect(isPluginInstallLockHeld("successor")).toBe(true);
    expect(isPluginInstallLockHeld("retired-plugin")).toBe(true);
    expect(isPluginInstallLockHeld("successor-alias")).toBe(true);
  });
  const market = new MarketplaceService({
    registry: { list: () => [{ id: "trusted" }] },
    syncer: { readSnapshot: async () => ({ revocations: [], conditionalRevocations: [
      { kind: "plugin", name: "retired-plugin", versions: "*", appVersions: "0.12.0", action: "uninstall", successors },
    ] }), readRevocations: async () => [] },
    versionContext: () => ({ appVersion: "0.12.0" }), policy: EMPTY_MARKETPLACE_POLICY, previewTokens: new Map(),
    installers: { plugin: { list: async () => structuredClone(installed), uninstall },
      mcp: { list: async () => [] }, content: { list: async () => [] } },
    revocations: { apply: async () => {} }, log: { warn: () => {} },
  } as never);
  const listKinds = vi.fn(async () => [structuredClone(row)]);
  const catalog = vi.fn(async () => ({ entries: [{ key: { kind: "plugin", name: "retired-plugin", sourceId: "trusted" }, required: false }] }));
  const access = new AlertPredecessorAccess({
    alertsService: { listKinds }, pluginMarketplace: { listInstalledPackages: async () => structuredClone(installed) },
    pluginRuntime: { getPluginManifest: () => null, listPluginIds: () => [],
      resolvePluginId: (id: string) => id === "successor" ? "successor-alias" : id,
      resolvePluginInstallIdIfKnown: (id: string) => id },
  } as never, async () => ({ catalog, getRetirementEntry: market.getRetirementEntry.bind(market), uninstall: market.uninstall.bind(market) }) as never);
  return { access, installed, successors, row, uninstall, listKinds, catalog };
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
