// Scripts live outside app home to protect trust; pre/post/perm prefixes are frozen. Stdin/stdout use JSON: silent exit 0 succeeds, exit 2 denies with stderr, and other exits/timeouts/parse failures deny; hook allows never upgrade upstream denies and modify is unsupported (docs/architecture/permission-policy-design.md).
import type { ToolCategory, ToolSource } from "../tools/types.js";
import type { PluginHookOwner } from "./hook-registry.js";
import type { TrustOriginWithUnknown } from "../shared/chat-origin.js";

// String origins survive JSON and future additions without breaking older hooks.
export type HookTrustOrigin = TrustOriginWithUnknown;

// Legacy scripts have exactly three prefixes; lifecycle events are config-only.
export type ScriptHookType = "pre" | "post" | "perm";

// Lifecycle hooks are config-only. Observe-only denials are audit-only; UserPromptSubmit alone is blocking and fail-closed, and must use runUserPromptSubmit.
export type LifecycleHookEvent =
  | "PostToolUseFailure"
  | "PermissionDenied"
  | "SessionStart"
  | "SessionEnd"
  | "Notification"
  | "Stop"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStart"
  | "SubagentStop"
  | "UserPromptSubmit";

// A UserPromptSubmit denial refuses the turn.
export const USER_PROMPT_SUBMIT_EVENT = "UserPromptSubmit" as const;

// Keep blocking-event detection centralized so it cannot enter the observe-only path.
export function isBlockingLifecycleEvent(
  event: LifecycleHookEvent,
): event is typeof USER_PROMPT_SUBMIT_EVENT {
  return event === USER_PROMPT_SUBMIT_EVENT;
}

// Registry consumers share this union; legacy scripts retain only pre/post/perm prefixes.
export type HookEvent = ScriptHookType | LifecycleHookEvent;

// Tool and lifecycle stdin share the event/session/trust envelope; tool-only fields are absent on lifecycle payloads. Callers DLP-redact secret-bearing text before JSON serialization.
export type ScriptHookStdin = ToolHookStdin | LifecycleHookStdin;

// Callers supply sessionId and trustOrigin from upstream context.
export interface HookDispatchPayload {
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  input: Record<string, unknown>;
  sessionId: string;
  trustOrigin: HookTrustOrigin;
  // Per-request server/plugin identity lets hooks restrict exact origins; category carries the authoritative tool metadata.
  mcpServerId?: string;
  pluginId?: string;
  // PostToolUse only — output of the underlying tool call.
  toolOutput?: string;
  // PostToolUse only — true when tool errored.
  isError?: boolean;
}

export interface ToolHookStdin extends HookDispatchPayload {
  hookType: ScriptHookType;
  // Closed-set event — equals `hookType` for the tool-use surface.
  event?: HookEvent;
}

// Lifecycle payloads contain optional event-specific fields; the manager adds the common envelope and redacts free text.
export interface LifecycleEventPayload {
  // How the session entered the current conversation.
  sessionSource?: "startup" | "resume" | "clear";
  // Notification category; turn completion uses agent_completed.
  notificationType?: string;
  // PostToolUseFailure — the failing tool's name.
  toolName?: string;
  // PostToolUseFailure — tool error message (DLP-redacted before dispatch).
  errorMessage?: string;
  // PostToolUseFailure / Stop — wall-clock duration in ms.
  durationMs?: number;
  // PermissionDenied — why + where the deny was finalized (the reason identifies the finalized policy cause).
  denyReason?: { source: string; reason?: string };
  // SessionStart — non-secret session metadata (routine scope / persona).
  sessionMeta?: Record<string, unknown>;
  // Stop — terminal stop reason for the turn.
  stopReason?: string;
  // Stop — number of tool calls in the turn.
  toolCount?: number;
  // PreCompact / PostCompact — `"auto-compact"` (threshold) | `"manual"`; SessionEnd — why the session ended.
  reason?: string;
  // PreCompact — pre-compaction token estimate.
  tokenEstimate?: number;
  // PostCompact — message counts before/after compaction.
  messagesBefore?: number;
  messagesAfter?: number;
  // PostCompact — token estimates before/after compaction.
  tokensBefore?: number;
  tokensAfter?: number;
  // SubagentStart / SubagentStop — the child run id (agent_spawn spawnId).
  agentId?: string;
  // SubagentStart / SubagentStop — the child agent mode/persona.
  agentType?: string;
  // Notification — the message body shown to the user.
  message?: string;
  // Stop / SubagentStop — true while a previous stop hook block is continuing the run.
  stopHookActive?: boolean;
}

// Every trusted prompt hook receives the manager-redacted inputText; callers pass raw prompts.
export interface UserPromptSubmitPayload {
  // The user's prompt text. Matcher subject + DLP-redacted before dispatch.
  inputText: string;
  // Chat input origin (e.g. user-keyboard, plugin-emitted).
  inputOrigin?: string;
  // Resolved route for this turn (`llm` | `skill`).
  route?: string;
  // Host input classification (`general` | `command`).
  classification?: string;
}

// Lifecycle hookType and event both carry the lifecycle name; payload text arrives DLP-redacted and never uses script prefixes.
export interface LifecycleHookStdin extends LifecycleEventPayload, Partial<UserPromptSubmitPayload> {
  hookType: LifecycleHookEvent;
  // Closed-set event — equals `hookType` for the lifecycle surface.
  event: LifecycleHookEvent;
  sessionId: string;
  trustOrigin: HookTrustOrigin;
}

// Normalized result of supported stdout decision forms. The public command protocol is documented in docs/guides/user-hooks.md; mutation is unsupported.
export interface ScriptHookStdout {
  action: "allow" | "deny";
  reason: string;
  // Structured `decision: "block"` without `continue: false`; a deliberate block, not a failure.
  block?: true;
}

export interface ScriptHookInvocationResult {
  hookPath: string;
  // Lifecycle results retain their event name for audit; tool-use results retain pre/post/perm.
  hookType: HookEvent;
  decision: "allow" | "deny";
  // Always populated.
  reason: string;
  // Raw stdout (for forensics / debugging). Truncated by caller.
  rawStdout: string;
  exitCode?: number;
  timedOut: boolean;
  durationMs: number;
  // Only deliberate exit-2 or structured blocks carry continuation feedback; failures never continue Stop/SubagentStop runs.
  blockFeedback?: string;
  // Runner always populates origin so audit can distinguish scripts from config hooks.
  source: "sh" | "config";
  // Runner always populates the trusted script hash or argv hash to tie audit to executed code.
  commandIdentity: string;
  // Exact owner/version/generation/fingerprint for plugin-bundled Hooks.
  pluginOwner?: PluginHookOwner;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

// Maximum captured stdout size — defence against runaway output.
export const MAX_HOOK_STDOUT_BYTES = 16 * 1024;
