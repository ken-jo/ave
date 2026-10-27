import type { PreviewDocumentFormat, PreviewTableDocument } from "./preview-document.js";
import type { EgressGrantScope } from "./egress-grant-scopes.js";
import type { EgressDecisionBasis } from "../audit/sandbox-audit.js";

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
export type ObservedDocument = PreviewTableDocument | PreviewObservedTextDocument;
export type DocumentObservationEvent =
  | DocumentEventBase & { kind: "element"; element: { kind: "cell"; sheet: string; row: number; column: number }
    | { kind: "line"; line: number };
    before: string; after: string; advisory: boolean }
  | DocumentEventBase & { kind: "snapshot"; before: null; after: ObservedDocument }
  | DocumentEventBase & { kind: "status"; before: null; after: { code: DocumentObservationStatus } };

export interface TerminalObservationDecision {
  kind: "egress";
  host: string;
  port: number | null;
  decision: "allow" | "deny";
  basis: EgressDecisionBasis;
  scope: EgressGrantScope | null;
  reason: string | null;
  attribution: "command" | "terminal-session";
  ts: number;
}

export interface TerminalObservedCommand {
  id: string;
  toolUseId: string;
  turnId: string;
  kind: "shell" | "terminal";
  command: string;
  cwd: string;
  tabId?: string;
  terminalSessionId?: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  exitCode: number | null;
  outputTail: string;
  outputTruncated: boolean;
  sandbox: { mode: "isolated" | "unconfined" | "disposable"; detail: string };
  outputAvailability: "streaming" | "on-completion";
  decisions: TerminalObservationDecision[];
}

interface TerminalEventBase extends ObservationEventEnvelope { source: "terminal" }
export type TerminalObservationEvent =
  | TerminalEventBase & { kind: "snapshot"; before: null; after: { commands: TerminalObservedCommand[] } }
  | TerminalEventBase & { kind: "status"; before: null; after: { code: "resync-required" | "observation-error" } };
export type AgentObservationEvent = DocumentObservationEvent | TerminalObservationEvent;

export interface DocumentObservationBinding { targetId: string; sessionId: string; seq: number }
export interface DocumentObservationAck {
  action: "rendered" | "release";
  targetId: string;
  sessionId: string;
  seq: number;
}

export type TerminalObservationRequest = { action: "subscribe-terminal"; sessionId: string } | DocumentObservationAck;
export interface TerminalObservationResponse {
  ok: boolean;
  error?: string;
  observation?: DocumentObservationBinding;
}

export function isTerminalObservationSubscription(value: unknown): value is Extract<TerminalObservationRequest, { action: "subscribe-terminal" }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.action === "subscribe-terminal"
    && typeof record.sessionId === "string" && record.sessionId.length > 0 && record.sessionId.length <= 256;
}

export const TERMINAL_OBSERVATION_LIMITS = Object.freeze({
  maxSessions: 16,
  maxCommands: 32,
  maxOutputChars: 4096,
  maxCommandChars: 4096,
  maxCwdChars: 2048,
  maxDecisions: 16,
  maxPendingChars: 8192,
  flushMs: 80,
});

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
  parse(bytes: Buffer, format: PreviewDocumentFormat | "text", sheetIndex: number, signal: AbortSignal): Promise<ObservedDocument>;
}
