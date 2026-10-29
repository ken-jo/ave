import { terminalFileEvidence } from "../main/terminal/changed-file-evidence.js";
import { createHash } from "node:crypto";
import { watch, type BigIntStats, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  OBSERVATION_LIMITS,
  type DocumentObservationEngine,
  type DocumentObservationEvent,
  type DocumentObservationStatus,
  type ObservationIdentity,
  type ObservedDocument,
} from "../shared/agent-observation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { MAX_TEXT_FILE_BYTES } from "../tools/file-read-core.js";
import type { DocumentEditJournalRecord } from "../shared/document-edit-journal.js";
import { readPreviewDocumentInput } from "../tools/preview-document-input.js";
import { ObservationDaemon } from "./daemon.js";
import { DocumentJournalReader } from "./journal-reader.js";
import { observedSelectionIndex, readObservedDocument } from "./observed-document.js";

export interface DocumentViewRegistration {
  id: string;
  sessionId: string;
  path: string;
  hash: string;
  document: ObservedDocument;
  isCurrent: () => boolean;
  onEvents: (events: DocumentObservationEvent[]) => void;
}

export interface JournalObservationLease {
  poll(): void;
  finish(): Promise<void>;
  dispose(): void;
}

interface MutationProof {
  identity: ObservationIdentity;
  beforeHash: string;
  afterHash: string;
}

interface DocumentView {
  registration: DocumentViewRegistration;
  renderedDocument: ObservedDocument;
  renderedHash: string;
  headHash: string;
  rendered: boolean;
  observed: boolean;
  blocked: boolean;
  dirty: boolean;
  version: number;
  watcher?: FSWatcher;
  controller?: AbortController;
  proof?: MutationProof;
  pending?: Promise<void>;
  snapshots: Map<number, string>;
  activeInvocations: Set<string>;
  knownTurns: Set<string>;
}

interface JournalEdit {
  beforeHash: string;
  views: string[];
  cells: number;
  committed: boolean;
}

interface AgentTargetAdmission { timer?: ReturnType<typeof setTimeout> }

const PENDING_AGENT_DOCUMENT_MS = PREVIEW_DOCUMENT_LIMITS.startupTimeoutMs + PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs
  + PREVIEW_DOCUMENT_LIMITS.busyRetryDelaysMs.reduce((total, milliseconds) => total + milliseconds, 0);

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function targetKey(sessionId: string, path: string): string { return `${sessionId}\0${resolve(path)}`; }
function invocationKey(identity: ObservationIdentity): string {
  return `${identity.sessionId}\0${identity.turnId}\0${identity.toolUseId}`;
}
function sameRevision(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}
function cellAddress(cell: string): { row: number; column: number } {
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(cell);
  if (!match) throw new Error("Invalid document journal cell.");
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  return { row: Number(match[2]) - 1, column: column - 1 };
}

/** File notifications wake reconciliation; only explicit mutation proof attributes content. */
export class DocumentObservationAdapter {
  readonly source = "document" as const;
  private readonly daemon: ObservationDaemon;
  private readonly ownsDaemon: boolean;
  private readonly views = new Map<string, DocumentView>();
  private readonly agentTargets = new Map<string, AgentTargetAdmission>();
  private readonly leases = new Map<JournalObservationLease, string>();
  private readonly journalDirectories = new Set<string>();
  private disposed = false;

  constructor(private readonly engine: DocumentObservationEngine | null, daemon?: ObservationDaemon) {
    this.daemon = daemon ?? new ObservationDaemon();
    this.ownsDaemon = daemon === undefined;
    this.daemon.registerAdapter(this);
  }

  registerView(registration: DocumentViewRegistration): void {
    if (this.disposed || this.views.has(registration.id)) throw new Error("Observation view already registered.");
    if (!/^[a-f0-9]{64}$/.test(registration.hash)) throw new Error("Invalid observation baseline hash.");
    this.daemon.registerTarget({ id: registration.id, path: registration.path }, registration.sessionId,
      registration.isCurrent, registration.onEvents);
    const view: DocumentView = {
      registration: { ...registration, path: resolve(registration.path) },
      renderedDocument: structuredClone(registration.document), renderedHash: registration.hash,
      headHash: registration.hash, rendered: false, observed: false, blocked: false, dirty: false,
      version: 0, snapshots: new Map(), activeInvocations: new Set(), knownTurns: new Set(),
    };
    this.views.set(registration.id, view);
  }

  markAgentDocument(sessionId: string, path: string): void {
    if (this.disposed) return;
    const key = targetKey(sessionId, path);
    this.dropAgentTarget(key);
    const admission: AgentTargetAdmission = {};
    this.agentTargets.set(key, admission);
    const views = this.matchingViews(sessionId, path);
    if (!views.some((view) => view.rendered)) {
      admission.timer = setTimeout(() => {
        if (this.agentTargets.get(key) === admission) this.dropAgentTarget(key);
      }, PENDING_AGENT_DOCUMENT_MS);
      admission.timer.unref?.();
    }
    while (this.agentTargets.size > OBSERVATION_LIMITS.maxViews) this.dropAgentTarget(this.agentTargets.keys().next().value!);
    for (const view of views) this.startWatching(view);
  }

  acknowledge(targetId: string, seq: number): void {
    const view = this.views.get(targetId);
    if (!view || !view.registration.isCurrent()) { this.release(targetId); throw new Error("Observation view is unavailable."); }
    const events = this.daemon.acknowledge(targetId, seq);
    if (seq === 0) {
      view.rendered = true;
      const admission = this.agentTargets.get(targetKey(view.registration.sessionId, view.registration.path));
      if (admission) {
        if (admission.timer) clearTimeout(admission.timer);
        admission.timer = undefined;
        this.startWatching(view);
      }
      if (view.knownTurns.size > 0) this.startWatching(view);
    }
    for (const event of events) {
      if (event.kind !== "snapshot") continue;
      const snapshot = view.snapshots.get(event.seq);
      if (!snapshot) continue;
      view.renderedDocument = structuredClone(event.after);
      view.renderedHash = snapshot;
      for (const pending of view.snapshots.keys()) if (pending <= event.seq) view.snapshots.delete(pending);
    }
  }

  release(targetId: string): void {
    const view = this.views.get(targetId);
    if (!view) return;
    view.controller?.abort();
    view.watcher?.close();
    view.snapshots.clear();
    this.views.delete(targetId);
    this.daemon.release(targetId);
    const key = targetKey(view.registration.sessionId, view.registration.path);
    const admission = this.agentTargets.get(key);
    // A successful reload replaces its view in the same turn of the event loop.
    queueMicrotask(() => {
      if (this.agentTargets.get(key) === admission
        && ![...this.views.values()].some((other) => targetKey(other.registration.sessionId, other.registration.path) === key)) {
        this.dropAgentTarget(key);
      }
    });
  }

  async observeMutation(identity: ObservationIdentity, path: string, beforeHash: string, afterHash: string): Promise<void> {
    const work: Promise<void>[] = [];
    for (const view of this.matchingViews(identity.sessionId, path)) {
      if (!view.rendered) continue;
      this.startWatching(view, identity);
      work.push(this.scheduleReconciliation(view, { identity: { ...identity }, beforeHash, afterHash }));
    }
    await Promise.all(work);
  }

  admitKnownTarget(sessionId: string, turnId: string, path: string): void {
    for (const view of this.matchingViews(sessionId, path)) {
      view.knownTurns.add(JSON.stringify([sessionId, turnId]));
      this.startWatching(view);
    }
  }

  finishTurn(sessionId: string, turnId: string): void {
    const key = JSON.stringify([sessionId, turnId]);
    for (const view of this.views.values()) {
      view.knownTurns.delete(key);
      this.closeUnownedWatch(view);
    }
  }

  openJournal(identity: ObservationIdentity, actionDirectory: string): JournalObservationLease {
    if (this.disposed) throw new Error("Observation daemon is disposed.");
    if (this.leases.size >= OBSERVATION_LIMITS.maxViews) throw new Error("Observation journal limit exceeded.");
    const directory = resolve(actionDirectory);
    if (this.journalDirectories.has(directory)) throw new Error("Document journal already registered.");
    const boundIdentity = Object.freeze({ ...identity });
    const edits = new Map<string, JournalEdit>();
    let stopped = false;
    let failed = false;
    let finished: Promise<void> | undefined;
    const affectedViews = (): DocumentView[] => [...new Set([...edits.values()].flatMap((edit) => edit.views))]
      .map((id) => this.views.get(id)).filter((view): view is DocumentView => view !== undefined);
    const fail = (): void => {
      if (failed) return;
      failed = true;
      for (const view of affectedViews()) {
        this.invalidate(view, "observation-error");
      }
    };
    const reader = new DocumentJournalReader(actionDirectory, (record) => {
      if (failed) return;
      this.acceptJournalRecord(boundIdentity, edits, record);
    });
    const poll = (): void => {
      if (stopped || failed) return;
      try { reader.poll(); }
      catch { fail(); }
    };
    const timer = setInterval(poll, OBSERVATION_LIMITS.pollMs);
    timer.unref?.();
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      reader.dispose();
      this.leases.delete(lease);
      this.journalDirectories.delete(directory);
    };
    const lease: JournalObservationLease = {
      poll,
      finish: () => {
        finished ??= (async () => {
          if (!stopped && !failed) {
            try { reader.drain(); }
            catch { fail(); }
          }
          stop();
          for (const edit of edits.values()) {
            if (!edit.committed) for (const id of edit.views) {
              const view = this.views.get(id);
              if (view) this.invalidate(view);
            }
          }
          await Promise.all(affectedViews().map((view) => view.pending));
        })();
        return finished;
      },
      dispose: () => {
        if (stopped) return;
        for (const view of affectedViews()) {
          this.invalidate(view);
        }
        stop();
      },
    };
    this.leases.set(lease, invocationKey(identity));
    this.journalDirectories.add(directory);
    return lease;
  }

  async finishInvocation(identity: ObservationIdentity): Promise<void> {
    const key = invocationKey(identity);
    const leases = [...this.leases].filter(([, owner]) => owner === key).map(([lease]) => lease);
    await Promise.all(leases.map((lease) => lease.finish()));
    await Promise.all([...this.views.values()].filter((view) => view.proof && invocationKey(view.proof.identity) === key)
      .map((view) => view.pending));
    for (const view of this.views.values()) {
      this.releaseInvocationWatch(view, key);
    }
  }

  revokeInvocation(identity: ObservationIdentity): void {
    const key = invocationKey(identity);
    for (const [lease, owner] of [...this.leases]) if (owner === key) lease.dispose();
    for (const view of this.views.values()) {
      if (view.activeInvocations.has(key) || (view.proof && invocationKey(view.proof.identity) === key)) this.invalidate(view);
      this.releaseInvocationWatch(view, key);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const lease of [...this.leases.keys()]) lease.dispose();
    for (const id of [...this.views.keys()]) this.release(id);
    for (const key of this.agentTargets.keys()) this.dropAgentTarget(key);
    this.agentTargets.clear();
    if (this.ownsDaemon) this.daemon.dispose();
  }

  private matchingViews(sessionId: string, path: string): DocumentView[] {
    const resolved = resolve(path);
    return [...this.views.values()].filter((view) => view.registration.sessionId === sessionId
      && view.registration.path === resolved && view.registration.isCurrent());
  }

  private dropAgentTarget(key: string): void {
    const admission = this.agentTargets.get(key);
    if (admission?.timer) clearTimeout(admission.timer);
    this.agentTargets.delete(key);
  }

  private startWatching(view: DocumentView, identity?: ObservationIdentity): void {
    if (identity) view.activeInvocations.add(invocationKey(identity));
    if (!view.rendered || view.observed || !this.current(view)) return;
    view.observed = true;
    if (!this.engine) { this.status(view, "engine-unavailable"); return; }
    try {
      view.watcher = watch(dirname(view.registration.path), { persistent: false }, (_event, file) => {
        if (!this.current(view)) return;
        if (file !== null && file.toString() !== basename(view.registration.path)) return;
        // No file bytes are read without a matching receipt, even inside an agent turn.
        view.dirty = true;
      });
      view.watcher.on("error", () => this.status(view, "observation-error"));
    } catch { this.status(view, "observation-error"); }
  }

  private status(view: DocumentView, code: DocumentObservationStatus): void {
    if (this.current(view)) this.daemon.publish(view.registration.id, { kind: "status", before: null, after: { code } });
  }

  private current(view: DocumentView): boolean {
    if (this.disposed || this.views.get(view.registration.id) !== view) return false;
    if (view.registration.isCurrent()) return true;
    this.release(view.registration.id);
    return false;
  }

  private invalidate(view: DocumentView, code: DocumentObservationStatus = "reload-required"): void {
    view.version += 1;
    view.blocked = true;
    view.controller?.abort();
    view.proof = undefined;
    view.snapshots.clear();
    this.daemon.discardPending(view.registration.id);
    this.status(view, code);
  }

  private releaseInvocationWatch(view: DocumentView, key: string): void {
    view.activeInvocations.delete(key);
    this.closeUnownedWatch(view);
  }

  private closeUnownedWatch(view: DocumentView): void {
    if (view.activeInvocations.size === 0 && view.knownTurns.size === 0
      && !this.agentTargets.has(targetKey(view.registration.sessionId, view.registration.path))) {
      view.watcher?.close();
      view.watcher = undefined;
      view.observed = false;
    }
  }

  private acceptJournalRecord(identity: ObservationIdentity, edits: Map<string, JournalEdit>, record: DocumentEditJournalRecord): void {
    if (record.kind === "begin") {
      if (!isAbsolute(record.target) || record.target !== resolve(record.target)) throw new Error("Invalid document journal target.");
      if (edits.has(record.editId) || edits.size >= OBSERVATION_LIMITS.maxEditCells) throw new Error("Invalid document journal edit.");
      const views = this.matchingViews(identity.sessionId, record.target)
        .filter((view) => view.rendered && view.renderedDocument.format !== "text");
      const accepted: string[] = [];
      for (const view of views) {
        this.startWatching(view, identity);
        if (view.blocked || view.headHash !== record.beforeHash) { this.invalidate(view); continue; }
        if (!this.engine) continue;
        accepted.push(view.registration.id);
      }
      edits.set(record.editId, { beforeHash: record.beforeHash, views: accepted, cells: 0, committed: false });
      return;
    }
    const edit = edits.get(record.editId);
    if (!edit || edit.committed) throw new Error("Invalid document journal edit sequence.");
    if (record.kind === "cell") {
      if (++edit.cells > OBSERVATION_LIMITS.maxEditCells) throw new Error("Document journal cell limit exceeded.");
      const address = cellAddress(record.cell);
      for (const id of edit.views) {
        const view = this.views.get(id);
        if (!view || !this.current(view) || view.blocked || !("sheet" in view.renderedDocument)
          || view.renderedDocument.sheet.name !== record.sheet) continue;
        this.daemon.publish(id, { kind: "element", element: { kind: "cell", sheet: record.sheet, ...address },
          before: record.before, after: record.after, advisory: true });
      }
      return;
    }
    edit.committed = true;
    for (const id of edit.views) {
      const view = this.views.get(id);
      if (view) void this.scheduleReconciliation(view, { identity, beforeHash: edit.beforeHash, afterHash: record.afterHash });
    }
  }

  private scheduleReconciliation(view: DocumentView, proof: MutationProof): Promise<void> {
    if (!this.current(view) || !view.rendered || view.blocked) return Promise.resolve();
    if (!/^[a-f0-9]{64}$/.test(proof.beforeHash) || !/^[a-f0-9]{64}$/.test(proof.afterHash)
      || proof.beforeHash !== view.headHash) {
      this.invalidate(view);
      return Promise.resolve();
    }
    if (!this.engine) { this.status(view, "engine-unavailable"); return Promise.resolve(); }
    view.headHash = proof.afterHash;
    view.proof = proof;
    const version = ++view.version;
    view.controller?.abort();
    const controller = new AbortController();
    view.controller = controller;
    this.status(view, "reconciling");
    const pending = this.reconcile(view, proof, version, controller).catch(() => {
      if (!controller.signal.aborted && this.current(view) && view.version === version) {
        this.invalidate(view, "observation-error");
      }
    }).finally(() => {
      if (view.pending === pending) view.pending = undefined;
    });
    view.pending = pending;
    return pending;
  }

  private async reconcile(view: DocumentView, proof: MutationProof, version: number, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    await delay(OBSERVATION_LIMITS.debounceMs, undefined, { signal });
    const settled = await this.readSettled(view, signal);
    if (!this.current(view) || version !== view.version) return;
    if (digest(settled.bytes) !== proof.afterHash) {
      this.invalidate(view);
      return;
    }
    let document: ObservedDocument | undefined;
    for (let attempt = 0; attempt < OBSERVATION_LIMITS.settleAttempts; attempt += 1) {
      try {
        const baseline = view.renderedDocument;
        const parsed = await this.engine!.parse(settled.bytes,
          baseline.format, observedSelectionIndex(baseline), signal, { sessionId: view.registration.sessionId });
        document = readObservedDocument(parsed, baseline);
        break;
      } catch (error) {
        signal.throwIfAborted();
        if ((error as { code?: string }).code !== "busy" || attempt === OBSERVATION_LIMITS.settleAttempts - 1) throw error;
        await delay(OBSERVATION_LIMITS.settleMs, undefined, { signal });
      }
    }
    signal.throwIfAborted();
    if (!document || !this.current(view) || version !== view.version) return;
    const current = await lstat(view.registration.path, { bigint: true });
    if (!sameRevision(settled.identity, current) || current.isSymbolicLink()) {
      this.invalidate(view);
      return;
    }
    const maxBytes = view.renderedDocument.format === "text" ? MAX_TEXT_FILE_BYTES : PREVIEW_DOCUMENT_LIMITS.maxFileBytes;
    if (digest(await readPreviewDocumentInput(view.registration.path, signal, maxBytes)) !== proof.afterHash) {
      this.invalidate(view);
      return;
    }
    signal.throwIfAborted();
    if (!this.current(view) || version !== view.version) return;
    await terminalFileEvidence.recordWrite(proof.identity.sessionId, view.registration.path);
    this.publishDiff(view, document);
    const seq = this.daemon.publish(view.registration.id, { kind: "snapshot", before: null, after: document });
    if (seq !== undefined) {
      view.snapshots.set(seq, proof.afterHash);
      for (const pendingSeq of view.snapshots.keys()) {
        if (!this.daemon.retains(view.registration.id, pendingSeq)) view.snapshots.delete(pendingSeq);
      }
    }
    view.dirty = false;
    this.status(view, "live");
  }

  private publishDiff(view: DocumentView, after: ObservedDocument): void {
    if (view.renderedDocument.format === "text" && after.format === "text") {
      const before = view.renderedDocument.lines;
      const length = Math.max(before.length, after.lines.length);
      for (let index = 0; index < length; index += 1) {
        const previous = before[index] ?? "";
        const next = after.lines[index] ?? "";
        if (previous === next) continue;
        this.daemon.publish(view.registration.id, { kind: "element", before: previous.slice(0, OBSERVATION_LIMITS.maxValueChars),
          after: next.slice(0, OBSERVATION_LIMITS.maxValueChars), advisory: false, element: { kind: "line", line: index + 1 } });
      }
      return;
    }
    if ("page" in view.renderedDocument && "page" in after) {
      const keyOf = (element: NonNullable<typeof after.elements>[number]["element"]): string =>
        element.kind === "paragraph" ? `paragraph:${element.paragraph}:${element.run ?? ""}` : `shape:${element.slide}:${element.shapeId}`;
      const before = new Map((view.renderedDocument.elements ?? []).map((item) => [keyOf(item.element), item]));
      const next = new Map((after.elements ?? []).map((item) => [keyOf(item.element), item]));
      for (const key of new Set([...before.keys(), ...next.keys()])) {
        const previous = before.get(key);
        const current = next.get(key);
        if (previous?.text === current?.text) continue;
        this.daemon.publish(view.registration.id, { kind: "element", element: (current ?? previous)!.element,
          before: (previous?.text ?? "").slice(0, OBSERVATION_LIMITS.maxValueChars),
          after: (current?.text ?? "").slice(0, OBSERVATION_LIMITS.maxValueChars), advisory: false });
      }
      return;
    }
    if (!("sheet" in view.renderedDocument) || !("sheet" in after)) throw new Error("Observation document kind changed.");
    const before = view.renderedDocument.sheet;
    const sheet = after.sheet;
    const emit = (row: number, column: number, previous: string, next: string): void => {
      if (previous === next) return;
      this.daemon.publish(view.registration.id, { kind: "element", before: previous, after: next, advisory: false,
        element: { kind: "cell", sheet: sheet.name, row, column } });
    };
    for (let row = 0; row < sheet.rows.length; row += 1) {
      for (let column = 0; column < sheet.rows[row].length; column += 1) {
        const absoluteRow = sheet.firstRow + row;
        const absoluteColumn = sheet.firstColumn + column;
        const previous = before.rows[absoluteRow - before.firstRow]?.[absoluteColumn - before.firstColumn] ?? "";
        const next = sheet.rows[row][column];
        emit(absoluteRow, absoluteColumn, previous, next);
      }
    }
    for (let row = 0; row < before.rows.length; row += 1) {
      for (let column = 0; column < before.rows[row].length; column += 1) {
        const absoluteRow = before.firstRow + row;
        const absoluteColumn = before.firstColumn + column;
        if (sheet.rows[absoluteRow - sheet.firstRow]?.[absoluteColumn - sheet.firstColumn] === undefined) {
          emit(absoluteRow, absoluteColumn, before.rows[row][column], "");
        }
      }
    }
  }

  private async readSettled(view: DocumentView, signal: AbortSignal): Promise<{ bytes: Buffer; identity: BigIntStats }> {
    const path = view.registration.path;
    let previous: BigIntStats | undefined;
    for (let attempt = 0; attempt < OBSERVATION_LIMITS.settleAttempts; attempt += 1) {
      signal.throwIfAborted();
      const changed = view.dirty;
      view.dirty = false;
      try {
        const current = await lstat(path, { bigint: true });
        const maxBytes = view.renderedDocument.format === "text" ? MAX_TEXT_FILE_BYTES : PREVIEW_DOCUMENT_LIMITS.maxFileBytes;
        if (!current.isFile() || current.isSymbolicLink() || current.size > BigInt(maxBytes)) {
          throw new Error("Invalid observed document.");
        }
        if (previous && !changed && sameRevision(previous, current)) {
          const bytes = await readPreviewDocumentInput(path, signal, maxBytes);
          const after = await lstat(path, { bigint: true });
          if (!view.dirty && sameRevision(current, after)) return { bytes, identity: after };
        }
        previous = current;
      } catch (error) {
        signal.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        previous = undefined;
      }
      await delay(OBSERVATION_LIMITS.settleMs, undefined, { signal });
    }
    throw new Error("Observed document did not settle.");
  }
}
