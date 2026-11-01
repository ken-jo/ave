// Drive semantic turn events without transport-specific channel knowledge.
import type {
  PlatformConversationEvent,
  PlatformConversationEventSink,
} from "../../engine/conversation-platform-protocol.js";
import { deriveTurnFailureSummary } from "../../engine/turn-failure-summary.js";
import type { ChatInputOrigin, RemoteControllerAuthority, VerifiedUserKeyboardIntent } from "../../shared/chat-origin.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type { ConversationLoop, TurnResult } from "../../engine/conversation-loop.js";
import type { UserContentPart } from "../../engine/llm/types.js";
import { createDlpSafeUuid } from "../../shared/dlp-safe-id.js";
import {
  authorizationRequiredStateForOutput,
  type UnattendedTurnAuthority,
} from "../../shared/authorization-required.js";
import { parseStagedEnvelope, stagedOriginForInput } from "../../shared/staged-origins.js";
import {
  countResourceAttachmentFences,
  MCP_RESOURCE_ATTACHMENTS_PER_TURN,
} from "../../shared/mcp-resource-bounds.js";
import {
  createStreamingFilter,
  stripSuggestedReplies,
} from "../../engine/suggested-replies.js";

export type ConversationStreamEventSink = PlatformConversationEventSink;

export async function runStreamedTurn(
  conversationLoop: ConversationLoop,
  input: string,
  sink: ConversationStreamEventSink,
  options: {
    attachments?: UserContentPart[];
    inputOrigin: ChatInputOrigin;
    /** Main's verified keyboard intent for this exact send; required for a user-keyboard turn and never defaulted. */
    userKeyboardIntent?: VerifiedUserKeyboardIntent;
    /** DLP-before-send keyboard text used only to mint a host RequestAnchor. */
    requestAnchorRawIntent?: string;
    rolePrompt?: ActiveRolePrompt;
    initialGuidance?: string;
    subAgentReport?: { title?: string };
    approvalReasonPrefix?: string;
    /** Host-owned remote-controller authority, never parsed from chat input. */
    remoteControllerAuthority?: RemoteControllerAuthority;
    /** Host-issued unattended lane for a windowless one-shot turn; never from chat input. */
    unattendedAuthority?: UnattendedTurnAuthority;
    displayText?: string;
    resumesInterruptedTurn?: true;
    // Host-started turns have no echoed bubble; surfaces must draw the announced input row.
    hostSubmitted?: true;
    abortSignal?: AbortSignal;
    maxRounds?: number;
  },
): Promise<TurnResult> {
  // Mint row identity before timeline emission and pass that same id into history persistence.
  const userMessageId = createDlpSafeUuid();
  if (options.abortSignal?.aborted) {
    throw new Error("turn-cancelled-before-start");
  }
  const send = (event: PlatformConversationEvent) => sink(event);
  // Staged envelopes carry provenance, not authority; send and replay must bind them to a host-minted origin.
  const claimedKind = stagedOriginForInput(options.inputOrigin);
  const envelope = claimedKind ? parseStagedEnvelope(input) : null;
  // Fail closed on unreadable staged envelopes, including headers rewritten by outgoing DLP.
  if (claimedKind && !envelope) {
    throw new Error(claimedKind.missingEnvelopeError);
  }
  // Enforce resource bounds at shared turn entry because main and side-chat sends parse independently.
  if (countResourceAttachmentFences(options.attachments) > MCP_RESOURCE_ATTACHMENTS_PER_TURN) {
    throw new Error("too-many-resource-attachments");
  }
  const inputOrigin = envelope?.kind.inputOrigin ?? options.inputOrigin;
  const originSource = envelope?.source ?? null;
  // Withhold possible trailing suggestion tags until parsing completes; see docs/architecture/proposals/suggested-replies-ghost-text.md.
  const suggestedRepliesFilter = createStreamingFilter();
  send({ kind: "turn.started" });
  // Announce input once after turn.started with host-resolved origin for every surface.
  send({
    kind: "user.message",
    origin: inputOrigin,
    ownerDetail: {
      text: options.displayText ?? input,
      messageId: userMessageId,
      ...(options.hostSubmitted ? { hostSubmitted: options.hostSubmitted } : {}),
    },
  });
  const result = await conversationLoop.runTurn(
    input,
    {
      onReasoningDelta: (text) => send({
        kind: "assistant.reasoning.delta",
        ownerDetail: { text },
      }),
      onTextDelta: (text) => {
        const visible = suggestedRepliesFilter.feed(text);
        if (visible) send({ kind: "assistant.text.delta", text: visible });
      },
      onAssistantRound: ({ roundIndex, text, thought, stopReason, hasToolCalls, messageId }) =>
        send({
          kind: "assistant.round.completed",
          round: {
            roundIndex,
            text: stripSuggestedReplies(text),
            stopReason,
            hasToolCalls,
            ownerDetail: { thought, messageId },
          },
        }),
      onToolStart: (name, toolInput, meta) =>
        send({
          kind: "tool.started",
          tool: {
            name,
            groupId: meta.groupId,
            toolUseId: meta.toolUseId,
            displayOrder: meta.displayOrder,
            ...(meta.source === undefined ? {} : { source: meta.source }),
            ...(meta.category === undefined ? {} : { category: meta.category }),
            ...(meta.pluginId === undefined ? {} : { pluginId: meta.pluginId }),
            ...(meta.mcpServerId === undefined ? {} : { mcpServerId: meta.mcpServerId }),
          },
          ownerDetail: { input: toolInput },
        }),
      onToolOutput: (name, text, meta) =>
        send({
          kind: "tool.output.delta",
          tool: {
            name,
            groupId: meta.groupId,
            toolUseId: meta.toolUseId,
            displayOrder: meta.displayOrder,
            ...(meta.source === undefined ? {} : { source: meta.source }),
            ...(meta.category === undefined ? {} : { category: meta.category }),
            ...(meta.pluginId === undefined ? {} : { pluginId: meta.pluginId }),
            ...(meta.mcpServerId === undefined ? {} : { mcpServerId: meta.mcpServerId }),
          },
          ownerDetail: { text },
        }),
      onPermissionReview: (event) =>
        send({
          kind: "permission.reviewed",
          review: {
            status: event.status,
            tool: {
              name: event.toolName,
              groupId: event.groupId,
              toolUseId: event.toolUseId,
              displayOrder: event.displayOrder,
              ...(event.source === undefined ? {} : { source: event.source }),
              ...(event.toolCategory === undefined ? {} : { category: event.toolCategory }),
            },
            ...(event.verdictLevel === undefined ? {} : { verdictLevel: event.verdictLevel }),
            ownerDetail: {
              ...(event.reason === undefined ? {} : { reason: event.reason }),
              ...(event.approvalPurpose === undefined
                ? {}
                : { approvalPurpose: event.approvalPurpose }),
            },
          },
        }),
      onToolEnd: (name, toolResult, isError, meta, uiPayload, durationMs) =>
        send({
          kind: "tool.completed",
          ...(meta.cancelled ? { cancelled: true } : {}),
          tool: {
            name,
            groupId: meta.groupId,
            toolUseId: meta.toolUseId,
            displayOrder: meta.displayOrder,
            ...(meta.source === undefined ? {} : { source: meta.source }),
            ...(meta.category === undefined ? {} : { category: meta.category }),
            ...(meta.pluginId === undefined ? {} : { pluginId: meta.pluginId }),
            ...(meta.mcpServerId === undefined ? {} : { mcpServerId: meta.mcpServerId }),
          },
          isError,
          durationMs,
          ownerDetail: {
            result: toolResult,
            ...(meta.executionPlan === undefined
              ? {}
              : { executionPlan: meta.executionPlan }),
            ...(uiPayload === undefined ? {} : { uiPayload }),
            ...(meta.browserPreview === undefined ? {} : { browserPreview: meta.browserPreview }),
          },
        }),
      onError: (error, systemNotice, classifierCategory, operation) =>
        send(operation === "compaction" ? { kind: "compaction.failed" } : {
          kind: "turn.error",
          // Derive share-safe failures from a closed table, never raw errors.
          failure: deriveTurnFailureSummary({
            ...(systemNotice === undefined ? {} : { systemNotice }),
            ...(classifierCategory === undefined ? {} : { classifierCategory }),
          }),
          ownerDetail: {
            message: error,
            ...(systemNotice === undefined ? {} : { systemNotice }),
          },
        }),
      onPermissionModeChanged: (mode) => send({ kind: "permission.mode.changed", mode }),
      onCompactStarted: ({ triggerSource, estimatedBefore, preflight }) =>
        send({
          kind: "compaction.started",
          triggerSource,
          estimatedBefore,
          preflight,
        }),
      onRecoveryExhausted: () =>
        send({ kind: "compaction.recovery.exhausted" }),
      onCompactOccurred: ({ removedMessages, freedTokens, estimatedAfter, trigger, summary, compactNum, compactStatus, truncatedDir }) =>
        send({
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
      onTurnSummary: ({ endedByEndTurn, turnDurationMs, toolCount, cumulativeToolMs, tokensIn, freshInputTokens, tokensOut, cacheReadTokens, cacheWriteTokens, vendorProvider, vendorModel, usageByModel, subscriptionUsage, decisionCounts, breakdown }) =>
        send({
          kind: "usage.reported",
          ownerDetail: {
            ...(endedByEndTurn === true ? { endedByEndTurn: true as const } : {}),
            turnDurationMs,
            toolCount,
            cumulativeToolMs,
            tokensIn,
            freshInputTokens,
            tokensOut,
            ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
            vendorProvider,
            vendorModel,
            ...(usageByModel !== undefined ? { usageByModel } : {}),
            ...(subscriptionUsage !== undefined ? { subscriptionUsage } : {}),
            ...(decisionCounts !== undefined ? { decisionCounts } : {}),
            ...(breakdown ? { breakdown } : {}),
          },
        }),
      onLlmStatus: (status) => send({ kind: "model.status", ownerDetail: { status } }),
      onFallback: (from, to) => send({ kind: "model.fallback", from, to }),
      onGuidanceInjected: (text, row) => send({
        kind: "guidance.applied",
        text,
        ...(row.source
          ? { subAgentReport: row.source.title === undefined ? {} : { title: row.source.title } }
          : {}),
        ownerDetail: { messageId: row.messageId },
      }),
      onGuidanceDropped: (text) => send({ kind: "guidance.dropped", text }),
      onDecision: (decision) => send({ kind: "loop.decision", decision }),
    },
    options.abortSignal,
    {
      ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
      ...(originSource ? { originSource } : {}),
      ...(options.attachments && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
      inputOrigin,
      // A staged envelope's origin replaces a claimed keyboard one; its intent is then not forwarded.
      ...(inputOrigin === "user-keyboard" && options.userKeyboardIntent ? { userKeyboardIntent: options.userKeyboardIntent } : {}),
      ...(options.requestAnchorRawIntent !== undefined
        ? { requestAnchorRawIntent: options.requestAnchorRawIntent }
        : {}),
      ...(options.rolePrompt ? { rolePrompt: options.rolePrompt } : {}),
      ...(options.initialGuidance ? { initialGuidance: options.initialGuidance } : {}),
      ...(options.subAgentReport ? { subAgentReport: options.subAgentReport } : {}),
      ...(options.approvalReasonPrefix
        ? { approvalReasonPrefix: options.approvalReasonPrefix }
        : {}),
      ...(options.remoteControllerAuthority
        ? { remoteControllerAuthority: options.remoteControllerAuthority }
        : {}),
      ...(options.unattendedAuthority
        ? { unattendedAuthority: options.unattendedAuthority }
        : {}),
      ...(options.displayText !== undefined ? { displayText: options.displayText } : {}),
      ...(options.resumesInterruptedTurn ? { resumesInterruptedTurn: true as const } : {}),
      userMessageId,
    },
  );
  const { trailing, suggestedReply } = suggestedRepliesFilter.finish();
  if (trailing) send({ kind: "assistant.text.delta", text: trailing });
  send({ kind: "suggestions.updated", reply: suggestedReply });
  const authorizationRequired = authorizationRequiredStateForOutput(
    result.authorizationRequired,
  );
  send({
    kind: "turn.completed",
    ...(result.route === "command" ? { route: "command" } : {}),
    ...(authorizationRequired
      ? { authorizationRequired }
      : {}),
  });
  return result;
}
