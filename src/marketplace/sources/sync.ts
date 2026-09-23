/**
 * Source sync (design §7.3, §7.5).
 *
 *   fetch the ref with --filter=blob:none (full commit history)
 *   candidate = fetched commit
 *   candidate == pin            → nothing to do (a lost snapshot is rebuilt)
 *   pin not an ancestor         → official, managed: keep pin, SOURCE_HISTORY_REWRITTEN
 *                                 custom, direct:    keep pin, record pendingRewrite for review
 *   snapshot at candidate fails → keep pin, record the code
 *   write snapshots/<candidate>.json, then move the pin in state.json, prune, notify
 *
 * The official source tries its primary URL and then each mirror; whichever
 * answers supplies the candidate, under the same history rule. Offline, the
 * snapshot at the pin keeps being served (`readSnapshot`); nothing falls back
 * to another source.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MarketplaceError, isMarketplaceError, type MarketplaceErrorCode } from "../errors.js";
import { BareRepo } from "../git/repo.js";
import type { GitRemote, GitRunner } from "../git/run-git.js";
import type { NetworkGate } from "../net/network-gate.js";
import type { ResolvedSource, SourceRegistry, SourceState } from "./registry.js";
import { SnapshotBuilder, type SourceSnapshot } from "./snapshot.js";

export interface SourceSyncOptions {
  registry: SourceRegistry;
  gate: NetworkGate;
  runner: GitRunner;
  /** `~/.ave/marketplaces`, the registry's root. */
  root: string;
  now?: () => Date;
  /** Commits that installed packages from this source still reference (`origin.commit`); never pruned. */
  retainedCommits: (sourceId: string) => Promise<ReadonlySet<string>>;
  /** Called after a source's pin moved. */
  onCatalogChanged?: (sourceId: string) => void;
}

export type SyncResult =
  | { status: "ok"; pinnedCommit: string; changed: boolean }
  | { status: "failed"; code: MarketplaceErrorCode; message: string; pinnedCommit: string | null };

const SNAPSHOT_FILE = /^[0-9a-f]{40}\.json$/u;
const CANDIDATE_REF = "candidate";

/** A source syncs while it is shown, or while an installed package is still bound to it (§7.3). */
export function shouldSyncSource(registry: SourceRegistry, source: ResolvedSource, state: SourceState, hasInstalledPackages: boolean): boolean {
  return registry.isEnabled(source, state) || hasInstalledPackages;
}

interface JoinedSync {
  promise: Promise<SyncResult>;
  controller: AbortController;
  /** Callers still waiting for this run. */
  waiting: number;
}

export class SourceSyncer {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly inflight = new Map<string, JoinedSync>();

  constructor(private readonly options: SourceSyncOptions) {}

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private sourceDir(id: string): string {
    return join(this.options.root, id);
  }

  private snapshotPath(id: string, commit: string): string {
    return join(this.sourceDir(id), "snapshots", `${commit}.json`);
  }

  /** One operation per source at a time; different sources run in parallel. */
  private withSourceLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return next;
  }

  private source(id: string): ResolvedSource {
    const source = this.options.registry.get(id);
    if (!source) throw new Error(`no source named ${id}`);
    return source;
  }

  private async openRepo(id: string): Promise<BareRepo> {
    const dir = join(this.sourceDir(id), "repo.git");
    if (existsSync(join(dir, "HEAD"))) return new BareRepo(this.options.runner, dir);
    return BareRepo.init(this.options.runner, dir);
  }

  private async remoteFor(source: ResolvedSource, url = source.url): Promise<GitRemote> {
    const { allowHttp } = await this.options.gate.checkRemote(url, { official: source.origin === "official" });
    // A mirror on another host never gets the primary host's token.
    const useToken = source.auth.kind === "token" && source.auth.host === url.host;
    return { url, sourceId: source.id, allowHttp, useToken };
  }

  /** Primary URL, then each mirror; the first to answer supplies the candidate. */
  private async fetchCandidate(repo: BareRepo, source: ResolvedSource, signal?: AbortSignal): Promise<{ candidate: string; remote: GitRemote }> {
    let firstError: MarketplaceError | null = null;
    for (const url of [source.url, ...source.mirrors]) {
      try {
        const remote = await this.remoteFor(source, url);
        return { candidate: await repo.fetchRef(remote, source.ref, CANDIDATE_REF, signal), remote };
      } catch (error) {
        if (!isMarketplaceError(error)) throw error;
        firstError ??= error;
      }
    }
    throw firstError ?? new Error(`source ${source.id} has no URL`);
  }

  private async recordFailure(source: ResolvedSource, code: MarketplaceErrorCode, message: string, candidate?: string): Promise<SyncResult> {
    const state = await this.options.registry.updateState(source.id, (current) => ({
      ...current,
      lastSync: { at: this.now(), result: code, ...(candidate ? { candidate } : {}) },
    }));
    return { status: "failed", code, message, pinnedCommit: state.pinnedCommit };
  }

  /** Build and write the snapshot at `commit`, then move the pin there. */
  private async publish(
    repo: BareRepo,
    remote: GitRemote,
    source: ResolvedSource,
    commit: string,
    previousPin: string | null,
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    const built = await new SnapshotBuilder(repo, remote, source, commit, signal).build(this.now());
    if (!built.ok) return this.recordFailure(source, built.code, built.message, commit);
    await writeFileAtomicAtPath(this.snapshotPath(source.id, commit), `${JSON.stringify(built.snapshot)}\n`);
    await this.options.registry.updateState(source.id, (current) => {
      const { pendingRewrite: _cleared, ...rest } = current;
      return { ...rest, pinnedCommit: commit, lastSync: { at: this.now(), result: "ok" } };
    });
    await this.prune(source.id, commit, previousPin);
    if (commit !== previousPin) this.options.onCatalogChanged?.(source.id);
    return { status: "ok", pinnedCommit: commit, changed: commit !== previousPin };
  }

  /** Keep the pin, the previous pin and every commit an installed package still references. */
  private async prune(id: string, pin: string, previousPin: string | null): Promise<void> {
    const keep = new Set([pin, ...(previousPin ? [previousPin] : []), ...(await this.options.retainedCommits(id))]);
    const dir = join(this.sourceDir(id), "snapshots");
    for (const name of await readdir(dir)) {
      if (SNAPSHOT_FILE.test(name) && !keep.has(name.slice(0, 40))) await rm(join(dir, name), { force: true });
    }
  }

  private async run(id: string, signal?: AbortSignal): Promise<SyncResult> {
    const source = this.source(id);
    // Written before the repository exists, so a state file that goes missing
    // later is noticed instead of read as a fresh, unpinned source.
    const state = await this.options.registry.updateState(id, (current) => current);
    const pin = state.pinnedCommit;
    const repo = await this.openRepo(id);

    let fetched: { candidate: string; remote: GitRemote };
    try {
      fetched = await this.fetchCandidate(repo, source, signal);
    } catch (error) {
      if (!isMarketplaceError(error)) throw error;
      return this.recordFailure(source, error.code, error.message);
    }
    const { candidate, remote } = fetched;

    if (candidate === pin) {
      if (existsSync(this.snapshotPath(id, pin))) {
        await this.options.registry.updateState(id, (current) => {
          const { pendingRewrite: _cleared, ...rest } = current;
          return { ...rest, lastSync: { at: this.now(), result: "ok" } };
        });
        return { status: "ok", pinnedCommit: pin, changed: false };
      }
      return this.publish(repo, remote, source, pin, pin, signal);
    }

    if (pin !== null && !((await repo.hasCommit(pin)) && (await repo.isAncestor(pin, candidate)))) {
      const message = `${candidate} does not descend from the pinned ${pin}`;
      if (source.origin === "official" || source.origin === "managed") {
        return this.recordFailure(source, "SOURCE_HISTORY_REWRITTEN", message, candidate);
      }
      const updated = await this.options.registry.updateState(id, (current) => ({
        ...current,
        pendingRewrite:
          current.pendingRewrite?.candidate === candidate ? current.pendingRewrite : { candidate, seenAt: this.now() },
        lastSync: { at: this.now(), result: "SOURCE_HISTORY_REWRITTEN", candidate },
      }));
      return { status: "failed", code: "SOURCE_HISTORY_REWRITTEN", message, pinnedCommit: updated.pinnedCommit };
    }

    return this.publish(repo, remote, source, candidate, pin, signal);
  }

  /**
   * Sync one source; a second call while one runs joins it. The shared run
   * stops only when every caller that joined it has aborted: a caller without
   * a signal keeps it going.
   */
  sync(id: string, signal?: AbortSignal): Promise<SyncResult> {
    let joined = this.inflight.get(id);
    // A run every caller abandoned is only winding down; a new caller starts
    // its own, queued behind it on the source lock.
    if (!joined || joined.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = this.withSourceLock(id, () => this.run(id, controller.signal)).finally(() => {
        if (this.inflight.get(id) === entry) this.inflight.delete(id);
      });
      const entry: JoinedSync = { promise, controller, waiting: 0 };
      this.inflight.set(id, entry);
      joined = entry;
    }
    const entry = joined;
    entry.waiting += 1;
    if (signal) {
      const leave = () => {
        entry.waiting -= 1;
        if (entry.waiting === 0) entry.controller.abort(signal.reason);
      };
      if (signal.aborted) {
        leave();
      } else {
        signal.addEventListener("abort", leave, { once: true });
        void entry.promise.then(
          () => signal.removeEventListener("abort", leave),
          () => signal.removeEventListener("abort", leave),
        );
      }
    }
    return entry.promise;
  }

  /**
   * The user accepted the rewritten history they reviewed (custom and direct
   * sources only, §7.3). `candidate` must still be the pending one; a sync
   * that saw a newer candidate in between expires the review.
   */
  acceptRewrite(id: string, candidate: string, signal?: AbortSignal): Promise<SyncResult> {
    return this.withSourceLock(id, async () => {
      const source = this.source(id);
      if (source.origin !== "custom" && source.origin !== "direct") {
        throw new Error(`the ${source.origin} source ${id} never accepts rewritten history`);
      }
      const state = await this.options.registry.readState(id);
      const repo = await this.openRepo(id);
      if (state.pendingRewrite?.candidate !== candidate || !(await repo.hasCommit(candidate))) {
        throw new MarketplaceError("PLAN_EXPIRED", `the reviewed history ${candidate} is no longer pending for ${id}`);
      }
      let remote: GitRemote;
      try {
        remote = await this.remoteFor(source);
      } catch (error) {
        if (!isMarketplaceError(error)) throw error;
        return this.recordFailure(source, error.code, error.message, candidate);
      }
      return this.publish(repo, remote, source, candidate, state.pinnedCommit, signal);
    });
  }

  /**
   * Run `fn` with the source's repository and a gated remote for its primary
   * URL, under the source lock: an install reads at the commits its plan was
   * bound to, and no sync or removal of the source runs meanwhile. A hidden
   * source syncs for the packages bound to it, but installs and updates from
   * it are refused with SOURCE_DISABLED until it is shown again (§14).
   */
  withRepository<T>(id: string, fn: (context: { source: ResolvedSource; repo: BareRepo; remote: GitRemote }) => Promise<T>): Promise<T> {
    return this.withSourceLock(id, async () => {
      const source = this.source(id);
      if (!this.options.registry.isEnabled(source, await this.options.registry.readState(id))) {
        throw new MarketplaceError("SOURCE_DISABLED", `source ${id} is hidden; show it again to install or update from it`);
      }
      const dir = join(this.sourceDir(id), "repo.git");
      if (!existsSync(join(dir, "HEAD"))) throw new Error(`source ${id} has not been synced`);
      return fn({ source, repo: new BareRepo(this.options.runner, dir), remote: await this.remoteFor(source) });
    });
  }

  /** Remove a custom or direct source once any running sync or accept of it has finished. */
  removeSource(id: string): Promise<void> {
    return this.withSourceLock(id, () => this.options.registry.remove(id));
  }

  /** The snapshot at the pin, or null before the first successful sync. Served offline as is (§7.5). */
  async readSnapshot(id: string): Promise<SourceSnapshot | null> {
    const { pinnedCommit } = await this.options.registry.readState(id);
    if (pinnedCommit === null) return null;
    let text: string;
    try {
      text = await readFile(this.snapshotPath(id, pinnedCommit), "utf8");
    } catch (error) {
      // The next sync rebuilds a lost snapshot at the same pin.
      if (isMissingPathError(error)) return null;
      throw error;
    }
    const snapshot = parseStrictJson(text) as SourceSnapshot;
    if (snapshot.sourceId !== id || snapshot.commit !== pinnedCommit) {
      throw new Error(`snapshot ${pinnedCommit}.json of ${id} names ${snapshot.sourceId}@${snapshot.commit}`);
    }
    return snapshot;
  }
}
