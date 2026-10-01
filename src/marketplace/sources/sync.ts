/**
 * Source sync (design §7.3, §7.5).
 *
 *   fetch the ref with --filter=blob:none (full commit history)
 *   candidate = fetched commit
 *   candidate == pin            → nothing to do if the cached snapshot is current and valid
 *   pin not an ancestor         → official, managed: keep pin, SOURCE_HISTORY_REWRITTEN
 *                                 custom, direct:    keep pin, record pendingRewrite for review
 *   snapshot at candidate fails → keep pin, record the code
 *   write snapshots/<candidate>.json, then move the pin in state.json, prune, notify
 *
 * The official source tries its primary URL and then each mirror; whichever
 * answers supplies the candidate, under the same history rule. Offline, the
 * snapshot at the pin keeps being served (`readSnapshot`); nothing falls back
 * to another source.
 *
 * A folder source (§18.4) is read in place instead, and no git command runs
 * against it (§18.3 #6): stages 2–4 again from the stored path (a drive
 * remapped to a share, or a component replaced by a link, is caught before
 * the read), the snapshot built over a `FolderTree`, and its revision
 * `local-<sha256>` as the pin. There is no history rule: every read is the
 * folder's current state. A read that fails keeps the last good snapshot
 * served, and the next read tries again.
 */
import { validateCachedSnapshotText } from "../catalog/validate.js";
import { effectiveRevocations } from "../catalog/effective-revocations.js";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MarketplaceError, isMarketplaceError, scrubMarketplaceErrorDetail, type MarketplaceErrorCode, type MarketplaceErrorDetail } from "../errors.js";
import { BareRepo, type ExportLimits } from "../git/repo.js";
import { LocalRepositoryDamagedError, type GitCommands, type GitRemote } from "../git/run-git.js";
import type { NetworkGate } from "../net/network-gate.js";
import { classifyFolder, folderMoved, resolveFolderRoot } from "../net/source-input.js";
import { errorMessage } from "../../shared/error-message.js";
import type { PackageKind } from "../catalog/types.js";
import type { FolderFs } from "./folder-fs.js";
import { FolderTree, type FolderCapture } from "./folder-tree.js";
import { folderIdentityState, fsErrorCode, readSourceState, type FolderSource, type GitSource, type ResolvedSource, type SourceRegistry, type SourceState } from "./registry.js";
import { pinnedArtifactSha256s, SnapshotBuilder, type SnapshotSubject, type SourceSnapshot } from "./snapshot.js";
import { GitTree, rootNameOf } from "./source-tree.js";

export interface SourceSyncOptions {
  registry: SourceRegistry;
  gate: NetworkGate;
  runner: GitCommands;
  /** `~/.ave/marketplaces`, the registry's root. */
  root: string;
  now?: () => Date;
  /** Commits that installed packages from this source still reference (`origin.commit`); never pruned. */
  retainedCommits: (sourceId: string) => Promise<ReadonlySet<string>>;
  /** Called after a snapshot is published, including a same-pin rebuild. */
  onCatalogChanged?: (sourceId: string) => void;
  /**
   * How folder sources are read (§18.4.5): every filesystem call through
   * `fs`, paths read for `platform`, and the ceiling on one package's files
   * and bytes (§5.4).
   */
  folders: { fs: FolderFs; platform: NodeJS.Platform; limits: ExportLimits };
}

export type SyncResult =
  | { status: "ok"; pinnedCommit: string; changed: boolean }
  /** `detail` says why when the failure did (design §18.8); it is persisted with the code. */
  | { status: "failed"; code: MarketplaceErrorCode; message: string; detail?: MarketplaceErrorDetail; pinnedCommit: string | null };

/** A snapshot is named by its pin: a commit, or a folder's revision (§18.4.3). */
const SNAPSHOT_FILE = /^(?:[0-9a-f]{40}|local-[0-9a-f]{64})\.json$/u;
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

  /** The gate's verdict for one of the source's URLs, under the confirmations the source holds (§18.5). */
  private async remoteFor(source: GitSource, url = source.url): Promise<GitRemote> {
    const acknowledged = await this.options.registry.acknowledged(source);
    const verdict = this.options.gate.checkRemote(url, { official: source.origin === "official", acknowledged });
    // A mirror on another host never gets the primary host's token.
    const useToken = source.auth.kind === "token" && source.auth.host === url.host;
    return { url, sourceId: source.id, useToken, ...verdict };
  }

  /** Primary URL, then each mirror; the first to answer supplies the candidate. */
  private async fetchCandidate(repo: BareRepo, source: GitSource, signal?: AbortSignal): Promise<{ candidate: string; remote: GitRemote }> {
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

  /**
   * Record a failed sync in the source's state. The detail is stored with the
   * code, because a background failure reaches the Sources view through
   * `sources:list`, never through a failed answer (design §18.8).
   */
  private async recordFailure(
    source: ResolvedSource,
    failure: { code: MarketplaceErrorCode; message: string; detail?: MarketplaceErrorDetail | undefined },
    candidate?: string,
  ): Promise<SyncResult> {
    const { code, message } = failure;
    // Stored and returned scrubbed: a detail's text can quote a credential (design §14).
    const detail = failure.detail && scrubMarketplaceErrorDetail(code, failure.detail);
    const state = await this.options.registry.updateState(source.id, (current) => ({
      ...current,
      lastSync: { at: this.now(), result: code, ...(detail ? { detail } : {}), ...(candidate ? { candidate } : {}) },
    }));
    return { status: "failed", code, message, ...(detail ? { detail } : {}), pinnedCommit: state.pinnedCommit };
  }

  /** Build and write the snapshot at `commit`, then move the pin there. */
  private async publish(
    repo: BareRepo,
    remote: GitRemote,
    source: GitSource,
    commit: string,
    previousPin: string | null,
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    const subject: SnapshotSubject = {
      id: source.id,
      origin: source.origin,
      ...(source.label !== undefined ? { label: source.label } : {}),
      ...(source.subdir !== undefined ? { subdir: source.subdir } : {}),
      rootName: rootNameOf(remote.url.path),
    };
    const built = await new SnapshotBuilder(new GitTree(repo, remote, commit, signal), subject).build(this.now());
    if (!built.ok) return this.recordFailure(source, built, commit);
    await writeFileAtomicAtPath(this.snapshotPath(source.id, commit), `${JSON.stringify(built.snapshot)}\n`);
    await this.options.registry.updateState(source.id, (current) => {
      const { pendingRewrite: _cleared, ...rest } = current;
      return { ...rest, pinnedCommit: commit, lastSync: { at: this.now(), result: "ok" } };
    });
    await this.prune(source.id, commit, previousPin);
    this.options.onCatalogChanged?.(source.id);
    return { status: "ok", pinnedCommit: commit, changed: true };
  }

  /**
   * Stages 2–4 of §18.4.1 for a stored folder, before anything reads it:
   * network classification, the policy and `network-folder`, then the walk,
   * fenced as the read is: a path on another computer without the
   * confirmation is never touched. A walk that ends at another path, or at a
   * directory whose recorded identity differs, is `moved`, and the new
   * target is never read (§18.4.4). The canonical path is judged by the
   * policy again.
   */
  private async openFolder(source: FolderSource, state: SourceState): Promise<FolderTree> {
    const { fs, platform, limits } = this.options.folders;
    this.options.gate.checkFolderPolicy(source.path);
    const network = await classifyFolder(source.path, platform, fs);
    const acknowledged = await this.options.registry.acknowledged(source);
    this.options.gate.checkFolder(source.path, network, acknowledged);
    const networkConsented = acknowledged.has("network-folder");
    const root = await resolveFolderRoot(source.path, platform, fs, networkConsented);
    if (root.path !== source.path) throw folderMoved(source.path, root.path);
    const recorded = state.folder;
    const known = recorded !== undefined && recorded.dev !== "0" && recorded.ino !== "0" && root.dev !== 0n && root.ino !== 0n;
    if (known && (recorded.dev !== root.dev.toString() || recorded.ino !== root.ino.toString())) throw folderMoved(source.path, root.path);
    this.options.gate.checkFolderPolicy(root.path);
    return new FolderTree({ fs, platform, root, readAt: this.now(), limits, networkConsented });
  }

  /**
   * One read of a folder source: the snapshot over its current files, written
   * and pinned when its revision is new (or its snapshot is gone), and the
   * folder's identity recorded. The tree is returned so a plan captures from
   * the same read (§18.4.2).
   */
  private async readFolder(source: FolderSource, signal?: AbortSignal): Promise<{ result: SyncResult; tree: FolderTree | null; snapshot: SourceSnapshot | null }> {
    const state = await this.options.registry.updateState(source.id, (current) => current);
    const pin = state.pinnedCommit;
    let tree: FolderTree;
    try {
      tree = await this.openFolder(source, state);
    } catch (error) {
      if (!isMarketplaceError(error)) throw error;
      return { result: await this.recordFailure(source, error), tree: null, snapshot: null };
    }
    signal?.throwIfAborted();
    const subject: SnapshotSubject = {
      id: source.id,
      origin: source.origin,
      ...(source.label !== undefined ? { label: source.label } : {}),
      rootName: rootNameOf(tree.root.path),
    };
    const built = await new SnapshotBuilder(tree, subject).build(this.now());
    if (!built.ok) return { result: await this.recordFailure(source, built), tree: null, snapshot: null };
    signal?.throwIfAborted();
    const revision = built.snapshot.commit;
    const identity = folderIdentityState(tree.root);
    const reusable = revision === pin && (await this.hasReusableSnapshot(source.id, revision));
    if (!reusable) await writeFileAtomicAtPath(this.snapshotPath(source.id, revision), `${JSON.stringify(built.snapshot)}\n`);
    await this.options.registry.updateState(source.id, (current) => ({ ...current, pinnedCommit: revision, folder: identity, lastSync: { at: this.now(), result: "ok" } }));
    if (reusable) return { result: { status: "ok", pinnedCommit: revision, changed: false }, tree, snapshot: built.snapshot };
    await this.prune(source.id, revision, pin);
    this.options.onCatalogChanged?.(source.id);
    return { result: { status: "ok", pinnedCommit: revision, changed: true }, tree, snapshot: built.snapshot };
  }

  /** Keep the pin, the previous pin and every commit an installed package still references. */
  private async prune(id: string, pin: string, previousPin: string | null): Promise<void> {
    const keep = new Set([pin, ...(previousPin ? [previousPin] : []), ...(await this.options.retainedCommits(id))]);
    const dir = join(this.sourceDir(id), "snapshots");
    for (const name of await readdir(dir)) {
      if (SNAPSHOT_FILE.test(name) && !keep.has(name.slice(0, -".json".length))) await rm(join(dir, name), { force: true });
    }
  }

  private async hasReusableSnapshot(id: string, commit: string): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.snapshotPath(id, commit), "utf8");
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
    const validated = validateCachedSnapshotText(text);
    return validated.ok && validated.value.sourceId === id && validated.value.commit === commit;
  }

  /**
   * One sync. A source repository git cannot open (a copy half removed by an
   * interrupted walk of an older build) is the sync's result as
   * SOURCE_LOCAL_DATA_DAMAGED `repository-damaged`, which the row offers
   * Repair for, never a network failure.
   */
  private async run(id: string, signal?: AbortSignal): Promise<SyncResult> {
    try {
      return await this.runOnce(id, signal);
    } catch (error) {
      if (!(error instanceof LocalRepositoryDamagedError)) throw error;
      return this.recordFailure(this.source(id), repositoryDamaged(id, error));
    }
  }

  private async runOnce(id: string, signal?: AbortSignal): Promise<SyncResult> {
    const source = this.source(id);
    if (source.transport === "folder") return (await this.readFolder(source, signal)).result;
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
      return this.recordFailure(source, error);
    }
    const { candidate, remote } = fetched;

    if (candidate === pin) {
      if (await this.hasReusableSnapshot(id, pin)) {
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
        return this.recordFailure(source, { code: "SOURCE_HISTORY_REWRITTEN", message }, candidate);
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
      // A folder has no history rule (§18.4.3): nothing is ever pending for it.
      if (source.transport === "folder") throw new MarketplaceError("PLAN_EXPIRED", `the folder source ${id} has no rewritten history to accept`);
      const state = await this.options.registry.readState(id);
      try {
        const repo = await this.openRepo(id);
        if (state.pendingRewrite?.candidate !== candidate || !(await repo.hasCommit(candidate))) {
          throw new MarketplaceError("PLAN_EXPIRED", `the reviewed history ${candidate} is no longer pending for ${id}`);
        }
        let remote: GitRemote;
        try {
          remote = await this.remoteFor(source);
        } catch (error) {
          if (!isMarketplaceError(error)) throw error;
          return await this.recordFailure(source, error, candidate);
        }
        return await this.publish(repo, remote, source, candidate, state.pinnedCommit, signal);
      } catch (error) {
        // Like a sync and an install: a repository git cannot open is the damaged copy Repair clears, never a raw path.
        if (error instanceof LocalRepositoryDamagedError) throw repositoryDamaged(id, error);
        throw error;
      }
    });
  }

  /**
   * Run `fn` with the source's repository and a gated remote for its primary
   * URL, under the source lock: an install reads at the commits its plan was
   * bound to, and no sync or removal of the source runs meanwhile. A hidden
   * source syncs for the packages bound to it, but installs and updates from
   * it are refused with SOURCE_DISABLED until it is shown again (§14).
   */
  withRepository<T>(id: string, fn: (context: { source: GitSource; repo: BareRepo; remote: GitRemote }) => Promise<T>): Promise<T> {
    return this.withSourceLock(id, async () => {
      const source = this.source(id);
      if (source.transport !== "git") throw new Error(`source ${id} is a folder; it has no repository`);
      if (!this.options.registry.isEnabled(source, await this.options.registry.readState(id))) {
        throw new MarketplaceError("SOURCE_DISABLED", `source ${id} is hidden; show it again to install or update from it`);
      }
      const dir = join(this.sourceDir(id), "repo.git");
      if (!existsSync(join(dir, "HEAD"))) throw new Error(`source ${id} has not been synced`);
      try {
        return await fn({ source, repo: new BareRepo(this.options.runner, dir), remote: await this.remoteFor(source) });
      } catch (error) {
        if (error instanceof LocalRepositoryDamagedError) throw repositoryDamaged(id, error);
        throw error;
      }
    });
  }

  /**
   * Capture one package of a folder source for an install plan (§18.4.2),
   * under the source lock: the folder is read again (stages 2–4, a fresh
   * snapshot, published when its revision is new), then the package's files
   * are copied from that same read into `dest`. The copy's tree digest must
   * be the one the snapshot recorded, so a package that changed during the
   * read is never captured. A read that fails is recorded on the source and
   * thrown. Execution installs the copy and never reads the folder again.
   */
  captureFolderPackage(
    id: string,
    wanted: { kind: PackageKind; name: string },
    dest: string,
  ): Promise<{ source: FolderSource; snapshot: SourceSnapshot; capture: FolderCapture; path: string }> {
    return this.withSourceLock(id, async () => {
      const source = this.source(id);
      if (source.transport !== "folder") throw new Error(`source ${id} is not a folder`);
      if (!this.options.registry.isEnabled(source, await this.options.registry.readState(id))) {
        throw new MarketplaceError("SOURCE_DISABLED", `source ${id} is hidden; show it again to install or update from it`);
      }
      const read = await this.readFolder(source);
      if (read.result.status === "failed") {
        const { code, message, detail } = read.result;
        throw new MarketplaceError(code, message, detail ? { detail } : undefined);
      }
      const { tree, snapshot } = read;
      if (!tree || !snapshot) throw new Error(`folder source ${id} was read without a tree`);
      const pkg = snapshot.packages.find((item) => item.kind === wanted.kind && item.name === wanted.name);
      if (!pkg) throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `${id} no longer lists ${wanted.kind} ${wanted.name}`);
      if (pkg.treeSha256 === undefined) throw new Error(`folder package ${wanted.name} of ${id} has no tree digest`);
      const capture = await tree.capture(pkg.path, pkg.kind, dest);
      if (capture.treeSha256 !== pkg.treeSha256) {
        throw new MarketplaceError("SOURCE_LOCAL_UNREADABLE", `${pkg.path || "the folder"} changed while it was read`, {
          detail: { reason: "changed-during-read", path: source.path },
        });
      }
      return { source, snapshot, capture, path: pkg.path };
    });
  }

  /**
   * Repair (design §18.8): move the source's downloaded copy aside once any
   * running sync, accept or install from it has finished; the caller syncs
   * it next. A state that still reads keeps its pin and switch; one that
   * does not starts the source unpinned, which the row's sentence warns
   * about. Its failures are SOURCE_LOCAL_DATA_DAMAGED `repair-failed` or
   * `repair-write-failed` ({@link SourceRegistry.resetLocalData}).
   */
  resetLocalData(id: string): Promise<void> {
    return this.withSourceLock(id, async () => {
      this.source(id);
      let kept: SourceState | null = null;
      try {
        kept = await this.options.registry.readState(id);
      } catch (error) {
        if (!isMarketplaceError(error) || error.code !== "SOURCE_LOCAL_DATA_DAMAGED") throw error;
      }
      await this.options.registry.resetLocalData(id, kept);
    });
  }

  /** Remove a custom or direct source once any running sync or accept of it has finished. */
  removeSource(id: string): Promise<void> {
    return this.withSourceLock(id, () => this.options.registry.remove(id));
  }

  /** The snapshot at the pin, or null before the first successful sync. Served offline as is (§7.5). */
  async readSnapshot(id: string): Promise<SourceSnapshot | null> {
    return readPinnedSnapshot(this.options.root, id);
  }

  /** The revocations at the pin, for the revocation feed ({@link readPinnedRevocations}). */
  readRevocations(id: string, appVersion: string): Promise<SourceSnapshot["revocations"]> {
    return readPinnedRevocations(this.options.root, id, appVersion);
  }
}

/** A source repository git cannot open, as the damaged copy Repair clears; the message names no path. */
function repositoryDamaged(id: string, error: LocalRepositoryDamagedError): MarketplaceError {
  return new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", `repo.git of source ${id} is not a repository git can open`, {
    cause: error,
    detail: { reason: "repository-damaged", sourceId: id },
  });
}

/**
 * The snapshot at a source's pin under `root` (`~/.ave/marketplaces`), or
 * null before the first successful sync. Boot reads it before the syncer
 * exists, to feed revocations to the plugin load gate.
 */
async function readPinnedSnapshot(root: string, id: string): Promise<SourceSnapshot | null> {
  const { pinnedCommit } = await readSourceState(root, id);
  if (pinnedCommit === null) return null;
  const path = join(root, id, "snapshots", `${pinnedCommit}.json`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    // The next sync rebuilds a lost snapshot at the same pin.
    if (isMissingPathError(error)) return null;
    throw new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", `snapshot ${pinnedCommit}.json of source ${id} cannot be read (${fsErrorCode(error)})`, {
      cause: error,
      detail: { reason: "snapshot-unreadable", sourceId: id },
    });
  }
  const invalid = (problem: string, cause?: unknown) =>
    new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", `snapshot ${pinnedCommit}.json of source ${id} ${problem}`, {
      ...(cause === undefined ? {} : { cause }),
      detail: { reason: "snapshot-invalid", sourceId: id },
    });
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text);
  } catch (error) {
    throw invalid(`is invalid: ${errorMessage(error)}`, error);
  }
  const named = typeof parsed === "object" && parsed !== null ? (parsed as Partial<SourceSnapshot>) : {};
  if (named.sourceId !== id || named.commit !== pinnedCommit) {
    throw invalid(`names ${String(named.sourceId)}@${String(named.commit)}`);
  }
  return parsed as SourceSnapshot;
}

/**
 * The revocations source `id` carries at its pin, for the revocation feed
 * (design §10.4): none before the first sync. A pin whose snapshot file is
 * gone throws, so the feed reports the source unreadable rather than
 * dropping its revocations until a sync rebuilds the snapshot.
 */
export async function readPinnedRevocations(root: string, id: string, appVersion: string): Promise<SourceSnapshot["revocations"]> {
  const snapshot = await readPinnedSnapshot(root, id);
  if (snapshot) return effectiveRevocations(snapshot, appVersion);
  const { pinnedCommit } = await readSourceState(root, id);
  if (pinnedCommit !== null) throw new Error(`snapshot ${pinnedCommit}.json of ${id} is missing`);
  return [];
}

/**
 * The artifact pins of source `id` at its current pin, for the host-secret
 * grant (design §10.3 condition 2): `pins(plugin, version)` answers what
 * `pinnedArtifactSha256s` reads from that snapshot. Each call reads the
 * source's small state file and parses the snapshot again only after the pin
 * moved, so a sync that changes the pins applies to the next secret read.
 */
export function pinnedArtifactReader(root: string, id: string): (plugin: string, version: string) => Promise<readonly string[]> {
  let cached: SourceSnapshot | null = null;
  return async (plugin, version) => {
    const { pinnedCommit } = await readSourceState(root, id);
    if (pinnedCommit === null) return [];
    if (cached?.commit !== pinnedCommit) cached = await readPinnedSnapshot(root, id);
    return cached ? pinnedArtifactSha256s(cached, plugin, version) : [];
  };
}
