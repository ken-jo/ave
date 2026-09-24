/**
 * The marketplace's work outside a request (design §7.3, §10.2): the boot
 * pass publishes what it did, the update list follows what is installed and
 * skipped, and the periodic tick syncs before it looks.
 */
import { describe, expect, it, vi } from "vitest";
import type { AppliedDefaults } from "../../boot-installs/applied.js";
import type { BootInstallReport } from "../../boot-installs/run.js";
import type { PackageUpdateView } from "../../../shared/git-marketplace.js";
import {
  DEFAULT_SYNC_INTERVAL_MS,
  MIN_SYNC_INTERVAL_MS,
  startMarketplaceBackground,
  syncIntervalMs,
  type BackgroundService,
  type MarketplaceBackgroundInput,
} from "../background.js";

const EMPTY_REPORT: BootInstallReport = { installed: [], updated: [], switched: [], skipped: [], failed: [] };

function update(name: string, to: string): PackageUpdateView {
  return { key: { sourceId: "ave", kind: "plugin", name }, displayName: name, from: "1.0.0", to };
}

function harness(options: {
  service?: Partial<BackgroundService>;
  settings?: ReturnType<MarketplaceBackgroundInput["settings"]>;
} = {}) {
  const calls: string[] = [];
  const service: BackgroundService = {
    refresh: vi.fn(async () => {
      calls.push("refresh");
    }),
    updates: vi.fn(async () => {
      calls.push("updates");
      return [];
    }),
    applyBootInstalls: vi.fn(async () => {
      calls.push("applyBootInstalls");
      return { report: EMPTY_REPORT, notice: null };
    }),
    ...options.service,
  };
  const ticks: Array<() => void> = [];
  const settings = { current: options.settings ?? { updateNotices: true } };
  const input: MarketplaceBackgroundInput = {
    service: async () => service,
    appliedDefaults: async () => ({}) as AppliedDefaults,
    defaults: [{ kind: "plugin", name: "meeting", source: "ave" }],
    settings: () => settings.current,
    publishStatus: vi.fn(),
    publishNotice: vi.fn(),
    publishUpdates: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
    setInterval: vi.fn((run: () => void) => {
      ticks.push(run);
      return {};
    }),
    clearInterval: vi.fn(),
  };
  return { input, service, calls, ticks, settings };
}

describe("syncIntervalMs", () => {
  it("reads unset as 6 hours, 0 as no periodic sync, and raises anything below 15 minutes", () => {
    expect(syncIntervalMs(undefined)).toBe(DEFAULT_SYNC_INTERVAL_MS);
    expect(syncIntervalMs(0)).toBe(0);
    expect(syncIntervalMs(60_000)).toBe(MIN_SYNC_INTERVAL_MS);
    expect(syncIntervalMs(2 * 60 * 60 * 1000)).toBe(2 * 60 * 60 * 1000);
    expect(syncIntervalMs(-5)).toBe(DEFAULT_SYNC_INTERVAL_MS);
    expect(syncIntervalMs(Number.NaN)).toBe(DEFAULT_SYNC_INTERVAL_MS);
  });
});

describe("startMarketplaceBackground", () => {
  it("syncs, applies the boot installs, publishes the notice and status, then the updates", async () => {
    const notice = { forYou: [{ sourceId: "ave", kind: "plugin" as const, name: "meeting" }], required: [], unmanaged: [], lostGrants: [], revoked: [] };
    const report: BootInstallReport = {
      ...EMPTY_REPORT,
      installed: [{ kind: "plugin", name: "meeting", source: "ave" }],
      failed: [{ key: { kind: "plugin", name: "local-indexer", source: "ave" }, message: "release asset missing" }],
    };
    const { input, service, calls } = harness({
      service: {
        applyBootInstalls: vi.fn(async () => {
          calls.push("applyBootInstalls");
          return { report, notice };
        }),
        updates: vi.fn(async () => {
          calls.push("updates");
          return [update("calendar", "2.0.0")];
        }),
      },
    });

    await startMarketplaceBackground(input).started;

    expect(calls).toEqual(["refresh", "applyBootInstalls", "updates"]);
    expect(service.applyBootInstalls).toHaveBeenCalledWith(input.defaults, expect.anything());
    expect(input.publishNotice).toHaveBeenCalledWith(notice);
    expect(vi.mocked(input.publishStatus).mock.calls.map(([status]) => status)).toEqual([
      { phase: "start" },
      { phase: "complete", installed: ["meeting"], failed: [{ id: "local-indexer", error: "release asset missing" }] },
    ]);
    expect(input.publishUpdates).toHaveBeenCalledWith([update("calendar", "2.0.0")]);
  });

  it("reports a boot pass that throws, and still checks for updates", async () => {
    const { input, calls } = harness({
      service: {
        refresh: vi.fn(async () => {
          calls.push("refresh");
          throw new Error("state file unreadable");
        }),
      },
    });

    await startMarketplaceBackground(input).started;

    expect(input.publishStatus).toHaveBeenLastCalledWith({ phase: "error", message: "state file unreadable" });
    expect(input.publishNotice).not.toHaveBeenCalled();
    expect(calls).toEqual(["refresh", "updates"]);
  });

  it("publishes nothing about updates while notices are off", async () => {
    const { input, service } = harness({ settings: { updateNotices: false } });
    await startMarketplaceBackground(input).started;
    expect(service.updates).not.toHaveBeenCalled();
    expect(input.publishUpdates).not.toHaveBeenCalled();
  });

  it("clears a sent list once notices are turned off, without looking up updates", async () => {
    const { input, service, settings } = harness({
      service: { updates: vi.fn(async () => [update("meeting", "0.5.24")]) },
    });
    const background = startMarketplaceBackground(input);
    await background.started;
    settings.current = { updateNotices: false };
    await background.recheck();
    await background.recheck();

    expect(vi.mocked(input.publishUpdates).mock.calls).toEqual([[[update("meeting", "0.5.24")]], [[]]]);
    expect(service.updates).toHaveBeenCalledOnce();
  });

  it("drops skipped versions, sends an unchanged list once, and sends it again when it changes", async () => {
    const lists = [
      [update("meeting", "0.5.24"), update("calendar", "2.0.0")],
      [update("calendar", "2.0.0"), update("meeting", "0.5.24")],
      [update("calendar", "2.0.0")],
    ];
    const { input } = harness({
      service: { updates: vi.fn(async () => lists.shift() ?? []) },
      settings: { updateNotices: true, skippedPluginUpdates: { calendar: "2.0.0" } },
    });
    const background = startMarketplaceBackground(input);
    await background.started;
    await background.recheck();
    await background.recheck();

    expect(vi.mocked(input.publishUpdates).mock.calls).toEqual([[[update("meeting", "0.5.24")]], [[]]]);
  });

  it("keeps the last list when a check fails", async () => {
    const updates = vi.fn()
      .mockResolvedValueOnce([update("meeting", "0.5.24")])
      .mockRejectedValueOnce(new Error("snapshot unreadable"));
    const { input } = harness({ service: { updates } });
    const background = startMarketplaceBackground(input);
    await background.started;
    await background.recheck();

    expect(input.publishUpdates).toHaveBeenCalledOnce();
    expect(input.log.warn).toHaveBeenCalledWith(expect.stringContaining("snapshot unreadable"));
  });

  it("syncs on every tick before it looks, and schedules no tick for an interval of 0", async () => {
    const { input, calls, ticks } = harness({ settings: { updateNotices: true, updateCheckIntervalMs: 60 * 60 * 1000 } });
    const background = startMarketplaceBackground(input);
    await background.started;
    expect(input.setInterval).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
    calls.length = 0;

    ticks[0]!();
    await background.recheck();
    expect(calls).toEqual(["refresh", "updates", "updates"]);

    background.stop();
    expect(input.clearInterval).toHaveBeenCalledOnce();

    const idle = harness({ settings: { updateNotices: true, updateCheckIntervalMs: 0 } });
    await startMarketplaceBackground(idle.input).started;
    expect(idle.input.setInterval).not.toHaveBeenCalled();
  });

  it("runs a check asked for during another after it, so it reads what an install left", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    let installed = false;
    const { input } = harness({
      service: {
        updates: vi.fn(async () => {
          const read = installed;
          order.push(`read:${read ? "after" : "before"}`);
          await gate;
          return read ? [] : [update("meeting", "0.5.24")];
        }),
      },
    });
    const background = startMarketplaceBackground(input);
    await vi.waitFor(() => expect(order).toEqual(["read:before"]));
    installed = true;
    const recheck = background.recheck();
    release();
    await Promise.all([background.started, recheck]);

    expect(order).toEqual(["read:before", "read:after"]);
    expect(vi.mocked(input.publishUpdates).mock.calls).toEqual([[[update("meeting", "0.5.24")]], [[]]]);
  });

  it("joins a boot pass in flight on Retry, and runs a new one after it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { input, service } = harness({
      service: {
        applyBootInstalls: vi.fn(async () => {
          await gate;
          return { report: EMPTY_REPORT, notice: null };
        }),
      },
    });
    const background = startMarketplaceBackground(input);
    const retry = background.retryBootInstalls();
    release();
    await Promise.all([background.started, retry]);
    expect(service.applyBootInstalls).toHaveBeenCalledOnce();

    await background.retryBootInstalls();
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(2);
  });
});
