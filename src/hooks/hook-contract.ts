import type {
  HookEvent,
  LifecycleEventPayload,
  LifecycleHookEvent,
  ScriptHookInvocationResult,
  ScriptHookStdin,
} from "./script-hook-types.js";

/**
 * The feedback a Stop/SubagentStop chain asks the run to continue with, or
 * undefined. The chain stops at its first denial, so only that last result can
 * carry a deliberate block; failures never continue the run.
 */
export function stopHookBlockFeedback(result: {
  decision: "allow" | "deny";
  results: readonly Pick<ScriptHookInvocationResult, "blockFeedback">[];
}): string | undefined {
  if (result.decision !== "deny") return undefined;
  return result.results.at(-1)?.blockFeedback;
}

/** Ave's compaction reason as the reference's `trigger` value. */
function compactTrigger(reason: string | undefined): "manual" | "auto" | undefined {
  if (reason === undefined) return undefined;
  return reason === "manual" ? "manual" : "auto";
}

/**
 * The value a lifecycle hook's matcher is tested against. It follows the Claude
 * Code hooks reference where Ave has the value: the tool name, the compaction
 * trigger, the agent type, or Ave's SessionEnd reason. Events without such a
 * value in Ave (SessionStart, Notification, Stop) keep matching the session ID.
 */
export function lifecycleMatcherSubject(
  event: LifecycleHookEvent,
  sessionId: string,
  payload: LifecycleEventPayload,
): string {
  switch (event) {
    case "PostToolUseFailure":
    case "PermissionDenied":
      return payload.toolName ?? "";
    case "PreCompact":
    case "PostCompact":
      return compactTrigger(payload.reason) ?? "";
    case "SubagentStart":
    case "SubagentStop":
      return payload.agentType ?? "";
    case "SessionEnd":
      return payload.reason ?? "";
    default:
      return sessionId;
  }
}

/** Public configuration keys; internal tool aliases remain stable for audit readers. */
export const HOOK_EVENT_TYPES = {
  PreToolUse: "pre",
  PostToolUse: "post",
  PermissionRequest: "perm",
  UserPromptSubmit: "UserPromptSubmit",
  PostToolUseFailure: "PostToolUseFailure",
  PermissionDenied: "PermissionDenied",
  SessionStart: "SessionStart",
  SessionEnd: "SessionEnd",
  Notification: "Notification",
  Stop: "Stop",
  PreCompact: "PreCompact",
  PostCompact: "PostCompact",
  SubagentStart: "SubagentStart",
  SubagentStop: "SubagentStop",
} as const satisfies Record<string, HookEvent>;

export type HookEventName = keyof typeof HOOK_EVENT_TYPES;

export function hookEventName(event: HookEvent): HookEventName {
  switch (event) {
    case "pre": return "PreToolUse";
    case "post": return "PostToolUse";
    case "perm": return "PermissionRequest";
    default: return event;
  }
}

interface ToolJsonFields {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** Event-specific JSON fields. Unavailable optional data is omitted, never invented. */
interface HookJsonFields {
  PreToolUse: ToolJsonFields;
  PostToolUse: ToolJsonFields & { tool_response?: string; is_error?: boolean };
  PermissionRequest: ToolJsonFields;
  UserPromptSubmit: { prompt: string };
  PostToolUseFailure: { tool_name?: string; error?: string; duration_ms?: number };
  PermissionDenied: { tool_name?: string; deny_reason?: { layer: number | undefined; source: string; reason?: string } };
  SessionStart: { session_meta?: Record<string, unknown> };
  SessionEnd: { reason?: string; session_meta?: Record<string, unknown>; stop_reason?: string };
  Notification: { message?: string };
  Stop: { stop_reason?: string; tool_count?: number; duration_ms?: number; stop_hook_active?: boolean };
  PreCompact: { reason?: string; trigger?: "manual" | "auto"; token_estimate?: number };
  PostCompact: { trigger?: "manual" | "auto"; messages_before?: number; messages_after?: number; tokens_before?: number; tokens_after?: number };
  SubagentStart: { agent_id?: string; agent_type?: string };
  SubagentStop: { agent_id?: string; agent_type?: string; stop_reason?: string; stop_hook_active?: boolean };
}

export type HookJsonInput = {
  [Event in HookEventName]: {
    schema_version: 1;
    hook_event_name: Event;
    session_id: string;
    cwd: string;
  } & HookJsonFields[Event];
}[HookEventName];

/** Adds the public envelope to the redacted legacy payload at the process boundary. */
export function hookJsonInput(payload: ScriptHookStdin, cwd: string): HookJsonInput & ScriptHookStdin {
  const common = {
    ...payload,
    schema_version: 1 as const,
    session_id: payload.sessionId,
    cwd,
  };
  if (payload.hookType === "pre" || payload.hookType === "post" || payload.hookType === "perm") {
    const tool = { ...common, tool_name: payload.toolName, tool_input: payload.input };
    if (payload.hookType === "post") {
      return { ...tool, hook_event_name: "PostToolUse",
        tool_response: payload.toolOutput, is_error: payload.isError };
    }
    if (payload.hookType === "pre") return { ...tool, hook_event_name: "PreToolUse" };
    return { ...tool, hook_event_name: "PermissionRequest" };
  }
  switch (payload.hookType) {
    case "UserPromptSubmit":
      if (typeof payload.inputText !== "string") throw new Error("UserPromptSubmit requires prompt text");
      return { ...common, hook_event_name: payload.hookType, prompt: payload.inputText };
    case "PostToolUseFailure":
      return { ...common, hook_event_name: payload.hookType, tool_name: payload.toolName,
        error: payload.errorMessage, duration_ms: payload.durationMs };
    case "PermissionDenied":
      return { ...common, hook_event_name: payload.hookType, tool_name: payload.toolName, deny_reason: payload.denyReason };
    case "SessionStart":
      return { ...common, hook_event_name: payload.hookType, session_meta: payload.sessionMeta };
    case "SessionEnd":
      return { ...common, hook_event_name: payload.hookType, reason: payload.reason,
        session_meta: payload.sessionMeta, stop_reason: payload.stopReason };
    case "Notification":
      return { ...common, hook_event_name: payload.hookType, message: payload.message };
    case "Stop":
      return { ...common, hook_event_name: payload.hookType, stop_reason: payload.stopReason,
        tool_count: payload.toolCount, duration_ms: payload.durationMs, stop_hook_active: payload.stopHookActive };
    case "PreCompact":
      return { ...common, hook_event_name: payload.hookType, reason: payload.reason,
        trigger: compactTrigger(payload.reason), token_estimate: payload.tokenEstimate };
    case "PostCompact":
      return { ...common, hook_event_name: payload.hookType, trigger: compactTrigger(payload.reason),
        messages_before: payload.messagesBefore,
        messages_after: payload.messagesAfter, tokens_before: payload.tokensBefore, tokens_after: payload.tokensAfter };
    case "SubagentStart":
      return { ...common, hook_event_name: "SubagentStart", agent_id: payload.agentId, agent_type: payload.agentType };
    case "SubagentStop":
      return { ...common, hook_event_name: "SubagentStop", agent_id: payload.agentId,
        agent_type: payload.agentType, stop_reason: payload.stopReason, stop_hook_active: payload.stopHookActive };
  }
}
