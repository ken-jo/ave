import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainPluginInstallLockOperations,
  hasPluginInstallInFlight,
  withPluginInstallLock,
  withAllPluginInstallLocks,
} from "../install-lifecycle.js";
import {
  beginAppUpdateInstallRequest,
  clearAppUpdateInstallRequested,
} from "../../main/app-update-install-intent.js";

describe("plugin install locks", () => {
  afterEach(() => {
    clearAppUpdateInstallRequested();
  });

  it("reports contention for only the requested plugin from reservation through release", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const locked = withPluginInstallLock("target", () => pending);
    try {
      expect(hasPluginInstallInFlight()).toBe(true);
      expect(hasPluginInstallInFlight("target")).toBe(true);
      expect(hasPluginInstallInFlight("unrelated")).toBe(false);
    } finally {
      release();
      await locked;
    }
    expect(hasPluginInstallInFlight("target")).toBe(false);
  });

  it("does not enter a plugin install lock callback after app update install starts", async () => {
    const install = vi.fn(async () => undefined);
    beginAppUpdateInstallRequest();

    await expect(withPluginInstallLock("p", install)).rejects.toMatchObject({
      code: "app-update-install-in-progress",
      message: expect.stringContaining("Plugin changes are paused while an app update is installing"),
    });

    expect(install).not.toHaveBeenCalled();
  });

  it("allows a same-plugin lifecycle hook to re-enter its owned lock", async () => {
    const order: string[] = [];
    await expect(withPluginInstallLock("p", async () => {
      order.push("outer:start");
      await withPluginInstallLock("p", async () => {
        order.push("inner");
      });
      order.push("outer:end");
    })).resolves.toBeUndefined();
    expect(order).toEqual(["outer:start", "inner", "outer:end"]);
  });

  it("keeps the owner lock held until a detached re-entrant mutation settles", async () => {
    const order: string[] = [];
    let releaseInner!: () => void;
    let innerEntered!: () => void;
    const innerGate = new Promise<void>((resolve) => { releaseInner = resolve; });
    const innerStarted = new Promise<void>((resolve) => { innerEntered = resolve; });
    let ownerSettled = false;

    const owner = withPluginInstallLock("p", async () => {
      order.push("owner:start");
      void withPluginInstallLock("p", async () => {
        order.push("inner:start");
        innerEntered();
        await innerGate;
        order.push("inner:end");
      });
      await innerStarted;
      order.push("owner:callback-end");
    }).then(() => { ownerSettled = true; });

    await innerStarted;
    await Promise.resolve();
    expect(ownerSettled).toBe(false);
    expect(order).toEqual(["owner:start", "inner:start", "owner:callback-end"]);

    releaseInner();
    await owner;
    expect(order).toEqual(["owner:start", "inner:start", "owner:callback-end", "inner:end"]);
  });

  it("does not self-deadlock when a re-entrant uninstall drains its own descendants", async () => {
    const order: string[] = [];
    await expect(withPluginInstallLock("p", async () => {
      await withPluginInstallLock("p", async () => {
        order.push("inner:start");
        await drainPluginInstallLockOperations("p");
        order.push("inner:end");
      });
      order.push("outer:end");
    })).resolves.toBeUndefined();
    expect(order).toEqual(["inner:start", "inner:end", "outer:end"]);
  });

  it("does not let an inactive inherited all-plugin token shadow a new plugin lock", async () => {
    const order: string[] = [];
    let inherited!: () => Promise<void>;
    await withAllPluginInstallLocks(async () => {
      inherited = async () => {
        await withPluginInstallLock("p", async () => {
          order.push("plugin");
          await withPluginInstallLock("p", async () => {
            order.push("nested");
          });
        });
      };
    });

    await expect(inherited()).resolves.toBeUndefined();
    expect(order).toEqual(["plugin", "nested"]);
  });

  it("reports detached re-entrant failures to the owning mutation", async () => {
    const detachedFailure = new Error("detached write failed");
    const error = await withPluginInstallLock("p", async () => {
      void withPluginInstallLock("p", async () => {
        throw detachedFailure;
      });
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([detachedFailure]);
  });

  it("preserves the primary owner failure before detached mutation failures", async () => {
    const ownerFailure = new Error("owner failed");
    const detachedFailure = new Error("detached failed");
    const error = await withPluginInstallLock("p", async () => {
      void withPluginInstallLock("p", async () => {
        throw detachedFailure;
      });
      throw ownerFailure;
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([ownerFailure, detachedFailure]);
  });

  it("rejects a per-plugin to all-plugin lock upgrade instead of deadlocking", async () => {
    await expect(withPluginInstallLock("p", async () => {
      await withAllPluginInstallLocks(async () => undefined);
    })).rejects.toThrow("Cannot upgrade a held per-plugin lifecycle lock");
  });

  it("bounds the owner wait while quarantining a detached mutation until it settles", async () => {
    vi.useFakeTimers();
    try {
      let releaseDetached!: () => void;
      let detachedStarted!: () => void;
      let detachedOperation!: Promise<void>;
      const detachedGate = new Promise<void>((resolve) => { releaseDetached = resolve; });
      const started = new Promise<void>((resolve) => { detachedStarted = resolve; });
      const owner = withPluginInstallLock("p", async () => {
        detachedOperation = withPluginInstallLock("p", async () => {
          detachedStarted();
          await detachedGate;
        });
        void detachedOperation;
        await started;
      });
      const ownerResult = owner.catch((caught) => caught);
      await started;

      let queuedPluginEntered = false;
      const queuedPlugin = withPluginInstallLock("p", async () => {
        queuedPluginEntered = true;
      });
      const queuedPluginResult = queuedPlugin.catch((caught) => caught);
      let queuedAllEntered = false;
      const queuedAll = withAllPluginInstallLocks(async () => {
        queuedAllEntered = true;
      });
      const queuedAllResult = queuedAll.catch((caught) => caught);

      await vi.advanceTimersByTimeAsync(10_001);
      await expect(ownerResult).resolves.toMatchObject({
        code: "plugin-lifecycle-drain-timeout",
      });
      await expect(queuedPluginResult).resolves.toMatchObject({
        code: "plugin-lifecycle-quarantined",
      });
      await expect(queuedAllResult).resolves.toMatchObject({
        code: "plugin-lifecycle-quarantined",
      });
      expect(queuedPluginEntered).toBe(false);
      expect(queuedAllEntered).toBe(false);

      let nextEntered = false;
      const next = withPluginInstallLock("p", async () => {
        nextEntered = true;
      });
      await expect(next).rejects.toMatchObject({
        code: "plugin-lifecycle-quarantined",
      });
      expect(nextEntered).toBe(false);

      releaseDetached();
      await detachedOperation;
      for (let attempt = 0; attempt < 20 && hasPluginInstallInFlight(); attempt += 1) {
        await Promise.resolve();
      }
      expect(hasPluginInstallInFlight()).toBe(false);
      await expect(withPluginInstallLock("p", async () => {
        nextEntered = true;
      })).resolves.toBeUndefined();
      expect(nextEntered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives multi-plugin bootstrap exclusive access across per-plugin mutations", async () => {
    const order: string[] = [];
    let releasePlugin!: () => void;
    let pluginEntered!: () => void;
    const pluginGate = new Promise<void>((resolve) => { releasePlugin = resolve; });
    const pluginStarted = new Promise<void>((resolve) => { pluginEntered = resolve; });
    const pluginMutation = withPluginInstallLock("p", async () => {
      order.push("plugin:start");
      pluginEntered();
      await pluginGate;
      order.push("plugin:end");
    });
    await pluginStarted;

    let releaseAll!: () => void;
    let allEntered!: () => void;
    const allGate = new Promise<void>((resolve) => { releaseAll = resolve; });
    const allStarted = new Promise<void>((resolve) => { allEntered = resolve; });
    const allMutation = withAllPluginInstallLocks(async () => {
      order.push("all:start");
      allEntered();
      await allGate;
      order.push("all:end");
    });
    await Promise.resolve();
    expect(order).toEqual(["plugin:start"]);

    releasePlugin();
    await pluginMutation;
    await allStarted;
    const otherMutation = withPluginInstallLock("other", async () => {
      order.push("other");
    });
    await Promise.resolve();
    expect(order).toEqual(["plugin:start", "plugin:end", "all:start"]);

    releaseAll();
    await allMutation;
    await otherMutation;
    expect(order).toEqual(["plugin:start", "plugin:end", "all:start", "all:end", "other"]);
  });

});
