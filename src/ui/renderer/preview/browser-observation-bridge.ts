import { useSyncExternalStore } from "react";
import {
  OBSERVATION_LIMITS,
  type AgentObservationEvent,
  type BrowserObservationEvent,
  type ObservationAck,
} from "../../../shared/agent-observation.js";
import type { AvePreviewApi } from "../types.js";
import { BrowserObservationPreviewStore } from "./browser-observation-preview.js";

interface BrowserObservationHistory {
  sessionId: string;
  hostSessionId: string;
  sessions: Set<string>;
  events: BrowserObservationEvent[];
  seq: number;
}

/** Local metadata only; the host supplies attribution and never sends input values. */
export class BrowserObservationStore {
  private readonly histories = new Map<string, BrowserObservationHistory>();
  private readonly retiredTargets = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly acknowledge: (ack: ObservationAck) => Promise<{ ok: boolean }>) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  accept(events: readonly AgentObservationEvent[]): void {
    if (this.disposed) return;
    const acknowledgements = new Map<string, ObservationAck>();
    let changed = false;
    for (const event of events) {
      if (event.source !== "browser" || event.actor !== "agent") continue;
      const targetId = event.target.id;
      if (this.retiredTargets.has(targetId)) continue;
      const previous = this.histories.get(targetId);
      if (!Number.isSafeInteger(event.seq) || event.seq <= 0 || !Number.isFinite(event.ts)
        || (previous && (previous.sessionId !== event.sessionId || previous.hostSessionId !== event.target.hostSessionId
          || previous.seq >= event.seq))) continue;
      if (event.kind === "status" && event.after.code === "session-cleared") {
        if (previous?.sessionId === event.sessionId) changed = this.histories.delete(targetId) || changed;
        this.retire(targetId);
        acknowledgements.delete(targetId);
        continue;
      }
      const history = previous ?? { sessionId: event.sessionId, hostSessionId: event.target.hostSessionId,
        sessions: new Set([event.sessionId, event.target.hostSessionId]), events: [], seq: 0 };
      history.seq = event.seq;
      history.events = [...history.events, event].slice(-OBSERVATION_LIMITS.browserHistoryEvents);
      this.histories.set(targetId, history);
      while (this.histories.size > OBSERVATION_LIMITS.maxViews) {
        const oldest = this.histories.keys().next().value!;
        this.release(oldest);
      }
      acknowledgements.set(targetId, { action: "rendered", targetId, sessionId: event.sessionId, seq: event.seq });
      changed = true;
    }
    if (changed) this.notify();
    for (const [targetId, ack] of acknowledgements) {
      const history = this.histories.get(targetId);
      if (!history) continue;
      void this.acknowledge(ack).then((result) => {
        if (!result.ok) this.fail(targetId, history, ack.seq);
      }, () => this.fail(targetId, history, ack.seq));
    }
  }

  latest(tabId: string, sessionId?: string): BrowserObservationEvent | undefined {
    let latest: BrowserObservationEvent | undefined;
    for (const history of this.histories.values()) {
      const sameSession = sessionId !== undefined && history.sessions.has(sessionId);
      const action = history.events.findLast((event) => event.kind === "action"
        && ((event.after.rendererTabId === tabId && (sessionId === undefined || sameSession))
          || (sameSession && event.after.action === "tab-close")));
      const status = history.events.at(-1);
      const candidate = status?.kind === "status" && (sameSession || action) && status.seq >= (action?.seq ?? 0) ? status : action;
      if (!candidate) continue;
      if (!latest || candidate.ts > latest.ts || (candidate.ts === latest.ts && candidate.seq > latest.seq)) latest = candidate;
    }
    return latest;
  }

  releaseSession(sessionId: string): void {
    let changed = false;
    for (const [targetId, history] of this.histories) if (history.sessions.has(sessionId)) {
      this.release(targetId);
      changed = true;
    }
    if (changed) this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const targetId of this.histories.keys()) this.release(targetId);
    this.notify();
    this.listeners.clear();
  }

  private fail(targetId: string, history: BrowserObservationHistory, seq: number): void {
    if (this.disposed || this.histories.get(targetId) !== history || history.seq !== seq) return;
    const latest = history.events.at(-1);
    if (!latest) return;
    history.events = [...history.events.slice(-(OBSERVATION_LIMITS.browserHistoryEvents - 1)), { ...latest, kind: "status", before: null,
      after: { code: "observation-error" } }];
    this.notify();
  }

  private release(targetId: string): void {
    const history = this.histories.get(targetId);
    if (!history) return;
    this.histories.delete(targetId);
    this.retire(targetId);
    void this.acknowledge({ action: "release", targetId, sessionId: history.sessionId, seq: history.seq }).then((result) => {
      if (!result.ok) console.warn("Browser observation release was refused.");
    }, () => console.warn("Browser observation release failed."));
  }

  private retire(targetId: string): void {
    this.retiredTargets.add(targetId);
    while (this.retiredTargets.size > OBSERVATION_LIMITS.maxViews) this.retiredTargets.delete(this.retiredTargets.values().next().value!);
  }

  private notify(): void { for (const listener of this.listeners) listener(); }
}

let store: BrowserObservationStore | undefined;
let previews: BrowserObservationPreviewStore | undefined;
const listeners = new Set<() => void>();
function notify(): void { for (const listener of listeners) listener(); }

/** Installed once with the window's existing browser host bridge. */
export function connectBrowserObservations(api: AvePreviewApi): () => void {
  if (store) throw new Error("Browser observation listener already registered.");
  const current = new BrowserObservationStore((ack) => api.acknowledgeObservation(ack));
  const preview = new BrowserObservationPreviewStore(api);
  store = current;
  previews = preview;
  const stopChanges = current.subscribe(notify);
  const stopPreviewChanges = preview.subscribe(notify);
  const stopEvents = api.onAgentObservation((events) => current.accept(events));
  const stopFrames = api.onObservationPreview((message) => preview.accept(message));
  notify();
  return () => {
    stopEvents();
    stopFrames();
    current.dispose();
    preview.dispose();
    stopChanges();
    stopPreviewChanges();
    if (store === current) store = undefined;
    if (previews === preview) previews = undefined;
    notify();
  };
}

export function releaseBrowserObservationSession(sessionId: string): void { store?.releaseSession(sessionId); }

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The connected window's preview store; undefined before connection or after teardown. */
export function useBrowserObservationPreviewStore(): BrowserObservationPreviewStore | undefined {
  return useSyncExternalStore(subscribe, () => previews, () => undefined);
}

export function useBrowserObservation(tabId: string, sessionId?: string): BrowserObservationEvent | undefined {
  return useSyncExternalStore(subscribe, () => store?.latest(tabId, sessionId), () => undefined);
}
