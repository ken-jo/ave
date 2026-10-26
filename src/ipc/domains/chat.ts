import { getTurnChangeReview, restoreCodeCheckpoint } from "../../memory/code-checkpoints.js";
import type { TurnReviewResult } from "../../shared/turn-change-review.js";
import { controlShellTask, listShellTasks } from "../../tools/shell-tools.js";
import { isRewindMode } from "../../shared/code-rewind.js";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { t } from "../../i18n/index.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { userContentText } from "../../engine/llm/types.js";
import { countResourceAttachmentFences } from "../../shared/mcp-resource-bounds.js";
import { normalizeToolPairInvariant } from "../../engine/conversation-history.js";
import {
  MAX_LOCAL_USER_CONTENT_PARTS,
  MAX_LOCAL_USER_CONTENT_TEXT_CHARS,
  MAX_LOCAL_USER_CONTENT_TEXT_PARTS,
  normalizeLocalUserContentParts,
} from "../../main/subscription-attachment-input.js";
import type { ChatUtteranceMode } from "../../shared/chat-utterance.js";
import { parseStagedEnvelope, isMissingStagedEnvelopeErrorMessage } from "../../shared/staged-origins.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { listCustomCommands } from "../../core/custom-commands.js";
import { isValidSessionId, MAX_SESSION_FILE_BYTES } from "../../memory/memory-manager.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { sendToWebContents } from "../safe-send.js";
import { approvalSurfaceRegistry } from "../../permissions/approval-surface-registry.js";
import {
  getMainWindows,
  getPrimaryMainWindow,
  isSecondaryMainWindowContents,
  mainWindowForContents,
  setSessionContentsLookup,
} from "../../main/app-state.js";
import {
  createPlatformConversationLegacyStreamAdapter,
  createPlatformTurnId,
} from "../../api/platform-conversation-legacy-adapter.js";
import { createPlatformConversationEventSink } from "../../engine/conversation-platform-protocol.js";
import {
  createConversationCommandPort,
  DESKTOP_CONVERSATION_ACTOR,
} from "../../main/conversation-command-port.js";
import { createLogger } from "../../lib/logger.js";
import { readDiffSidecar, isSafeId } from "../../tools/write-diff-cache.js";
import { isToolResultStubContent } from "../../shared/tool-result-stub.js";
import {
  getLlmVendorSettings,
  getLlmThinkingBudgetLimit,
  normalizeLlmThinkingBudgetTokens,
  llmRouteBaseUrlSignature,
} from "../../shared/llm-vendor-defaults.js";
import {
  runStreamedTurn,
  STREAM_TURN_OPTIONS,
  type ConversationStreamEventSink,
} from "../handlers/chat-stream.js";
import {
  handleChatSessions,
  handleChatGetHistory,
  handleChatSessionHistory,
  personaPromptIdFromUserMessage,
  resolvePersonaRolePrompt,
  sanitizeOutgoingTurnContent,
  sanitizeOutgoingInput,
  markMainActiveAfterTurn,
  prepareParentMailboxTurn,
  acknowledgeParentMailboxAfterTurn,
  resolveChatNewProjectPayload,
  parseChatSendPayload,
} from "../handlers/chat.js";
import {
  defaultWorkspaceProject,
  resolveAuthorizedWorkspaceProject,
} from "../../main/project-root-authorization.js";
import { createDlpSafeUuid } from "../../shared/dlp-safe-id.js";
import { createConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import { createSessionGoalRevival } from "../../main/session-goal-revival.js";
import { ensureSuggestionsSession } from "../../main/suggestions-session.js";
import { isSuggestionsSession } from "../../shared/suggestions-session.js";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "../../main/conversation-command-port.js";
import { MAIN_CHAT_GROUP_ID } from "../../contract/app-contract.js";
import type { ConversationLoop } from "../../engine/conversation-loop.js";
import { hasOnlyKeys } from "../../shared/is-record.js";
import { errorMessage } from "../../shared/error-message.js";
import { activeModelCatalog } from "../../shared/model-catalog/active.js";
import type { ModelCatalogIpcResult } from "../../shared/model-catalog/types.js";
import { readModelCatalogRefreshPolicy } from "../../core/model-catalog/refresh-policy.js";
import { getAdminPolicyPath } from "../../permissions/policy-store.js";
import { parseFileMentionReferences } from "../../shared/file-mention-reference.js";
import { expandFileMentionContext } from "../handlers/file-mention-context.js";

const SESSION_OPEN_IN_OTHER_GROUP = "session-open-in-other-group";
const log = createLogger("chat");
const MAX_MEMORY_PROJECT_ROOT_CHARS = 2_048;
const MAX_MEMORY_PROJECT_NAME_CHARS = 120;
const PROJECT_NOT_ALLOWED = { ok: false, error: "project-not-allowed" } as const;

function isMissingStagedEnvelopeError(error: unknown): boolean {
  return error instanceof Error
    && isMissingStagedEnvelopeErrorMessage(error.message);
}

// Imports accept the export envelope and always create a new session, never overwrite an existing one.
const MAX_IMPORTED_MESSAGES = 100_000;

const USER_CONTENT_PART_KEYS: Record<string, readonly string[]> = {
  text: ["type", "text"],
  image: ["type", "image", "mimeType", "width", "height", "bytes"],
  file: ["type", "data", "mimeType"],
};

const UNREADABLE_FIELD = Symbol("unreadable-field");

function ownField(obj: Record<string, unknown>, key: string): unknown {
  try {
    return Object.hasOwn(obj, key) ? obj[key] : undefined;
  } catch {
    return UNREADABLE_FIELD;
  }
}

function isOptionalNonNegativeSafeInteger(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isValidUserContentPart(part: unknown): boolean {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;
  const p = part as Record<string, unknown>;
  const type = ownField(p, "type");
  if (typeof type !== "string" || !Object.hasOwn(USER_CONTENT_PART_KEYS, type)) return false;
  if (!hasOnlyKeys(p, USER_CONTENT_PART_KEYS[type])) return false;

  if (type === "text") return typeof ownField(p, "text") === "string";

  if (type === "image") {
    const image = ownField(p, "image");
    const mimeType = ownField(p, "mimeType");
    const width = ownField(p, "width");
    const height = ownField(p, "height");
    const bytes = ownField(p, "bytes");
    return typeof image === "string"
      && (mimeType === undefined || typeof mimeType === "string")
      && isOptionalNonNegativeSafeInteger(width)
      && isOptionalNonNegativeSafeInteger(height)
      && isOptionalNonNegativeSafeInteger(bytes);
  }

  if (type === "file") {
    return typeof ownField(p, "data") === "string" && typeof ownField(p, "mimeType") === "string";
  }
  return false;
}

// Read owned array indices; sparse, unreadable, or overridden iteration must fail closed.
function hasValidUserContentPartComposition(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;

  let length: number;
  try {
    length = raw.length;
  } catch {
    return false;
  }
  if (
    !Number.isSafeInteger(length)
    || length < 0
    || length > MAX_LOCAL_USER_CONTENT_PARTS
  ) {
    return false;
  }

  let textPartCount = 0;
  let textChars = 0;
  for (let index = 0; index < length; index += 1) {
    let part: unknown;
    try {
      if (!Object.hasOwn(raw, index)) return false;
      part = raw[index];
    } catch {
      return false;
    }
    if (!isValidUserContentPart(part)) return false;

    const record = part as Record<string, unknown>;
    if (ownField(record, "type") !== "text") continue;
    const text = ownField(record, "text");
    if (typeof text !== "string") return false;
    if (textPartCount >= MAX_LOCAL_USER_CONTENT_TEXT_PARTS) return false;
    if (text.length > MAX_LOCAL_USER_CONTENT_TEXT_CHARS - textChars) return false;
    textPartCount += 1;
    textChars += text.length;
  }
  return true;
}

const IMPORTABLE_TOOL_SOURCES: ReadonlySet<string> = new Set(["builtin", "plugin", "mcp"]);
const IMPORTABLE_TOOL_CATEGORIES: ReadonlySet<string> =
  new Set(["read", "write", "shell", "network", "meta"]);

function isValidOptionalMember(value: unknown, allowed: ReadonlySet<string>): boolean {
  return value === undefined || (typeof value === "string" && allowed.has(value));
}

function isValidOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function isValidToolCallBlock(call: unknown): boolean {
  if (!call || typeof call !== "object" || Array.isArray(call)) return false;
  const c = call as Record<string, unknown>;
  // Accept exported registry origin only after validating every value.
  if (!hasOnlyKeys(c, ["id", "name", "input", "source", "category", "pluginId", "mcpServerId"])) {
    return false;
  }
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    !!c.input &&
    typeof c.input === "object" &&
    !Array.isArray(c.input) &&
    isValidOptionalMember(c.source, IMPORTABLE_TOOL_SOURCES) &&
    isValidOptionalMember(c.category, IMPORTABLE_TOOL_CATEGORIES) &&
    isValidOptionalString(c.pluginId) &&
    isValidOptionalString(c.mcpServerId)
  );
}

// Reject unknown message fields for the entire import; partial acceptance is forbidden.
function isValidImportedMessage(raw: unknown): raw is GenericMessage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const m = raw as Record<string, unknown>;
  switch (m.role) {
    case "user": {
      // Accept exported meta but discard it during normalization so imports cannot forge identity or host compact boundaries.
      if (!hasOnlyKeys(m, ["role", "content", "meta"])) return false;
      const content = ownField(m, "content");
      if (content === UNREADABLE_FIELD) return false;
      if (typeof content === "string") return true;
      return hasValidUserContentPartComposition(content);
    }
    case "assistant": {
      if (!hasOnlyKeys(m, ["role", "content", "thought", "toolCalls", "meta"])) return false;
      if (typeof m.content !== "string") return false;
      if (m.thought !== undefined && typeof m.thought !== "string") return false;
      if (m.toolCalls !== undefined) {
        if (!Array.isArray(m.toolCalls) || !m.toolCalls.every(isValidToolCallBlock)) return false;
      }
      return true;
    }
    case "tool_result": {
      if (!hasOnlyKeys(m, ["role", "content", "toolName", "toolUseId", "isError", "meta"])) return false;
      if (typeof m.content !== "string") return false;
      if (typeof m.toolUseId !== "string") return false;
      if (m.toolName !== undefined && typeof m.toolName !== "string") return false;
      if (m.isError !== undefined && typeof m.isError !== "boolean") return false;
      return true;
    }
    default:
      return false;
  }
}

// Rebuild parsed records and normalize multipart data through the live IPC bounds.
function normalizeImportedMessage(message: GenericMessage): GenericMessage | null {
  switch (message.role) {
    case "user": {
      if (typeof message.content === "string") {
        return { role: "user", content: message.content };
      }
      const content = normalizeLocalUserContentParts(message.content);
      return content && content.length === message.content.length ? { role: "user", content } : null;
    }
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.thought !== undefined ? { thought: message.thought } : {}),
        ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
      };
    case "tool_result":
      return {
        role: "tool_result",
        toolUseId: message.toolUseId,
        content: message.content,
        ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
        ...(message.isError !== undefined ? { isError: message.isError } : {}),
      };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function hasParentSubAgentReference(
  messages: GenericMessage[],
  childSessionId: string,
): boolean {
  const resultByToolUseId = new Map<string, Record<string, unknown> | null>();
  for (const message of messages) {
    if (message.role === "tool_result") {
      resultByToolUseId.set(message.toolUseId, parseJsonRecord(message.content));
    }
  }

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) continue;
    for (const toolCall of message.toolCalls) {
      if (toolCall.name !== "agent_spawn") continue;
      const input = asRecord(toolCall.input) ?? {};
      const result = resultByToolUseId.get(toolCall.id) ?? null;
      const linkedIds = [
        typeof input.resumeId === "string" ? input.resumeId : undefined,
        typeof result?.childSessionId === "string" ? result.childSessionId : undefined,
        typeof result?.resumeId === "string" ? result.resumeId : undefined,
      ];
      if (!linkedIds.includes(childSessionId)) continue;
      return true;
    }
  }
  return false;
}

interface ImportValidationResult {
  ok: boolean;
  messages: GenericMessage[];
  error?: string;
}

// Reject the whole import on any invalid message; never import a partial batch.
function validateImportedSessionJson(raw: unknown): ImportValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, messages: [], error: "invalid-file-shape" };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || typeof r.exportedAt !== "string" || !Array.isArray(r.messages)) {
    return { ok: false, messages: [], error: "invalid-file-shape" };
  }
  if (r.messages.length === 0) {
    return { ok: false, messages: [], error: "empty-messages" };
  }
  if (r.messages.length > MAX_IMPORTED_MESSAGES) {
    return { ok: false, messages: [], error: "too-many-messages" };
  }
  const messages: GenericMessage[] = [];
  for (const candidate of r.messages) {
    if (!isValidImportedMessage(candidate)) {
      return { ok: false, messages: [], error: "invalid-message-shape" };
    }
    const normalized = normalizeImportedMessage(candidate);
    if (!normalized) {
      return { ok: false, messages: [], error: "invalid-message-shape" };
    }
    messages.push(normalized);
  }
  return { ok: true, messages };
}

interface MemoryProjectOptions {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
}

type MemoryProjectOptionsResolution =
  | { ok: true; options: MemoryProjectOptions }
  | { ok: false; error: "project-not-allowed" };

function normalizeMemoryProjectString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxChars) : undefined;
}

function parseMemoryProjectOptions(raw: unknown): MemoryProjectOptionsResolution {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: true, options: {} };
  }
  const record = raw as Record<string, unknown>;
  const projectRoot = normalizeMemoryProjectString(record.projectRoot, MAX_MEMORY_PROJECT_ROOT_CHARS);
  const projectName = normalizeMemoryProjectString(record.projectName, MAX_MEMORY_PROJECT_NAME_CHARS);
  const resolved = resolveAuthorizedWorkspaceProject(projectRoot, projectName);
  if (!resolved.authorized || !resolved.project) return PROJECT_NOT_ALLOWED;
  return {
    ok: true,
    options: {
      projectRoot: resolved.project.projectRoot,
      projectName: resolved.project.projectName,
      ...(resolved.project.isDefault === true ? { includeUnscoped: true } : {}),
      ...(record.includeUnscoped === true && resolved.project.isDefault === true ? { includeUnscoped: true } : {}),
    },
  };
}

type MemoryCandidateActionPayload =
  | { ok: true; id: string; options: unknown }
  | { ok: false };

// Limit lifecycle payloads so renderer input cannot smuggle manager options.
function parseMemoryCandidateActionPayload(raw: unknown): MemoryCandidateActionPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const record = raw as Record<string, unknown>;
  if (!hasOnlyKeys(record, ["id", "opts"])) return { ok: false };
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 128) {
    return { ok: false };
  }
  if (record.opts !== undefined) {
    if (!record.opts || typeof record.opts !== "object" || Array.isArray(record.opts)) {
      return { ok: false };
    }
    if (!hasOnlyKeys(record.opts as Record<string, unknown>, ["projectRoot", "projectName", "includeUnscoped"])) {
      return { ok: false };
    }
  }
  return { ok: true, id: record.id, options: record.opts };
}

function candidateMemoryActionFailure(error: unknown): { ok: false; error: "invalid-input" | "not-found" | "write-failed" } {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("invalid memory id")) return { ok: false, error: "invalid-input" };
  // Scope misses intentionally share this result with absent candidates, so a
  // caller cannot probe whether another project's candidate exists.
  if (message.includes("candidate not found")) return { ok: false, error: "not-found" };
  return { ok: false, error: "write-failed" };
}

export type { SerializedHistoryMessage } from "../../shared/chat-history.js";

// Resolve durable row ids; transcript entry ordinals differ from stored row ordinals.
function historyIndexOfMessageId(history: GenericMessage[], messageId: string): number {
  return history.findIndex((m) => m.meta?.messageId === messageId);
}

function latestReviewTurnId(loop: ConversationLoop): string | undefined {
  const latest = loop.getHistory().getMessages().findLast((message) =>
    message.role === "user" && message.meta?.compactBoundary !== true && message.meta?.hostInjectionId === undefined);
  return typeof latest?.meta?.messageId === "string" ? latest.meta.messageId : undefined;
}



// Rewind returns the complete original input or refuses without truncating history.
function restorableRewindInput(
  message: Extract<GenericMessage, { role: "user" }>,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof message.content !== "string") {
    if (message.content.some((part) => part.type !== "text")) {
      return { ok: false, error: "attachment-not-restorable" };
    }
    if (countResourceAttachmentFences(message.content) > 0) {
      return { ok: false, error: "attachment-not-restorable" };
    }
  }
  // Restore canonical user text, never a host routing wrapper.
  const displayText = message.meta?.displayText;
  if (typeof displayText === "string") return { ok: true, text: displayText };
  if (typeof message.content === "string") return { ok: true, text: message.content };
  return { ok: true, text: userContentText(message.content) };
}

export function registerChatHandlers(deps: IpcDeps): void {
  const {
    conversationLoop,
    settingsService,
    memoryManager,
    memoryCaptureService,
    starredStore,
    feedbackStore,
    auditLogger,
    askUserQuestionGate,
    preferenceRefreshService,
    memoryConsolidationService,
    personaPromptStore,
    getMainWindow,
  } = deps;

  // Production transports share one host-owned runtime; registrar tests use a private instance.
  const STREAMING_ACTIVE = "streaming-active" as const;
  type StreamTurnTransport = {
    readonly sink: ConversationStreamEventSink;
    readonly abortSignal?: AbortSignal;
  };
  // Each tiled group owns its loop, leases, streams, and replay paths.
  const createGroupTurns = (
    loop: ConversationLoop,
    surfaceRuntime: ConversationSurfaceRuntime,
    buildSink: (streamId?: number) => ConversationStreamEventSink,
    groupDeps: IpcDeps,
  ) => {
    const trackStreamTurn = <T>(factory: (signal: AbortSignal) => Promise<T>): Promise<T> =>
      surfaceRuntime.activity.trackTurn(factory);
    const tryTrackStreamTurn = <T>(factory: (signal: AbortSignal) => Promise<T>): Promise<T> | null =>
      surfaceRuntime.activity.tryTrackTurn(factory);
    const trackSessionMutation = <T>(factory: () => Promise<T>): Promise<T> | null =>
      surfaceRuntime.activity.trackMutation(factory);
    const allocateStreamId = () => surfaceRuntime.activity.allocateStreamId();
    const createStreamTurnTransport = (): StreamTurnTransport => {
      const streamId = allocateStreamId();
      return { sink: buildSink(streamId) };
    };
    const runStreamTurn = async (
      { sink, abortSignal }: StreamTurnTransport,
      input: string,
      attachments?: import("../../engine/llm/types.js").UserContentPart[],
      rolePrompt?: ActiveRolePrompt,
      displayText?: string,
      resumesInterruptedTurn?: true,
    ) => {
      // Replay and edit/resend need the same input DLP boundary as ordinary sends.
      const replayStagedInputOrigin = parseStagedEnvelope(input)?.kind.inputOrigin;
      const sanitized = sanitizeOutgoingTurnContent(settingsService, sink, input, attachments);
      const safeDisplayText = displayText === undefined ? undefined
        : sanitizeOutgoingInput(settingsService, sink, displayText);
      const result = await runStreamedTurn(
        loop,
        sanitized.input,
        sink,
        {
          ...STREAM_TURN_OPTIONS,
          ...(abortSignal ? { abortSignal } : {}),
          ...(replayStagedInputOrigin ? { inputOrigin: replayStagedInputOrigin } : {}),
          ...(sanitized.attachments && sanitized.attachments.length > 0
            ? { attachments: sanitized.attachments }
            : {}),
          ...(rolePrompt ? { rolePrompt } : {}),
          ...(safeDisplayText !== undefined ? { displayText: safeDisplayText } : {}),
          ...(resumesInterruptedTurn ? { resumesInterruptedTurn } : {}),
        },
      );
      await markMainActiveAfterTurn(groupDeps, sanitized.input);
      return result;
    };
    const tryStreamTurn = <T>(
      factory: (transport: StreamTurnTransport) => Promise<T>,
    ): Promise<T> | null => {
      const transport = createStreamTurnTransport();
      return tryTrackStreamTurn((abortSignal) => factory({ ...transport, abortSignal }));
    };

    const continueFromLastUserTurnWithinLease = async (
      opts: { requireTerminalUser: boolean; restoreOnFailure: boolean },
      transport: StreamTurnTransport,
    ) => {
      const messages = [...(loop.getHistory().getMessages() as GenericMessage[])];
      if (messages.length === 0) return { ok: false, error: "no-user-message" };
      let lastUserIdx = messages.length - 1;
      // Host-exit interruption resumes persisted progress rather than replaying the user's last request.
      const resumeInterrupted = opts.requireTerminalUser && endsInHostExitInterruption(messages);
      if (resumeInterrupted) {
        lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") { lastUserIdx = i; break; }
        }
      } else if (opts.requireTerminalUser) {
        if (messages[lastUserIdx]?.role !== "user") {
          return { ok: false, error: "last-message-not-user" };
        }
      } else {
        lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") { lastUserIdx = i; break; }
        }
      }
      if (lastUserIdx < 0) return { ok: false, error: "no-user-message" };
      const lastUser = messages[lastUserIdx] as Extract<GenericMessage, { role: "user" }>;
      // Split text into prompt and non-text into attachments; display placeholders would duplicate attachments.
      const lastUserText = Array.isArray(lastUser.content)
        ? lastUser.content
            .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
            .map((p) => p.text)
            .join("\n")
        : lastUser.content;
      const lastUserAttachments = Array.isArray(lastUser.content)
        ? lastUser.content.filter((p) => p.type !== "text")
        : undefined;
      const personaPromptId = personaPromptIdFromUserMessage(lastUser);
      if (!personaPromptId.ok) return { ok: false, error: personaPromptId.error };
      const personaPrompt = await resolvePersonaRolePrompt(personaPromptStore, personaPromptId.personaPromptId);
      if (!personaPrompt.ok) return { ok: false, error: personaPrompt.error };
      if (resumeInterrupted) {
        const result = await runStreamTurn(
          transport,
          t("be_conversationLoop.resumeInterruptedTurnInput"),
          undefined,
          personaPrompt.rolePrompt,
          t("be_conversationLoop.resumeInterruptedTurnDisplay"),
          true,
        );
        return { ok: true, result };
      }
      // Preserve display text so resource replay does not expose folded fences in the user bubble.
      const priorDisplayText = (lastUser.meta as { displayText?: unknown } | undefined)?.displayText;
      loop.getHistory().truncate(lastUserIdx);
      try {
        const result = await runStreamTurn(
          transport,
          lastUserText,
          lastUserAttachments,
          personaPrompt.rolePrompt,
          typeof priorDisplayText === "string" ? priorDisplayText : undefined,
        );
        return { ok: true, result };
      } catch (err) {
        // Restore truncated history when staged-header rejection happens before provider work.
        if (opts.restoreOnFailure || isMissingStagedEnvelopeError(err)) {
          loop.getHistory().restore(messages);
        }
        throw err;
      }
    };
    const continueFromLastUserTurn = async (
      opts: { requireTerminalUser: boolean; restoreOnFailure: boolean },
      expectedSessionId?: string,
    ) => {
      const turn = tryStreamTurn(async (transport) => {
        if (expectedSessionId !== undefined && expectedSessionId !== loop.getSessionId()) {
          return { ok: false, error: "session-mismatch" };
        }
        return continueFromLastUserTurnWithinLease(opts, transport);
      });
      return turn ?? { ok: false, error: STREAMING_ACTIVE };
    };
    return {
      trackStreamTurn,
      trackSessionMutation,
      allocateStreamId,
      runStreamTurn,
      tryStreamTurn,
      continueFromLastUserTurnWithinLease,
      continueFromLastUserTurn,
    };
  };
  type GroupTurns = ReturnType<typeof createGroupTurns>;
  const endsInHostExitInterruption = (messages: readonly GenericMessage[]): boolean => {
    const tail = messages[messages.length - 1];
    return tail?.role === "assistant"
      && tail.meta?.interrupted === true
      && tail.meta.interruptedBy === "host-exit";
  };

  interface ChatGroupContext {
    // Secondary-window groups are renderer-owned; the primary scope retains global ids.
    owner: WebContents | null;
    rendererGroupId: string;
    loop: ConversationLoop;
    deps: IpcDeps;
    surfaceRuntime: ConversationSurfaceRuntime;
    commandPort: ConversationCommandPort;
    buildSink: (streamId?: number) => ConversationStreamEventSink;
    turns: GroupTurns;
    unsubscribeStream: () => void;
  }
  const groupContexts = new Map<string, ChatGroupContext>();
  const isPrimaryGroup = (group: ChatGroupContext): boolean =>
    group.deps.chatGroupId === undefined || group.deps.chatGroupId === MAIN_CHAT_GROUP_ID;
  const groupHolding = (sessionId: string): ChatGroupContext | undefined =>
    [...groupContexts.values()].find((group) => group.loop.getSessionId() === sessionId);
  // Primary frames follow the primary window, never the active window, whose tile ids may collide.
  const groupTargetContents = (owner: WebContents | null): WebContents | undefined => {
    if (owner) return owner.isDestroyed() ? undefined : owner;
    const primary = getPrimaryMainWindow();
    if (primary) return primary.webContents;
    return getMainWindows().length === 0 ? getMainWindow()?.webContents : undefined;
  };
  const registerGroupApprovalOwner = (group: Pick<ChatGroupContext, "loop" | "owner">): void => {
    const contents = groupTargetContents(group.owner);
    // Only the host's registered app window may own this group's approvals.
    const window = contents && mainWindowForContents(contents);
    approvalSurfaceRegistry.register(group.loop.getSessionId(), window?.webContents ?? null);
  };
  setSessionContentsLookup((sessionId) => {
    const holder = groupHolding(sessionId);
    return holder ? groupTargetContents(holder.owner) ?? null : null;
  });
  // Scope secondary tile ids by window so independently numbered renderers never share loops.
  const scopedGroupKey = (owner: WebContents | null, rendererGroupId: string): string =>
    owner ? `window-${owner.id}:${rendererGroupId}` : rendererGroupId;
  const ownerOf = (sender: unknown): WebContents | null =>
    isSecondaryMainWindowContents(sender) ? sender as WebContents : null;
  const chatGroupContext = (
    rendererGroupId: string,
    owner: WebContents | null = null,
  ): ChatGroupContext => {
    const chatGroupId = scopedGroupKey(owner, rendererGroupId);
    const cached = groupContexts.get(chatGroupId);
    if (cached) return cached;
    const isMain = chatGroupId === MAIN_CHAT_GROUP_ID;
    // Unknown groups fail instead of falling back to another tile's loop.
    if (!isMain && (!deps.resolveChatGroupLoop || !deps.releaseChatGroupLoop)) {
      throw new Error("chat-groups-unavailable");
    }
    const loop = isMain ? conversationLoop : deps.resolveChatGroupLoop!(chatGroupId);
    const groupDeps: IpcDeps = isMain ? deps : { ...deps, conversationLoop: loop, chatGroupId };
    if (!isMain) watchRendererLifetime(owner);
    // Only the primary group receives the runtime shared with external transports.
    const surfaceRuntime = isMain
      ? deps.conversationSurfaceRuntime ?? createConversationSurfaceRuntime()
      : createConversationSurfaceRuntime();
    surfaceRuntime.activity.bindSessionTransitionGuard(
      () => loop.isSessionTransitioning?.() ?? false,
      (notify) => loop.onSessionTransitionSettled?.(notify) ?? (() => undefined),
    );
    const commandPort = isMain
      ? deps.conversationCommandPort ?? createConversationCommandPort(groupDeps, surfaceRuntime)
      : createConversationCommandPort(groupDeps, surfaceRuntime);
    const legacyStreamAdapter = createPlatformConversationLegacyStreamAdapter(
      surfaceRuntime.timeline,
    );
    // The semantic timeline is canonical; stamp the group before adapting frames for the renderer.
    const unsubscribeStream = legacyStreamAdapter.subscribe((channel, payload) => {
      const labelled = payload && typeof payload === "object"
        ? { ...(payload as Record<string, unknown>), chatGroupId: rendererGroupId }
        : payload;
      sendToWebContents(groupTargetContents(owner), channel, labelled, log);
    });
    const buildGroupSink = (streamId?: number): ConversationStreamEventSink =>
      createPlatformConversationEventSink(surfaceRuntime.timeline, {
        conversationId: loop.getSessionId(),
        ...(streamId === undefined ? {} : { turnId: createPlatformTurnId(streamId) }),
      });
    const turns = createGroupTurns(loop, surfaceRuntime, buildGroupSink, groupDeps);
    const context: ChatGroupContext = {
      owner,
      rendererGroupId,
      loop,
      deps: groupDeps,
      surfaceRuntime,
      commandPort,
      buildSink: buildGroupSink,
      turns,
      unsubscribeStream,
    };
    groupContexts.set(chatGroupId, context);
    registerGroupApprovalOwner(context);
    // Goal revival belongs to the group's held session and starts only after its turn lease releases.
    if (deps.sessionGoalStore) {
      const revival = createSessionGoalRevival({
        goals: deps.sessionGoalStore,
        currentSessionId: () => loop.getSessionId(),
        // Released groups cannot revive goals for conversations no longer on screen.
        isAttached: () => {
          if (groupContexts.get(chatGroupId) !== context) return false;
          return groupTargetContents(owner) !== undefined;
        },
        isBusy: () => surfaceRuntime.activity.isBusy(),
        hasActiveTurn: () => loop.hasActiveTurn(),
        tryTakeTurn: (body) => surfaceRuntime.activity.tryTrackTurn(body),
        runTurn: async ({ input, displayText }) => {
          await runStreamedTurn(loop, input, buildGroupSink(turns.allocateStreamId()), {
            ...STREAM_TURN_OPTIONS,
            // Autonomous continuation is host-authored and must retain non-keyboard provenance.
            inputOrigin: "agent-message",
            displayText,
            // Host-started turns need an announced row because no surface echoed a bubble.
            hostSubmitted: true,
          });
        },
      });
      surfaceRuntime.activity.onTurnSettled(revival.reviveIfDue);
      // Idle goal resume must explicitly start a turn; there is no prior turn to trigger revival.
      deps.sessionGoalStore.onChange((sessionId) => {
        if (sessionId === loop.getSessionId()) revival.reviveIfDue();
      });
    }
    return context;
  };

  // Build the primary group before exposing channels so injected runtimes are ready.
  const mainGroup = chatGroupContext(MAIN_CHAT_GROUP_ID);
  const conversationSurfaceRuntime = mainGroup.surfaceRuntime;
  const buildSink = mainGroup.buildSink;

  // Require the preload-stamped group id; omission must not address the primary conversation.
  const isNativeGroupFrame = (event: IpcMainInvokeEvent): boolean => {
    const contents = event.sender;
    if (!contents || contents.isDestroyed() || event.senderFrame !== contents.mainFrame) return false;
    const window = mainWindowForContents(contents);
    return window !== null && !window.isDestroyed() && window.webContents === contents;
  };
  const groupOf = (event: IpcMainInvokeEvent, chatGroupId: unknown, channel: string): ChatGroupContext => {
    if (!validateHostRendererSender(event) || !isNativeGroupFrame(event)) {
      auditUnauthorized(auditLogger, channel, event);
      throw new Error("unauthorized-frame");
    }
    if (typeof chatGroupId !== "string" || !chatGroupId.trim()) {
      throw new Error("chat-group-required");
    }
    return chatGroupContext(chatGroupId.trim(), ownerOf(event.sender));
  };

  // Abort and await stopped work; interruption reasons name the host action.
  const quiesce = async (
    context: ChatGroupContext,
    reason: string,
    capturedOwner?: Promise<unknown> | null,
  ): Promise<void> => {
    context.surfaceRuntime.activity.abortActiveTurn(new Error(reason));
    context.loop.abortCurrentTurn(new Error(reason));
    const active = capturedOwner === undefined
      ? context.surfaceRuntime.activity.activeTurn() ?? context.surfaceRuntime.activity.activeMutation()
      : capturedOwner;
    if (!active) return;
    try {
      await active;
    } catch {
    }
  };

  const releaseGroup = async (id: string, reason: string): Promise<boolean> => {
    const context = groupContexts.get(id);
    if (!context) return false;
    const admission = context.surfaceRuntime.activity.beginSessionTransitionAdmission();
    if (admission === null) throw new Error("conversation-activity:session-transition-in-progress");
    try {
      await quiesce(context, reason, admission.owner);
      return await context.loop.runSessionTransition("chat-group-release", async (lease) => {
        await context.loop.cleanupSession(lease);
        context.unsubscribeStream();
        approvalSurfaceRegistry.release(context.loop.getSessionId());
        groupContexts.delete(id);
        deps.releaseChatGroupLoop?.(id);
        return true;
      });
    } finally {
      admission.release();
    }
  };

  // Document replacement releases non-primary groups before the renderer reuses its tile ids.
  const watchedRenderers = new WeakSet<object>();
  const watchRendererLifetime = (owner: WebContents | null): void => {
    const contents = owner ?? groupTargetContents(null);
    if (!contents || watchedRenderers.has(contents)) return;
    watchedRenderers.add(contents);
    // Release only this renderer's groups; the primary loop remains alive.
    const releaseAll = (reason: string) => {
      for (const [id, context] of [...groupContexts.entries()]) {
        if (id !== MAIN_CHAT_GROUP_ID && context.owner === owner) {
          void releaseGroup(id, reason).catch((error: unknown) => {
            log.warn("chat group release failed (%s): %s", id, (error as Error).message);
          });
        }
      }
    };
    // Use committed main-frame changes; cancelled, in-page, and subframe navigation retain the owning document.
    contents.on("did-navigate", () => releaseAll("renderer reload released the tile"));
    contents.on("did-fail-provisional-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3 /* ERR_ABORTED */) releaseAll("renderer load failed; tile released");
    });
    contents.on("render-process-gone", () => releaseAll("renderer process gone; tile released"));
    // Window closure releases its tiles before a later window reuses their ids.
    contents.on("destroyed", () => releaseAll("window closed; tile released"));
  };

  // Closing a tile releases its loop and leases to prevent hidden live conversations.
  ipcMain.handle(CHANNELS.chat.groupRelease, async (e, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.groupRelease, e); return UNAUTHORIZED_FRAME; }
    if (!isNativeGroupFrame(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.groupRelease, e); return UNAUTHORIZED_FRAME; }
    if (typeof chatGroupId !== "string" || !chatGroupId.trim()) return { ok: false, error: "chat-group-required" };
    const id = scopedGroupKey(ownerOf(e.sender), chatGroupId.trim());
    if (id === MAIN_CHAT_GROUP_ID) {
      // Keep the primary loop and stream subscription for resume, restore, and session-list consumers.
      const admission = mainGroup.surfaceRuntime.activity.beginSessionTransitionAdmission();
      if (admission === null) throw new Error("conversation-activity:session-transition-in-progress");
      try {
        await quiesce(mainGroup, "tile closed", admission.owner);
        return await mainGroup.loop.runSessionTransition("primary-chat-group-release", async (lease) => {
          await mainGroup.loop.newConversation("main", undefined, lease);
          registerGroupApprovalOwner(mainGroup);
          await memoryManager.markMainActiveFresh();
          return { ok: true, released: true };
        });
      } finally {
        admission.release();
      }
    }
    return { ok: true, released: await releaseGroup(id, "tile closed") };
  });

  ipcMain.handle(CHANNELS.chat.hasProvider, (e, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.hasProvider, e); return false; }
    if (!isNativeGroupFrame(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.hasProvider, e); return false; }
    return groupOf(e, chatGroupId, CHANNELS.chat.hasProvider).loop.hasProvider();
  });
  // Commands read disk; validate the sender and derive the project from the tile session.
  ipcMain.handle(CHANNELS.chat.listCustomCommands, async (e, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.listCustomCommands, e);
      return UNAUTHORIZED_FRAME;
    }
    const { projectRoot } = groupOf(e, chatGroupId, CHANNELS.chat.listCustomCommands).loop.getSessionProjectContext();
    return { commands: await listCustomCommands(projectRoot) };
  });
  ipcMain.handle(CHANNELS.llm.ping, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.llm.ping, e);
      return UNAUTHORIZED_FRAME;
    }
    return conversationLoop.pingProvider();
  });
  ipcMain.handle(CHANNELS.llm.getModelCatalog, async (e): Promise<ModelCatalogIpcResult | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.llm.getModelCatalog, e);
      return UNAUTHORIZED_FRAME;
    }
    try {
      const catalog = activeModelCatalog();
      return { ok: true, catalog, refreshPolicy: await readModelCatalogRefreshPolicy(getAdminPolicyPath()) };
    } catch (error) {
      // A missing boot catalog is a startup-order defect; log it and return a stable refusal.
      log.error({ err: error }, "model catalog requested before main installed one");
      return { ok: false, error: "catalog-unavailable" };
    }
  });

  const mainTurns = mainGroup.turns;

  // Opt-in parent wake never changes sessions; racing navigation leaves the durable mailbox for later.
  type WakeAwareRunner = {
    setParentWakeHandler?: (handler: (parentSessionId: string) => Promise<void>) => void;
  };
  const wakeAwareRunner = deps.getSubAgentRunner?.() as WakeAwareRunner | undefined;
  if (typeof wakeAwareRunner?.setParentWakeHandler === "function") {
    wakeAwareRunner.setParentWakeHandler(async (parentSessionId) => {
      // A child result may arrive before lease release; capture and await that lease once before revalidation.
      const leaseAtRequest = conversationSurfaceRuntime.activity.activeTurn()
        ?? conversationSurfaceRuntime.activity.activeMutation();
      if (leaseAtRequest !== null) {
        try {
          await leaseAtRequest;
        } catch {
          // Interrupted work still releases its lease; the mailbox remains available for revalidation.
        }
      }

      if (
        conversationLoop.getSessionKind() !== "main"
        || conversationLoop.getSessionId() !== parentSessionId
        || conversationSurfaceRuntime.activity.isBusy()
        || conversationLoop.hasActiveTurn()
      ) {
        return;
      }

      const streamId = mainTurns.allocateStreamId();
      const sink = buildSink(streamId);
      await mainTurns.trackStreamTurn(async (abortSignal) => {
        // Publish the turn lease before mailbox snapshot so concurrent sends or mutations cannot switch the loop.
        const mailboxTurn = await prepareParentMailboxTurn(deps);
        if (
          !mailboxTurn
          || mailboxTurn.parentSessionId !== parentSessionId
          || conversationLoop.getSessionId() !== parentSessionId
          || conversationLoop.hasActiveTurn()
        ) {
          return { text: "", toolCalls: [], route: "default", stopReason: "blocked" };
        }
        const result = await runStreamedTurn(
          conversationLoop,
          mailboxTurn.initialGuidance,
          sink,
          {
            ...STREAM_TURN_OPTIONS,
            inputOrigin: "agent-message",
            abortSignal,
            approvalReasonPrefix: mailboxTurn.approvalReasonPrefix,
            // Preserve report input as the user-row display text for reload.
            subAgentReport: mailboxTurn.childTitle === undefined
              ? {}
              : { title: mailboxTurn.childTitle },
          },
        );
        if (conversationLoop.getSessionId() !== parentSessionId) return result;
        await acknowledgeParentMailboxAfterTurn(deps, mailboxTurn, result);
        await markMainActiveAfterTurn(deps, mailboxTurn.initialGuidance);
        return result;
      });
    });
  }
  // The semantic timeline owns chat frames; renderer delivery uses its compatibility projection.
  const interruptActiveTurn = async (group: ChatGroupContext): Promise<void> => {
    group.surfaceRuntime.activity.abortActiveTurn();
    group.loop.abortCurrentTurn();
    const activeStreamTurn = group.surfaceRuntime.activity.activeTurn();
    if (activeStreamTurn) {
      try {
        await activeStreamTurn;
      } catch {
      }
    }
  };
  // A late refusal must retain the interrupted badge if the running answer was already stopped.
  const flagInterruptedRefusal = (result: unknown): unknown => {
    if (result === null || typeof result !== "object") return result;
    const { ok, error } = result as { ok?: unknown; error?: unknown };
    if (ok === true || typeof error !== "string") return result;
    return { ...result, interrupted: true };
  };
  const isInterruptSend = (payload: unknown): boolean =>
    typeof payload === "object" && payload !== null
    && (payload as { interrupt?: unknown }).interrupt === true;

  ipcMain.handle(CHANNELS.chat.send, async (e, payload: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.send, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.send);
    // Abort inside the interrupt send so a separate round-trip cannot expire keyboard activation.
    let interrupted = false;
    if (isInterruptSend(payload)) {
      // Validate keyboard authority and payload before interrupting the running turn.
      const admitted = parseChatSendPayload(payload);
      if (admitted.ok && admitted.payload.inputOrigin === "user-keyboard") {
        await interruptActiveTurn(group);
        interrupted = true;
      }
    }
    try {
      const result = await group.commandPort.execute(DESKTOP_CONVERSATION_ACTOR, {
        kind: "message.send",
        payload,
      });
      return interrupted ? flagInterruptedRefusal(result) : result;
    } catch (error) {
      if (error instanceof Error && error.message === STREAMING_ACTIVE) {
        return { error: STREAMING_ACTIVE, ...(interrupted ? { interrupted: true } : {}) };
      }
      throw error;
    }
  });

  // Guide input queues for the next assistant-round boundary without interrupting the turn.
  ipcMain.handle(CHANNELS.chat.guide, async (e, input: string, chatGroupId?: unknown) => {
    const group = groupOf(e, chatGroupId, CHANNELS.chat.guide);
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.guide, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof input !== "string" || input.trim().length === 0) {
      return { ok: false, error: "empty-text" };
    }
    try {
      if (parseFileMentionReferences(input).length > 0) return { ok: false, error: "file-reference-while-running" };
    } catch {
      return { ok: false, error: "file-reference-invalid" };
    }
    // Guide text needs the same PII redaction as keyboard sends.
    const effective = sanitizeOutgoingInput(settingsService, group.buildSink(), input);
    const queueResult = group.loop.queueGuidance(effective);
    if (queueResult === "queued") {
      // Audit guide acceptance as a mutation, recording metadata without user text.
      const mode: ChatUtteranceMode = "guide";
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: group.loop.getSessionId(),
        type: "info",
        input: `chat:utterance:${mode}:queued:len=${effective.length}`,
      });
      return { ok: true };
    }
    return { ok: false, error: queueResult };
  });

  ipcMain.handle(CHANNELS.chat.abort, async (e, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.abort, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.abort);
    // Pause the goal on Stop so it cannot immediately revive; retain the goal for explicit resume.
    const goalSessionId = group.loop.getSessionId();
    const pausingGoal = deps.sessionGoalStore?.get(goalSessionId)?.status === "running";
    const admission = pausingGoal ? group.surfaceRuntime.activity.beginSessionTransitionAdmission() : null;
    // Latch Stop before asynchronous goal persistence; hold admission so goal revival cannot race the pause.
    group.surfaceRuntime.activity.abortActiveTurn();
    try {
      if (pausingGoal) await deps.sessionGoalStore!.pause(goalSessionId);
      await interruptActiveTurn(group);
      return { ok: true };
    } finally { admission?.release(); }
  });

  ipcMain.handle(CHANNELS.chat.listShellTasks, (e, chatGroupId: unknown, expectedSessionId: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.listShellTasks, e); return []; }
    const sessionId = groupOf(e, chatGroupId, CHANNELS.chat.listShellTasks).loop.getSessionId();
    return sessionId === expectedSessionId ? listShellTasks(sessionId) : [];
  });

  ipcMain.handle(CHANNELS.chat.controlShellTask, (e, chatGroupId: unknown, expectedSessionId: unknown, action: unknown, shellId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.controlShellTask, e); return UNAUTHORIZED_FRAME; }
    if ((action !== "background" && action !== "stop") ||
        (shellId !== undefined && (typeof shellId !== "string" || shellId.length === 0 || shellId.length > 128))) {
      return { ok: false, error: "invalid-shell-action" };
    }
    const sessionId = groupOf(e, chatGroupId, CHANNELS.chat.controlShellTask).loop.getSessionId();
    if (sessionId !== expectedSessionId) return { ok: false, error: "session-changed" };
    const result = controlShellTask(sessionId, action, shellId as string | undefined);
    auditLogger.log({ timestamp: new Date().toISOString(), sessionId, type: "info", input: JSON.stringify({ event: "shell_task_control", action, ok: result.ok }) });
    return result;
  });

  ipcMain.handle(CHANNELS.chat.new, async (e, rawProject?: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.new, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.new);
    const conversationLoop = group.loop;
    const mutation = group.turns.trackSessionMutation(async () => {
      const parsed = resolveChatNewProjectPayload(rawProject, defaultWorkspaceProject().projectRoot);
      const resolved = resolveAuthorizedWorkspaceProject(parsed.projectRoot, parsed.projectName);
      if (!resolved.authorized || !resolved.project) return PROJECT_NOT_ALLOWED;
      const { project } = resolved;
      await conversationLoop.newConversation("main", project);
      registerGroupApprovalOwner(group);
      // Persist project identity only for explicit selections; default-directory access is not a project label.
      if (!project.isDefault && (project.projectRoot || project.projectName)) {
        await memoryManager.saveSessionMetadata(conversationLoop.getSessionId(), {
          sessionKind: "main",
          ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
          ...(project.projectName ? { projectName: project.projectName } : {}),
        });
      }
      if (isPrimaryGroup(group)) await memoryManager.markMainActiveFresh();
      return { ok: true as const };
    });
    return mutation ?? { ok: false as const, error: STREAMING_ACTIVE };
  });
  ipcMain.handle(CHANNELS.chat.sessions, (e, opts?: { limit?: unknown; before?: unknown; beforeId?: unknown; after?: unknown; kind?: unknown; routineId?: unknown; projectRoot?: unknown }) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.sessions, e);
      return { current: conversationLoop.getSessionId(), sessions: [] };
    }
    return handleChatSessions(deps, opts);
  });

  ipcMain.handle(CHANNELS.chat.compact, (e, chatGroupId?: unknown, focus?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.compact, e); return UNAUTHORIZED_FRAME; }
    if (focus !== undefined && typeof focus !== "string") throw new Error("invalid compact focus");
    const group = groupOf(e, chatGroupId, CHANNELS.chat.compact);
    // Wire compact callbacks for slash-triggered compaction too; no stream id exists outside a turn.
    const mutation = group.turns.trackSessionMutation(async () => {
      const sink = group.buildSink();
      return group.loop.manualCompact({
        ...(typeof focus === "string" && focus.trim().length > 0 ? { focus: focus.trim() } : {}),
        onCompactStarted: ({ triggerSource, estimatedBefore, preflight }) =>
          sink({
            kind: "compaction.started",
            triggerSource,
            estimatedBefore,
            preflight,
          }),
        onCompactOccurred: ({ removedMessages, freedTokens, estimatedAfter, trigger, summary, compactNum, compactStatus, truncatedDir }) =>
          sink({
            kind: "compaction.completed",
            removedMessages,
            freedTokens,
            estimatedAfter,
            ...(trigger !== undefined ? { trigger } : {}),
            ...(compactNum !== undefined ? { compactNum } : {}),
            ...(compactStatus !== undefined ? { compactStatus } : {}),
            ownerDetail: {
              ...(summary === undefined ? {} : { summary }),
              ...(truncatedDir === undefined ? {} : { truncatedDir }),
            },
          }),
      });
    });
    return mutation ?? { error: STREAMING_ACTIVE };
  });

  ipcMain.handle(CHANNELS.chat.sessionResume, async (e, sessionId: string, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.sessionResume, e); return UNAUTHORIZED_FRAME; }
    if (!isValidSessionId(sessionId)) {
      return { ok: false, compacted: false, compactedAt: null, removedMessageCount: 0 };
    }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.sessionResume);
    const conversationLoop = group.loop;
    // Name the holding tile so the renderer can reveal a folded conversation.
    const holder = groupHolding(sessionId);
    if (holder && holder !== group) {
      return {
        ok: false, compacted: false, compactedAt: null, removedMessageCount: 0,
        error: SESSION_OPEN_IN_OTHER_GROUP,
        ...(holder.owner === ownerOf(e.sender) ? { holderChatGroupId: holder.rendererGroupId } : {}),
      };
    }
    const mutation = group.turns.trackSessionMutation(async () => {
      const result = await conversationLoop.resetAndResume(sessionId);
      if (result.ok) registerGroupApprovalOwner(group);
      if (result.ok && conversationLoop.getSessionKind() === "main" && isPrimaryGroup(group)) {
        await memoryManager.markMainActiveResume(sessionId).catch((err: unknown) => {
          log.warn("session-resume markMainActiveResume failed: %s", (err as Error).message);
        });
      }
      return result;
    });
    return mutation ?? {
      ok: false,
      compacted: false,
      compactedAt: null,
      removedMessageCount: 0,
      error: STREAMING_ACTIVE,
    };
  });
  ipcMain.handle(CHANNELS.chat.getHistory, (e, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.getHistory, e); return []; }
    if (!isNativeGroupFrame(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.getHistory, e); return []; }
    return handleChatGetHistory(groupOf(e, chatGroupId, CHANNELS.chat.getHistory).deps);
  });

  ipcMain.handle(CHANNELS.chat.mainActiveState, (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.mainActiveState, e);
      return null;
    }
    return memoryManager.loadMainActiveSessionState();
  });

  ipcMain.handle(CHANNELS.chat.sessionHistory, (e, sessionId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.sessionHistory, e);
      // Unauthorized history replies must retain messages and ok fields expected by callers.
      return { ok: false, messages: [], error: "unauthorized-frame" as const };
    }
    return handleChatSessionHistory(deps, sessionId);
  });

  ipcMain.handle(CHANNELS.chat.editResend, async (e, messageId: string, newText: string, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.editResend, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.editResend);
    const conversationLoop = group.loop;
    if (typeof messageId !== "string" || messageId.length === 0) return { ok: false, error: "invalid-message-id" };
    if (typeof newText !== "string" || newText.trim().length === 0) return { ok: false, error: "empty-text" };
    const turn = group.turns.tryStreamTurn(async (transport) => {
      // Publish the exclusive lease before reading or truncating replay history.
      const history = conversationLoop.getHistory().getMessages() as GenericMessage[];
      const historyIndex = historyIndexOfMessageId(history, messageId);
      if (historyIndex < 0) return { ok: false, error: "message-not-found" };
      const personaPromptId = personaPromptIdFromUserMessage(history[historyIndex]);
      if (!personaPromptId.ok) return { ok: false, error: personaPromptId.error };
      const messages = [...history];
      let replayEntered = false;
      try {
        transport.abortSignal?.throwIfAborted();
        const personaPrompt = await resolvePersonaRolePrompt(personaPromptStore, personaPromptId.personaPromptId);
        if (!personaPrompt.ok) return { ok: false, error: personaPrompt.error };
        // Resolve fresh selectors before history mutation under the same cancellable turn admission.
        const expanded = await expandFileMentionContext(conversationLoop, newText, "user-keyboard", [], transport.abortSignal);
        transport.abortSignal?.throwIfAborted();
        conversationLoop.getHistory().truncate(historyIndex);
        replayEntered = true;
        const result = await group.turns.runStreamTurn(transport, expanded.input, undefined, personaPrompt.rolePrompt, expanded.displayText);
        return { ok: true, result };
      } catch (err) {
        if (!replayEntered && transport.abortSignal?.aborted) {
          transport.sink({ kind: "turn.completed" });
          return { ok: true, result: { text: "", toolCalls: [], route: "default", stopReason: "interrupted" } };
        }
        // Restore history if provider-bound replay is refused before runTurn.
        if (isMissingStagedEnvelopeError(err)) {
          conversationLoop.getHistory().restore(messages);
        }
        throw err;
      }
    });
    return turn ?? { ok: false, error: STREAMING_ACTIVE };
  });

  ipcMain.handle(CHANNELS.chat.getTurnReview, async (e, expectedSessionId: unknown, chatGroupId?: unknown): Promise<TurnReviewResult> => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.getTurnReview, e); return { ok: false, error: "unauthorized-frame" }; }
    if (typeof expectedSessionId !== "string" || !isValidSessionId(expectedSessionId)) return { ok: false, error: "invalid-input" };
    const group = groupOf(e, chatGroupId, CHANNELS.chat.getTurnReview);
    const mutation = group.turns.trackSessionMutation(async (): Promise<TurnReviewResult> => {
      const loop = group.loop;
      if (expectedSessionId !== loop.getSessionId()) return { ok: false, error: "turn-review-stale" };
      const turnId = latestReviewTurnId(loop);
      if (!turnId) return { ok: false, error: "turn-review-unavailable" };
      return getTurnChangeReview(expectedSessionId, turnId, () => ({
        cwd: loop.getSessionExecutionCwd(), extraAllowedDirectories: loop.getTurnAdditionalDirectories(),
      }), { currentDetails: true });
    });
    return mutation ?? { ok: false, error: STREAMING_ACTIVE };
  });

  // Restore code before history mutation; code-only restore leaves history intact and rewind persists its own truncation.
  ipcMain.handle(CHANNELS.chat.rewindTo, async (e, messageId: string, chatGroupId?: unknown, mode: unknown = "conversation") => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.rewindTo, e); return UNAUTHORIZED_FRAME; }
    if (!isRewindMode(mode)) return { ok: false, error: "invalid-rewind-mode" };
    const group = groupOf(e, chatGroupId, CHANNELS.chat.rewindTo);
    const conversationLoop = group.loop;
    if (typeof messageId !== "string" || messageId.length === 0) return { ok: false, error: "invalid-message-id" };
    const mutation = group.turns.trackSessionMutation(async () => {
      const history = conversationLoop.getHistory().getMessages() as GenericMessage[];
      const historyIndex = historyIndexOfMessageId(history, messageId);
      if (historyIndex < 0) return { ok: false, error: "message-not-found" };
      const target = history[historyIndex];
      if (target.role !== "user") return { ok: false, error: "not-a-user-message" };
      // Resolve all composer input before truncation; refuse if it cannot be restored whole.
      const restorable = mode === "code" ? { ok: true as const, text: "" } : restorableRewindInput(target);
      if (!restorable.ok) return { ok: false, error: restorable.error };
      const personaPromptId = personaPromptIdFromUserMessage(target);
      if (!personaPromptId.ok) return { ok: false, error: personaPromptId.error };
      const sessionId = conversationLoop.getSessionId();
      if (mode !== "conversation") {
        const restored = await restoreCodeCheckpoint(sessionId, messageId, () => ({
          cwd: conversationLoop.getSessionExecutionCwd(),
          extraAllowedDirectories: conversationLoop.getTurnAdditionalDirectories(),
        }));
        if (!restored.ok) {
          auditLogger.log({ timestamp: new Date().toISOString(), type: "warn", sessionId, input: `code_checkpoint_refused:${messageId}:${mode}`, output: restored.error });
          return restored;
        }
        auditLogger.log({ timestamp: new Date().toISOString(), type: "info", sessionId, input: `code_checkpoint_restored:${messageId}:${mode}` });
        if (mode === "code") return { ok: true, text: "" };
      }
      // Prune boundaries discarded by this rewind, not those absent after earlier compactions.
      const discarded = history.slice(historyIndex);
      conversationLoop.getHistory().truncate(historyIndex);
      const remaining = conversationLoop.getHistory().getMessages() as GenericMessage[];
      // Drop discarded checkpoint sidecars before saving or load-time recovery may resurrect removed messages.
      await memoryManager.pruneCheckpointsDiscardedByRewind(sessionId, discarded);
      await memoryManager.saveSession(sessionId, remaining);
      return {
        ok: true,
        text: restorable.text,
        ...(personaPromptId.personaPromptId !== undefined
          ? { personaPromptId: personaPromptId.personaPromptId }
          : {}),
      };
    });
    return mutation ?? { ok: false, error: STREAMING_ACTIVE };
  });

  ipcMain.handle(CHANNELS.chat.fork, async (e, messageId: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.fork, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.fork);
    const conversationLoop = group.loop;
    const mutation = group.turns.trackSessionMutation(async () => {
      const current = conversationLoop.getHistory().getMessages() as GenericMessage[];
      let upto = current.length;
      // Omitted id branches the whole conversation; an unresolved explicit id must fail.
      if (typeof messageId === "string" && messageId.length > 0) {
        const historyIndex = historyIndexOfMessageId(current, messageId);
        if (historyIndex < 0) return { ok: false, sessionId: null, error: "message-not-found" };
        upto = Math.min(historyIndex + 1, current.length);
      }
      const sliced = current.slice(0, upto);
      // Repair tool-call/result pairing before writing the forked session.
      const { messages: slice, removedMessages, removedToolCalls } = normalizeToolPairInvariant(sliced);
      if (removedMessages > 0 || removedToolCalls > 0) {
        log.warn(
          `chat:fork repaired ${removedMessages} messages + ${removedToolCalls} tool calls from the forked slice`,
        );
      }
      if (current.length > 0) {
        await memoryManager.saveSession(conversationLoop.getSessionId(), current);
      }
      const newId = createDlpSafeUuid();
      const sourceSessionId = conversationLoop.getSessionId();
      const forkSlice = memoryManager.rehydrateToolResultArtifacts(sourceSessionId, slice) as GenericMessage[];
      await memoryManager.saveSession(newId, forkSlice);
      const currentMeta = memoryManager.loadSessionMetadata(sourceSessionId);
      await memoryManager.saveSessionMetadata(newId, {
        sessionKind: currentMeta?.sessionKind ?? conversationLoop.getSessionKind(),
        ...(currentMeta?.routineId ? { routineId: currentMeta.routineId } : {}),
        ...(currentMeta?.routineTitle ? { routineTitle: currentMeta.routineTitle } : {}),
        ...(currentMeta?.routineFiredAt ? { routineFiredAt: currentMeta.routineFiredAt } : {}),
        ...(currentMeta?.projectRoot ? { projectRoot: currentMeta.projectRoot } : {}),
        ...(currentMeta?.projectName ? { projectName: currentMeta.projectName } : {}),
        ...(currentMeta?.summaryPreamble ? { summaryPreamble: currentMeta.summaryPreamble } : {}),
      });
      const loaded = await conversationLoop.loadSession(newId);
      if (loaded) registerGroupApprovalOwner(group);
      if (loaded && conversationLoop.getSessionKind() === "main" && isPrimaryGroup(group)) {
        await memoryManager.markMainActiveResume(newId).catch((err: unknown) => {
          log.warn("chat:fork markMainActiveResume failed: %s", (err as Error).message);
        });
      }
      return { ok: loaded, sessionId: loaded ? newId : null };
    });
    return mutation ?? { ok: false, sessionId: null, error: STREAMING_ACTIVE };
  });
  ipcMain.handle(CHANNELS.chat.continueLastUser, async (e, payload: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.continueLastUser, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.continueLastUser);
    const p = payload as { sessionId?: unknown };
    if (typeof p?.sessionId !== "string") return { ok: false, error: "invalid-args" };
    if (p.sessionId !== group.loop.getSessionId()) return { ok: false, error: "session-mismatch" };
    return group.turns.continueFromLastUserTurn({ requireTerminalUser: true, restoreOnFailure: true }, p.sessionId);
  });

  ipcMain.handle(CHANNELS.chat.retryEffort, async (
    e,
    opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean },
    chatGroupId?: unknown,
  ) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.retryEffort, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.retryEffort);
    const turn = group.turns.tryStreamTurn(async (transport) => {
      const prevLlm = settingsService.get("llm");
      const provider = prevLlm.provider;
      const prevBlock = getLlmVendorSettings(prevLlm.vendors, provider);
      // Read settings before and after the patch through the same resolver.
      const currentVendorBaseUrlSig = () => llmRouteBaseUrlSignature(
        settingsService.get("llm"),
        settingsService.get("marketplace").installedProviderPresets,
      );
      const prevVendorBaseUrlSig = currentVendorBaseUrlSig();
      await settingsService.patch({
        llm: {
          vendors: {
            [provider]: {
              ...prevBlock,
              enableThinking: opts?.enableThinking ?? true,
              thinkingBudgetTokens: normalizeLlmThinkingBudgetTokens(
                opts?.thinkingBudgetTokens ?? getLlmThinkingBudgetLimit(prevBlock.outputTokenLimit),
                prevBlock.outputTokenLimit,
              ),
            },
          },
        },
      });
      // Only address changes require sandbox network refresh; spreading the prior block preserves its address.
      if (currentVendorBaseUrlSig() !== prevVendorBaseUrlSig) {
        void deps.refreshSandboxNetworkConfig?.();
      }
      group.loop.refreshProvider();
      try {
        return await group.turns.continueFromLastUserTurnWithinLease(
          { requireTerminalUser: false, restoreOnFailure: false },
          transport,
        );
      } finally {
        await settingsService.patch({
          llm: { vendors: { [provider]: prevBlock } },
        });
        // Restoring the same address must not refresh sandbox network configuration.
        if (currentVendorBaseUrlSig() !== prevVendorBaseUrlSig) {
          void deps.refreshSandboxNetworkConfig?.();
        }
        group.loop.refreshProvider();
      }
    });
    return turn ?? { ok: false, error: STREAMING_ACTIVE };
  });

  // Export the named session, never whichever conversation happens to be loaded.
  ipcMain.handle(CHANNELS.chat.export, async (
    e,
    format: "markdown" | "json",
    targetSessionId?: unknown,
  ) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.export, e); return UNAUTHORIZED_FRAME; }
    const { dialog } = await import("electron");
    const { writeFile } = await import("node:fs/promises");
    const win = mainWindowForContents(e.sender) ?? getMainWindow();
    if (format !== "markdown" && format !== "json") return { ok: false, error: "invalid-format" };
    const loadedSessionId = conversationLoop.getSessionId();
    let sessionId = loadedSessionId;
    let messages: GenericMessage[];
    if (typeof targetSessionId === "string" && targetSessionId !== loadedSessionId) {
      if (!isValidSessionId(targetSessionId)) return { ok: false, error: "invalid-session" };
      const stored = memoryManager.loadSession(targetSessionId);
      // A missing export target must fail instead of exporting another conversation under its name.
      if (!Array.isArray(stored)) return { ok: false, error: "not-found" };
      sessionId = targetSessionId;
      messages = stored as GenericMessage[];
    } else {
      messages = conversationLoop.getHistory().getMessages() as GenericMessage[];
    }
    if (messages.length === 0) return { ok: false, error: "empty" };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const defaultName = `ave-chat-${sessionId.slice(0, 8)}-${stamp}.${format === "markdown" ? "md" : "json"}`;
    const dialogOptions = {
      title: t("mainDialog.exportConversationTitle"),
      defaultPath: defaultName,
      filters: format === "markdown"
        ? [{ name: "Markdown", extensions: ["md"] }]
        : [{ name: "JSON", extensions: ["json"] }],
    };
    const res = win
      ? await dialog.showSaveDialog(win, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };

    let body: string;
    if (format === "json") {
      body = JSON.stringify({ sessionId, exportedAt: new Date().toISOString(), messages }, null, 2);
    } else {
      const exportedAt = new Date().toISOString();
      const lines: string[] = [t("be_chatDomain.exportHeading"), ``, t("be_chatDomain.exportSessionLine", { sessionId }), t("be_chatDomain.exportTimeLine", { exportedAt }), ``];
      for (const m of messages) {
        if (m.role === "user") {
          lines.push(`## User`, ``, userContentText(m.content), ``);
        } else if (m.role === "assistant") {
          lines.push(`## Assistant`, ``);
          if (m.thought) lines.push(`> _reasoning:_ ${m.thought.replace(/\n/g, " ")}`, ``);
          lines.push(m.content, ``);
          if (m.toolCalls && m.toolCalls.length > 0) {
            for (const tc of m.toolCalls) {
              lines.push(`### Tool call: \`${tc.name}\``, ``, "```json", JSON.stringify(tc.input, null, 2), "```", ``);
            }
          }
        } else if (m.role === "tool_result") {
          lines.push(`### Tool result${m.toolName ? `: \`${m.toolName}\`` : ""}${m.isError ? " (error)" : ""}`, ``, "```", m.content, "```", ``);
        }
      }
      body = lines.join("\n");
    }
    await writeFile(res.filePath, body, "utf-8");
    return { ok: true, filePath: res.filePath };
  });

  // Row edits share one channel so title, archive, and other row changes address the same conversation.
  ipcMain.handle(CHANNELS.chat.sessionUpdate, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.sessionUpdate, e); return UNAUTHORIZED_FRAME; }
    const raw = (payload ?? {}) as {
      sessionId?: unknown;
      title?: unknown;
      archived?: unknown;
      unread?: unknown;
    };
    if (!isValidSessionId(raw.sessionId)) return { ok: false, error: "invalid-session" };
    if (!memoryManager.hasSessionMetadataFile(raw.sessionId)
      && !Array.isArray(memoryManager.loadSession(raw.sessionId))) {
      return { ok: false, error: "not-found" };
    }
    const fields: { title?: string; archivedAt?: string | null; unreadSince?: string | null } = {};
    if (raw.title !== undefined) {
      if (typeof raw.title !== "string") return { ok: false, error: "invalid-title" };
      const title = raw.title.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ").trim();
      // Reject empty titles; otherwise derived-title fallback silently discards the rename.
      if (!title) return { ok: false, error: "empty-title" };
      fields.title = title;
    }
    const now = new Date().toISOString();
    if (raw.archived !== undefined) {
      if (typeof raw.archived !== "boolean") return { ok: false, error: "invalid-archived" };
      // Keep Suggestions unarchived while staged cards address it.
      if (raw.archived && isSuggestionsSession(raw.sessionId)) {
        return { ok: false, error: "suggestions-not-archivable" };
      }
      fields.archivedAt = raw.archived ? now : null;
    }
    if (raw.unread !== undefined) {
      if (typeof raw.unread !== "boolean") return { ok: false, error: "invalid-unread" };
      fields.unreadSince = raw.unread ? now : null;
    }
    if (Object.keys(fields).length === 0) return { ok: false, error: "no-fields" };
    await memoryManager.updateSessionRowFields(raw.sessionId, fields);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.chat.sessionDelete, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.sessionDelete, e); return UNAUTHORIZED_FRAME; }
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
    if (!isValidSessionId(sessionId)) return { ok: false, error: "invalid-session" };
    // Confirm in main so callers cannot bypass a renderer-only dialog.
    const { dialog } = await import("electron");
    const win = mainWindowForContents(e.sender) ?? getMainWindow();
    const confirmOptions = {
      type: "warning" as const,
      buttons: [t("mainDialog.cancelButton"), t("mainDialog.deleteConversationConfirm")],
      defaultId: 0,
      cancelId: 0,
      message: t("mainDialog.deleteConversationMessage"),
      detail: t("mainDialog.deleteConversationDetail"),
    };
    const confirmation = win
      ? await dialog.showMessageBox(win, confirmOptions)
      : await dialog.showMessageBox(confirmOptions);
    if (confirmation.response !== 1) return { ok: false, canceled: true };

    // Guard deletion only against the loop holding that conversation; unrelated sessions need no turn lease.
    const deleteConversation = async (): Promise<void> => {
      await memoryManager.deleteSession(sessionId);
      // Its "This session" rules, approvals and network hosts end with it.
      const { endSessionScopedPermissions } = await import("../../permissions/session-scope-end.js");
      endSessionScopedPermissions(sessionId, conversationLoop.permissionManager);
      if (isSuggestionsSession(sessionId)) ensureSuggestionsSession(memoryManager);
    };
    const holder = groupHolding(sessionId);
    if (!holder) {
      await deleteConversation();
      return { ok: true, wasLoaded: false };
    }
    const mutation = holder.turns.trackSessionMutation(async () => {
      await deleteConversation();
      return { ok: true as const, wasLoaded: true };
    });
    return (await mutation) ?? { ok: false, error: STREAMING_ACTIVE };
  });

  // Import is internal and always creates a fresh DLP-safe session id.
  ipcMain.handle(CHANNELS.chat.import, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.import, e); return UNAUTHORIZED_FRAME; }
    const { dialog } = await import("electron");
    const { open } = await import("node:fs/promises");
    const win = mainWindowForContents(e.sender) ?? getMainWindow();
    const dialogOptions = {
      title: t("mainDialog.importConversationTitle"),
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"] as Array<"openFile">,
    };
    const res = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
    const filePath = res.filePaths[0];

    // Size-check and read through the same file handle to prevent path-swap races.
    let text: string;
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fileHandle = await open(filePath, "r");
      const stats = await fileHandle.stat();
      // Reject oversized session files before reading or parsing.
      if (stats.size > MAX_SESSION_FILE_BYTES) {
        return { ok: false, error: "file-too-large" };
      }
      text = await fileHandle.readFile("utf-8");
    } catch {
      return { ok: false, error: "file-not-found" };
    } finally {
      await fileHandle?.close().catch(() => {});
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: "invalid-json" };
    }

    const validated = validateImportedSessionJson(raw);
    if (!validated.ok) {
      return { ok: false, error: validated.error ?? "invalid-file-shape" };
    }

    const newSessionId = createDlpSafeUuid();
    await memoryManager.saveImportedSession(newSessionId, validated.messages);
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: newSessionId,
      type: "info",
      input: `chat:import:sessionId=${newSessionId}:messageCount=${validated.messages.length}`,
    });
    return { ok: true, sessionId: newSessionId, messageCount: validated.messages.length };
  });

  ipcMain.handle(CHANNELS.chat.enterCheckpointView, (e, payload: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.enterCheckpointView, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.enterCheckpointView);
    const p = payload as { sessionId?: unknown; compactNum?: unknown };
    if (typeof p?.sessionId !== "string" || !Number.isSafeInteger(p?.compactNum) || (p.compactNum as number) < 0) {
      return { error: "invalid-args" };
    }
    if (p.sessionId !== group.loop.getSessionId()) {
      return { error: "session-mismatch" };
    }
    const result = group.loop.enterViewMode(p.compactNum as number);
    if (!result) return { error: "checkpoint-not-found" };
    return result;
  });

  ipcMain.handle(CHANNELS.chat.exitCheckpointView, (e, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.exitCheckpointView, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.exitCheckpointView);
    group.loop.exitViewMode();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.chat.branchFromCheckpoint, async (e, payload: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.branchFromCheckpoint, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(e, chatGroupId, CHANNELS.chat.branchFromCheckpoint);
    const p = payload as { sessionId?: unknown; compactNum?: unknown };
    if (typeof p?.sessionId !== "string" || !Number.isSafeInteger(p?.compactNum) || (p.compactNum as number) < 0) {
      return { error: "invalid-args" };
    }
    if (p.sessionId !== group.loop.getSessionId()) {
      return { error: "session-mismatch" };
    }
    const mutation = group.turns.trackSessionMutation(async () =>
      group.loop.branchFromCheckpoint(p.compactNum as number));
    if (!mutation) return { error: STREAMING_ACTIVE };
    try {
      return await mutation;
    } catch (err) {
      return { error: (err as Error).message };
    }
  });
  ipcMain.handle(CHANNELS.memory.entriesList, (e, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesList, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.listMemoryEntries(project.options);
  });
  ipcMain.handle(CHANNELS.memory.candidatesList, (e, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.candidatesList, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.listMemoryCandidates(project.options);
  });
  ipcMain.handle(CHANNELS.memory.entriesSave, async (e, title: string, content: string, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesSave, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return PROJECT_NOT_ALLOWED;
    if (!memoryCaptureService) {
      throw new Error("memory-reviewer-unavailable");
    }
    try {
      const result = await memoryCaptureService.captureExplicit({
        title,
        content,
        ...project.options,
      });
      if (result.status === "skipped") {
        throw new Error("memory-review-not-saved");
      }
      return result.entry;
    } catch {
      // Never fall back to a raw renderer-provided memory write.
      throw new Error("memory-review-not-saved");
    }
  });
  ipcMain.handle(CHANNELS.memory.entriesDelete, async (e, filename: unknown, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesDelete, e); return UNAUTHORIZED_FRAME; }
    if (typeof filename !== "string") return { ok: false, error: "invalid-input" };
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return PROJECT_NOT_ALLOWED;
    try {
      await memoryManager.deleteMemory(filename, project.options);
      return { ok: true };
    } catch {
      // Do not disclose a path, title, or another project's memory scope to the renderer.
      return { ok: false, error: "write-failed" };
    }
  });
  ipcMain.handle(CHANNELS.memory.candidateActivate, async (e, raw: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.candidateActivate, e); return UNAUTHORIZED_FRAME; }
    const candidate = parseMemoryCandidateActionPayload(raw);
    if (!candidate.ok) return { ok: false, error: "invalid-input" };
    const project = parseMemoryProjectOptions(candidate.options);
    if (!project.ok) return PROJECT_NOT_ALLOWED;
    try {
      const entry = await memoryManager.activateMemoryCandidate(candidate.id, project.options);
      return { ok: true, entry };
    } catch (error) {
      return candidateMemoryActionFailure(error);
    }
  });
  ipcMain.handle(CHANNELS.memory.candidateDelete, async (e, raw: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.candidateDelete, e); return UNAUTHORIZED_FRAME; }
    const candidate = parseMemoryCandidateActionPayload(raw);
    if (!candidate.ok) return { ok: false, error: "invalid-input" };
    const project = parseMemoryProjectOptions(candidate.options);
    if (!project.ok) return PROJECT_NOT_ALLOWED;
    try {
      await memoryManager.deleteMemoryCandidate(candidate.id, project.options);
      return { ok: true };
    } catch (error) {
      return candidateMemoryActionFailure(error);
    }
  });
  ipcMain.handle(CHANNELS.memory.entriesSearch, (e, query: string, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesSearch, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.searchMemoryEntries(query, project.options).map((note) => ({
      filename: note.filename,
      title: note.title,
      content: note.content,
      excerpt: note.content.replace(/^#\s+.+(?:\r?\n)+/, "").trim(),
      updatedAt: note.updatedAt ?? new Date().toISOString(),
      ...(note.projectRoot ? { projectRoot: note.projectRoot } : {}),
      ...(note.projectName ? { projectName: note.projectName } : {}),
    }));
  });
  ipcMain.handle(CHANNELS.memory.indexGet, (e, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.indexGet, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return "";
    return memoryManager.getMemoryIndex(project.options);
  });
  ipcMain.handle(CHANNELS.memory.indexUpdateIfUnchanged, async (e, expectedContent: string, nextContent: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.indexUpdateIfUnchanged, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateMemoryIndexIfUnchanged(expectedContent, nextContent);
  });
  ipcMain.handle(CHANNELS.memory.indexSectionsUpdate, async (e, sections: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.indexSectionsUpdate, e); return UNAUTHORIZED_FRAME; }
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
      return { ok: false, error: "invalid-memory-sections" };
    }
    const candidate = sections as { urgentMemory?: unknown; references?: unknown };
    if (
      (candidate.urgentMemory !== undefined && typeof candidate.urgentMemory !== "string") ||
      (candidate.references !== undefined && typeof candidate.references !== "string")
    ) {
      return { ok: false, error: "invalid-memory-sections" };
    }
    await memoryManager.updateMemoryIndexSections({
      ...(candidate.urgentMemory !== undefined ? { urgentMemory: candidate.urgentMemory } : {}),
      ...(candidate.references !== undefined ? { references: candidate.references } : {}),
    });
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.memory.sessionsList, (e, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.sessionsList, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.listSessionEntries(50, project.options);
  });
  ipcMain.handle(CHANNELS.memory.sessionsSearch, (e, query: string, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.sessionsSearch, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.searchSessions(query, project.options);
  });
  ipcMain.handle(CHANNELS.memory.agentsMdGet, (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.agentsMdGet, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.getAgentsMd();
  });
  ipcMain.handle(CHANNELS.memory.agentsMdUpdate, async (e, content: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.agentsMdUpdate, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateAgentsMd(content);
  });
  ipcMain.handle(CHANNELS.memory.userPrefsGet, (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.userPrefsGet, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.getUserPreferences();
  });
  ipcMain.handle(CHANNELS.memory.userPrefsUpdate, async (e, content: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.userPrefsUpdate, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateUserPreferences(content);
  });
  ipcMain.handle(CHANNELS.memory.userPrefsRefresh, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.userPrefsRefresh, e); return UNAUTHORIZED_FRAME; }
    if (!preferenceRefreshService) {
      return { ok: false, error: "preference-refresh-service-unavailable" };
    }
    try {
      const result = await preferenceRefreshService.refresh({ reason: "manual" });
      return {
        ok: true,
        content: result.content,
        refreshedAt: result.refreshedAt,
        sources: result.sources,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.memory.longTermRefresh, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.memory.longTermRefresh, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!memoryConsolidationService) {
      return { ok: false, error: "memory-consolidation-service-unavailable" };
    }
    try {
      // The default workspace is unscoped global context; never create a project overview for it.
      const project = conversationLoop.getSessionProjectIsDefault?.()
        ? undefined
        : conversationLoop.getSessionMemoryProjectContext?.();
      const result = await memoryConsolidationService.refresh({
        reason: "manual",
        ...(project ? { project } : {}),
      });
      return { ok: true, ...result };
    } catch (error) {
      // Keep provider and source failures host-only; renderer replies use stable envelopes.
      log.warn("manual long-term memory consolidation failed: %s", errorMessage(error));
      return { ok: false, error: "memory-consolidation-failed" };
    }
  });

  ipcMain.handle(CHANNELS.starred.list, () => {
    if (!starredStore) return [];
    return starredStore.list();
  });
  ipcMain.handle(CHANNELS.starred.add, (e, entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.starred.add, e); return UNAUTHORIZED_FRAME; }
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (typeof entry?.messageIndex !== "number" || entry.messageIndex < -1) return { ok: false, error: "invalid-index" };
    if (typeof entry?.text !== "string") return { ok: false, error: "invalid-text" };
    const sessionId = entry.sessionId ?? conversationLoop.getSessionId();
    const record = starredStore.add({ sessionId, messageIndex: entry.messageIndex, role: entry.role, text: entry.text });
    return { ok: true, entry: record };
  });
  ipcMain.handle(CHANNELS.starred.remove, (e, opts: { id?: string; sessionId?: string; messageIndex?: number }) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.starred.remove, e); return UNAUTHORIZED_FRAME; }
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (opts?.id) return { ok: starredStore.remove(opts.id) };
    if (opts?.sessionId && typeof opts.messageIndex === "number") {
      return { ok: starredStore.removeBySessionAndIndex(opts.sessionId, opts.messageIndex) };
    }
    return { ok: false, error: "invalid-args" };
  });

  ipcMain.handle(CHANNELS.feedback.submit, async (e, payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.feedback.submit, e); return UNAUTHORIZED_FRAME; }
    const { sessionId, messageIndex, rating, reason } = payload ?? {};
    if (
      typeof sessionId !== "string" ||
      typeof messageIndex !== "number" ||
      messageIndex < 0 ||
      (rating !== "up" && rating !== "down")
    ) {
      return { ok: false, error: "invalid-args" };
    }
    if (feedbackStore) {
      feedbackStore.add({ sessionId, messageIndex, rating, ...(reason !== undefined ? { reason } : {}) });
    }
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId,
      type: "warn",
      input: `feedback:${rating}:${sessionId}:${messageIndex}`,
    });
    if (rating === "up" && starredStore) {
      const existing = starredStore.list().find(
        (s) => s.sessionId === sessionId && s.messageIndex === messageIndex,
      );
      if (!existing) {
        starredStore.add({ sessionId, messageIndex, role: "assistant", text: "" });
      }
    }
    return { ok: true };
  });

  // Lazy verbatim results exist only in the active session; session switching must not read stale content.
  ipcMain.handle(
    CHANNELS.chat.getVerbatimToolResult,
    (e, { sessionId, toolUseId }: { sessionId: string; toolUseId: string }, chatGroupId?: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.chat.getVerbatimToolResult, e);
        return null;
      }
      const group = groupOf(e, chatGroupId, CHANNELS.chat.getVerbatimToolResult);
      if (sessionId !== group.loop.getSessionId()) return null;
      const messages = group.loop.getHistory().getMessages() as GenericMessage[];
      const msg = messages.find(
        (m): m is Extract<GenericMessage, { role: "tool_result" }> =>
          m.role === "tool_result" && m.toolUseId === toolUseId,
      );
      if (!msg) return null;
      const content = msg.content;
      if (typeof content !== "string") return null;
      const artifact = isToolResultStubContent(content) && !msg.meta?.artifactUnavailable
        ? memoryManager.loadToolResultArtifact(sessionId, toolUseId)
        : null;
      if (!artifact && msg.meta?.compactedAt === undefined && msg.meta?.truncated === undefined) return null;
      if (msg.meta?.serializedStub === true && isToolResultStubContent(content) && !artifact) return null;
      const verbatim = artifact?.content ?? content;
      let lineCount = 1;
      for (let i = 0; i < verbatim.length; i++) {
        if (verbatim.charCodeAt(i) === 10) lineCount++;
      }
      return { content: verbatim, lineCount };
    },
  );

  // Resolve child transcript handles from isolated storage; never expose host paths.
  ipcMain.handle(
    CHANNELS.chat.getSubAgentTranscript,
    (e, payload: unknown, chatGroupId?: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.chat.getSubAgentTranscript, e);
        return { ok: false, error: "unauthorized-frame" };
      }
      const group = groupOf(e, chatGroupId, CHANNELS.chat.getSubAgentTranscript);
      const p = (payload ?? {}) as Record<string, unknown>;
      const originSessionId = typeof p.originSessionId === "string" && isValidSessionId(p.originSessionId)
        ? p.originSessionId
        : "";
      if (!originSessionId) return { ok: false, error: "invalid-origin-session-id" };
      if (originSessionId !== group.loop.getSessionId()) {
        return { ok: false, error: "origin-session-not-active" };
      }
      const runner = deps.getSubAgentRunner?.();
      if (!runner) return { ok: false, error: "sub-agent-runner-unavailable" };
      const childSessionId = typeof p.childSessionId === "string" && isValidSessionId(p.childSessionId)
        ? p.childSessionId
        : undefined;
      if (!childSessionId) return { ok: false, error: "invalid-child-session-id" };
      const messages = memoryManager.rehydrateToolResultArtifacts(
        originSessionId,
        group.loop.getHistory().getMessages(),
      ) as GenericMessage[];
      // Prove ownership from the parent's reference or the child's host-written originSessionId.
      const ownedByOrigin = runner.isPersistedSpawnOfOrigin?.(originSessionId, childSessionId) === true;
      if (!ownedByOrigin && !hasParentSubAgentReference(messages, childSessionId)) {
        return { ok: false, error: "sub-agent-reference-not-found" };
      }
      return runner.getPersistedTranscript({
        originSessionId,
        childSessionId,
      });
    },
  );

  // Load oversized write diffs from the sidecar instead of truncated tool content.
  ipcMain.handle(
    CHANNELS.chat.getWriteDiff,
    async (e, payload: unknown): Promise<{ before: string; after: string } | null> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.chat.getWriteDiff, e);
        return null;
      }
      const p = (payload ?? {}) as Record<string, unknown>;
      const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
      const toolUseId = typeof p.toolUseId === "string" ? p.toolUseId : "";
      if (!sessionId || !toolUseId || !isSafeId(sessionId) || !isSafeId(toolUseId)) {
        return null;
      }
      return readDiffSidecar(sessionId, toolUseId);
    },
  );

  // Reload pending questions only into the window holding their session.
  ipcMain.handle(CHANNELS.askUserQuestion.pending, (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.askUserQuestion.pending, e);
      return UNAUTHORIZED_FRAME;
    }
    return askUserQuestionGate ? askUserQuestionGate.listPending(e.sender) : [];
  });

  ipcMain.handle(CHANNELS.askUserQuestion.respond, (e, response: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.askUserQuestion.respond, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!askUserQuestionGate) {
      return { ok: false, error: "ask-user-question gate not configured" };
    }
    const r = (response ?? {}) as Record<string, unknown>;
    const requestId = typeof r.requestId === "string" ? r.requestId : "";
    if (!requestId) return { ok: false, error: "invalid-request-id" };
    const rawAnswers = Array.isArray(r.answers) ? (r.answers as unknown[]) : null;
    const answers = rawAnswers
      ? rawAnswers.map((entry) => {
          const a = (entry ?? {}) as Record<string, unknown>;
          const multiRaw = Array.isArray(a.choices) ? (a.choices as unknown[]) : null;
          const choices = multiRaw
            ? multiRaw.filter((c): c is string => typeof c === "string" && c.length > 0)
            : undefined;
          return {
            choice: typeof a.choice === "string" ? a.choice : undefined,
            choices: choices && choices.length > 0 ? choices : undefined,
            // Validate shape here; the gate owns answer type and length for its recorded request.
            freeText: typeof a.freeText === "string" ? a.freeText : undefined,
          };
        })
      : undefined;
    const accepted = askUserQuestionGate.resolve({
      requestId,
      answers,
      dismissed: r.dismissed === true,
    });
    return accepted ? { ok: true } : { ok: false, error: "invalid-answer" };
  });
}
