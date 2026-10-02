/**
 * The git marketplace's work outside a request (design §7.3, §10.2,
 * §18.7.1): the boot pass and the one update scheduler.
 *
 * Once the window has loaded: enforce the revocations already on disk, run a
 * discovery (sync every source, enforce what it brought, compute the
 * updates), apply the default and required installs, and publish what they
 * did — the notice (§15.1) and the status the boot pill shows, whose Retry
 * runs the same pass again. The boot's apply check joins that discovery.
 *
 * After that a **due check** runs at most an hour apart, on `resume`, on a
 * settings change and on *Check now*. It starts what is due:
 *
 * - **discovery**, after a failed attempt once `lastAttemptAt` is an hour
 *   old, after a success once `lastSuccessAt` is `updateCheckIntervalMs` old;
 * - the **apply check**, at boot, on *Check now*, and 24 hours after the last
 *   successful one. It always obtains a fresh discovery — joining one in
 *   flight or starting one — and classifies only that discovery's updates:
 *   all of them when it is `ok` (then `applyCheckAt` is written), the reached
 *   sources' when `partial`, none when `offline` or `error`.
 *
 * Times come from `updates.json` (`../updates/history.ts`), so the cadence
 * survives a restart and a sleep: the timer only wakes the due check, which
 * reads the wall clock. The timer is unreferenced and stops with the app, and
 * a stopped scheduler starts nothing.
 *
 * Every list of updates is classified (`../updates/eligibility.ts`): what
 * needs the user (`needs-review`, `manual`, `failed`) reaches the toolbar
 * pill. The apply check queues each `automatic` update, and required
 * updates, on the apply queue (`../updates/apply.ts`), which applies one
 * package at a time while the conversation is idle and records each
 * outcome: `applied`, `applied-not-running` and `approval-pending` stay in
 * the view and are announced once under "Updated automatically" (§18.7.5).
 */
import { AsyncResource } from "node:async_hooks";
import type { AppBootstrapStatus } from "../../shared/bootstrap-status.js";
import { errorMessage } from "../../shared/error-message.js";
import { scrubDiagnosticSecrets } from "../../shared/dlp.js";
import {
  updateViewNeedsUser,
  type AutoUpdatedView,
  type BootInstallNoticeView,
  type InstallProgressView,
  type PackageKeyView,
  type PackageUpdateOffer,
  type PackageUpdateView,
  type ReviewedComponentConsent,
  type SyncProgressView,
  type UpdateDiscoveryResult,
  type UpdatePackageState,
  type UpdateReason,
  type UpdateStatusView,
} from "../../shared/git-marketplace.js";
import { isSkippedPackageUpdate, packageUpdateSkipKey, readSkippedPluginUpdates } from "../../shared/skipped-plugin-updates.js";
import { isMarketplaceError, scrubMarketplaceErrorDetail } from "../errors.js";
import { ApplyQueue, type ApplyItem, type ApplyOutcome } from "../updates/apply.js";
import { classifyUpdate, resolvePackageSwitch, resolveSourceSwitch, type AutoUpdateSettings, type UpdateClassification } from "../updates/eligibility.js";
import type { AppliedState, ApplyDecision, ApplyTarget, AutoUpdateContext, UpdateCandidate } from "./service.js";
import type { AppliedDefaults } from "../boot-installs/applied.js";
import { packageKeyId } from "../boot-installs/default-installs.js";
import type { BootInstallReport } from "../boot-installs/run.js";
import type { PackageKey } from "../sources/policy.js";
import {
  applyCheckDueAt,
  discoveryDueAt,
  emptyUpdateHistory,
  HOUR_MS,
  parseUpdateRecordKey,
  updateRecordKey,
  updateRecordSource,
  type PackageUpdateRecord,
  type SyncDiscovery,
  type UpdateFailureRecord,
  type UpdateHistory,
  type UpdateHistoryStore,
} from "../updates/history.js";

/**
 * The one boundary the marketplace's events cross to the renderer (design
 * §7.3). Wrap each sender with it: once `shutdown` has aborted, the wrapped
 * sender drops what it is given, whichever internal continuation sends it.
 * The IPC domain wraps every outward callback of the service, the syncer
 * and the revocation sink — `onSyncProgress`, `onInstallProgress`,
 * `onCatalogChanged` (service and syncer), the revocation sink's catalog
 * change — and the scheduler's four publications. The work behind an event
 * (an install and its record, a sync and its pin) still finishes.
 */
export function whileRunning(shutdown: AbortSignal): <A extends unknown[]>(send: (...args: A) => void) => (...args: A) => void {
  return (send) =>
    (...args) => {
      if (!shutdown.aborted) send(...args);
    };
}

/** Where the marketplace's events go: the renderer broadcasts, in the IPC domain. */
export interface MarketplaceEventSinks {
  syncProgress(progress: SyncProgressView): void;
  installProgress(progress: InstallProgressView): void;
  catalogChanged(): void;
}

/**
 * Every outward callback of the service, the syncer and the revocation sink,
 * each through {@link whileRunning}: `onSyncProgress` (service),
 * `onInstallProgress` (service), `onCatalogChanged` (service, syncer and
 * revocation sink alike). The IPC domain builds the service with exactly
 * these.
 */
export function marketplaceEvents(shutdown: AbortSignal, sinks: MarketplaceEventSinks) {
  const gated = whileRunning(shutdown);
  return {
    onSyncProgress: gated((progress: SyncProgressView) => sinks.syncProgress(progress)),
    onInstallProgress: gated((progress: InstallProgressView) => sinks.installProgress(progress)),
    onCatalogChanged: gated(() => sinks.catalogChanged()),
  };
}

/** The code default (§7.3): a discovery fetches every source. */
export const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A stored interval below this is raised to it when read (§7.3). */
export const MIN_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/** The discovery interval: unset → 6 hours, `0` → boot and *Check now* only, below 15 minutes → 15 minutes. */
export function syncIntervalMs(stored: number | undefined): number {
  if (stored === undefined || !Number.isFinite(stored) || stored < 0) return DEFAULT_SYNC_INTERVAL_MS;
  if (stored === 0) return 0;
  return Math.max(stored, MIN_SYNC_INTERVAL_MS);
}

/** How long an `applied` entry stays in the view: the card's recent list (§15.7.1). */
const RECENT_APPLIED_MS = 24 * HOUR_MS;

/** The states an applied update keeps in the view after its offer is gone (§18.7.5). */
const APPLIED_STATES: ReadonlySet<UpdatePackageState> = new Set(["applied", "applied-not-running", "approval-pending"]);

/** A recorded failure as the view shows it (§18.7.5): its code, detail, scrubbed message and the attempts at this version. */
function failureView(record: PackageUpdateRecord & { lastError: UpdateFailureRecord }): NonNullable<PackageUpdateView["failure"]> {
  const { code, detail, message } = record.lastError;
  return { code, ...(detail ? { detail } : {}), ...(message ? { message } : {}), attempts: record.attempts };
}

/** One update on the apply queue. */
interface QueuedUpdate extends ApplyItem {
  candidate: UpdateCandidate;
}

/** The record of a failure before commit (§18.7.5): a marketplace refusal by code and detail, anything else as `unavailable`. */
function failureRecord(error: unknown, at: string): UpdateFailureRecord {
  if (isMarketplaceError(error)) {
    return { code: error.code, ...(error.detail ? { detail: scrubMarketplaceErrorDetail(error.code, error.detail) } : {}), message: scrubDiagnosticSecrets(error.message), at };
  }
  return { code: "unavailable", message: scrubDiagnosticSecrets(errorMessage(error)), at };
}

/**
 * What the scheduler asks of the marketplace service. `signal` is the
 * scheduler's shutdown: once it aborts, the service starts no further stage
 * and sends no progress, and the call rejects with its reason.
 */
export interface BackgroundService {
  enforceRevocations(signal: AbortSignal): Promise<void>;
  takeRevocationNotice(): BootInstallNoticeView | null;
  /** Sync every source that syncs and enforce the revocations; throws only outside a sync result. */
  discover(signal: AbortSignal): Promise<SyncDiscovery>;
  updates(signal: AbortSignal): Promise<PackageUpdateOffer[]>;
  /** The updates of the reached sources with what classifies them (§18.7.2). */
  updateCandidates(reached: ReadonlySet<string>, signal: AbortSignal): Promise<UpdateCandidate[]>;
  /** The policy's `autoUpdate` and each source's facts, for the switches. */
  autoUpdateContext(signal: AbortSignal): Promise<AutoUpdateContext>;
  applyBootInstalls(defaults: readonly PackageKey[], applied: AppliedDefaults, signal: AbortSignal): Promise<{ report: BootInstallReport; notice: BootInstallNoticeView | null }>;
  /** Apply one queued update (§18.7.4), if `decide` still finds it automatic under the locks. */
  applyUpdate(target: ApplyTarget, decide: ApplyDecision, signal: AbortSignal): Promise<ApplyOutcome>;
  /** An applied update read again; null when it is no longer installed at that version. */
  appliedState(key: PackageKeyView, to: string): Promise<AppliedState | null>;
  callsInFlight(name: string): Promise<boolean>;
  approveComponents(key: PackageKeyView, installId: string, consents: readonly ReviewedComponentConsent[]): Promise<void>;
}

export interface MarketplaceBackgroundInput {
  service(): Promise<BackgroundService>;
  appliedDefaults(): Promise<AppliedDefaults>;
  defaults: readonly PackageKey[];
  /** Read at each use: the interval at each due check, notices, skips and switches at each publication. */
  settings(): AutoUpdateSettings & { updateNotices: boolean; updateCheckIntervalMs?: number; skippedPluginUpdates?: unknown };
  /** The conversation's idle gate (§18.7.4). */
  activity: { isBusy(): boolean; onIdle(listener: () => void): () => void };
  history: UpdateHistoryStore;
  publishStatus(status: AppBootstrapStatus): void;
  publishNotice(notice: BootInstallNoticeView): void;
  /** `marketplace:updates-available`: only the updates that need the user. */
  publishUpdates(updates: PackageUpdateView[]): void;
  /** `marketplace:update-status`. */
  publishUpdateStatus(status: UpdateStatusView): void;
  /** Subscribe to the system waking from sleep; returns the unsubscribe. */
  onResume(listener: () => void): () => void;
  log: { info(message: string): void; warn(message: string): void };
}

export interface MarketplaceBackground {
  /** The boot pass, the boot apply check and the first update list; resolves when all are done. */
  readonly started: Promise<void>;
  /** Sync and apply the boot installs again (the status pill's Retry). Joins a pass in flight. */
  retryBootInstalls(): Promise<void>;
  /** Recompute the updates without syncing: an install, uninstall or sync changed what is installed or offered. */
  recheck(): Promise<void>;
  /**
   * `marketplace` settings were written: the updates are published again
   * under the new notice, skip and switch settings, a queued update they no
   * longer let apply by itself leaves the queue, and a due check runs, so a
   * shorter interval takes effect now.
   */
  settingsChanged(): Promise<void>;
  /** What the scheduler knows (`updates:status`). */
  status(): Promise<UpdateStatusView>;
  /** *Check now* (`updates:check`): an apply check, joined if one runs; answers when its discovery and classification end. */
  checkNow(): Promise<UpdateStatusView>;
  /** *Apply now* (`updates:apply-now`): the queue skips the wait for the conversation to pause (§18.7.4). */
  applyNow(): Promise<UpdateStatusView>;
  /** Approve an `approval-pending` agent plugin's components (`components:approve`, §18.7.5). */
  approveComponents(key: PackageKeyView, installId: string, consents: readonly ReviewedComponentConsent[]): Promise<UpdateStatusView>;
  stop(): void;
}

interface DiscoveryOutcome {
  result: UpdateDiscoveryResult;
  reached: ReadonlySet<string>;
  updates: PackageUpdateOffer[];
  error?: unknown;
}

function statusFrom(report: BootInstallReport): AppBootstrapStatus {
  return {
    phase: "complete",
    installed: report.installed.map((key) => key.name),
    failed: report.failed.map((item) => ({ id: item.key.name, error: item.message })),
  };
}

function describe(keys: readonly PackageKey[]): string {
  return keys.map(packageKeyId).join(", ");
}

function updatesKey(updates: readonly PackageUpdateView[]): string {
  return updates
    .map((update) => `${update.key.sourceId}/${update.key.kind}/${update.key.name}@${update.from}->${update.to}:${update.state}${update.stale ? ":stale" : ""}`)
    .sort()
    .join("|");
}

/** What a wait ends with once the scheduler has stopped (see `gate` below). */
class SchedulerStopped extends Error {
  constructor() {
    super("the update scheduler has stopped");
    this.name = "SchedulerStopped";
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function startMarketplaceBackground(input: MarketplaceBackgroundInput): MarketplaceBackground {
  const { log } = input;
  // Background work is never part of the operation that asked for it (§18.6). A recheck can be asked
  // for from inside a marketplace operation (a sync that published a snapshot, an install), and work
  // started there would carry that operation's async context: its service calls would join an operation
  // that may already be ending, without their own policy refresh or shared lock. Every place below that
  // asks for work (each entry the caller holds, resume and the due-check timer) runs it in the context
  // the scheduler started in, so each service call is an operation of its own.
  const detached = new AsyncResource("marketplace-background");
  const now = () => Date.now();

  let history: UpdateHistory = emptyUpdateHistory();
  let historyReset = false;
  let offered: PackageUpdateOffer[] = [];
  /** The last list's updates of reached sources, with what classifies them, by record key. */
  let candidates = new Map<string, UpdateCandidate>();
  /** The policy and sources the switches resolve with; null until a list has been computed. */
  let context: AutoUpdateContext | null = null;
  /** An agent plugin's `approval-pending` review payload, by record key (§18.9). */
  const pendingApprovals = new Map<string, NonNullable<Extract<AppliedState, { state: "approval-pending" }>["pendingApproval"]>>();
  /** The sources the last finished discovery reached; null until one has. */
  let reached: ReadonlySet<string> | null = null;
  /** What is published: each offer of a reached source classified, the rest only as stale prior state. */
  let shown: PackageUpdateView[] = [];
  let discovering: Promise<DiscoveryOutcome> | null = null;
  let applying: Promise<void> | null = null;
  let bootPass: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Aborted by `stop()`; the gate reads it, and the service receives it to stop its own stages. */
  const shutdown = new AbortController();

  // ─── the lifecycle gate ───────────────────────────────────────────────────

  /**
   * The one place that knows whether the scheduler still runs. Every outward
   * effect passes through it:
   *
   * - `emit`: the four publications — `publishStatus`, `publishNotice`,
   *   `publishUpdates`, `publishUpdateStatus`;
   * - `work`: everything that reads or changes state outside the scheduler —
   *   opening the service, its calls (`enforceRevocations`, `discover`,
   *   `takeRevocationNotice`, `updates`, `applyBootInstalls`), reading the
   *   applied defaults, and loading and writing `updates.json` (`commit`,
   *   the replacement of an unreadable file included);
   * - `closed`: the due-check timer, which is armed only while open.
   *
   * Once `stop()` has run, `emit` drops a publication and `work` refuses to
   * start. Work in flight at the stop ends with {@link SchedulerStopped},
   * whether it fulfils or rejects, so no continuation after any wait does
   * anything; each entry point ends quietly on it.
   */
  const gate = {
    get closed(): boolean {
      return shutdown.signal.aborted;
    },
    /** Handed to the service, whose own stages and progress stop with it. */
    signal: shutdown.signal,
    emit(publication: () => void): void {
      if (!gate.closed) publication();
    },
    async work<T>(run: () => T | Promise<T>): Promise<T> {
      if (gate.closed) throw new SchedulerStopped();
      let value: T;
      try {
        value = await run();
      } catch (error) {
        if (gate.closed) throw new SchedulerStopped();
        throw error;
      }
      if (gate.closed) throw new SchedulerStopped();
      return value;
    },
  };

  const intervalMs = () => syncIntervalMs(input.settings().updateCheckIntervalMs);

  // ─── what is published ────────────────────────────────────────────────────

  /**
   * A classified update as the view shows it. The queue's own state comes
   * first (applying, or waiting for idle or for an agent plugin's calls), then
   * what the last attempt at this version recorded (a failure, a deferral at
   * checkpoint two), then the classification.
   */
  const packageView = (candidate: UpdateCandidate, classification: UpdateClassification, settings: AutoUpdateSettings): PackageUpdateView => {
    const id = updateRecordKey(candidate.key);
    const record = history.packages[id];
    const memory = record && record.to === candidate.to ? record : undefined;
    const queued = queue.state();
    let state: UpdatePackageState = classification.state;
    let reasons: UpdateReason[] = [...classification.reasons];
    if (queued.applying === id) {
      state = "automatic";
    } else if (queued.queued.includes(id)) {
      const calls = queued.waitingForCalls.includes(id);
      state = calls || queued.waitingSince !== null ? "waiting" : "automatic";
      reasons = calls ? ["calls-in-flight"] : [];
    } else if (memory?.state === "failed" || memory?.state === "needs-review") {
      state = memory.state;
      if (memory.state === "needs-review" && reasons.length === 0) reasons = ["consent-changed"];
    }
    const escalated = state === "waiting" && queued.escalated;
    return {
      key: candidate.key,
      displayName: candidate.displayName,
      from: candidate.from,
      to: candidate.to,
      state,
      ...(reasons.length > 0 ? { reasons } : {}),
      ...(memory?.lastError ? { failure: failureView({ ...memory, lastError: memory.lastError }) } : {}),
      ...(context ? { autoUpdate: resolvePackageSwitch(context.policy, settings, candidate.facts.switchKey, candidate.facts.source, candidate.facts.required) } : {}),
      ...(escalated ? { escalated: true as const } : {}),
      ...(candidate.facts.required ? { required: true as const } : {}),
    };
  };

  /** An applied update that stays in the view after its offer is gone (§18.7.5). */
  const appliedView = (id: string, record: PackageUpdateRecord): PackageUpdateView => {
    const pending = pendingApprovals.get(id);
    return {
      key: parseUpdateRecordKey(id),
      displayName: record.displayName!,
      from: record.from!,
      to: record.to,
      state: record.state,
      ...(record.appliedAt ? { appliedAt: record.appliedAt } : {}),
      ...(record.commits ? { commitRange: record.commits } : {}),
      ...(record.state === "approval-pending" && pending ? { pendingApproval: pending } : {}),
    };
  };

  /**
   * Classify the updates of the sources the last discovery reached. An offer
   * from a source it did not reach is a cached snapshot's, so it is never
   * classified anew: what was shown for that version before keeps its state,
   * marked stale, while the package still offers that version. Skipped
   * versions are neither. Applied updates follow.
   */
  const classifyShown = () => {
    const settings = input.settings();
    const skipped = readSkippedPluginUpdates(settings.skippedPluginUpdates);
    const prior = new Map(shown.map((update) => [updateRecordKey(update.key), update]));
    const next: PackageUpdateView[] = [];
    const listed = new Set<string>();
    for (const [id, candidate] of candidates) {
      if (!context || !reached?.has(candidate.key.sourceId)) continue;
      const classification = classifyUpdate(candidate.facts, {
        policy: context.policy,
        settings,
        memory: history.packages[id] ?? null,
        skipped: isSkippedPackageUpdate(candidate, skipped),
      });
      if (!classification) continue;
      next.push(packageView(candidate, classification, settings));
      listed.add(id);
    }
    for (const update of offered) {
      const id = updateRecordKey(update.key);
      if (reached?.has(update.key.sourceId) || listed.has(id)) continue;
      const before = prior.get(id);
      // A required update ignores a skipped version (§18.7.2), stale or not.
      if (before && before.to === update.to && (before.required === true || !isSkippedPackageUpdate(update, skipped))) {
        next.push({ ...before, stale: true });
        listed.add(id);
      }
    }
    for (const [id, record] of Object.entries(history.packages)) {
      if (APPLIED_STATES.has(record.state) && !listed.has(id)) next.push(appliedView(id, record));
    }
    shown = next;
  };

  const view = (): UpdateStatusView => {
    const at = now();
    const next = Math.min(applyCheckDueAt(history), discoveryDueAt(history.discovery, intervalMs()));
    const queued = queue.state();
    const settings = input.settings();
    return {
      discovery: {
        lastAttemptAt: history.discovery?.lastAttemptAt ?? null,
        lastSuccessAt: history.discovery?.lastSuccessAt ?? null,
        result: history.discovery?.result ?? null,
        nextAt: iso(Math.max(at, next)),
      },
      applyCheckAt: history.applyCheckAt,
      running: discovering !== null || applying !== null,
      historyReset,
      waitingSince: queued.waitingSince === null ? null : iso(queued.waitingSince),
      escalated: queued.escalated,
      autoUpdate: autoUpdateView(settings),
      packages: shown,
    };
  };

  /**
   * The switches as they take effect (§18.7.2): under a policy value the
   * global switch shows that value, not the stored one; every installed
   * package bound to a listed source has its switch, update or not.
   */
  const autoUpdateView = (settings: AutoUpdateSettings): UpdateStatusView["autoUpdate"] => {
    const locked = context && context.policy !== "user" ? context.policy : null;
    const sources = context?.sources ?? [];
    const byId = new Map(sources.map((source) => [source.id, source]));
    return {
      enabled: locked !== null ? locked === "on" : settings.autoUpdate !== false,
      lockedByPolicy: locked,
      sources: sources.map((source) => ({
        id: source.id,
        label: source.label,
        origin: source.origin,
        switch: resolveSourceSwitch(context!.policy, settings, source),
        needsUnencryptedUpdates: source.http && !source.acknowledgedUnencryptedUpdates,
      })),
      packages: (context?.installed ?? []).flatMap(({ key, required }) => {
        const source = byId.get(key.sourceId);
        return source ? [{ key, switch: resolvePackageSwitch(context!.policy, settings, packageUpdateSkipKey(key), source, required) }] : [];
      }),
    };
  };

  // Only a change is sent; the renderer starts from no updates, so an empty first list is not sent either.
  let lastView = "";
  let lastUpdates = updatesKey([]);
  const publish = () => {
    // A stopped scheduler sends nothing: the window it would reach is closing.
    if (gate.closed) return;
    const status = view();
    const statusKey = JSON.stringify(status);
    if (statusKey !== lastView) {
      lastView = statusKey;
      gate.emit(() => input.publishUpdateStatus(status));
    }
    // Notices off: the pill hears of nothing that waits only for the user's choice.
    const notices = input.settings().updateNotices;
    // An escalated wait is sent whatever the notice setting: only *Apply now* moves it on (§18.7.4).
    const updates = status.packages.filter((update) => updateViewNeedsUser(update) && (notices || update.state !== "manual"));
    const key = updatesKey(updates);
    if (key === lastUpdates) return;
    gate.emit(() => input.publishUpdates(updates));
    lastUpdates = key;
    if (updates.length > 0) log.info(`marketplace updates available: ${updates.length}`);
  };

  /**
   * The one way history changes: through the gate, so `change` runs and the
   * file is written only while the scheduler runs. A write already started
   * when the scheduler stops completes.
   */
  const commit = async (change: () => void) => {
    try {
      await gate.work(async () => {
        change();
        try {
          await input.history.save(history);
        } catch (error) {
          // The scheduler keeps its times in memory; the next record writes them
          // again. A write that fails after a stop is the shutdown's and says nothing.
          if (!gate.closed) log.warn(`marketplace updates.json could not be written: ${errorMessage(error)}`);
        }
      });
    } catch (error) {
      if (!(error instanceof SchedulerStopped)) throw error;
    }
  };

  // ─── the update list ──────────────────────────────────────────────────────

  // Computed one after another, never joined: a list asked for after an
  // install must read what the install left.
  let tail: Promise<void> = Promise.resolve();
  const computeOffers = (): Promise<PackageUpdateOffer[]> => {
    const run = tail.then(async () => {
      const service = await gate.work(() => input.service());
      // What enforcement removed since the last notice: a discovery's revocations, or an install's refeed.
      const revoked = await gate.work(() => service.takeRevocationNotice());
      if (revoked) gate.emit(() => input.publishNotice(revoked));
      offered = await gate.work(() => service.updates(gate.signal));
      context = await gate.work(() => service.autoUpdateContext(gate.signal));
      const sources = reached ?? new Set<string>();
      const found = sources.size > 0 ? await gate.work(() => service.updateCandidates(sources, gate.signal)) : [];
      candidates = new Map(found.map((candidate) => [updateRecordKey(candidate.key), candidate]));
      classifyShown();
      publish();
      return offered;
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const recheck = async () => {
    try {
      await computeOffers();
    } catch (error) {
      if (error instanceof SchedulerStopped) return;
      log.warn(`marketplace update check failed; the last list stays: ${errorMessage(error)}`);
    }
  };

  // ─── discovery and the apply check ────────────────────────────────────────

  /** A discovery the scheduler's stop ended; nothing is recorded or published for it. */
  const STOPPED: DiscoveryOutcome = { result: "error", reached: new Set(), updates: [], error: new SchedulerStopped() };

  const runDiscovery = async (): Promise<DiscoveryOutcome> => {
    let outcome: DiscoveryOutcome;
    try {
      const service = await gate.work(() => input.service());
      const synced = await gate.work(() => service.discover(gate.signal));
      reached = new Set(synced.reached);
      outcome = { result: synced.result, reached, updates: await computeOffers() };
    } catch (error) {
      // A stop, or a rejection that arrives after one, is the shutdown's, not a failed attempt.
      if (error instanceof SchedulerStopped) return STOPPED;
      log.warn(`marketplace discovery failed; retried within the hour: ${errorMessage(error)}`);
      // This pass reached no source: what was shown stays only as stale, and
      // nothing cached is classified until a discovery reaches its source.
      reached = new Set();
      classifyShown();
      publish();
      outcome = { result: "error", reached, updates: [], error };
    }
    // Timed at its end, so a slow pass is not retried the moment it fails.
    const at = iso(now());
    await commit(() => {
      history.discovery = {
        lastAttemptAt: at,
        lastSuccessAt: outcome.result === "ok" ? at : (history.discovery?.lastSuccessAt ?? null),
        result: outcome.result,
      };
    });
    return outcome;
  };

  const discover = (): Promise<DiscoveryOutcome> => {
    if (discovering) return discovering;
    const run = runDiscovery().finally(() => {
      discovering = null;
      publish();
      arm();
    });
    discovering = run;
    publish();
    return run;
  };

  /**
   * Read an applied update again (§18.7.5): still installed at its version,
   * and whether a component still waits for approval or the generation
   * still does not run. Null when it no longer is installed at that version.
   */
  const settleApplied = async (id: string, record: PackageUpdateRecord): Promise<PackageUpdateRecord | null> => {
    const service = await gate.work(() => input.service());
    const settled = await gate.work(() => service.appliedState(parseUpdateRecordKey(id), record.to));
    if (!settled) {
      pendingApprovals.delete(id);
      return null;
    }
    if (settled.state === "approval-pending" && settled.pendingApproval) pendingApprovals.set(id, settled.pendingApproval);
    else pendingApprovals.delete(id);
    return { ...record, state: settled.state };
  };

  const runApplyCheck = async (): Promise<void> => {
    const outcome = await discover();
    if (outcome.result !== "ok" && outcome.result !== "partial") return;
    if (!context) return;
    const policy = context.policy;
    const settings = input.settings();
    const skipped = readSkippedPluginUpdates(settings.skippedPluginUpdates);
    const packages = Object.create(null) as Record<string, PackageUpdateRecord>;
    // A partial pass leaves what it did not reach as the last pass classified it.
    if (outcome.result === "partial") {
      for (const [key, entry] of Object.entries(history.packages)) {
        if (!outcome.reached.has(updateRecordSource(key))) packages[key] = entry;
      }
    }
    // Applied updates stay while they are installed: `applied` for a day (the recent list), the others until they clear.
    const at = now();
    for (const [id, entry] of Object.entries(history.packages)) {
      if (!APPLIED_STATES.has(entry.state) || id in packages) continue;
      if (entry.state === "applied" && entry.appliedAt && at - Date.parse(entry.appliedAt) >= RECENT_APPLIED_MS) continue;
      const settled = await settleApplied(id, entry);
      if (settled) packages[id] = settled;
    }
    const queued: QueuedUpdate[] = [];
    for (const [id, candidate] of candidates) {
      if (!outcome.reached.has(candidate.key.sourceId)) continue;
      const prior = history.packages[id];
      const memory = prior && prior.to === candidate.to ? prior : null;
      const classification = classifyUpdate(candidate.facts, { policy, settings, memory, skipped: isSkippedPackageUpdate(candidate, skipped) });
      if (!classification) continue;
      packages[id] = {
        to: candidate.to,
        state: classification.state,
        attempts: memory?.attempts ?? 0,
        ...(memory?.lastError ? { lastError: memory.lastError } : {}),
        from: candidate.from,
        displayName: candidate.displayName,
      };
      if (classification.state === "automatic") {
        queued.push({ id, kind: candidate.key.kind, name: candidate.key.name, provides: candidate.provides, needs: candidate.needs, candidate });
      }
    }
    await commit(() => {
      history.packages = packages;
      // Timed at its end: a check that spanned a sleep is not due again the moment it ends.
      if (outcome.result === "ok") history.applyCheckAt = iso(now());
    });
    if (gate.closed) return;
    // A later apply check replaces what is queued and leaves the package applying alone (§18.7.1).
    queue.replace(queued);
    classifyShown();
    publish();
  };

  /** Whether an update applies by itself under `policy` and the switches, skips and failures as they are now (§18.7.2). */
  const stillAutomatic = (id: string, facts: UpdateCandidate["facts"], policy: AutoUpdateContext["policy"]): boolean => {
    const settings = input.settings();
    const skipped = readSkippedPluginUpdates(settings.skippedPluginUpdates);
    const prior = history.packages[id];
    const memory = prior && prior.to === facts.to ? prior : null;
    const key = parseUpdateRecordKey(id);
    return classifyUpdate(facts, { policy, settings, memory, skipped: isSkippedPackageUpdate({ key, to: facts.to }, skipped) })?.state === "automatic";
  };

  /** The notice's "Updated automatically" entry for one applied update (§18.7.5). */
  const announce = (candidate: UpdateCandidate, state: AutoUpdatedView["state"]) => {
    const notice: BootInstallNoticeView = {
      forYou: [],
      required: [],
      unmanaged: [],
      lostGrants: [],
      revoked: [],
      autoUpdated: [{
        key: candidate.key,
        displayName: candidate.displayName,
        from: candidate.from,
        to: candidate.to,
        commitRange: candidate.commitRange,
        required: candidate.facts.required,
        state,
      }],
    };
    gate.emit(() => input.publishNotice(notice));
  };

  /** Record what one apply ended with (§18.7.4's table, §18.7.5). */
  const settled = async (item: QueuedUpdate, outcome: ApplyOutcome): Promise<void> => {
    // A stop ends quietly: nothing the shutdown cut short is recorded or announced.
    if (gate.closed) return;
    const { candidate } = item;
    const prior = history.packages[item.id];
    const attempts = prior && prior.to === candidate.to ? prior.attempts : 0;
    const base = { to: candidate.to, from: candidate.from, displayName: candidate.displayName };
    let record: PackageUpdateRecord;
    switch (outcome.state) {
      case "superseded":
        // A user install or uninstall came first: the list follows what is installed now.
        await recheck();
        return;
      case "failed":
        record = { ...base, state: "failed", attempts: attempts + 1, lastError: failureRecord(outcome.error, iso(now())) };
        log.warn(`marketplace update of ${item.id} to ${candidate.to} failed (attempt ${attempts + 1}): ${errorMessage(outcome.error)}`);
        break;
      case "needs-review":
        // A consent deferral is never a failure and never an attempt (§18.7.3).
        record = { ...base, state: "needs-review", attempts, ...(prior?.to === candidate.to && prior.lastError ? { lastError: prior.lastError } : {}) };
        break;
      default:
        record = { ...base, state: outcome.state, attempts: 0, appliedAt: iso(now()), commits: candidate.commitRange };
        log.info(`marketplace updated ${item.id} ${candidate.from} -> ${candidate.to} automatically (${outcome.state})`);
    }
    await commit(() => {
      history.packages[item.id] = record;
    });
    if (APPLIED_STATES.has(record.state)) {
      if (record.state === "approval-pending") {
        try {
          const settledRecord = await settleApplied(item.id, record);
          if (settledRecord) await commit(() => {
            history.packages[item.id] = settledRecord;
          });
        } catch (error) {
          if (error instanceof SchedulerStopped) return;
          log.warn(`marketplace could not read the approvals of ${item.id}: ${errorMessage(error)}`);
        }
      }
      announce(candidate, record.state as AutoUpdatedView["state"]);
    }
    await recheck();
  };

  const queue: ApplyQueue<QueuedUpdate> = new ApplyQueue<QueuedUpdate>({
    activity: input.activity,
    apply: async (item, signal) => {
      const service = await gate.work(() => input.service());
      const { candidate } = item;
      // Judged again under the service's locks with what is in force then: nothing queued earlier authorizes it.
      const decide: ApplyDecision = (facts, policy) => stillAutomatic(item.id, facts, policy);
      return gate.work(() => service.applyUpdate({
        key: candidate.key,
        from: candidate.from,
        to: candidate.to,
        switchSource: candidate.switchSource,
      }, decide, signal));
    },
    callsInFlight: async (item) => {
      const service = await gate.work(() => input.service());
      return gate.work(() => service.callsInFlight(item.name));
    },
    settled,
    changed: () => {
      if (gate.closed) return;
      classifyShown();
      publish();
    },
    signal: shutdown.signal,
    now,
    log,
  });

  const applyCheck = (): Promise<void> => {
    if (applying) return applying;
    const run = runApplyCheck().finally(() => {
      applying = null;
      publish();
      arm();
    });
    applying = run;
    publish();
    return run;
  };

  // ─── the due check and its timer ──────────────────────────────────────────

  /**
   * Wake the due check when something is due, and at least once an hour. A
   * run in flight is not due again; an apply check that falls due while a
   * discovery runs wakes to join it.
   */
  function arm(): void {
    if (gate.closed || bootPass) return;
    if (timer) clearTimeout(timer);
    const at = now();
    let next = at + HOUR_MS;
    if (!applying) next = Math.min(next, applyCheckDueAt(history));
    if (!applying && !discovering) next = Math.min(next, discoveryDueAt(history.discovery, intervalMs()));
    timer = setTimeout(
      detached.bind(() => {
        timer = null;
        dueCheck();
      }),
      Math.max(0, next - at),
    );
    // A wake-up never keeps the app alive.
    timer.unref?.();
  }

  function dueCheck(): void {
    // The boot pass runs its own discovery and apply check, and arms when it ends.
    if (gate.closed || bootPass) return;
    const at = now();
    if (!applying && at >= applyCheckDueAt(history)) void applyCheck();
    else if (!applying && !discovering && at >= discoveryDueAt(history.discovery, intervalMs())) void discover();
    arm();
  }

  // ─── boot ─────────────────────────────────────────────────────────────────

  const runBoot = (applyAtBoot: boolean): Promise<void> => {
    if (bootPass) return bootPass;
    const run = (async () => {
      gate.emit(() => input.publishStatus({ phase: "start" }));
      let applied: Promise<void> | null = null;
      // Each wait passes the gate: a stop during any of them ends the pass there.
      const pass = async () => {
        const service = await gate.work(() => input.service());
        // A revocation the last session synced acts now, not after the network answers.
        await gate.work(() => service.enforceRevocations(gate.signal));
        const discovered = discover();
        // The boot's apply check joins this discovery instead of starting another.
        if (applyAtBoot) applied = applyCheck();
        const outcome = await discovered;
        // A source that fails to sync reports it in its status; a throw (a stop's
        // included) is an unreadable file or a bug.
        if (outcome.result === "error") throw outcome.error;
        const appliedDefaults = await gate.work(() => input.appliedDefaults());
        const { report, notice } = await gate.work(() => service.applyBootInstalls(input.defaults, appliedDefaults, gate.signal));
        if (report.installed.length > 0) log.info(`marketplace boot installs: ${describe(report.installed)}`);
        if (report.failed.length > 0) {
          log.warn(`marketplace boot installs failed: ${report.failed.map((item) => `${packageKeyId(item.key)}: ${item.message}`).join("; ")}`);
        }
        if (notice) gate.emit(() => input.publishNotice(notice));
        gate.emit(() => input.publishStatus(statusFrom(report)));
      };
      try {
        await pass();
      } catch (error) {
        if (!(error instanceof SchedulerStopped)) {
          log.warn(`marketplace boot pass failed: ${errorMessage(error)}`);
          gate.emit(() => input.publishStatus({ phase: "error", message: errorMessage(error) }));
        }
      }
      await applied;
    })().finally(() => {
      bootPass = null;
    });
    bootPass = run;
    return run;
  };

  // A stop during the read leaves the empty history in memory and the file as it is.
  const loaded = gate.work(() => input.history.load()).then(
    async (read) => {
      history = read.history;
      historyReset = read.reset;
      if (read.reset) {
        // The loader only reports; what it found is said, and the file replaced, through the gate.
        const { reason } = read;
        gate.emit(() => log.warn(`marketplace updates.json ${reason}; starting a new update history`));
        await commit(() => {});
      }
      publish();
    },
    (error: unknown) => {
      if (!(error instanceof SchedulerStopped)) throw error;
    },
  );

  const started = loaded.then(
    async () => {
      await runBoot(true);
      // The boot installs changed what is installed: the list follows.
      await recheck();
      arm();
    },
    (error: unknown) => {
      // Reading the history failed outside a file problem: a bug. Nothing is scheduled.
      log.warn(`marketplace update scheduler could not start: ${errorMessage(error)}`);
      gate.emit(() => input.publishStatus({ phase: "error", message: errorMessage(error) }));
    },
  );

  const offResume = input.onResume(detached.bind(() => dueCheck()));

  const outside = <T>(run: () => Promise<T>): Promise<T> => detached.runInAsyncScope(run);

  return {
    started,
    retryBootInstalls: () =>
      outside(async () => {
        await loaded;
        if (gate.closed) throw new SchedulerStopped();
        await runBoot(false);
        await recheck();
        arm();
      }),
    recheck: () => outside(recheck),
    settingsChanged: () =>
      outside(async () => {
        await loaded;
        await recheck();
        // A switch turned off or a version skipped: what is queued and no longer automatic waits for the user.
        if (context) {
          const policy = context.policy;
          queue.retain((item) => {
            const fresh = candidates.get(item.id);
            return stillAutomatic(item.id, (fresh ?? item.candidate).facts, policy);
          });
        }
        dueCheck();
      }),
    status: async () => {
      await loaded;
      return view();
    },
    checkNow: () =>
      outside(async () => {
        await loaded;
        if (gate.closed) throw new SchedulerStopped();
        await applyCheck();
        return view();
      }),
    applyNow: () =>
      outside(async () => {
        await loaded;
        if (gate.closed) throw new SchedulerStopped();
        queue.applyNow();
        return view();
      }),
    approveComponents: (key, installId, consents) =>
      outside(async () => {
        await loaded;
        const service = await gate.work(() => input.service());
        await gate.work(() => service.approveComponents(key, installId, consents));
        // The state clears when no component of the installed generation is unapproved (§18.7.5).
        const id = updateRecordKey(key);
        const record = history.packages[id];
        if (record?.state === "approval-pending") {
          const settledRecord = await settleApplied(id, record);
          await commit(() => {
            if (settledRecord) history.packages[id] = settledRecord;
            else delete history.packages[id];
          });
        }
        await recheck();
        return view();
      }),
    stop: () => {
      shutdown.abort(new SchedulerStopped());
      if (timer) clearTimeout(timer);
      timer = null;
      offResume();
    },
  };
}
