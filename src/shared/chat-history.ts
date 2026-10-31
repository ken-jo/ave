import type { GenericMessage, MessageMeta } from "../engine/llm/types.js";
import { userContentText } from "../engine/llm/types.js";
import { isPiiRedactionEnabled, maskSensitiveData } from "./dlp.js";
import { isStagedTurnSource } from "./staged-origins.js";
import {
  normalizeProviderToolAliasName,
  normalizeProviderToolAliasText,
} from "./tool-name-aliases.js";
import type { ToolCategory, ToolSource } from "./permission-review-status.js";

type SerializedHistoryToolCall = {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  source?: ToolSource;
  category?: ToolCategory;
  pluginId?: string;
  mcpServerId?: string;
};

/** Persist turn-final aggregates so renderer reload can reconstruct summaries without rerunning the loop. */
type SerializedTurnSummary = NonNullable<MessageMeta["turnSummary"]>;

/** Checkpoint metrics carried on the compactBoundary user message. */
type SerializedCheckpointMeta = NonNullable<MessageMeta["checkpointMeta"]>;
/** Sub-agent report provenance carried on an injected child-delivery message. */
type SerializedSubAgentReportMeta = NonNullable<MessageMeta["subAgentReport"]>;
type SerializedImportedTriggerMeta = NonNullable<MessageMeta["importedTrigger"]>;
type SerializedToolDisplayMeta = {
  durationMs?: number;
  /** Replay cancellation distinctly from failure so stopped calls keep their halt badge. */
  cancelled?: boolean;
};
type SerializedPermissionReviewMeta = NonNullable<MessageMeta["permissionReview"]>;

// Flatten multimodal display text at IPC while preserving assistant/tool structure for reconstruction.
export type SerializedHistoryMessage = {
  index: number;
  /** Use durable row ids so compaction cannot retarget stale positional actions. */
  messageId?: string;
  role: "user" | "assistant" | "tool_result";
  content: string;
  thought?: string;
  toolCalls?: SerializedHistoryToolCall[];
  toolUseId?: string;
  toolName?: string;
  isError?: boolean;
  /** Wall-clock epoch ms when the message was created (see MessageMeta.createdAt). */
  createdAt?: number;
  /** User-visible text when durable content carries routing/provenance wrappers. */
  displayText?: string;
  /** Proactive/plugin imported-trigger provenance for card replay. */
  importedTrigger?: SerializedImportedTriggerMeta;
  toolDisplay?: SerializedToolDisplayMeta;
  /** Permission review verdict for this tool call — tool_result rows only. */
  permissionReview?: SerializedPermissionReviewMeta;
  /** Turn-aggregate stats — only on turn-final assistant messages. */
  turnSummary?: SerializedTurnSummary;
  /** Checkpoint metrics — only on compactBoundary user messages. */
  checkpointMeta?: SerializedCheckpointMeta;
  /** Sub-agent report provenance — only on injected child-delivery messages. */
  subAgentReport?: SerializedSubAgentReportMeta;
  /** Host notification assistant rows render with destructive styling. */
  systemNotice?: NonNullable<MessageMeta["systemNotice"]>;
  /** User aborted the turn mid-stream; rendered as a badge, never as prose. */
  interrupted?: boolean;
  /** The interruption was the app exiting mid-turn, not the user's Stop. */
  interruptedBy?: "host-exit";
};

export function serializeHistoryMessage(
  m: GenericMessage,
  index: number,
): SerializedHistoryMessage {
  const content =
    m.role === "user"
      ? userContentText(m.content)
      : m.role === "tool_result"
        ? normalizeProviderToolAliasText(
            // Mask renderer history under the same live privacy setting; retain raw results on the machine channel.
            maskSensitiveData(m.content, { pii: isPiiRedactionEnabled() }).masked,
          )
        : normalizeProviderToolAliasText(m.content);
  const meta = m.meta as MessageMeta | undefined;
  const toolDisplay = serializeToolDisplay(meta?.toolDisplay);
  const importedTrigger = serializeImportedTrigger(meta?.importedTrigger);
  const systemNotice = serializeSystemNotice(meta?.systemNotice);
  const displayText = typeof meta?.displayText === "string" ? meta.displayText : undefined;
  const createdAt =
    typeof meta?.createdAt === "number" && Number.isFinite(meta.createdAt)
      ? meta.createdAt
      : undefined;
  const metaFields = {
    ...(typeof meta?.messageId === "string" ? { messageId: meta.messageId } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(displayText !== undefined ? { displayText } : {}),
    ...(importedTrigger !== undefined ? { importedTrigger } : {}),
    ...(toolDisplay !== undefined ? { toolDisplay } : {}),
    ...(m.meta?.turnSummary !== undefined ? { turnSummary: m.meta.turnSummary } : {}),
    ...(m.meta?.checkpointMeta !== undefined ? { checkpointMeta: m.meta.checkpointMeta } : {}),
    ...(meta?.subAgentReport !== undefined ? { subAgentReport: meta.subAgentReport } : {}),
    ...(systemNotice !== undefined ? { systemNotice } : {}),
    ...(meta?.interrupted === true ? { interrupted: true } : {}),
    ...(meta?.interrupted === true && meta.interruptedBy === "host-exit"
      ? { interruptedBy: "host-exit" as const }
      : {}),
  };
  const base = {
    index,
    role: m.role,
    // Use export/search placeholders for user multimodal content while retaining assistant/tool structure.
    content,
    ...metaFields,
  };

  if (m.role === "assistant") {
    return {
      ...base,
      ...(m.thought !== undefined
        ? { thought: normalizeProviderToolAliasText(m.thought) }
        : {}),
      ...(m.toolCalls !== undefined
        ? {
            toolCalls: m.toolCalls.map((toolCall) => ({
              ...toolCall,
              name: normalizeProviderToolAliasName(toolCall.name),
            })),
          }
        : {}),
    };
  }

  if (m.role === "tool_result") {
    const permissionReview = serializePermissionReview(meta?.permissionReview);
    return {
      ...base,
      toolUseId: m.toolUseId,
      ...(m.toolName !== undefined
        ? { toolName: normalizeProviderToolAliasName(m.toolName) }
        : {}),
      ...(m.isError !== undefined ? { isError: m.isError } : {}),
      ...(permissionReview !== undefined ? { permissionReview } : {}),
    };
  }

  return base;
}

function serializeImportedTrigger(
  importedTrigger: MessageMeta["importedTrigger"] | undefined,
): SerializedImportedTriggerMeta | undefined {
  if (!importedTrigger) return undefined;
  // Persist only registered staged-origin tags so writable transcripts cannot invent provenance.
  if (!isStagedTurnSource(importedTrigger.source)) return undefined;
  if (
    typeof importedTrigger.sessionId !== "string" ||
    typeof importedTrigger.prompt !== "string" ||
    typeof importedTrigger.summary !== "string" ||
    typeof importedTrigger.importedAt !== "string" ||
    typeof importedTrigger.toolCallCount !== "number" ||
    !Number.isInteger(importedTrigger.toolCallCount) ||
    importedTrigger.toolCallCount < 0
  ) {
    return undefined;
  }
  return {
    sessionId: importedTrigger.sessionId,
    source: importedTrigger.source,
    prompt: importedTrigger.prompt,
    summary: importedTrigger.summary,
    toolCallCount: importedTrigger.toolCallCount,
    importedAt: importedTrigger.importedAt,
  };
}

function serializeToolDisplay(
  toolDisplay: MessageMeta["toolDisplay"] | undefined,
): SerializedToolDisplayMeta | undefined {
  if (!toolDisplay) return undefined;
  // Replay inert metadata only; writable transcripts must not mount UI resources or trigger IPC.
  const durationMs =
    typeof toolDisplay.durationMs === "number" &&
    Number.isFinite(toolDisplay.durationMs) &&
    toolDisplay.durationMs >= 0
      ? toolDisplay.durationMs
      : undefined;
  // Cancellation selects only a badge, so it is safe to replay from writable transcripts.
  const cancelled = toolDisplay.cancelled === true ? true : undefined;
  if (durationMs !== undefined || cancelled !== undefined) {
    return {
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(cancelled !== undefined ? { cancelled } : {}),
    };
  }
  return undefined;
}

function serializePermissionReview(
  permissionReview: MessageMeta["permissionReview"] | undefined,
): SerializedPermissionReviewMeta | undefined {
  if (!permissionReview) return undefined;
  // Replay only current permission outcomes; labels grant no authority or audit provenance.
  if (
    permissionReview.status !== "reviewing" &&
    permissionReview.status !== "needs_approval" &&
    permissionReview.status !== "auto_approved" &&
    permissionReview.status !== "failed"
  ) {
    return undefined;
  }
  const verdictLevel =
    permissionReview.verdictLevel === "low" ||
    permissionReview.verdictLevel === "medium" ||
    permissionReview.verdictLevel === "high"
      ? permissionReview.verdictLevel
      : undefined;
  const reason =
    typeof permissionReview.reason === "string"
      ? maskSensitiveData(permissionReview.reason).masked
      : undefined;
  return {
    status: permissionReview.status,
    ...(verdictLevel !== undefined ? { verdictLevel } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

function serializeSystemNotice(
  systemNotice: MessageMeta["systemNotice"] | undefined,
): NonNullable<MessageMeta["systemNotice"]> | undefined {
  return systemNotice === "context-error" ||
    systemNotice === "stream-error" ||
    systemNotice === "interrupted"
    ? systemNotice
    : undefined;
}
