import type { IpcMainInvokeEvent } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { IpcDeps } from "../ipc/types.js";
import { validateAppWindowMainFrameSender } from "../ipc/app-window-sender.js";
import { CHANNELS } from "../contract/app-contract.js";
import { findSessionMainWindowContents } from "./app-state.js";
import { DocumentObservationAdapter, type JournalObservationLease } from "../observation/document-adapter.js";
import { createTableObservationEngine } from "../observation/table-engine.js";
import { ObservationCapacityError, ObservationDaemon } from "../observation/daemon.js";
import {
  isObservationAck, OBSERVATION_LIMITS,
  type ObservationBinding, type DocumentObservationEngine, type ObservationIdentity,
  type ObservedDocument,
} from "../shared/agent-observation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { assertReadableFilePath, MAX_TEXT_FILE_BYTES } from "../tools/file-read-core.js";
import { readPreviewDocumentInput } from "../tools/preview-document-input.js";
import { TableDocumentError } from "../tools/table-document-error.js";
import { readPermissionSettings } from "../permissions/permission-settings-store.js";
import { buildRuntimeAllowedDirectories } from "../permissions/allowed-directories.js";
import { protectedReadDenyCovering, getProtectedReadDenyFloor } from "../permissions/asrt-sandbox.js";
import { setAgentObservationSink, type ObservedFileEffect } from "../tools/agent-observation-context.js";
import { TerminalObservationRuntime } from "./terminal-observation.js";
import type { ObservationResponse } from "../shared/agent-observation.js";
import { installBrowserObservation, type BrowserObservationRuntime } from "./browser-observation.js";

interface ViewOwner {
  id: string;
  event: IpcMainInvokeEvent;
  sessionId: string;
  path: string;
  rendered: boolean;
  maxBytes: number;
  stop: () => void;
}

function digest(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function invocationKey(identity: ObservationIdentity): string {
  return JSON.stringify([identity.sessionId, identity.turnId, identity.toolUseId]);
}

/** Read-only desktop binding: no script execution or document publication lives here. */
export class DocumentObservationRuntime {
  private readonly adapter: DocumentObservationAdapter;
  private readonly daemon = new ObservationDaemon();
  private readonly terminalObservation: TerminalObservationRuntime;
  private readonly browser: BrowserObservationRuntime;
  private readonly views = new Map<string, ViewOwner>();
  private readonly journals = new Map<string, JournalObservationLease[]>();
  private readonly readyWaiters = new Set<{ sessionId: string; path: string; finish: (ready: boolean) => void }>();
  private readonly knownTargets = new Map<string, { identity: ObservationIdentity; path: string }>();
  private disposed = false;

  constructor(private readonly deps: IpcDeps, engine: DocumentObservationEngine | null = createTableObservationEngine()) {
    this.adapter = new DocumentObservationAdapter(engine, this.daemon);
    this.terminalObservation = new TerminalObservationRuntime(deps, this.daemon);
    this.browser = installBrowserObservation(deps, this.daemon);
    setAgentObservationSink({
      openJournal: (identity, path) => {
        const lease = this.adapter.openJournal(identity, path);
        const key = invocationKey(identity);
        const leases = this.journals.get(key) ?? [];
        if (leases.length >= OBSERVATION_LIMITS.maxViews) {
          lease.dispose();
          throw new Error("Observation journal limit exceeded");
        }
        leases.push(lease);
        this.journals.set(key, leases);
        return lease;
      },
      beforeMutation: (identity, effects) => this.beforeMutation(identity, effects),
      finishInvocation: async (identity) => {
        const key = invocationKey(identity);
        const leases = this.journals.get(key) ?? [];
        this.journals.delete(key);
        try { for (const lease of leases) await lease.finish(); }
        finally { for (const lease of leases) lease.dispose(); }
        await this.adapter.finishInvocation(identity);
      },
      revokeInvocation: (identity) => {
        this.adapter.revokeInvocation(identity);
        this.journals.delete(invocationKey(identity));
      },
      finishTurn: (sessionId, turnId) => {
        for (const [key, target] of this.knownTargets) if (target.identity.sessionId === sessionId && target.identity.turnId === turnId) this.knownTargets.delete(key);
        this.adapter.finishTurn(sessionId, turnId);
        this.prune();
      },
    });
  }

  private isCurrent(view: Pick<ViewOwner, "event" | "sessionId" | "path">): boolean {
    if (this.disposed || !validateAppWindowMainFrameSender(view.event, this.deps)
      || findSessionMainWindowContents(view.sessionId) !== view.event.sender) return false;
    const additional = readPermissionSettings().permissions.additionalDirectories;
    const verdict = assertReadableFilePath(view.path, process.cwd(), buildRuntimeAllowedDirectories(additional));
    return verdict.ok && verdict.resolved === view.path
      && protectedReadDenyCovering(view.path, getProtectedReadDenyFloor()) === undefined;
  }

  private prune(): void {
    for (const view of this.views.values()) if (!this.isCurrent(view)) this.release(view.id);
  }

  registerView(event: IpcMainInvokeEvent, sessionId: unknown, path: string, bytes: Buffer,
    document: ObservedDocument): ObservationBinding | undefined {
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) return undefined;
    const prospective = { event, sessionId, path };
    if (!this.isCurrent(prospective)) return undefined;
    this.prune();
    for (const view of this.views.values()) if (view.event.sender === event.sender && view.event.senderFrame === event.senderFrame
      && view.sessionId === sessionId && view.path === path) this.release(view.id);
    // The daemon's limit is shared with terminal and browser targets, so its capacity, not the document view count, decides.
    if (this.views.size >= OBSERVATION_LIMITS.maxViews || !this.daemon.hasCapacity()) throw new TableDocumentError("busy", "Document observation limit exceeded");
    const id = randomUUID();
    const release = (): void => this.release(id);
    const handleNavigation = (_event: unknown, _url: string, _status: number, _text: string,
      isMainFrame: boolean): void => { if (isMainFrame) release(); };
    event.sender.on("destroyed", release);
    event.sender.on("render-process-gone", release);
    event.sender.on("did-frame-navigate", handleNavigation);
    const timer = setInterval(() => { if (!this.isCurrent(prospective)) release(); }, PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs);
    timer.unref();
    const view: ViewOwner = { id, ...prospective, rendered: false,
      maxBytes: document.format === "text" ? MAX_TEXT_FILE_BYTES : PREVIEW_DOCUMENT_LIMITS.maxFileBytes, stop: () => {
      clearInterval(timer);
      event.sender.removeListener("destroyed", release);
      event.sender.removeListener("render-process-gone", release);
      event.sender.removeListener("did-frame-navigate", handleNavigation);
    } };
    this.views.set(id, view);
    try {
      this.adapter.registerView({ id, sessionId, path, hash: digest(bytes), document,
        isCurrent: () => this.isCurrent(view),
        onEvents: (events) => {
          if (!this.isCurrent(view)) { this.release(id); return; }
          event.sender.send(CHANNELS.preview.observationEvents, events);
        },
      });
    } catch (error) {
      // Leave no view owner, listener or timer behind.
      this.release(id);
      if (error instanceof ObservationCapacityError) throw new TableDocumentError("busy", "Document observation limit exceeded");
      throw error;
    }
    for (const target of this.knownTargets.values()) if (target.identity.sessionId === sessionId && target.path === path) {
      this.adapter.admitKnownTarget(sessionId, target.identity.turnId, path);
    }
    return { targetId: id, sessionId, seq: 0 };
  }

  browserPreview(event: IpcMainInvokeEvent, raw: unknown): { ok: boolean; error?: string } {
    return this.browser.previewRequest(event, raw);
  }

  acknowledge(event: IpcMainInvokeEvent, raw: unknown): ObservationResponse {
    if (!validateAppWindowMainFrameSender(event, this.deps)) return { ok: false, error: "unauthorized" };
    const terminal = this.terminalObservation.acknowledge(event, raw);
    if (terminal) return terminal;
    if (!isObservationAck(raw)) return { ok: false, error: "bad-request" };
    const browserResult = this.browser.acknowledge(event, raw);
    if (browserResult) return browserResult;
    const view = this.views.get(raw.targetId);
    if (!view || !this.isCurrent(view) || view.event.sender !== event.sender
      || view.event.senderFrame !== event.senderFrame || view.sessionId !== raw.sessionId) {
      return { ok: false, error: "unauthorized" };
    }
    if (raw.action === "release") this.release(view.id);
    else {
      this.adapter.acknowledge(view.id, raw.seq);
      if (raw.seq === 0) {
        view.rendered = true;
        for (const waiter of this.readyWaiters) if (waiter.sessionId === view.sessionId && waiter.path === view.path) waiter.finish(true);
      }
    }
    return { ok: true };
  }

  markAgentDocument(identity: ObservationIdentity, path: string): void {
    this.adapter.markAgentDocument(identity.sessionId, resolve(path));
  }

  waitForRendered(identity: ObservationIdentity, path: string, expiresAt: number, signal?: AbortSignal): Promise<boolean> {
    const resolved = resolve(path);
    if (this.disposed || signal?.aborted || expiresAt <= Date.now()) return Promise.resolve(false);
    if (Array.from(this.views.values()).some((view) => view.rendered && view.sessionId === identity.sessionId
      && view.path === resolved && this.isCurrent(view))) return Promise.resolve(true);
    if (this.readyWaiters.size >= OBSERVATION_LIMITS.maxViews) return Promise.resolve(false);
    return new Promise<boolean>((resolveReady) => {
      const waiter = { sessionId: identity.sessionId, path: resolved, finish: (ready: boolean): void => {
        if (!this.readyWaiters.delete(waiter)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", handleAbort);
        resolveReady(ready && !signal?.aborted && Date.now() < expiresAt);
      } };
      const handleAbort = (): void => waiter.finish(false);
      const timer = setTimeout(() => waiter.finish(false), expiresAt - Date.now());
      timer.unref();
      this.readyWaiters.add(waiter);
      signal?.addEventListener("abort", handleAbort, { once: true });
      if (signal?.aborted) handleAbort();
    });
  }

  private async beforeMutation(identity: ObservationIdentity, effects: readonly ObservedFileEffect[]) {
    this.prune();
    const knownPaths = effects.filter((effect) => !("content" in effect && effect.content === null))
      .slice(0, OBSERVATION_LIMITS.maxViews).map((effect) => resolve(effect.path));
    const receipts: { path: string; beforeHash: string; afterHash: string }[] = [];
    for (const effect of effects) {
      const path = resolve(effect.path);
      const view = Array.from(this.views.values()).find((candidate) => candidate.sessionId === identity.sessionId
        && candidate.path === path && this.isCurrent(candidate));
      if (!view) continue;
      try {
        const before = await readPreviewDocumentInput(path, undefined, view.maxBytes);
        const after = "copyFrom" in effect ? await readPreviewDocumentInput(effect.copyFrom, undefined, view.maxBytes) : effect.content;
        if (after === null || Buffer.byteLength(after) > view.maxBytes) continue;
        receipts.push({ path, beforeHash: digest(before), afterHash: digest(after) });
      } catch {
        // An unreadable pre-image supplies no attribution and does not grant a read retry.
      }
    }
    return async (completed: boolean): Promise<void> => {
      if (!completed) return;
      for (const path of knownPaths) {
        const key = JSON.stringify([identity.sessionId, identity.turnId, path]);
        this.knownTargets.set(key, { identity, path });
        while (this.knownTargets.size > OBSERVATION_LIMITS.maxViews) this.knownTargets.delete(this.knownTargets.keys().next().value!);
        this.adapter.admitKnownTarget(identity.sessionId, identity.turnId, path);
      }
      for (const receipt of receipts) await this.adapter.observeMutation(identity, receipt.path, receipt.beforeHash, receipt.afterHash);
    };
  }

  release(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    view.stop();
    this.adapter.release(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    setAgentObservationSink(undefined);
    try { this.terminalObservation.dispose(); }
    finally {
      try { this.browser.dispose(); }
      finally { this.disposeDocuments(); }
    }
  }

  private disposeDocuments(): void {
    for (const id of this.views.keys()) this.release(id);
    for (const leases of this.journals.values()) for (const lease of leases) lease.dispose();
    this.journals.clear();
    this.knownTargets.clear();
    for (const waiter of this.readyWaiters) waiter.finish(false);
    this.daemon.dispose();
  }
}

let documentObservation: DocumentObservationRuntime | undefined;
export function installDocumentObservation(deps: IpcDeps): DocumentObservationRuntime {
  documentObservation?.dispose();
  documentObservation = new DocumentObservationRuntime(deps);
  return documentObservation;
}
export function observeAgentOpenedDocument(identity: ObservationIdentity, path: string, expiresAt: number, signal: AbortSignal): Promise<boolean> {
  if (!documentObservation) return Promise.resolve(false);
  documentObservation.markAgentDocument(identity, path);
  return documentObservation.waitForRendered(identity, path, expiresAt, signal);
}
process.once("exit", () => documentObservation?.dispose());
