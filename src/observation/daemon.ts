import {
  OBSERVATION_LIMITS,
  type DocumentObservationEvent,
  type ObservationSource,
  type ObservationTarget,
  type ObservationEventEnvelope,
} from "../shared/agent-observation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";

export interface ObservationAdapter {
  readonly source: ObservationSource;
  dispose(): void;
}

type ObservationEventPayload<Event extends ObservationEventEnvelope> = Event extends ObservationEventEnvelope
  ? Omit<Event, "source" | "actor" | "sessionId" | "target" | "seq" | "ts"> : never;

interface EventTarget {
  target: ObservationTarget;
  sessionId: string;
  source: ObservationSource;
  isCurrent: () => boolean;
  onEvents: (events: ObservationEventEnvelope[]) => void;
  nextSeq: number;
  acknowledged: number;
  sent: number;
  queued: ObservationEventEnvelope[];
  inFlight: ObservationEventEnvelope[];
  timer?: ReturnType<typeof setTimeout>;
}

function elementKey(event: ObservationEventEnvelope): string | undefined {
  if (event.source !== "document" || event.kind !== "element") return undefined;
  const element = (event as Extract<DocumentObservationEvent, { kind: "element" }>).element;
  return element.kind === "line" ? `line\0${element.line}` : `${element.sheet}\0${element.row}\0${element.column}`;
}

function elementBytes(events: readonly ObservationEventEnvelope[]): number {
  return events.reduce((total, event) => total + (event.kind !== "snapshot" ? Buffer.byteLength(JSON.stringify(event)) : 0), 0);
}

/** Local delivery is bounded even when a renderer stops acknowledging frames. */
export class ObservationDaemon {
  private readonly adapters = new Map<ObservationSource, ObservationAdapter>();
  private readonly targets = new Map<string, EventTarget>();
  private disposed = false;

  registerAdapter(adapter: ObservationAdapter): void {
    if (this.disposed || this.adapters.has(adapter.source)) throw new Error("Observation adapter already registered.");
    this.adapters.set(adapter.source, adapter);
  }

  registerTarget<Event extends ObservationEventEnvelope = DocumentObservationEvent>(target: ObservationTarget, sessionId: string, isCurrent: () => boolean,
    onEvents: (events: Event[]) => void, source: Event["source"] = "document"): void {
    if (this.disposed || this.targets.has(target.id)) throw new Error("Observation target already registered.");
    if (!this.adapters.has(source)) throw new Error("Observation source is not registered.");
    if (this.targets.size >= OBSERVATION_LIMITS.maxViews) throw new Error("Observation view limit exceeded.");
    this.targets.set(target.id, { target: { ...target }, sessionId, source, isCurrent,
      onEvents: (events) => onEvents(events as Event[]),
      nextSeq: 0, acknowledged: 0, sent: 0, queued: [], inFlight: [] });
  }

  publish<Event extends ObservationEventEnvelope = DocumentObservationEvent>(targetId: string, payload: ObservationEventPayload<Event>): number | undefined {
    const target = this.targets.get(targetId);
    if (!target || !target.isCurrent()) { this.release(targetId); return undefined; }
    if (payload.kind === "snapshot" && Buffer.byteLength(JSON.stringify(payload.after)) > PREVIEW_DOCUMENT_LIMITS.maxResponseBytes) {
      throw new Error("Observation snapshot limit exceeded.");
    }
    const event = { ...payload, source: target.source, actor: "agent", sessionId: target.sessionId,
      target: target.target, seq: ++target.nextSeq, ts: Date.now() } as ObservationEventEnvelope;
    const key = elementKey(event);
    if (key !== undefined) target.queued = target.queued.filter((pending) => elementKey(pending) !== key);
    if (event.kind === "snapshot") target.queued = target.queued.filter((pending) => pending.kind !== "snapshot");
    target.queued.push(event);
    if (target.queued.length > OBSERVATION_LIMITS.maxQueuedEvents
      || elementBytes(target.queued) > OBSERVATION_LIMITS.maxQueuedElementBytes) {
      // Preserve the newest authoritative snapshot; provisional cells can be rebuilt.
      const snapshot = target.queued.findLast((pending) => pending.kind === "snapshot");
      target.queued = snapshot ? [snapshot] : [];
      target.queued.push({ source: target.source, actor: "agent", sessionId: target.sessionId,
        target: target.target, seq: ++target.nextSeq, ts: Date.now(), kind: "status", before: null,
        after: { code: "resync-required" } });
    }
    this.schedule(target);
    return event.seq;
  }

  /** Return only events actually delivered before this acknowledgement. */
  acknowledge<Event extends ObservationEventEnvelope = DocumentObservationEvent>(targetId: string, seq: number): Event[] {
    const target = this.targets.get(targetId);
    if (!target || !Number.isSafeInteger(seq) || seq < 0 || seq > target.sent) {
      throw new Error("Invalid observation acknowledgement.");
    }
    if (seq <= target.acknowledged) return [];
    target.acknowledged = seq;
    const rendered = target.inFlight.filter((event) => event.seq <= seq);
    target.inFlight = target.inFlight.filter((event) => event.seq > seq);
    this.schedule(target);
    return rendered as Event[];
  }

  retains(targetId: string, seq: number): boolean {
    const target = this.targets.get(targetId);
    return target !== undefined && (target.inFlight.some((event) => event.seq === seq)
      || target.queued.some((event) => event.seq === seq));
  }

  /** Revocation invalidates unsent content and releases retained delivery buffers. */
  discardPending(targetId: string): void {
    const target = this.targets.get(targetId);
    if (!target) return;
    if (target.timer) clearTimeout(target.timer);
    target.timer = undefined;
    target.queued = [];
    target.inFlight = [];
    target.acknowledged = target.sent;
  }

  release(targetId: string): void {
    const target = this.targets.get(targetId);
    if (target?.timer) clearTimeout(target.timer);
    this.targets.delete(targetId);
  }

  /** A lifetime invalidation clears rendered state even when normal delivery is backpressured. */
  endTarget(targetId: string): void {
    const target = this.targets.get(targetId);
    if (!target) return;
    this.discardPending(targetId);
    const event: ObservationEventEnvelope = { source: target.source, actor: "agent", sessionId: target.sessionId,
      target: target.target, seq: ++target.nextSeq, ts: Date.now(), kind: "status", before: null, after: { code: "session-cleared" } };
    try { target.onEvents([event]); }
    finally { this.release(targetId); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.targets.keys()) this.release(id);
    for (const adapter of this.adapters.values()) adapter.dispose();
    this.adapters.clear();
  }

  private schedule(target: EventTarget): void {
    if (target.timer || target.queued.length === 0 || target.inFlight.length >= OBSERVATION_LIMITS.maxInFlightEvents) return;
    if (target.queued[0].kind === "snapshot" && target.inFlight.some((event) => event.kind === "snapshot")) return;
    target.timer = setTimeout(() => {
      target.timer = undefined;
      if (!this.targets.has(target.target.id)) return;
      if (!target.isCurrent()) { this.release(target.target.id); return; }
      let allowance = Math.min(OBSERVATION_LIMITS.batchEvents,
        OBSERVATION_LIMITS.maxInFlightEvents - target.inFlight.length);
      if (target.inFlight.some((event) => event.kind === "snapshot")) {
        const snapshot = target.queued.findIndex((event) => event.kind === "snapshot");
        if (snapshot !== -1) allowance = Math.min(allowance, snapshot);
      }
      const events = target.queued.splice(0, allowance);
      if (events.length === 0) return;
      target.inFlight.push(...events);
      target.sent = events.at(-1)!.seq;
      try { target.onEvents(events); }
      catch (error) {
        const current = target.isCurrent();
        this.release(target.target.id);
        if (current) throw error;
      }
      this.schedule(target);
    }, 0);
    target.timer.unref?.();
  }
}
