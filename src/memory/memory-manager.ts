import { resolveConversationTitle } from "../shared/conversation-title.js";
import { readBoundedTextWindow } from "../shared/bounded-tool-output.js";
import { ToolOutputArtifactStore } from "./tool-output-artifact-store.js";
import { deleteCodeCheckpoints } from "./code-checkpoints.js";
import { MAX_TOOL_RESULT_ARTIFACT_BYTES, MAX_TOOL_OUTPUT_PREVIEW_CHARS, normalizeToolOutputArtifactInfo, type ToolOutputCapture, type ToolOutputArtifactInfo } from "../shared/tool-output-artifact.js";
export { MAX_TOOL_RESULT_ARTIFACT_BYTES } from "../shared/tool-output-artifact.js";
import { isValidSessionId } from "../shared/session-id.js";
export { isValidSessionId } from "../shared/session-id.js";


import { closeSync, constants, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync, unlinkSync, rmSync, renameSync, watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync, replaceUtf8FileAtomicSyncIf, isMissingPathError } from "../lib/atomic-file.js";
import { isSessionTaskItem, type SessionTaskItem } from "../shared/session-tasks.js";
import { isSessionGoal, type SessionGoal } from "../shared/session-goal.js";
import { createLogger } from "../lib/logger.js";
import {
  AGENTS_CUSTOM_DOC_NAME,
  AGENTS_DOC_NAME,
  aveHome,
} from "../shared/ave-home.js";
import { sessionStorePath } from "../shared/session-store-path.js";
import { t } from "../i18n/index.js";
import { projectRootEquals, projectRootKey } from "../shared/project-identity.js";
import { parseWorkBoardOriginSessionId } from "../shared/work-board-types.js";
import type { SessionFamily, SessionKind, SessionListRow } from "../shared/session-lookup.js";
import { discoverProjectAgentsMd, type ProjectAgentsMd } from "./project-agents-md.js";
import { maskSensitiveData } from "../shared/dlp.js";
import { estimateTokens } from "../shared/token-estimate.js";
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
import { escapeRegExp } from "../shared/escape-reg-exp.js";
import { dlpSafeCandidate, isSafeStructuralId } from "../shared/dlp-safe-id.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { SHA256_HEX, sha256Hex } from "../lib/hex-digest-equal.js";
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



interface FileSnapshot {
  content: string;
  mtime: Date;
  mtimeMs: number;
  size: number;
  tooLarge: boolean;
}

function readUtf8FileIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
}

function readUtf8FileSnapshotIfPresent(path: string, maxBytes = Number.POSITIVE_INFINITY): FileSnapshot | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (stat.size > maxBytes) {
      return { content: "", mtime: stat.mtime, mtimeMs: stat.mtimeMs, size: stat.size, tooLarge: true };
    }
    return {
      content: readFileSync(fd, "utf-8"),
      mtime: stat.mtime,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      tooLarge: false,
    };
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
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

function readdirIfPresent(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (err) {
    if (isMissingPathError(err)) return [];
    throw err;
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isMissingPathError(err)) throw err;
  }
}

export interface MemoryManagerOptions {

  aveDir?: string;
  defaultWorkspaceRoot?: string;
}

export interface NoteEntry {
  filename: string;
  title: string;
  content: string;
  updatedAt?: string;
  excerpt?: string;
  projectRoot?: string;
  projectName?: string;
  id?: string;
  kind?: MemoryKind;
  state?: MemoryState;
  source?: MemorySourceKind;
  createdAt?: string;
  confirmedAt?: string;
  expiresAt?: string;
  pinned?: boolean;
  derivation?: MemoryDerivationV1;
  capture?: MemoryCaptureV1;
}

export interface ProjectScopedMemoryOptions {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
}

export type MemoryKind = "preference" | "constraint" | "fact" | "goal" | "reference" | "note";

/** Candidates are optional review-only records; only active memories may reach a model prompt. */
export type MemoryState = "candidate" | "active";

/** Provenance is recorded so later lifecycle policy can distinguish imports from direct user intent. */
export type MemorySourceKind = "user" | "assistant" | "import" | "capture";

export type MemoryCaptureTrigger = "automatic" | "explicit";

export type MemoryScope =
  | { type: "global" }
  | { type: "project"; projectRoot: string; projectName?: string };

interface MemoryDerivationV1 {
  v: 1;
  type: "consolidated-overview";
  sourceFingerprint: string;
  generatedAt: string;
}

interface MemoryCaptureV1 {
  v: 1;
  method: "llm-refined";
  trigger: MemoryCaptureTrigger;
  sourceDigest: string;
  capturedAt: string;
}

export interface MemoryConsolidationSnapshot {
  scope: MemoryScope;
  sources: readonly NoteEntry[];
  sourceFingerprint: string;
}

export type MemoryConsolidationUpsertResult =
  | { status: "updated"; entry: NoteEntry }
  | { status: "sources-changed" | "empty" };

export interface MemoryMetadataV1 {
  v: 1;
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  state: MemoryState;
  source: MemorySourceKind;
  createdAt: string;
  confirmedAt?: string;
  expiresAt?: string;
  pinned?: true;
  derivation?: MemoryDerivationV1;
  capture?: MemoryCaptureV1;
}

// Omitted projectRoot explicitly selects global long-term memory.
export interface MemorySaveOptions extends ProjectScopedMemoryOptions {
  kind?: MemoryKind;
  state?: MemoryState;
  source?: MemorySourceKind;
  confirmedAt?: string;
  expiresAt?: string;
  pinned?: boolean;
  capture?: MemoryCaptureV1;
}

export interface MemoryReadOptions extends ProjectScopedMemoryOptions {
  // Candidates are excluded from normal reads and prompts by default.
  includeCandidates?: boolean;
  scope?: "all" | "global";
}

export interface MemorySelectionOptions extends ProjectScopedMemoryOptions {
  tokenBudget?: number;
  maxEntries?: number;
}

export interface MemorySelection {
  entries: NoteEntry[];
  context: string;
  usedTokens: number;
}

export interface MemoryIndexSectionsPatch {
  urgentMemory?: string;
  references?: string;
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

export type { SessionFamily, SessionKind, SessionListRow };

// Return no family for ordinary spawned children; only work-board runs belong in the sidebar list.
export function sessionFamilyOf(
  namespace: SessionNamespace,
  session: Pick<SessionListEntry, "sessionKind" | "workBoardItemId">,
): SessionFamily | null {
  if (namespace === "side-chat") return "side-chat";
  if (namespace === "subagent") {
    return session.workBoardItemId !== undefined ? "work-board" : null;
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
    // Only side-chat origins group sidebar rows; spawned children stay in their parent's panel.
    ...(family === "side-chat" && session.originSessionId
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
  // Work-board filtering applies only to child sessions whose host-written origin names an item.
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

export type CheckpointTrigger = "auto-compact" | "manual";

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

const MEMORY_MARKER = "<!-- ave:kind=memory -->";
const MEMORY_PROJECT_ROOT_PREFIX = "<!-- ave:project-root:";
const MEMORY_PROJECT_NAME_PREFIX = "<!-- ave:project-name:";
const MEMORY_METADATA_PREFIX = "<!-- ave:memory-meta:";
const MEMORY_METADATA_SUFFIX = " -->";
const MAX_MANAGED_MEMORY_FILE_BYTES = 64 * 1024;
// Legacy notes retain a larger bounded read ceiling; managed notes still fail closed at their own cap.
const MAX_LEGACY_MEMORY_FILE_BYTES = 512 * 1024;
const DEFAULT_MEMORY_SELECTION_TOKEN_BUDGET = 1_000;
const DEFAULT_MEMORY_SELECTION_MAX_ENTRIES = 6;
const MAX_PROMPT_MEMORY_INDEX_TOKENS = 400;
const MAX_PROMPT_USER_PREFERENCES_TOKENS = 600;
const MAX_MEMORY_SELECTION_ENTRY_TOKENS = 320;
const MAX_MANAGED_MEMORY_TITLE_CHARS = 120;
const MAX_SESSION_TITLE_CHARS = 80;
const MAX_MANAGED_MEMORY_CONTENT_CHARS = 8_000;
const MAX_CONSOLIDATION_SOURCE_NOTES = 16;
const MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_TOKENS = 400;
const MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_SCOPE_TOKENS = 190;
export const MEMORY_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  "preference", "constraint", "fact", "goal", "reference", "note",
]);
export const MAX_MEMORY_SOURCE_CHARS = 4_000;
const MEMORY_STATES = new Set<MemoryState>(["candidate", "active"]);
const MEMORY_CAPTURE_TRIGGERS = new Set<MemoryCaptureTrigger>(["automatic", "explicit"]);
const MEMORY_SOURCES = new Set<MemorySourceKind>(["user", "assistant", "import", "capture"]);

function getDefaultMemoryIndex(): string {
  return t("be_memoryManager.defaultMemoryIndex");
}

// Own session-file limits here and share them with import validation.
export const MAX_SESSION_FILE_BYTES = 5_000_000;
const MAX_SUMMARY_PREAMBLE_CHARS = 8_000;
export const MAX_PROJECT_ROOT_CHARS = 2_048;
export const MAX_PROJECT_NAME_CHARS = 120;
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

function sha256Text(content: string): string {
  return sha256Hex(content);
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

function normalizeMetadataString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxChars) : undefined;
}

interface ParsedMemoryNote {
  content: string;
  metadata?: MemoryMetadataV1;
  legacyProject: ProjectScopedMemoryOptions;
  /** A v1-looking header that cannot be validated must never fall back to global legacy scope. */
  invalidMetadata: boolean;
}

function isValidMemoryTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && Number.isFinite(Date.parse(value));
}

function normalizeMemoryCapture(value: unknown): MemoryCaptureV1 | null {
  if (
    !isRecord(value)
    || value.v !== 1
    || value.method !== "llm-refined"
    || !MEMORY_CAPTURE_TRIGGERS.has(value.trigger as MemoryCaptureTrigger)
    || typeof value.sourceDigest !== "string"
    || !isValidMemoryTimestamp(value.capturedAt)
  ) {
    return null;
  }
  // Normalize caller digests to the host's strict lowercase provenance shape.
  const sourceDigest = value.sourceDigest.toLowerCase();
  if (!SHA256_HEX.test(sourceDigest)) return null;
  return {
    v: 1,
    method: "llm-refined",
    trigger: value.trigger as MemoryCaptureTrigger,
    sourceDigest,
    capturedAt: value.capturedAt,
  };
}

// Capture provenance belongs only to its owning write path; manual records cannot impersonate reviewed captures.
function hasValidCaptureSourceCombination(
  source: MemorySourceKind,
  capture: MemoryCaptureV1 | undefined,
  derivation?: MemoryDerivationV1,
): boolean {
  if (capture && derivation) return false;
  if (!capture) return source !== "capture";
  return capture.trigger === "automatic"
    ? source === "capture"
    : source === "user";
}

function decodeMemoryMetadata(encoded: string): MemoryMetadataV1 | null {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(encoded)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1 || !UUID_PATTERN.test(String(raw.id ?? ""))) return null;
  if (!MEMORY_KINDS.has(raw.kind as MemoryKind) || !MEMORY_STATES.has(raw.state as MemoryState)) return null;
  if (!MEMORY_SOURCES.has(raw.source as MemorySourceKind) || !isValidMemoryTimestamp(raw.createdAt)) return null;
  if (raw.confirmedAt !== undefined && !isValidMemoryTimestamp(raw.confirmedAt)) return null;
  if (raw.expiresAt !== undefined && !isValidMemoryTimestamp(raw.expiresAt)) return null;
  if (raw.pinned !== undefined && raw.pinned !== true) return null;
  if (!isRecord(raw.scope)) return null;

  let derivation: MemoryDerivationV1 | undefined;
  if (raw.derivation !== undefined) {
    if (
      !isRecord(raw.derivation)
      || raw.derivation.v !== 1
      || raw.derivation.type !== "consolidated-overview"
      || typeof raw.derivation.sourceFingerprint !== "string"
      || !isValidMemoryTimestamp(raw.derivation.generatedAt)
    ) {
      return null;
    }
    // Normalize persisted frontmatter before strict validation.
    const sourceFingerprint = raw.derivation.sourceFingerprint.toLowerCase();
    if (!SHA256_HEX.test(sourceFingerprint)) return null;
    derivation = {
      v: 1,
      type: "consolidated-overview",
      sourceFingerprint,
      generatedAt: raw.derivation.generatedAt,
    };
  }

  const decodedCapture = raw.capture === undefined ? undefined : normalizeMemoryCapture(raw.capture);
  if (raw.capture !== undefined && !decodedCapture) return null;
  const capture = decodedCapture ?? undefined;
  if (!hasValidCaptureSourceCombination(raw.source as MemorySourceKind, capture, derivation)) return null;

  let scope: MemoryScope;
  if (raw.scope.type === "global") {
    scope = { type: "global" };
  } else if (raw.scope.type === "project") {
    const projectRoot = normalizeMetadataString(raw.scope.projectRoot, MAX_PROJECT_ROOT_CHARS);
    const projectName = normalizeMetadataString(raw.scope.projectName, MAX_PROJECT_NAME_CHARS);
    if (!projectRoot || (typeof raw.scope.projectRoot === "string" && raw.scope.projectRoot.trim().length > MAX_PROJECT_ROOT_CHARS)) {
      return null;
    }
    if (typeof raw.scope.projectName === "string" && raw.scope.projectName.trim().length > MAX_PROJECT_NAME_CHARS) return null;
    scope = { type: "project", projectRoot, ...(projectName ? { projectName } : {}) };
  } else {
    return null;
  }

  return {
    v: 1,
    id: raw.id as string,
    scope,
    kind: raw.kind as MemoryKind,
    state: raw.state as MemoryState,
    source: raw.source as MemorySourceKind,
    createdAt: raw.createdAt as string,
    ...(raw.confirmedAt ? { confirmedAt: raw.confirmedAt as string } : {}),
    ...(raw.expiresAt ? { expiresAt: raw.expiresAt as string } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
    ...(derivation ? { derivation } : {}),
    ...(capture ? { capture } : {}),
  };
}

function encodeMemoryMetadata(metadata: MemoryMetadataV1): string {
  return Buffer.from(JSON.stringify(metadata), "utf-8").toString("base64url");
}

function noteIsExpired(note: Pick<NoteEntry, "expiresAt">, now = Date.now()): boolean {
  return note.expiresAt !== undefined && Date.parse(note.expiresAt) <= now;
}

function memoryTextTerms(query: string): string[] {
  const terms = query.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return Array.from(new Set(terms)).slice(0, 16);
}

function truncateTextToTokenBudget(value: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || value.trim() === "") return "";
  if (estimateTokens(value) <= tokenBudget) return value;
  const targetChars = Math.max(48, Math.floor(value.length * tokenBudget / estimateTokens(value)) - 1);
  return `${value.slice(0, targetChars).trimEnd()}…`;
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

// Require every prompt-memory reader; absent wiring must fail instead of masquerading as empty memory.
export interface PromptMemorySource {
  getAgentsMd(): string;
  getAgentsCustomMd(): string;
  getProjectAgentsMd(projectRoot: string): ProjectAgentsMd;
  getPromptUserPreferences(): string;
  getPromptMemoryIndex(): string;
  getPromptLongTermMemoryOverview(options?: ProjectScopedMemoryOptions): string;
  selectRelevantMemories(query: string, options?: MemorySelectionOptions): MemorySelection;
}

export class MemoryManager implements PromptMemorySource {
  private readonly aveDir: string;
  private readonly memoryDir: string;
  private readonly sessionsDir: string;
  private readonly toolOutputArtifacts: ToolOutputArtifactStore;
  private readonly unpublishedOutputCaptures: Map<string, Set<string>>;
  private readonly defaultWorkspaceRoot: string | undefined;
  // Keep one search index per manager namespace, never a global singleton.
  private readonly searchIndex: SessionSearchIndex;
  // Root guards block stale writers until re-add; only newly created sessions may bind again.
  private readonly detachedProjectRoots = new Set<string>();
  // Session tombstones survive root re-add so old conversations remain detached.
  private readonly detachedProjectRootsBySession = new Map<string, Set<string>>();
  // Capture policy generation before locking to detect detach/re-add ABA races.
  private readonly projectRootGenerations = new Map<string, number>();
  // Retain terminal state and binding together so late writes cannot regress or reclassify detached wire tasks.
  private readonly detachedWireTerminalTombstones = new Map<string, DetachedWireTerminalTombstone>();
  private paneSessions: Map<string, Set<string>> | null = null;
  private persistentContextWatchers: FSWatcher[] = [];
  private persistentContextReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private persistentContextPollTimer: ReturnType<typeof setInterval> | undefined;
  private persistentContextFileState = new Map<string, number>();
  private get checkpointsDir(): string {
    return join(this.sessionsDir, ".checkpoints");
  }

  private agentsMd: string = "";
  private agentsCustomMd: string = "";
  private memoryIndex: string = "";
  private userPreferences: string = "";

  constructor(options?: MemoryManagerOptions) {
    this.aveDir = resolve(options?.aveDir ?? aveHome());
    this.memoryDir = join(this.aveDir, "memories");
    this.sessionsDir = sessionStorePath(this.aveDir);
    this.toolOutputArtifacts = new ToolOutputArtifactStore(this.sessionsDir);
    this.defaultWorkspaceRoot = normalizeMetadataString(
      options?.defaultWorkspaceRoot,
      MAX_PROJECT_ROOT_CHARS,
    );
    this.searchIndex = new SessionSearchIndex(this.aveDir);
    this.ensureStructure();
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

  load(): void {
    this.agentsMd = this.readFile(AGENTS_DOC_NAME);
    this.agentsCustomMd = this.readFile(AGENTS_CUSTOM_DOC_NAME);
    this.memoryIndex = this.readMemoryIndex();
    this.userPreferences = this.readFile("user-preferences.md");
  }

  startPersistentContextWatcher(): void {
    if (this.persistentContextWatchers.length > 0 || this.persistentContextPollTimer !== undefined) return;
    this.snapshotPersistentContextFiles();
    this.watchDirectoryForPersistentContext(
      this.aveDir,
      new Set([AGENTS_DOC_NAME, AGENTS_CUSTOM_DOC_NAME, "user-preferences.md"]),
    );
    this.watchDirectoryForPersistentContext(this.memoryDir, new Set(["MEMORY.md"]));
    this.startPersistentContextPoller();
  }

  stopPersistentContextWatcher(): void {
    if (this.persistentContextReloadTimer !== undefined) {
      clearTimeout(this.persistentContextReloadTimer);
      this.persistentContextReloadTimer = undefined;
    }
    if (this.persistentContextPollTimer !== undefined) {
      clearInterval(this.persistentContextPollTimer);
      this.persistentContextPollTimer = undefined;
    }
    for (const watcher of this.persistentContextWatchers) {
      try {
        watcher.close();
      } catch {
      }
    }
    this.persistentContextWatchers = [];
    this.persistentContextFileState.clear();
  }

  closeSearchIndex(): void {
    this.searchIndex.close();
  }

  getAgentsMd(): string {
    return this.agentsMd;
  }

  // Keep user context separate from packaged context so editors and merge jobs retain distinct sources.
  getAgentsCustomMd(): string {
    return this.agentsCustomMd;
  }

  private projectAgentsMdCache: { root: string; sig: string; value: ProjectAgentsMd } | null = null;

  // Revalidate every candidate and imported path, including absent files, so newly created instructions invalidate the cache.
  getProjectAgentsMd(projectRoot: string): ProjectAgentsMd {
    const root = resolve(projectRoot);
    const cached = this.projectAgentsMdCache;
    if (cached && cached.root === root && cached.sig === this.projectAgentsMdSignature(cached.value)) {
      return cached.value;
    }
    const value = discoverProjectAgentsMd(root);
    this.projectAgentsMdCache = { root, sig: this.projectAgentsMdSignature(value), value };
    return value;
  }

  private projectAgentsMdSignature(value: ProjectAgentsMd): string {
    return value.watchedPaths.map((path) => this.getFileMtimeMs(path)).join(",");
  }

  getMemoryIndex(options: ProjectScopedMemoryOptions = {}): string {
    if (options.projectRoot) return "";
    return this.memoryIndex;
  }

  // Saved-memory links are navigation metadata, not prompt content; inject selected note bodies separately.
  getPromptMemoryIndex(): string {
    return truncateTextToTokenBudget(this.withoutSavedMemoryIndexEntries(this.memoryIndex), MAX_PROMPT_MEMORY_INDEX_TOKENS);
  }

  getUserPreferences(): string {
    return this.userPreferences;
  }

  getPromptUserPreferences(): string {
    return truncateTextToTokenBudget(this.userPreferences, MAX_PROMPT_USER_PREFERENCES_TOKENS);
  }

  // Snapshots contain exactly one scope; callers needing global and project notes must request each explicitly.
  getConsolidationSnapshot(options: ProjectScopedMemoryOptions = {}): MemoryConsolidationSnapshot {
    return this.getConsolidationSnapshotForScope(this.consolidationScopeFromOptions(options));
  }

  // Suppress derived overviews when their bounded source fingerprint is stale.
  getConsolidatedMemoryOverview(snapshot: MemoryConsolidationSnapshot): NoteEntry | undefined {
    if (!this.isValidConsolidationSnapshot(snapshot)) return undefined;
    const current = this.getConsolidationSnapshotForScope(snapshot.scope);
    if (current.sources.length === 0 || current.sourceFingerprint !== snapshot.sourceFingerprint) {
      return undefined;
    }
    const overview = this.findConsolidatedMemoryOverview(snapshot.scope);
    return overview?.derivation?.sourceFingerprint === snapshot.sourceFingerprint
      ? overview
      : undefined;
  }

  // Derived summaries enter prompts only through their bounded overview section, never ordinary note selection.
  getPromptLongTermMemoryOverview(options: ProjectScopedMemoryOptions = {}): string {
    const globalSnapshot = this.getConsolidationSnapshot();
    const projectSnapshot = this.getConsolidationSnapshot(options);
    const globalOverview = this.getConsolidatedMemoryOverview(globalSnapshot);
    const globalSection = globalOverview
      ? `### ${globalOverview.title}\n${this.memoryBodyForPrompt(globalOverview)}`
      : "";

    // Default workspaces expose global memory only; explicit projects split the bounded overview budget fairly.
    if (projectSnapshot.scope.type !== "project") {
      return truncateTextToTokenBudget(globalSection, MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_TOKENS);
    }
    const projectOverview = this.getConsolidatedMemoryOverview(projectSnapshot);
    const projectSection = projectOverview
      ? `### ${projectOverview.title}\n${this.memoryBodyForPrompt(projectOverview)}`
      : "";
    if (!globalSection || !projectSection) {
      return truncateTextToTokenBudget(
        globalSection || projectSection,
        MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_TOKENS,
      );
    }
    return [
      truncateTextToTokenBudget(globalSection, MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_SCOPE_TOKENS),
      truncateTextToTokenBudget(projectSection, MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_SCOPE_TOKENS),
    ].join("\n\n---\n\n");
  }

  // Recheck source fingerprints under the index lock before committing generated overviews.
  async upsertConsolidatedMemoryIfUnchanged(
    snapshot: MemoryConsolidationSnapshot,
    content: string,
  ): Promise<MemoryConsolidationUpsertResult> {
    if (!this.isValidConsolidationSnapshot(snapshot)) {
      throw new Error("upsertConsolidatedMemoryIfUnchanged: invalid snapshot");
    }
    const title = this.consolidatedOverviewTitle(snapshot.scope);
    const input = this.assertManagedMemoryInput(title, content);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let result: MemoryConsolidationUpsertResult = { status: "sources-changed" };

    await withFileLock(indexPath, async () => {
      const current = this.getConsolidationSnapshotForScope(snapshot.scope);
      if (current.sources.length === 0) {
        result = { status: "empty" };
        return;
      }
      if (current.sourceFingerprint !== snapshot.sourceFingerprint) return;

      const existing = this.findConsolidatedMemoryOverview(snapshot.scope);
      const now = new Date().toISOString();
      const metadata: MemoryMetadataV1 = {
        v: 1,
        id: existing?.id ?? randomUUID(),
        scope: snapshot.scope,
        kind: "reference",
        state: "active",
        source: "assistant",
        createdAt: existing?.createdAt ?? now,
        confirmedAt: now,
        derivation: {
          v: 1,
          type: "consolidated-overview",
          sourceFingerprint: snapshot.sourceFingerprint,
          generatedAt: now,
        },
      };
      const filename = existing?.filename ?? this.allocateMemoryFilename(input.title, metadata.id);
      const visibleContent = `# ${input.title}\n\n${input.content}\n`;
      const storedContent = [
        MEMORY_MARKER,
        `${MEMORY_METADATA_PREFIX}${encodeMemoryMetadata(metadata)}${MEMORY_METADATA_SUFFIX}`,
        visibleContent,
      ].join("\n");
      writeFileSync(join(this.memoryDir, filename), storedContent, "utf-8");
      // Keep generated overviews out of navigation indexes and ordinary memory selection.
      this.removeMemoryIndexEntryLocked(filename, indexPath);
      result = {
        status: "updated",
        entry: this.entryFromMemoryMetadata(filename, input.title, visibleContent, metadata, now),
      };
    });

    this.memoryIndex = this.readMemoryIndex();
    return result;
  }

  listMemoryEntries(options: MemoryReadOptions = {}): NoteEntry[] {
    return this.readMarkdownEntries(this.memoryDir, options);
  }

  // Global refresh includes unscoped legacy records but never project-scoped managed memories.
  listGlobalMemoryEntries(options: Pick<MemoryReadOptions, "includeCandidates"> = {}): NoteEntry[] {
    return this.listMemoryEntries(options).filter((entry) => !entry.projectRoot);
  }

  /** Candidates are review-only and never enter normal prompt/list reads. */
  listMemoryCandidates(options: ProjectScopedMemoryOptions = {}): NoteEntry[] {
    // Candidate reviews expose global plus the selected project only; detached callers cannot enumerate projects.
    return this.readMarkdownEntries(this.memoryDir, {
      includeCandidates: true,
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      ...(options.projectName ? { projectName: options.projectName } : {}),
    })
      .filter((entry) => entry.state === "candidate" && this.matchesCandidateReviewScope(entry, options));
  }

  searchMemoryEntries(query: string, options: MemoryReadOptions = {}): NoteEntry[] {
    return this.searchEntries(this.listMemoryEntries(options), query);
  }

  searchSessions(query: string, options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped"> = {}): SessionSearchEntry[] {
    // Require two code points; exactly two use LIKE because trigram MATCH requires three.
    if ([...query.trim()].length < 2) return [];
    if (!this.searchIndex.open()) return [];
    try {
      return this.searchIndex.query(query, {
        kind: options.kind,
        routineId: options.routineId,
        projectRoot: options.projectRoot,
        includeUnscoped: options.includeUnscoped,
      });
    } finally {
      this.searchIndex.close();
    }
  }

  getMemoryContext(options: ProjectScopedMemoryOptions = {}): string {
    return this.buildMarkdownContext(
      this.listMemoryEntries(options).filter((entry) => !this.isDerivedMemory(entry)),
    );
  }

  // Select active memory by request relevance instead of charging every note to every prompt.
  selectRelevantMemories(query: string, options: MemorySelectionOptions = {}): MemorySelection {
    const tokenBudget = Math.max(1, Math.min(options.tokenBudget ?? DEFAULT_MEMORY_SELECTION_TOKEN_BUDGET, 8_000));
    const maxEntries = Math.max(1, Math.min(options.maxEntries ?? DEFAULT_MEMORY_SELECTION_MAX_ENTRIES, 24));
    const ranked = this.rankPromptVisibleMemories(query, options, { includeUnmatchedPinned: true });

    const selected: NoteEntry[] = [];
    const sections: string[] = [];
    for (const { entry } of ranked) {
      if (selected.length >= maxEntries) break;
      const separator = sections.length > 0 ? "\n\n---\n\n" : "";
      const existing = sections.join("\n\n---\n\n");
      const remaining = tokenBudget - estimateTokens(existing) - estimateTokens(separator);
      if (remaining < 16) break;
      const heading = `### ${entry.title}\n`;
      const fullSection = `${heading}${this.memoryBodyForPrompt(entry)}`;
      const sectionBudget = Math.min(MAX_MEMORY_SELECTION_ENTRY_TOKENS, remaining);
      const section = estimateTokens(fullSection) <= sectionBudget
        ? fullSection
        : `${heading}${truncateTextToTokenBudget(this.memoryBodyForPrompt(entry), sectionBudget - estimateTokens(heading))}`;
      if (section.trim() === "" || estimateTokens(section) > remaining) continue;
      selected.push(entry);
      sections.push(section);
    }

    const context = sections.join("\n\n---\n\n");
    return { entries: selected, context, usedTokens: context ? estimateTokens(context) : 0 };
  }
  // Recall shares prompt eligibility and scoring, but unmatched pinned notes do not become search results.
  searchModelVisibleMemories(query: string, options: ProjectScopedMemoryOptions = {}): NoteEntry[] {
    if (memoryTextTerms(query).length === 0) {
      return this.listPromptVisibleMemories(options).sort((left, right) =>
        String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
        || left.filename.localeCompare(right.filename));
    }
    return this.rankPromptVisibleMemories(query, options, { includeUnmatchedPinned: false }).map(({ entry }) => entry);
  }

  private listPromptVisibleMemories(options: ProjectScopedMemoryOptions): NoteEntry[] {
    return this.listMemoryEntries({
      projectRoot: options.projectRoot,
      projectName: options.projectName,
      includeUnscoped: options.includeUnscoped,
    }).filter((entry) => this.isPromptVisibleMemory(entry, options));
  }

  private rankPromptVisibleMemories(
    query: string,
    options: ProjectScopedMemoryOptions,
    policy: { includeUnmatchedPinned: boolean },
  ): Array<{ entry: NoteEntry; score: number }> {
    const terms = memoryTextTerms(query);
    const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase();
    return this.listPromptVisibleMemories(options)
      .flatMap((entry) => {
        const title = entry.title.normalize("NFKC").toLocaleLowerCase();
        const content = entry.content.normalize("NFKC").toLocaleLowerCase();
        let matched = 0;
        if (terms.length === 0) {
          return entry.pinned && policy.includeUnmatchedPinned ? [{ entry, score: 8 }] : [];
        }
        for (const term of terms) {
          if (title.includes(term)) matched += 18;
          if (content.includes(term)) matched += 5;
        }
        if (normalizedQuery.length >= 2 && title.includes(normalizedQuery)) matched += 12;
        if (normalizedQuery.length >= 2 && content.includes(normalizedQuery)) matched += 4;
        if (matched === 0 && !(entry.pinned && policy.includeUnmatchedPinned)) return [];
        return [{ entry, score: matched + (entry.pinned ? 8 : 0) }];
      })
      .sort((left, right) =>
        right.score - left.score
        || Number(right.entry.pinned === true) - Number(left.entry.pinned === true)
        || String(right.entry.updatedAt ?? "").localeCompare(String(left.entry.updatedAt ?? ""))
        || left.entry.filename.localeCompare(right.entry.filename),
      );
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

  async saveMemory(title: string, content: string, options: MemorySaveOptions = {}): Promise<NoteEntry> {
    const input = this.assertManagedMemoryInput(title, content);
    let metadata = this.createMemoryMetadata(options);
    const visibleContent = `# ${input.title}\n\n${input.content}\n`;
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let filename = "";

    await withFileLock(indexPath, async () => {
      const existing = this.findExistingManagedMemory(
        input.title,
        metadata.scope,
        metadata.state,
        metadata.source,
        metadata.capture?.trigger,
      );
      if (existing) {
        // State and source are collision boundaries; same-title records from other lifecycle paths cannot overwrite each other.
        const mustPreserveExisting =
          metadata.state !== existing.metadata.state
          || metadata.source !== existing.metadata.source
          || metadata.capture?.trigger !== existing.metadata.capture?.trigger;
        if (mustPreserveExisting) {
          filename = this.allocateMemoryFilename(input.title, metadata.id);
        } else {
          filename = existing.filename;
          metadata = this.mergeExistingMemoryMetadata(existing.metadata, metadata, options);
        }
      } else {
        filename = this.allocateMemoryFilename(input.title, metadata.id);
      }

      const storedContent = [
        MEMORY_MARKER,
        `${MEMORY_METADATA_PREFIX}${encodeMemoryMetadata(metadata)}${MEMORY_METADATA_SUFFIX}`,
        visibleContent,
      ].join("\n");
      writeFileSync(join(this.memoryDir, filename), storedContent, "utf-8");
      if (metadata.scope.type === "global" && metadata.state === "active") {
        this.updateMemoryIndexLocked(indexPath, filename, input.title, input.content);
      } else {
        this.removeMemoryIndexEntryLocked(filename, indexPath);
      }
    });

    this.memoryIndex = this.readMemoryIndex();
    return this.entryFromMemoryMetadata(filename, input.title, visibleContent, metadata, new Date().toISOString());
  }

  // Approve by immutable identity and recheck review scope under the write lock.
  async activateMemoryCandidate(
    id: string,
    options: ProjectScopedMemoryOptions = {},
  ): Promise<NoteEntry> {
    const safeId = this.validateManagedMemoryId(id, "activateMemoryCandidate");
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let activated: NoteEntry | undefined;

    await withFileLock(indexPath, async () => {
      const found = this.findManagedMemoryById(safeId);
      if (
        !found
        || found.metadata.state !== "candidate"
        || !this.memoryScopeVisibleForCandidateReview(found.metadata.scope, options)
      ) {
        throw new Error("activateMemoryCandidate: candidate not found");
      }

      const metadata: MemoryMetadataV1 = {
        ...found.metadata,
        state: "active",
        confirmedAt: new Date().toISOString(),
      };
      const storedContent = [
        MEMORY_MARKER,
        `${MEMORY_METADATA_PREFIX}${encodeMemoryMetadata(metadata)}${MEMORY_METADATA_SUFFIX}`,
        found.content,
      ].join("\n");
      writeFileSync(join(this.memoryDir, found.filename), storedContent, "utf-8");

      if (metadata.scope.type === "global") {
        this.updateMemoryIndexLocked(
          indexPath,
          found.filename,
          found.title,
          this.memoryBodyForPrompt({ filename: found.filename, title: found.title, content: found.content }),
        );
      } else {
        this.removeMemoryIndexEntryLocked(found.filename, indexPath);
      }
      activated = this.entryFromMemoryMetadata(
        found.filename,
        found.title,
        found.content,
        metadata,
        new Date().toISOString(),
      );
    });

    this.memoryIndex = this.readMemoryIndex();
    return activated!;
  }

  async deleteMemoryCandidate(id: string, options: ProjectScopedMemoryOptions = {}): Promise<void> {
    const safeId = this.validateManagedMemoryId(id, "deleteMemoryCandidate");
    const indexPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(indexPath, async () => {
      const found = this.findManagedMemoryById(safeId);
      if (
        !found
        || found.metadata.state !== "candidate"
        || !this.memoryScopeVisibleForCandidateReview(found.metadata.scope, options)
      ) {
        throw new Error("deleteMemoryCandidate: candidate not found");
      }
      unlinkIfPresent(join(this.memoryDir, found.filename));
      this.removeMemoryIndexEntryLocked(found.filename, indexPath);
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  async updateMemoryIndex(content: string): Promise<void> {
    const targetPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  async updateMemoryIndexIfUnchanged(expectedContent: string, nextContent: string): Promise<boolean> {
    const targetPath = join(this.memoryDir, "MEMORY.md");
    let didUpdate = false;
    await withFileLock(targetPath, async () => {
      const current = readUtf8FileIfPresent(targetPath) ?? "";
      if (current !== expectedContent) return;
      writeFileSync(targetPath, nextContent, "utf-8");
      didUpdate = true;
    });
    this.memoryIndex = this.readMemoryIndex();
    return didUpdate;
  }

  async updateMemoryIndexSections(sections: MemoryIndexSectionsPatch): Promise<void> {
    const targetPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(targetPath, async () => {
      const current = readUtf8FileIfPresent(targetPath) ?? getDefaultMemoryIndex();
      writeFileSync(targetPath, this.patchMemoryIndexSections(current, sections), "utf-8");
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  async deleteMemory(filename: string, options: ProjectScopedMemoryOptions = {}): Promise<void> {
    const safeFilename = this.validateDeletableMemoryFilename(filename);
    const path = join(this.memoryDir, safeFilename);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(indexPath, async () => {
      const snapshot = readUtf8FileSnapshotIfPresent(path, MAX_LEGACY_MEMORY_FILE_BYTES);
      if (snapshot?.tooLarge) {
        throw new Error("deleteMemory: memory file exceeds the supported size");
      }
      if (snapshot) {
        if (this.hasMemoryMarker(snapshot.content) && snapshot.size > MAX_MANAGED_MEMORY_FILE_BYTES) {
          throw new Error("deleteMemory: managed memory file exceeds the supported size");
        }
        const parsed = this.parseMemoryNote(snapshot.content);
        if (parsed.invalidMetadata) throw new Error("deleteMemory: invalid memory metadata");
        const title = parsed.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim() || safeFilename.replace(/\.md$/i, "");
        const entry = parsed.metadata
          ? this.entryFromMemoryMetadata(safeFilename, title, parsed.content, parsed.metadata, snapshot.mtime.toISOString())
          : {
              filename: safeFilename,
              title,
              content: parsed.content,
              ...(parsed.legacyProject.projectRoot ? { projectRoot: parsed.legacyProject.projectRoot } : {}),
              ...(parsed.legacyProject.projectName ? { projectName: parsed.legacyProject.projectName } : {}),
            };
        if (!this.memoryScopeVisibleForMutation(entry, options)) {
          throw new Error("deleteMemory: memory does not belong to the selected scope");
        }
      }
      unlinkIfPresent(path);
      this.removeMemoryIndexEntryLocked(safeFilename, indexPath);
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  async updateAgentsMd(content: string): Promise<void> {
    const targetPath = join(this.aveDir, AGENTS_DOC_NAME);
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.agentsMd = content;
  }

  async updateAgentsCustomMd(content: string): Promise<void> {
    const targetPath = join(this.aveDir, AGENTS_CUSTOM_DOC_NAME);
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.agentsCustomMd = content;
  }

  // Compare-and-swap prevents a delayed model merge from overwriting a newer manual edit.
  async updateAgentsMdIfUnchanged(expectedContent: string, nextContent: string): Promise<boolean> {
    const didWrite = await this.replaceHomeDocIfUnchanged(
      AGENTS_DOC_NAME,
      expectedContent,
      nextContent,
    );
    this.agentsMd = didWrite ? nextContent : this.readFile(AGENTS_DOC_NAME);
    return didWrite;
  }

  async updateAgentsCustomMdIfUnchanged(
    expectedContent: string,
    nextContent: string,
  ): Promise<boolean> {
    const didWrite = await this.replaceHomeDocIfUnchanged(
      AGENTS_CUSTOM_DOC_NAME,
      expectedContent,
      nextContent,
    );
    this.agentsCustomMd = didWrite ? nextContent : this.readFile(AGENTS_CUSTOM_DOC_NAME);
    return didWrite;
  }

  // Missing docs compare as empty; commit under the shared lock only if the reviewed text remains current.
  private async replaceHomeDocIfUnchanged(
    name: string,
    expectedContent: string,
    nextContent: string,
  ): Promise<boolean> {
    const targetPath = join(this.aveDir, name);
    let didWrite = false;
    await withFileLock(targetPath, async () => {
      didWrite = replaceUtf8FileAtomicSyncIf(
        targetPath,
        nextContent,
        () => (readUtf8FileIfPresent(targetPath) ?? "") === expectedContent,
      );
    });
    return didWrite;
  }

  async updateUserPreferences(content: string): Promise<void> {
    const targetPath = join(this.aveDir, "user-preferences.md");
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.userPreferences = content;
  }

  // Background preference refresh must compare-and-swap against concurrent manual edits.
  async updateUserPreferencesIfUnchanged(expectedContent: string, nextContent: string): Promise<boolean> {
    const didWrite = await this.replaceHomeDocIfUnchanged(
      "user-preferences.md",
      expectedContent,
      nextContent,
    );
    this.userPreferences = didWrite ? nextContent : this.readFile("user-preferences.md");
    return didWrite;
  }

  getDir(): string {
    return this.aveDir;
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
    writeUtf8FileAtomicSync(targetPath, lines);
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
    return recoverInterruptedTurn(
      messages,
      record,
      (seed) => derivedRowId(sessionId, seed),
      { toolResultUnknown: t("be_conversationLoop.hostExitToolResultUnknown") },
    );
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
    const mtimeMs = this.getFileMtimeMs(join(this.sessionsDir, `${sessionId}.jsonl`));
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
    const metadataTargets = readdirIfPresent(this.sessionsDir)
      .filter((file) => file.endsWith(".meta.json"))
      .map((file) => ({
        sessionId: file.slice(0, -".meta.json".length),
        targetPath: join(this.sessionsDir, file),
      }))
      .filter(({ sessionId }) => isValidSessionId(sessionId))
      .sort((a, b) => a.targetPath.localeCompare(b.targetPath));

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
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new TypeError("session metadata must be an object");
          }
          const storedRoot = typeof parsed.projectRoot === "string"
            ? parsed.projectRoot
            : undefined;
          if (!storedRoot || !projectRootEquals(storedRoot, projectRoot)) continue;
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
      .map((session) => {
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
          title: resolveConversationTitle({ sessionId: session.id, title: metadata?.title || summary.title, routineTitle: metadata?.routineTitle }, t),
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
      });
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

  private ensureStructure(): void {
    mkdirSync(this.aveDir, { recursive: true });
    this.migrateLegacyDirectory("memory", "memories");

    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });
    this.restrictSessionsDirWrites();

    // Use exclusive creation to eliminate check-then-write races.
    this.writeDefaultIfAbsent(join(this.aveDir, "AGENTS.md"), t("be_memoryManager.defaultAgentsMd"));
    this.writeDefaultIfAbsent(join(this.aveDir, "user-preferences.md"), t("be_memoryManager.defaultUserPrefs"));
    this.writeDefaultIfAbsent(join(this.memoryDir, "MEMORY.md"), getDefaultMemoryIndex());
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

  private writeDefaultIfAbsent(path: string, content: string): void {
    try {
      writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  private readFile(name: string): string {
    const path = join(this.aveDir, name);
    return readUtf8FileIfPresent(path) ?? "";
  }

  private readMemoryIndex(): string {
    const path = join(this.memoryDir, "MEMORY.md");
    const raw = readUtf8FileIfPresent(path);
    return raw === null ? "" : this.truncateMemoryIndex(raw);
  }

  private watchDirectoryForPersistentContext(dir: string, filenames: Set<string>): void {
    try {
      const watcher = watch(dir, { persistent: false }, (_eventType, changedName) => {
        const name = typeof changedName === "string" ? basename(changedName) : "";
        if (name !== "" && !filenames.has(name)) return;
        this.schedulePersistentContextReload(name || dir);
      });
      watcher.on("error", (err) => {
        log.warn({ dir, err }, "persistent context watcher failed");
        this.schedulePersistentContextReload(`${dir}:watcher-error`);
      });
      this.persistentContextWatchers.push(watcher);
    } catch (err) {
      log.warn({ dir, err }, "persistent context watcher unavailable");
    }
  }

  private persistentContextFiles(): string[] {
    return [
      join(this.aveDir, AGENTS_DOC_NAME),
      join(this.aveDir, AGENTS_CUSTOM_DOC_NAME),
      join(this.aveDir, "user-preferences.md"),
      join(this.memoryDir, "MEMORY.md"),
    ];
  }

  private snapshotPersistentContextFiles(): void {
    this.persistentContextFileState.clear();
    for (const path of this.persistentContextFiles()) {
      this.persistentContextFileState.set(path, this.getFileMtimeMs(path));
    }
  }

  private startPersistentContextPoller(): void {
    if (this.persistentContextPollTimer !== undefined) return;
    const timer = setInterval(() => {
      let changed = false;
      for (const path of this.persistentContextFiles()) {
        const previous = this.persistentContextFileState.get(path);
        const current = this.getFileMtimeMs(path);
        if (previous !== current) {
          this.persistentContextFileState.set(path, current);
          changed = true;
        }
      }
      if (changed) this.schedulePersistentContextReload("persistent-context-poll");
    }, 500);
    const maybeNodeTimer = timer as ReturnType<typeof setInterval> & { unref?: () => void };
    maybeNodeTimer.unref?.();
    this.persistentContextPollTimer = timer;
  }

  private getFileMtimeMs(path: string): number {
    try {
      return statPathIfPresent(path)?.mtimeMs ?? -1;
    } catch {
      return -1;
    }
  }

  private schedulePersistentContextReload(reason: string): void {
    if (this.persistentContextReloadTimer !== undefined) {
      clearTimeout(this.persistentContextReloadTimer);
    }
    const timer = setTimeout(() => {
      this.persistentContextReloadTimer = undefined;
      try {
        this.load();
        log.info({ reason }, "persistent context reloaded");
      } catch (err) {
        log.warn({ reason, err }, "persistent context reload failed");
      }
    }, 75);
    const maybeNodeTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
    maybeNodeTimer.unref?.();
    this.persistentContextReloadTimer = timer;
  }

  private buildMarkdownContext(entries: NoteEntry[]): string {
    if (entries.length === 0) return "";
    return entries
      .map((entry) => `### ${entry.title}\n${entry.content}`)
      .join("\n\n---\n\n");
  }

  private readMarkdownEntries(
    dir: string,
    options: MemoryReadOptions & { excludeMarkedMemory?: boolean } = {},
  ): NoteEntry[] {
    return readdirIfPresent(dir)
      .filter((filename) => filename.endsWith(".md"))
      .flatMap((filename) => {
        if (this.isMemoryIndexFilename(filename)) return [];
        const snapshot = readUtf8FileSnapshotIfPresent(join(dir, filename), MAX_LEGACY_MEMORY_FILE_BYTES);
        if (!snapshot || snapshot.tooLarge) return [];
        if (this.hasMemoryMarker(snapshot.content) && snapshot.size > MAX_MANAGED_MEMORY_FILE_BYTES) return [];
        const parsed = this.parseMemoryNote(snapshot.content);
        if (parsed.invalidMetadata || (options.excludeMarkedMemory && this.hasMemoryMarker(snapshot.content))) return [];
        const titleMatch = parsed.content.match(/^#\s+([^\r\n]+)/);
        const entry = parsed.metadata
          ? this.entryFromMemoryMetadata(
              filename,
              titleMatch?.[1]?.trim() || filename.replace(/\.md$/i, ""),
              parsed.content,
              parsed.metadata,
              snapshot.mtime.toISOString(),
            )
          : {
              filename,
              title: titleMatch?.[1]?.trim() || filename.replace(/\.md$/i, ""),
              content: parsed.content,
              updatedAt: snapshot.mtime.toISOString(),
              ...(parsed.legacyProject.projectRoot ? { projectRoot: parsed.legacyProject.projectRoot } : {}),
              ...(parsed.legacyProject.projectName ? { projectName: parsed.legacyProject.projectName } : {}),
            };
        return this.matchesMemoryRead(entry, options) ? [entry] : [];
      })
      .sort((left, right) =>
        new Date(right.updatedAt ?? 0).getTime() - new Date(left.updatedAt ?? 0).getTime()
        || left.filename.localeCompare(right.filename),
      );
  }

  private searchEntries(entries: NoteEntry[], query: string): NoteEntry[] {
    const lower = query.toLocaleLowerCase();
    return entries.filter(
      (note) => note.title.toLocaleLowerCase().includes(lower) || note.content.toLocaleLowerCase().includes(lower),
    ).slice(0, 50);
  }

  private hasMemoryMarker(content: string): boolean {
    const firstLine = content.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
    return /^<!--\s*ave:kind=memory\s*-->$/i.test(firstLine);
  }

  private parseMemoryNote(rawContent: string): ParsedMemoryNote {
    const lines = rawContent.replace(/^\uFEFF/, "").split(/\r?\n/);
    let cursor = 0;
    let encodedMetadata: string | undefined;
    let projectRoot: string | undefined;
    let projectName: string | undefined;
    let invalidMetadata = false;

    while (cursor < lines.length) {
      const line = lines[cursor] ?? "";
      if (/^<!--\s*ave:kind=memory\s*-->$/i.test(line)) {
        cursor += 1;
        continue;
      }
      if (/^<!--\s*ave:memory-meta:/i.test(line)) {
        const match = /^<!--\s*ave:memory-meta:([A-Za-z0-9_-]+)\s*-->$/i.exec(line);
        if (!match || encodedMetadata !== undefined) invalidMetadata = true;
        else encodedMetadata = match[1];
        cursor += 1;
        continue;
      }
      const rootMatch = new RegExp(`^${escapeRegExp(MEMORY_PROJECT_ROOT_PREFIX)}\\s*(.*?)\\s*-->$`, "i").exec(line);
      if (rootMatch) {
        if (projectRoot !== undefined) invalidMetadata = true;
        else {
          const normalizedRoot = normalizeMetadataString(rootMatch[1], MAX_PROJECT_ROOT_CHARS);
          if (!normalizedRoot) invalidMetadata = true;
          else projectRoot = normalizedRoot;
        }
        cursor += 1;
        continue;
      }
      const nameMatch = new RegExp(`^${escapeRegExp(MEMORY_PROJECT_NAME_PREFIX)}\\s*(.*?)\\s*-->$`, "i").exec(line);
      if (nameMatch) {
        if (projectName !== undefined) invalidMetadata = true;
        else {
          const normalizedName = normalizeMetadataString(nameMatch[1], MAX_PROJECT_NAME_CHARS);
          if (!normalizedName) invalidMetadata = true;
          else projectName = normalizedName;
        }
        cursor += 1;
        continue;
      }
      if (/^<!--\s*ave:/i.test(line)) invalidMetadata = true;
      break;
    }

    const content = lines.slice(cursor).join("\n");
    if (encodedMetadata !== undefined) {
      const metadata = !invalidMetadata ? decodeMemoryMetadata(encodedMetadata) : null;
      return { content, metadata: metadata ?? undefined, legacyProject: {}, invalidMetadata: metadata === null || invalidMetadata };
    }
    return {
      content,
      legacyProject: {
        ...(projectRoot ? { projectRoot } : {}),
        ...(projectName ? { projectName } : {}),
      },
      invalidMetadata,
    };
  }

  private matchesMemoryRead(entry: NoteEntry, options: MemoryReadOptions): boolean {
    if (entry.state === "candidate" && options.includeCandidates !== true) return false;
    if (noteIsExpired(entry)) return false;
    const isManagedGlobal = entry.id !== undefined && !entry.projectRoot;
    if (options.scope === "global") return isManagedGlobal;
    // Detached callers cannot enumerate project-managed memory; retain visibility of unscoped legacy notes.
    if (!options.projectRoot) return !entry.projectRoot;
    if (isManagedGlobal) return true;
    return projectRootEquals(entry.projectRoot, options.projectRoot)
      || (options.includeUnscoped === true && !entry.projectRoot);
  }

  private matchesCandidateReviewScope(entry: NoteEntry, options: ProjectScopedMemoryOptions): boolean {
    if (entry.id === undefined || entry.state !== "candidate") return false;
    const scope: MemoryScope = entry.projectRoot
      ? {
          type: "project",
          projectRoot: entry.projectRoot,
          ...(entry.projectName ? { projectName: entry.projectName } : {}),
        }
      : { type: "global" };
    return this.memoryScopeVisibleForCandidateReview(scope, options);
  }

  private memoryScopeVisibleForCandidateReview(
    scope: MemoryScope,
    options: ProjectScopedMemoryOptions,
  ): boolean {
    if (!options.projectRoot) return scope.type === "global";
    return scope.type === "global" || projectRootEquals(scope.projectRoot, options.projectRoot);
  }

  private memoryScopeVisibleForMutation(entry: NoteEntry, options: ProjectScopedMemoryOptions): boolean {
    if (!options.projectRoot) return !entry.projectRoot;
    return !entry.projectRoot || projectRootEquals(entry.projectRoot, options.projectRoot);
  }

  private isPromptVisibleMemory(entry: NoteEntry, options: MemorySelectionOptions): boolean {
    if (this.isDerivedMemory(entry) || entry.state === "candidate" || noteIsExpired(entry)) return false;
    if (!options.projectRoot) return entry.id !== undefined ? !entry.projectRoot : !entry.projectRoot;
    if (entry.id !== undefined && !entry.projectRoot) return true;
    return projectRootEquals(entry.projectRoot, options.projectRoot)
      || (options.includeUnscoped === true && !entry.projectRoot);
  }

  private memoryBodyForPrompt(entry: NoteEntry): string {
    return entry.content.replace(/^#\s+[^\r\n]+\r?\n?/, "").trim();
  }

  private withoutSavedMemoryIndexEntries(markdown: string): string {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const kept: string[] = [];
    let skippingSavedMemories = false;
    for (const line of lines) {
      if (/^##\s+Saved Memories\s*$/i.test(line)) {
        skippingSavedMemories = true;
        continue;
      }
      if (skippingSavedMemories && /^##\s+/.test(line)) skippingSavedMemories = false;
      if (!skippingSavedMemories) kept.push(line);
    }
    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  private assertManagedMemoryInput(title: string, content: string): { title: string; content: string } {
    const safeTitle = typeof title === "string" ? title.trim() : "";
    const safeContent = typeof content === "string" ? content.trim() : "";
    if (!safeTitle || !safeContent) throw new Error("saveMemory: title and content are required");
    if (safeTitle.length > MAX_MANAGED_MEMORY_TITLE_CHARS) {
      throw new Error(`saveMemory: title exceeds ${MAX_MANAGED_MEMORY_TITLE_CHARS} characters`);
    }
    if (safeContent.length > MAX_MANAGED_MEMORY_CONTENT_CHARS) {
      throw new Error(`saveMemory: content exceeds ${MAX_MANAGED_MEMORY_CONTENT_CHARS} characters`);
    }
    if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(safeTitle)) {
      throw new Error("saveMemory: title must be a single-line label without control characters");
    }
    if (/<!--\s*ave:/i.test(`${safeTitle}\n\n${safeContent}`)) {
      throw new Error("saveMemory: the ave marker namespace is reserved");
    }
    return { title: safeTitle, content: safeContent };
  }

  private createMemoryMetadata(options: MemorySaveOptions): MemoryMetadataV1 {
    const kind = options.kind ?? "note";
    const state = options.state ?? "active";
    const source = options.source ?? "user";
    if (!MEMORY_KINDS.has(kind)) throw new Error("saveMemory: invalid memory kind");
    if (!MEMORY_STATES.has(state)) throw new Error("saveMemory: invalid memory state");
    if (!MEMORY_SOURCES.has(source)) throw new Error("saveMemory: invalid memory source");
    if (options.confirmedAt !== undefined && !isValidMemoryTimestamp(options.confirmedAt)) {
      throw new Error("saveMemory: invalid confirmedAt timestamp");
    }
    if (options.expiresAt !== undefined && !isValidMemoryTimestamp(options.expiresAt)) {
      throw new Error("saveMemory: invalid expiresAt timestamp");
    }
    if (state === "candidate" && options.confirmedAt !== undefined) {
      throw new Error("saveMemory: candidate memory cannot be confirmed");
    }
    const normalizedCapture = options.capture === undefined ? undefined : normalizeMemoryCapture(options.capture);
    if (options.capture !== undefined && !normalizedCapture) throw new Error("saveMemory: invalid capture provenance");
    const capture = normalizedCapture ?? undefined;
    if (!hasValidCaptureSourceCombination(source, capture)) {
      throw new Error("saveMemory: capture provenance does not match the memory source");
    }

    const projectRoot = normalizeMetadataString(options.projectRoot, MAX_PROJECT_ROOT_CHARS);
    const projectName = normalizeMetadataString(options.projectName, MAX_PROJECT_NAME_CHARS);
    if (typeof options.projectRoot === "string" && options.projectRoot.trim().length > MAX_PROJECT_ROOT_CHARS) {
      throw new Error("saveMemory: projectRoot exceeds the maximum length");
    }
    if (typeof options.projectName === "string" && options.projectName.trim().length > MAX_PROJECT_NAME_CHARS) {
      throw new Error("saveMemory: projectName exceeds the maximum length");
    }
    const now = new Date().toISOString();
    const scope: MemoryScope = projectRoot
      ? { type: "project", projectRoot, ...(projectName ? { projectName } : {}) }
      : { type: "global" };
    return {
      v: 1,
      id: randomUUID(),
      scope,
      kind,
      state,
      source,
      createdAt: now,
      ...(state === "active" ? { confirmedAt: options.confirmedAt ?? now } : {}),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      ...(options.pinned === true ? { pinned: true } : {}),
      ...(capture ? { capture: { ...capture } } : {}),
    };
  }

  private mergeExistingMemoryMetadata(
    existing: MemoryMetadataV1,
    requested: MemoryMetadataV1,
    options: MemorySaveOptions,
  ): MemoryMetadataV1 {
    const state = options.state ?? existing.state;
    if (existing.state === "candidate" && state !== "candidate") {
      throw new Error("saveMemory: candidate memories must be activated by id");
    }
    const pinned = options.pinned === undefined ? existing.pinned : options.pinned === true;
    const expiresAt = options.expiresAt ?? existing.expiresAt;
    return {
      v: 1,
      id: existing.id,
      scope: existing.scope,
      kind: options.kind ?? existing.kind,
      state,
      source: options.source ?? existing.source,
      createdAt: existing.createdAt,
      ...(state === "active"
        ? { confirmedAt: existing.confirmedAt ?? requested.confirmedAt ?? new Date().toISOString() }
        : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(pinned ? { pinned: true } : {}),
      ...(requested.capture ?? existing.capture ? { capture: { ...(requested.capture ?? existing.capture)! } } : {}),
    };
  }

  private entryFromMemoryMetadata(
    filename: string,
    title: string,
    content: string,
    metadata: MemoryMetadataV1,
    updatedAt: string,
  ): NoteEntry {
    const project = metadata.scope.type === "project" ? metadata.scope : undefined;
    return {
      filename,
      title,
      content,
      updatedAt,
      id: metadata.id,
      kind: metadata.kind,
      state: metadata.state,
      source: metadata.source,
      createdAt: metadata.createdAt,
      ...(metadata.confirmedAt ? { confirmedAt: metadata.confirmedAt } : {}),
      ...(metadata.expiresAt ? { expiresAt: metadata.expiresAt } : {}),
      ...(metadata.pinned ? { pinned: true } : {}),
      ...(metadata.derivation ? { derivation: { ...metadata.derivation } } : {}),
      ...(metadata.capture ? { capture: { ...metadata.capture } } : {}),
      ...(project?.projectRoot ? { projectRoot: project.projectRoot } : {}),
      ...(project?.projectName ? { projectName: project.projectName } : {}),
    };
  }

  private memoryScopesEqual(left: MemoryScope, right: MemoryScope): boolean {
    if (left.type === "global") return right.type === "global";
    if (right.type !== "project") return false;
    return projectRootEquals(left.projectRoot, right.projectRoot);
  }

  private consolidationScopeFromOptions(options: ProjectScopedMemoryOptions): MemoryScope {
    const projectRoot = normalizeMetadataString(options.projectRoot, MAX_PROJECT_ROOT_CHARS);
    if (!projectRoot) return { type: "global" };
    const projectName = normalizeMetadataString(options.projectName, MAX_PROJECT_NAME_CHARS);
    return {
      type: "project",
      projectRoot,
      ...(projectName ? { projectName } : {}),
    };
  }

  private cloneMemoryScope(scope: MemoryScope): MemoryScope {
    return scope.type === "global"
      ? { type: "global" }
      : {
          type: "project",
          projectRoot: scope.projectRoot,
          ...(scope.projectName ? { projectName: scope.projectName } : {}),
        };
  }

  private isValidConsolidationScope(scope: unknown): scope is MemoryScope {
    if (!isRecord(scope)) return false;
    if (scope.type === "global") return true;
    return scope.type === "project"
      && typeof scope.projectRoot === "string"
      && scope.projectRoot.length <= MAX_PROJECT_ROOT_CHARS
      && projectRootKey(scope.projectRoot) !== undefined
      && (scope.projectName === undefined
        || (typeof scope.projectName === "string" && scope.projectName.length <= MAX_PROJECT_NAME_CHARS));
  }

  private isValidConsolidationSnapshot(snapshot: unknown): snapshot is MemoryConsolidationSnapshot {
    return isRecord(snapshot)
      && this.isValidConsolidationScope(snapshot.scope)
      && Array.isArray(snapshot.sources)
      && typeof snapshot.sourceFingerprint === "string"
      && SHA256_HEX.test(snapshot.sourceFingerprint);
  }

  private getConsolidationSnapshotForScope(scope: MemoryScope): MemoryConsolidationSnapshot {
    const sourceOptions: MemoryReadOptions = scope.type === "project"
      ? { projectRoot: scope.projectRoot }
      : this.defaultWorkspaceRoot
        ? { projectRoot: this.defaultWorkspaceRoot, includeUnscoped: true }
        : {};
    const sources = this.readMarkdownEntries(this.memoryDir, sourceOptions)
      .filter((entry) => (
        this.entryMatchesConsolidationScope(entry, scope)
        || this.isDefaultWorkspaceGlobalSource(entry, scope)
      ) && this.isConsolidationSource(entry))
      .slice(0, MAX_CONSOLIDATION_SOURCE_NOTES)
      .map((entry) => this.cloneMemoryEntry(entry));
    const sourceFingerprint = sha256Text(JSON.stringify({
      v: 1,
      scope: this.consolidationScopeFingerprintValue(scope),
      sources: sources.map((entry) => ({
        filename: entry.filename,
        title: entry.title,
        content: entry.content,
        updatedAt: entry.updatedAt,
        id: entry.id,
        kind: entry.kind,
        state: entry.state,
        source: entry.source,
        createdAt: entry.createdAt,
        confirmedAt: entry.confirmedAt,
        expiresAt: entry.expiresAt,
        pinned: entry.pinned,
        projectRoot: entry.projectRoot ? projectRootKey(entry.projectRoot) ?? entry.projectRoot : undefined,
        projectName: entry.projectName,
      })),
    }));
    return {
      scope: this.cloneMemoryScope(scope),
      sources,
      sourceFingerprint,
    };
  }

  private consolidationScopeFingerprintValue(scope: MemoryScope): Record<string, string | number> {
    if (scope.type === "global") return { type: "global", v: 1 };
    return {
      type: "project",
      v: 1,
      projectRoot: projectRootKey(scope.projectRoot) ?? scope.projectRoot,
    };
  }

  private cloneMemoryEntry(entry: NoteEntry): NoteEntry {
    return {
      ...entry,
      ...(entry.derivation ? { derivation: { ...entry.derivation } } : {}),
      ...(entry.capture ? { capture: { ...entry.capture } } : {}),
    };
  }

  private entryMatchesConsolidationScope(entry: NoteEntry, scope: MemoryScope): boolean {
    return scope.type === "global"
      ? !entry.projectRoot
      : entry.projectRoot !== undefined && projectRootEquals(entry.projectRoot, scope.projectRoot);
  }

  private isDefaultWorkspaceGlobalSource(entry: NoteEntry, scope: MemoryScope): boolean {
    return scope.type === "global"
      && this.defaultWorkspaceRoot !== undefined
      && entry.projectRoot !== undefined
      && projectRootEquals(entry.projectRoot, this.defaultWorkspaceRoot);
  }

  private isDerivedMemory(entry: NoteEntry): boolean {
    return entry.derivation?.type === "consolidated-overview";
  }

  private isConsolidationSource(entry: NoteEntry): boolean {
    return !this.isDerivedMemory(entry)
      && !noteIsExpired(entry)
      && (entry.state === undefined || entry.state === "active");
  }

  private findConsolidatedMemoryOverview(scope: MemoryScope): NoteEntry | undefined {
    const options: MemoryReadOptions = scope.type === "project"
      ? { projectRoot: scope.projectRoot }
      : {};
    return this.readMarkdownEntries(this.memoryDir, options).find((entry) =>
      this.entryMatchesConsolidationScope(entry, scope)
      && this.isDerivedMemory(entry)
      && entry.kind === "reference"
      && entry.state === "active"
      && entry.source === "assistant",
    );
  }

  private consolidatedOverviewTitle(scope: MemoryScope): string {
    return scope.type === "global"
      ? "Long-term Memory Overview"
      : "Project Long-term Memory Overview";
  }

  private findExistingManagedMemory(
    title: string,
    scope: MemoryScope,
    preferredState: MemoryState | undefined,
    preferredSource: MemorySourceKind | undefined,
    preferredCaptureTrigger: MemoryCaptureTrigger | undefined,
  ): { filename: string; metadata: MemoryMetadataV1 } | undefined {
    let fallback: { filename: string; metadata: MemoryMetadataV1 } | undefined;
    for (const filename of readdirIfPresent(this.memoryDir)) {
      if (!filename.endsWith(".md") || this.isMemoryIndexFilename(filename)) continue;
      const snapshot = readUtf8FileSnapshotIfPresent(join(this.memoryDir, filename), MAX_MANAGED_MEMORY_FILE_BYTES);
      if (!snapshot || snapshot.tooLarge) continue;
      const parsed = this.parseMemoryNote(snapshot.content);
      if (!parsed.metadata || parsed.invalidMetadata) continue;
      if (parsed.metadata.derivation) continue;
      const existingTitle = parsed.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
      if (existingTitle === title && this.memoryScopesEqual(parsed.metadata.scope, scope)) {
        const match = { filename, metadata: parsed.metadata };
        if (
          (!preferredState || parsed.metadata.state === preferredState)
          && (!preferredSource || parsed.metadata.source === preferredSource)
          && parsed.metadata.capture?.trigger === preferredCaptureTrigger
        ) return match;
        fallback ??= match;
      }
    }
    return fallback;
  }

  private validateManagedMemoryId(id: string, operation: string): string {
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      throw new Error(`${operation}: invalid memory id`);
    }
    return id.toLowerCase();
  }

  private findManagedMemoryById(
    id: string,
  ): { filename: string; title: string; content: string; metadata: MemoryMetadataV1 } | undefined {
    for (const filename of readdirIfPresent(this.memoryDir)) {
      if (!filename.endsWith(".md") || this.isMemoryIndexFilename(filename)) continue;
      const snapshot = readUtf8FileSnapshotIfPresent(join(this.memoryDir, filename), MAX_MANAGED_MEMORY_FILE_BYTES);
      if (!snapshot || snapshot.tooLarge) continue;
      const parsed = this.parseMemoryNote(snapshot.content);
      if (!parsed.metadata || parsed.invalidMetadata || parsed.metadata.id.toLowerCase() !== id) continue;
      const title = parsed.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
      if (!title) continue;
      return {
        filename,
        title,
        content: parsed.content,
        metadata: parsed.metadata,
      };
    }
    return undefined;
  }

  private allocateMemoryFilename(title: string, id: string): string {
    const base = this.memoryFilenameForTitle(title);
    if (!existsSync(join(this.memoryDir, base))) return base;
    const stem = base.replace(/\.md$/i, "");
    const suffix = id.slice(0, 8);
    let candidate = `${stem}--${suffix}.md`;
    let collision = 2;
    while (existsSync(join(this.memoryDir, candidate))) {
      candidate = `${stem}--${suffix}-${collision}.md`;
      collision += 1;
    }
    return candidate;
  }

  private migrateLegacyDirectory(legacyName: string, currentName: string): void {
    const legacyPath = join(this.aveDir, legacyName);
    const currentPath = join(this.aveDir, currentName);
    if (!existsSync(legacyPath)) return;
    if (!existsSync(currentPath)) {
      renameSync(legacyPath, currentPath);
      return;
    }
    for (const entry of readdirSync(legacyPath)) {
      const source = join(legacyPath, entry);
      const target = join(currentPath, entry);
      if (existsSync(target)) continue;
      renameSync(source, target);
    }
    log.warn(`${legacyName}/ exists alongside ${currentName}/; moved non-conflicting entries into ${currentName}/`);
  }

  private updateMemoryIndexLocked(targetPath: string, filename: string, title: string, content: string): void {
    const safeTitle = title.replace(/[\r\n\[\]]/g, " ").trim() || filename.replace(".md", "");
    const excerpt = content.replace(/\s+/g, " ").trim().slice(0, 140);
    const line = `- [${safeTitle}](./${filename}) — ${excerpt}`;
    const existing = readUtf8FileIfPresent(targetPath) ?? getDefaultMemoryIndex();
    const lines = existing.split(/\r?\n/);
    const linkNeedle = `](./${filename})`;
    const idx = lines.findIndex((l) => l.includes(linkNeedle));
    if (idx >= 0) {
      lines[idx] = line;
    } else {
      if (!existing.includes("## Saved Memories")) {
        lines.push("", "## Saved Memories", "");
      }
      lines.push(line);
    }
    writeFileSync(targetPath, lines.join("\n").replace(/\n{4,}/g, "\n\n\n"), "utf-8");
  }

  private patchMemoryIndexSections(markdown: string, sections: MemoryIndexSectionsPatch): string {
    let next = this.ensureMemoryIndexSections(markdown);
    if (sections.urgentMemory !== undefined) {
      next = this.replaceMemoryIndexSection(next, "Urgent Memory", sections.urgentMemory);
    }
    if (sections.references !== undefined) {
      next = this.replaceMemoryIndexSection(next, "References", sections.references);
    }
    return `${next.trim()}\n`;
  }

  private ensureMemoryIndexSections(markdown: string): string {
    const base = markdown.trim() ? markdown.trim() : "# Ave Memory Index";
    let next = base.startsWith("# ") ? base : `# Ave Memory Index\n\n${base}`;
    next = this.ensureMemoryIndexSection(next, "Urgent Memory", t("be_memoryManager.urgentMemoryPlaceholder"));
    next = this.ensureMemoryIndexSection(next, "References", t("be_memoryManager.referencesPlaceholder"));
    next = this.ensureMemoryIndexSection(next, "Saved Memories", "");
    return next;
  }

  private ensureMemoryIndexSection(markdown: string, heading: string, placeholder: string): string {
    if (this.hasMemoryIndexSection(markdown, heading)) return markdown;
    const block = `## ${heading}\n\n${placeholder}`.trimEnd();
    if (heading !== "Saved Memories") {
      const savedIndex = markdown.search(/^##\s+Saved Memories\s*$/im);
      if (savedIndex >= 0) {
        return `${markdown.slice(0, savedIndex).trimEnd()}\n\n${block}\n\n${markdown.slice(savedIndex).trimStart()}`;
      }
    }
    return `${markdown.trimEnd()}\n\n${block}`;
  }

  private replaceMemoryIndexSection(markdown: string, heading: string, body: string): string {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const headingRegex = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
    const nextHeadingRegex = /^##\s+/;
    const start = lines.findIndex((line) => headingRegex.test(line));
    const sectionLines = [`## ${heading}`, "", ...body.trim().split(/\r?\n/).filter((line) => line.length > 0)];
    if (start < 0) {
      return `${markdown.trimEnd()}\n\n${sectionLines.join("\n")}`;
    }

    let end = start + 1;
    while (end < lines.length && !nextHeadingRegex.test(lines[end])) {
      end += 1;
    }
    return [...lines.slice(0, start), ...sectionLines, "", ...lines.slice(end)].join("\n").replace(/\n{4,}/g, "\n\n\n");
  }

  private hasMemoryIndexSection(markdown: string, heading: string): boolean {
    return new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "im").test(markdown);
  }

  private memoryFilenameForTitle(title: string): string {
    const filename = `${this.slugify(title)}.md`;
    return this.isMemoryIndexFilename(filename) ? "memory-entry.md" : filename;
  }

  private removeMemoryIndexEntryLocked(filename: string, targetPath: string): void {
    const existing = readUtf8FileIfPresent(targetPath);
    if (existing === null) {
      this.memoryIndex = "";
      return;
    }
    const linkNeedle = `](./${filename})`;
    const lines = existing.split(/\r?\n/).filter((line) => !line.includes(linkNeedle));
    writeFileSync(targetPath, lines.join("\n"), "utf-8");
  }

  private validateDeletableMemoryFilename(filename: string): string {
    if (
      typeof filename !== "string" ||
      filename.trim() === "" ||
      filename.includes("\0") ||
      basename(filename) !== filename ||
      !filename.endsWith(".md")
    ) {
      throw new Error("deleteMemory: invalid memory filename");
    }
    if (this.isMemoryIndexFilename(filename)) {
      throw new Error("deleteMemory: MEMORY.md is an index file and cannot be deleted as a memory entry");
    }
    return filename;
  }

  private isMemoryIndexFilename(filename: string): boolean {
    return filename.toLowerCase() === "memory.md";
  }

  private truncateMemoryIndex(content: string): string {
    const byLines = content.split(/\r?\n/).slice(0, 200).join("\n");
    const buf = Buffer.from(byLines, "utf-8");
    if (buf.byteLength <= 25 * 1024) return byLines;
    return buf.subarray(0, 25 * 1024).toString("utf-8");
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
      const normalized = content.replace(/\s+/g, " ").trim();
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

  private slugify(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\uac00-\ud7a3\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "untitled";
  }
}
