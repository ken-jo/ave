import { markCodeCheckpointUnavailable, withCodeCheckpoint } from "../../memory/code-checkpoints.js";
import { runWithAgentObservationTurn } from "../../tools/agent-observation-context.js";
import { randomUUID } from "node:crypto";
import type { ConversationLoop as LoopContext } from "../conversation-loop.js";
import type {
  RunTurnOptions,
  TurnCallbacks,
  TurnDecisionEvent,
  TurnDecisionKind,
  TurnResult,
  TurnStopReason,
} from "./types.js";
import type { Span, Tracer } from "@opentelemetry/api";
import { context as otelContext, SpanStatusCode, trace as otelTrace } from "@opentelemetry/api";
import {
  DECISION_EVENT_NAME,
  decisionAttributes,
  TOOL_SPAN_PREFIX,
  TURN_SPAN_NAME,
} from "../telemetry/tracing.js";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import type { MessageMeta } from "../llm/types.js";
import type * as QueryLoopModule from "./query-loop.js";
import { initialToolTrustOrigin, summarizePermissionUserIntent,
} from "./trust-origin.js";
import { projectNextTurnInputTokens } from "../request-input-projection.js";
import { fireContinuableStop } from "./lifecycle-hooks.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import { normalizeAiSdkUsageForCost } from "../llm/pricing.js";
import { stripLeadingSlash } from "../../shared/slash-sanitizer.js";
import { isUserKeyboardOrigin } from "../../shared/chat-origin.js";
import { consumeUnattendedTurnAuthority } from "../../shared/authorization-required.js";
import { countResourceAttachmentFences } from "../../shared/mcp-resource-bounds.js";
import {
  parseStagedEnvelopePayload,
  stagedOriginForInput,
} from "../../shared/staged-origins.js";
import { sessionContext } from "../session-context.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import { createRequestAnchor } from "../../tools/pipeline/rationale-control.js";
import { providerMatchesActiveChatRuntime } from "./provider.js";
import { BUILTIN_SLASH_COMMANDS } from "./commands.js";
import { expandCustomCommand, loadCustomCommand } from "../../core/custom-commands.js";
import { aggregateSubscriptionUsage } from "./subscription-usage-telemetry.js";
import { TurnJournal, isHostExitAbort, registerRunningTurn } from "./turn-journal.js";
import { HOST_EXIT_INTERRUPTION } from "../../memory/session-turn-journal.js";
import type { MemoryCaptureTaintReason } from "../../memory/memory-capture-service.js";

const log = createLogger("ave");

interface TurnTrace {
  readonly tracer: Tracer;
  readonly span: Span;
  // Close leftover tool spans on turn exit; aborted tools may never emit onToolEnd.
  readonly toolSpans: Map<string, Span>;
}

// Export only sizes and identifiers; traces must never contain prompt text or tool input/output.
function toolSpanEndAttributes(
  result: string,
  isError: boolean,
  durationMs: number,
): Record<string, string | number | boolean> {
  return {
    "ave.tool.is_error": isError,
    "ave.tool.result_chars": result.length,
    "ave.tool.duration_ms": durationMs,
  };
}

function commitsHostInjectedMessages(stopReason: TurnStopReason | undefined,
): boolean {
  return stopReason === "end_turn" || stopReason === "input-required";
}

/** Flush accepted history even when queryLoop throws; repeated whole-session writes are idempotent.
 * Log durability failures without replacing the turn error already being reported. */
async function flushTranscript(self: LoopContext, reason: string): Promise<void> {
  if (self.deps.disableSessionPersistence) return;
  try {
    await self.deps.memoryManager.saveSession(
      self.sessionId,
      self.history.getMessages(),
    );
  } catch (err) {
    log.warn(`transcript flush failed (${reason}): %s`, err);
  }
}

/** Run under an active turn span so generated spans inherit it; no tracer creates no span. */
export async function runTurn(
  self: LoopContext,
  input: string,
  callbacks?: TurnCallbacks,
  abortSignal?: AbortSignal,
  options?: RunTurnOptions,
): Promise<TurnResult> {
  const tracer = self.deps.tracer;
  if (!tracer) return runTurnInSpan(self, input, callbacks, abortSignal, options, null);
  return tracer.startActiveSpan(
    TURN_SPAN_NAME,
    {
      attributes: {
        "ave.session_id": options?.sessionIdOverride ?? self.sessionId,
        "ave.turn_id": randomUUID(),
        "ave.input_origin": options?.inputOrigin ?? "",
      },
    },
    async (span) => {
      const toolSpans = new Map<string, Span>();
      try {
        return await runTurnInSpan(self, input, callbacks, abortSignal, options, {
          tracer,
          span,
          toolSpans,
        });
      } finally {
        for (const toolSpan of toolSpans.values()) {
          toolSpan.setAttribute("ave.tool.unfinished", true);
          toolSpan.end();
        }
        toolSpans.clear();
        span.end();
      }
    },
  );
}

async function runTurnInSpan(
  self: LoopContext,
    input: string,
    callbacks?: TurnCallbacks,
    abortSignal?: AbortSignal,
    options?: RunTurnOptions,
    turnTrace?: TurnTrace | null,
  ): Promise<TurnResult> {
    const effectiveSessionId = options?.sessionIdOverride ?? self.sessionId;
    if (!options?.inputOrigin) {
      throw new Error("ConversationLoop.runTurn requires an explicit inputOrigin",
    );
    }
    const inputOrigin: ChatInputOrigin = options.inputOrigin;
    const isRemoteControllerTurn = options.remoteControllerAuthority !== undefined;
    // Spend only host-minted unattended authority once; lookalikes and replay fail closed.
    if (
      options.unattendedAuthority !== undefined
      && !consumeUnattendedTurnAuthority(options.unattendedAuthority)
    ) {
      throw new Error("ConversationLoop.runTurn received an unattended authority this host did not issue for this turn");
    }
    let turnInput = isUserKeyboardOrigin(inputOrigin) ? input : stripLeadingSlash(input);
    let customCommandDisplayText: string | undefined;
    const attachmentParts = options.attachments ?? [];
    const memoryCaptureTaint = new Set<MemoryCaptureTaintReason>();
    if (!isUserKeyboardOrigin(inputOrigin)) memoryCaptureTaint.add("non-keyboard-origin");
    if (attachmentParts.length > 0) memoryCaptureTaint.add("attachment");
    if (options.initialGuidance) memoryCaptureTaint.add("initial-guidance");
    if (options.a2aCausalContext) memoryCaptureTaint.add("a2a-causal-context");
    if (options.originSource) memoryCaptureTaint.add("overlay-origin");
    const toolTrustOrigin = attachmentParts.length > 0
      ? "file-content"
      : initialToolTrustOrigin(inputOrigin, turnInput);
    let lifecycleProvenance: { toolTrustOrigin: ChatInputOrigin; overlayTriggerOrigin: string | null; approvalReasonPrefix?: string } = {
      toolTrustOrigin, overlayTriggerOrigin: options.originSource ?? null, approvalReasonPrefix: options.approvalReasonPrefix,
    };
    const permissionUserIntent = summarizePermissionUserIntent(inputOrigin, turnInput,
  );
    const requestAnchor = options.requestAnchorRawIntent !== undefined && self.deps.headless !== true
      ? createRequestAnchor({
          sessionId: effectiveSessionId,
          turnId: randomUUID(),
          inputMessageId: randomUUID(),
          inputOrigin,
          rawIntent: options.requestAnchorRawIntent,
        })
      : null;

    self.tracer.step("REQUEST_ENTRY", { inputLen: turnInput.length, inputOrigin,
  });
    let activeChatRuntime = self.deps.settingsService.get("llm").activeChatRuntime;
    if (!providerMatchesActiveChatRuntime(self.provider, activeChatRuntime)) {
      try {
        // Revalidate provider posture at execution for stale loops missed by settings refresh.
        self.refreshProvider();
      } catch {
        // Refresh clears the prior client first; rebuild failure leaves the route unconfigured.
      }
      activeChatRuntime = self.deps.settingsService.get("llm").activeChatRuntime;
    }
    if (!providerMatchesActiveChatRuntime(self.provider, activeChatRuntime)) {
      const err = t("be_conversationLoop.llmProviderNotConfigured");
      callbacks?.onError?.(err);
      throw new Error(err);
    }

    const ac = new AbortController();
    self.currentAbortController = ac;
    if (abortSignal?.aborted) {
      ac.abort(abortSignal.reason ?? new Error("parent aborted turn"));
    } else {
      abortSignal?.addEventListener(
        "abort",
        () => ac.abort(abortSignal.reason ?? new Error("parent aborted turn")),
        { once: true },
      );
    }
    const turnSignal = ac.signal;
    const runLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
      const inherited = turnExtensionPolicyContext.getStore();
      const otherPrincipal = lifecycleProvenance.toolTrustOrigin === "file-content" || lifecycleProvenance.toolTrustOrigin === "agent-message" ||
        lifecycleProvenance.approvalReasonPrefix !== undefined || memoryCaptureTaint.has("staged-guidance");
      return turnExtensionPolicyContext.run(Object.freeze({
        ...inherited,
        allowExternalHooks: inherited?.allowExternalHooks !== false && !isRemoteControllerTurn,
        headless: self.deps.headless, ownerUnattended: options.unattendedAuthority !== undefined,
        approvalSurface: self.deps.approvalSurface, remoteControllerAuthority: options.remoteControllerAuthority,
        floor: inherited?.floor ?? (otherPrincipal ? { code: "other-principal" as const, reason: lifecycleProvenance.approvalReasonPrefix ?? "This principal requires local approval for the action." } : undefined),
        overlayTriggerOrigin: lifecycleProvenance.overlayTriggerOrigin, abortSignal: turnSignal,
      }), operation);
    };
    let initialGuidanceId: string | null = null;
    let agentMessageInputId: string | null = null;
    let retainHostInjectedMessages = false;
    let turnStateFinalized = false;
    let userTurnAppended = false;
    let transcriptPersistedAfterLoop = false;
    let journal: TurnJournal | null = null;
    // Host exit aborts and waits for turns to settle after their final durability write.
    const runningTurn = registerRunningTurn((reason) => ac.abort(reason));

    // Cover every path after exposing the controller; detach guidance before callbacks for idempotent cleanup.
    const finalizeTurnState = async () => {
      if (turnStateFinalized) return;
      turnStateFinalized = true;
      self.currentAbortController = null;
      self.turnAdditionalDirectories = [];
      await self.dropPendingGuidance("turn-ended", callbacks);
    };

    try {
    const classification = self.deps.inputClassifier.classify(turnInput);
    self.tracer.step("INPUT_CLASSIFY", { type: classification.type });
    let routeResult = self.deps.routeEngine.route(classification);
    self.tracer.step("ROUTE_RESOLVE", { route: routeResult.route });

    if (routeResult.route === "command") {
      // Builtins precede keyboard-only command files; expansion retains typed-input trust and permission intent.
      const customCommand = isUserKeyboardOrigin(inputOrigin) && !BUILTIN_SLASH_COMMANDS.has(routeResult.command)
        ? await loadCustomCommand(routeResult.command, self.getSessionProjectContext().projectRoot)
        : null;
      if (customCommand) {
        customCommandDisplayText = turnInput;
        turnInput = expandCustomCommand(customCommand.body, routeResult.args);
        routeResult = { route: "llm", input: turnInput };
      } else if (
        !BUILTIN_SLASH_COMMANDS.has(routeResult.command) &&
        self.deps.isSkillName?.(routeResult.command) === true
      ) {
        // Skills run as model turns with visible loading; builtins and user command files win name collisions.
        routeResult = { route: "llm", input: turnInput };
      } else {
        self.currentAbortController = null;
        return self.handleCommand(routeResult.command, routeResult.args, inputOrigin, callbacks,
        );
      }
    }

    self.tracer.step("TURN_ORCHESTRATE", { sessionId: self.sessionId });

    // Fire observe-only SessionStart once per session after command short-circuiting.
    if (!isRemoteControllerTurn && self.sessionStartFiredFor !== effectiveSessionId) {
      self.sessionStartFiredFor = effectiveSessionId;
      await runLifecycle(() => self.fireLifecycleEvent(
        "SessionStart",
        { sessionMeta: self.sessionMetaForLifecycle(), sessionSource: self.sessionSource },
        effectiveSessionId,
      ));
    }

    // Blocking prompt hooks run before queryLoop and fail closed; unmatched trusted hooks allow.
    const promptGate = isRemoteControllerTurn
      ? { decision: "allow" as const, reason: "Remote-controller pre-approval prompt hook disabled" }
      : await runLifecycle(() => self.fireUserPromptSubmit(
          {
            inputText: options?.initialGuidance
              ? `${turnInput}\n\n${options.initialGuidance}`
              : turnInput,
            inputOrigin,
            route: routeResult.route,
            classification: classification.type,
          },
          effectiveSessionId,
        ));
    if (promptGate.decision === "deny") {
      // Refused input is displayed but never accepted into history or query execution.
      self.currentAbortController = null;
      const refusal = t("be_conversationLoop.userPromptBlocked", {
        reason: promptGate.reason,
      });
      callbacks?.onTextDelta?.(refusal);
      callbacks?.onTurnComplete?.(refusal);
      log.warn(
        `runTurn: UserPromptSubmit hook REFUSED the prompt (turn blocked) — ${promptGate.reason}`,
      );
      return {
        text: refusal,
        toolCalls: [],
        route: routeResult.route,
        stopReason: "blocked",
      };
    }

    // Aggregate tool duration by call ID so parallel starts do not collide; prefer executor measurements.
    const turnStartedAt = Date.now();
    let turnTokensIn = 0;
    let turnTokensOut = 0;
    // Calibrate final projected context from the latest provider input and post-turn projection delta.
    self.lastRoundProviderInputTokens = 0;
    self.lastRoundInputProjection = null;
    let turnToolCount = 0;
    let turnCumulativeToolMs = 0;
    const turnToolStarts = new Map<string, number>();
    const turnToolBreakdown = new Map<string, { count: number; ms: number }>();
    const turnDecisionCounts = new Map<TurnDecisionKind, number>();
    const recordDecision = (event: TurnDecisionEvent): void => {
      turnDecisionCounts.set(event.kind, (turnDecisionCounts.get(event.kind) ?? 0) + 1);
      turnTrace?.span.addEvent(DECISION_EVENT_NAME, decisionAttributes(event));
      callbacks?.onDecision?.(event);
    };
    const wrappedCallbacks: TurnCallbacks | undefined = callbacks
      ? {
          ...callbacks,
          onDecision: recordDecision,
          onCompactStarted: (info) => {
            turnTrace?.span.addEvent("ave.compact.preflight", {
              "ave.compact.trigger_source": info.triggerSource,
              "ave.compact.estimated_before": info.estimatedBefore,
              "ave.compact.preflight": info.preflight,
            });
            callbacks.onCompactStarted?.(info);
          },
          onCompactOccurred: (result) => {
            turnTrace?.span.addEvent("ave.compact.applied", {
              "ave.compact.removed_messages": result.removedMessages,
              "ave.compact.freed_tokens": result.freedTokens,
              "ave.compact.estimated_after": result.estimatedAfter,
              ...(result.trigger ? { "ave.compact.trigger": result.trigger } : {}),
            });
            callbacks.onCompactOccurred?.(result);
          },
          onGuidanceInjected: (text, row) => {
            turnTrace?.span.addEvent("ave.guidance.staged", {
              "ave.guidance.disposition": "applied",
              "ave.guidance.chars": text.length,
            });
            callbacks.onGuidanceInjected?.(text, row);
          },
          onGuidanceDropped: (text) => {
            turnTrace?.span.addEvent("ave.guidance.staged", {
              "ave.guidance.disposition": "dropped",
              "ave.guidance.chars": text.length,
            });
            callbacks.onGuidanceDropped?.(text);
          },
          onFallback: (from, to) => {
            turnTrace?.span.addEvent("ave.provider.fallback", {
              "ave.provider.from": from,
              "ave.provider.to": to,
            });
            callbacks.onFallback?.(from, to);
          },
          onError: (error, systemNotice, classifierCategory, operation) => {
            if (!operation) turnTrace?.span.setStatus({
              code: SpanStatusCode.ERROR,
              ...(systemNotice ? { message: systemNotice } : {}),
            });
            callbacks.onError?.(error, systemNotice, classifierCategory, operation);
          },
          onToolStart: (name, input, meta) => {
            turnToolStarts.set(meta.toolUseId, Date.now());
            if (turnTrace) {
              turnTrace.toolSpans.set(
                meta.toolUseId,
                turnTrace.tracer.startSpan(`${TOOL_SPAN_PREFIX}${name}`, {
                  attributes: {
                    "gen_ai.tool.name": name,
                    "gen_ai.tool.call.id": meta.toolUseId,
                    "ave.tool.group_id": meta.groupId,
                    ...(meta.source ? { "ave.tool.source": meta.source } : {}),
                    ...(meta.category ? { "ave.tool.category": meta.category } : {}),
                    ...(meta.pluginId ? { "ave.tool.plugin_id": meta.pluginId } : {}),
                  },
                },
                // Set tool-span parents explicitly; this relation must not rely on an installed context manager.
                otelTrace.setSpan(otelContext.active(), turnTrace.span)),
              );
            }
            callbacks.onToolStart?.(name, input, meta);
          },
          onToolEnd: (name, result, isError, meta, uiPayload, durationMs) => {
            const startedAt = turnToolStarts.get(meta.toolUseId);
            turnToolStarts.delete(meta.toolUseId);
            // Prefer executor duration, then start/end wall time; missing start contributes zero.
            const elapsed =
              typeof durationMs === "number" &&
              Number.isFinite(durationMs) &&
              durationMs >= 0
                ? durationMs
                : startedAt !== undefined
                  ? Math.max(0, Date.now() - startedAt)
                  : 0;
            turnToolCount += 1;
            turnCumulativeToolMs += elapsed;
            const toolSpan = turnTrace?.toolSpans.get(meta.toolUseId);
            if (toolSpan) {
              turnTrace?.toolSpans.delete(meta.toolUseId);
              toolSpan.setAttributes(toolSpanEndAttributes(result, isError, elapsed));
              if (isError) toolSpan.setStatus({ code: SpanStatusCode.ERROR });
              toolSpan.end();
            }
            const prev = turnToolBreakdown.get(name) ?? { count: 0, ms: 0 };
            turnToolBreakdown.set(name, {
              count: prev.count + 1,
              ms: prev.ms + elapsed,
            });
            callbacks.onToolEnd?.(
              name,
              result,
              isError,
              meta,
              uiPayload,
              elapsed,
            );
          },
        }
      : undefined;
    const callbacksForLoop = wrappedCallbacks ?? callbacks;

    const userContent: string | import("../llm/types.js").UserContentPart[] =
      attachmentParts.length > 0
        ? [{ type: "text" as const, text: turnInput }, ...attachmentParts]
        : turnInput;
    const personaPromptMeta = options?.rolePrompt?.id
      ? {
          id: options.rolePrompt.id,
          name: options.rolePrompt.name,
          ...(options.rolePrompt.origin ? { origin: options.rolePrompt.origin } : {}),
        }
      : undefined;
    // Render staged input with provenance from its claimed origin envelope, never as genuine user text.
    // Direct callers also need origin-envelope binding to prevent impersonating another source.
    const stagedKind = stagedOriginForInput(inputOrigin);
    const importedTrigger = stagedKind
      ? (() => {
          const parsed = parseStagedEnvelopePayload(turnInput);
          return parsed && parsed.kind === stagedKind ? parsed : null;
        })()
      : null;
    if (inputOrigin === "agent-message") {
      agentMessageInputId = randomUUID();
    }
    // Show typed resource markers rather than server attachment bodies in the user transcript bubble.
    const carriesResourceAttachment = countResourceAttachmentFences(attachmentParts) > 0;
    const userMeta: MessageMeta = {
      // Preserve a caller-announced row ID; append mints one only if absent.
      ...(options.userMessageId !== undefined ? { messageId: options.userMessageId } : {}),
      ...(agentMessageInputId ? { hostInjectionId: agentMessageInputId } : {}),
      ...(personaPromptMeta ? { activePersonaPrompt: personaPromptMeta } : {}),
      ...(options.resumesInterruptedTurn ? { resumesInterruptedTurn: true as const } : {}),
      ...(options.displayText !== undefined
        ? { displayText: options.displayText }
        : customCommandDisplayText !== undefined
          ? { displayText: customCommandDisplayText }
          : carriesResourceAttachment
          ? { displayText: turnInput }
          : {}),
      ...(importedTrigger
        ? {
            displayText: importedTrigger.body,
            importedTrigger: {
              sessionId: `history-imported-${self.sessionId}-${turnStartedAt}`,
              source: importedTrigger.source,
              prompt: turnInput,
              summary: importedTrigger.body,
              toolCallCount: 0,
              importedAt: new Date(turnStartedAt).toISOString(),
            },
          }
        : {}),
    };

    // Stamp exactly the row holding a child report, whether turn input or guidance.
    if (options?.subAgentReport && !options.initialGuidance && inputOrigin === "agent-message") {
      userMeta.subAgentReport = options.subAgentReport;
    }
    const turnUserMessage = self.history.append({
      role: "user",
      content: userContent,
      ...(Object.keys(userMeta).length > 0 ? { meta: userMeta } : {}),
    });
    if (options?.initialGuidance) {
      initialGuidanceId = randomUUID();
      self.history.append({
        role: "user",
        content: t("be_conversationLoop.guidanceInjectionHeader", {
          joined: options.initialGuidance,
        }),
        meta: {
          hostInjectionId: initialGuidanceId,
          ...(options.subAgentReport ? { subAgentReport: options.subAgentReport } : {}),
        },
      });
    }
    userTurnAppended = true;
    self.tracer.step("HISTORY_APPEND", {
      role: "user",
      historySize: self.history.length,
    });
    // Persist accepted input before preflight or provider work can throw and erase the question.
    await flushTranscript(self, "turn-accepted");
    // Start append journaling after the baseline flush; snapshot partial streaming text for crash recovery.
    if (!self.deps.disableSessionPersistence) {
      journal = new TurnJournal(self.deps.memoryManager, self.sessionId, self.history);
      await journal.begin();
      self.activeTurnJournal = journal;
    }

    // Set tool scope before prompt building so advertised schemas match execution scope.
    const scope = self.resolveToolScope(input);
    const subscriptionRuntime = self.provider?.subscriptionRuntime;
    const isSubscriptionRuntime = subscriptionRuntime !== undefined;
    const subscriptionAuditRoute = subscriptionRuntime
      ? `subscription:${subscriptionRuntime.provider}/${subscriptionRuntime.model || "default"}`
      : undefined;
    const initialToolSchemas = self.rebuildToolSchemas(scope);

    // Preflight measures the outgoing prompt, wire history, and schemas; rebuild after compact mutation.
    if (self.provider && !self.deps.disableSessionPersistence) {
      await self.runPreflightGuard(
        self.createRequestProjectionContext(
          scope,
          options?.originSource ?? null,
          options?.rolePrompt,
          initialToolSchemas,
          effectiveSessionId,
          input,
        ),
        turnSignal,
        callbacks,
      );
    }

    const systemPrompt = self.buildSystemPromptForScope(
      scope,
      options?.rolePrompt,
      effectiveSessionId,
    );
    self.tracer.step("PROMPT_ASSEMBLE", {
      promptLen: systemPrompt.length,
      activePlugins: scope.activePluginIds.size,
    });
    // Lazy-load the round loop on first turn; load failures reject through normal cleanup.
    const { queryLoop } = await import("./query-loop.js");
    let result: Awaited<ReturnType<typeof QueryLoopModule.queryLoop>>;
    // Clean root turns dispatch Stop; child runs dispatch SubagentStop; other nested turns observe only.
    let stopHookDispatched = false;
    const subagentStop = options?.subagentStop;
    const onStopHook = subagentStop || !options?.spawnDepth
      ? async ({ toolCount, stopHookActive }: { toolCount: number; stopHookActive: boolean }) => runLifecycle(async () => {
          stopHookDispatched = true;
          if (subagentStop) {
            subagentStop.onDispatched();
            return fireContinuableStop(self.deps, self.sessionId, "SubagentStop", {
              ...(subagentStop.agentId !== undefined ? { agentId: subagentStop.agentId } : {}),
              ...(subagentStop.agentType !== undefined ? { agentType: subagentStop.agentType } : {}),
              stopReason: "end_turn",
              stopHookActive,
            }, effectiveSessionId);
          }
          return fireContinuableStop(self.deps, self.sessionId, "Stop", {
            stopReason: "end_turn",
            toolCount,
            durationMs: Math.max(0, Date.now() - turnStartedAt),
            stopHookActive,
          }, effectiveSessionId);
        })
      : undefined;
    // Bind async context to the effective session ID so delegates read isolated session activations.
    const runQuery = () => runWithAgentObservationTurn({ sessionId: effectiveSessionId, turnId: turnUserMessage.meta.messageId }, () => sessionContext.run({ sessionId: effectiveSessionId }, () =>
      queryLoop(
        self,
        systemPrompt,
        scope,
        callbacksForLoop,
        turnSignal,
        options?.originSource ?? null,
        {
          maxRounds: options?.maxRounds,
          sessionIdOverride: options?.sessionIdOverride,
          spawnDepth: options?.spawnDepth,
          approvalReasonPrefix: options?.approvalReasonPrefix,
          remoteControllerAuthority: options?.remoteControllerAuthority,
          unattendedAuthority: options?.unattendedAuthority,
          inputOrigin,
          a2aCausalContext: options?.a2aCausalContext,
          toolTrustOrigin,
          ...(requestAnchor ? { requestAnchor } : {}),
          permissionUserIntent,
          rolePrompt: options?.rolePrompt,
          onMemoryCaptureTaint: (reason) => memoryCaptureTaint.add(reason),
          onPermissionProvenanceChanged: (provenance) => { lifecycleProvenance = provenance; },
          memoryQuery: input,
          ...(onStopHook ? { onStopHook } : {}),
        },
      ),
    ));
    if (self.sessionKind === "subagent") await markCodeCheckpointUnavailable();
    result = self.deps.disableSessionPersistence || self.sessionKind === "subagent"
      ? await runQuery()
      : await withCodeCheckpoint({ sessionId: effectiveSessionId, messageId: turnUserMessage.meta.messageId }, runQuery);
    await finalizeTurnState();
    if (!commitsHostInjectedMessages(result.stopReason) && initialGuidanceId) {
      self.history.removeByHostInjectionId(initialGuidanceId);
      initialGuidanceId = null;
    }
    if (
      !commitsHostInjectedMessages(result.stopReason) &&
      agentMessageInputId
    ) {
      self.history.removeByHostInjectionId(agentMessageInputId);
      agentMessageInputId = null;
    }
    // Carry newly activated plugin scope into the next turn.
    self.lastTurnScope = new Set(scope.activePluginIds);
    // Carry only intentional plugin/MCP tool surface, not unused search promotions.
    self.lastTurnToolNames = self.nextCarryForwardToolNames(
      scope,
      result.toolCalls,
    );
    const postTurnToolExposure = self.buildToolExposureMetrics(
      scope,
      result.finalToolSchemas,
      self.projectProviderRequestInput({
        systemPrompt,
        messages: self.history.getMessages(),
        toolSchemas: result.finalToolSchemas,
      }),
      result.promotedToolNames,
    );

    // Observe terminal Stop before persistence; a lifecycle hook cannot block the internal save chain.
    if (!(stopHookDispatched && result.stopReason === "end_turn" && !subagentStop)) await runLifecycle(() => self.fireLifecycleEvent(
      "Stop",
      {
        ...(result.stopReason !== undefined
          ? { stopReason: result.stopReason }
          : {}),
        toolCount: result.toolCalls.length,
        durationMs: Math.max(0, Date.now() - turnStartedAt),
      },
      effectiveSessionId,
    ));

    self.tracer.step("POST_TURN", {
      toolCallCount: result.toolCalls.length,
      stopReason: result.stopReason,
      ...postTurnToolExposure,
    });
    if (self.deps.postTurnHookChain) {
      const hookResult = await self.deps.postTurnHookChain.run({
        sessionId: self.sessionId,
        ...self.getSessionProjectContext(),
        messages: self.history.getMessages(),
        // Only original textual user input can be capture evidence, never attachments or generated content.
        input: turnInput,
        inputOrigin,
        memoryCaptureTaint: [...memoryCaptureTaint],
        output: result.text,
        stopReason: result.stopReason,
        toolCalls: result.toolCalls.map((tc) => ({
          name: tc.name,
          isError: false,
        })),
        toolExposure: postTurnToolExposure,
        route: subscriptionAuditRoute ?? routeResult.route,
        ...(isSubscriptionRuntime && result.subscriptionUsage.length > 0
          ? { subscriptionUsage: result.subscriptionUsage }
          : {}),
        ...(!isSubscriptionRuntime
          ? {
              tokenUsage: result.usage,
              usageByModel: result.usageByModel,
              vendorProvider: result.vendorProvider,
              vendorModel: result.vendorModel,
              ...(result.modelSettings ? { modelSettings: result.modelSettings } : {}),
            }
          : {}),
      });
      // Align memory with marker-stripped output before the final summary save can overwrite clean history.
      const shouldRestoreHookHistory = hookResult.detector.cleanedText !== result.text;
      if (shouldRestoreHookHistory) {
        const beforeCount = self.history.getMessages().length;
        const afterCount = hookResult.messagesForPersistence.length;
        log.info(
          `post-turn: history mutation — ${beforeCount} → ${afterCount} msgs (canonical persistence applied to history reference)`,
        );
        self.history.clear();
        self.history.restore(hookResult.messagesForPersistence);
      }
      if (hookResult.detector.cleanedText !== result.text) {
        result = { ...result, text: hookResult.detector.cleanedText };
      }
    } else {
      // Child fallback saves stay isolated from parent audit and extraction hooks.
      // Do not stub after the turn: preserving the reusable prefix avoids cache churn.
      if (!self.deps.disableSessionPersistence) {
        await self.deps.memoryManager.saveSession(
          self.sessionId,
          self.history.getMessages(),
        );
      }
      // Child fallback audits use the same vendor/model route format as post-turn hooks.
      const auditRoute = subscriptionAuditRoute
        ?? (result.usage && result.vendorProvider && result.vendorModel
          ? `${result.vendorProvider}/${result.vendorModel}`
          : routeResult.route);
      const auditVendorProvider = isSubscriptionRuntime ? undefined : result.vendorProvider;
      const auditTokenUsage = auditVendorProvider
        ? normalizeAiSdkUsageForCost(
          result.usage,
          auditVendorProvider,
        )
        : undefined;
      const auditUsageByModel = isSubscriptionRuntime
        ? undefined
        : result.usageByModel?.map((segment) => ({
          ...segment,
          tokenUsage: normalizeAiSdkUsageForCost(
            segment.tokenUsage,
            segment.vendorProvider,
          ),
        }));
      self.auditLogger.logTurn({
        sessionId: self.sessionId,
        input,
        output: result.text,
        toolCalls: result.toolCalls.map((tc) => ({
          name: tc.name,
          isError: false,
        })),
        tokenUsage: auditTokenUsage,
        usageByModel: auditUsageByModel,
        ...(isSubscriptionRuntime && result.subscriptionUsage.length > 0
          ? { subscriptionUsage: result.subscriptionUsage }
          : {}),
        toolExposure: postTurnToolExposure,
        route: auditRoute,
        ...(!isSubscriptionRuntime && result.modelSettings ? { modelSettings: result.modelSettings } : {}),
      });
      self.deps.idleScheduler?.signalConversation();
    }
    transcriptPersistedAfterLoop = true;

    // Summarize completed text or reasoning spend; suppress interrupted, error, and authorization-only turns.
    const turnProducedAnswer =
      result.text.trim().length > 0 ||
      self.history.getLastAssistantThought().trim().length > 0;
    const willEmitSummary =
      result.stopReason !== "interrupted" &&
      result.stopReason !== "context-error" &&
      // Error notice rows must not receive completed-turn badges from partial failed-round usage.
      result.stopReason !== "stream-error" &&
      result.stopReason !== "authorization-required" &&
      turnProducedAnswer;
    // Record diagnostic shape even when interrupted or failed turns suppress their summary.
    if (turnTrace) {
      turnTrace.span.setAttributes({
        "ave.turn.tool_count": turnToolCount,
        "ave.turn.duration_ms": Math.max(0, Date.now() - turnStartedAt),
        "ave.turn.stop_reason": result.stopReason ?? "",
      });
      for (const [kind, count] of turnDecisionCounts) {
        turnTrace.span.setAttribute(`ave.decision.${kind}`, count);
      }
    }
    const billableTurnUsage = isSubscriptionRuntime ? undefined : result.usage;
    const billableUsageByModel = isSubscriptionRuntime ? [] : result.usageByModel;
    const subscriptionTurnUsage = isSubscriptionRuntime ? result.subscriptionUsage : [];
    const subscriptionTotals = aggregateSubscriptionUsage(subscriptionTurnUsage);
    log.info(
      `turn_summary: emit decision — stopReason="${result.stopReason}" textLen=${result.text.trim().length} thoughtLen=${self.history.getLastAssistantThought().trim().length} usage=${billableTurnUsage ? `in=${billableTurnUsage.inputTokens} out=${billableTurnUsage.outputTokens}` : "MISSING"} → willEmit=${willEmitSummary}`,
    );
    if (willEmitSummary) {
      // Input fullness is provider-calibrated final request context; output and cache usage aggregate every round.
      // Fresh billing input subtracts per-round cache usage, never turn cache from last-round input.
      const postTurnProjection = self.projectProviderRequestInput({
        systemPrompt,
        messages: self.history.getMessages(),
        toolSchemas: result.finalToolSchemas,
      });
      const lastRoundProjection =
        self.lastRoundInputProjection ?? postTurnProjection;
      turnTokensIn = projectNextTurnInputTokens({
        providerInputTokens: self.lastRoundProviderInputTokens,
        lastRoundProjection,
        postTurnProjection,
      });
      self.lastContextInputTokens = turnTokensIn;
      self.lastContextInputProjectionTokens = postTurnProjection.totalTokens;
      turnTokensOut = billableTurnUsage?.outputTokens
        ?? (subscriptionTotals.outputTokens + subscriptionTotals.reasoningOutputTokens);
      const turnCacheRead = billableTurnUsage?.cacheReadTokens ?? subscriptionTotals.cacheReadTokens;
      const turnCacheWrite = billableTurnUsage?.cacheWriteTokens ?? subscriptionTotals.cacheWriteTokens;
      const turnFreshInput = isSubscriptionRuntime
        ? subscriptionTotals.inputTokens
        : Math.max(
          0,
          (billableTurnUsage?.inputTokens ?? 0) - turnCacheRead - turnCacheWrite,
        );
      const breakdown =
        turnToolBreakdown.size > 0
          ? Object.fromEntries(turnToolBreakdown.entries())
          : undefined;
      const uniqueUsageModelKeys = new Set(
        billableUsageByModel.map(
          (segment) => `${segment.vendorProvider}\u0000${segment.vendorModel}`,
        ),
      );
      const singleUsageModel =
        uniqueUsageModelKeys.size === 1 && billableUsageByModel[0]
          ? billableUsageByModel[0]
          : undefined;
      const turnSummaryPayload = {
        ...(result.stopReason === "end_turn" ? { endedByEndTurn: true as const } : {}),
        turnDurationMs: Math.max(0, Date.now() - turnStartedAt),
        toolCount: turnToolCount,
        cumulativeToolMs: turnCumulativeToolMs,
        tokensIn: turnTokensIn,
        freshInputTokens: turnFreshInput,
        tokensOut: turnTokensOut,
        ...(turnCacheRead > 0 ? { cacheReadTokens: turnCacheRead } : {}),
        ...(turnCacheWrite > 0 ? { cacheWriteTokens: turnCacheWrite } : {}),
        ...(singleUsageModel
          ? {
              vendorProvider: singleUsageModel.vendorProvider,
              vendorModel: singleUsageModel.vendorModel,
            }
          : {}),
        ...(billableUsageByModel.length > 0
          ? { usageByModel: billableUsageByModel }
          : {}),
        ...(subscriptionTurnUsage.length > 0
          ? { subscriptionUsage: subscriptionTurnUsage }
          : {}),
        ...(turnDecisionCounts.size > 0
          ? { decisionCounts: Object.fromEntries(turnDecisionCounts) }
          : {}),
        ...(breakdown ? { breakdown } : {}),
        ...(!isSubscriptionRuntime && result.modelSettings
          ? {
              modelSettings: {
                ...result.modelSettings,
                // Remaining window is diagnostic; it does not clamp requests.
                remainingContextOutputTokens: Math.max(0, result.modelSettings.contextWindow.tokens - turnTokensIn),
              },
            }
          : {}),
      };
      if (turnTrace) {
        turnTrace.span.setAttributes({
          "gen_ai.usage.input_tokens": billableTurnUsage?.inputTokens ?? 0,
          "gen_ai.usage.output_tokens": turnTokensOut,
          "gen_ai.usage.cache_read_input_tokens": turnCacheRead,
          "ave.usage.fresh_input_tokens": turnFreshInput,
        });
      }
      // Persist summary on the final assistant row so reload reproduces usage and cost without rerunning.
      let attachedTurnSummary = false;
      try {
        attachedTurnSummary =
          self.history.attachTurnSummaryToLastAssistant(turnSummaryPayload);
      } catch {
      }
      let turnSummaryDurable =
        attachedTurnSummary && self.deps.disableSessionPersistence === true;
      if (attachedTurnSummary && !self.deps.disableSessionPersistence) {
        try {
          await self.deps.memoryManager.saveSession(
            self.sessionId,
            self.history.getMessages(),
          );
          turnSummaryDurable = true;
        } catch (err) {
          log.warn("turn_summary final save failed: %s", err);
        }
      }
      if (turnSummaryDurable) {
        try {
          callbacks?.onTurnSummary?.(turnSummaryPayload);
        } catch {
        }
      }
    }

    callbacks?.onTurnComplete?.(result.text);

    // Only clean turns re-arm exhausted context and TPM recovery budgets.
    if (
      result.stopReason !== "context-error" &&
      result.stopReason !== "stream-error" &&
      result.stopReason !== "interrupted" &&
      result.stopReason !== "authorization-required"
    ) {
      // Reset consecutive recovery counts after clean completion; aborted turns cannot reset the spending cap.
      self.contextErrorRecoveryCount = 0;
      if (self.recoveryExhausted || self.rateLimitRecoveryAttempted) {
        const wasRecoveryExhausted = self.recoveryExhausted;
        self.recoveryExhausted = false;
        self.rateLimitRecoveryAttempted = false;
        log.info(
          wasRecoveryExhausted
            ? "runTurn: recoveryExhausted reset — clean turn, recovery re-armed"
            : "runTurn: rate-limit recovery reset — clean turn, recovery re-armed",
        );
      }
    }

    // Notify only completed text answers, excluding interruption and provider/context failures.
    if (
      result.stopReason !== "interrupted" &&
      result.stopReason !== "context-error" &&
      result.stopReason !== "stream-error" &&
      result.stopReason !== "authorization-required" &&
      typeof result.text === "string" &&
      result.text.trim().length > 0
    ) {
      try {
        self.deps.notificationService?.fire({
          kind: "turn-end",
          title: t("be_conversationLoop.notificationTurnEndTitle"),
          body: result.text,
          contextRef: { sessionId: self.sessionId },
        });
        // Notification hooks observe the same turn-end message shown to the user.
        await runLifecycle(() => self.fireLifecycleEvent("Notification", { message: result.text, notificationType: "agent_completed" }));
      } catch {
      }
    }

    retainHostInjectedMessages = commitsHostInjectedMessages(result.stopReason);
    return { ...result, route: routeResult.route };
  } finally {
    try {
    let removedHostInjectionRows = 0;
    if (!retainHostInjectedMessages && initialGuidanceId) {
      removedHostInjectionRows +=
        self.history.removeByHostInjectionId(initialGuidanceId);
    }
    if (!retainHostInjectedMessages && agentMessageInputId) {
      removedHostInjectionRows +=
        self.history.removeByHostInjectionId(agentMessageInputId);
    }
    // Flush accepted history after throws; load repairs unpaired calls without synthetic end markers.
    // Record host-exit interruption even when it lands between rounds.
    const hostExitMarked = userTurnAppended && isHostExitAbort(turnSignal.reason)
      && markHostExitInterruption(self);
    if (
      userTurnAppended
      && (!transcriptPersistedAfterLoop || removedHostInjectionRows > 0 || hostExitMarked)
    ) {
      await flushTranscript(
        self,
        hostExitMarked
          ? "host-exit"
          : transcriptPersistedAfterLoop ? "host-injection-rollback" : "mid-turn-failure",
      );
    }
    if (journal) {
      if (self.activeTurnJournal === journal) self.activeTurnJournal = null;
      await journal.end();
    }
    await finalizeTurnState();
    // Notify settlement last, after persistence and guidance dispositions, before observers can start work.
    self.emitTurnSettled(effectiveSessionId);
    } finally {
      runningTurn.settle();
    }
  }
}

// Mark host-exit stops lacking a streamed interrupted row; do not add prose after unanswered user input.
function markHostExitInterruption(self: LoopContext): boolean {
  const messages = self.history.getMessages();
  const tail = messages[messages.length - 1];
  if (!tail || tail.role === "user") return false;
  if (tail.role === "assistant" && tail.meta?.interrupted === true) {
    if (tail.meta.interruptedBy === HOST_EXIT_INTERRUPTION) return false;
    tail.meta = { ...tail.meta, interruptedBy: HOST_EXIT_INTERRUPTION };
    return true;
  }
  self.history.append({
    role: "assistant",
    content: "",
    meta: { interrupted: true, interruptedBy: HOST_EXIT_INTERRUPTION },
  });
  return true;
}
