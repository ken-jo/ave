/**
 * The marketplace's work outside a request (design §7.3, §10.2, §10.4,
 * §18.7.1): the boot pass enforces the revocations on disk and publishes what
 * it did; the one scheduler runs discovery and the apply check by their due
 * rules, on fake time, and publishes the update list and the status.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppliedDefaults } from "../../boot-installs/applied.js";
import type { BootInstallReport } from "../../boot-installs/run.js";
import { UPDATE_PACKAGE_STATES, type PackageUpdateOffer, type PackageUpdateView, type UpdateStatusView } from "../../../shared/git-marketplace.js";
import { MarketplaceError } from "../../errors.js";
import type { ApplyOutcome } from "../../updates/apply.js";
import { emptyUpdateHistory, updateHistoryStore, type SyncDiscovery, type UpdateHistory, type UpdateHistoryStore } from "../../updates/history.js";
import type { UpdateCandidate } from "../service.js";
import {
  DEFAULT_SYNC_INTERVAL_MS,
  MIN_SYNC_INTERVAL_MS,
  startMarketplaceBackground,
  syncIntervalMs,
  type BackgroundService,
  type MarketplaceBackgroundInput,
} from "../background.js";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const EMPTY_REPORT: BootInstallReport = { installed: [], skipped: [], failed: [] };
const OK: SyncDiscovery = { result: "ok", reached: ["ave", "acme"] };
const OFFLINE: SyncDiscovery = { result: "offline", reached: [] };

function offer(name: string, to: string, sourceId = "ave"): PackageUpdateOffer {
  return { key: { sourceId, kind: "plugin", name }, displayName: name, from: "1.0.0", to };
}

/** The harness turns automatic updates off (`autoUpdate: false`), so every update waits for the user. */
function manual(name: string, to: string, sourceId = "ave"): PackageUpdateView {
  return { ...offer(name, to, sourceId), state: "manual", reasons: ["switched-off"], autoUpdate: { effective: false, override: null, lockedByPolicy: false } };
}

/** An offer as the service's candidate: an upgrade from an official source with nothing to review. */
function candidateOf(update: PackageUpdateOffer, facts: Partial<UpdateCandidate["facts"]> = {}): UpdateCandidate {
  return {
    ...update,
    commitRange: { from: "a".repeat(40), to: "b".repeat(40) },
    switchSource: false,
    provides: [],
    needs: [],
    facts: {
      switchKey: update.key.name,
      to: update.to,
      change: "upgrade",
      enabled: true,
      required: false,
      policyBlocked: false,
      source: { id: update.key.sourceId, origin: "official", http: false, acknowledgedUnencryptedUpdates: false, shown: true, pendingRewrite: false },
      consent: [],
      unconfirmedApprovals: [],
      ...facts,
    },
  };
}

function memoryHistory(initial: UpdateHistory | null = null): UpdateHistoryStore & { saved: UpdateHistory | null } {
  const store = {
    saved: initial,
    load: async () => ({ history: store.saved ? structuredClone(store.saved) : emptyUpdateHistory(), reset: false as const }),
    save: async (history: UpdateHistory) => {
      store.saved = structuredClone(history);
    },
  };
  return store;
}

function harness(options: {
  service?: Partial<BackgroundService>;
  settings?: ReturnType<MarketplaceBackgroundInput["settings"]>;
  history?: UpdateHistoryStore;
  /** What each discovery reports, in order; then `ok`. */
  discoveries?: SyncDiscovery[];
} = {}) {
  const calls: string[] = [];
  const discoveries = [...(options.discoveries ?? [])];
  /** What the sources publish: a discovery's `updates()` reads it, and `facts` classify each by name. */
  const published = { offers: [] as PackageUpdateOffer[], facts: {} as Record<string, Partial<UpdateCandidate["facts"]>> };
  const service: BackgroundService = {
    enforceRevocations: vi.fn(async () => {
      calls.push("enforceRevocations");
    }),
    takeRevocationNotice: vi.fn(() => null),
    discover: vi.fn(async () => {
      calls.push("discover");
      return discoveries.shift() ?? OK;
    }),
    updates: vi.fn(async () => {
      calls.push("updates");
      return [...published.offers];
    }),
    applyBootInstalls: vi.fn(async () => {
      calls.push("applyBootInstalls");
      return { report: EMPTY_REPORT, notice: null };
    }),
    updateCandidates: vi.fn(async (reached: ReadonlySet<string>) =>
      published.offers.filter((update) => reached.has(update.key.sourceId)).map((update) => candidateOf(update, published.facts[update.key.name]))),
    autoUpdateContext: vi.fn(async () => ({ policy: "user" as const, sources: [] })),
    applyUpdate: vi.fn(async () => ({ state: "applied" as const })),
    appliedState: vi.fn(async () => ({ state: "applied" as const })),
    callsInFlight: vi.fn(async () => false),
    approveComponents: vi.fn(async () => undefined),
    ...options.service,
  };
  const settings = { current: options.settings ?? { updateNotices: true } };
  const activity = { busy: false, idle: new Set<() => void>() };
  const resume = new Set<() => void>();
  const history = options.history ?? memoryHistory();
  const input: MarketplaceBackgroundInput = {
    service: async () => service,
    appliedDefaults: async () => ({}) as AppliedDefaults,
    defaults: [{ kind: "plugin", name: "meeting", source: "ave" }],
    // Automatic updates are off unless a test turns them on: the update list then waits for the user.
    settings: () => ({ autoUpdate: false, ...settings.current }),
    activity: {
      isBusy: () => activity.busy,
      onIdle: (listener: () => void) => {
        activity.idle.add(listener);
        return () => activity.idle.delete(listener);
      },
    },
    history,
    publishStatus: vi.fn(),
    publishNotice: vi.fn(),
    publishUpdates: vi.fn(),
    publishUpdateStatus: vi.fn(),
    onResume: vi.fn((listener: () => void) => {
      resume.add(listener);
      return () => resume.delete(listener);
    }),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const discoverCount = () => calls.filter((call) => call === "discover").length;
  const lastStatus = (): UpdateStatusView => vi.mocked(input.publishUpdateStatus).mock.calls.at(-1)![0];
  /** End the conversation's busy spell: the idle listeners hear it. */
  const goIdle = () => {
    activity.busy = false;
    for (const listener of [...activity.idle]) listener();
  };
  return { input, service, calls, settings, history, published, resume, discoverCount, lastStatus, discoveries, activity, goIdle };
}

/** Let every pending promise chain run; the fake clock does not move. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** Move the fake clock to `T0 + hours`, firing the timers due on the way. */
async function at(hours: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(T0 + hours * HOUR - Date.now());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncIntervalMs", () => {
  it("reads unset as 6 hours, 0 as no scheduled discovery, and raises anything below 15 minutes", () => {
    expect(syncIntervalMs(undefined)).toBe(DEFAULT_SYNC_INTERVAL_MS);
    expect(syncIntervalMs(0)).toBe(0);
    expect(syncIntervalMs(60_000)).toBe(MIN_SYNC_INTERVAL_MS);
    expect(syncIntervalMs(2 * HOUR)).toBe(2 * HOUR);
    expect(syncIntervalMs(-5)).toBe(DEFAULT_SYNC_INTERVAL_MS);
    expect(syncIntervalMs(Number.NaN)).toBe(DEFAULT_SYNC_INTERVAL_MS);
  });
});

describe("the boot pass", () => {
  it("enforces the revocations on disk, discovers, applies the boot installs, publishes the notice and status, then the updates", async () => {
    const notice = { forYou: [{ sourceId: "ave", kind: "plugin" as const, name: "meeting" }], required: [], unmanaged: [], lostGrants: [], revoked: [], autoUpdated: [] };
    const report: BootInstallReport = {
      ...EMPTY_REPORT,
      installed: [{ kind: "plugin", name: "meeting", source: "ave" }],
      failed: [{ key: { kind: "plugin", name: "local-indexer", source: "ave" }, message: "release asset missing" }],
    };
    const h = harness({
      service: {
        applyBootInstalls: vi.fn(async () => {
          h.calls.push("applyBootInstalls");
          return { report, notice };
        }),
      },
    });
    h.published.offers = [offer("calendar", "2.0.0")];

    await startMarketplaceBackground(h.input).started;

    expect(h.calls).toEqual(["enforceRevocations", "discover", "updates", "applyBootInstalls", "updates"]);
    // With the scheduler's shutdown signal, which the service's own stages stop on.
    expect(h.service.applyBootInstalls).toHaveBeenCalledWith(h.input.defaults, expect.anything(), expect.any(AbortSignal));
    expect(h.service.discover).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(h.service.enforceRevocations).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(h.input.publishNotice).toHaveBeenCalledWith(notice);
    expect(vi.mocked(h.input.publishStatus).mock.calls.map(([status]) => status)).toEqual([
      { phase: "start" },
      { phase: "complete", installed: ["meeting"], failed: [{ id: "local-indexer", error: "release asset missing" }] },
    ]);
    expect(h.input.publishUpdates).toHaveBeenCalledWith([manual("calendar", "2.0.0")]);
  });

  it("reports a discovery that throws as the boot pass failing, skips the boot installs, and records the attempt", async () => {
    const h = harness({
      service: {
        discover: vi.fn(async () => {
          h.calls.push("discover");
          throw new Error("state file unreadable");
        }),
      },
    });

    await startMarketplaceBackground(h.input).started;

    expect(h.input.publishStatus).toHaveBeenLastCalledWith({ phase: "error", message: "state file unreadable" });
    expect(h.service.applyBootInstalls).not.toHaveBeenCalled();
    expect(h.lastStatus().discovery).toMatchObject({ result: "error", lastAttemptAt: new Date(T0).toISOString(), lastSuccessAt: null });
  });

  it("publishes what enforcement removed as a notice of its own", async () => {
    const revoked = {
      forYou: [],
      required: [],
      unmanaged: [],
      lostGrants: [],
      revoked: [{ key: { sourceId: "acme", kind: "mcp" as const, name: "notes" }, version: "2.0.0", reason: "exfiltrates notes", outcome: "uninstalled" as const }],
      autoUpdated: [],
    };
    const notices = [null, null, revoked];
    const h = harness({
      service: { takeRevocationNotice: vi.fn(() => notices.shift() ?? null) },
      settings: { updateNotices: false },
    });
    const background = startMarketplaceBackground(h.input);
    await background.started;
    expect(h.input.publishNotice).not.toHaveBeenCalled();

    await background.recheck();
    // Published with notices off too: a removal is not an update offer.
    expect(vi.mocked(h.input.publishNotice).mock.calls).toEqual([[revoked]]);
    background.stop();
  });

  it("joins a boot pass in flight on Retry, and runs a new one after it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      service: {
        applyBootInstalls: vi.fn(async () => {
          await gate;
          return { report: EMPTY_REPORT, notice: null };
        }),
      },
    });
    const background = startMarketplaceBackground(h.input);
    await settle();
    expect(h.service.applyBootInstalls).toHaveBeenCalledOnce();
    const retry = background.retryBootInstalls();
    release();
    await Promise.all([background.started, retry]);
    expect(h.service.applyBootInstalls).toHaveBeenCalledOnce();

    await background.retryBootInstalls();
    expect(h.service.applyBootInstalls).toHaveBeenCalledTimes(2);
    background.stop();
  });
});

describe("the update list", () => {
  it("publishes nothing waiting only for the user while notices are off, and still keeps the status", async () => {
    const h = harness({ settings: { updateNotices: false } });
    h.published.offers = [offer("meeting", "0.5.24")];
    const background = startMarketplaceBackground(h.input);
    await background.started;
    expect(h.input.publishUpdates).not.toHaveBeenCalled();
    expect(h.lastStatus().packages).toEqual([manual("meeting", "0.5.24")]);
    background.stop();
  });

  it("clears a sent list once notices are turned off", async () => {
    const h = harness();
    h.published.offers = [offer("meeting", "0.5.24")];
    const background = startMarketplaceBackground(h.input);
    await background.started;
    h.settings.current = { updateNotices: false };
    await background.settingsChanged();
    await background.settingsChanged();

    expect(vi.mocked(h.input.publishUpdates).mock.calls).toEqual([[[manual("meeting", "0.5.24")]], [[]]]);
    background.stop();
  });

  it("drops skipped versions, sends an unchanged list once, and sends it again when it changes", async () => {
    const h = harness({ settings: { updateNotices: true, skippedPluginUpdates: { calendar: "2.0.0" } } });
    h.published.offers = [offer("meeting", "0.5.24"), offer("calendar", "2.0.0")];
    const background = startMarketplaceBackground(h.input);
    await background.started;
    h.published.offers = [offer("calendar", "2.0.0"), offer("meeting", "0.5.24")];
    await background.recheck();
    h.published.offers = [offer("calendar", "2.0.0")];
    await background.recheck();

    expect(vi.mocked(h.input.publishUpdates).mock.calls).toEqual([[[manual("meeting", "0.5.24")]], [[]]]);
    expect(h.lastStatus().packages).toEqual([]);
    background.stop();
  });

  it("keeps the last list when a recheck fails", async () => {
    const h = harness();
    h.published.offers = [offer("meeting", "0.5.24")];
    const background = startMarketplaceBackground(h.input);
    await background.started;
    vi.mocked(h.service.updates).mockRejectedValueOnce(new Error("snapshot unreadable"));
    await background.recheck();

    expect(h.input.publishUpdates).toHaveBeenCalledOnce();
    expect(h.input.log.warn).toHaveBeenCalledWith(expect.stringContaining("snapshot unreadable"));
    background.stop();
  });

  it("computes a list asked for during another after it, so it reads what an install left", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    let installed = false;
    let listed: PackageUpdateOffer[] = [];
    const h = harness({
      service: {
        updates: vi.fn(async () => {
          const read = installed;
          order.push(`read:${read ? "after" : "before"}`);
          await gate;
          listed = read ? [] : [offer("meeting", "0.5.24")];
          return listed;
        }),
        // Classified from the same read.
        updateCandidates: vi.fn(async () => listed.map((update) => candidateOf(update))),
      },
    });
    const background = startMarketplaceBackground(h.input);
    await settle();
    expect(order).toEqual(["read:before"]);
    installed = true;
    const recheck = background.recheck();
    release();
    await Promise.all([background.started, recheck]);

    expect(order.slice(0, 2)).toEqual(["read:before", "read:after"]);
    expect(vi.mocked(h.input.publishUpdates).mock.calls).toEqual([[[manual("meeting", "0.5.24")]], [[]]]);
    background.stop();
  });

  it("publishes only the sources a discovery reached; an unreached one keeps only what an earlier discovery showed, marked stale", async () => {
    const AVE_ONLY: SyncDiscovery = { result: "partial", reached: ["ave"] };
    const h = harness({ discoveries: [AVE_ONLY] });
    // acme's offer comes from its cached snapshot: the boot discovery did not reach it.
    h.published.offers = [offer("meeting", "2.0.0", "ave"), offer("notes", "3.0.0", "acme")];
    const background = startMarketplaceBackground(h.input);
    await background.started;
    const updatesSent = () => vi.mocked(h.input.publishUpdates).mock.calls.at(-1)![0];
    expect(h.lastStatus().packages).toEqual([manual("meeting", "2.0.0", "ave")]);
    expect(updatesSent()).toEqual([manual("meeting", "2.0.0", "ave")]);
    // A recheck between discoveries does not classify the unreached source either.
    await background.recheck();
    expect(h.lastStatus().packages).toEqual([manual("meeting", "2.0.0", "ave")]);

    await background.checkNow();
    expect(h.lastStatus().packages).toEqual([manual("meeting", "2.0.0", "ave"), manual("notes", "3.0.0", "acme")]);
    expect(updatesSent()).toEqual([manual("meeting", "2.0.0", "ave"), manual("notes", "3.0.0", "acme")]);

    h.discoveries.push(AVE_ONLY);
    await background.checkNow();
    const stale = { ...manual("notes", "3.0.0", "acme"), stale: true };
    expect(h.lastStatus().packages).toEqual([manual("meeting", "2.0.0", "ave"), stale]);
    expect(updatesSent()).toEqual([manual("meeting", "2.0.0", "ave"), stale]);

    // Not the version shown before: nothing is shown for it until a discovery reaches acme.
    h.published.offers = [offer("meeting", "2.0.0", "ave"), offer("notes", "4.0.0", "acme")];
    await background.recheck();
    expect(h.lastStatus().packages).toEqual([manual("meeting", "2.0.0", "ave")]);
    background.stop();
  });

  it("after a discovery that throws, shows what it showed before only as stale, and classifies no newly cached version", async () => {
    const h = harness();
    h.published.offers = [offer("meeting", "2.0.0")];
    const background = startMarketplaceBackground(h.input);
    await background.started;
    const updatesSent = () => vi.mocked(h.input.publishUpdates).mock.calls.at(-1)![0];
    expect(updatesSent()).toEqual([manual("meeting", "2.0.0")]);

    vi.mocked(h.service.discover).mockRejectedValueOnce(new Error("registry unreadable"));
    const status = await background.checkNow();
    const stale = { ...manual("meeting", "2.0.0"), stale: true };
    expect(status.discovery.result).toBe("error");
    expect(status.packages).toEqual([stale]);
    expect(h.lastStatus().packages).toEqual([stale]);
    expect(updatesSent()).toEqual([stale]);

    // A version cached since is not classified with the reach of an earlier discovery.
    h.published.offers = [offer("meeting", "3.0.0")];
    await background.recheck();
    expect((await background.status()).packages).toEqual([]);
    expect(updatesSent()).toEqual([]);
    background.stop();
  });
});

describe("the due rules (design §18.7.1)", () => {
  it("retries an offline discovery at the next hourly due check, not an interval later", async () => {
    // The boot's apply check succeeds, so only discovery's own rule can retry the one at 6 hours.
    const h = harness({ discoveries: [OK, OFFLINE] });
    const background = startMarketplaceBackground(h.input);
    await background.started;
    await at(6);
    expect(h.discoverCount()).toBe(2);
    expect(h.lastStatus().discovery.result).toBe("offline");

    await at(6.99);
    expect(h.discoverCount()).toBe(2);
    await at(7);
    expect(h.discoverCount()).toBe(3);
    expect(h.lastStatus().discovery.result).toBe("ok");
    background.stop();
  });

  it("retries an offline Check now an hour later although the last success is recent", async () => {
    const h = harness({ discoveries: [OK, OFFLINE] });
    const background = startMarketplaceBackground(h.input);
    await background.started;
    await at(1);
    expect(h.discoverCount()).toBe(1);

    const checked = await background.checkNow();
    expect(checked.discovery).toMatchObject({ result: "offline", lastSuccessAt: new Date(T0).toISOString(), lastAttemptAt: new Date(T0 + HOUR).toISOString() });
    expect(h.discoverCount()).toBe(2);

    await at(2);
    expect(h.discoverCount()).toBe(3);
    background.stop();
  });

  it("does not repeat a successful discovery for 6 hours with the default interval", async () => {
    const h = harness();
    const background = startMarketplaceBackground(h.input);
    await background.started;

    await at(5.99);
    expect(h.discoverCount()).toBe(1);
    await at(6);
    expect(h.discoverCount()).toBe(2);
    expect(h.lastStatus().discovery.nextAt).toBe(new Date(T0 + 12 * HOUR).toISOString());
    background.stop();
  });

  it("runs the apply check at boot and again 24 hours after the last one", async () => {
    const h = harness();
    const history = h.history as ReturnType<typeof memoryHistory>;
    const background = startMarketplaceBackground(h.input);
    await background.started;
    expect(history.saved?.applyCheckAt).toBe(new Date(T0).toISOString());

    await at(23.99);
    expect(history.saved?.applyCheckAt).toBe(new Date(T0).toISOString());
    await at(24);
    expect(history.saved?.applyCheckAt).toBe(new Date(T0 + 24 * HOUR).toISOString());
    background.stop();
  });

  it("at the exact 24-hour boundary, discovers before it classifies, whatever the discovery interval", async () => {
    const h = harness({ settings: { updateNotices: true, updateCheckIntervalMs: 48 * HOUR } });
    const history = h.history as ReturnType<typeof memoryHistory>;
    const background = startMarketplaceBackground(h.input);
    await background.started;
    expect(h.discoverCount()).toBe(1);
    expect(history.saved?.packages).toEqual({});

    // Published a minute after the boot's discovery read the source.
    await at(1 / 60);
    h.published.offers = [offer("meeting", "2.0.0")];

    await at(24);
    expect(h.discoverCount()).toBe(2);
    expect(history.saved?.packages).toEqual({ "ave:plugin:meeting": { to: "2.0.0", state: "manual", attempts: 0, from: "1.0.0", displayName: "meeting" } });
    expect(history.saved?.applyCheckAt).toBe(new Date(T0 + 24 * HOUR).toISOString());
    background.stop();
  });

  it("phases the apply check apart from discovery: a due apply check starts its own discovery although one succeeded 3 hours earlier", async () => {
    // The spec's fixture: discoveries at 0, 12, 18 and 24, the last apply
    // check at 3. Live, the apply check at 3 (Check now) runs a discovery at
    // 3, and the interval follows it to 9; offline there and at the hourly
    // retries 10 and 11, it succeeds at 12, which puts the interval back on
    // 12, 18, 24.
    const h = harness({ discoveries: [OK, OK, OFFLINE, OFFLINE, OFFLINE] });
    const history = h.history as ReturnType<typeof memoryHistory>;
    const background = startMarketplaceBackground(h.input);
    await background.started;
    await at(3);
    await background.checkNow();
    await at(12);
    expect(history.saved?.discovery?.lastSuccessAt).toBe(new Date(T0 + 12 * HOUR).toISOString());
    expect(history.saved?.applyCheckAt).toBe(new Date(T0 + 3 * HOUR).toISOString());
    await at(24);
    expect(h.discoverCount()).toBe(8);
    expect(history.saved?.discovery?.lastSuccessAt).toBe(new Date(T0 + 24 * HOUR).toISOString());

    await at(25);
    h.published.offers = [offer("meeting", "2.0.0")];
    await at(26.99);
    expect(h.discoverCount()).toBe(8);
    await at(27);
    expect(h.discoverCount()).toBe(9);
    expect(history.saved?.applyCheckAt).toBe(new Date(T0 + 27 * HOUR).toISOString());
    expect(history.saved?.packages["ave:plugin:meeting"]).toEqual({ to: "2.0.0", state: "manual", attempts: 0, from: "1.0.0", displayName: "meeting" });
    background.stop();
  });

  it("joins a discovery in flight when the apply check falls due, and after a partial one classifies only the reached sources", async () => {
    const h = harness({ settings: { updateNotices: true, updateCheckIntervalMs: 23 * HOUR } });
    const history = h.history as ReturnType<typeof memoryHistory>;
    const background = startMarketplaceBackground(h.input);
    await background.started;

    // The discovery due at 23 hours is slow; the apply check falls due at 24 while it runs.
    let release: () => void = () => {};
    vi.mocked(h.service.discover).mockImplementationOnce(async () => {
      h.calls.push("discover");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { result: "partial", reached: ["ave"] };
    });
    h.published.offers = [offer("meeting", "2.0.0", "ave"), offer("notes", "3.0.0", "acme")];
    await at(23);
    expect(h.discoverCount()).toBe(2);
    expect(h.lastStatus().running).toBe(true);
    await at(24);
    expect(h.discoverCount()).toBe(2);

    release();
    await settle();
    expect(h.lastStatus().running).toBe(false);
    expect(h.discoverCount()).toBe(2);
    expect(history.saved?.packages).toEqual({ "ave:plugin:meeting": { to: "2.0.0", state: "manual", attempts: 0, from: "1.0.0", displayName: "meeting" } });
    expect(history.saved?.applyCheckAt).toBe(new Date(T0).toISOString());
    expect(history.saved?.discovery?.result).toBe("partial");

    // Still due, it joins the hourly retry of the failed discovery.
    await at(24.99);
    expect(h.discoverCount()).toBe(2);
    await at(25);
    expect(h.discoverCount()).toBe(3);
    expect(history.saved?.applyCheckAt).toBe(new Date(T0 + 25 * HOUR).toISOString());
    expect(history.saved?.packages).toEqual({
      "ave:plugin:meeting": { to: "2.0.0", state: "manual", attempts: 0, from: "1.0.0", displayName: "meeting" },
      "acme:plugin:notes": { to: "3.0.0", state: "manual", attempts: 0, from: "1.0.0", displayName: "notes" },
    });
    background.stop();
  });

  it("runs a discovery on resume after the clock jumps 30 hours, with no timer firing", async () => {
    const h = harness();
    const background = startMarketplaceBackground(h.input);
    await background.started;
    expect(h.discoverCount()).toBe(1);

    vi.setSystemTime(T0 + 30 * HOUR);
    h.resume.forEach((listener) => listener());
    await settle();
    expect(h.discoverCount()).toBe(2);
    background.stop();
  });

  it("publishes an offline discovery as offline", async () => {
    const h = harness({ discoveries: [OFFLINE] });
    const background = startMarketplaceBackground(h.input);
    await background.started;
    expect(h.lastStatus().discovery).toMatchObject({ result: "offline", lastSuccessAt: null, nextAt: new Date(T0 + HOUR).toISOString() });
    background.stop();
  });

  it("answers Check now when its discovery and apply check end", async () => {
    const h = harness();
    const background = startMarketplaceBackground(h.input);
    await background.started;
    await at(2);

    let release: () => void = () => {};
    vi.mocked(h.service.discover).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return OK;
    });
    h.published.offers = [offer("meeting", "2.0.0")];
    let answered: UpdateStatusView | null = null;
    const check = background.checkNow().then((status) => {
      answered = status;
    });
    await settle();
    expect(h.lastStatus().running).toBe(true);
    expect(answered).toBeNull();

    release();
    await check;
    expect(answered).toMatchObject({
      running: false,
      applyCheckAt: new Date(T0 + 2 * HOUR).toISOString(),
      discovery: { result: "ok", lastSuccessAt: new Date(T0 + 2 * HOUR).toISOString() },
      packages: [manual("meeting", "2.0.0")],
    });
    background.stop();
  });

  it("keeps discovery at boot and Check now only for an interval of 0, still retrying a failure hourly and checking daily", async () => {
    const h = harness({ settings: { updateNotices: true, updateCheckIntervalMs: 0 }, discoveries: [OK, OFFLINE] });
    const background = startMarketplaceBackground(h.input);
    await background.started;
    await at(23.99);
    expect(h.discoverCount()).toBe(1);
    await at(24);
    expect(h.discoverCount()).toBe(2);
    await at(25);
    expect(h.discoverCount()).toBe(3);
    await at(48);
    expect(h.discoverCount()).toBe(3);
    await at(49);
    expect(h.discoverCount()).toBe(4);
    background.stop();
  });

  it("runs every service call in the context the scheduler started in, whoever asks and from wherever (§18.6)", async () => {
    // Stands in for the service's operation context: a check asked for from inside an operation (a
    // published snapshot, an install), on resume or by the timer must not join that operation.
    const caller = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const h = harness();
    const calls = ["enforceRevocations", "takeRevocationNotice", "discover", "updates", "applyBootInstalls"] as const;
    for (const name of calls) {
      const original = h.service[name] as (...args: unknown[]) => unknown;
      (h.service as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        seen.push(caller.getStore());
        return original(...args);
      };
    }
    const background = caller.run("boot", () => startMarketplaceBackground(h.input));
    await background.started;
    const phases: Array<[string, () => Promise<unknown>]> = [
      ["recheck", () => background.recheck()],
      ["retryBootInstalls", () => background.retryBootInstalls()],
      ["settingsChanged", () => background.settingsChanged()],
      ["checkNow", () => background.checkNow()],
      [
        "resume",
        async () => {
          vi.setSystemTime(T0 + 30 * HOUR);
          h.resume.forEach((listener) => listener());
          await settle();
        },
      ],
      // The apply check falls due 24 hours after the resume's; only the timer starts it.
      ["timer", () => at(55)],
    ];
    for (const [phase, run] of phases) {
      seen.length = 0;
      await caller.run("operation", run);
      expect({ phase, called: seen.length > 0 }).toEqual({ phase, called: true });
      expect({ phase, contexts: [...new Set(seen)] }).toEqual({ phase, contexts: ["boot"] });
    }
    background.stop();
  });

  it("starts nothing once stopped: no timer, no resume", async () => {
    const h = harness();
    const background = startMarketplaceBackground(h.input);
    await background.started;
    background.stop();
    expect(h.resume.size).toBe(0);

    await at(72);
    expect(h.discoverCount()).toBe(1);
    await expect(background.checkNow()).rejects.toThrow("stopped");
  });

  it("starts no boot work when stopped before the history has loaded, and refuses Retry after", async () => {
    const h = harness();
    const background = startMarketplaceBackground(h.input);
    background.stop();
    await background.started;
    await at(72);

    expect(h.calls).toEqual([]);
    expect(h.input.publishStatus).not.toHaveBeenCalled();
    await expect(background.retryBootInstalls()).rejects.toThrow("stopped");
    await background.settingsChanged();
    await background.recheck();
    expect(h.calls).toEqual([]);
  });

  it("writes nothing when stopped while a Check now computes its offers", async () => {
    const h = harness();
    const history = h.history as ReturnType<typeof memoryHistory>;
    const background = startMarketplaceBackground(h.input);
    await background.started;
    const saved = structuredClone(history.saved);
    await at(2);
    let release: () => void = () => {};
    vi.mocked(h.service.updates).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [offer("meeting", "2.0.0")];
    });
    const check = background.checkNow();
    await settle();
    background.stop();
    release();
    await check;
    expect(history.saved).toEqual(saved);
  });

  it("records no failed attempt for a discovery that rejects after a stop", async () => {
    const h = harness();
    const history = h.history as ReturnType<typeof memoryHistory>;
    const background = startMarketplaceBackground(h.input);
    await background.started;
    const saved = structuredClone(history.saved);
    await at(2);
    let reject: (error: Error) => void = () => {};
    vi.mocked(h.service.discover).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const check = background.checkNow();
    await settle();
    background.stop();
    reject(new Error("shutdown closed the source"));
    await check;
    expect(history.saved).toEqual(saved);
    expect(h.input.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("shutdown closed the source"));
  });

  it("times a successful apply check at its end, so one that spans a sleep is not due again at once", async () => {
    let release: () => void = () => {};
    const h = harness();
    vi.mocked(h.service.discover).mockImplementationOnce(async () => {
      h.calls.push("discover");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return OK;
    });
    const history = h.history as ReturnType<typeof memoryHistory>;
    const background = startMarketplaceBackground(h.input);
    await settle();
    // The computer sleeps through the boot discovery: it ends 25 hours after it began.
    vi.setSystemTime(T0 + 25 * HOUR);
    release();
    await background.started;
    expect(history.saved?.applyCheckAt).toBe(new Date(T0 + 25 * HOUR).toISOString());

    await vi.advanceTimersByTimeAsync(0);
    await at(30.99);
    expect(h.discoverCount()).toBe(1);
    await at(31);
    expect(h.discoverCount()).toBe(2);
    expect(history.saved?.applyCheckAt).toBe(new Date(T0 + 25 * HOUR).toISOString());
    background.stop();
  });
});

describe("updates.json", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-updates-history-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves an unreadable file as it is when stopped before the read ends", async () => {
    const path = join(dir, "updates.json");
    writeFileSync(path, "{ incomplete");
    const h = harness({ history: updateHistoryStore(path) });
    const background = startMarketplaceBackground(h.input);
    background.stop();
    await background.started;
    expect(h.calls).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("{ incomplete");
    // Nor is it reported: the loader only says what it found, and the stopped scheduler says nothing.
    expect(h.input.log.warn).not.toHaveBeenCalled();
  });

  it("an unreadable file sets historyReset, is replaced by an empty history, and runs a discovery", async () => {
    const path = join(dir, "updates.json");
    writeFileSync(path, "{ not json");
    const h = harness({ history: updateHistoryStore(path) });
    let replaced: unknown = null;
    vi.mocked(h.service.enforceRevocations).mockImplementationOnce(async () => {
      replaced = JSON.parse(readFileSync(path, "utf8"));
    });
    const background = startMarketplaceBackground(h.input);
    await background.started;
    // Replaced before the boot pass starts, not only by the boot's own discovery.
    expect(replaced).toEqual({ version: 1, discovery: null, applyCheckAt: null, packages: {} });
    expect(h.input.log.warn).toHaveBeenCalledWith(expect.stringMatching(/^marketplace updates\.json is not in the format Ave writes \(.+\); starting a new update history$/u));

    expect(h.discoverCount()).toBe(1);
    const status = await background.status();
    expect(status.historyReset).toBe(true);
    expect(status.discovery.result).toBe("ok");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, discovery: { result: "ok" }, applyCheckAt: new Date(T0).toISOString() });
    background.stop();
  });

  it("keeps the cadence across a restart", async () => {
    const path = join(dir, "updates.json");
    const first = harness({ history: updateHistoryStore(path) });
    const background = startMarketplaceBackground(first.input);
    await background.started;
    background.stop();

    await at(2);
    const second = harness({ history: updateHistoryStore(path) });
    const restarted = startMarketplaceBackground(second.input);
    const before = await restarted.status();
    expect(before.historyReset).toBe(false);
    expect(before.discovery.lastSuccessAt).toBe(new Date(T0).toISOString());
    await restarted.started;
    restarted.stop();
  });
});

describe("a stopped scheduler (the lifecycle gate)", () => {
  const notice = { forYou: [{ sourceId: "ave", kind: "plugin" as const, name: "meeting" }], required: [], unmanaged: [], lostGrants: [], revoked: [], autoUpdated: [] };

  it("publishes no revocation notice from a recheck whose service opens after the stop", async () => {
    const h = harness();
    const background = startMarketplaceBackground(h.input);
    await background.started;
    let release: () => void = () => {};
    h.input.service = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return h.service;
    };
    vi.mocked(h.service.takeRevocationNotice).mockReturnValueOnce(notice);
    const taken = vi.mocked(h.service.takeRevocationNotice).mock.calls.length;
    const check = background.recheck();
    await settle();
    background.stop();
    release();
    await check;
    expect(h.input.publishNotice).not.toHaveBeenCalled();
    // The notice is not taken either: nothing in the service moves after the stop.
    expect(vi.mocked(h.service.takeRevocationNotice).mock.calls).toHaveLength(taken);
  });

  it("publishes neither the notice nor the status of boot installs that end after the stop", async () => {
    const h = harness();
    let release: () => void = () => {};
    vi.mocked(h.service.applyBootInstalls).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { report: EMPTY_REPORT, notice };
    });
    const background = startMarketplaceBackground(h.input);
    await settle();
    const statuses = vi.mocked(h.input.publishStatus).mock.calls.length;
    background.stop();
    release();
    await background.started;
    expect(h.input.publishNotice).not.toHaveBeenCalled();
    expect(vi.mocked(h.input.publishStatus).mock.calls).toHaveLength(statuses);
  });

  it("publishes no error when the boot's service rejects after the stop", async () => {
    const h = harness();
    let reject: (error: Error) => void = () => {};
    h.input.service = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    const background = startMarketplaceBackground(h.input);
    await settle();
    const statuses = vi.mocked(h.input.publishStatus).mock.calls.length;
    background.stop();
    reject(new Error("shutdown"));
    await background.started;
    expect(vi.mocked(h.input.publishStatus).mock.calls).toHaveLength(statuses);
  });

  it("publishes no startup error when reading the history rejects after the stop", async () => {
    const h = harness();
    let reject: (error: Error) => void = () => {};
    h.input.history.load = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    const background = startMarketplaceBackground(h.input);
    background.stop();
    reject(new Error("shutdown"));
    await background.started;
    expect(h.input.publishStatus).not.toHaveBeenCalled();
  });

  /**
   * Every wait of every flow, stopped at that wait, which then fulfils or
   * rejects: afterwards nothing is published, written or started. An effect
   * added without the gate makes a row fail.
   */
  type Point = "load" | "service" | "enforceRevocations" | "discover" | "updates" | "appliedDefaults" | "applyBootInstalls" | "save";
  type Flow = "boot" | "recheck" | "Check now" | "due apply check";
  const WAITS: Array<[Flow, Point]> = [
    ["boot", "load"],
    ["boot", "service"],
    ["boot", "enforceRevocations"],
    ["boot", "discover"],
    ["boot", "updates"],
    ["boot", "save"],
    ["boot", "appliedDefaults"],
    ["boot", "applyBootInstalls"],
    ["recheck", "service"],
    ["recheck", "updates"],
    ["Check now", "service"],
    ["Check now", "discover"],
    ["Check now", "updates"],
    ["Check now", "save"],
    ["due apply check", "service"],
    ["due apply check", "discover"],
    ["due apply check", "updates"],
    ["due apply check", "save"],
  ];
  const ROWS = WAITS.flatMap(([flow, point]) => (["fulfils", "rejects"] as const).map((ending) => [flow, point, ending] as const));

  it.each(ROWS)("%s, stopped while it waits on %s, which then %s: nothing more is published, written or started", async (flow, point, ending) => {
    let armed: Point | null = null;
    let held: { resolve: () => void; reject: (error: Error) => void } | null = null;
    /** Each call into the service, the app's files or history, as it begins. */
    const begun: string[] = [];
    const pass = async (at: Point) => {
      begun.push(at);
      if (armed !== at) return;
      armed = null;
      await new Promise<void>((resolve, reject) => {
        held = { resolve, reject };
      });
    };
    const memory = memoryHistory();
    let saves = 0;
    const history: UpdateHistoryStore = {
      load: async () => {
        await pass("load");
        return memory.load();
      },
      save: async (next) => {
        saves += 1;
        await pass("save");
        await memory.save(next);
      },
    };
    const h = harness({ history });
    h.published.offers = [offer("meeting", "2.0.0")];
    // Every source of a notice has one to give, so a notice sent after the stop would show.
    vi.mocked(h.service.takeRevocationNotice).mockReturnValue(notice);
    // A report that is logged, so a continuation that handles it after the stop would show.
    const report: BootInstallReport = {
      ...EMPTY_REPORT,
      installed: [{ kind: "plugin", name: "meeting", source: "ave" }],
      failed: [{ key: { kind: "plugin", name: "notes", source: "ave" }, message: "release asset missing" }],
    };
    vi.mocked(h.service.applyBootInstalls).mockImplementation(async () => ({ report, notice }));
    const service = h.input.service;
    h.input.service = async () => {
      await pass("service");
      return service();
    };
    const appliedDefaults = h.input.appliedDefaults;
    h.input.appliedDefaults = async () => {
      await pass("appliedDefaults");
      return appliedDefaults();
    };
    for (const method of ["enforceRevocations", "discover", "updates", "applyBootInstalls"] as const) {
      const original = h.service[method] as (...args: unknown[]) => Promise<unknown>;
      (h.service as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        await pass(method);
        return original(...args);
      };
    }

    let flowEnd: Promise<unknown>;
    let background: ReturnType<typeof startMarketplaceBackground>;
    if (flow === "boot") {
      armed = point;
      background = startMarketplaceBackground(h.input);
      flowEnd = background.started;
    } else {
      background = startMarketplaceBackground(h.input);
      await background.started;
      if (flow === "recheck") {
        armed = point;
        flowEnd = background.recheck();
      } else if (flow === "Check now") {
        await at(2);
        armed = point;
        flowEnd = background.checkNow().catch(() => undefined);
      } else {
        // The discoveries at 6, 12 and 18 hours run first; the apply check
        // falls due at 24, and a due check (here the one `resume` runs) starts it.
        await at(23.99);
        vi.setSystemTime(T0 + 24 * HOUR);
        armed = point;
        h.resume.forEach((listener) => listener());
        flowEnd = Promise.resolve();
      }
    }
    for (let round = 0; round < 20 && held === null; round += 1) await settle();
    expect(held, `the ${flow} reached ${point}`).not.toBeNull();

    const counts = () => ({
      status: vi.mocked(h.input.publishStatus).mock.calls.length,
      notice: vi.mocked(h.input.publishNotice).mock.calls.length,
      updates: vi.mocked(h.input.publishUpdates).mock.calls.length,
      updateStatus: vi.mocked(h.input.publishUpdateStatus).mock.calls.length,
      saves,
      begun: [...begun],
      takenNotices: vi.mocked(h.service.takeRevocationNotice).mock.calls.length,
      logs: vi.mocked(h.input.log.info).mock.calls.length + vi.mocked(h.input.log.warn).mock.calls.length,
    });
    const before = counts();
    background.stop();
    if (ending === "fulfils") held!.resolve();
    else held!.reject(new Error("shutdown"));
    await flowEnd;
    await settle();
    await at(72);
    await background.recheck();
    await background.settingsChanged();
    h.resume.forEach((listener) => listener());
    await settle();
    expect(counts()).toEqual(before);
    // No wake-up is left armed.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("automatic apply (design §18.7.4, §18.7.5)", () => {
  const ON = { updateNotices: true, autoUpdate: true };
  const APPLIED_AT = new Date(T0).toISOString();

  function applying(outcomes: ApplyOutcome[] = []) {
    const store = memoryHistory();
    const h = Object.assign(harness({ settings: ON, history: store }), { store });
    h.published.offers = [offer("meeting", "2.0.0")];
    const queue = [...outcomes];
    vi.mocked(h.service.applyUpdate).mockImplementation(async () => queue.shift() ?? { state: "applied" });
    return h;
  }

  async function idle(background: { started: Promise<void> }): Promise<void> {
    await background.started;
    await settle();
  }

  it("applies an automatic update at the boot apply check while idle, records it, and announces it once", async () => {
    const h = applying();
    const background = startMarketplaceBackground(h.input);
    await idle(background);
    expect(h.service.applyUpdate).toHaveBeenCalledOnce();
    expect(vi.mocked(h.service.applyUpdate).mock.calls[0]![0]).toEqual({ key: offer("meeting", "2.0.0").key, from: "1.0.0", to: "2.0.0", required: false, switchSource: false });
    expect(h.store.saved?.packages["ave:plugin:meeting"]).toEqual({ to: "2.0.0", from: "1.0.0", displayName: "meeting", state: "applied", attempts: 0, appliedAt: APPLIED_AT });
    const notices = vi.mocked(h.input.publishNotice).mock.calls.map(([notice]) => notice.autoUpdated);
    expect(notices).toEqual([[{ key: offer("meeting", "2.0.0").key, displayName: "meeting", from: "1.0.0", to: "2.0.0", commitRange: { from: "a".repeat(40), to: "b".repeat(40) }, required: false, state: "applied" }]]);
    // Its offer is gone once installed; the applied entry stays in the view, and never reaches the pill.
    h.published.offers = [];
    await background.recheck();
    expect(h.lastStatus().packages).toEqual([{ ...offer("meeting", "2.0.0"), state: "applied", appliedAt: APPLIED_AT }]);
    expect(vi.mocked(h.input.publishUpdates).mock.calls.flat(2).filter((update) => update.state === "applied")).toEqual([]);
    background.stop();
  });

  it("waits while the conversation is busy, shows waiting, and applies on the next idle moment", async () => {
    const h = applying();
    h.activity.busy = true;
    const background = startMarketplaceBackground(h.input);
    await idle(background);
    expect(h.service.applyUpdate).not.toHaveBeenCalled();
    expect(h.lastStatus()).toMatchObject({ waitingSince: APPLIED_AT, escalated: false, packages: [{ key: { name: "meeting" }, state: "waiting" }] });
    // Thirty minutes on, the card offers Apply now; without it the queue keeps waiting.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(h.lastStatus().escalated).toBe(true);
    expect(h.service.applyUpdate).not.toHaveBeenCalled();
    h.goIdle();
    await settle();
    expect(h.service.applyUpdate).toHaveBeenCalledOnce();
    expect(h.lastStatus()).toMatchObject({ waitingSince: null, escalated: false });
    background.stop();
  });

  it("Apply now applies what waits while the conversation stays busy", async () => {
    const h = applying();
    h.activity.busy = true;
    const background = startMarketplaceBackground(h.input);
    await idle(background);
    expect(h.service.applyUpdate).not.toHaveBeenCalled();
    await background.applyNow();
    await settle();
    expect(h.service.applyUpdate).toHaveBeenCalledOnce();
    background.stop();
  });

  it("records a failure before commit with its attempt, retries at each apply check, and stops after the third", async () => {
    const error = new MarketplaceError("SOURCE_UNREACHABLE", "git fetch failed", { detail: { reason: "offline" } });
    const h = applying([{ state: "failed", error }, { state: "failed", error }, { state: "failed", error: new Error("disk full at /Users/someone") }]);
    const background = startMarketplaceBackground(h.input);
    await idle(background);
    expect(h.store.saved?.packages["ave:plugin:meeting"]).toMatchObject({ state: "failed", attempts: 1, lastError: { code: "SOURCE_UNREACHABLE", detail: { reason: "offline" } } });
    expect(h.lastStatus().packages).toEqual([expect.objectContaining({ state: "failed", failure: { code: "SOURCE_UNREACHABLE", detail: { reason: "offline" }, message: "git fetch failed", attempts: 1 } })]);
    await background.checkNow();
    await settle();
    await background.checkNow();
    await settle();
    expect(h.service.applyUpdate).toHaveBeenCalledTimes(3);
    // Anything but a marketplace refusal is `unavailable`, its message kept behind Copy details.
    expect(h.store.saved?.packages["ave:plugin:meeting"]).toMatchObject({ state: "failed", attempts: 3, lastError: { code: "unavailable" } });
    await background.checkNow();
    await settle();
    expect(h.service.applyUpdate).toHaveBeenCalledTimes(3);
    expect(h.lastStatus().packages).toEqual([expect.objectContaining({ state: "failed", reasons: ["failed-three-times"] })]);
    background.stop();
  });

  it("a deferral at checkpoint two three passes in a row stays needs-review with no attempt", async () => {
    const deferred: ApplyOutcome = { state: "needs-review", delta: [{ field: "hook:audit", checkpoint: "staged", before: null, after: "a".repeat(64) }] };
    const h = applying([deferred, deferred, deferred]);
    const background = startMarketplaceBackground(h.input);
    await idle(background);
    await background.checkNow();
    await settle();
    await background.checkNow();
    await settle();
    expect(h.service.applyUpdate).toHaveBeenCalledTimes(3);
    expect(h.store.saved?.packages["ave:plugin:meeting"]).toMatchObject({ state: "needs-review", attempts: 0 });
    expect(h.store.saved?.packages["ave:plugin:meeting"]?.lastError).toBeUndefined();
    expect(h.lastStatus().packages).toEqual([expect.objectContaining({ state: "needs-review", reasons: ["consent-changed"] })]);
    background.stop();
  });

  it("records a committed generation that did not start as applied-not-running, counting no attempt", async () => {
    const h = applying([{ state: "applied-not-running" }]);
    vi.mocked(h.service.appliedState).mockResolvedValue({ state: "applied-not-running" });
    const background = startMarketplaceBackground(h.input);
    await idle(background);
    expect(h.store.saved?.packages["ave:plugin:meeting"]).toMatchObject({ state: "applied-not-running", attempts: 0 });
    expect(vi.mocked(h.input.publishNotice).mock.calls.at(-1)![0].autoUpdated).toEqual([expect.objectContaining({ state: "applied-not-running" })]);
    h.published.offers = [];
    await background.recheck();
    // It needs the user: Restart Ave.
    expect(vi.mocked(h.input.publishUpdates).mock.calls.at(-1)![0]).toEqual([expect.objectContaining({ state: "applied-not-running" })]);
    background.stop();
  });

  it("writes only states of the view's union", async () => {
    const error = new Error("x");
    for (const outcome of [{ state: "applied" }, { state: "applied-not-running" }, { state: "approval-pending" }, { state: "needs-review", delta: null }, { state: "failed", error }] as ApplyOutcome[]) {
      const h = applying([outcome]);
      vi.mocked(h.service.appliedState).mockResolvedValue(outcome.state === "approval-pending" ? { state: "approval-pending", pendingApproval: null } : { state: "applied" });
      const background = startMarketplaceBackground(h.input);
      await idle(background);
      for (const record of Object.values(h.store.saved?.packages ?? {})) expect(UPDATE_PACKAGE_STATES).toContain(record.state);
      for (const update of h.lastStatus().packages) expect(UPDATE_PACKAGE_STATES).toContain(update.state);
      background.stop();
    }
  });

  it("a required update leaves a component unapproved as approval-pending, with its review, until the user approves it", async () => {
    const h = applying([{ state: "approval-pending" }]);
    h.published.offers = [{ key: { sourceId: "corp", kind: "agent-plugin", name: "assist" }, displayName: "Assist", from: "1.0.0", to: "2.0.0" }];
    h.published.facts = { assist: { required: true } };
    const pendingApproval = {
      installId: "11111111-2222-4333-8444-555555555555",
      consentDelta: [{ field: "mcpServer:search", checkpoint: "staged" as const, before: null, after: "b".repeat(64) }],
      components: [{ name: "search", digest: "c".repeat(64), approvalDigest: "b".repeat(64) }],
    };
    vi.mocked(h.service.appliedState).mockResolvedValue({ state: "approval-pending", pendingApproval });
    const discoveries = [...h.discoveries];
    h.discoveries.splice(0, h.discoveries.length, ...discoveries, { result: "ok", reached: ["corp"] }, { result: "ok", reached: ["corp"] });
    const background = startMarketplaceBackground(h.input);
    await idle(background);
    // Applied with the policy's review, though automatic updates are on or off.
    expect(vi.mocked(h.service.applyUpdate).mock.calls[0]![0]).toMatchObject({ required: true });
    expect(h.store.saved?.packages["corp:agent-plugin:assist"]).toMatchObject({ state: "approval-pending" });
    h.published.offers = [];
    await background.recheck();
    expect(h.lastStatus().packages).toEqual([expect.objectContaining({ state: "approval-pending", pendingApproval })]);
    expect(vi.mocked(h.input.publishNotice).mock.calls.at(-1)![0].autoUpdated).toEqual([expect.objectContaining({ required: true, state: "approval-pending" })]);

    vi.mocked(h.service.appliedState).mockResolvedValue({ state: "applied" });
    const status = await background.approveComponents({ sourceId: "corp", kind: "agent-plugin", name: "assist" }, pendingApproval.installId, pendingApproval.components);
    expect(h.service.approveComponents).toHaveBeenCalledWith({ sourceId: "corp", kind: "agent-plugin", name: "assist" }, pendingApproval.installId, pendingApproval.components);
    expect(status.packages).toEqual([expect.objectContaining({ state: "applied" })]);
    background.stop();
  });

  it("does not apply a switched-off update, and applies nothing more once stopped", async () => {
    const h = applying();
    h.settings.current = { updateNotices: true, autoUpdate: false };
    const background = startMarketplaceBackground(h.input);
    await idle(background);
    expect(h.service.applyUpdate).not.toHaveBeenCalled();

    const busy = applying();
    busy.activity.busy = true;
    const second = startMarketplaceBackground(busy.input);
    await idle(second);
    const saved = structuredClone(busy.store.saved);
    second.stop();
    busy.goIdle();
    await settle();
    expect(busy.service.applyUpdate).not.toHaveBeenCalled();
    expect(busy.store.saved).toEqual(saved);
    background.stop();
  });
});
