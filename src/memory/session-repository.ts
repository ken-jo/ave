import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveConversationTitle, unwrapStagedText } from "../shared/conversation-title.js";
import { stripStagedEnvelopeTags } from "../shared/staged-origins.js";
import { readBoundedTextWindow } from "../shared/bounded-tool-output.js";
import { ToolOutputArtifactStore } from "./tool-output-artifact-store.js";
import { deleteCodeCheckpoints } from "./code-checkpoints.js";
import { MAX_TOOL_RESULT_ARTIFACT_BYTES, MAX_TOOL_OUTPUT_PREVIEW_CHARS, normalizeToolOutputArtifactInfo, type ToolOutputCapture, type ToolOutputArtifactInfo } from "../shared/tool-output-artifact.js";
import { isValidSessionId } from "../shared/session-id.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync, isMissingPathError, syncExistingFileSync } from "../lib/atomic-file.js";
import { isSessionTaskItem, type SessionTaskItem } from "../shared/session-tasks.js";
import { isSessionGoal, type SessionGoal } from "../shared/session-goal.js";
import { createLogger } from "../lib/logger.js";
import { aveHome } from "../shared/ave-home.js";
import { sessionStorePath } from "../shared/session-store-path.js";
import { t } from "../i18n/index.js";
import { projectRootEquals, projectRootKey } from "../shared/project-identity.js";
import { parseWorkBoardOriginSessionId } from "../shared/work-board-types.js";
import type { CheckpointTrigger } from "./memory-manager.js";
import type { SessionFamily, SessionKind, SessionListRow } from "../shared/session-lookup.js";
import { maskSensitiveData } from "../shared/dlp.js";
import {
  A2ATaskState,
  A2A_HANDLER_ID_PATTERN,
  A2A_PROJECTED_TASK_STATE_VALUES,
  isA2ATerminalTaskState,
  type A2AProjectedTaskState,
} from "../shared/a2a.js";
import type { SubAgentSuspensionReason } from "../shared/subagent-events.js";
import {
  buildToolResultStrippedStub,
  buildToolResultTruncatedStub,
  type ToolResultArtifactUnavailableInfo,
  isToolResultStubContent,
  type ToolResultTruncatedInfo,
} from "../shared/tool-result-stub.js";
import { SessionSearchIndex, type IndexedSessionInput } from "./session-search-index.js";
import { isRecord } from "../shared/is-record.js";
import { dlpSafeCandidate, isSafeStructuralId } from "../shared/dlp-safe-id.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { parseJsonlLines } from "../audit/jsonl-reader.js";
import {
  appendJsonlRecords,
  orderToolResultRows,
  parseTurnInflightRecord,
  recoverInterruptedTurn,
  removeTurnInflightRecord,
  rowIdsOf,
  sessionProgressRows,
  turnInflightPath,
  writeTurnInflightRecord,
  type TurnInflightPartial,
} from "./session-turn-journal.js";

const log = createLogger("memory");
// Track written row ids plus file size and mtime; append completion-order results only while the prior prefix remains valid.
const transcriptWriteStates = new Map<string, { ids: string[]; size: number; mtimeMs: number }>();
// A process-local open journal marks a live turn; never recover its sidecar as an orphan.
const liveTurnJournals = new Map<string, number>();
// Auxiliary managers can share the same host-owned session directory.
const unpublishedCapturesByDirectory = new Map<string, Map<string, Set<string>>>();

export interface FileSnapshot {
  content: string;
  mtime: Date;
  mtimeMs: number;
  size: number;
  tooLarge: boolean;
}

function statPathIfPresent(path: string): Omit<FileSnapshot, "content" | "tooLarge"> | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    return { mtime: stat.mtime, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function readdirIfPresent(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (err) {
    if (isMissingPathError(err)) return [];
    throw err;
  }
}

export function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isMissingPathError(err)) throw err;
  }
}

export function sha256Text(content: string): string {
  return sha256Hex(content);
}

export function normalizeMetadataString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxChars) : undefined;
}

export const MAX_PROJECT_ROOT_CHARS = 2_048;

export const MAX_PROJECT_NAME_CHARS = 120;

export function getFileMtimeMs(path: string): number {
  try {
    return statPathIfPresent(path)?.mtimeMs ?? -1;
  } catch {
    return -1;
  }
}

function readUtf8FileIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
}

export interface SessionSearchEntry {
  sessionId: string;
  title?: string;
  matchedMessage: string;
  timestamp: string;
  sessionKind: SessionKind;
}

export interface ToolResultArtifact {
  toolUseId: string;
  toolName?: string;
  content: string;
  truncated: ToolResultTruncatedInfo;
  sha256: string;
  createdAt: string;
}

// Session family depends on the owning store as well as metadata; identical kinds can name different namespaces.
export type SessionNamespace = "main" | "side-chat" | "subagent";

// Classify spawned conversations from their host-written origin.
export function sessionFamilyOf(
  namespace: SessionNamespace,
  session: Pick<SessionListEntry, "sessionKind" | "workBoardItemId" | "originSessionId">,
): SessionFamily | null {
  if (namespace === "side-chat") return "side-chat";
  if (namespace === "subagent") {
    return session.workBoardItemId !== undefined ? "work-board" : isValidSessionId(session.originSessionId) ? "subagent" : null;
  }
  if (session.sessionKind === "main") return "main";
  if (session.sessionKind === "routine") return "routine";
  return null;
}

// Assemble one shared conversation row for sidebar and panel consumers.
export function toSessionListRow(
  namespace: SessionNamespace,
  session: SessionListEntry,
): SessionListRow | null {
  const family = sessionFamilyOf(namespace, session);
  if (family === null) return null;
  return {
    id: session.id,
    modifiedAt: session.modifiedAt.toISOString(),
    title: session.title,
    ...(session.preview ? { preview: session.preview.slice(0, 200) } : {}),
    sessionKind: session.sessionKind,
    family,
    ...(session.workBoardItemId !== undefined ? { workBoardItemId: session.workBoardItemId } : {}),
    // Reuse the host-written conversation origin; checkpoint ancestry is separate.
    ...((family === "side-chat" || family === "subagent") && session.originSessionId
      ? { originSessionId: session.originSessionId }
      : {}),
    ...(family === "side-chat" && session.paneTabId ? { paneTabId: session.paneTabId } : {}),
    ...(session.routineId ? { routineId: session.routineId } : {}),
    ...(session.routineTitle ? { routineTitle: session.routineTitle } : {}),
    ...(session.routineFiredAt ? { routineFiredAt: session.routineFiredAt } : {}),
    ...(session.projectRoot ? { projectRoot: session.projectRoot } : {}),
    ...(session.projectName ? { projectName: session.projectName } : {}),
    ...(session.branchedFromCompactNum !== undefined
      ? { branchedFromCompactNum: session.branchedFromCompactNum }
      : {}),
    ...(session.branchedAt ? { branchedAt: session.branchedAt } : {}),
    ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
    ...(session.unreadSince ? { unreadSince: session.unreadSince } : {}),
  };
}

// Restore only panel row fields; load the child transcript separately on demand.
export interface RestoredSubAgentSession {
  spawnId: string;
  childSessionId: string;
  title: string;
  modifiedAt: Date;
  taskState?: A2AProjectedTaskState;
  toolUseId?: string;
}

export interface ListSessionsOptions {
  kind?: SessionKind | "all";
  // True selects item runs; false selects children with a conversation origin.
  workBoardRuns?: boolean;
  routineId?: string;
  projectRoot?: string;
  includeUnscoped?: boolean;
  limit?: number;
  before?: Date;
  beforeId?: string;
  after?: Date;
}

export interface MainActiveSessionState {
  mainActiveSessionId: string | null;
  mainActiveMode: "resume" | "fresh";
  updatedAt: string;
}

export interface SessionListEntry {
  id: string;
  modifiedAt: Date;
  title: string;
  preview: string;
  sessionKind: SessionKind;
  // Derive workBoardItemId only from a host-created run origin.
  workBoardItemId?: number;
  // The host-written terminal or page identity, kept in side-chat list rows.
  paneTabId?: string;
  // Carry conversation origins only when they are valid session ids; item origins use workBoardItemId.
  originSessionId?: string;
  routineId?: string;
  routineTitle?: string;
  routineFiredAt?: string;
  projectRoot?: string;
  projectName?: string;
  // Fork provenance is not chronological continuity and must not drive previous-session loading.
  parentSessionId?: string;
  branchedFromCompactNum?: number;
  archivedAt?: string;
  unreadSince?: string;
  branchedAt?: string;
}

export interface Checkpoint {
  id: string;
  triggeredAt: string;
  trigger: CheckpointTrigger;
  // Trigger-time usage ratio determines checkpoint summary depth.
  ctxUsageAtTrigger: number;
  // No summary below the minimum context threshold; compact checkpoints store the rendered boundary preamble.
  summary: string | null;
  messageCountAtTrigger: number;
  compactNum?: number;
}

// Metadata may be partial; missing kind normalizes without inferring chronological continuity.
export interface SessionMetadata {
  sessionKind?: SessionKind;
  routineId?: string;
  routineTitle?: string;
  routineFiredAt?: string;
  projectRoot?: string;
  projectName?: string;
  parentSessionId?: string;
  // Bound the inherited rolling summary on write.
  summaryPreamble?: string;
  checkpoints?: Checkpoint[];
  // Explicit titles override derived titles and share their length cap.
  title?: string;
  // The archive timestamp is the flag; absence means unarchived.
  archivedAt?: string;
  // Unread is user-managed; no automatic reader clears it.
  unreadSince?: string;
  // Host-written pane identity restores the newest unarchived match and clears when the pane starts fresh.
  paneTabId?: string;
  branchedFromCompactNum?: number;
  branchedAt?: string;
  // Resume must restore the frozen permission scope from child-only host-written metadata.
  sourceTools?: string[];
  profileModel?: string;
  profileMode?: string;
  /** Parent chat session or host-minted internal A2A origin bound to this child. */
  originSessionId?: string;
  /** Host-only A2A profile handler id. Never populated from remote context ids. */
  a2aWireHandlerId?: string;
  /** Host-minted A2A origin; must match originSessionId for wire-bound tasks. */
  a2aWireInternalOrigin?: string;
  originToolUseId?: string;
  spawnId?: string;
  // Keep the sub-agent display title separate from the capped session-list title.
  subAgentTitle?: string;
  // Only budget continuations spend MAX_RESUMES.
  budgetResumeCount?: number;
  /** Number of question answers accepted; independent from MAX_RESUMES. */
  questionAnswerCount?: number;
  // Legacy and current resume counters fail closed on the greater compatible value.
  resumeCount?: number;
  // Count assistant rounds cumulatively across spawn and every resume segment.
  cumulativeRounds?: number;
  /** Last durable A2A projection. Only INPUT_REQUIRED is resumable. */
  subAgentTaskState?: A2AProjectedTaskState;
  subAgentSuspensionReason?: SubAgentSuspensionReason;
  subAgentSuspensionPrompt?: string;
  // Completed tasks remain in list order; completion changes state rather than deleting rows.
  tasks?: SessionTaskItem[];
  // Persist goal revival rounds so restart cannot reset the budget.
  goal?: SessionGoal;
}

function asTerminalA2ATaskState(value: unknown): A2AProjectedTaskState | undefined {
  if (
    typeof value !== "string"
    || !(A2A_PROJECTED_TASK_STATE_VALUES as readonly string[]).includes(value)
  ) {
    return undefined;
  }
  const state = value as A2AProjectedTaskState;
  return isA2ATerminalTaskState(state) ? state : undefined;
}

function hasA2AWireIdentity(metadata: Partial<SessionMetadata>): boolean {
  return metadata.a2aWireHandlerId !== undefined
    || metadata.a2aWireInternalOrigin !== undefined;
}

interface DetachedWireTerminalTombstone {
  taskState: A2AProjectedTaskState;
  handlerId: string;
  internalOrigin: string;
  originSessionId: string;
  sourceTools: string[];
  subAgentTitle?: string;
}

function detachProjectBinding<T extends object>(
  metadata: T,
  terminalTombstone?: A2AProjectedTaskState,
): T {
  const next = { ...metadata } as T & Partial<SessionMetadata>;
  delete next.projectRoot;
  delete next.projectName;

  if (hasA2AWireIdentity(next)) {
    // Workspace removal cancels only live tasks; preserve the first terminal projection across restart.
    next.subAgentTaskState = asTerminalA2ATaskState(terminalTombstone)
      ?? asTerminalA2ATaskState(next.subAgentTaskState)
      ?? A2ATaskState.CANCELED;
    delete next.subAgentSuspensionReason;
    delete next.subAgentSuspensionPrompt;
  }

  return next;
}

function applyDetachedWireTerminalTombstone<T extends object>(
  metadata: T,
  tombstone: DetachedWireTerminalTombstone,
): T {
  return detachProjectBinding(
    {
      ...metadata,
      sessionKind: "subagent",
      sourceTools: [...tombstone.sourceTools],
      originSessionId: tombstone.originSessionId,
      a2aWireHandlerId: tombstone.handlerId,
      a2aWireInternalOrigin: tombstone.internalOrigin,
      ...(tombstone.subAgentTitle !== undefined
        ? { subAgentTitle: tombstone.subAgentTitle }
        : {}),
    },
    tombstone.taskState,
  );
}
const MAX_SESSION_TITLE_CHARS = 80;

// Own session-file limits here and share them with import validation.
export const MAX_SESSION_FILE_BYTES = 5_000_000;
const MAX_SUMMARY_PREAMBLE_CHARS = 8_000;
const MAX_A2A_WIRE_ID_CHARS = 256;
const ACTIVE_SESSION_STATE_FILE = ".active-session.json";

// Child origins may name a parent session or work-board item; conversation readers still require session ids.
function isPersistedOriginSessionId(id: unknown): id is string {
  return isValidSessionId(id) || parseWorkBoardOriginSessionId(id) !== null;
}
function isValidA2AWireHandlerId(id: unknown): id is string {
  return typeof id === "string"
    && A2A_HANDLER_ID_PATTERN.test(id)
    && maskSensitiveData(id).detections.length === 0;
}
function isValidA2AWireMetadataId(id: unknown): id is string {
  return isValidSessionId(id)
    && id.length <= MAX_A2A_WIRE_ID_CHARS
    && isSafeStructuralId(id);
}

// Keep collision and DLP retry budgets independent; identity collisions do not imply sensitive digests.
const LEGACY_ROW_ID_MAX_DLP_ATTEMPTS = 8;
const LEGACY_ROW_ID_MAX_COLLISION_ATTEMPTS = 64;

// Derive ids for unlabelled disk rows deterministically; live in-memory rows use the separate random minter.
function legacyRowId(sessionId: string, index: number, taken: ReadonlySet<string>): string {
  for (let collision = 0; collision < LEGACY_ROW_ID_MAX_COLLISION_ATTEMPTS; collision += 1) {
    const candidate = dlpSafeCandidate((dlpAttempt) => {
      // Keep the candidate counter flat so existing deterministic ids remain stable.
      const step = collision * LEGACY_ROW_ID_MAX_DLP_ATTEMPTS + dlpAttempt;
      const digest = sha256Hex(`${sessionId}:${index}:${step}`)
        .slice(0, 32);
      return `row-${digest}`;
    }, LEGACY_ROW_ID_MAX_DLP_ATTEMPTS);
    // Null means every generated candidate failed DLP; another collision round cannot help.
    if (candidate === null) break;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("[legacy-row-id] could not derive a redaction-safe row identity");
}

// Recovered rows need deterministic ids so independent readers agree before persistence.
function derivedRowId(sessionId: string, seed: string): string {
  const candidate = dlpSafeCandidate(
    (attempt) => `row-${sha256Hex(`${sessionId}:${seed}:${attempt}`).slice(0, 32)}`,
    LEGACY_ROW_ID_MAX_DLP_ATTEMPTS,
  );
  if (candidate === null) throw new Error("[derived-row-id] could not derive a redaction-safe row identity");
  return candidate;
}

// Independent history and resume readers must derive the same identity for legacy rows.
function stampLegacyRowIds(sessionId: string, messages: unknown[]): unknown[] {
  const taken = new Set<string>();
  const keepsOwnId = new Array<boolean>(messages.length).fill(false);

  // Reserve every stored id before deriving any; synthetic earlier rows must not displace durable later ids.
  messages.forEach((message, index) => {
    if (!isRecord(message)) return;
    const meta = isRecord(message.meta) ? message.meta : undefined;
    const existing = meta?.messageId;
    if (typeof existing !== "string" || existing.length === 0) return;
    // A file can still carry the same id twice; there the first occurrence keeps
    // it and the rest are re-minted below.
    if (taken.has(existing)) return;
    taken.add(existing);
    keepsOwnId[index] = true;
  });

  return messages.map((message, index) => {
    if (!isRecord(message) || keepsOwnId[index]) return message;
    const meta = isRecord(message.meta) ? message.meta : undefined;
    const messageId = legacyRowId(sessionId, index, taken);
    taken.add(messageId);
    return { ...message, meta: { ...(meta ?? {}), messageId } };
  });
}

function isCompactBoundaryRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const meta = isRecord(value.meta) ? value.meta : {};
  return value.role === "user" && meta.compactBoundary === true;
}

function isRenderableUserRecord(value: unknown): value is Record<string, unknown> & {
  role: "user";
  content: unknown;
} {
  return isRecord(value) && value.role === "user" && "content" in value && !isCompactBoundaryRecord(value);
}

function findLatestRenderableUserRecord(messages: readonly unknown[]): unknown | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isRenderableUserRecord(message)) return message;
  }
  return null;
}

function isToolResultRecord(value: unknown): value is Record<string, unknown> & {
  role: "tool_result";
  toolUseId: string;
  content: string;
} {
  return (
    isRecord(value) &&
    value.role === "tool_result" &&
    typeof value.toolUseId === "string" &&
    typeof value.content === "string"
  );
}

function normalizeTruncatedInfo(value: unknown): ToolResultTruncatedInfo | null {
  if (!isRecord(value)) return null;
  const { originalLines, originalTokens, originalBytes, trimmedAt } = value;
  if (
    typeof originalLines !== "number" ||
    typeof originalTokens !== "number" ||
    typeof originalBytes !== "number" ||
    !Number.isFinite(originalLines) ||
    !Number.isFinite(originalTokens) ||
    !Number.isFinite(originalBytes)
  ) return null;
  return {
    originalLines,
    originalTokens,
    originalBytes,
    trimmedAt: typeof trimmedAt === "string" ? trimmedAt : new Date(0).toISOString(),
  };
}

function normalizeArtifactUnavailable(value: unknown): ToolResultArtifactUnavailableInfo | null {
  if (!isRecord(value)) return null;
  if (value.reason !== "artifact-too-large") return null;
  if (typeof value.maxBytes !== "number" || !Number.isFinite(value.maxBytes) || value.maxBytes <= 0) {
    return null;
  }
  return { reason: "artifact-too-large", maxBytes: value.maxBytes };
}

function toolUseArtifactKey(toolUseId: string): string {
  return sha256Hex(toolUseId).slice(0, 32);
}

const VALID_CHECKPOINT_TRIGGERS = new Set<CheckpointTrigger>([
  "auto-compact",
  "manual",
]);

function normalizeSessionKind(value: unknown): SessionKind {
  if (value === "main" || value === "routine" || value === "subagent") return value;
  return "main";
}

// Index string content and multipart text fields so search does not lose readable message text.
function extractSearchableContent(messages: unknown[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    const message = raw as Record<string, unknown>;
    const content = message?.content;
    if (typeof content === "string") {
      if (content.trim().length > 0) parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join("\n");
}

function matchesSessionScope(
  metadata: SessionMetadata | null,
  options: Pick<ListSessionsOptions, "kind" | "workBoardRuns" | "routineId" | "projectRoot" | "includeUnscoped">,
): boolean {
  const kind = options.kind ?? "main";
  const sessionKind = metadata?.sessionKind ?? normalizeSessionKind(undefined);
  if (kind !== "all" && sessionKind !== kind) return false;
  if (
    options.workBoardRuns === true &&
    (sessionKind !== "subagent" || parseWorkBoardOriginSessionId(metadata?.originSessionId) === null)
  ) return false;
  // Ordinary child rows need a conversation origin; board and unattributed sessions stay internal.
  if (options.workBoardRuns === false && !isValidSessionId(metadata?.originSessionId)) return false;
  if (options.routineId !== undefined && metadata?.routineId !== options.routineId) return false;
  if (
    options.projectRoot !== undefined &&
    !projectRootEquals(metadata?.projectRoot, options.projectRoot) &&
    !(options.includeUnscoped === true && metadata?.projectRoot === undefined)
  ) return false;
  return true;
}

function normalizeCheckpoint(raw: unknown): Checkpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  if (typeof r.triggeredAt !== "string") return null;
  if (!VALID_CHECKPOINT_TRIGGERS.has(r.trigger as CheckpointTrigger)) return null;
  const ctxUsage = r.ctxUsageAtTrigger;
  if (typeof ctxUsage !== "number" || ctxUsage < 0 || ctxUsage > 1) return null;
  if (r.summary !== null && typeof r.summary !== "string") return null;
  const msgCount = r.messageCountAtTrigger;
  if (typeof msgCount !== "number" || msgCount < 0 || !Number.isInteger(msgCount)) return null;

  const compactNum =
    typeof r.compactNum === "number" && r.compactNum >= 0 && Number.isInteger(r.compactNum)
      ? r.compactNum
      : undefined;
  return {
    id: r.id,
    triggeredAt: r.triggeredAt,
    trigger: r.trigger as CheckpointTrigger,
    ctxUsageAtTrigger: ctxUsage,
    summary: r.summary as string | null,
    messageCountAtTrigger: msgCount,
    ...(compactNum !== undefined && { compactNum }),
  };
}

// Missing or invalid kind becomes main without routine inference; discard invalid checkpoint entries individually.
function normalizeSessionMetadata(raw: Record<string, unknown>): SessionMetadata {
  const checkpointsRaw = Array.isArray(raw.checkpoints) ? raw.checkpoints : undefined;
  const checkpoints: Checkpoint[] | undefined = checkpointsRaw
    ? (checkpointsRaw.map(normalizeCheckpoint).filter((c): c is Checkpoint => c !== null))
    : undefined;

  const rawPreamble = typeof raw.summaryPreamble === "string" ? raw.summaryPreamble : undefined;
  const rawTitle = typeof raw.title === "string" ? raw.title.trim() : undefined;
  const rawBranchedFromCompactNum = typeof raw.branchedFromCompactNum === "number" && Number.isInteger(raw.branchedFromCompactNum) && raw.branchedFromCompactNum >= 0
    ? raw.branchedFromCompactNum
    : undefined;
  const rawBranchedAt = typeof raw.branchedAt === "string" ? raw.branchedAt : undefined;
  const routineId = typeof raw.routineId === "string" ? raw.routineId : undefined;
  const projectRoot = normalizeMetadataString(raw.projectRoot, MAX_PROJECT_ROOT_CHARS);
  const projectName = normalizeMetadataString(raw.projectName, MAX_PROJECT_NAME_CHARS);
  // Invalid child resume fields become undefined so malformed metadata cannot widen the frozen permission scope.
  const sourceTools = Array.isArray(raw.sourceTools)
    ? raw.sourceTools.filter((n): n is string => typeof n === "string")
    : undefined;
  const profileModel = typeof raw.profileModel === "string" ? raw.profileModel : undefined;
  const profileMode = typeof raw.profileMode === "string" ? raw.profileMode : undefined;
  const originSessionId = isPersistedOriginSessionId(raw.originSessionId) ? raw.originSessionId : undefined;
  const subAgentTaskState = typeof raw.subAgentTaskState === "string"
    && (A2A_PROJECTED_TASK_STATE_VALUES as readonly string[]).includes(raw.subAgentTaskState)
    ? raw.subAgentTaskState as A2AProjectedTaskState
    : undefined;
  const hasA2AWireHandlerId = raw.a2aWireHandlerId !== undefined;
  const hasA2AWireInternalOrigin = raw.a2aWireInternalOrigin !== undefined;
  let a2aWireHandlerId: string | undefined;
  let a2aWireInternalOrigin: string | undefined;
  const isDetachedA2AWireTask = projectRoot === undefined
    && subAgentTaskState !== undefined
    && isA2ATerminalTaskState(subAgentTaskState)
    && raw.subAgentSuspensionReason === undefined
    && raw.subAgentSuspensionPrompt === undefined;
  if (hasA2AWireHandlerId || hasA2AWireInternalOrigin) {
    if (
      !hasA2AWireHandlerId
      || !hasA2AWireInternalOrigin
      || !isValidA2AWireHandlerId(raw.a2aWireHandlerId)
      || !isValidA2AWireMetadataId(raw.a2aWireInternalOrigin)
      || raw.a2aWireInternalOrigin !== originSessionId
      || (projectRoot === undefined && !isDetachedA2AWireTask)
      || !Array.isArray(raw.sourceTools)
      || !raw.sourceTools.every((tool) =>
        typeof tool === "string" && tool.length > 0 && tool.length <= 256)
    ) {
      throw new Error("invalid A2A wire binding metadata (a2a-wire-binding-invalid)");
    }
    a2aWireHandlerId = raw.a2aWireHandlerId;
    a2aWireInternalOrigin = raw.a2aWireInternalOrigin;
  }
  const originToolUseId = normalizeMetadataString(raw.originToolUseId, 256);
  const spawnId = normalizeMetadataString(raw.spawnId, 128);
  const subAgentTitle = normalizeMetadataString(raw.subAgentTitle, MAX_PROJECT_NAME_CHARS);
  const resumeCount = typeof raw.resumeCount === "number" && Number.isInteger(raw.resumeCount) && raw.resumeCount >= 0
    ? raw.resumeCount
    : undefined;
  const budgetResumeCount = typeof raw.budgetResumeCount === "number" && Number.isInteger(raw.budgetResumeCount) && raw.budgetResumeCount >= 0
    ? raw.budgetResumeCount
    : undefined;
  const questionAnswerCount = typeof raw.questionAnswerCount === "number" && Number.isInteger(raw.questionAnswerCount) && raw.questionAnswerCount >= 0
    ? raw.questionAnswerCount
    : undefined;
  const cumulativeRounds = typeof raw.cumulativeRounds === "number" && Number.isInteger(raw.cumulativeRounds) && raw.cumulativeRounds >= 0
    ? raw.cumulativeRounds
    : undefined;
  const subAgentSuspensionReason = raw.subAgentSuspensionReason === "budget"
    || raw.subAgentSuspensionReason === "question"
    ? raw.subAgentSuspensionReason
    : undefined;
  const subAgentSuspensionPrompt = normalizeMetadataString(
    raw.subAgentSuspensionPrompt,
    MAX_SUMMARY_PREAMBLE_CHARS,
  );
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.filter(isSessionTaskItem).map((item) => ({
        id: item.id,
        content: item.content,
        status: item.status,
      }))
    : [];
  // Treat goals as all-or-nothing records; partial records cannot account for revival budgets.
  const goal = isSessionGoal(raw.goal)
    ? {
        text: raw.goal.text,
        status: raw.goal.status,
        round: raw.goal.round,
        ceiling: raw.goal.ceiling,
        createdAt: raw.goal.createdAt,
        updatedAt: raw.goal.updatedAt,
      }
    : undefined;
  return {
    sessionKind: normalizeSessionKind(raw.sessionKind),
    routineId,
    routineTitle: typeof raw.routineTitle === "string" ? raw.routineTitle : undefined,
    routineFiredAt: typeof raw.routineFiredAt === "string" ? raw.routineFiredAt : undefined,
    projectRoot,
    projectName,
    parentSessionId: isValidSessionId(raw.parentSessionId) ? raw.parentSessionId : undefined,
    summaryPreamble: rawPreamble !== undefined
      ? rawPreamble.slice(0, MAX_SUMMARY_PREAMBLE_CHARS)
      : undefined,
    checkpoints: checkpoints && checkpoints.length > 0 ? checkpoints : undefined,
    title: rawTitle && rawTitle.length > 0 ? rawTitle.slice(0, MAX_SESSION_TITLE_CHARS) : undefined,
    branchedFromCompactNum: rawBranchedFromCompactNum,
    branchedAt: rawBranchedAt,
    sourceTools: a2aWireHandlerId !== undefined
      ? sourceTools
      : sourceTools && sourceTools.length > 0
        ? sourceTools
        : undefined,
    profileModel,
    profileMode,
    originSessionId,
    a2aWireHandlerId,
    a2aWireInternalOrigin,
    originToolUseId,
    spawnId,
    subAgentTitle,
    budgetResumeCount,
    questionAnswerCount,
    resumeCount,
    cumulativeRounds,
    subAgentTaskState,
    subAgentSuspensionReason,
    subAgentSuspensionPrompt,
    tasks: tasks.length > 0 ? tasks : undefined,
    goal,
    archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : undefined,
    unreadSince: typeof raw.unreadSince === "string" ? raw.unreadSince : undefined,
    paneTabId: typeof raw.paneTabId === "string" && raw.paneTabId.length > 0 ? raw.paneTabId : undefined,
  };
}

function parseSessionMetadataObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("session metadata must be an object");
  }
  return parsed;
}

/** Whether stored session metadata belongs to `projectRoot`: the detach and its preview share this. */
function sessionMetadataInProject(parsed: Record<string, unknown>, projectRoot: string): boolean {
  const storedRoot = typeof parsed.projectRoot === "string" ? parsed.projectRoot : undefined;
  return Boolean(storedRoot && projectRootEquals(storedRoot, projectRoot));
}

export class SessionRepository {
  private readonly sessionsDir: string;
  private readonly toolOutputArtifacts: ToolOutputArtifactStore;
  private readonly unpublishedOutputCaptures: Map<string, Set<string>>;
  // Keep one search index per manager namespace, never a global singleton.
  private readonly searchIndex: SessionSearchIndex;
  // Root guards block stale writers until re-add; only newly created sessions may bind again.
  private readonly detachedProjectRoots = new Set<string>();
  // Session tombstones survive root re-add so old conversations remain detached.
  private readonly detachedProjectRootsBySession = new Map<string, Set<string>>();
  private readonly reportedInterruptedTurnFolds = new Set<string>();
  // Capture policy generation before locking to detect detach/re-add ABA races.
  private readonly projectRootGenerations = new Map<string, number>();
  // Retain terminal state and binding together so late writes cannot regress or reclassify detached wire tasks.
  private readonly detachedWireTerminalTombstones = new Map<string, DetachedWireTerminalTombstone>();
  private paneSessions: Map<string, Set<string>> | null = null;
  private get checkpointsDir(): string {
    return join(this.sessionsDir, ".checkpoints");
  }

  private readonly aveDir: string;

  constructor(options?: { aveDir?: string }) {
    this.aveDir = resolve(options?.aveDir ?? aveHome());
    this.sessionsDir = sessionStorePath(this.aveDir);
    this.toolOutputArtifacts = new ToolOutputArtifactStore(this.sessionsDir);
    this.searchIndex = new SessionSearchIndex(this.aveDir);
    mkdirSync(this.sessionsDir, { recursive: true });
    this.restrictSessionsDirWrites();
    const captureOwnerKey = realpathSync(this.sessionsDir);
    this.unpublishedOutputCaptures = unpublishedCapturesByDirectory.get(captureOwnerKey) ?? new Map();
    unpublishedCapturesByDirectory.set(captureOwnerKey, this.unpublishedOutputCaptures);
  }

  private projectRootGeneration(key: string): number {
    return this.projectRootGenerations.get(key) ?? 0;
  }

  // Use a persistent sidecar lock target; touching a missing metadata path during locking could resurrect deleted state.
  private sessionMetadataLockPath(sessionId: string): string {
    return join(this.sessionsDir, ".metadata-locks", `${sessionId}.target`);
  }

  private bumpProjectRootGeneration(key: string): void {
    this.projectRootGenerations.set(key, this.projectRootGeneration(key) + 1);
  }

  private rememberDetachedWireTerminal(
    sessionId: string,
    metadata: Partial<SessionMetadata>,
  ): DetachedWireTerminalTombstone | undefined {
    const existing = this.detachedWireTerminalTombstones.get(sessionId);
    if (existing) return existing;

    const taskState = asTerminalA2ATaskState(metadata.subAgentTaskState);
    if (
      taskState === undefined
      || typeof metadata.a2aWireHandlerId !== "string"
      || typeof metadata.a2aWireInternalOrigin !== "string"
      || typeof metadata.originSessionId !== "string"
      || metadata.a2aWireInternalOrigin !== metadata.originSessionId
      || !Array.isArray(metadata.sourceTools)
    ) {
      return undefined;
    }
    const tombstone: DetachedWireTerminalTombstone = {
      taskState,
      handlerId: metadata.a2aWireHandlerId,
      internalOrigin: metadata.a2aWireInternalOrigin,
      originSessionId: metadata.originSessionId,
      sourceTools: [...metadata.sourceTools],
      ...(metadata.subAgentTitle !== undefined
        ? { subAgentTitle: metadata.subAgentTitle }
        : {}),
    };
    this.detachedWireTerminalTombstones.set(sessionId, tombstone);
    return tombstone;
  }

  closeSearchIndex(): void {
    this.searchIndex.close();
  }

  searchSessions(query: string, options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped"> = {}): SessionSearchEntry[] {
    // Require two code points; exactly two use LIKE because trigram MATCH requires three.
    if ([...query.trim()].length < 2) return [];
    if (!this.searchIndex.open()) return [];
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

  listSessionEntries(limit = 50, options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped"> = {}): SessionSearchEntry[] {
    const UUID_RE = /^[0-9a-f-]{8,}$/i;
    return this.listSessions({ ...options, limit })
      .filter((session) => UUID_RE.test(session.id))
      .map((session) => ({
        sessionId: session.id,
        title: session.title,
        matchedMessage: session.preview,
        timestamp: session.modifiedAt.toISOString(),
        sessionKind: session.sessionKind,
      }));
  }

  async saveSession(sessionId: string, messages: unknown[]): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`saveSession: invalid sessionId "${sessionId}"`);
    }
    const targetPath = join(this.sessionsDir, `${sessionId}.jsonl`);
    await withFileLock(targetPath, async () => {
      this.writeSessionTranscriptLocked(sessionId, targetPath, messages);
    });
    // Whole-history save supersedes orphan recovery state; retain sidecars for locally running turns.
    if (!this.isTurnJournalLive(sessionId)) {
      removeTurnInflightRecord(turnInflightPath(this.sessionsDir, sessionId));
    }
    this.indexSessionForSearch(sessionId, messages);
  }

  // Rewrite through temp, fsync, and rename so crashes retain a complete prior transcript.
  private writeSessionTranscriptLocked(sessionId: string, targetPath: string, messages: unknown[]): void {
    const prepared = this.prepareSessionMessagesForDisk(sessionId, messages);
    const lines = prepared.messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    let unchanged = false;
    try {
      unchanged = readFileSync(targetPath).equals(Buffer.from(lines, "utf8"));
    } catch { /* Write when the existing transcript cannot be compared. */ }
    if (unchanged) {
      try {
        syncExistingFileSync(targetPath);
      } catch {
        // Retry through the atomic writer when in-place durability cannot be confirmed.
        writeUtf8FileAtomicSync(targetPath, lines);
      }
    } else writeUtf8FileAtomicSync(targetPath, lines);
    this.cleanupToolResultArtifacts(sessionId, prepared.keepArtifactKeys);
    this.cleanupToolOutputArtifacts(sessionId, prepared.keepCaptureIds);
    const ids = rowIdsOf(messages);
    const stat = statPathIfPresent(targetPath);
    if (ids && stat) {
      transcriptWriteStates.set(targetPath, { ids, size: stat.size, mtimeMs: stat.mtimeMs });
    } else {
      transcriptWriteStates.delete(targetPath);
    }
  }

  // Append only a valid extension of the last written history; otherwise atomically rewrite from the live reader.
  async appendSessionProgress(
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
        const prepared = this.prepareSessionMessagesForDisk(sessionId, rows);
        const after = await appendJsonlRecords(targetPath, prepared.messages);
        transcriptWriteStates.set(targetPath, { ids, ...after });
        return "appended";
      }
      this.writeSessionTranscriptLocked(sessionId, targetPath, messages);
      return "rewritten";
    });
  }

  // Persist the in-flight marker before the first provider call so any later crash remains recoverable.
  async beginTurnJournal(sessionId: string, startedAt: number): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`beginTurnJournal: invalid sessionId "${sessionId}"`);
    }
    const path = turnInflightPath(this.sessionsDir, sessionId);
    liveTurnJournals.set(path, (liveTurnJournals.get(path) ?? 0) + 1);
    await writeTurnInflightRecord(path, { v: 1, startedAt });
  }

  // Undefined partial content preserves the in-flight marker.
  async writeTurnPartial(sessionId: string, startedAt: number, partial: TurnInflightPartial | undefined): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`writeTurnPartial: invalid sessionId "${sessionId}"`);
    }
    await writeTurnInflightRecord(
      turnInflightPath(this.sessionsDir, sessionId),
      partial ? { v: 1, startedAt, partial } : { v: 1, startedAt },
    );
  }

  // Deregister the turn but retain recovery evidence until persistence is confirmed.
  endTurnJournal(sessionId: string): void {
    if (!isValidSessionId(sessionId)) return;
    const path = turnInflightPath(this.sessionsDir, sessionId);
    const remaining = (liveTurnJournals.get(path) ?? 1) - 1;
    if (remaining > 0) {
      liveTurnJournals.set(path, remaining);
      return;
    }
    liveTurnJournals.delete(path);
  }

  // Remove the sidecar only after its owner confirms the transcript contains the turn.
  clearTurnJournal(sessionId: string): void {
    if (!isValidSessionId(sessionId) || this.isTurnJournalLive(sessionId)) return;
    removeTurnInflightRecord(turnInflightPath(this.sessionsDir, sessionId));
  }

  private isTurnJournalLive(sessionId: string): boolean {
    return liveTurnJournals.has(turnInflightPath(this.sessionsDir, sessionId));
  }

  // Fold only orphaned sidecars into recovered history; live local turns keep their sidecars untouched.
  private withRecoveredInterruptedTurn(sessionId: string, messages: unknown[]): unknown[] {
    if (this.isTurnJournalLive(sessionId)) return messages;
    const raw = readUtf8FileIfPresent(turnInflightPath(this.sessionsDir, sessionId));
    if (raw === null) return messages;
    const record = parseTurnInflightRecord(raw);
    if (!record) {
      log.warn({ sessionId }, "ignoring unreadable turn in-flight record");
      return messages;
    }
    const recovered = recoverInterruptedTurn(
      messages,
      record,
      (seed) => derivedRowId(sessionId, seed),
      { toolResultUnknown: t("be_conversationLoop.hostExitToolResultUnknown") },
    );
    // Every read folds until the next save removes the sidecar; report it once per session.
    if (!this.reportedInterruptedTurnFolds.has(sessionId)) {
      this.reportedInterruptedTurnFolds.add(sessionId);
      log.info("session: recovered an interrupted turn (%d rows -> %d)", messages.length, recovered.length);
    }
    return recovered;
  }

  // Imports require a fresh session id and never overwrite an existing transcript.
  async saveImportedSession(sessionId: string, messages: unknown[]): Promise<void> {
    await this.saveSession(sessionId, messages);
    await this.saveSessionMetadata(sessionId, { sessionKind: "main" });
  }

  // Empty searchable content removes the index row; derive timestamps from transcript mtime, not indexing time.
  private buildIndexInput(sessionId: string, messages: unknown[]): IndexedSessionInput | null {
    const content = extractSearchableContent(messages);
    if (!content) return null;
    const metadata = this.loadSessionMetadata(sessionId);
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

  // Open and close the index per operation so persistence leaves no database handle blocking directory cleanup.
  private indexSessionForSearch(sessionId: string, messages: unknown[]): void {
    if (!this.searchIndex.open()) return;
    try {
      const input = this.buildIndexInput(sessionId, messages);
      if (input) this.searchIndex.upsertSession(input);
      else this.searchIndex.deleteSession(sessionId);
    } finally {
      this.searchIndex.close();
    }
  }
  private deleteSessionFromSearchIndex(sessionId: string): void {
    if (!this.searchIndex.open()) return;
    try {
      this.searchIndex.deleteSession(sessionId);
    } finally {
      this.searchIndex.close();
    }
  }

  // Rebuild the complete search projection after detach so retries repair partial metadata/index updates.
  private repairAllSessionSearchRowsForProjectDetach(): void {
    const dbPath = this.searchIndex.getDbPath();
    this.searchIndex.close();
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(`${dbPath}${suffix}`);
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
      }
      if (!this.searchIndex.open()) {
        throw new Error("search index could not be opened after reset");
      }

      let expectedRows = 0;
      const sessionFiles = readdirIfPresent(this.sessionsDir)
        .filter((file) => file.endsWith(".jsonl"))
        .sort();
      for (const file of sessionFiles) {
        const sessionId = file.slice(0, -".jsonl".length);
        if (!isValidSessionId(sessionId)) continue;
        const messages = this.loadSession(sessionId);
        if (!Array.isArray(messages)) continue;
        const input = this.buildIndexInput(sessionId, messages);
        if (!input) continue;
        this.searchIndex.upsertSession(input);
        expectedRows += 1;
      }
      const actualRows = this.searchIndex.rowCount();
      if (actualRows !== expectedRows) {
        throw new Error(
          `search index row count mismatch (expected ${expectedRows}, got ${actualRows})`,
        );
      }
    } catch (cause) {
      throw Object.assign(
        new Error("workspace session search index repair failed"),
        { code: "SESSION_SEARCH_INDEX_REPAIR_FAILED", cause },
      );
    } finally {
      this.searchIndex.close();
    }
  }

  // Boot integrity repair rebuilds missing or corrupt indexes from JSONL; search never scans as a fallback.
  async verifyOrRebuildSearchIndex(): Promise<void> {
    const opened = this.searchIndex.open();
    // Skip transcript enumeration for healthy populated indexes.
    if (opened && this.searchIndex.rowCount() > 0) {
      this.searchIndex.close();
      return;
    }
    const sessionFiles = this.listSessionJsonlFiles();
    const needsRebuild = !opened || sessionFiles.length > 0;
    if (!needsRebuild) {
      this.searchIndex.close();
      return;
    }
    log.info("search index rebuild starting (%d session file(s))", sessionFiles.length);
    if (opened) {
      this.searchIndex.close();
    }
    await SessionSearchIndex.deleteFile(this.searchIndex.getDbPath());
    if (!this.searchIndex.open()) {
      log.warn("search index rebuild failed: could not reopen index after reset");
      return;
    }
    try {
      const UUID_RE = /^[0-9a-f-]{8,}$/i;
      for (const file of sessionFiles) {
        const stem = file.replace(".jsonl", "");
        if (!UUID_RE.test(stem)) continue;
        const messages = this.loadSession(stem);
        if (!Array.isArray(messages)) continue;
        // Keep one index handle across the bulk rebuild.
        const input = this.buildIndexInput(stem, messages);
        if (input) this.searchIndex.upsertSession(input);
        else this.searchIndex.deleteSession(stem);
      }
      log.info("search index rebuild complete (%d row(s))", this.searchIndex.rowCount());
    } finally {
      this.searchIndex.close();
    }
  }

  private listSessionJsonlFiles(): string[] {
    return readdirIfPresent(this.sessionsDir).filter((file) => file.endsWith(".jsonl"));
  }

  // Store pre-compact snapshots in a separate directory so session listings cannot expose them as conversations.
  async saveCheckpointSnapshot(sessionId: string, compactNum: number, messages: unknown[]): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`saveCheckpointSnapshot: invalid sessionId "${sessionId}"`);
    }
    const sessionSnapshotDir = join(this.checkpointsDir, sessionId);
    mkdirSync(sessionSnapshotDir, { recursive: true });
    const targetPath = join(sessionSnapshotDir, `${compactNum}.jsonl`);
    await withFileLock(targetPath, async () => {
      const prepared = this.prepareSessionMessagesForDisk(sessionId, messages);
      const lines = prepared.messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      writeFileSync(targetPath, lines, "utf-8");
      // Release unpublished artifact pins only after durable checkpoint ownership commits.
      const unpublished = this.unpublishedOutputCaptures.get(sessionId);
      for (const id of prepared.keepCaptureIds) unpublished?.delete(id);
    });
  }

  loadCheckpointSnapshot(sessionId: string, compactNum: number): unknown[] | null {
    if (!isValidSessionId(sessionId)) return null;
    const snapshotPath = join(this.checkpointsDir, sessionId, `${compactNum}.jsonl`);
    const raw = readUtf8FileIfPresent(snapshotPath);
    if (raw === null) return null;
    const messages: unknown[] = [];
    for (const line of parseJsonlLines(raw)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        log.warn({ sessionId, compactNum }, "skipping malformed checkpoint snapshot line");
      }
    }
    return messages.map((message) => this.normalizeStoredOutputCapture(sessionId, message));
  }

  loadSession(sessionId: string): unknown[] | null {
    if (!isValidSessionId(sessionId)) return null;
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    const raw = readUtf8FileIfPresent(path);
    if (raw === null) return null;
    const messages: unknown[] = [];
    for (const line of parseJsonlLines(raw)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        log.warn({ sessionId }, "skipping malformed session line");
      }
    }
    const recovered = this.recoverLatestCheckpointUserIfMissing(
      sessionId,
      this.withRecoveredInterruptedTurn(sessionId, messages),
    );
    return stampLegacyRowIds(sessionId, orderToolResultRows(recovered)
      .map((message) => this.normalizeStoredOutputCapture(sessionId, message)));
  }

  private recoverLatestCheckpointUserIfMissing(sessionId: string, messages: unknown[]): unknown[] {
    if (messages.some(isRenderableUserRecord)) return messages;
    let metadata: SessionMetadata | null = null;
    try {
      metadata = this.loadSessionMetadata(sessionId);
    } catch {
      return messages;
    }
    const checkpoints = metadata?.checkpoints ?? [];
    const latestCompactNum = checkpoints
      .map((checkpoint) => checkpoint.compactNum)
      .filter((compactNum): compactNum is number =>
        typeof compactNum === "number" && Number.isInteger(compactNum) && compactNum >= 0,
      )
      .sort((a, b) => b - a)[0];
    if (latestCompactNum === undefined) return messages;

    const snapshot = this.loadCheckpointSnapshot(sessionId, latestCompactNum);
    if (!snapshot) return messages;
    const latestUser = findLatestRenderableUserRecord(snapshot);
    if (!latestUser) return messages;

    const firstNonBoundaryIndex = messages.findIndex((message) => !isCompactBoundaryRecord(message));
    const insertAt = firstNonBoundaryIndex < 0 ? messages.length : firstNonBoundaryIndex;
    return [
      ...messages.slice(0, insertAt),
      latestUser,
      ...messages.slice(insertAt),
    ];
  }

  loadToolResultArtifact(sessionId: string, toolUseId: string): ToolResultArtifact | null {
    if (!isValidSessionId(sessionId) || typeof toolUseId !== "string" || toolUseId.length === 0) {
      return null;
    }
    const paths = this.toolResultArtifactPaths(sessionId, toolUseId);
    try {
      const content = readUtf8FileIfPresent(paths.contentPath);
      const rawMeta = readUtf8FileIfPresent(paths.metaPath);
      if (content === null || rawMeta === null) return null;
      const meta = JSON.parse(rawMeta) as Record<string, unknown>;
      if (meta.toolUseId !== toolUseId) return null;
      const truncated = normalizeTruncatedInfo(meta.truncated);
      const sha256 = typeof meta.sha256 === "string" ? meta.sha256 : "";
      if (!truncated || sha256.length === 0 || sha256Text(content) !== sha256) return null;
      return {
        toolUseId,
        ...(typeof meta.toolName === "string" ? { toolName: meta.toolName } : {}),
        content,
        truncated,
        sha256,
        createdAt: typeof meta.createdAt === "string" ? meta.createdAt : new Date(0).toISOString(),
      };
    } catch (err) {
      log.warn(`loadToolResultArtifact failed for ${sessionId}/${toolUseId}: %s`, (err as Error).message);
      return null;
    }
  }

  startToolOutputCapture(sessionId: string, toolUseId: string): ToolOutputCapture {
    if (!isValidSessionId(sessionId)) throw new TypeError("tool-output-session-id-invalid");
    const capture = this.toolOutputArtifacts.start(sessionId, toolUseId, () => {
      this.cleanupToolOutputArtifacts(sessionId, this.loadPersistedOutputCaptureIds(sessionId));
    });
    // Pin before finish publishes or releases its reservation; waiting first permits pruning in the microtask gap.
    let pending = this.unpublishedOutputCaptures.get(sessionId);
    if (!pending) this.unpublishedOutputCaptures.set(sessionId, pending = new Set());
    pending.add(capture.captureId);
    return {
      captureId: capture.captureId,
      abandon: () => { pending.delete(capture.captureId); },
      append: (chunk) => capture.append(chunk),
      waitForDrain: () => capture.waitForDrain(),
      finish: async (interrupted) => {
        const info = await capture.finish(interrupted);
        if (info.status === "unavailable") pending.delete(capture.captureId);
        return info;
      },
    };
  }

  private normalizeStoredOutputCapture(sessionId: string, message: unknown): unknown {
    if (!isToolResultRecord(message) || !isRecord(message.meta)) return message;
    if (message.meta.outputArtifact === undefined && message.meta.outputArtifactUnavailable !== true) return message;
    const outputArtifact = normalizeToolOutputArtifactInfo(message.meta.outputArtifact);
    if (outputArtifact && this.toolOutputArtifacts.validateReference(sessionId, message.toolUseId, outputArtifact)) {
      const { outputArtifactUnavailable: _unavailable, serializedStub: _stub, truncated: _truncated, ...meta } = message.meta;
      return { ...message, content: readBoundedTextWindow(message.content, 0, MAX_TOOL_OUTPUT_PREVIEW_CHARS).text, meta: { ...meta, outputArtifact } };
    }
    const { outputArtifact: _invalid, serializedStub: _stub, truncated: _truncated, ...meta } = message.meta;
    return {
      ...message,
      content: readBoundedTextWindow(message.content, 0, MAX_TOOL_OUTPUT_PREVIEW_CHARS).text,
      meta: { ...meta, outputArtifactUnavailable: true },
    };
  }

  loadToolOutputArtifact(sessionId: string, toolUseId: string, info: ToolOutputArtifactInfo): string | null {
    return this.toolOutputArtifacts.read(sessionId, toolUseId, info);
  }

  rehydrateToolResultArtifacts(sessionId: string, messages: unknown[]): unknown[] {
    if (!isValidSessionId(sessionId)) return messages;
	    let changed = false;
	    const hydrated = messages.map((rawMessage) => {
          const message = this.normalizeStoredOutputCapture(sessionId, rawMessage);
          if (message !== rawMessage) changed = true;
	      if (!isToolResultRecord(message) || !isToolResultStubContent(message.content)) {
	        return message;
	      }
	      const meta = isRecord(message.meta) ? message.meta : {};
	      if (meta.outputArtifact !== undefined || normalizeArtifactUnavailable(meta.artifactUnavailable)) return message;
	      const artifact = this.loadToolResultArtifact(sessionId, message.toolUseId);
	      if (!artifact) return message;
	      const { serializedStub: _serializedStub, ...restMeta } = meta;
      changed = true;
      return {
        ...message,
        toolName: artifact.toolName ?? message.toolName,
        content: artifact.content,
        meta: {
          ...restMeta,
          truncated: artifact.truncated,
        },
      };
    });
    return changed ? hydrated : messages;
  }

  // Read-modify-write row fields so whole-sidecar persistence preserves unrelated metadata.
  async updateSessionRowFields(
    sessionId: string,
    fields: { title?: string; archivedAt?: string | null; unreadSince?: string | null },
  ): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`updateSessionRowFields: invalid sessionId "${sessionId}"`);
    }
    const current = this.loadSessionMetadata(sessionId) ?? {};
    const next: SessionMetadata = { ...current };
    if (fields.title !== undefined) next.title = fields.title;
    if (fields.archivedAt !== undefined) {
      if (fields.archivedAt === null) delete next.archivedAt;
      else next.archivedAt = fields.archivedAt;
    }
    if (fields.unreadSince !== undefined) {
      if (fields.unreadSince === null) delete next.unreadSince;
      else next.unreadSince = fields.unreadSince;
    }
    await this.saveSessionMetadata(sessionId, next);
  }

  // Task-list updates preserve unrelated metadata; an empty list removes the field.
  async saveSessionTasks(sessionId: string, tasks: SessionTaskItem[]): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`saveSessionTasks: invalid sessionId "${sessionId}"`);
    }
    const current = this.loadSessionMetadata(sessionId) ?? {};
    const next: SessionMetadata = { ...current };
    if (tasks.length === 0) delete next.tasks;
    else next.tasks = tasks.map((item) => ({ ...item }));
    await this.saveSessionMetadata(sessionId, next);
  }

  // Goal updates preserve unrelated metadata; null removes the goal without a tombstone.
  async saveSessionGoal(sessionId: string, goal: SessionGoal | null): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`saveSessionGoal: invalid sessionId "${sessionId}"`);
    }
    const current = this.loadSessionMetadata(sessionId) ?? {};
    const next: SessionMetadata = { ...current };
    if (goal === null) delete next.goal;
    else next.goal = { ...goal };
    await this.saveSessionMetadata(sessionId, next);
  }

  async saveSessionMetadata(sessionId: string, metadata: SessionMetadata): Promise<void> {
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
      writeUtf8FileAtomicSync(targetPath, JSON.stringify(safe, null, 2));
      this.notePaneSession(sessionId, safe);
    });
    // Reindex metadata-only updates too because project, kind, routine, and title fields are denormalized.
    const messages = this.loadSession(sessionId);
    if (Array.isArray(messages)) {
      this.indexSessionForSearch(sessionId, messages);
    } else {
      this.deleteSessionFromSearchIndex(sessionId);
    }
  }

  // Re-add permits new bindings but keeps old session tombstones; it does not reassign detached chats.
  allowProjectRoot(projectRoot: string): void {
    const key = projectRootKey(projectRoot);
    if (!key) return;
    this.bumpProjectRootGeneration(key);
    this.detachedProjectRoots.delete(key);
  }

  // Detach project metadata without deleting transcripts; re-read under locks for idempotent concurrent cleanup.
  private sessionMetadataTargets(): Array<{ sessionId: string; targetPath: string }> {
    return readdirIfPresent(this.sessionsDir)
      .filter((file) => file.endsWith(".meta.json"))
      .map((file) => ({
        sessionId: file.slice(0, -".meta.json".length),
        targetPath: join(this.sessionsDir, file),
      }))
      .filter(({ sessionId }) => isValidSessionId(sessionId))
      .sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  }

  /** The removal preview: how many conversations `detachSessionsFromProject` would detach now, by the same predicate, writing nothing.
   * Unreadable metadata fails here as it would fail the detach. */
  countSessionsInProject(projectRoot: string): number {
    if (!projectRootKey(projectRoot)) return 0;
    let count = 0;
    for (const { sessionId, targetPath } of this.sessionMetadataTargets()) {
      const raw = readUtf8FileIfPresent(targetPath);
      if (raw === null) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = parseSessionMetadataObject(raw);
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        log.warn("countSessionsInProject: invalid metadata for %s (%s)", sessionId, errorName);
        throw Object.assign(new Error("workspace session metadata unreadable"), { code: "SESSION_METADATA_INVALID", cause: error });
      }
      if (sessionMetadataInProject(parsed, projectRoot)) count += 1;
    }
    return count;
  }

  async detachSessionsFromProject(projectRoot: string): Promise<number> {
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
          const raw = readUtf8FileIfPresent(targetPath);
          if (raw === null) continue;
          const parsed = parseSessionMetadataObject(raw);
          if (!sessionMetadataInProject(parsed, projectRoot)) continue;
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

      // Keep root intent active through partial I/O failure so retry can repair metadata and the complete index.
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

    this.repairAllSessionSearchRowsForProjectDetach();
    return detachedCount;
  }

  // Existence must match conversation listing and return false for invalid ids.
  hasSessionTranscript(sessionId: unknown): boolean {
    if (!isValidSessionId(sessionId)) return false;
    return statPathIfPresent(join(this.sessionsDir, `${sessionId}.jsonl`)) !== null;
  }

  // Create missing transcripts exclusively so concurrent writers cannot be overwritten.
  touchSessionTranscript(sessionId: string, options: { bump: boolean }): boolean {
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
      const now = new Date();
      utimesSync(path, now, now);
    }
    return false;
  }

  hasSessionMetadataFile(sessionId: string): boolean {
    if (!isValidSessionId(sessionId)) {
      throw new Error('hasSessionMetadataFile: invalid sessionId "' + sessionId + '"');
    }
    const path = join(this.sessionsDir, sessionId + ".meta.json");
    return readUtf8FileIfPresent(path) !== null;
  }

  loadSessionMetadata(sessionId: string): SessionMetadata | null {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`loadSessionMetadata: invalid sessionId "${sessionId}"`);
    }
    const path = join(this.sessionsDir, `${sessionId}.meta.json`);
    try {
      const raw = readUtf8FileIfPresent(path);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") return null;
      return normalizeSessionMetadata(parsed);
    } catch (err) {
      // Warn on metadata parse or I/O failures while retaining the null return contract.
      log.warn(`loadSessionMetadata failed for ${sessionId}: %s`, (err as Error).message);
      return null;
    }
  }

  loadMainActiveSessionState(): MainActiveSessionState | null {
    const path = join(this.sessionsDir, ACTIVE_SESSION_STATE_FILE);
    try {
      const raw = readUtf8FileIfPresent(path);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const mode = parsed.mainActiveMode;
      if (mode !== "resume" && mode !== "fresh") return null;
      const id = parsed.mainActiveSessionId;
      const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString();
      const mainActiveSessionId = isValidSessionId(id) ? id : null;
      if (mode === "resume" && mainActiveSessionId) {
        const metadata = this.loadSessionMetadata(mainActiveSessionId);
        if (metadata?.sessionKind === "routine") {
          return {
            mainActiveMode: "fresh",
            mainActiveSessionId: null,
            updatedAt,
          };
        }
      }
      return {
        mainActiveMode: mode,
        mainActiveSessionId,
        updatedAt,
      };
    } catch (err) {
      log.warn(`loadMainActiveSessionState failed: %s`, (err as Error).message);
      return null;
    }
  }

  async saveMainActiveSessionState(state: MainActiveSessionState): Promise<void> {
    const targetPath = join(this.sessionsDir, ACTIVE_SESSION_STATE_FILE);
    const safe: MainActiveSessionState = {
      mainActiveMode: state.mainActiveMode,
      mainActiveSessionId:
        state.mainActiveMode === "fresh"
          ? null
          : isValidSessionId(state.mainActiveSessionId)
            ? state.mainActiveSessionId
            : null,
      updatedAt: state.updatedAt,
    };
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, JSON.stringify(safe, null, 2), "utf-8");
    });
  }

  async markMainActiveFresh(): Promise<void> {
    await this.saveMainActiveSessionState({
      mainActiveSessionId: null,
      mainActiveMode: "fresh",
      updatedAt: new Date().toISOString(),
    });
  }

  async markMainActiveResume(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`markMainActiveResume: invalid sessionId "${sessionId}"`);
    }
    await this.saveMainActiveSessionState({
      mainActiveSessionId: sessionId,
      mainActiveMode: "resume",
      updatedAt: new Date().toISOString(),
    });
  }

  // Assemble plain lists through pagination so row fields cannot drift between the two surfaces.
  listSessions(input: number | ListSessionsOptions = Number.POSITIVE_INFINITY): SessionListEntry[] {
    const options: ListSessionsOptions = typeof input === "number" ? { limit: input } : input;
    return this.listSessionsPage({ ...options, limit: options.limit ?? Number.POSITIVE_INFINITY });
  }

  // Resolve pane sessions from a lazy metadata index and update it on local writes and deletes.
  findPaneSession(paneTabId: string): string | undefined {
    let newest: { id: string; mtimeMs: number } | undefined;
    for (const id of this.paneSessionIndex().get(paneTabId) ?? []) {
      const stat = statPathIfPresent(join(this.sessionsDir, `${id}.jsonl`));
      if (!stat) continue;
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { id, mtimeMs: stat.mtimeMs };
    }
    return newest?.id;
  }

  private paneSessionIndex(): Map<string, Set<string>> {
    if (this.paneSessions) return this.paneSessions;
    const index = new Map<string, Set<string>>();
    this.paneSessions = index;
    for (const file of readdirIfPresent(this.sessionsDir)) {
      if (!file.endsWith(".meta.json")) continue;
      const id = file.slice(0, -".meta.json".length);
      if (isValidSessionId(id)) this.notePaneSession(id, this.loadSessionMetadata(id));
    }
    return index;
  }

  private notePaneSession(sessionId: string, metadata: SessionMetadata | null): void {
    const index = this.paneSessions;
    if (!index) return;
    for (const [tabId, ids] of index) {
      if (ids.delete(sessionId) && ids.size === 0) index.delete(tabId);
    }
    const tabId = metadata?.paneTabId;
    if (!tabId || metadata.archivedAt !== undefined) return;
    const ids = index.get(tabId) ?? new Set<string>();
    ids.add(sessionId);
    index.set(tabId, ids);
  }

  // Restore child panel rows from persisted metadata; live spawn events disappear on restart.

  listSubAgentSessionsForOrigin(originSessionId: string): RestoredSubAgentSession[] {
    if (!originSessionId) return [];
    return readdirIfPresent(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f): RestoredSubAgentSession[] => {
        const id = f.replace(".jsonl", "");
        const stat = statPathIfPresent(join(this.sessionsDir, f));
        if (!stat) return [];
        const metadata = this.loadSessionMetadata(id);
        if (metadata?.sessionKind !== "subagent") return [];
        if (metadata.originSessionId !== originSessionId) return [];
        // Skip children without stored spawnId; synthesized panel ids cannot join later live events.
        if (!metadata.spawnId) return [];
        return [{
          spawnId: metadata.spawnId,
          childSessionId: id,
          title: metadata.subAgentTitle ?? metadata.title ?? "",
          modifiedAt: stat.mtime,
          ...(metadata.subAgentTaskState ? { taskState: metadata.subAgentTaskState } : {}),
          ...(metadata.originToolUseId ? { toolUseId: metadata.originToolUseId } : {}),
        }];
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  listSessionsPage(options: ListSessionsOptions = {}): SessionListEntry[] {
    const limit = Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit ?? 0))
      : Number.POSITIVE_INFINITY;
    const beforeTime = options.before?.getTime();
    const beforeId = options.beforeId;
    const afterTime = options.after?.getTime();
    return readdirIfPresent(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => {
        const stat = statPathIfPresent(join(this.sessionsDir, f));
        if (!stat) return [];
        return {
          id: f.replace(".jsonl", ""),
          modifiedAt: stat.mtime,
          size: stat.size,
        };
      })
      .filter((session) => {
        const t = session.modifiedAt.getTime();
        if (afterTime !== undefined && !Number.isNaN(afterTime) && t < afterTime) return false;
        if (beforeTime === undefined || Number.isNaN(beforeTime)) return true;
        if (t < beforeTime) return true;
        return t === beforeTime && beforeId !== undefined && session.id < beforeId;
      })
      .sort((a, b) => {
        const timeDelta = b.modifiedAt.getTime() - a.modifiedAt.getTime();
        return timeDelta !== 0 ? timeDelta : b.id.localeCompare(a.id);
      })
      .map((session) => ({ ...session, metadata: this.loadSessionMetadata(session.id) }))
      .filter((session) => matchesSessionScope(session.metadata, options))
      .slice(0, Number.isFinite(limit) ? limit : undefined)
      .map((session) => this.toSessionListEntry(session));
  }

  /** Read one row without enumerating unrelated histories. */
  getSessionListEntry(sessionId: string): SessionListEntry | null {
    if (!isValidSessionId(sessionId)) return null;
    const stat = statPathIfPresent(join(this.sessionsDir, `${sessionId}.jsonl`));
    if (!stat) return null;
    return this.toSessionListEntry({ id: sessionId, modifiedAt: stat.mtime, size: stat.size, metadata: this.loadSessionMetadata(sessionId) });
  }

  private toSessionListEntry(session: { id: string; modifiedAt: Date; size: number; metadata: SessionMetadata | null }): SessionListEntry {
    const metadata = session.metadata;
    const sessionKind = metadata?.sessionKind ?? normalizeSessionKind(undefined);
    const workBoardItemId = sessionKind === "subagent"
      ? parseWorkBoardOriginSessionId(metadata?.originSessionId)
      : null;
    const summary = session.size > MAX_SESSION_FILE_BYTES
      ? {
          title: metadata?.routineTitle
            ? t("be_memoryManager.sessionTitleWithRoutine", { routineTitle: metadata.routineTitle })
            : t("be_memoryManager.sessionTitleShort", { id: session.id.slice(0, 8) }),
          preview: t("be_memoryManager.sessionPreviewTooLarge"),
        }
      : this.readSessionSummary(session.id);
    return {
      id: session.id,
      modifiedAt: session.modifiedAt,
      sessionKind,
      title: resolveConversationTitle({ sessionId: session.id, title: metadata?.title || metadata?.subAgentTitle || summary.title, routineTitle: metadata?.routineTitle }, t),
      preview: summary.preview,
      routineId: metadata?.routineId,
      routineTitle: metadata?.routineTitle,
      routineFiredAt: metadata?.routineFiredAt,
      ...(metadata?.projectRoot ? { projectRoot: metadata.projectRoot } : {}),
      ...(metadata?.projectName ? { projectName: metadata.projectName } : {}),
      ...(workBoardItemId !== null ? { workBoardItemId } : {}),
      ...(isValidSessionId(metadata?.originSessionId) ? { originSessionId: metadata.originSessionId } : {}),
      ...(metadata?.paneTabId ? { paneTabId: metadata.paneTabId } : {}),
      ...(metadata?.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
      ...(metadata?.branchedFromCompactNum !== undefined ? { branchedFromCompactNum: metadata.branchedFromCompactNum } : {}),
      ...(metadata?.branchedAt ? { branchedAt: metadata.branchedAt } : {}),
      ...(metadata?.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
      ...(metadata?.unreadSince ? { unreadSince: metadata.unreadSince } : {}),
    };
  }

  listSessionsByRoutine(routineId: string, limit = Number.POSITIVE_INFINITY): SessionListEntry[] {
    return this.listSessions({ kind: "routine", routineId, limit });
  }

  // Append in memory only; callers must persist the updated metadata.
  appendCheckpoint(metadata: SessionMetadata, checkpoint: Checkpoint): SessionMetadata {
    const existing = Array.isArray(metadata.checkpoints) ? metadata.checkpoints : [];
    return { ...metadata, checkpoints: [...existing, checkpoint] };
  }

  // Prune only discarded checkpoint boundaries and their snapshots before saving rewind state.
  async pruneCheckpointsDiscardedByRewind(
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

  // Cap the preamble and return updated metadata without persisting it.
  setSummaryPreamble(metadata: SessionMetadata, preamble: string): SessionMetadata {
    const truncated = preamble.length > MAX_SUMMARY_PREAMBLE_CHARS
      ? preamble.slice(0, MAX_SUMMARY_PREAMBLE_CHARS)
      : preamble;
    return { ...metadata, summaryPreamble: truncated };
  }

  // Delete session artifacts but retain the stable metadata lock target for waiting operations.
  async deleteSession(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      log.warn({ sessionId }, "unsafe caller-provided sessionId rejected in deleteSession");
      return;
    }
    await withFileLock(this.sessionMetadataLockPath(sessionId), async () => {
      this.detachedProjectRootsBySession.delete(sessionId);
      await deleteCodeCheckpoints(sessionId);
      this.detachedWireTerminalTombstones.delete(sessionId);
      const jsonlPath = join(this.sessionsDir, `${sessionId}.jsonl`);
      unlinkIfPresent(jsonlPath);
      transcriptWriteStates.delete(jsonlPath);
      const metaPath = join(this.sessionsDir, `${sessionId}.meta.json`);
      unlinkIfPresent(metaPath);
      this.notePaneSession(sessionId, null);
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
      if (this.searchIndex.open()) {
        try {
          this.searchIndex.deleteSession(sessionId);
        } finally {
          this.searchIndex.close();
        }
      }
    });
  }

  private toolResultArtifactsDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId, "tool-results");
  }

  private toolResultArtifactPaths(sessionId: string, toolUseId: string): { key: string; contentPath: string; metaPath: string } {
    const key = toolUseArtifactKey(toolUseId);
    const dir = this.toolResultArtifactsDir(sessionId);
    return {
      key,
      contentPath: join(dir, `${key}.txt`),
      metaPath: join(dir, `${key}.json`),
    };
  }

  private writeToolResultArtifact(
    sessionId: string,
    message: { toolUseId: string; toolName?: unknown; content: string },
    truncated: ToolResultTruncatedInfo,
  ): boolean {
    const byteLength = Buffer.byteLength(message.content, "utf8");
    if (byteLength > MAX_TOOL_RESULT_ARTIFACT_BYTES) {
      log.warn(
        {
          sessionId,
          toolUseId: message.toolUseId,
          byteLength,
          maxBytes: MAX_TOOL_RESULT_ARTIFACT_BYTES,
        },
        "tool_result artifact skipped because it exceeds the host storage cap",
      );
      return false;
    }
    const paths = this.toolResultArtifactPaths(sessionId, message.toolUseId);
    mkdirSync(this.toolResultArtifactsDir(sessionId), { recursive: true, mode: 0o700 });
    const sha256 = sha256Text(message.content);
    writeFileSync(paths.contentPath, message.content, { encoding: "utf-8", mode: 0o600 });
    writeFileSync(
      paths.metaPath,
      JSON.stringify({
        toolUseId: message.toolUseId,
        ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
        truncated,
        sha256,
        createdAt: new Date().toISOString(),
      }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
    return true;
  }

  private prepareSessionMessagesForDisk(sessionId: string, messages: unknown[]): {
    messages: unknown[];
    keepArtifactKeys: Set<string>;
    keepCaptureIds: Set<string>;
  } {
    const keepArtifactKeys = new Set<string>();
    const keepCaptureIds = new Set<string>();
    const prepared = messages.map((rawMessage) => {
      const message = this.normalizeStoredOutputCapture(sessionId, rawMessage);
      if (!isToolResultRecord(message)) return message;

      // Persist a clone without live-only image bytes; never mutate the caller's in-memory tool result.
      const base =
        "image" in message
          ? ((): Record<string, unknown> => {
              const { image: _image, ...rest } = message as Record<string, unknown>;
              return rest;
            })()
          : message;

      const meta = isRecord(message.meta) ? message.meta : {};
      const outputArtifact = normalizeToolOutputArtifactInfo(meta.outputArtifact);
      if (meta.outputArtifactUnavailable === true) return base;
      if (outputArtifact) {
        // Persist bounded canonical previews and validated host references, never provider-recovery projections.
        keepCaptureIds.add(outputArtifact.captureId);
        const { serializedStub: _stub, truncated: _truncated, ...captureMeta } = meta;
        return {
          ...base,
          content: readBoundedTextWindow(message.content, 0, MAX_TOOL_OUTPUT_PREVIEW_CHARS).text,
          meta: { ...captureMeta, outputArtifact },
        };
      }

      let truncated = normalizeTruncatedInfo(meta.truncated);
      const compactedAt = typeof meta.compactedAt === "string" ? meta.compactedAt : undefined;
      let artifactUnavailable = normalizeArtifactUnavailable(meta.artifactUnavailable);
      const hasStubPrefix = isToolResultStubContent(message.content);
      const isSerializedStub = hasStubPrefix && (meta.serializedStub === true || !truncated);
      let previewContent = isSerializedStub ? null : message.content;

      if (truncated) {
        const paths = this.toolResultArtifactPaths(sessionId, message.toolUseId);
        if (!isSerializedStub) {
          if (this.writeToolResultArtifact(sessionId, message, truncated)) {
            keepArtifactKeys.add(paths.key);
            artifactUnavailable = null;
          } else {
            artifactUnavailable = {
              reason: "artifact-too-large",
              maxBytes: MAX_TOOL_RESULT_ARTIFACT_BYTES,
            };
          }
        } else if (!artifactUnavailable) {
          keepArtifactKeys.add(paths.key);
          previewContent = this.loadToolResultArtifact(sessionId, message.toolUseId)?.content ?? null;
        }
      } else if (isSerializedStub) {
        const paths = this.toolResultArtifactPaths(sessionId, message.toolUseId);
        const artifact = this.loadToolResultArtifact(sessionId, message.toolUseId);
        if (artifact) {
          keepArtifactKeys.add(paths.key);
          truncated = artifact.truncated;
          if (compactedAt === undefined) {
            return {
              ...base,
              content: buildToolResultTruncatedStub(
                message.toolUseId,
                message.toolName as string | undefined,
                artifact.truncated,
                artifact.content,
              ),
              meta: {
                ...meta,
                truncated: artifact.truncated,
                ...(artifactUnavailable ? { artifactUnavailable } : {}),
                serializedStub: true,
              },
            };
          }
        }
      }

      if (!truncated && compactedAt === undefined) return base;

      const content = truncated
        ? buildToolResultTruncatedStub(
              message.toolUseId,
              typeof message.toolName === "string" ? message.toolName : undefined,
              truncated,
              previewContent,
              artifactUnavailable ? { artifactUnavailable } : undefined,
            )
        : buildToolResultStrippedStub(
            typeof message.toolName === "string" ? message.toolName : undefined,
            message.content.length,
          );
      return {
        ...base,
        content,
        meta: {
          ...meta,
          ...(truncated ? { truncated } : {}),
          ...(artifactUnavailable ? { artifactUnavailable } : {}),
          serializedStub: true,
        },
      };
    });

    return { messages: prepared, keepArtifactKeys, keepCaptureIds };
  }

  private loadPersistedOutputCaptureIds(sessionId: string): Set<string> {
    const ids = new Set<string>();
    const raw = readUtf8FileIfPresent(join(this.sessionsDir, sessionId + ".jsonl"));
    for (const line of raw?.split("\n") ?? []) {
      try {
        const message: unknown = JSON.parse(line);
        if (!isToolResultRecord(message) || !isRecord(message.meta)) continue;
        const info = normalizeToolOutputArtifactInfo(message.meta.outputArtifact);
        if (info) ids.add(info.captureId);
      } catch { /* Only parsed capture metadata can retain an owned artifact. */ }
    }
    return ids;
  }

  private cleanupToolOutputArtifacts(sessionId: string, keepCaptureIds: Set<string>): void {
    const unpublished = this.unpublishedOutputCaptures.get(sessionId);
    for (const id of keepCaptureIds) unpublished?.delete(id);
    for (const id of unpublished ?? []) keepCaptureIds.add(id);
    for (const entry of readdirIfPresent(join(this.checkpointsDir, sessionId))) {
      if (!entry.endsWith(".jsonl")) continue;
      const raw = readUtf8FileIfPresent(join(this.checkpointsDir, sessionId, entry));
      for (const line of raw?.split("\n") ?? []) {
        try {
          const message: unknown = JSON.parse(line);
          if (!isToolResultRecord(message) || !isRecord(message.meta)) continue;
          const info = normalizeToolOutputArtifactInfo(message.meta.outputArtifact);
          if (info) keepCaptureIds.add(info.captureId);
        } catch { /* A malformed checkpoint row cannot grant artifact ownership. */ }
      }
    }
    this.toolOutputArtifacts.prune(sessionId, keepCaptureIds);
  }

  private cleanupToolResultArtifacts(sessionId: string, keepArtifactKeys: Set<string>): void {
    const dir = this.toolResultArtifactsDir(sessionId);
    const entries = readdirIfPresent(dir);
    if (entries.length === 0) return;
    const checkpointKeys = this.loadCheckpointToolResultArtifactKeys(sessionId);
    for (const entry of entries) {
      const key = entry.replace(/\.(txt|json)$/u, "");
      if (keepArtifactKeys.has(key) || checkpointKeys.has(key)) continue;
      try {
        unlinkSync(join(dir, entry));
      } catch (err) {
        log.warn(`cleanupToolResultArtifacts: failed to remove ${entry}: ${(err as Error).message}`);
      }
    }
  }

  private loadCheckpointToolResultArtifactKeys(sessionId: string): Set<string> {
    const keys = new Set<string>();
    const dir = join(this.checkpointsDir, sessionId);
    for (const entry of readdirIfPresent(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(dir, entry);
      try {
        const raw = readUtf8FileIfPresent(path);
        if (raw === null) continue;
        const lines = raw.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
	          if (!isToolResultRecord(parsed)) continue;
	          const meta = isRecord(parsed.meta) ? parsed.meta : {};
	          if (normalizeArtifactUnavailable(meta.artifactUnavailable)) continue;
	          if (isToolResultStubContent(parsed.content) || normalizeTruncatedInfo(meta.truncated)) {
	            keys.add(toolUseArtifactKey(parsed.toolUseId));
	          }
        }
      } catch (err) {
        log.warn(`loadCheckpointToolResultArtifactKeys: failed to scan ${entry}: ${(err as Error).message}`);
      }
    }
    return keys;
  }

  // Enforce a private sessions-root mode explicitly; permissive umasks must not leave capture storage group-writable.
  private restrictSessionsDirWrites(): void {
    if (process.platform === "win32") return;
    let fd: number;
    try {
      fd = openSync(this.sessionsDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      // O_DIRECTORY may report a trailing link as ENOTDIR; leave linked roots for the store's authorization decision.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENOTDIR") return;
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (stat.uid === process.getuid?.() && (stat.mode & 0o022) !== 0) fchmodSync(fd, stat.mode & 0o7755);
    } finally { closeSync(fd); }
  }

  // Derive summaries only from string user/assistant content so disk and in-memory paths agree.
  private deriveSessionSummary(
    sessionId: string,
    messages: unknown[] | null,
  ): { title: string; preview: string } {
    if (!Array.isArray(messages)) {
      return {
        title: t("be_memoryManager.sessionTitleShort", { id: sessionId.slice(0, 8) }),
        preview: t("be_memoryManager.sessionPreviewEmpty"),
      };
    }

    let lastUser = "";
    let lastContent = "";
    for (const message of messages) {
      const role = (message as Record<string, unknown>)?.role;
      const content = (message as Record<string, unknown>)?.content;
      if (typeof content !== "string" || content.trim().length === 0) continue;
      // Exclude host resume instructions from titles and previews; they do not describe the user's request.
      const meta = (message as Record<string, unknown>)?.meta;
      if (isRecord(meta) && meta.resumesInterruptedTurn === true) continue;
      const normalized = unwrapStagedText(content, t, "body").replace(/\s+/g, " ").trim();
      lastContent = normalized;
      if (role === "user") lastUser = normalized;
    }

    return {
      title: resolveConversationTitle({ sessionId, messages }, t),
      preview: (lastContent || lastUser || t("be_memoryManager.sessionPreviewEmpty")).slice(0, 200),
    };
  }

  // Reuse in-memory summaries during indexing to avoid rereading the transcript.
  private readSessionSummary(sessionId: string): { title: string; preview: string } {
    return this.deriveSessionSummary(sessionId, this.loadSession(sessionId));
  }
}
