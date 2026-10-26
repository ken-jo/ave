/** Publish a validated snapshot before moving the pin; rewritten history requires review.
 * Folder sync has no history rule and retains the last good snapshot on read failure. */
import { admitSnapshotPackages, validateCachedSnapshotText } from "../catalog/validate.js";
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
import { classifyFolder, folderMoved, resolveFolderRoot, type FolderRoot } from "../net/source-input.js";
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
  root: string;
  now?: () => Date;
  /** Never prune commits still referenced by installed origins. */
  retainedCommits: (sourceId: string) => Promise<ReadonlySet<string>>;
  onCatalogChanged?: (sourceId: string) => void;
  /** All folder access uses the supplied filesystem fence and package ceilings. */
  folders: { fs: FolderFs; platform: NodeJS.Platform; limits: ExportLimits };
}

export type SyncResult =
  | { status: "ok"; pinnedCommit: string; changed: boolean }
  /** Persist details with codes so background failures retain their explanation. */
  | { status: "failed"; code: MarketplaceErrorCode; message: string; detail?: MarketplaceErrorDetail; pinnedCommit: string | null };

const SNAPSHOT_FILE = /^(?:[0-9a-f]{40}|local-[0-9a-f]{64})\.json$/u;
const CANDIDATE_REF = "candidate";

/** Reads and reveal share classification, consent and identity checks before folder access.
 * Changed paths or identities are moved and their replacement targets remain unread. */
export async function openStoredFolder(
  source: FolderSource,
  state: SourceState,
  options: Pick<SourceSyncOptions, "registry" | "gate"> & { folders: Pick<SourceSyncOptions["folders"], "fs" | "platform"> },
): Promise<{ root: FolderRoot; networkConsented: boolean }> {
  const { fs, platform } = options.folders;
  options.gate.checkFolderPolicy(source.path);
  const network = await classifyFolder(source.path, platform, fs);
  const acknowledged = await options.registry.acknowledged(source);
  options.gate.checkFolder(source.path, network, acknowledged);
  const networkConsented = acknowledged.has("network-folder");
  const root = await resolveFolderRoot(source.path, platform, fs, networkConsented);
  if (root.path !== source.path) throw folderMoved(source.path, root.path);
  const recorded = state.folder;
  const known = recorded !== undefined && recorded.dev !== "0" && recorded.ino !== "0" && root.dev !== 0n && root.ino !== 0n;
  if (known && (recorded.dev !== root.dev.toString() || recorded.ino !== root.ino.toString())) throw folderMoved(source.path, root.path);
  options.gate.checkFolderPolicy(root.path);
  return { root, networkConsented };
}

/** Hidden sources sync only for bound installs; quarantined ids never sync. */
export function shouldSyncSource(registry: SourceRegistry, source: ResolvedSource, state: SourceState, hasInstalledPackages: boolean): boolean {
  if (registry.isQuarantined(source)) return false;
  return registry.isEnabled(source, state) || hasInstalledPackages;
}

interface JoinedSync {
  promise: Promise<SyncResult>;
  controller: AbortController;
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

  private async remoteFor(source: GitSource, url = source.url): Promise<GitRemote> {
    const acknowledged = await this.options.registry.acknowledged(source);
    const verdict = this.options.gate.checkRemote(url, { official: source.origin === "official", acknowledged });
    // A mirror on another host never gets the primary host's token.
    const useToken = source.auth.kind === "token" && source.auth.host === url.host;
    return { url, sourceId: source.id, useToken, ...verdict };
  }

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

  /** Persist failure details because background results reach views through source listing. */
  private async recordFailure(
    source: ResolvedSource,
    failure: { code: MarketplaceErrorCode; message: string; detail?: MarketplaceErrorDetail | undefined },
    candidate?: string,
  ): Promise<SyncResult> {
    const { code, message } = failure;
    // Scrub details before storing or returning them; remote text may quote credentials.
    const detail = failure.detail && scrubMarketplaceErrorDetail(code, failure.detail);
    const state = await this.options.registry.updateState(source.id, (current) => ({
      ...current,
      lastSync: { at: this.now(), result: code, ...(detail ? { detail } : {}), ...(candidate ? { candidate } : {}) },
    }));
    return { status: "failed", code, message, ...(detail ? { detail } : {}), pinnedCommit: state.pinnedCommit };
  }

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

  private async openFolder(source: FolderSource, state: SourceState): Promise<FolderTree> {
    const { fs, platform, limits } = this.options.folders;
    const { root, networkConsented } = await openStoredFolder(source, state, this.options);
    return new FolderTree({ fs, platform, root, readAt: this.now(), limits, networkConsented });
  }

  /** Return the same fresh folder read used for its published snapshot so capture cannot mix revisions. */
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

  /** Unopenable local repositories are repairable data damage, not network failures. */
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
    // Write state before repository creation so later state loss cannot silently unpin history.
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

  /** Join existing syncs; shared work stops only when every caller has aborted. */
  sync(id: string, signal?: AbortSignal): Promise<SyncResult> {
    let joined = this.inflight.get(id);
    // A new caller cannot join an abandoned run; queue a fresh run behind its source lock.
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

  /** Accept only the reviewed pending candidate; an intervening rewrite expires that review. */
  acceptRewrite(id: string, candidate: string, signal?: AbortSignal): Promise<SyncResult> {
    return this.withSourceLock(id, async () => {
      const source = this.source(id);
      if (source.origin !== "custom" && source.origin !== "direct") {
        throw new Error(`the ${source.origin} source ${id} never accepts rewritten history`);
      }
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
        if (error instanceof LocalRepositoryDamagedError) throw repositoryDamaged(id, error);
        throw error;
      }
    });
  }

  /** Hold the source lock while reading planned commits; hidden sources refuse installs until shown. */
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

  /** Under the source lock, capture a fresh read and require its digest to match the new snapshot.
     * Execution reuses the capture; failures are recorded and thrown. */
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

  /** Repair waits for source operations, preserving readable history and switches before the caller resyncs. */
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

  removeSource(id: string): Promise<void> {
    return this.withSourceLock(id, () => this.options.registry.remove(id));
  }

  /** Serve the pinned snapshot offline under current identifier admission; null before first success. */
  async readSnapshot(id: string): Promise<SourceSnapshot | null> {
    return readPinnedSnapshot(this.options.root, id);
  }

  /** Retained install snapshots reconstruct missing consent fields; pruned commits return null. */
  async readRetainedSnapshot(id: string, commit: string): Promise<SourceSnapshot | null> {
    let text: string;
    try {
      text = await readFile(this.snapshotPath(id, commit), "utf8");
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
    const validated = validateCachedSnapshotText(text);
    return validated.ok && validated.value.sourceId === id && validated.value.commit === commit ? validated.value : null;
  }

  readRevocations(id: string, appVersion: string): Promise<SourceSnapshot["revocations"]> {
    return readPinnedRevocations(this.options.root, id, appVersion);
  }
}

/** Report local repository damage without exposing its path. */
function repositoryDamaged(id: string, error: LocalRepositoryDamagedError): MarketplaceError {
  return new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", `repo.git of source ${id} is not a repository git can open`, {
    cause: error,
    detail: { reason: "repository-damaged", sourceId: id },
  });
}

/** Boot reads pinned snapshots before syncer construction to enforce persisted revocations. */
async function readPinnedSnapshot(root: string, id: string): Promise<SourceSnapshot | null> {
  const { pinnedCommit } = await readSourceState(root, id);
  if (pinnedCommit === null) return null;
  const path = join(root, id, "snapshots", `${pinnedCommit}.json`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
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
  return admitSnapshotPackages(parsed as SourceSnapshot);
}

/** Missing pinned snapshots throw rather than silently dropping revocations. */
export async function readPinnedRevocations(root: string, id: string, appVersion: string): Promise<SourceSnapshot["revocations"]> {
  const snapshot = await readPinnedSnapshot(root, id);
  if (snapshot) return effectiveRevocations(snapshot, appVersion);
  const { pinnedCommit } = await readSourceState(root, id);
  if (pinnedCommit !== null) throw new Error(`snapshot ${pinnedCommit}.json of ${id} is missing`);
  return [];
}

/** Re-read source state per secret access and reload pins when the source pin moves. */
export function pinnedArtifactReader(root: string, id: string): (plugin: string, version: string) => Promise<readonly string[]> {
  let cached: SourceSnapshot | null = null;
  return async (plugin, version) => {
    const { pinnedCommit } = await readSourceState(root, id);
    if (pinnedCommit === null) return [];
    if (cached?.commit !== pinnedCommit) cached = await readPinnedSnapshot(root, id);
    return cached ? pinnedArtifactSha256s(cached, plugin, version) : [];
  };
}
