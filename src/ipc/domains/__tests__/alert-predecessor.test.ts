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
  type PackageLocking = { withPackage: (kind: string, name: string, fn: () => Promise<unknown>) => Promise<unknown> };

  /** An install as the service runs one: its operation, then the package's lock, then the plugin's. */
  function realInstall(h: ReturnType<typeof harness>, entered: () => void, inside: () => Promise<void> = async () => {}) {
    Object.assign(h.market, {
      executeInstallNow: async () => {
        entered();
        return (h.market as unknown as PackageLocking).withPackage("plugin", "retired-plugin", () =>
          withPluginInstallLock("retired-plugin", async () => {
            await inside();
            return { installed: true };
          }));
      },
    });
  }

  async function bothFinish(...work: Promise<unknown>[]): Promise<string> {
    return Promise.race([
      Promise.all(work).then(() => "finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadlocked"), 2_000)),
    ]);
  }

  it("finishes both when the policy changes while removal holds the plugin locks and an install waits behind it", async () => {
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
    // An install inside its own operation, which then needs the predecessor's package lock and plugin lock.
    let installEnters: () => void = () => {};
    const installEntered = new Promise<void>((resolve) => (installEnters = resolve));
    realInstall(h, installEnters);

    const removal = h.access.remove(h.row.kindKey);
    await removalHolding;
    const install = h.market.executeInstall("fixture-plan");
    await installEntered;
    // The policy changes now: a service call that refreshed here would wait for the install's shared hold.
    h.policy.change();
    releaseRemoval();

    expect(await bothFinish(removal, install)).toBe("finished");
    expect(await removal).toMatchObject({ ok: true });
    expect(h.uninstall).toHaveBeenCalledOnce();
    // The change applies at the next operation, once neither holds anything.
    await h.market.asOneOperation(async () => {});
    expect(h.policy.apply).toHaveBeenCalledOnce();
    expect(h.policy.load).toMatchObject({ ok: true, policy: { requireHttps: true } });
  });

  it("finishes both when an install holds the predecessor's package lock before removal starts: removal waits without plugin locks", async () => {
    const h = harness();
    let releaseInstall: () => void = () => {};
    const installMayGo = new Promise<void>((resolve) => (releaseInstall = resolve));
    let installHolds: () => void = () => {};
    const installHolding = new Promise<void>((resolve) => (installHolds = resolve));
    // The install holds its package lock and has not yet asked for the plugin lock.
    Object.assign(h.market, {
      executeInstallNow: async () => (h.market as unknown as PackageLocking).withPackage("plugin", "retired-plugin", async () => {
        installHolds();
        await installMayGo;
        return withPluginInstallLock("retired-plugin", async () => ({ installed: true }));
      }),
    });
    const install = h.market.executeInstall("fixture-plan");
    await installHolding;
    const removal = h.access.remove(h.row.kindKey);
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    releaseInstall();
    expect(await bothFinish(removal, install)).toBe("finished");
    expect(await removal).toMatchObject({ ok: true });
  });

  it("refuses a package lock asked for under a plugin lock, instead of waiting in the wrong order", async () => {
    const h = harness();
    const wrongOrder = withPluginInstallLock("retired-plugin", () => h.market.uninstall({ kind: "plugin", name: "retired-plugin", sourceId: "trusted" }));
    await expect(wrongOrder).rejects.toThrow(/lock order: the package lock of plugin:retired-plugin was asked for while a plugin lock is held/u);
    expect(h.uninstall).not.toHaveBeenCalled();
  });
});

describe("the service's package locks (§18.6)", () => {
  const settle = async (count = 20) => {
    for (let i = 0; i < count; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const packageOf = (name: string) => [{ kind: "plugin" as const, name }];

  it("keeps a holder's package locked when an update waiting behind it is cancelled (shutdown)", async () => {
    const h = harness();
    let releaseA!: () => void;
    let enteredA!: () => void;
    const insideA = new Promise<void>((resolve) => { enteredA = resolve; });
    const a = h.market.asOneOperation(async () => { enteredA(); await new Promise<void>((resolve) => { releaseA = resolve; }); }, packageOf("retired-plugin"));
    await insideA;
    const abort = new AbortController();
    const applyBody = vi.fn(async () => ({ state: "applied" as const }));
    Object.assign(h.market, { applyUpdateNow: applyBody });
    const b = h.market.applyUpdate({ key: { sourceId: "trusted", kind: "plugin", name: "retired-plugin" }, from: "1.0.0", to: "2.0.0", switchSource: false },
      () => true, abort.signal).catch((error: unknown) => error);
    await settle();
    abort.abort(new Error("cancel queued waiter"));
    expect(await b).toMatchObject({ message: "cancel queued waiter" });
    let enteredC = false;
    const c = h.market.asOneOperation(async () => { enteredC = true; }, packageOf("retired-plugin"));
    await settle();
    const overlapped = enteredC;
    releaseA();
    await Promise.all([a, c]);
    expect(applyBody).not.toHaveBeenCalled();
    expect(overlapped).toBe(false);
    expect(enteredC).toBe(true);
  });

  it("refuses a nested package lock asked for without the holder's lease, so no work it started inherits its ownership", async () => {
    const h = harness();
    let releaseB!: () => void;
    let enteredB!: () => void;
    const insideB = new Promise<void>((resolve) => { enteredB = resolve; });
    const b = h.market.asOneOperation(async () => { enteredB(); await new Promise<void>((resolve) => { releaseB = resolve; }); }, packageOf("b"));
    await insideB;
    let nested!: Promise<unknown>;
    let nestedInnerA = false;
    await h.market.asOneOperation(async () => {
      nested = h.market.asOneOperation(async () => {
        await h.market.asOneOperation(async () => { nestedInnerA = true; }, packageOf("a"));
      }, packageOf("b")).catch((error: unknown) => error);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }, packageOf("a"));
    let releaseC!: () => void;
    let enteredC!: () => void;
    const insideC = new Promise<void>((resolve) => { enteredC = resolve; });
    const c = h.market.asOneOperation(async () => { enteredC(); await new Promise<void>((resolve) => { releaseC = resolve; }); }, packageOf("a"));
    await insideC;
    releaseB();
    await b;
    await settle();
    const overlapped = nestedInnerA;
    releaseC();
    await c;
    expect(overlapped).toBe(false);
    expect(await nested).toMatchObject({ message: expect.stringMatching(/lock contract: plugin:b asked for without the lease of a caller holding plugin:a; pass it down/u) });
  });

  it("keeps the holder's package locked for a nested lease that outlives it, and re-enters only through that lease", async () => {
    const h = harness();
    let releaseB!: () => void;
    let enteredB!: () => void;
    const insideB = new Promise<void>((resolve) => { enteredB = resolve; });
    const b = h.market.asOneOperation(async () => { enteredB(); await new Promise<void>((resolve) => { releaseB = resolve; }); }, packageOf("b"));
    await insideB;
    let nested!: Promise<void>;
    const order: string[] = [];
    await h.market.asOneOperation(async (lease) => {
      nested = h.market.asOneOperation(async (inner) => {
        await h.market.asOneOperation(async () => { order.push("nested holds a and b"); }, packageOf("a"), inner);
      }, packageOf("b"), lease);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }, packageOf("a"));
    const c = h.market.asOneOperation(async () => { order.push("later caller holds a"); }, packageOf("a"));
    await settle();
    expect(order).toEqual([]);
    releaseB();
    await Promise.all([b, nested, c]);
    expect(order).toEqual(["nested holds a and b", "later caller holds a"]);
  });

  it("refuses a nested package lock below one the lease holds instead of waiting in a cycle", async () => {
    const h = harness();
    let firstReady!: () => void; let secondReady!: () => void;
    const firstHeld = new Promise<void>((resolve) => { firstReady = resolve; });
    const secondHeld = new Promise<void>((resolve) => { secondReady = resolve; });
    const first = h.market.asOneOperation(async (lease) => {
      firstReady(); await secondHeld;
      return h.market.asOneOperation(async () => "first extended", packageOf("b"), lease);
    }, packageOf("a"));
    const second = h.market.asOneOperation(async (lease) => {
      secondReady(); await firstHeld;
      return h.market.asOneOperation(async () => "second extended", packageOf("a"), lease);
    }, packageOf("b"));
    const outcome = await Promise.race([
      Promise.allSettled([first, second]),
      new Promise<"deadlocked">((resolve) => setTimeout(() => resolve("deadlocked"), 2_000)),
    ]);
    expect(outcome).not.toBe("deadlocked");
    expect(outcome).toEqual([
      { status: "fulfilled", value: "first extended" },
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/lock order: plugin:a asked for while holding plugin:b/u) }) },
    ]);
  });
});
