import { lstatSync, mkdirSync, readFileSync, utimesSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { unwrapStagedText } from "../shared/conversation-title.js";
import { stripStagedEnvelopeTags } from "../shared/staged-origins.js";
import { deleteCodeCheckpoints } from "./code-checkpoints.js";
import { isValidSessionId } from "../shared/session-id.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync, isMissingPathError } from "../lib/atomic-file.js";
import { openFeatureNamespace } from "../main/storage/feature-namespace.js";
import { t } from "../i18n/index.js";
import { projectRootKey } from "../shared/project-identity.js";
import type { IndexedSessionInput, SessionSearchIndexPolicy, SessionSearchIndexPolicySource } from "./session-search-index.js";
import { createLogger } from "../lib/logger.js";
import { isRecord } from "../shared/is-record.js";
import { parseStrictJsonText } from "../shared/strict-json.js";
import { appendJsonlRecords, removeTurnInflightRecord, rowIdsOf, sessionProgressRows, turnInflightPath, writeTurnInflightRecord, type TurnInflightPartial } from "./session-turn-journal.js";
import { SessionRepository, transcriptWriteStates, liveTurnJournals, statPathIfPresent, asTerminalA2ATaskState, detachProjectBinding, applyDetachedWireTerminalTombstone, MAX_SESSION_TITLE_CHARS, MAX_SUMMARY_PREAMBLE_CHARS, isValidA2AWireHandlerId, isValidA2AWireMetadataId, isCompactBoundaryRecord, normalizeSessionKind, extractSearchableContent, normalizeSessionMetadata, sessionMetadataInProject, unlinkIfPresent, normalizeMetadataString, MAX_PROJECT_ROOT_CHARS, MAX_PROJECT_NAME_CHARS, getFileMtimeMs, type SessionSearchEntry, type ListSessionsOptions, type SessionMetadata } from "./session-repository.js";

const log = createLogger("memory");

const SESSION_METADATA_FORBIDDEN_KEYS: ReadonlySet<string> = new Set();

function readSessionMetadataObject(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && lstatSync(path, { throwIfNoEntry: false }) === undefined) return null;
    throw error;
  }
  const parsed = parseStrictJsonText(raw, {
    maxDepth: 32,
    forbiddenKeys: SESSION_METADATA_FORBIDDEN_KEYS,
    nullPrototypeObjects: true,
    rejectNonFiniteNumbers: true,
    fail: () => { throw new SyntaxError("invalid session metadata"); },
  });
  if (!isRecord(parsed)) {
    throw new TypeError("session metadata must be an object");
  }
  return parsed;
}

const SEARCH_REPAIR_INTENT = ".search-repair.json";

export class WindowsSessionRepository extends SessionRepository {
  private readonly getSearchIndexPolicy: () => SessionSearchIndexPolicy;
  private readonly refreshSearchIndexPolicy: (() => Promise<() => SessionSearchIndexPolicy>) | undefined;
  private readonly searchIndexQueue: Array<(admit: () => SessionSearchIndexPolicy) => void> = [];
  private searchIndexBatch: typeof this.searchIndexQueue = [];
  private searchIndexDrain: Promise<void> | undefined;
  private readonly pendingSearchWrites = new Set<string>();
  private searchSourceRevision = 0;
  private searchSourceWrites = 0;
  private readonly liveSearchRecovery = new Set<string>();
  private readonly sessionNamespace: ReturnType<typeof openFeatureNamespace>;
  private searchIndexState: "current" | "stale" | "discarded" = "current";
  private searchIndexChecked = false;

  constructor(options?: { aveDir?: string } & SessionSearchIndexPolicySource) {
    super(options);
    this.sessionNamespace = openFeatureNamespace("sessions", this.aveDir);
    this.getSearchIndexPolicy = options?.getSearchIndexPolicy ?? (() => "enabled");
    this.refreshSearchIndexPolicy = options?.refreshSearchIndexPolicy;
  }

  override closeSearchIndex(): void {
    // Work still waiting for its policy runs as refused: writes leave a repair intent, reads answer nothing.
    for (const work of [...this.searchIndexBatch.splice(0), ...this.searchIndexQueue.splice(0)]) {
      try {
        work(() => "inactive");
      } catch (error) {
        log.warn({ error }, "session search index work failed");
      }
    }
    this.pendingSearchWrites.clear();
    this.searchIndex.close();
  }

  private withSearchIndexPolicy(work: (admit: () => SessionSearchIndexPolicy) => void): void {
    if (this.refreshSearchIndexPolicy === undefined) {
      work(this.getSearchIndexPolicy);
      return;
    }
    this.searchIndexQueue.push(work);
    this.searchIndexDrain ??= this.drainSearchIndexQueue(this.refreshSearchIndexPolicy);
  }

  private async drainSearchIndexQueue(refresh: () => Promise<() => SessionSearchIndexPolicy>): Promise<void> {
    try {
      while (this.searchIndexQueue.length > 0) {
        this.searchIndexBatch = this.searchIndexQueue.splice(0);
        const revision = this.searchSourceRevision;
        const readPolicy = await refresh().catch((): (() => SessionSearchIndexPolicy) => () => "inactive");
        const admit = (): SessionSearchIndexPolicy => revision === this.searchSourceRevision && this.searchSourceWrites === 0
          ? readPolicy() : "inactive";
        for (const work of this.searchIndexBatch.splice(0)) {
          try {
            work(admit);
          } catch (error) {
            log.warn({ error }, "session search index work failed");
          }
        }
      }
    } finally {
      this.searchIndexDrain = undefined;
    }
  }

  private answerFromSearchIndex<T>(work: (admit: () => SessionSearchIndexPolicy) => T): Promise<T> {
    return new Promise((resolve, reject) => {
      this.withSearchIndexPolicy((admit) => {
        try {
          resolve(work(admit));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  searchIndexIdle(): Promise<void> {
    return this.searchIndexDrain ?? Promise.resolve();
  }

  searchSessionsWithCurrentPolicy(query: string, options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped"> = {},
    onAdmission?: (assertLive: () => void) => void): Promise<SessionSearchEntry[]> {
    return this.answerFromSearchIndex((admit) => {
      if (!onAdmission) return this.querySearchIndex(query, options, admit);
      const revision = this.searchSourceRevision;
      const policy = admit();
      const result = this.querySearchIndex(query, options, admit);
      onAdmission(() => {
        if (revision !== this.searchSourceRevision || this.searchSourceWrites !== 0 || admit() !== policy) throw new Error("Session search authorization changed");
      });
      return result;
    });
  }

  override searchSessions(query: string, options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped"> = {}): SessionSearchEntry[] {
    return this.querySearchIndex(query, options, this.refreshSearchIndexPolicy === undefined ? this.getSearchIndexPolicy : () => "inactive");
  }

  private querySearchIndex(query: string, options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped">,
    admit: () => SessionSearchIndexPolicy): SessionSearchEntry[] {
    // Require two code points; exactly two use LIKE because trigram MATCH requires three.
    if ([...query.trim()].length < 2) return [];
    if (!this.canUseSearchIndex("read", admit) || !this.searchIndex.open()) return [];
    try {
      // The index has no schema version to trigger a rebuild, so rows indexed before staged titles were unwrapped are repaired on read.
      // This only repairs a stored title whose 80-code-point cut kept the whole envelope header; a longer header stays raw until the session is saved again.
      // Snippets drop envelope tags for display; the indexed content stays raw so the source tag remains searchable.
      return this.searchIndex.query(query, {
        kind: options.kind,
        routineId: options.routineId,
        projectRoot: options.projectRoot,
        includeUnscoped: options.includeUnscoped,
      }).map((hit) => ({
        ...hit,
        ...(hit.title ? { title: unwrapStagedText(hit.title, t) } : {}),
        matchedMessage: stripStagedEnvelopeTags(hit.matchedMessage),
      }));
    } finally {
      this.searchIndex.close();
    }
  }

  override async saveSession(sessionId: string, messages: unknown[]): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`saveSession: invalid sessionId "${sessionId}"`);
    }
    const targetPath = join(this.sessionsDir, `${sessionId}.jsonl`);
    await withFileLock(targetPath, async () => {
      this.mutateSessionSearchSource(sessionId, () => {
        this.writeSessionTranscriptLocked(sessionId, targetPath, messages);
        // Whole-history save supersedes orphan recovery state; retain sidecars for locally running turns.
        if (!this.isTurnJournalLive(sessionId)) {
          removeTurnInflightRecord(turnInflightPath(this.sessionsDir, sessionId));
        }
      }, messages);
    });
  }

  override async appendSessionProgress(
    sessionId: string,
    readMessages: unknown[] | (() => unknown[]),
  ): Promise<"appended" | "rewritten" | "unchanged"> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`appendSessionProgress: invalid sessionId "${sessionId}"`);
    }
    const targetPath = join(this.sessionsDir, `${sessionId}.jsonl`);
    return withFileLock(targetPath, async () => {
      const onDisk = await stat(targetPath).catch((err: unknown) => {
        if (isMissingPathError(err)) return null;
        throw err;
      });
      // Read history after acquiring the lock so a waiting writer cannot undo a newer saved snapshot.
      const messages = typeof readMessages === "function" ? readMessages() : readMessages;
      const ids = rowIdsOf(messages);
      const known = transcriptWriteStates.get(targetPath);
      const rows = ids && known ? sessionProgressRows(known.ids, ids, messages) : null;
      if (
        ids
        && known
        && onDisk
        && onDisk.size === known.size
        && onDisk.mtimeMs === known.mtimeMs
        && rows !== null
      ) {
        if (rows.length === 0) return "unchanged";
        await this.withSearchSourceWrite(async () => {
          const prepared = this.prepareSessionMessagesForDisk(sessionId, rows);
          const after = await appendJsonlRecords(targetPath, prepared.messages);
          transcriptWriteStates.set(targetPath, { ids, ...after });
        });
        return "appended";
      }
      this.markSearchSourceChanged();
      this.writeSessionTranscriptLocked(sessionId, targetPath, messages);
      return "rewritten";
    });
  }

  override async beginTurnJournal(sessionId: string, startedAt: number): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`beginTurnJournal: invalid sessionId "${sessionId}"`);
    }
    const path = turnInflightPath(this.sessionsDir, sessionId);
    const hadJournal = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
    liveTurnJournals.set(path, (liveTurnJournals.get(path) ?? 0) + 1);
    if (hadJournal) {
      await this.withSearchSourceWrite(() => writeTurnInflightRecord(path, { v: 1, startedAt }));
    } else {
      await writeTurnInflightRecord(path, { v: 1, startedAt });
    }
  }

  override async writeTurnPartial(sessionId: string, startedAt: number, partial: TurnInflightPartial | undefined): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`writeTurnPartial: invalid sessionId "${sessionId}"`);
    }
    await this.withSearchSourceWrite(async () => {
      if (partial && this.isTurnJournalLive(sessionId)) this.liveSearchRecovery.add(sessionId);
      await writeTurnInflightRecord(
        turnInflightPath(this.sessionsDir, sessionId),
        partial ? { v: 1, startedAt, partial } : { v: 1, startedAt },
      );
      if (!partial) this.liveSearchRecovery.delete(sessionId);
    });
  }

  override endTurnJournal(sessionId: string): void {
    if (!isValidSessionId(sessionId)) return;
    const path = turnInflightPath(this.sessionsDir, sessionId);
    const remaining = (liveTurnJournals.get(path) ?? 1) - 1;
    if (remaining > 0) {
      liveTurnJournals.set(path, remaining);
      return;
    }
    liveTurnJournals.delete(path);
    if (this.liveSearchRecovery.delete(sessionId)) this.markSearchSourceChanged();
  }

  override clearTurnJournal(sessionId: string): void {
    if (!isValidSessionId(sessionId) || this.isTurnJournalLive(sessionId)) return;
    const path = turnInflightPath(this.sessionsDir, sessionId);
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return;
    this.markSearchSourceChanged();
    removeTurnInflightRecord(path);
  }

  private buildAdmittedIndexInput(sessionId: string, messages: unknown[], metadata: SessionMetadata | null): IndexedSessionInput | null {
    const content = extractSearchableContent(messages);
    if (!content) return null;
    const summary = this.deriveSessionSummary(sessionId, messages);
    const mtimeMs = getFileMtimeMs(join(this.sessionsDir, `${sessionId}.jsonl`));
    const timestamp = mtimeMs >= 0 ? new Date(mtimeMs).toISOString() : new Date().toISOString();
    return {
      sessionId,
      content,
      timestamp,
      sessionKind: metadata?.sessionKind ?? normalizeSessionKind(undefined),
      ...(metadata?.routineId ? { routineId: metadata.routineId } : {}),
      ...(metadata?.projectRoot ? { projectRoot: metadata.projectRoot } : {}),
      ...(summary.title ? { title: summary.title } : {}),
    };
  }

  private mutateSessionSearchSource(sessionId: string, write: () => void, messages?: unknown[]): void {
    if (this.refreshSearchIndexPolicy === undefined) {
      this.deferInactiveSearchWrite();
      write();
      this.indexSessionForSearch(sessionId, messages);
      return;
    }

    // A marker from a previous batch or process requires a full repair.
    const first = this.pendingSearchWrites.size === 0;
    if (first && this.hasSearchRepairIntent()) this.searchIndexState = "stale";
    this.persistSearchRepairIntent();
    this.searchSourceRevision += 1;
    try {
      write();
    } catch (error) {
      this.searchIndexState = "stale";
      throw error;
    }

    this.pendingSearchWrites.add(sessionId);
    this.scheduleSearchWrites();
  }

  private scheduleSearchWrites(): void {
    this.withSearchIndexPolicy((admit) => this.flushSearchWrites(admit));
  }

  private markSearchSourceChanged(): void {
    this.recordSearchRepairIntent();
    this.searchSourceRevision += 1;
  }

  private async withSearchSourceWrite<T>(write: () => Promise<T>): Promise<T> {
    this.markSearchSourceChanged();
    this.searchSourceWrites += 1;
    try {
      return await write();
    } finally {
      this.searchSourceRevision += 1;
      this.searchSourceWrites -= 1;
      if (this.searchSourceWrites === 0 && this.pendingSearchWrites.size > 0) this.scheduleSearchWrites();
    }
  }

  private writeSessionSearchRow(sessionId: string, messages: unknown[] | null): boolean {
    const input = messages === null ? null
      : this.buildAdmittedIndexInput(sessionId, messages, this.readSessionMetadataForSearch(sessionId));
    return input ? this.searchIndex.upsertSessionAdmitted(input) : this.searchIndex.deleteSessionAdmitted(sessionId);
  }

  protected override indexSessionForSearch(sessionId: string, messages: unknown[] | undefined): void {
    if (!this.canUseSearchIndex("write", this.getSearchIndexPolicy) || !this.searchIndex.open()) return;
    try {
      if (!this.writeSessionSearchRow(sessionId, messages ?? this.loadSession(sessionId))) this.recordSearchRepairIntent();
    } catch (error) {
      this.recordSearchRepairIntent();
      log.warn({ error }, "could not update session search row");
    } finally {
      this.searchIndex.close();
    }
  }

  private flushSearchWrites(admit: () => SessionSearchIndexPolicy): void {
    if (this.pendingSearchWrites.size === 0) return;
    // Recovery may have already projected every pending source change.
    if (!this.canUseSearchIndex("write", admit) || this.pendingSearchWrites.size === 0) return;
    try {
      if (!this.searchIndex.open()) throw new Error("could not open session search index for writing");
      for (const sessionId of this.pendingSearchWrites) {
        if (!this.writeSessionSearchRow(sessionId, this.loadSession(sessionId))) {
          throw new Error("could not commit session search row");
        }
      }
      this.clearSearchRepairIntent();
    } catch (error) {
      this.searchIndexState = "stale";
      log.warn({ error }, "could not project queued session search changes");
    } finally {
      this.pendingSearchWrites.clear();
      this.searchIndex.close();
    }
  }

  private hasSearchRepairIntent(): boolean {
    return lstatSync(join(this.sessionsDir, SEARCH_REPAIR_INTENT), { throwIfNoEntry: false }) !== undefined;
  }

  private recordSearchRepairIntent(): void {
    this.searchIndexState = "stale";
    this.persistSearchRepairIntent();
  }

  private persistSearchRepairIntent(): void {
    if (!this.hasSearchRepairIntent()) this.sessionNamespace.writeExistingJsonSync(SEARCH_REPAIR_INTENT, true);
  }

  private clearSearchRepairIntent(): void {
    if (this.searchSourceWrites > 0 || this.liveSearchRecovery.size > 0) return;
    try {
      unlinkSync(join(this.sessionsDir, SEARCH_REPAIR_INTENT));
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }

  private deferInactiveSearchWrite(): void {
    try {
      if (this.getSearchIndexPolicy() === "inactive") this.recordSearchRepairIntent();
    } catch (error) {
      log.warn({ error }, "could not persist session search repair intent");
    }
  }

  private pauseSearchIndex(): void {
    if (this.searchIndexState === "discarded" && !this.hasSearchRepairIntent()) return;
    this.searchIndexState = "stale";
    this.searchIndex.discard();
    this.clearSearchRepairIntent();
    this.pendingSearchWrites.clear();
    this.searchIndexState = "discarded";
  }

  private canUseSearchIndex(operation: "read" | "write", admit: () => SessionSearchIndexPolicy): boolean {
    try {
      if (this.searchSourceWrites > 0) return false;
      const policy = admit();
      if (policy === "inactive") {
        if (operation === "write") this.recordSearchRepairIntent();
        return false;
      }
      if (policy === "paused") {
        this.pauseSearchIndex();
        return false;
      }
      if (this.searchIndexState !== "current" || (this.pendingSearchWrites.size === 0 && this.liveSearchRecovery.size === 0 && this.hasSearchRepairIntent())) {
        this.rebuildSessionSearchRows();
      }
      if (policy === "enabled-with-recovery" && !this.searchIndexChecked) {
        if (!this.hasPopulatedSearchIndex()) this.rebuildSessionSearchRows();
        this.searchIndexChecked = true;
      }
      return true;
    } catch (error) {
      log.warn({ error }, "could not update session search index state");
      return false;
    }
  }

  private hasPopulatedSearchIndex(): boolean {
    if (statPathIfPresent(this.searchIndex.getDbPath()) === null || !this.searchIndex.open()) return false;
    try {
      return this.searchIndex.rowCount() > 0;
    } finally {
      this.searchIndex.close();
    }
  }

  private *sessionSearchInputs(): Iterable<IndexedSessionInput> {
    const sessionFiles = this.listSessionJsonlFiles().sort();
    for (const file of sessionFiles) {
      const sessionId = file.slice(0, -".jsonl".length);
      if (!isValidSessionId(sessionId)) continue;
      const messages = this.loadSession(sessionId);
      if (!Array.isArray(messages)) continue;
      const input = this.buildAdmittedIndexInput(sessionId, messages, this.readSessionMetadataForSearch(sessionId));
      if (input) yield input;
    }
  }

  private rebuildSessionSearchRows(): void {
    this.searchIndexState = "stale";
    try {
      if (!this.searchIndex.open({ recoverCorruption: true })) {
        throw new Error("search index could not be opened for repair");
      }

      this.searchIndex.writeRebuiltSessions(this.sessionSearchInputs());
      this.clearSearchRepairIntent();
      this.pendingSearchWrites.clear();
      this.searchIndexState = "current";
      this.searchIndexChecked = true;
    } finally {
      this.searchIndex.close();
    }
  }

  private repairAdmittedSearchRowsForProjectDetach(admit: () => SessionSearchIndexPolicy): void {
    if (this.searchSourceWrites > 0) return;
    try {
      const policy = admit();
      if (policy === "inactive") return;
      if (policy === "paused") this.pauseSearchIndex();
      else this.rebuildSessionSearchRows();
    } catch (cause) {
      throw Object.assign(
        new Error("workspace session search index repair failed"),
        { code: "SESSION_SEARCH_INDEX_REPAIR_FAILED", cause },
      );
    }
  }

  override verifyOrRebuildSearchIndex(): Promise<void> {
    return this.answerFromSearchIndex((admit) => this.verifyOrRebuildSearchIndexUnder(admit));
  }

  private verifyOrRebuildSearchIndexUnder(admit: () => SessionSearchIndexPolicy): void {
    if (!this.canUseSearchIndex("read", admit)) return;
    const opened = this.searchIndex.open();
    if (opened) {
      try {
        // Skip transcript enumeration for healthy populated indexes.
        if (this.searchIndex.rowCount() > 0 || this.listSessionJsonlFiles().length === 0) return;
      } finally {
        this.searchIndex.close();
      }
    }
    this.rebuildSessionSearchRows();
  }

  override async saveCheckpointSnapshot(sessionId: string, compactNum: number, messages: unknown[]): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`saveCheckpointSnapshot: invalid sessionId "${sessionId}"`);
    }
    const sessionSnapshotDir = join(this.checkpointsDir, sessionId);
    mkdirSync(sessionSnapshotDir, { recursive: true });
    const targetPath = join(sessionSnapshotDir, `${compactNum}.jsonl`);
    await withFileLock(targetPath, async () => {
      const prepared = this.prepareSessionMessagesForDisk(sessionId, messages);
      const lines = `${prepared.messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
      this.markSearchSourceChanged();
      writeUtf8FileAtomicSync(targetPath, lines);
      // Release unpublished artifact pins only after durable checkpoint ownership commits.
      const unpublished = this.unpublishedOutputCaptures.get(sessionId);
      for (const id of prepared.keepCaptureIds) unpublished?.delete(id);
    });
  }

  override async saveSessionMetadata(sessionId: string, metadata: SessionMetadata): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`saveSessionMetadata: invalid sessionId "${sessionId}"`);
    }
    const targetPath = join(this.sessionsDir, `${sessionId}.meta.json`);
    let safe: SessionMetadata = metadata.summaryPreamble !== undefined &&
      metadata.summaryPreamble.length > MAX_SUMMARY_PREAMBLE_CHARS
      ? { ...metadata, summaryPreamble: metadata.summaryPreamble.slice(0, MAX_SUMMARY_PREAMBLE_CHARS) }
      : metadata;
    safe = {
      ...safe,
      sessionKind: normalizeSessionKind(safe.sessionKind),
      projectRoot: normalizeMetadataString(safe.projectRoot, MAX_PROJECT_ROOT_CHARS),
      projectName: normalizeMetadataString(safe.projectName, MAX_PROJECT_NAME_CHARS),
      subAgentSuspensionPrompt: normalizeMetadataString(
        safe.subAgentSuspensionPrompt,
        MAX_SUMMARY_PREAMBLE_CHARS,
      ),
    };
    const hasA2AWireHandlerId = safe.a2aWireHandlerId !== undefined;
    const hasA2AWireInternalOrigin = safe.a2aWireInternalOrigin !== undefined;
    const detachedTerminalState = asTerminalA2ATaskState(safe.subAgentTaskState);
    const isDetachedA2AWireTask = safe.projectRoot === undefined
      && detachedTerminalState !== undefined
      && safe.subAgentSuspensionReason === undefined
      && safe.subAgentSuspensionPrompt === undefined;
    if (hasA2AWireHandlerId || hasA2AWireInternalOrigin) {
      if (
        !isValidA2AWireHandlerId(safe.a2aWireHandlerId)
        || !isValidA2AWireMetadataId(safe.a2aWireInternalOrigin)
        || safe.a2aWireInternalOrigin !== safe.originSessionId
        || (safe.projectRoot === undefined && !isDetachedA2AWireTask)
        || !Array.isArray(safe.sourceTools)
        || !safe.sourceTools.every((tool) =>
          typeof tool === "string" && tool.length > 0 && tool.length <= 256)
      ) {
        throw new Error(
          "saveSessionMetadata: invalid A2A wire binding metadata (a2a-wire-binding-invalid)",
        );
      }
    }
    if (safe.title !== undefined && safe.title.length > MAX_SESSION_TITLE_CHARS) {
      safe = { ...safe, title: safe.title.slice(0, MAX_SESSION_TITLE_CHARS) };
    }
    // Capture generation before locking so detach/re-add cannot clear a stale writer's guard.
    const guardedProjectKey = projectRootKey(safe.projectRoot);
    const capturedRootGeneration = guardedProjectKey
      ? this.projectRootGeneration(guardedProjectKey)
      : undefined;
    await withFileLock(this.sessionMetadataLockPath(sessionId), async () => {
      // A metadata update must not replace an unreadable sidecar with default scope.
      readSessionMetadataObject(targetPath);
      const sessionTombstones = this.detachedProjectRootsBySession.get(sessionId);
      const rootIsDetached = Boolean(
        guardedProjectKey && this.detachedProjectRoots.has(guardedProjectKey),
      );
      const sessionWasDetached = Boolean(
        guardedProjectKey && sessionTombstones?.has(guardedProjectKey),
      );
      const rootGenerationChanged = Boolean(
        guardedProjectKey
        && capturedRootGeneration !== this.projectRootGeneration(guardedProjectKey),
      );
      const shouldDetachProject = Boolean(
        guardedProjectKey
        && (rootIsDetached || sessionWasDetached || rootGenerationChanged),
      );
      if (shouldDetachProject && guardedProjectKey) {
        // Writers arriving during removal remain detached after re-add; generation checks cover the ABA window.
        if (!sessionWasDetached) {
          const nextTombstones = sessionTombstones ?? new Set<string>();
          nextTombstones.add(guardedProjectKey);
          this.detachedProjectRootsBySession.set(sessionId, nextTombstones);
        }
      }
      const terminalTombstone = this.detachedWireTerminalTombstones.get(sessionId);
      if (terminalTombstone) {
        safe = applyDetachedWireTerminalTombstone(safe, terminalTombstone);
      } else if (shouldDetachProject) {
        safe = detachProjectBinding(safe);
        this.rememberDetachedWireTerminal(sessionId, safe);
      }
      this.mutateSessionSearchSource(sessionId, () => {
        writeUtf8FileAtomicSync(targetPath, JSON.stringify(safe, null, 2));
        this.notePaneSession(sessionId, safe);
      });
    });
  }

  override countSessionsInProject(projectRoot: string): number {
    if (!projectRootKey(projectRoot)) return 0;
    let count = 0;
    for (const { sessionId, targetPath } of this.sessionMetadataTargets()) {
      let parsed: Record<string, unknown> | null;
      try {
        parsed = readSessionMetadataObject(targetPath);
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        log.warn("countSessionsInProject: invalid metadata for %s (%s)", sessionId, errorName);
        throw Object.assign(new Error("workspace session metadata unreadable"), { code: "SESSION_METADATA_INVALID", cause: error });
      }
      if (parsed !== null && sessionMetadataInProject(parsed, projectRoot)) count += 1;
    }
    return count;
  }

  override async detachSessionsFromProject(projectRoot: string): Promise<number> {
    const key = projectRootKey(projectRoot);
    if (!key) return 0;
    this.bumpProjectRootGeneration(key);
    this.detachedProjectRoots.add(key);

    type DetachPlan = {
      sessionId: string;
      targetPath: string;
      normalized: SessionMetadata;
      next: Record<string, unknown>;
    };
    const metadataTargets = this.sessionMetadataTargets();

    let detachedCount = 0;
    const withAllMetadataLocks = async <T>(
      index: number,
      action: () => Promise<T>,
    ): Promise<T> => {
      const target = metadataTargets[index];
      if (!target) return await action();
      return await withFileLock(
        this.sessionMetadataLockPath(target.sessionId),
        async () => await withAllMetadataLocks(index + 1, action),
      );
    };

    await withAllMetadataLocks(0, async () => {
      const plans: DetachPlan[] = [];
      // Preflight every candidate while all locks are held before rewriting any metadata.
      for (const { sessionId, targetPath } of metadataTargets) {
        try {
          const parsed = readSessionMetadataObject(targetPath);
          if (parsed === null || !sessionMetadataInProject(parsed, projectRoot)) continue;
          const normalized = normalizeSessionMetadata(parsed);
          const terminalTombstone = this.detachedWireTerminalTombstones.get(sessionId);
          const next = terminalTombstone
            ? applyDetachedWireTerminalTombstone(parsed, terminalTombstone)
            : detachProjectBinding(parsed);
          plans.push({ sessionId, targetPath, normalized, next });
        } catch (error) {
          // Return stable retryable errors; parser diagnostics may echo private source text.
          const errorName = error instanceof Error ? error.name : "UnknownError";
          log.warn("detachSessionsFromProject: invalid metadata for %s (%s)", sessionId, errorName);
          throw Object.assign(new Error("workspace session metadata detach incomplete"), {
            code: "SESSION_METADATA_INVALID",
            cause: error,
          });
        }
      }

      // Persist projection repair before detaching metadata so it survives workspace removal completion.
      this.markSearchSourceChanged();
      for (const { sessionId, targetPath, normalized, next } of plans) {
        writeUtf8FileAtomicSync(targetPath, JSON.stringify(next, null, 2));
        const sessionTombstones = this.detachedProjectRootsBySession.get(sessionId)
          ?? new Set<string>();
        sessionTombstones.add(key);
        this.detachedProjectRootsBySession.set(sessionId, sessionTombstones);
        if (!this.detachedWireTerminalTombstones.has(sessionId)) {
          this.rememberDetachedWireTerminal(sessionId, {
            ...normalized,
            subAgentTaskState: (next as Partial<SessionMetadata>).subAgentTaskState,
          });
        }
        detachedCount += 1;
      }
    });

    this.withSearchIndexPolicy((admit) => this.repairAdmittedSearchRowsForProjectDetach(admit));
    return detachedCount;
  }

  override touchSessionTranscript(sessionId: string, options: { bump: boolean }): boolean {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`touchSessionTranscript: invalid sessionId "${sessionId}"`);
    }
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    try {
      writeFileSync(path, "", { encoding: "utf-8", flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (options.bump) {
      this.markSearchSourceChanged();
      const now = new Date();
      utimesSync(path, now, now);
    }
    return false;
  }

  private readSessionMetadataForSearch(sessionId: string): SessionMetadata | null {
    const path = join(this.sessionsDir, `${sessionId}.meta.json`);
    try {
      const metadata = readSessionMetadataObject(path);
      if (metadata === null) return null;
      const { sessionKind, routineId, projectRoot } = metadata;
      if (sessionKind !== undefined && sessionKind !== normalizeSessionKind(sessionKind)
        || routineId !== undefined && (typeof routineId !== "string" || routineId.trim().length === 0)
        || projectRoot !== undefined && (
          typeof projectRoot !== "string" || projectRoot.includes("\0")
          || projectRoot.trim().length === 0 || projectRoot.trim().length > MAX_PROJECT_ROOT_CHARS
        )) {
        throw new TypeError("invalid search scope");
      }
      return normalizeSessionMetadata(metadata);
    } catch {
      throw new Error("invalid session metadata for search");
    }
  }

  override loadSessionMetadata(sessionId: string): SessionMetadata | null {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`loadSessionMetadata: invalid sessionId "${sessionId}"`);
    }
    const path = join(this.sessionsDir, `${sessionId}.meta.json`);
    try {
      const parsed = readSessionMetadataObject(path);
      return parsed === null ? null : normalizeSessionMetadata(parsed);
    } catch (err) {
      // Warn on metadata parse or I/O failures while retaining the null return contract.
      log.warn(`loadSessionMetadata failed for ${sessionId}: %s`, (err as Error).message);
      return null;
    }
  }

  override async pruneCheckpointsDiscardedByRewind(
    sessionId: string,
    discardedMessages: readonly unknown[],
  ): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`pruneCheckpointsDiscardedByRewind: invalid sessionId "${sessionId}"`);
    }
    const metadata = this.loadSessionMetadata(sessionId);
    const checkpoints = metadata?.checkpoints ?? [];
    if (!metadata || checkpoints.length === 0) return;

    const discardedCompactNums = new Set<number>();
    for (const message of discardedMessages) {
      if (!isCompactBoundaryRecord(message)) continue;
      const meta = isRecord(message) && isRecord(message.meta) ? message.meta : {};
      if (typeof meta.compactNum === "number") discardedCompactNums.add(meta.compactNum);
    }
    if (discardedCompactNums.size === 0) return;

    const kept = checkpoints.filter(
      (checkpoint) =>
        checkpoint.compactNum === undefined || !discardedCompactNums.has(checkpoint.compactNum),
    );
    if (kept.length === checkpoints.length) return;

    this.markSearchSourceChanged();
    for (const compactNum of discardedCompactNums) {
      const snapshotPath = join(this.checkpointsDir, sessionId, `${compactNum}.jsonl`);
      try {
        rmSync(snapshotPath, { force: true });
      } catch (err) {
        log.warn(
          { sessionId, compactNum },
          `pruneCheckpointsDiscardedByRewind: failed to remove snapshot: ${(err as Error).message}`,
        );
      }
    }

    // Clear the preamble only when its latest checkpoint disappears; losing older checkpoints leaves it valid.
    const latestCompactNum = checkpoints
      .map((checkpoint) => checkpoint.compactNum)
      .filter((compactNum): compactNum is number => compactNum !== undefined)
      .reduce<number | undefined>(
        (highest, compactNum) => (highest === undefined || compactNum > highest ? compactNum : highest),
        undefined,
      );
    const latestSurvives =
      latestCompactNum === undefined || !discardedCompactNums.has(latestCompactNum);
    const { summaryPreamble: _describedDiscardedTurns, ...withoutPreamble } = metadata;
    await this.saveSessionMetadata(sessionId, {
      ...(latestSurvives ? metadata : withoutPreamble),
      checkpoints: kept.length > 0 ? kept : undefined,
    });
  }

  override async deleteSession(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      log.warn({ sessionId }, "unsafe caller-provided sessionId rejected in deleteSession");
      return;
    }
    await withFileLock(this.sessionMetadataLockPath(sessionId), async () => {
      this.detachedProjectRootsBySession.delete(sessionId);
      await deleteCodeCheckpoints(sessionId);
      this.detachedWireTerminalTombstones.delete(sessionId);
      this.mutateSessionSearchSource(sessionId, () => {
        const jsonlPath = join(this.sessionsDir, `${sessionId}.jsonl`);
        unlinkIfPresent(jsonlPath);
        transcriptWriteStates.delete(jsonlPath);
        unlinkIfPresent(join(this.sessionsDir, `${sessionId}.meta.json`));
        this.notePaneSession(sessionId, null);
      });
      const sessionDir = join(this.sessionsDir, sessionId);
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`deleteSession: failed to remove session dir ${sessionDir}: ${(err as Error).message}`);
      }
      const checkpointSnapshotDir = join(this.checkpointsDir, sessionId);
      try {
        rmSync(checkpointSnapshotDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`deleteSession: failed to remove checkpoint snapshot dir ${checkpointSnapshotDir}: ${(err as Error).message}`);
      }
      const diffCacheDir = join(this.aveDir, "diff-cache", sessionId);
      try {
        rmSync(diffCacheDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`deleteSession: failed to remove diff cache dir ${diffCacheDir}: ${(err as Error).message}`);
      }
    });
  }
}
