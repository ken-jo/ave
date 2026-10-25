// Stream spawn lifecycle frames to the originating conversation's sub-agent viewer.
import { createDynamicTool, type Tool } from "./base.js";
import {
  exactToolScope,
  PARENT_ALL_TOOL_SCOPE,
  type SubAgentRunner,
  type SubAgentSpawnResult,
  type SubAgentToolScope,
} from "../engine/subagent-runner.js";
import {
  AGENT_NAME_ALLOWLIST,
  type LoadedAgentProfile,
} from "../main/agent-profile-store.js";
import { renderAgentProfilePrompt } from "../engine/agent-profile-prompt.js";
import { t } from "../i18n/index.js";

import type { ChatEntry } from "../lib/chat-stream-state.js";
import {
  A2A_ROLE_AGENT,
  projectSubAgentResultState,
  projectSubAgentRunState,
  subAgentRunStatusFromTaskState,
  type A2AMessage,
} from "../shared/a2a.js";
import type { AgentSpawnEvent as SharedAgentSpawnEvent } from "../shared/subagent-events.js";
import { createDlpSafeUuid } from "../shared/dlp-safe-id.js";
import { resolveSubAgentCeilingMs } from "../shared/tool-timeout-policy.js";
import { SUBAGENT_MAX_ROUNDS_DEFAULT } from "../shared/subagent-policy.js";
import { isDeterministicProviderRequestRejection } from "../engine/llm/error-classifier.js";
import {
  authorizationRequiredStateForOutput,
  issueAuthorizationRequiredControl,
} from "../shared/authorization-required.js";

// Authorized turns can fail through deterministic remote rejection; retry guidance must distinguish that from transient failure.
// Keep the child's resumeId, but reserve resumeRefusal for host decisions made before a turn runs.
function resumeRanGuidance(error: string): Record<string, unknown> {
  return isDeterministicProviderRequestRejection(error)
    ? {
        resumeDeterministicFailure: true,
        resumeGuidance: t("be_agentSpawn.resumeProviderRejectedGuidance"),
      }
    : { resumeGuidance: t("be_agentSpawn.resumeRetryGuidance") };
}


// Refusal before linking has no authorized child ID; delivery receives the authorized link separately.
type SubAgentTerminalOutcome =
  Omit<SubAgentSpawnResult, "childSessionId">
  & { childSessionId?: string };

// Empty summaries still need actionable state; use only the authorized child link, never an unvalidated result ID.
function backgroundResultText(
  result: SubAgentTerminalOutcome,
  childSessionId: string,
): string {
  const reported = result.error ?? result.summary;
  const summary = reported.trim().length > 0
    ? reported
    : t("be_agentSpawn.emptySummaryFallback", {
        taskState: projectSubAgentResultState(result),
        resumeId: childSessionId,
      });
  if (!result.suspension) return summary;
  const requestedInput = result.suspension.reason === "question"
    ? result.suspension.prompt ?? "answer the sub-agent question"
    : "send any message to continue, or treat this partial result as done";
  return `${summary}\n\n[Input required: ${requestedInput}]`;
}

function createBackgroundResultMessage(
  result: SubAgentTerminalOutcome,
  parentSessionId: string,
  spawnId: string,
  // Use the authorized child link that delivery addresses.
  childSessionId: string,
): A2AMessage {
  const suspension = result.suspension;
  return {
    messageId: createDlpSafeUuid(),
    role: A2A_ROLE_AGENT,
    parts: [{ text: backgroundResultText(result, childSessionId) }],
    contextId: parentSessionId,
    taskId: childSessionId,
    metadata: {
      taskState: projectSubAgentResultState(result),
      spawnId,
      ...(suspension
        ? {
            suspension: {
              reason: suspension.reason,
              resumeId: suspension.resumeId,
              ...(suspension.prompt ? { prompt: suspension.prompt } : {}),
            },
          }
        : {}),
    },
  };
}

export type AgentSpawnEvent = SharedAgentSpawnEvent<ChatEntry>;

export interface AgentSpawnToolDeps {
  getRunner: () => SubAgentRunner | undefined;
  getAgentProfile?: (name: string) => Promise<LoadedAgentProfile | null>;
  emit: (event: AgentSpawnEvent) => void;
}

export function createAgentSpawnTool(deps: AgentSpawnToolDeps): Tool {
  return createDynamicTool({
    name: "agent_spawn",
    description: t("be_agentSpawn.toolDescription"),
    source: "builtin",
    category: "meta",
    decisionOverride: "ask",
    parallelSafe: true,
    // Scale the ceiling with the uncapped user round budget; without a runner, retain the minimum bound.
    resolveHostCeilingMs: () =>
      resolveSubAgentCeilingMs(
        deps.getRunner()?.roundBudget() ?? SUBAGENT_MAX_ROUNDS_DEFAULT,
      ),
    jsonSchema: {
      type: "object",
      required: ["instructions"],
      properties: {
        title: {
          type: "string",
          description: t("be_agentSpawn.propTitleDescription"),
        },
        agentName: {
          type: "string",
          description: t("be_agentSpawn.propAgentNameDescription"),
        },
        instructions: {
          type: "string",
          description: t("be_agentSpawn.propInstructionsDescription"),
        },
        sourceTools: {
          type: "array",
          items: { type: "string" },
          description: t("be_agentSpawn.propSourceToolsDescription"),
        },
        resumeId: {
          type: "string",
          description: t("be_agentSpawn.propResumeIdDescription"),
        },
        background: {
          type: "boolean",
          description: "Deprecated and ignored: sub-agents always run in the background on surfaces that can deliver their results. You receive a run handle immediately; results arrive as parent messages, and agent_status inspects progress.",
        },
      },
    },
    execute: async (rawInput, ctx) => {
      // Refuse nested spawning even if registry filtering accidentally exposes the tool to a child.
      const depth = typeof ctx.metadata?.spawnDepth === "number"
        ? (ctx.metadata.spawnDepth as number)
        : 0;
      if (depth >= 1) {
        return {
          output: JSON.stringify({
            error: "agent_spawn cannot be invoked from a sub-agent",
            taskState: projectSubAgentRunState("rejected"),
          }),
          isError: true,
        };
      }
      // Require an originating conversation to own progress frames and child approvals.
      const originSessionId =
        typeof ctx.metadata?.sessionId === "string" ? ctx.metadata.sessionId : undefined;
      if (originSessionId === undefined) {
        return {
          output: JSON.stringify({
            error: "agent_spawn requires a conversation in context",
            taskState: projectSubAgentRunState("rejected"),
          }),
          isError: true,
        };
      }
      const a = (rawInput ?? {}) as Record<string, unknown>;
      // Use background execution only when results can reach the parent, keeping parent-child messaging live.
      // Windowless owners keep children inline so authorization terminal control can settle before the next parent round.
      const background = ctx.metadata?.supportsA2AParentDelivery === true
        && ctx.metadata?.approvalSurface !== "unavailable";
      const runner = deps.getRunner();
      if (!runner) {
        return {
          output: JSON.stringify({
            error: "agent_spawn runner not configured",
            taskState: projectSubAgentRunState("error"),
          }),
          isError: true,
        };
      }
      const agentName = typeof a.agentName === "string" ? a.agentName.trim() : "";
      if (agentName && !AGENT_NAME_ALLOWLIST.test(agentName)) {
        return {
          output: JSON.stringify({
            error: `invalid agentName: must match ${AGENT_NAME_ALLOWLIST.source}`,
            taskState: projectSubAgentRunState("rejected"),
          }),
          isError: true,
        };
      }
      const profile = agentName && deps.getAgentProfile
        ? await deps.getAgentProfile(agentName)
        : null;
      if (agentName && !profile) {
        return {
          output: JSON.stringify({ error: `agent profile not found: ${agentName}`, taskState: projectSubAgentRunState("rejected") }),
          isError: true,
        };
      }
      const title = typeof a.title === "string" && a.title.trim()
        ? a.title.trim()
        : profile?.name ?? "";
      const instructions =
        typeof a.instructions === "string" ? a.instructions.trim() : "";
      // Resume uses persisted profile and frozen tool scope without re-granting permission; title is optional.
      const resumeId = typeof a.resumeId === "string" && a.resumeId.trim()
        ? a.resumeId.trim()
        : undefined;

      if (!instructions || (!resumeId && !title)) {
        return {
          output: JSON.stringify({
            error: "instructions are required; title is required when agentName is not provided (unless resumeId is set)",
            taskState: projectSubAgentRunState("rejected"),
          }),
          isError: true,
        };
      }
      // Resolve scope once: explicit usable names, then profile scope, then the parent's registry.
      const requestedSourceTools = Array.isArray(a.sourceTools)
        ? (a.sourceTools as unknown[]).filter(
            (t): t is string => typeof t === "string" && t.trim().length > 0,
          )
        : [];
      const toolScope: SubAgentToolScope = requestedSourceTools.length > 0
        ? exactToolScope(requestedSourceTools)
        : profile?.sourceTools && profile.sourceTools.length > 0
          ? exactToolScope(profile.sourceTools)
          : PARENT_ALL_TOOL_SCOPE;
      const toolUseId =
        typeof ctx.metadata?.toolUseId === "string"
          ? (ctx.metadata.toolUseId as string)
          : undefined;
      // Stamp every frame with its originating conversation so only the owning tile retains it.
      const emit = (event: Omit<AgentSpawnEvent, "parentSessionId">) =>
        deps.emit({ ...event, parentSessionId: originSessionId });
      const spawnId = createDlpSafeUuid();
      const initialTaskState = resumeId
        ? projectSubAgentRunState("waiting")
        : projectSubAgentRunState("submitted");
      const promptPayload = instructions ? { instructions } : {};
      // onLinked authorizes delivery only after origin and durable INPUT_REQUIRED checks.
      let linkedChildSessionId: string | undefined;
      const linkedPayload = () => linkedChildSessionId ? { childSessionId: linkedChildSessionId } : {};
      let terminalFrameEmitted = false;
      // Emit terminal frames once, using only the authorized link, with the terminal-state write.
      // Throws outside tracked completion use this same latched helper to close the panel without duplicate frames.
      const emitTerminalFrame = (result: SubAgentTerminalOutcome) => {
        const taskState = projectSubAgentResultState(result);
        const status = subAgentRunStatusFromTaskState(taskState);
        if (terminalFrameEmitted) return { taskState, status };
        terminalFrameEmitted = true;
        if (status === "error") {
          emit({
            spawnId,
            type: "error",
            taskState,
            status,
            message: result.error ?? result.summary,
            entries: result.entries,
            ...promptPayload,
            ...linkedPayload(),
          });
        } else {
          emit({
            spawnId,
            type: "done",
            taskState,
            status,
            ...(result.suspension ? { suspension: result.suspension } : {}),
            summary: result.summary,
            toolCallCount: result.toolCallCount,
            entries: result.entries,
            ...promptPayload,
            ...linkedPayload(),
          });
        }
        return { taskState, status };
      };
      emit({
        spawnId,
        type: "start",
        taskState: initialTaskState,
        title,
        toolUseId,
        ...promptPayload,
      });
      try {
        let markSetupReady!: () => void;
        const setupReady = new Promise<void>((resolve) => {
          markSetupReady = resolve;
        });
        const callbacks = {
          onLinked: ({ childSessionId }: { childSessionId: string }) => {
            linkedChildSessionId = childSessionId;
            emit({
              spawnId,
              type: "activity" as const,
              taskState: resumeId
                ? projectSubAgentRunState("waiting")
                : projectSubAgentRunState("submitted"),
              childSessionId,
              ...promptPayload,
            });
          },
          onActivity: (u: { entries: ChatEntry[]; toolCallCount: number }) =>
            emit({
              spawnId,
              type: "activity" as const,
              taskState: projectSubAgentRunState("running"),
              entries: u.entries,
              toolCallCount: u.toolCallCount,
              ...promptPayload,
              ...linkedPayload(),
            }),
          onReady: () => markSetupReady(),
          // onError is diagnostic; only onTerminal emits alongside the runner's terminal-state write.
          onTerminal: (result: SubAgentSpawnResult) => {
            emitTerminalFrame(result);
          },
        };
        // Resume restores persisted profile and scope; tool arguments cannot re-scope the child.
        const run = async () => resumeId
          ? await runner.resume(
              resumeId,
              instructions,
              title,
              callbacks,
              originSessionId,
              spawnId,
              background,
            )
          : await runner.spawn(
              {
                title,
                instructions: profile
                  ? renderAgentProfilePrompt(profile, instructions)
                  : instructions,
                // Parent adjudication needs the original task text before the profile charter is rendered around it.
                parentAuthoredTask: instructions,
                spawnId,
                toolUseId,
                toolScope,
                originSessionId,
                background,
                projectRoot: ctx.cwd,
                // Resolve profile model tiers against the active provider; absence inherits the parent model.
                profileModel: profile?.model,
                // Profile mode adds working posture and skill guidance; absence leaves the default inert.
                profileMode: profile?.mode,
              },
              callbacks,
            );
        if (background) {
          let terminalized = false;
          const terminalize = async (result: SubAgentTerminalOutcome): Promise<void> => {
            if (terminalized) return;
            terminalized = true;
            const authorizedChildSessionId = linkedChildSessionId;
            emitTerminalFrame(result);

            if (
              !authorizedChildSessionId
              || result.suspension?.reason === "question"
            ) {
              return;
            }
            const parentSessionId = originSessionId ?? "";
            try {
              await runner.deliverToParent(
                {
                  parentSessionId,
                  childSessionId: authorizedChildSessionId,
                  message: createBackgroundResultMessage(
                    result,
                    parentSessionId,
                    spawnId,
                    authorizedChildSessionId,
                  ),
                },
                // Track completion-report delivery so a report read through agent_status is not replayed as steering.
                { terminalReport: true },
              );
            } catch {
              // Delivery owns its audit path. The renderer terminal state is final.
            }
          };
          // The terminal latch prevents duplicates and withholds delivery when no authorized child link exists.
          const terminalizeRejection = async (err: unknown): Promise<void> => {
            const message = (err as Error).message ?? "agent_spawn failed";
            await terminalize({
              summary: message,
              error: message,
              toolCallCount: 0,
              turnCount: 0,
              childSessionId: linkedChildSessionId,
              entries: [],
              ok: false,
            });
          };

          const backgroundRun = run();
          void backgroundRun.then(terminalize, terminalizeRejection);
          // Publish resumed handles only after child-lease ownership and WORKING state, never from a prior WAITING snapshot.
          if (resumeId) {
            await Promise.race([
              setupReady,
              backgroundRun.then(() => undefined, () => undefined),
            ]);
          }
          const handleTaskState = originSessionId
            && typeof runner.getRunStatus === "function"
            ? runner.getRunStatus(spawnId, originSessionId)?.taskState ?? initialTaskState
            : initialTaskState;
          return {
            output: JSON.stringify({
              spawnId,
              status: subAgentRunStatusFromTaskState(handleTaskState),
              taskState: handleTaskState,
              background: true,
              ...(resumeId ? { resumeId } : {}),
              ...(linkedChildSessionId ? { childSessionId: linkedChildSessionId } : {}),
              agentName: profile?.name,
            }),
            isError: false,
          };
        }

        const result = await run();
        // FAILED and REJECTED remain errors even when runTurn returns a result.
        const { taskState, status } = emitTerminalFrame(result);
        const authorizationRequired = authorizationRequiredStateForOutput(
          result.authorizationRequired,
        );
        if (authorizationRequired) {
          return {
            output: JSON.stringify({
              error: "sub-agent requires user authorization",
              taskState,
              stopReason: "authorization-required",
            }),
            isError: true,
            authorizationRequired: issueAuthorizationRequiredControl(
              authorizationRequired,
            ),
          };
        }
        if (status === "error") {
          // Preserve the same child for authorized resume failures; only transient causes invite identical retries.
          // Host refusals are permanent, while deterministic remote rejection requires changed request conditions.
          const resumeFields = ((): Record<string, unknown> => {
            switch (result.resumeRefusal) {
              case "exhausted":
                return {
                  resumeRefusal: "exhausted",
                  resumeGuidance: t("be_agentSpawn.resumeExhaustedGuidance"),
                };
              case "invalid":
                return {
                  resumeRefusal: "invalid",
                  resumeGuidance: t("be_agentSpawn.resumeInvalidGuidance"),
                };
              case undefined:
                if (resumeId !== undefined) {
                  return { resumeId, ...resumeRanGuidance(result.error ?? result.summary) };
                }
                // Failed fresh runs never suspended and must not advertise a resumeId; report the child and whether the cause can change.
                // Exclude host-blocked runs: they never started and are policy refusals, not provider failures.
                if (result.stopReason === "blocked") return {};
                return {
                  ...(linkedChildSessionId ? { childSessionId: linkedChildSessionId } : {}),
                  freshSpawnFailed: true,
                  ...(isDeterministicProviderRequestRejection(result.error ?? result.summary)
                    ? { spawnDeterministicFailure: true, spawnGuidance: t("be_agentSpawn.freshSpawnRejectedGuidance") }
                    : { spawnGuidance: t("be_agentSpawn.freshSpawnFailedGuidance") }),
                };
            }
          })();
          return {
            output: JSON.stringify({
              error: result.error ?? result.summary,
              taskState,
              ...resumeFields,
            }),
            isError: true,
          };
        }
        return {
          output: JSON.stringify({
            summary: result.summary,
            toolCallCount: result.toolCallCount,
            turnCount: result.turnCount,
            spawnId,
            agentName: profile?.name,
            childSessionId: result.childSessionId,
            taskState,
            ...(result.stopReason ? { stopReason: result.stopReason } : {}),
            ...(result.suspension ? { suspension: result.suspension } : {}),
            ...(result.incomplete
              ? {
                  incomplete: true,
                  // Include the ID in prose for callers that do not inspect sibling fields.
                  incompleteReason: t("be_agentSpawn.incompleteNotice", {
                    resumeId: result.childSessionId,
                  }),
                  resumeId: result.childSessionId,
                }
              : {}),
          }),
          isError: false,
        };      } catch (err) {
        const message = (err as Error).message ?? "agent_spawn failed";
        // Untracked throws still need a terminal frame; the shared latch suppresses duplicates.
        const { taskState } = emitTerminalFrame({
          summary: message,
          error: message,
          toolCallCount: 0,
          turnCount: 0,
          ...(linkedChildSessionId ? { childSessionId: linkedChildSessionId } : {}),
          entries: [],
          ok: false,
        });
        return {
          output: JSON.stringify({
            error: message,
            taskState,
            // Throws do not exhaust the resume chain; retryability still depends on whether the remote request was refused.
            ...(resumeId ? { resumeId, ...resumeRanGuidance(message) } : {}),
          }),
          isError: true,
        };
      }
    },
  });
}

export function createAgentStatusTool(deps: Pick<AgentSpawnToolDeps, "getRunner">): Tool {
  return createDynamicTool({
    name: "agent_status",
    // Describe persisted-child lookup before an empty live-run list can be mistaken for completed work.
    description: t("be_agentSpawn.statusToolDescription"),
    source: "builtin",
    // Host-scoped status polling is a builtin read, not meta control flow, so cross-agent report paging can auto-review.
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "spawnId or childSessionId to inspect. Omit to list tracked runs.",
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const runner = deps.getRunner();
      if (!runner) {
        return {
          output: JSON.stringify({ error: "agent_status runner not configured" }),
          isError: true,
        };
      }
      const originSessionId =
        typeof ctx.metadata?.sessionId === "string"
          ? (ctx.metadata.sessionId as string)
          : "";
      if (!originSessionId) {
        return {
          output: JSON.stringify({ error: "agent_status requires a session id" }),
          isError: true,
        };
      }
      const input = (rawInput ?? {}) as Record<string, unknown>;
      const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : "";
      // Full snapshot reads retire duplicate mailbox reports through host bookkeeping, preserving the read category.
      if (id) {
        const run = runner.getRunStatus(id, originSessionId, {
          deliversReportToParent: true,
        });
        return {
          output: JSON.stringify(run ? { run } : { error: `sub-agent run not found: ${id}` }),
          isError: !run,
        };
      }
      const runs = runner.listRunStatuses(originSessionId, {
        deliversReportToParent: true,
      });
      // Live runs vanish on restart; direct callers to agent_list for persisted children and resume IDs.
      const restoredCount = runs.length === 0
        ? runner.listPersistedSpawnsForOrigin(originSessionId).length
        : 0;
      return {
        output: JSON.stringify({
          runs,
          ...(restoredCount > 0
            ? {
                restoredSubAgentsHint: t("be_agentSpawn.statusRestoredHint", {
                  count: String(restoredCount),
                }),
              }
            : {}),
        }),
        isError: false,
      };
    },
  });
}

export function createAgentInterruptTool(deps: Pick<AgentSpawnToolDeps, "getRunner">): Tool {
  return createDynamicTool({
    name: "agent_interrupt",
    description: "Request interruption of a running sub-agent by spawnId or childSessionId.",
    source: "builtin",
    category: "meta",
    decisionOverride: "ask",
    jsonSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "spawnId or childSessionId for the running sub-agent.",
        },
        reason: {
          type: "string",
          description: "Short reason for interrupting the sub-agent.",
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const runner = deps.getRunner();
      if (!runner) {
        return {
          output: JSON.stringify({ error: "agent_interrupt runner not configured" }),
          isError: true,
        };
      }
      const originSessionId =
        typeof ctx.metadata?.sessionId === "string"
          ? (ctx.metadata.sessionId as string)
          : "";
      if (!originSessionId) {
        return {
          output: JSON.stringify({ error: "agent_interrupt requires a session id" }),
          isError: true,
        };
      }
      const input = (rawInput ?? {}) as Record<string, unknown>;
      const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : "";
      if (!id) {
        return {
          output: JSON.stringify({ error: "id is required" }),
          isError: true,
        };
      }
      const result = runner.interruptRun(id, originSessionId);
      return {
        output: JSON.stringify(result),
        isError: !result.ok,
      };
    },
  });
}
