import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, rmSync, renameSync, watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { type ToolOutputCapture, type ToolOutputArtifactInfo } from "../shared/tool-output-artifact.js";
import { isValidSessionId } from "../shared/session-id.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { replaceUtf8FileAtomicSyncIf, isMissingPathError } from "../lib/atomic-file.js";
import { readAveHomeInputSync, recordAveHomeInputWriteSync } from "../shared/ave-home-trust.js";
import { type SessionTaskItem } from "../shared/session-tasks.js";
import { type SessionGoal } from "../shared/session-goal.js";
import { createLogger } from "../lib/logger.js";
import {
  AGENTS_CUSTOM_DOC_NAME,
  AGENTS_DOC_NAME,
  aveHome,
} from "../shared/ave-home.js";
import { t } from "../i18n/index.js";
import { projectRootEquals, projectRootKey } from "../shared/project-identity.js";
import { discoverProjectAgentsMd, type ProjectAgentsMd } from "./project-agents-md.js";
import { estimateTokens } from "../shared/token-estimate.js";
import { isRecord } from "../shared/is-record.js";
import { escapeRegExp } from "../shared/escape-reg-exp.js";
import { isSafeStructuralId } from "../shared/dlp-safe-id.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { MemoryHistory, historyText, type MemoryHistoryActor, type MemoryHistoryRead } from "./memory-history.js";
import { SHA256_HEX } from "../lib/hex-digest-equal.js";
import { type TurnInflightPartial } from "./session-turn-journal.js";
import {
  SessionRepository,
  getFileMtimeMs,
  readdirIfPresent,
  unlinkIfPresent,
  MAX_PROJECT_ROOT_CHARS,
  MAX_PROJECT_NAME_CHARS,
  sha256Text,
  normalizeMetadataString,
  type FileSnapshot,
  type SessionSearchEntry,
  type ToolResultArtifact,
  type SessionNamespace,
  type RestoredSubAgentSession,
  type ListSessionsOptions,
  type MainActiveSessionState,
  type SessionListEntry,
  type Checkpoint,
  type SessionMetadata,
} from "./session-repository.js";

export { MAX_TOOL_RESULT_ARTIFACT_BYTES } from "../shared/tool-output-artifact.js";
export { isValidSessionId } from "../shared/session-id.js";
export type { SessionNamespace, RestoredSubAgentSession, ListSessionsOptions, SessionListEntry, Checkpoint, SessionMetadata } from "./session-repository.js";
export { sessionFamilyOf, toSessionListRow, MAX_SESSION_FILE_BYTES, MAX_PROJECT_ROOT_CHARS, MAX_PROJECT_NAME_CHARS } from "./session-repository.js";

const log = createLogger("memory");

/** A home document (AGENTS.md, agents.custom.md, user-preferences.md, memories/MEMORY.md) is read as one verified buffer: one
 * pending review in the home content trust manifest is not injected and reads as absent. Other paths read as before. */
function readHomeDocIfPresent(path: string): string | null {
  const input = readAveHomeInputSync(path);
  return input.status === "trusted" ? input.bytes.toString("utf-8") : null;
}

/** Every whole-file write of a home document is recorded in the trust manifest; a write over one pending review is refused. */
function writeHomeDocSync(path: string, content: string): void {
  recordAveHomeInputWriteSync(path, content, () => writeFileSync(path, content, "utf-8"));
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

export interface MemoryManagerOptions {
  aveDir?: string;
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
  origin?: MemoryOriginV1;
}

export interface ProjectScopedMemoryOptions {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
}

export type MemoryKind = "preference" | "constraint" | "fact" | "goal" | "reference" | "note";

/** One lifecycle: every saved memory is active at once (owner decision 2026-11-04); a stored "candidate" no longer decodes. */
type MemoryState = "active";

/** Provenance is recorded so later lifecycle policy can distinguish imports from direct user intent. */
export type MemorySourceKind = "user" | "assistant" | "import" | "capture";

type MemoryCaptureTrigger = "automatic" | "explicit";

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

/**
 * Where a memory was learned: the conversation and, when known, the user row that opened the turn. Ids only; the quote is
 * read from the session at display time so the memory store never duplicates conversation text. `store` is recorded where
 * the writer knows it structurally; a reader resolves a missing store by probing main, side-chat, then sub-agent sessions.
 * A save with no conversation behind it has no origin. Kept separate from `capture` because assistant writes carry no capture block.
 */
export interface MemoryOriginV1 {
  v: 1;
  sessionId: string;
  messageId?: string;
  store?: SessionNamespace;
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
  origin?: MemoryOriginV1;
}

// Omitted projectRoot explicitly selects global long-term memory.
export interface MemorySaveOptions extends ProjectScopedMemoryOptions {
  kind?: MemoryKind;
  source?: MemorySourceKind;
  confirmedAt?: string;
  expiresAt?: string;
  pinned?: boolean;
  capture?: MemoryCaptureV1;
  origin?: MemoryOriginV1;
}

export interface MemorySaveResult {
  op: "created" | "updated";
  entry: NoteEntry;
  /** sha256 of the bytes this save wrote; an undo acts only while the file still holds them. */
  fileDigest: string;
  /** For an update, the file's bytes before it, so an undo can put them back. */
  priorContent?: string;
}

/** What a delete removed: the file's bytes, so an undo can write them back, and the memory they held. */
export interface MemoryDeleteResult {
  /** Null when there was no file. */
  priorContent: string | null;
  /** The removed memory as it was listed; absent when there was no file. */
  entry?: NoteEntry;
}

export interface MemoryReadOptions extends ProjectScopedMemoryOptions {
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

export type { SessionKind } from "../shared/session-lookup.js";

export type CheckpointTrigger = "auto-compact" | "manual";

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
const MAX_MANAGED_MEMORY_CONTENT_CHARS = 8_000;
const MAX_CONSOLIDATION_SOURCE_NOTES = 16;
const MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_TOKENS = 400;
const MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_SCOPE_TOKENS = 190;
export const MEMORY_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  "preference", "constraint", "fact", "goal", "reference", "note",
]);
export const MAX_MEMORY_SOURCE_CHARS = 4_000;
const MEMORY_STATES = new Set<MemoryState>(["active"]);
// Invisible text that can hide instructions from the user who reads the memory.
const MEMORY_INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const MEMORY_CAPTURE_TRIGGERS = new Set<MemoryCaptureTrigger>(["automatic", "explicit"]);
const MEMORY_SOURCES = new Set<MemorySourceKind>(["user", "assistant", "import", "capture"]);

function getDefaultMemoryIndex(): string {
  return t("be_memoryManager.defaultMemoryIndex");
}

/** The requesting conversation's id for a history row, when it is a valid session id. */
function historySession(requestedIn: { sessionId?: string } | undefined): { sessionId?: string } {
  const sessionId = requestedIn?.sessionId;
  return sessionId !== undefined && isValidSessionId(sessionId) ? { sessionId } : {};
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

const SESSION_NAMESPACES = new Set<SessionNamespace>(["main", "side-chat", "subagent"]);

// Strict: an origin with an unknown key or a malformed id is invalid, never trimmed into a valid one.
function normalizeMemoryOrigin(value: unknown): MemoryOriginV1 | null {
  if (!isRecord(value) || value.v !== 1 || !isValidSessionId(value.sessionId)) return null;
  for (const key of Object.keys(value)) {
    if (key !== "v" && key !== "sessionId" && key !== "messageId" && key !== "store") return null;
  }
  if (value.messageId !== undefined && !isSafeStructuralId(value.messageId)) return null;
  if (value.store !== undefined && !SESSION_NAMESPACES.has(value.store as SessionNamespace)) return null;
  return {
    v: 1,
    sessionId: value.sessionId,
    ...(value.messageId !== undefined ? { messageId: value.messageId as string } : {}),
    ...(value.store !== undefined ? { store: value.store as SessionNamespace } : {}),
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
  const origin = raw.origin === undefined ? undefined : normalizeMemoryOrigin(raw.origin);
  if (origin === null) return null;

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
    ...(origin ? { origin } : {}),
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
  private readonly sessionRepository: SessionRepository;
  private readonly history: MemoryHistory;
  private persistentContextWatchers: FSWatcher[] = [];
  private persistentContextReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private persistentContextPollTimer: ReturnType<typeof setInterval> | undefined;
  private persistentContextFileState = new Map<string, number>();

  private agentsMd: string = "";
  private agentsCustomMd: string = "";
  private memoryIndex: string = "";
  private userPreferences: string = "";

  constructor(options?: MemoryManagerOptions) {
    this.aveDir = resolve(options?.aveDir ?? aveHome());
    this.memoryDir = join(this.aveDir, "memories");
    this.history = new MemoryHistory(this.memoryDir);
    mkdirSync(this.aveDir, { recursive: true });
    this.migrateLegacyDirectory("memory", "memories");
    mkdirSync(this.memoryDir, { recursive: true });
    this.sessionRepository = new SessionRepository({ aveDir: this.aveDir });
    this.ensureStructure();
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

  closeSearchIndex(): void { return this.sessionRepository.closeSearchIndex(); }

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
    return value.watchedPaths.map((path) => getFileMtimeMs(path)).join(",");
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

    // Without a project only the global overview applies; a project (the default one included) splits the budget fairly.
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
  // Derived overviews get no change-history rows on purpose: they are host-regenerated summaries, not user memories.
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

  /** One inventory pass; only the selected scope's notes leave the store, alongside scope counts. */
  readMemoryPanelCatalog(options: ProjectScopedMemoryOptions, defaultProjectRoot: string) {
    const entries = this.readMarkdownEntries(this.memoryDir, { includeOtherProjects: true });
    const notes = entries.filter((entry) => this.matchesMemoryRead(entry, options));
    const global = entries.filter((entry) => entry.id && !entry.projectRoot).length;
    return {
      notes,
      scopeCounts: {
        project: notes.filter((entry) => entry.projectRoot || !entry.id).length,
        global,
        defaultProject: entries.filter((entry) => entry.projectRoot
          ? projectRootEquals(entry.projectRoot, defaultProjectRoot)
          : !entry.id).length,
        defaultProjectApplicable: projectRootEquals(options.projectRoot, defaultProjectRoot),
      },
    };
  }

  // Global refresh includes unscoped legacy records but never project-scoped managed memories.
  listGlobalMemoryEntries(): NoteEntry[] {
    return this.listMemoryEntries().filter((entry) => !entry.projectRoot);
  }

  searchMemoryEntries(query: string, options: MemoryReadOptions = {}): NoteEntry[] {
    return this.searchEntries(this.listMemoryEntries(options), query);
  }

  searchSessions(query: string, options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped"> = {}): SessionSearchEntry[] { return this.sessionRepository.searchSessions(query, options); }

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

  listSessionEntries(limit = 50, options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped"> = {}): SessionSearchEntry[] { return this.sessionRepository.listSessionEntries(limit, options); }

  // `actor` is who is saving now; it is recorded in the change history and never inferred from stored metadata.
  // `requestedIn` is the conversation that asked for the change; the history row keeps its id only.
  async saveMemory(
    title: string,
    content: string,
    options: MemorySaveOptions,
    actor: MemoryHistoryActor,
    requestedIn?: { sessionId?: string },
  ): Promise<MemorySaveResult> {
    const input = this.assertManagedMemoryInput(title, content);
    let metadata = this.createMemoryMetadata(options);
    const visibleContent = `# ${input.title}\n\n${input.content}\n`;
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let filename = "";
    let previousBody: string | undefined;
    let priorContent: string | undefined;
    let fileDigest = "";

    await withFileLock(indexPath, async () => {
      // One save rule: within a scope, a same-title save updates the existing memory whichever path wrote it. Should two files
      // share the title, only the newest is updated; the others stay as they are for the user to view or delete.
      const existing = this.findExistingManagedMemory(input.title, metadata.scope);
      if (existing) {
        filename = existing.filename;
        metadata = this.mergeExistingMemoryMetadata(existing.metadata, metadata, options);
        const previous = readUtf8FileSnapshotIfPresent(join(this.memoryDir, filename), MAX_MANAGED_MEMORY_FILE_BYTES);
        previousBody = previous && !previous.tooLarge
          ? this.memoryBodyForPrompt({ filename, title: input.title, content: this.parseMemoryNote(previous.content).content })
          : "";
        if (previous && !previous.tooLarge) priorContent = previous.content;
      } else {
        filename = this.allocateMemoryFilename(input.title, metadata.id);
      }

      const storedContent = [
        MEMORY_MARKER,
        `${MEMORY_METADATA_PREFIX}${encodeMemoryMetadata(metadata)}${MEMORY_METADATA_SUFFIX}`,
        visibleContent,
      ].join("\n");
      writeFileSync(join(this.memoryDir, filename), storedContent, "utf-8");
      fileDigest = sha256Text(storedContent);
      if (metadata.scope.type === "global") {
        this.updateMemoryIndexLocked(indexPath, filename, input.title, input.content);
      } else {
        this.removeMemoryIndexEntryLocked(filename, indexPath);
      }
      // Recorded under the same lock as the write, as a scrub is, so another process cannot slip a row in between.
      await this.history.record({
        memoryId: metadata.id,
        op: previousBody === undefined ? "created" : "updated",
        actor,
        fields: {
          title: historyText(input.title),
          contentDigest: sha256Text(input.content),
          scope: metadata.scope.type,
        },
        ...(previousBody !== undefined ? { before: historyText(previousBody), after: historyText(input.content) } : {}),
        ...historySession(requestedIn),
      });
    });

    this.memoryIndex = this.readMemoryIndex();
    return {
      op: previousBody === undefined ? "created" : "updated",
      entry: this.entryFromMemoryMetadata(filename, input.title, visibleContent, metadata, new Date().toISOString()),
      fileDigest,
      ...(priorContent !== undefined ? { priorContent } : {}),
    };
  }

  /**
   * Rewrite one memory by id, title included, within the caller's project or global scope. The id and origin stay;
   * provenance follows this save. `scope: "global"` moves a project memory to global (the user asked for every project).
   * A title another memory in the target scope already uses is refused.
   */
  async updateMemoryById(
    id: string,
    title: string,
    content: string,
    options: ProjectScopedMemoryOptions & { source: MemorySourceKind; kind?: MemoryKind; scope?: "global" },
    actor: MemoryHistoryActor,
    requestedIn?: { sessionId?: string },
  ): Promise<MemorySaveResult> {
    const safeId = this.validateManagedMemoryId(id, "updateMemoryById");
    const input = this.assertManagedMemoryInput(title, content);
    if (!MEMORY_SOURCES.has(options.source) || options.source === "capture") {
      throw new Error("updateMemoryById: invalid memory source");
    }
    if (options.kind !== undefined && !MEMORY_KINDS.has(options.kind)) throw new Error("updateMemoryById: invalid memory kind");
    const visibleContent = `# ${input.title}\n\n${input.content}\n`;
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let updated: NoteEntry | undefined;
    let previousBody = "";
    let priorContent: string | undefined;
    let fileDigest = "";
    await withFileLock(indexPath, async () => {
      const found = this.findManagedMemoryById(safeId);
      const scopeEntry = found
        ? this.entryFromMemoryMetadata(found.filename, found.title, found.content, found.metadata, "")
        : undefined;
      // Scope misses share the not-found result so a caller cannot probe another project's memory.
      if (!found || !scopeEntry || found.metadata.derivation || !this.memoryScopeVisibleForMutation(scopeEntry, options)) {
        throw new Error("updateMemoryById: memory not found");
      }
      const targetScope: MemoryScope = options.scope === "global" ? { type: "global" } : found.metadata.scope;
      // Same-title copies are never folded. An older copy that keeps its title and scope takes nothing from another file,
      // while the lookup below names only the newest copy, which need not be this one.
      const keepsTitleAndScope = found.title === input.title && this.memoryScopesEqual(found.metadata.scope, targetScope);
      const sameTitle = keepsTitleAndScope ? undefined : this.findExistingManagedMemory(input.title, targetScope);
      if (sameTitle && sameTitle.metadata.id.toLowerCase() !== safeId) {
        throw new Error("updateMemoryById: title-conflict");
      }
      previousBody = this.memoryBodyForPrompt({ filename: found.filename, title: found.title, content: found.content });
      const prior = readUtf8FileSnapshotIfPresent(join(this.memoryDir, found.filename), MAX_MANAGED_MEMORY_FILE_BYTES);
      if (prior && !prior.tooLarge) priorContent = prior.content;
      const { capture: _capture, ...rest } = found.metadata;
      const metadata: MemoryMetadataV1 = {
        ...rest,
        scope: targetScope,
        source: options.source,
        ...(options.kind ? { kind: options.kind } : {}),
      };
      const storedContent = [
        MEMORY_MARKER,
        `${MEMORY_METADATA_PREFIX}${encodeMemoryMetadata(metadata)}${MEMORY_METADATA_SUFFIX}`,
        visibleContent,
      ].join("\n");
      writeFileSync(join(this.memoryDir, found.filename), storedContent, "utf-8");
      fileDigest = sha256Text(storedContent);
      if (metadata.scope.type === "global") {
        this.updateMemoryIndexLocked(indexPath, found.filename, input.title, input.content);
      } else {
        this.removeMemoryIndexEntryLocked(found.filename, indexPath);
      }
      updated = this.entryFromMemoryMetadata(found.filename, input.title, visibleContent, metadata, new Date().toISOString());
      await this.history.record({
        memoryId: safeId,
        op: "updated",
        actor,
        fields: { title: historyText(input.title), contentDigest: sha256Text(input.content), scope: metadata.scope.type },
        before: historyText(previousBody),
        after: historyText(input.content),
        ...historySession(requestedIn),
      });
    });
    this.memoryIndex = this.readMemoryIndex();
    return { op: "updated", entry: updated!, fileDigest, ...(priorContent !== undefined ? { priorContent } : {}) };
  }

  /** Delete one managed memory by id within the caller's scope; the same path as deleting its file. */
  async deleteMemoryById(
    id: string,
    options: ProjectScopedMemoryOptions,
    actor: MemoryHistoryActor,
  ): Promise<{ entry: NoteEntry } & MemoryDeleteResult> {
    const safeId = this.validateManagedMemoryId(id, "deleteMemoryById");
    const found = this.findManagedMemoryById(safeId);
    const entry = found
      ? this.entryFromMemoryMetadata(found.filename, found.title, found.content, found.metadata, "")
      : undefined;
    if (!found || !entry || !this.memoryScopeVisibleForMutation(entry, options)) {
      throw new Error("deleteMemoryById: memory not found");
    }
    const { priorContent } = await this.deleteMemory(found.filename, options, actor);
    return { entry, priorContent };
  }

  /** One memory's change history; the memory must exist in the caller's scope, like any id-based operation. */
  async getMemoryHistory(id: string, options: ProjectScopedMemoryOptions): Promise<MemoryHistoryRead> {
    const safeId = this.validateManagedMemoryId(id, "getMemoryHistory");
    const found = this.findManagedMemoryById(safeId);
    const scopeEntry = found
      ? this.entryFromMemoryMetadata(found.filename, found.title, found.content, found.metadata, "")
      : undefined;
    if (!scopeEntry || !this.memoryScopeVisibleForMutation(scopeEntry, options)) {
      throw new Error("getMemoryHistory: memory not found");
    }
    return this.history.read(safeId);
  }

  async updateMemoryIndex(content: string): Promise<void> {
    const targetPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(targetPath, async () => {
      writeHomeDocSync(targetPath, content);
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  async updateMemoryIndexIfUnchanged(expectedContent: string, nextContent: string): Promise<boolean> {
    const targetPath = join(this.memoryDir, "MEMORY.md");
    let didUpdate = false;
    await withFileLock(targetPath, async () => {
      const current = readHomeDocIfPresent(targetPath) ?? "";
      if (current !== expectedContent) return;
      writeHomeDocSync(targetPath, nextContent);
      didUpdate = true;
    });
    this.memoryIndex = this.readMemoryIndex();
    return didUpdate;
  }

  async updateMemoryIndexSections(sections: MemoryIndexSectionsPatch): Promise<void> {
    const targetPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(targetPath, async () => {
      const current = readHomeDocIfPresent(targetPath) ?? getDefaultMemoryIndex();
      writeHomeDocSync(targetPath, this.patchMemoryIndexSections(current, sections));
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  async deleteMemory(filename: string, options: ProjectScopedMemoryOptions, actor: MemoryHistoryActor): Promise<MemoryDeleteResult> {
    const safeFilename = this.validateDeletableMemoryFilename(filename);
    let deletedId: string | undefined;
    let priorContent: string | null = null;
    let deletedEntry: NoteEntry | undefined;
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
        deletedId = entry.id;
        priorContent = snapshot.content;
        deletedEntry = entry;
      }
      // Deleting removes the text the history kept; if that cannot be done the memory stays and the delete fails.
      if (deletedId) await this.history.scrub(deletedId);
      unlinkIfPresent(path);
      this.removeMemoryIndexEntryLocked(safeFilename, indexPath);
      // Legacy notes have no id, and the id is a memory's identity, so only managed deletions are recorded.
      if (deletedId) await this.history.record({ memoryId: deletedId, op: "deleted", actor });
    });
    this.memoryIndex = this.readMemoryIndex();
    return { priorContent, ...(deletedEntry ? { entry: deletedEntry } : {}) };
  }

  /**
   * Undo an update: put the file's earlier bytes back only while it still holds exactly the bytes that update wrote, and
   * only while its earlier title is free in its scope. "changed" otherwise; the undo token is the caller's authority.
   */
  async restoreMemoryIfUnchanged(
    filename: string,
    expectedDigest: string,
    priorContent: string,
    actor: MemoryHistoryActor,
  ): Promise<"restored" | "changed"> {
    const safeFilename = this.validateDeletableMemoryFilename(filename);
    const prior = this.parseMemoryNote(priorContent);
    if (!prior.metadata || prior.invalidMetadata) throw new Error("restoreMemoryIfUnchanged: not a managed memory");
    const metadata = prior.metadata;
    const title = prior.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
    if (!title) throw new Error("restoreMemoryIfUnchanged: memory has no title");
    const body = prior.content.replace(/^#\s+[^\r\n]+(?:\r?\n)*/, "").trim();
    const path = join(this.memoryDir, safeFilename);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let outcome = "changed" as "restored" | "changed";
    await withFileLock(indexPath, async () => {
      const current = readUtf8FileSnapshotIfPresent(path, MAX_MANAGED_MEMORY_FILE_BYTES);
      if (!current || current.tooLarge || sha256Text(current.content) !== expectedDigest) return;
      const currentBody = this.parseMemoryNote(current.content).content;
      // An update by id may have renamed it; putting the old title back needs that title free in its scope. A restore that
      // keeps the title changes nothing about which file holds it.
      const currentTitle = currentBody.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
      if (currentTitle !== title) {
        const holder = this.findExistingManagedMemory(title, metadata.scope);
        if (holder && holder.metadata.id.toLowerCase() !== metadata.id.toLowerCase()) return;
      }
      writeFileSync(path, priorContent, "utf-8");
      if (metadata.scope.type === "global") {
        this.updateMemoryIndexLocked(indexPath, safeFilename, title, body);
      } else {
        this.removeMemoryIndexEntryLocked(safeFilename, indexPath);
      }
      await this.history.record({
        memoryId: metadata.id,
        op: "updated",
        actor,
        fields: { title: historyText(title), contentDigest: sha256Text(body), scope: metadata.scope.type },
        before: historyText(this.memoryBodyForPrompt({ filename: safeFilename, title, content: currentBody })),
        after: historyText(body),
      });
      outcome = "restored";
    });
    if (outcome === "restored") this.memoryIndex = this.readMemoryIndex();
    return outcome;
  }

  /**
   * Undo a create: delete the file only while it still holds exactly the bytes that save wrote.
   * "changed" when it was edited or removed since; the undo token is the caller's authority, so no scope check.
   */
  async deleteMemoryIfUnchanged(filename: string, expectedDigest: string, actor: MemoryHistoryActor): Promise<"deleted" | "changed"> {
    const safeFilename = this.validateDeletableMemoryFilename(filename);
    const path = join(this.memoryDir, safeFilename);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let deletedId: string | undefined;
    let outcome = "changed" as "deleted" | "changed";
    await withFileLock(indexPath, async () => {
      const snapshot = readUtf8FileSnapshotIfPresent(path, MAX_MANAGED_MEMORY_FILE_BYTES);
      if (!snapshot || snapshot.tooLarge || sha256Text(snapshot.content) !== expectedDigest) return;
      const parsed = this.parseMemoryNote(snapshot.content);
      if (!parsed.metadata || parsed.invalidMetadata) throw new Error("deleteMemoryIfUnchanged: not a managed memory");
      deletedId = parsed.metadata.id;
      await this.history.scrub(deletedId);
      unlinkIfPresent(path);
      this.removeMemoryIndexEntryLocked(safeFilename, indexPath);
      await this.history.record({ memoryId: deletedId, op: "deleted", actor });
      outcome = "deleted";
    });
    if (outcome === "deleted") this.memoryIndex = this.readMemoryIndex();
    return outcome;
  }

  /**
   * Undo a delete: write the deleted file's bytes back. "changed" when the file name, the id or the title in its
   * scope has been taken since, so a restore never overwrites or duplicates a newer memory. A failure after the file is
   * written removes it again and throws, so the delete still stands and the same undo can be tried again.
   */
  async restoreDeletedMemory(filename: string, priorContent: string, actor: MemoryHistoryActor): Promise<"restored" | "changed"> {
    const safeFilename = this.validateDeletableMemoryFilename(filename);
    const parsed = this.parseMemoryNote(priorContent);
    if (!parsed.metadata || parsed.invalidMetadata) throw new Error("restoreDeletedMemory: not a managed memory");
    const metadata = parsed.metadata;
    const title = parsed.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
    if (!title) throw new Error("restoreDeletedMemory: memory has no title");
    const body = parsed.content.replace(/^#\s+[^\r\n]+(?:\r?\n)*/, "").trim();
    const path = join(this.memoryDir, safeFilename);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let outcome = "changed" as "restored" | "changed";
    await withFileLock(indexPath, async () => {
      if (existsSync(path)) return;
      if (this.findManagedMemoryById(metadata.id.toLowerCase())) return;
      if (this.findExistingManagedMemory(title, metadata.scope)) return;
      writeFileSync(path, priorContent, "utf-8");
      let indexed = false;
      try {
        if (metadata.scope.type === "global") {
          this.updateMemoryIndexLocked(indexPath, safeFilename, title, body);
          indexed = true;
        }
        await this.history.record({
          memoryId: metadata.id,
          op: "created",
          actor,
          fields: { title: historyText(title), contentDigest: sha256Text(body), scope: metadata.scope.type },
        });
      } catch (error) {
        // Put the disk back in its deleted state, so the undo the caller keeps for a retry finds the file name free again.
        if (indexed) {
          try {
            this.removeMemoryIndexEntryLocked(safeFilename, indexPath);
          } catch (indexError) {
            log.warn("restoreDeletedMemory: index entry could not be rolled back: %s", (indexError as Error).message);
          }
        }
        rmSync(path, { force: true });
        throw error;
      }
      outcome = "restored";
    });
    if (outcome === "restored") this.memoryIndex = this.readMemoryIndex();
    return outcome;
  }

  async updateAgentsMd(content: string): Promise<void> {
    const targetPath = join(this.aveDir, AGENTS_DOC_NAME);
    await withFileLock(targetPath, async () => {
      writeHomeDocSync(targetPath, content);
    });
    this.agentsMd = content;
  }

  async updateAgentsCustomMd(content: string): Promise<void> {
    const targetPath = join(this.aveDir, AGENTS_CUSTOM_DOC_NAME);
    await withFileLock(targetPath, async () => {
      writeHomeDocSync(targetPath, content);
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
        () => (readHomeDocIfPresent(targetPath) ?? "") === expectedContent,
      );
    });
    return didWrite;
  }

  async updateUserPreferences(content: string): Promise<void> {
    const targetPath = join(this.aveDir, "user-preferences.md");
    await withFileLock(targetPath, async () => {
      writeHomeDocSync(targetPath, content);
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

  async saveSession(sessionId: string, messages: unknown[]): Promise<void> { return this.sessionRepository.saveSession(sessionId, messages); }

  // Append only a valid extension of the last written history; otherwise atomically rewrite from the live reader.
  async appendSessionProgress(
    sessionId: string,
    readMessages: unknown[] | (() => unknown[]),
  ): Promise<"appended" | "rewritten" | "unchanged"> { return this.sessionRepository.appendSessionProgress(sessionId, readMessages); }

  // Persist the in-flight marker before the first provider call so any later crash remains recoverable.
  async beginTurnJournal(sessionId: string, startedAt: number): Promise<void> { return this.sessionRepository.beginTurnJournal(sessionId, startedAt); }

  // Undefined partial content preserves the in-flight marker.
  async writeTurnPartial(sessionId: string, startedAt: number, partial: TurnInflightPartial | undefined): Promise<void> { return this.sessionRepository.writeTurnPartial(sessionId, startedAt, partial); }

  // Deregister the turn but retain recovery evidence until persistence is confirmed.
  endTurnJournal(sessionId: string): void { return this.sessionRepository.endTurnJournal(sessionId); }

  // Remove the sidecar only after its owner confirms the transcript contains the turn.
  clearTurnJournal(sessionId: string): void { return this.sessionRepository.clearTurnJournal(sessionId); }

  // Imports require a fresh session id and never overwrite an existing transcript.
  async saveImportedSession(sessionId: string, messages: unknown[]): Promise<void> { return this.sessionRepository.saveImportedSession(sessionId, messages); }

  // Boot integrity repair rebuilds missing or corrupt indexes from JSONL; search never scans as a fallback.
  async verifyOrRebuildSearchIndex(): Promise<void> { return this.sessionRepository.verifyOrRebuildSearchIndex(); }

  // Store pre-compact snapshots in a separate directory so session listings cannot expose them as conversations.
  async saveCheckpointSnapshot(sessionId: string, compactNum: number, messages: unknown[]): Promise<void> { return this.sessionRepository.saveCheckpointSnapshot(sessionId, compactNum, messages); }

  loadCheckpointSnapshot(sessionId: string, compactNum: number): unknown[] | null { return this.sessionRepository.loadCheckpointSnapshot(sessionId, compactNum); }

  loadSession(sessionId: string): unknown[] | null { return this.sessionRepository.loadSession(sessionId); }

  loadToolResultArtifact(sessionId: string, toolUseId: string): ToolResultArtifact | null { return this.sessionRepository.loadToolResultArtifact(sessionId, toolUseId); }

  startToolOutputCapture(sessionId: string, toolUseId: string): ToolOutputCapture { return this.sessionRepository.startToolOutputCapture(sessionId, toolUseId); }

  loadToolOutputArtifact(sessionId: string, toolUseId: string, info: ToolOutputArtifactInfo): string | null { return this.sessionRepository.loadToolOutputArtifact(sessionId, toolUseId, info); }

  rehydrateToolResultArtifacts(sessionId: string, messages: unknown[]): unknown[] { return this.sessionRepository.rehydrateToolResultArtifacts(sessionId, messages); }

  // Read-modify-write row fields so whole-sidecar persistence preserves unrelated metadata.
  async updateSessionRowFields(
    sessionId: string,
    fields: { title?: string; archivedAt?: string | null; unreadSince?: string | null },
  ): Promise<void> { return this.sessionRepository.updateSessionRowFields(sessionId, fields); }

  // Task-list updates preserve unrelated metadata; an empty list removes the field.
  async saveSessionTasks(sessionId: string, tasks: SessionTaskItem[]): Promise<void> { return this.sessionRepository.saveSessionTasks(sessionId, tasks); }

  // Goal updates preserve unrelated metadata; null removes the goal without a tombstone.
  async saveSessionGoal(sessionId: string, goal: SessionGoal | null): Promise<void> { return this.sessionRepository.saveSessionGoal(sessionId, goal); }

  async saveSessionMetadata(sessionId: string, metadata: SessionMetadata): Promise<void> { return this.sessionRepository.saveSessionMetadata(sessionId, metadata); }

  // Re-add permits new bindings but keeps old session tombstones; it does not reassign detached chats.
  allowProjectRoot(projectRoot: string): void { return this.sessionRepository.allowProjectRoot(projectRoot); }

  /** The removal preview: how many conversations `detachSessionsFromProject` would detach now, by the same predicate, writing nothing.
   * Unreadable metadata fails here as it would fail the detach. */
  countSessionsInProject(projectRoot: string): number { return this.sessionRepository.countSessionsInProject(projectRoot); }

  async detachSessionsFromProject(projectRoot: string): Promise<number> { return this.sessionRepository.detachSessionsFromProject(projectRoot); }

  // Existence must match conversation listing and return false for invalid ids.
  hasSessionTranscript(sessionId: unknown): boolean { return this.sessionRepository.hasSessionTranscript(sessionId); }

  // Create missing transcripts exclusively so concurrent writers cannot be overwritten.
  touchSessionTranscript(sessionId: string, options: { bump: boolean }): boolean { return this.sessionRepository.touchSessionTranscript(sessionId, options); }

  hasSessionMetadataFile(sessionId: string): boolean { return this.sessionRepository.hasSessionMetadataFile(sessionId); }

  loadSessionMetadata(sessionId: string): SessionMetadata | null { return this.sessionRepository.loadSessionMetadata(sessionId); }

  loadMainActiveSessionState(): MainActiveSessionState | null { return this.sessionRepository.loadMainActiveSessionState(); }

  async saveMainActiveSessionState(state: MainActiveSessionState): Promise<void> { return this.sessionRepository.saveMainActiveSessionState(state); }

  async markMainActiveFresh(): Promise<void> { return this.sessionRepository.markMainActiveFresh(); }

  async markMainActiveResume(sessionId: string): Promise<void> { return this.sessionRepository.markMainActiveResume(sessionId); }

  // Assemble plain lists through pagination so row fields cannot drift between the two surfaces.
  listSessions(input: number | ListSessionsOptions = Number.POSITIVE_INFINITY): SessionListEntry[] { return this.sessionRepository.listSessions(input); }

  // Resolve pane sessions from a lazy metadata index and update it on local writes and deletes.
  findPaneSession(paneTabId: string): string | undefined { return this.sessionRepository.findPaneSession(paneTabId); }

  // Restore child panel rows from persisted metadata; live spawn events disappear on restart.

  listSubAgentSessionsForOrigin(originSessionId: string): RestoredSubAgentSession[] { return this.sessionRepository.listSubAgentSessionsForOrigin(originSessionId); }

  listSessionsPage(options: ListSessionsOptions = {}): SessionListEntry[] { return this.sessionRepository.listSessionsPage(options); }

  listSessionsByRoutine(routineId: string, limit = Number.POSITIVE_INFINITY): SessionListEntry[] { return this.sessionRepository.listSessionsByRoutine(routineId, limit); }

  // Append in memory only; callers must persist the updated metadata.
  appendCheckpoint(metadata: SessionMetadata, checkpoint: Checkpoint): SessionMetadata { return this.sessionRepository.appendCheckpoint(metadata, checkpoint); }

  // Prune only discarded checkpoint boundaries and their snapshots before saving rewind state.
  async pruneCheckpointsDiscardedByRewind(
    sessionId: string,
    discardedMessages: readonly unknown[],
  ): Promise<void> { return this.sessionRepository.pruneCheckpointsDiscardedByRewind(sessionId, discardedMessages); }

  // Cap the preamble and return updated metadata without persisting it.
  setSummaryPreamble(metadata: SessionMetadata, preamble: string): SessionMetadata { return this.sessionRepository.setSummaryPreamble(metadata, preamble); }

  // Delete session artifacts but retain the stable metadata lock target for waiting operations.
  async deleteSession(sessionId: string): Promise<void> { return this.sessionRepository.deleteSession(sessionId); }

  private ensureStructure(): void {
    // Use exclusive creation to eliminate check-then-write races.
    this.writeDefaultIfAbsent(join(this.aveDir, "AGENTS.md"), t("be_memoryManager.defaultAgentsMd"));
    this.writeDefaultIfAbsent(join(this.aveDir, "user-preferences.md"), t("be_memoryManager.defaultUserPrefs"));
    this.writeDefaultIfAbsent(join(this.memoryDir, "MEMORY.md"), getDefaultMemoryIndex());
  }

  private writeDefaultIfAbsent(path: string, content: string): void {
    // An existing document, trusted or pending review, is never touched.
    if (existsSync(path)) return;
    try {
      recordAveHomeInputWriteSync(path, content, () => writeFileSync(path, content, { encoding: "utf-8", flag: "wx" }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  private readFile(name: string): string {
    const path = join(this.aveDir, name);
    return readHomeDocIfPresent(path) ?? "";
  }

  private readMemoryIndex(): string {
    const path = join(this.memoryDir, "MEMORY.md");
    const raw = readHomeDocIfPresent(path);
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
      this.persistentContextFileState.set(path, getFileMtimeMs(path));
    }
  }

  private startPersistentContextPoller(): void {
    if (this.persistentContextPollTimer !== undefined) return;
    const timer = setInterval(() => {
      let changed = false;
      for (const path of this.persistentContextFiles()) {
        const previous = this.persistentContextFileState.get(path);
        const current = getFileMtimeMs(path);
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
    options: MemoryReadOptions & { excludeMarkedMemory?: boolean; includeOtherProjects?: true } = {},
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
        return (options.includeOtherProjects ? !noteIsExpired(entry) : this.matchesMemoryRead(entry, options)) ? [entry] : [];
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
    if (noteIsExpired(entry)) return false;
    const isManagedGlobal = entry.id !== undefined && !entry.projectRoot;
    if (options.scope === "global") return isManagedGlobal;
    // Detached callers cannot enumerate project-managed memory; retain visibility of unscoped legacy notes.
    if (!options.projectRoot) return !entry.projectRoot;
    if (isManagedGlobal) return true;
    return projectRootEquals(entry.projectRoot, options.projectRoot)
      || (options.includeUnscoped === true && !entry.projectRoot);
  }

  private memoryScopeVisibleForMutation(entry: NoteEntry, options: ProjectScopedMemoryOptions): boolean {
    if (!options.projectRoot) return !entry.projectRoot;
    return !entry.projectRoot || projectRootEquals(entry.projectRoot, options.projectRoot);
  }

  private isPromptVisibleMemory(entry: NoteEntry, options: MemorySelectionOptions): boolean {
    if (this.isDerivedMemory(entry) || noteIsExpired(entry)) return false;
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
    // Every refusal of the text itself carries the stable reason `unsafe-text`.
    if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(safeTitle)) {
      throw new Error("saveMemory: unsafe-text: title must be a single-line label without control characters");
    }
    if (MEMORY_INVISIBLE_CHARS.test(`${safeTitle}\n${safeContent}`)) {
      throw new Error("saveMemory: unsafe-text: zero-width and bidi control characters are not allowed");
    }
    if (/<!--\s*ave:/i.test(`${safeTitle}\n\n${safeContent}`)) {
      throw new Error("saveMemory: unsafe-text: the ave marker namespace is reserved");
    }
    return { title: safeTitle, content: safeContent };
  }

  private createMemoryMetadata(options: MemorySaveOptions): MemoryMetadataV1 {
    const kind = options.kind ?? "note";
    const state: MemoryState = "active";
    const source = options.source ?? "user";
    if (!MEMORY_KINDS.has(kind)) throw new Error("saveMemory: invalid memory kind");
    if (!MEMORY_SOURCES.has(source)) throw new Error("saveMemory: invalid memory source");
    if (options.confirmedAt !== undefined && !isValidMemoryTimestamp(options.confirmedAt)) {
      throw new Error("saveMemory: invalid confirmedAt timestamp");
    }
    if (options.expiresAt !== undefined && !isValidMemoryTimestamp(options.expiresAt)) {
      throw new Error("saveMemory: invalid expiresAt timestamp");
    }
    const normalizedCapture = options.capture === undefined ? undefined : normalizeMemoryCapture(options.capture);
    if (options.capture !== undefined && !normalizedCapture) throw new Error("saveMemory: invalid capture provenance");
    const capture = normalizedCapture ?? undefined;
    if (!hasValidCaptureSourceCombination(source, capture)) {
      throw new Error("saveMemory: capture provenance does not match the memory source");
    }
    const origin = options.origin === undefined ? undefined : normalizeMemoryOrigin(options.origin);
    if (origin === null) throw new Error("saveMemory: invalid origin");

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
      confirmedAt: options.confirmedAt ?? now,
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      ...(options.pinned === true ? { pinned: true } : {}),
      ...(capture ? { capture: { ...capture } } : {}),
      ...(origin ? { origin } : {}),
    };
  }

  private mergeExistingMemoryMetadata(
    existing: MemoryMetadataV1,
    requested: MemoryMetadataV1,
    options: MemorySaveOptions,
  ): MemoryMetadataV1 {
    const pinned = options.pinned === undefined ? existing.pinned : options.pinned === true;
    const expiresAt = options.expiresAt ?? existing.expiresAt;
    return {
      v: 1,
      id: existing.id,
      scope: existing.scope,
      kind: options.kind ?? existing.kind,
      state: "active",
      // Provenance describes the latest content, so it follows the save that wrote it.
      source: requested.source,
      createdAt: existing.createdAt,
      confirmedAt: existing.confirmedAt ?? requested.confirmedAt ?? new Date().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
      ...(pinned ? { pinned: true } : {}),
      ...(requested.capture ? { capture: { ...requested.capture } } : {}),
      // Origin is set only when a memory is created; a memory first saved without one (a direct UI save) never gains one.
      ...(existing.origin ? { origin: { ...existing.origin } } : {}),
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
      ...(metadata.origin ? { origin: { ...metadata.origin } } : {}),
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

  // Default-project memory is ordinary project memory here; global sources are global records only.
  // Unscoped legacy notes (no id, no project marker) remain global sources, unchanged by the split.
  private getConsolidationSnapshotForScope(scope: MemoryScope): MemoryConsolidationSnapshot {
    const sourceOptions: MemoryReadOptions = scope.type === "project"
      ? { projectRoot: scope.projectRoot }
      : {};
    const sources = this.readMarkdownEntries(this.memoryDir, sourceOptions)
      .filter((entry) => this.entryMatchesConsolidationScope(entry, scope) && this.isConsolidationSource(entry))
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
      ...(entry.origin ? { origin: { ...entry.origin } } : {}),
    };
  }

  private entryMatchesConsolidationScope(entry: NoteEntry, scope: MemoryScope): boolean {
    return scope.type === "global"
      ? !entry.projectRoot
      : entry.projectRoot !== undefined && projectRootEquals(entry.projectRoot, scope.projectRoot);
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

  /**
   * The memory a same-title save in `scope` updates: the newest such file (by modification time, then name, so the choice
   * never depends on directory order). Other files with that title and scope are left alone.
   */
  private findExistingManagedMemory(
    title: string,
    scope: MemoryScope,
  ): { filename: string; metadata: MemoryMetadataV1 } | undefined {
    const matches: Array<{ filename: string; metadata: MemoryMetadataV1; mtimeMs: number }> = [];
    for (const filename of readdirIfPresent(this.memoryDir)) {
      if (!filename.endsWith(".md") || this.isMemoryIndexFilename(filename)) continue;
      const snapshot = readUtf8FileSnapshotIfPresent(join(this.memoryDir, filename), MAX_MANAGED_MEMORY_FILE_BYTES);
      if (!snapshot || snapshot.tooLarge) continue;
      const parsed = this.parseMemoryNote(snapshot.content);
      if (!parsed.metadata || parsed.invalidMetadata) continue;
      if (parsed.metadata.derivation) continue;
      const existingTitle = parsed.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
      if (existingTitle === title && this.memoryScopesEqual(parsed.metadata.scope, scope)) {
        matches.push({ filename, metadata: parsed.metadata, mtimeMs: snapshot.mtime.getTime() });
      }
    }
    if (matches.length === 0) return undefined;
    matches.sort((x, y) => y.mtimeMs - x.mtimeMs || (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
    const newest = matches[0]!;
    return { filename: newest.filename, metadata: newest.metadata };
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
    const existing = readHomeDocIfPresent(targetPath) ?? getDefaultMemoryIndex();
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
    writeHomeDocSync(targetPath, lines.join("\n").replace(/\n{4,}/g, "\n\n\n"));
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
    const existing = readHomeDocIfPresent(targetPath);
    if (existing === null) {
      this.memoryIndex = "";
      return;
    }
    const linkNeedle = `](./${filename})`;
    const lines = existing.split(/\r?\n/).filter((line) => !line.includes(linkNeedle));
    writeHomeDocSync(targetPath, lines.join("\n"));
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

  private slugify(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\uac00-\ud7a3\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "untitled";
  }
}
