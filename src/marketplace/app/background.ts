/**
 * The git marketplace's work outside a request (design §7.3, §10.2).
 *
 * Once the window has loaded: enforce the revocations already on disk, sync
 * every source, apply the default and required installs, and publish what
 * they did — the notice (§15.1) and the status the boot pill shows, whose
 * Retry runs the same pass again. Then every
 * `marketplace.updateCheckIntervalMs` sync again and tell the renderer which
 * installed packages have updates. The periodic sync runs whether or not
 * update notices are on: revocations reach installed packages through it, and
 * what they removed since the last notice is published as a notice.
 */
import { AsyncResource } from "node:async_hooks";
import type { AppBootstrapStatus } from "../../shared/bootstrap-status.js";
import { errorMessage } from "../../shared/error-message.js";
import type { BootInstallNoticeView, PackageUpdateView } from "../../shared/git-marketplace.js";
import { isSkippedPackageUpdate, readSkippedPluginUpdates } from "../../shared/skipped-plugin-updates.js";
import type { AppliedDefaults } from "../boot-installs/applied.js";
import { packageKeyId } from "../boot-installs/default-installs.js";
import type { BootInstallReport } from "../boot-installs/run.js";
import type { PackageKey } from "../sources/policy.js";

/** The code default (§7.3): a tick fetches every source. */
export const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A stored interval below this is raised to it when read (§7.3). */
export const MIN_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/** The periodic sync interval: unset → 6 hours, `0` → none, below 15 minutes → 15 minutes. */
export function syncIntervalMs(stored: number | undefined): number {
  if (stored === undefined || !Number.isFinite(stored) || stored < 0) return DEFAULT_SYNC_INTERVAL_MS;
  if (stored === 0) return 0;
  return Math.max(stored, MIN_SYNC_INTERVAL_MS);
}

export interface BackgroundService {
  enforceRevocations(): Promise<void>;
  takeRevocationNotice(): BootInstallNoticeView | null;
  refresh(): Promise<unknown>;
  updates(): Promise<PackageUpdateView[]>;
  applyBootInstalls(defaults: readonly PackageKey[], applied: AppliedDefaults): Promise<{ report: BootInstallReport; notice: BootInstallNoticeView | null }>;
}

export interface MarketplaceBackgroundInput {
  service(): Promise<BackgroundService>;
  appliedDefaults(): Promise<AppliedDefaults>;
  defaults: readonly PackageKey[];
  /** Read at each check; the interval is read again on `settingsChanged`. */
  settings(): { updateNotices: boolean; updateCheckIntervalMs?: number; skippedPluginUpdates?: unknown };
  publishStatus(status: AppBootstrapStatus): void;
  publishNotice(notice: BootInstallNoticeView): void;
  publishUpdates(updates: PackageUpdateView[]): void;
  log: { info(message: string): void; warn(message: string): void };
  setInterval?: (run: () => void, ms: number) => { unref?(): void };
  clearInterval?: (timer: { unref?(): void }) => void;
}

export interface MarketplaceBackground {
  /** The boot pass and the first update check; resolves when both are done. */
  readonly started: Promise<void>;
  /** Sync and apply the boot installs again (the status pill's Retry). Joins a pass in flight. */
  retryBootInstalls(): Promise<void>;
  /** Recompute the updates without syncing: an install, uninstall or sync changed what is installed or offered. */
  recheck(): Promise<void>;
  /**
   * `marketplace` settings were written: the tick moves to a changed
   * interval, and the updates are recomputed under the new notice and skip
   * settings (after any check in flight).
   */
  settingsChanged(): Promise<void>;
  stop(): void;
}

function statusFrom(report: BootInstallReport): AppBootstrapStatus {
  return {
    phase: "complete",
    installed: [...report.installed, ...report.updated, ...report.switched].map((key) => key.name),
    failed: report.failed.map((item) => ({ id: item.key.name, error: item.message })),
  };
}

function describe(keys: readonly PackageKey[]): string {
  return keys.map(packageKeyId).join(", ");
}

function updatesKey(updates: readonly PackageUpdateView[]): string {
  return updates
    .map((update) => `${update.key.sourceId}/${update.key.kind}/${update.key.name}@${update.from}->${update.to}`)
    .sort()
    .join("|");
}

export function startMarketplaceBackground(input: MarketplaceBackgroundInput): MarketplaceBackground {
  const { log } = input;
  // Background work is never part of the operation that asked for it (§18.6). A recheck can be asked
  // for from inside a marketplace operation (a sync that published a snapshot, an install), and work
  // started there would carry that operation's async context: its service calls would join an operation
  // that may already be ending, without their own policy refresh or shared lock. Every entry below runs
  // in the context the scheduler started in, so each service call is an operation of its own.
  const detached = new AsyncResource("marketplace-background");

  let bootPass: Promise<void> | null = null;
  const bootInstalls = (): Promise<void> => {
    bootPass ??= detached.runInAsyncScope(async () => {
      input.publishStatus({ phase: "start" });
      try {
        const service = await input.service();
        // A revocation the last session synced acts now, not after the network answers.
        await service.enforceRevocations();
        // A source that fails to sync reports it in its status; a throw here is an unreadable file or a bug.
        await service.refresh();
        const { report, notice } = await service.applyBootInstalls(input.defaults, await input.appliedDefaults());
        const moved = [...report.installed, ...report.updated, ...report.switched];
        if (moved.length > 0) log.info(`marketplace boot installs: ${describe(moved)}`);
        if (report.failed.length > 0) {
          log.warn(`marketplace boot installs failed: ${report.failed.map((item) => `${packageKeyId(item.key)}: ${item.message}`).join("; ")}`);
        }
        if (notice) input.publishNotice(notice);
        input.publishStatus(statusFrom(report));
      } catch (error) {
        log.warn(`marketplace boot pass failed: ${errorMessage(error)}`);
        input.publishStatus({ phase: "error", message: errorMessage(error) });
      }
    }).finally(() => {
      bootPass = null;
    });
    return bootPass;
  };

  // Checks run one after another, never joined: a check asked for after an
  // install must read what the install left. Only a successful check moves the
  // published list, and an unchanged list is not sent again — the renderer
  // starts from none, so an empty first list is not sent either.
  let lastPublished = updatesKey([]);
  let tail: Promise<void> = Promise.resolve();
  const checkUpdates = (sync: boolean): Promise<void> => {
    tail = detached.runInAsyncScope(() => tail.then(async () => {
      try {
        const service = await input.service();
        if (sync) await service.refresh();
        // What a sync's revocations removed since the last notice, this tick's or one the user ran.
        const revoked = service.takeRevocationNotice();
        if (revoked) input.publishNotice(revoked);
        const settings = input.settings();
        // Notices off: the list the renderer holds is cleared, and nothing is looked up.
        const skipped = readSkippedPluginUpdates(settings.skippedPluginUpdates);
        const updates = settings.updateNotices
          ? (await service.updates()).filter((update) => !isSkippedPackageUpdate(update, skipped))
          : [];
        const key = updatesKey(updates);
        if (key === lastPublished) return;
        input.publishUpdates(updates);
        lastPublished = key;
        if (updates.length > 0) log.info(`marketplace updates available: ${updates.length}`);
      } catch (error) {
        log.warn(`marketplace update check failed; the last list stays: ${errorMessage(error)}`);
      }
    }));
    return tail;
  };

  const started = bootInstalls().then(() => checkUpdates(false));

  const setTimer = input.setInterval ?? ((run, ms) => setInterval(run, ms));
  const clearTimer = input.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  let interval = 0;
  let timer: { unref?(): void } | null = null;
  let stopped = false;
  // (Re)schedule the tick for the stored interval; an unchanged interval keeps the running timer.
  const schedule = () => {
    const next = syncIntervalMs(input.settings().updateCheckIntervalMs);
    if (stopped || next === interval) return;
    if (timer) clearTimer(timer);
    interval = next;
    timer = next > 0 ? setTimer(() => void checkUpdates(true), next) : null;
    timer?.unref?.();
  };
  schedule();

  return {
    started,
    retryBootInstalls: async () => {
      await bootInstalls();
      await checkUpdates(false);
    },
    recheck: () => checkUpdates(false),
    settingsChanged: () => {
      schedule();
      return checkUpdates(false);
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
