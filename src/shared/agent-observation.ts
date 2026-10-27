import type { PreviewTableDocument } from "./preview-document.js";
import type { PreviewAnyFormat, PreviewDocumentFor, PreviewPageDocument, PreviewDocumentElement } from "./preview-page-document.js";

export type ObservationSource = "document" | "browser" | "terminal";
export interface ObservationTarget { id: string; path: string }
export interface ObservationIdentity { sessionId: string; turnId: string; toolUseId: string }
export type DocumentObservationStatus = "live" | "reconciling" | "reload-required"
  | "engine-unavailable" | "observation-error" | "resync-required";

export interface ObservationEventEnvelope {
  source: ObservationSource;
  actor: "agent";
  sessionId: string;
  target: ObservationTarget;
  seq: number;
  ts: number;
  kind: string;
  before: unknown;
  after: unknown;
}
interface DocumentEventBase extends ObservationEventEnvelope { source: "document" }
export interface PreviewObservedTextDocument {
  format: "text";
  content: string;
  lines: string[];
  totalLines: number;
  truncated: boolean;
}
export type ObservedDocument = PreviewTableDocument | PreviewObservedTextDocument | PreviewPageDocument;
export type DocumentObservationEvent =
  | DocumentEventBase & { kind: "element"; element: { kind: "cell"; sheet: string; row: number; column: number }
    | { kind: "line"; line: number } | PreviewDocumentElement["element"];
    before: string; after: string; advisory: boolean }
  | DocumentEventBase & { kind: "snapshot"; before: null; after: ObservedDocument }
  | DocumentEventBase & { kind: "status"; before: null; after: { code: DocumentObservationStatus } };

export interface DocumentObservationBinding { targetId: string; sessionId: string; seq: number }
export interface DocumentObservationAck {
  action: "rendered" | "release";
  targetId: string;
  sessionId: string;
  seq: number;
}

export function isDocumentObservationAck(value: unknown): value is DocumentObservationAck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4
    && (record.action === "rendered" || record.action === "release")
    && typeof record.targetId === "string" && /^[a-f0-9-]{36}$/.test(record.targetId)
    && typeof record.sessionId === "string" && record.sessionId.length > 0 && record.sessionId.length <= 256
    && Number.isSafeInteger(record.seq) && (record.seq as number) >= 0;
}

export const OBSERVATION_LIMITS = Object.freeze({
  maxViews: 16,
  maxQueuedEvents: 256,
  maxQueuedElementBytes: 1_048_576,
  batchEvents: 32,
  maxInFlightEvents: 64,
  journalBytes: 2_097_152,
  journalLineBytes: 16_384,
  journalReadBytes: 65_536,
  maxEditCells: 500,
  maxValueChars: 2_000,
  maxTextLines: 5_000,
  pollMs: 40,
  debounceMs: 80,
  settleMs: 40,
  settleAttempts: 8,
});

export interface DocumentObservationEngine {
  readonly id: string;
  prepare?(format: PreviewAnyFormat, signal: AbortSignal, context?: DocumentObservationEngineContext): Promise<void>;
  parse(bytes: Buffer, format: PreviewAnyFormat | "text", selectionIndex: number, signal: AbortSignal,
    context?: DocumentObservationEngineContext): Promise<ObservedDocument>;
  releaseSession?(sessionId: string): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

/** Host-owned parse admission can be retained across conversion and output decoding. */
export interface DocumentObservationEngineContext {
  sessionId: string;
  parse?: <F extends PreviewAnyFormat>(bytes: Buffer, format: F, selectionIndex: number, signal: AbortSignal) => Promise<PreviewDocumentFor<F>>;
}
