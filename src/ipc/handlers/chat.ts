// Shared chat handlers remain transport-independent; wrappers own sender and gesture validation.
import { MAIN_CHAT_GROUP_ID } from "../../contract/app-contract.js";
import type { ChatInputOrigin, ChatSendPayload, RemoteControllerAuthority } from "../../shared/chat-origin.js";
import {
  isChatSendInputOrigin,
  isRemoteControllerAuthorityCurrent,
  isUserKeyboardOrigin,
  mintUserKeyboardIntent,
} from "../../shared/chat-origin.js";
import { normalizeLocalUserContentParts } from "../../main/subscription-attachment-input.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import { PERSONA_PROMPT_ID_ALLOWLIST } from "../../main/persona-prompt-store.js";
import { redactForLLM } from "../../audit/dlp-filter.js";
import type { GenericMessage, UserContentPart } from "../../engine/llm/types.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import type { TurnResult } from "../../engine/conversation-loop.js";
import type { ParentMailboxEntry } from "../../engine/subagent-message-mailbox.js";
import { wrapChildReportForParentJudgment } from "../../engine/a2a-subagent-message-codec.js";
import { parseStagedEnvelope, stagedOriginForInput } from "../../shared/staged-origins.js";
import {
  isSessionFamily,
  isSessionListKindFilter,
  SESSION_LIST_MAX_LIMIT,
  type SessionFamily,
  type SessionListRow,
} from "../../shared/session-lookup.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import {
  isValidSessionId,
  MAX_PROJECT_NAME_CHARS,
  MAX_PROJECT_ROOT_CHARS,
  sessionFamilyOf,
  toSessionListRow,
  type SessionKind,
} from "../../memory/memory-manager.js";
import { resolveAuthorizedWorkspaceProject } from "../../main/project-root-authorization.js";
import { projectRootEquals } from "../../shared/project-identity.js";
import { isDefaultWorkspaceRoot } from "../../main/default-workspace-root.js";
import { expandFileMentionContext } from "./file-mention-context.js";
import {
  runStreamedTurn,
  type ConversationStreamEventSink,
} from "./chat-stream.js";

const log = createLogger("chat");

const ACKNOWLEDGING_STOP_REASON = "end_turn";

export interface ParentMailboxTurn {
  parentSessionId: string;
  entryIds: string[];
  initialGuidance: string;
  approvalReasonPrefix: string;
  childTitle?: string;
}

interface ParentMailboxRunner {
  // Snapshot also acknowledges reports already consumed through agent_status so they cannot be injected twice.
  peekParentMailbox(parentSessionId: string): Promise<ParentMailboxEntry[]>;
  acknowledgeParentMailbox(parentSessionId: string, entryIds: readonly string[]): Promise<unknown>;
}

function getParentMailboxRunner(deps: IpcDeps): ParentMailboxRunner | undefined {
  const runner = deps.getSubAgentRunner?.() as Partial<ParentMailboxRunner> | undefined;
  return runner
    && typeof runner.peekParentMailbox === "function"
    && typeof runner.acknowledgeParentMailbox === "function"
    ? runner as ParentMailboxRunner
    : undefined;
}

function mailboxApprovalPrefix(entries: readonly ParentMailboxEntry[]): string {
  const labels = [...new Set(entries.map((entry) => entry.approvalLabel))];
  return labels.length === 1 ? labels[0]! : "[Sub-Agent: multiple sources]";
}

// Snapshot without switching sessions; durable entries remain until the receiving turn acknowledges them.
export async function prepareParentMailboxTurn(deps: IpcDeps): Promise<ParentMailboxTurn | null> {
  const { conversationLoop } = deps;
  if (conversationLoop.getSessionKind() !== "main") return null;
  const parentSessionId = conversationLoop.getSessionId();
  const runner = getParentMailboxRunner(deps);
  if (!runner) return null;

  let entries: ParentMailboxEntry[];
  try {
    entries = await runner.peekParentMailbox(parentSessionId);
  } catch (err) {
    deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: parentSessionId,
      type: "error",
      input: `subagent-mailbox-peek-failed:${(err as Error).message}`,
    });
    return null;
  }
  if (
    entries.length === 0
    || conversationLoop.getSessionKind() !== "main"
    || conversationLoop.getSessionId() !== parentSessionId
  ) {
    return null;
  }

  const childTitles = [...new Set(entries.map((entry) => entry.childTitle))];
  const singleChildTitle = childTitles.length === 1
    && typeof childTitles[0] === "string"
    && childTitles[0].length > 0
    ? childTitles[0]
    : undefined;
  return {
    parentSessionId,
    entryIds: entries.map((entry) => entry.id),
    // Wrap reports at consumption, never persistence, so each path adds one host instruction.
    initialGuidance: wrapChildReportForParentJudgment(
      entries.map((entry) => entry.formattedText).join("\n\n"),
    ),
    approvalReasonPrefix: mailboxApprovalPrefix(entries),
    ...(singleChildTitle !== undefined ? { childTitle: singleChildTitle } : {}),
  };
}

export async function acknowledgeParentMailboxAfterTurn(
  deps: IpcDeps,
  mailboxTurn: ParentMailboxTurn | null,
  result: TurnResult,
): Promise<void> {
  if (
    !mailboxTurn
    || result.route === "command"
    || result.stopReason !== ACKNOWLEDGING_STOP_REASON
  ) return;
  if (deps.conversationLoop.getSessionId() !== mailboxTurn.parentSessionId) return;
  const runner = getParentMailboxRunner(deps);
  if (!runner) return;
  try {
    await runner.acknowledgeParentMailbox(mailboxTurn.parentSessionId, mailboxTurn.entryIds);
  } catch (err) {
    deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: mailboxTurn.parentSessionId,
      type: "error",
      input: `subagent-mailbox-ack-failed:${(err as Error).message}`,
    });
  }
}

export interface ChatSessionProjectPayload {
  projectRoot?: string;
  projectName?: string;
}

function normalizeProjectString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxChars) : undefined;
}

export function parseChatSessionProjectPayload(raw: unknown): ChatSessionProjectPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const projectRoot = normalizeProjectString(record.projectRoot, MAX_PROJECT_ROOT_CHARS);
  const projectName = normalizeProjectString(record.projectName, MAX_PROJECT_NAME_CHARS);
  return {
    ...(projectRoot ? { projectRoot } : {}),
    ...(projectName ? { projectName } : {}),
  };
}

export function defaultWorkspaceProjectPayload(defaultWorkspaceRoot = process.cwd()): ChatSessionProjectPayload {
  const projectRoot = normalizeProjectString(defaultWorkspaceRoot, MAX_PROJECT_ROOT_CHARS);
  // Resolve default-project identity centrally so ambient workspace names cannot leak into project labels.
  return {
    ...(projectRoot ? { projectRoot } : {}),
    projectName: "default",
  };
}

export function resolveChatNewProjectPayload(raw: unknown, defaultWorkspaceRoot = process.cwd()): ChatSessionProjectPayload {
  const parsed = parseChatSessionProjectPayload(raw);
  if (parsed.projectRoot) return parsed;
  return defaultWorkspaceProjectPayload(defaultWorkspaceRoot);
}

function normalizePersonaPromptId(
  inputOrigin: ChatInputOrigin,
  value: unknown,
): { ok: true; personaPromptId?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (inputOrigin !== "user-keyboard") {
    return { ok: false, error: "persona-prompt-origin-restricted" };
  }
  if (typeof value !== "string") return { ok: false, error: "invalid-persona-prompt-id" };
  const id = value.trim();
  if (!PERSONA_PROMPT_ID_ALLOWLIST.test(id) || id === "default") {
    return { ok: false, error: "invalid-persona-prompt-id" };
  }
  return { ok: true, personaPromptId: id };
}

export function personaPromptIdFromUserMessage(
  message: GenericMessage | undefined,
): { ok: true; personaPromptId?: string } | { ok: false; error: string } {
  if (!message || message.role !== "user") return { ok: true };
  const value = message.meta?.activePersonaPrompt;
  if (value === undefined || value === null) return { ok: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid-persona-prompt-id" };
  }
  return normalizePersonaPromptId("user-keyboard", (value as { id?: unknown }).id);
}

export async function resolvePersonaRolePrompt(
  personaPromptStore: IpcDeps["personaPromptStore"],
  personaPromptId: string | undefined,
): Promise<{ ok: true; rolePrompt?: ActiveRolePrompt } | { ok: false; error: string }> {
  if (!personaPromptId) return { ok: true };
  if (!personaPromptStore) return { ok: false, error: "persona-prompt-not-found" };
  try {
    const prompt = await personaPromptStore.get(personaPromptId);
    if (!prompt) return { ok: false, error: "persona-prompt-not-found" };
    return {
      ok: true,
      rolePrompt: {
        id: prompt.id,
        name: prompt.name,
        systemPromptAdd: prompt.systemPromptAdd,
        ...(prompt.origin ? { origin: prompt.origin } : {}),
      },
    };
  } catch {
    return { ok: false, error: "invalid-persona-prompt-id" };
  }
}

// Validate and normalize untrusted multipart IPC entries before provider mapping.
export function validateUserContentParts(
  raw: unknown,
): import("../../engine/llm/types.js").UserContentPart[] | undefined {
  return normalizeLocalUserContentParts(raw);
}

export function parseChatSendPayload(
  payload: unknown,
): { ok: true; payload: ChatSendPayload } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "invalid-payload" };
  }
  const candidate = payload as {
    input?: unknown;
    attachments?: unknown;
    inputOrigin?: unknown;
    userActivation?: unknown;
    personaPromptId?: unknown;
  };
  if (typeof candidate.input !== "string") {
    return { ok: false, error: "invalid-input" };
  }
  if (!isChatSendInputOrigin(candidate.inputOrigin)) {
    return { ok: false, error: "missing-input-origin" };
  }
  if (candidate.inputOrigin === "user-keyboard" && candidate.userActivation !== true) {
    return { ok: false, error: "user-keyboard-required" };
  }
  // Bind every claimed staged origin to its canonical envelope before execution.
  const stagedKind = stagedOriginForInput(candidate.inputOrigin);
  if (stagedKind) {
    const enveloped = candidate.input.trimStart().match(stagedKind.envelopePrefixPattern);
    if (!enveloped) {
      return { ok: false, error: stagedKind.missingEnvelopeError };
    }
  } else {
    // Reject staged envelopes claiming keyboard origin or their force-ask and untrusted framing would disappear.
    if (parseStagedEnvelope(candidate.input)) {
      // Use a distinct unexpected-envelope code; user-pasted provenance headers are not missing envelopes.
      return { ok: false, error: "origin-envelope-mismatch" };
    }
  }
  const personaPrompt = normalizePersonaPromptId(candidate.inputOrigin, candidate.personaPromptId);
  if (!personaPrompt.ok) return { ok: false, error: personaPrompt.error };
  return {
    ok: true,
    payload: {
      input: candidate.input,
      attachments: candidate.attachments,
      inputOrigin: candidate.inputOrigin,
      ...(candidate.userActivation === true ? { userActivation: true } : {}),
      ...(personaPrompt.personaPromptId ? { personaPromptId: personaPrompt.personaPromptId } : {}),
    },
  };
}

export interface SanitizedOutgoingTurnContent {
  input: string;
  attachments: UserContentPart[] | undefined;
}

// Redact input and text attachments as separate DLP spans immediately before provider work.
export function sanitizeOutgoingTurnContent(
  settingsService: IpcDeps["settingsService"],
  sink: ConversationStreamEventSink,
  input: string,
  attachments: UserContentPart[] | undefined,
): SanitizedOutgoingTurnContent {
  const privacy = settingsService.get("privacy");
  if (!privacy?.piiRedactEnabled) return { input, attachments };

  let effectiveInput = input;
  let effectiveAttachments = attachments;
  let totalCount = 0;
  const counts: Record<string, number> = {};
  const addResult = (result: ReturnType<typeof redactForLLM>) => {
    totalCount += result.totalCount;
    for (const [kind, count] of Object.entries(result.counts)) {
      counts[kind] = (counts[kind] ?? 0) + count;
    }
  };

  const inputResult = redactForLLM(input);
  addResult(inputResult);
  if (inputResult.totalCount > 0) effectiveInput = inputResult.redacted;

  if (attachments) {
    for (let index = 0; index < attachments.length; index += 1) {
      const part = attachments[index]!;
      if (part.type !== "text") continue;
      const result = redactForLLM(part.text);
      addResult(result);
      if (result.totalCount === 0) continue;
      const redactedAttachments =
        effectiveAttachments === attachments
          ? [...attachments]
          : effectiveAttachments ?? [...attachments];
      redactedAttachments[index] = { ...part, text: result.redacted };
      effectiveAttachments = redactedAttachments;
    }
  }

  if (totalCount > 0) {
    // Audit hit counts per span but emit one turn-level notice without raw text or resource URIs.
    sink({
      kind: "privacy.redacted",
      count: totalCount,
      byKind: counts,
    });
    log.warn({ counts }, `outgoing turn content redacted — count=${totalCount}`);
  }

  return { input: effectiveInput, attachments: effectiveAttachments };
}

export function sanitizeOutgoingInput(
  settingsService: IpcDeps["settingsService"],
  sink: ConversationStreamEventSink,
  input: string,
): string {
  return sanitizeOutgoingTurnContent(settingsService, sink, input, undefined).input;
}

export async function markMainActiveAfterTurn(
  deps: IpcDeps,
  input: string,
  inputOrigin: ChatInputOrigin,
): Promise<void> {
  const { conversationLoop, memoryManager } = deps;
  if (conversationLoop.getSessionKind() !== "main") return;
  // Only the primary tile updates next-launch resume state; other tiles must not overwrite it.
  if (deps.chatGroupId !== undefined && deps.chatGroupId !== MAIN_CHAT_GROUP_ID) return;
  if (conversationLoop.getHistory().length > 0) {
    // Default-directory sessions retain null project fields; only explicit selections persist project metadata.
    const isDefaultProject = conversationLoop.getSessionProjectIsDefault();
    if (!isDefaultProject) {
      const project = typeof conversationLoop.getSessionProjectContext === "function"
        ? conversationLoop.getSessionProjectContext()
        : {
            projectRoot: typeof conversationLoop.getSessionProjectRoot === "function" ? conversationLoop.getSessionProjectRoot() ?? undefined : undefined,
            projectName: typeof conversationLoop.getSessionProjectName === "function" ? conversationLoop.getSessionProjectName() ?? undefined : undefined,
          };
      if (project.projectRoot || project.projectName) {
        const existing = memoryManager.loadSessionMetadata(conversationLoop.getSessionId()) ?? {};
        await memoryManager.saveSessionMetadata(conversationLoop.getSessionId(), {
          ...existing,
          sessionKind: "main",
          ...project,
        });
      }
    }
    await memoryManager.markMainActiveResume(conversationLoop.getSessionId());
    return;
  }
  if (input.trim() === "/new" && isUserKeyboardOrigin(inputOrigin)) {
    await memoryManager.markMainActiveFresh();
  }
}

export interface ChatSendContext {
  createStreamEventSink: (streamId: number) => ConversationStreamEventSink;
  allocateStreamId: () => number;
  trackStreamTurn: (factory: (signal?: AbortSignal) => Promise<ChatSendResult>) => Promise<ChatSendResult>;
  /** Host-owned remote-controller authority; external payloads cannot supply it. */
  remoteControllerAuthority?: RemoteControllerAuthority;
  /** Host-owned cancellation from admission and, when present, the public-turn owner. */
  abortSignal?: AbortSignal;
}

export type ChatSendResult = TurnResult | { ok: false; error: string };

export async function handleChatSend(
  deps: IpcDeps,
  payload: unknown,
  ctx: ChatSendContext,
): Promise<ChatSendResult> {
  const { conversationLoop, settingsService, auditLogger, personaPromptStore } = deps;
  if (!isRemoteControllerAuthorityCurrent(ctx.remoteControllerAuthority)) {
    return { ok: false, error: "remote-controller-revoked" };
  }
  const expectedSessionId = conversationLoop.getSessionId();
  const parsed = parseChatSendPayload(payload);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { input, attachments, inputOrigin, userActivation, personaPromptId } = parsed.payload;
  const validated = validateUserContentParts(attachments);
  const streamId = ctx.allocateStreamId();
  const sink = ctx.createStreamEventSink(streamId);
  return ctx.trackStreamTurn(async (admissionSignal) => {
    const abortSignal = admissionSignal && ctx.abortSignal
      ? AbortSignal.any([admissionSignal, ctx.abortSignal]) : admissionSignal ?? ctx.abortSignal;
    let turnEntered = false;
    try {
      abortSignal?.throwIfAborted();
      const personaPrompt = await resolvePersonaRolePrompt(personaPromptStore, personaPromptId);
      abortSignal?.throwIfAborted();
      // Recheck remote authority after asynchronous persona resolution; revocation may race it.
      if (!isRemoteControllerAuthorityCurrent(ctx.remoteControllerAuthority)) {
        return { ok: false, error: "remote-controller-revoked" };
      }
      if (conversationLoop.getSessionId() !== expectedSessionId) {
        return { ok: false, error: "session-mismatch" };
      }
      if (!personaPrompt.ok) return { ok: false, error: personaPrompt.error };
      // Automatic queue intake has no live keyboard gesture; audit it separately from keyboard sends.
      if (inputOrigin === "queue-auto") {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: conversationLoop.getSessionId(),
          type: "info",
          input: `chat:utterance:queue-auto:start:len=${input.length}`,
        });
      }
      abortSignal?.throwIfAborted();
      // Check revoked remote authority inside the lease's deferred effect-entry factory.
      if (!isRemoteControllerAuthorityCurrent(ctx.remoteControllerAuthority)) {
        return { ok: false, error: "remote-controller-revoked" };
      }
      // Snapshot the mailbox under the receiving turn's lease so session mutation cannot switch its owner.
      const mailboxTurn = inputOrigin === "user-keyboard" || inputOrigin === "queue-auto"
        ? await prepareParentMailboxTurn(deps)
        : null;
      if (!isRemoteControllerAuthorityCurrent(ctx.remoteControllerAuthority)) {
        return { ok: false, error: "remote-controller-revoked" };
      }
      // Redact only under an accepted lease; refused overlapping sends must not create DLP records or notices.
      const expanded = await expandFileMentionContext(conversationLoop, input, inputOrigin, validated, abortSignal);
      abortSignal?.throwIfAborted();
      if (!isRemoteControllerAuthorityCurrent(ctx.remoteControllerAuthority)) {
        return { ok: false, error: "remote-controller-revoked" };
      }
      const sanitized = sanitizeOutgoingTurnContent(settingsService, sink, expanded.input, validated);
      const displayText = expanded.displayText === undefined ? undefined
        : sanitizeOutgoingInput(settingsService, sink, expanded.displayText);
      // No await may separate the last authority check from the model effect.
      if (!isRemoteControllerAuthorityCurrent(ctx.remoteControllerAuthority)) {
        return { ok: false, error: "remote-controller-revoked" };
      }
      abortSignal?.throwIfAborted();
      turnEntered = true;
      const result = await runStreamedTurn(
        conversationLoop,
        sanitized.input,
        sink,
        {
          attachments: sanitized.attachments,
          inputOrigin,
          // Desktop sends only: the payload's userActivation is preload's report of a consumed gesture token (parse refuses a
          // user-keyboard payload without it); main mints the turn's one verified intent from it.
          ...(inputOrigin === "user-keyboard" ? { userKeyboardIntent: mintUserKeyboardIntent({ inputOrigin, userActivation }) } : {}),
          ...(displayText === undefined ? {} : { displayText }),
          ...((inputOrigin === "user-keyboard" && userActivation === true || ctx.remoteControllerAuthority !== undefined)
            ? { requestAnchorRawIntent: input }
            : {}),
          ...(personaPrompt.rolePrompt ? { rolePrompt: personaPrompt.rolePrompt } : {}),
          ...(mailboxTurn
            ? {
                initialGuidance: mailboxTurn.initialGuidance,
                approvalReasonPrefix: mailboxTurn.approvalReasonPrefix,
                subAgentReport: mailboxTurn.childTitle === undefined
                  ? {}
                  : { title: mailboxTurn.childTitle },
              }
            : {}),
          ...(ctx.remoteControllerAuthority
            ? { remoteControllerAuthority: ctx.remoteControllerAuthority }
            : {}),
          ...(abortSignal === undefined ? {} : { abortSignal }),
        },
      );
      await acknowledgeParentMailboxAfterTurn(deps, mailboxTurn, result);
      await markMainActiveAfterTurn(deps, sanitized.input, inputOrigin);
      return result;
    } catch (error) {
      if (turnEntered || !abortSignal?.aborted) throw error;
      sink({ kind: "turn.completed" });
      return { text: "", toolCalls: [], route: "default", stopReason: "interrupted" };
    }
  });
}

// Omitted families preserves main-store filtering; explicit families request cross-store federation.
function requestedSessionFamilies(raw: unknown): ReadonlySet<SessionFamily> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const families = new Set<SessionFamily>();
  for (const value of raw) {
    if (isSessionFamily(value)) families.add(value);
  }
  return families.size > 0 ? families : undefined;
}

// Federate requested conversation families across their owning stores with one shared pagination contract.
export async function handleChatSessions(
  deps: IpcDeps,
  opts?: { limit?: unknown; before?: unknown; beforeId?: unknown; after?: unknown; kind?: unknown; routineId?: unknown; projectRoot?: unknown; families?: unknown },
) {
  const { conversationLoop, memoryManager } = deps;
  const limit = typeof opts?.limit === "number" && Number.isFinite(opts.limit)
    ? Math.max(1, Math.min(SESSION_LIST_MAX_LIMIT, Math.floor(opts.limit)))
    : 20;
  const beforeTime = typeof opts?.before === "string" ? Date.parse(opts.before) : Number.NaN;
  const before = Number.isNaN(beforeTime) ? undefined : new Date(beforeTime);
  const afterTime = typeof opts?.after === "string" ? Date.parse(opts.after) : Number.NaN;
  const after = Number.isNaN(afterTime) ? undefined : new Date(afterTime);
  const beforeId = isValidSessionId(opts?.beforeId)
    ? opts.beforeId
    : undefined;
  const kind = isSessionListKindFilter(opts?.kind) ? opts.kind : "main";
  const families = requestedSessionFamilies(opts?.families);
  const routineId = typeof opts?.routineId === "string" ? opts.routineId : undefined;
  const requestedProjectRoot = normalizeProjectString(opts?.projectRoot, MAX_PROJECT_ROOT_CHARS);
  const resolvedProject = requestedProjectRoot ? resolveAuthorizedWorkspaceProject(requestedProjectRoot) : undefined;
  const projectRoot = resolvedProject
    ? resolvedProject.authorized && resolvedProject.project
      ? resolvedProject.project.projectRoot
      : "__ave_unauthorized_project_root__"
    : undefined;
  const includeUnscoped = resolvedProject?.authorized === true && resolvedProject.project?.isDefault === true;
  const sessions = memoryManager
    .listSessionsPage({ kind: families ? "all" : kind, ...(routineId ? { routineId } : {}), ...(projectRoot ? { projectRoot } : {}), ...(includeUnscoped ? { includeUnscoped: true } : {}), limit, ...(before ? { before } : {}), ...(beforeId ? { beforeId } : {}), ...(after ? { after } : {}) })
    .flatMap((s): SessionListRow[] => {
      // Strip legacy default-project tags at the read boundary so they cannot become named sidebar projects.
      const isLegacyDefaultTagged = Boolean(s.projectRoot) && isDefaultWorkspaceRoot(s.projectRoot!);
      const row = toSessionListRow(
        "main",
        isLegacyDefaultTagged ? { ...s, projectRoot: undefined, projectName: undefined } : s,
      );
      if (row === null) return [];
      if (families && !families.has(row.family)) return [];
      return [row];
    });
  if (!families) {
    return { current: conversationLoop.getSessionId(), sessions };
  }
  const pageWindow = { limit, before, beforeId, after, projectRoot, includeUnscoped };
  const federated = [
    ...sessions,
    ...(families.has("work-board") ? await workBoardRunRows(deps, pageWindow) : []),
    ...(families.has("side-chat") ? sideChatRows(deps, pageWindow) : []),
  ]
    .sort((a, b) => {
      const delta = b.modifiedAt.localeCompare(a.modifiedAt);
      return delta !== 0 ? delta : b.id.localeCompare(a.id);
    })
    .slice(0, limit);
  return { current: conversationLoop.getSessionId(), sessions: federated };
}

async function workBoardRunRows(
  deps: IpcDeps,
  window: {
    limit: number;
    before?: Date;
    beforeId?: string;
    after?: Date;
    projectRoot?: string;
    includeUnscoped: boolean;
  },
): Promise<SessionListRow[]> {
  const runner = deps.getSubAgentRunner?.();
  const store = deps.workBoardStore;
  if (!runner || !store) return [];
  const runs = runner.listWorkBoardRunSessions({
    limit: window.limit,
    ...(window.before ? { before: window.before } : {}),
    ...(window.beforeId ? { beforeId: window.beforeId } : {}),
    ...(window.after ? { after: window.after } : {}),
  });
  const seen = new Set<number>();
  const rows: SessionListRow[] = [];
  for (const run of runs) {
    const itemId = run.workBoardItemId;
    if (itemId === undefined || seen.has(itemId)) continue;
    seen.add(itemId);
    const family = sessionFamilyOf("subagent", run);
    if (family === null) continue;
    const found = await store.get(itemId);
    if (found.status !== "found") continue;
    const item = found.item;
    if (
      window.projectRoot !== undefined &&
      !projectRootEquals(item.projectRoot, window.projectRoot) &&
      !(window.includeUnscoped && item.projectRoot === undefined)
    ) continue;
    rows.push({
      id: run.id,
      modifiedAt: run.modifiedAt.toISOString(),
      title: item.title,
      ...(run.preview ? { preview: run.preview.slice(0, 200) } : {}),
      sessionKind: run.sessionKind,
      family,
      workBoardItemId: itemId,
      ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
      ...(item.projectName ? { projectName: item.projectName } : {}),
    });
  }
  return rows;
}

// Read side chats from their own store and use host-written originSessionId for parent grouping.
function sideChatRows(
  deps: IpcDeps,
  window: { limit: number; before?: Date; beforeId?: string; after?: Date },
): SessionListRow[] {
  const manager = deps.sideChatMemoryManager;
  if (!manager) return [];
  return manager
    .listSessionsPage({
      kind: "all",
      limit: window.limit,
      ...(window.before ? { before: window.before } : {}),
      ...(window.beforeId ? { beforeId: window.beforeId } : {}),
      ...(window.after ? { after: window.after } : {}),
    })
    .flatMap((s): SessionListRow[] => {
      const row = toSessionListRow("side-chat", s);
      return row === null ? [] : [row];
    });
}

// Read child sessions through the runner's namespace; the main session directory holds none.
function restoredSubAgentRows(deps: IpcDeps, originSessionId: string) {
  const runner = deps.getSubAgentRunner?.() as
    | { listPersistedSpawnsForOrigin?: (id: string) => Array<{ modifiedAt: Date }> }
    | undefined;
  if (typeof runner?.listPersistedSpawnsForOrigin !== "function") return [];
  return runner
    .listPersistedSpawnsForOrigin(originSessionId)
    .map((entry) => ({ ...entry, modifiedAt: entry.modifiedAt.toISOString() }));
}

export function handleChatGetHistory(deps: IpcDeps) {
  const { conversationLoop, memoryManager } = deps;
  const messages = conversationLoop.getHistory().getMessages() as GenericMessage[];
  const currentListEntry = memoryManager
    .listSessions({ kind: "all", limit: Number.POSITIVE_INFINITY })
    .find((session) => session.id === conversationLoop.getSessionId());
  return {
    sessionId: conversationLoop.getSessionId(),
    sessionTitle: currentListEntry?.title,
    sessionKind: conversationLoop.getSessionKind(),
    ...(conversationLoop.getSessionRoutineId() ? { routineId: conversationLoop.getSessionRoutineId() } : {}),
    ...(conversationLoop.getSessionRoutineTitle() ? { routineTitle: conversationLoop.getSessionRoutineTitle() } : {}),
    ...(conversationLoop.getSessionProjectRoot() ? { projectRoot: conversationLoop.getSessionProjectRoot() } : {}),
    ...(conversationLoop.getSessionProjectName() ? { projectName: conversationLoop.getSessionProjectName() } : {}),
    // Live bindings include the default workspace even when persisted explicit-project metadata is absent.
    ...(conversationLoop.getSessionProjectIsDefault() ? { projectIsDefault: true } : {}),
    // Startup history must restore sub-agent rows because the prior process's live events are gone.
    restoredSubAgents: restoredSubAgentRows(deps, conversationLoop.getSessionId()),
    messages: messages.map(serializeHistoryMessage),
  };
}

// Session-history previews may read non-active sessions without switching them; missing sessions return the stable empty shape.
export function handleChatSessionHistory(deps: IpcDeps, sessionId: string) {
  const { memoryManager } = deps;
  if (!isValidSessionId(sessionId)) {
    return { ok: false, messages: [] };
  }
  // Catch session I/O and parse failures so corrupted files do not reject renderer IPC.
  let loaded: unknown;
  try {
    loaded = memoryManager.loadSession(sessionId);
  } catch {
    return { ok: false, messages: [] };
  }
  if (!Array.isArray(loaded)) return { ok: false, messages: [] };
  const raw = loaded.filter(
    (m): m is GenericMessage =>
      m != null && typeof m === "object" && "role" in m && "content" in m,
  );
  // Return resume-preamble length only; its system-prompt text must not enter chat history.
  let preambleChars = 0;
  let sessionKind: SessionKind = "main";
  let sessionTitle: string | undefined;
  let routineId: string | undefined;
  let routineTitle: string | undefined;
  let routineFiredAt: string | undefined;
  let projectRoot: string | undefined;
  let projectName: string | undefined;
  try {
    const meta = memoryManager.loadSessionMetadata(sessionId);
    if (meta) {
      sessionKind = meta.sessionKind ?? "main";
      sessionTitle = meta.title;
      routineId = meta.routineId;
      routineTitle = meta.routineTitle;
      routineFiredAt = meta.routineFiredAt;
      projectRoot = meta.projectRoot;
      projectName = meta.projectName;
      preambleChars = typeof meta.summaryPreamble === "string" ? meta.summaryPreamble.length : 0;
    }
  } catch {
  }
  if (!sessionTitle) {
    sessionTitle = memoryManager
      .listSessions({ kind: "all", limit: Number.POSITIVE_INFINITY })
      .find((session) => session.id === sessionId)?.title;
  }
  return {
    ok: true,
    sessionKind,
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(routineId ? { routineId } : {}),
    ...(routineTitle ? { routineTitle } : {}),
    ...(routineFiredAt ? { routineFiredAt } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(projectName ? { projectName } : {}),
    // Rebuild child rows from disk during history load; live spawn events do not survive restart.
    restoredSubAgents: restoredSubAgentRows(deps, sessionId),
    messages: raw.map(serializeHistoryMessage),
    preambleChars,
  };
}
