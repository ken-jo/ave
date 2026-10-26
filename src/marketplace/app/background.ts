/** Schedules discovery and update application from persisted wall-clock times. */
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
import { classifyUpdate, requiresPackage, resolvePackageSwitch, resolveSourceSwitch, type AutoUpdateSettings, type UpdateClassification } from "../updates/eligibility.js";
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

/** Drops all renderer events after shutdown; in-flight installs and syncs still finish. */
export function whileRunning(shutdown: AbortSignal): <A extends unknown[]>(send: (...args: A) => void) => (...args: A) => void {
  return (send) =>
    (...args) => {
      if (!shutdown.aborted) send(...args);
    };
}

export interface MarketplaceEventSinks {
  syncProgress(progress: SyncProgressView): void;
  installProgress(progress: InstallProgressView): void;
  catalogChanged(): void;
}

/** All service, syncer and revocation-sink callbacks cross the shutdown boundary. */
export function marketplaceEvents(shutdown: AbortSignal, sinks: MarketplaceEventSinks) {
  const gated = whileRunning(shutdown);
  return {
    onSyncProgress: gated((progress: SyncProgressView) => sinks.syncProgress(progress)),
    onInstallProgress: gated((progress: InstallProgressView) => sinks.installProgress(progress)),
    onCatalogChanged: gated(() => sinks.catalogChanged()),
  };
}

export const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Persisted intervals below this floor are clamped on read. */
export const MIN_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/** The discovery interval: unset → 6 hours, `0` → boot and *Check now* only, below 15 minutes → 15 minutes. */
export function syncIntervalMs(stored: number | undefined): number {
  if (stored === undefined || !Number.isFinite(stored) || stored < 0) return DEFAULT_SYNC_INTERVAL_MS;
  if (stored === 0) return 0;
  return Math.max(stored, MIN_SYNC_INTERVAL_MS);
}

const RECENT_APPLIED_MS = 24 * HOUR_MS;

const APPLIED_STATES: ReadonlySet<UpdatePackageState> = new Set(["applied", "applied-not-running", "approval-pending"]);

/** Failures expose scrubbed messages and per-version attempt counts. */
function failureView(record: PackageUpdateRecord & { lastError: UpdateFailureRecord }): NonNullable<PackageUpdateView["failure"]> {
  const { code, detail, message } = record.lastError;
  return { code, ...(detail ? { detail } : {}), ...(message ? { message } : {}), attempts: record.attempts };
}

interface QueuedUpdate extends ApplyItem {
  candidate: UpdateCandidate;
}

/** Unexpected pre-commit failures use unavailable; marketplace refusals retain their code and detail. */
function failureRecord(error: unknown, at: string): UpdateFailureRecord {
  if (isMarketplaceError(error)) {
    return { code: error.code, ...(error.detail ? { detail: scrubMarketplaceErrorDetail(error.code, error.detail) } : {}), message: scrubDiagnosticSecrets(error.message), at };
  }
  return { code: "unavailable", message: scrubDiagnosticSecrets(errorMessage(error)), at };
}

/** Shutdown aborts later service stages and progress, rejecting with the signal reason. */
export interface BackgroundService {
  enforceRevocations(signal: AbortSignal): Promise<void>;
  takeRevocationNotice(): BootInstallNoticeView | null;
  /** Sync results contain expected failures; only unexpected failures throw. */
  discover(signal: AbortSignal): Promise<SyncDiscovery>;
  updates(signal: AbortSignal): Promise<PackageUpdateOffer[]>;
  updateCandidates(reached: ReadonlySet<string>, signal: AbortSignal): Promise<UpdateCandidate[]>;
  autoUpdateContext(signal: AbortSignal): Promise<AutoUpdateContext>;
  applyBootInstalls(defaults: readonly PackageKey[], applied: AppliedDefaults, signal: AbortSignal): Promise<{ report: BootInstallReport; notice: BootInstallNoticeView | null }>;
  /** Apply only if current eligibility still holds under the locks. */
  applyUpdate(target: ApplyTarget, decide: ApplyDecision, signal: AbortSignal): Promise<ApplyOutcome>;
  /** Null if the recorded version is no longer installed. */
  appliedState(key: PackageKeyView, to: string): Promise<AppliedState | null>;
  callsInFlight(name: string): Promise<boolean>;
  approveComponents(key: PackageKeyView, installId: string, consents: readonly ReviewedComponentConsent[]): Promise<void>;
}

export interface MarketplaceBackgroundInput {
  service(): Promise<BackgroundService>;
  appliedDefaults(): Promise<AppliedDefaults>;
  defaults: readonly PackageKey[];
  /** Settings are read at use time, including each publication and due check. */
  settings(): AutoUpdateSettings & { updateNotices: boolean; updateCheckIntervalMs?: number; skippedPluginUpdates?: unknown };
  activity: { isBusy(): boolean; onIdle(listener: () => void): () => void };
  history: UpdateHistoryStore;
  publishStatus(status: AppBootstrapStatus): void;
  publishNotice(notice: BootInstallNoticeView): void;
  /** Publishes only updates that need user action. */
  publishUpdates(updates: PackageUpdateView[]): void;
  publishUpdateStatus(status: UpdateStatusView): void;
  onResume(listener: () => void): () => void;
  log: { info(message: string): void; warn(message: string): void };
}

export interface MarketplaceBackground {
  /** Resolves after the boot pass, apply check and first update list. */
  readonly started: Promise<void>;
  /** Retries boot work, joining any pass in flight. */
  retryBootInstalls(): Promise<void>;
  /** Reclassifies changed installs or offers without syncing. */
  recheck(): Promise<void>;
  /** Reclassifies with current settings, removes ineligible queued updates and checks the new interval. */
  settingsChanged(): Promise<void>;
  status(): Promise<UpdateStatusView>;
  /** Joins any running apply check and waits for discovery and classification. */
  checkNow(): Promise<UpdateStatusView>;
  /** Bypasses the conversation-idle wait for queued updates. */
  applyNow(): Promise<UpdateStatusView>;
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
    .map((update) => `${update.key.sourceId}/${update.key.kind}/${update.key.name}@${update.from}->${update.to}:${update.state}`
      + `${update.stale ? ":stale" : ""}${update.escalated ? ":escalated" : ""}${update.required ? ":required" : ""}`)
    .sort()
    .join("|");
}

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
  // Background calls use the scheduler context so each gets its own policy refresh and shared lock.
  const detached = new AsyncResource("marketplace-background");
  const now = () => Date.now();

  let history: UpdateHistory = emptyUpdateHistory();
  let historyReset = false;
  let offered: PackageUpdateOffer[] = [];
  let candidates = new Map<string, UpdateCandidate>();
  /** Null until classification has read the policy and sources. */
  let context: AutoUpdateContext | null = null;
  const pendingApprovals = new Map<string, NonNullable<Extract<AppliedState, { state: "approval-pending" }>["pendingApproval"]>>();
  /** Null until the first discovery finishes. */
  let reached: ReadonlySet<string> | null = null;
  /** Only reached sources are classified; other offers retain stale prior state. */
  let shown: PackageUpdateView[] = [];
  let discovering: Promise<DiscoveryOutcome> | null = null;
  let applying: Promise<void> | null = null;
  let bootPass: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Stops scheduler effects and service stages together. */
  const shutdown = new AbortController();

  /** Every publication and external effect passes this gate.
     * Stopped in-flight work resolves to SchedulerStopped so continuations cannot act. */
  const gate = {
    get closed(): boolean {
      return shutdown.signal.aborted;
    },
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

  /** Queue state overrides recorded outcomes, which override classification. */
  const requiredNow = (key: PackageKeyView): boolean => {
    if (!context) throw new Error("required status asked for before the policy was read");
    return requiresPackage({ requiredInstalls: context.requiredInstalls }, key);
  };

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

  const appliedView = (id: string, record: PackageUpdateRecord): PackageUpdateView => {
    const pending = pendingApprovals.get(id);
    // Current policy keeps required-package attention states visible despite skipped versions.
    const required = requiredNow(parseUpdateRecordKey(id));
    return {
      key: parseUpdateRecordKey(id),
      displayName: record.displayName!,
      from: record.from!,
      to: record.to,
      state: record.state,
      ...(record.appliedAt ? { appliedAt: record.appliedAt } : {}),
      ...(record.commits ? { commitRange: record.commits } : {}),
      ...(record.state === "approval-pending" && pending ? { pendingApproval: pending } : {}),
      ...(required ? { required: true as const } : {}),
    };
  };

  /** Reclassify only reached sources; retain other offers as stale and append applied updates. */
  const classifyShown = () => {
    // Without current policy, preserve the view so a required update cannot be hidden as optional.
    if (!context) return;
    const settings = input.settings();
    const skipped = readSkippedPluginUpdates(settings.skippedPluginUpdates);
    const prior = new Map(shown.map((update) => [updateRecordKey(update.key), update]));
    const next: PackageUpdateView[] = [];
    const listed = new Set<string>();
    for (const [id, candidate] of candidates) {
      if (!reached?.has(candidate.key.sourceId)) continue;
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
      if (!before || before.to !== update.to) continue;
      // Cached version state stays stale, but required status follows current policy.
      const required = requiredNow(update.key);
      if (!required && isSkippedPackageUpdate(update, skipped)) continue;
      const { required: _was, autoUpdate: _switch, ...kept } = before;
      const source = context.sources.find((item) => item.id === update.key.sourceId) ?? null;
      next.push({
        ...kept,
        stale: true,
        ...(required || source ? { autoUpdate: resolvePackageSwitch(context.policy, settings, packageUpdateSkipKey(update.key), source, required) } : {}),
        ...(required ? { required: true as const } : {}),
      });
      listed.add(id);
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
      unmetRequired: context?.unmetRequired ?? [],
    };
  };

  /** Policy overrides the global switch; installed packages have switches even without an update. */
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
      packages: (context?.installed ?? []).flatMap((key) => {
        const source = byId.get(key.sourceId) ?? null;
        const required = requiredNow(key);
        // A source whose metadata cannot be read leaves an optional package without a switch, never a required one.
        return source || required ? [{ key, switch: resolvePackageSwitch(context!.policy, settings, packageUpdateSkipKey(key), source, required) }] : [];
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
    // Escalated waits bypass notice settings because only Apply now can resume them.
    const updates = status.packages.filter((update) => updateViewNeedsUser(update) && (notices || update.state !== "manual"));
    const key = updatesKey(updates);
    if (key === lastUpdates) return;
    gate.emit(() => input.publishUpdates(updates));
    lastUpdates = key;
    if (updates.length > 0) log.info(`marketplace updates available: ${updates.length}`);
  };

  /** Gate history changes and writes; a write already in flight finishes after stop. */
  const commit = async (change: () => void) => {
    try {
      await gate.work(async () => {
        change();
        try {
          await input.history.save(history);
        } catch (error) {
          // Retain times for the next write; failures after stop belong to shutdown.
          if (!gate.closed) log.warn(`marketplace updates.json could not be written: ${errorMessage(error)}`);
        }
      });
    } catch (error) {
      if (!(error instanceof SchedulerStopped)) throw error;
    }
  };

  // Serialize without joining so post-install reads see the completed install.
  let tail: Promise<void> = Promise.resolve();
  const computeOffers = (): Promise<PackageUpdateOffer[]> => {
    const run = tail.then(async () => {
      const service = await gate.work(() => input.service());
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
      // No source was reached, so cached offers remain stale rather than being reclassified.
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

  /** Recheck installed version and approval/runtime state; null if that version is gone. */
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
    // Replace queued work without interrupting the package already applying.
    queue.replace(queued);
    classifyShown();
    publish();
  };

  /** Uses current policy, switches, skips and failures to decide automatic eligibility. */
  const stillAutomatic = (id: string, facts: UpdateCandidate["facts"], policy: AutoUpdateContext["policy"]): boolean => {
    const settings = input.settings();
    const skipped = readSkippedPluginUpdates(settings.skippedPluginUpdates);
    const prior = history.packages[id];
    const memory = prior && prior.to === facts.to ? prior : null;
    const key = parseUpdateRecordKey(id);
    return classifyUpdate(facts, { policy, settings, memory, skipped: isSkippedPackageUpdate({ key, to: facts.to }, skipped) })?.state === "automatic";
  };

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
        await recheck();
        return;
      case "failed":
        record = { ...base, state: "failed", attempts: attempts + 1, lastError: failureRecord(outcome.error, iso(now())) };
        log.warn(`marketplace update of ${item.id} to ${candidate.to} failed (attempt ${attempts + 1}): ${errorMessage(outcome.error)}`);
        break;
      case "needs-review":
        // Consent deferral counts as neither a failure nor an attempt.
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

  /** Wake at least hourly; an apply check becoming due joins discovery already in flight. */
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
    if (gate.closed || bootPass) return;
    const at = now();
    if (!applying && at >= applyCheckDueAt(history)) void applyCheck();
    else if (!applying && !discovering && at >= discoveryDueAt(history.discovery, intervalMs())) void discover();
    arm();
  }

  const runBoot = (applyAtBoot: boolean): Promise<void> => {
    if (bootPass) return bootPass;
    const run = (async () => {
      gate.emit(() => input.publishStatus({ phase: "start" }));
      let applied: Promise<void> | null = null;
      const pass = async () => {
        const service = await gate.work(() => input.service());
        // Enforce persisted revocations before waiting for the network.
        await gate.work(() => service.enforceRevocations(gate.signal));
        const discovered = discover();
        // The boot's apply check joins this discovery instead of starting another.
        if (applyAtBoot) applied = applyCheck();
        const outcome = await discovered;
        // Expected source failures are sync results; throws indicate shutdown, unreadable state or bugs.
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
        // Clear the state only when every installed-generation component is approved.
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
