import type { PreviewTableDocument } from "./preview-document.js";
import type { PreviewAnyFormat, PreviewDocumentFor, PreviewPageDocument, PreviewDocumentElement } from "./preview-page-document.js";

export type ObservationSource = "document" | "browser" | "terminal";
export interface ObservationTarget { id: string; path: string; hostSessionId?: string }
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

export type BrowserObservationAction = "navigate" | "click" | "type" | "tab-open" | "tab-close" | "tab-switch"
  | "download" | "hover" | "drag" | "select" | "scroll" | "upload" | "press-key";
export interface BrowserObservationElement { ref: string; role: string; name: string; redacted: boolean }
export interface BrowserObservationDetail {
  action: BrowserObservationAction;
  tabId: string;
  rendererTabId: string | null;
  url: string;
  title: string;
  element?: BrowserObservationElement;
  download?: { state: "started" | "completed" | "cancelled" | "interrupted" };
}
export type BrowserObservationEvent = { target: ObservationTarget & { hostSessionId: string } } & (
  | ObservationEventEnvelope & { source: "browser"; kind: "action"; before: null; after: BrowserObservationDetail }
  | ObservationEventEnvelope & { source: "browser"; kind: "status"; before: null;
    after: { code: "resync-required" | "observation-error" | "session-cleared" } });
export type AgentObservationEvent = DocumentObservationEvent | BrowserObservationEvent;

/**
 * Transient live preview of an agent-driven tab. Frames never enter the daemon, its queues, event history or any file;
 * the renderer keeps only the newest frame per browser target while its preview element is visible.
 */
export interface BrowserObservationPreviewRequest {
  action: "start" | "stop" | "rendered";
  targetId: string;
  sessionId: string;
  /** Main-issued tab handle from an agent action event for this target. */
  tabId: string;
  /** The rendered frame number for `rendered`; 0 otherwise. */
  frame: number;
}
interface BrowserObservationPreviewBase { targetId: string; sessionId: string; tabId: string }
export type BrowserObservationPreviewMessage = BrowserObservationPreviewBase & (
  | { kind: "frame"; frame: number; mimeType: "image/jpeg"; data: string; width: number; height: number; ts: number }
  | { kind: "state"; state: "updating" | "stopped" | "error" });

export function isBrowserObservationPreviewRequest(value: unknown): value is BrowserObservationPreviewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 5
    && (record.action === "start" || record.action === "stop" || record.action === "rendered")
    && typeof record.targetId === "string" && /^[a-f0-9-]{36}$/.test(record.targetId)
    && typeof record.sessionId === "string" && record.sessionId.length > 0 && record.sessionId.length <= 256
    && typeof record.tabId === "string" && /^tab-\d+$/.test(record.tabId)
    && Number.isSafeInteger(record.frame) && (record.frame as number) >= 0
    && (record.action === "rendered" || record.frame === 0);
}

export interface ObservationBinding { targetId: string; sessionId: string; seq: number }
export interface ObservationAck {
  action: "rendered" | "release";
  targetId: string;
  sessionId: string;
  seq: number;
}

export function isObservationAck(value: unknown): value is ObservationAck {
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
  browserHistoryEvents: 64,
  browserTextChars: 256,
  browserUrlChars: 2_048,
  /** Live preview bounds: JPEG at most 640x400, at most 4 forwarded frames per second, one unrendered frame in flight. */
  previewMaxWidth: 640,
  previewMaxHeight: 400,
  previewJpegQuality: 60,
  previewMinFrameIntervalMs: 250,
  previewMaxFrameChars: 400_000,
  /** Re-arm the screencast when a visible preview receives no frame for this long. */
  previewSilenceMs: 2_000,
  /** Uniform frames this soon after a main-frame commit keep the previous real frame marked as updating. */
  previewCommitBlankMs: 1_500,
  /** A preview parks this long after the agent's last command on the tab ends. */
  previewIdleMs: 30_000,
  maxPreviews: 4,
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
