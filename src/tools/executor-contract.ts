import type { ReplayRootBinding } from "../permissions/reviewer/replay-root-binding.js";
import type { PermissionDecisionRequest } from "../permissions/decision-pipeline.js";
import type { A2AAgentCausalContext } from "../engine/a2a-agent-message-envelope.js";
import type { RemoteControllerAuthority } from "../shared/chat-origin.js";
import type {
  ApprovalSurface,
  AuthorizationRequiredControl,
} from "../shared/authorization-required.js";
import type { McpUiPayload } from "../mcp/types.js";
import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import type { DisposableSubstrate } from "../permissions/sandbox-capability.js";
import type { PluginOperationPrincipal } from "../permissions/plugin-operation-grant.js";
import type { PermissionReviewEvent } from "../shared/permission-review-status.js";
import type { ApprovalMemory } from "../shared/permissions-events.js";
import type { ToolOutputCaptureFactory } from "../shared/tool-output-artifact.js";
import type { RationaleExecutorControlOutcome } from "./pipeline/rationale-pr1-contract.js";
import type { RationaleHostRuntime } from "./pipeline/rationale-orchestrator.js";
import type { RationaleResumeHostRuntime } from "./pipeline/rationale-resume-runner.js";
import type { PluginOperationInvocationContext } from "./plugin-operation-governance.js";
import type { ToolResultChunkReader } from "./tool-result-chunk.js";
import type {
  ToolCategory,
  ToolResultImage,
  ToolSource,
  ToolTrustOrigin,
} from "./types.js";

export interface ToolCallMeta {
  groupId: string;
  toolUseId: string;
  displayOrder: number;
  source?: ToolSource;
  category?: ToolCategory;
  pluginId?: string;
  workerId?: string;
  mcpServerId?: string;
  /** Renderer-safe shell projection; never the raw capability or permit. */
  executionPlan?: HostShellExecutionPlanAuditProjection;
  // Renderer-only cancellation marker; model-facing is_error stays true because tool results have no cancellation state.
  cancelled?: boolean;
}

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  outputArtifact?: import("../shared/tool-output-artifact.js").ToolOutputArtifactInfo;
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  uiPayload?: McpUiPayload;
  /** Host-internal raw tool result for non-LLM plugin invocation surfaces. */
  rawResult?: unknown;
  image?: ToolResultImage;
  /** Host-issued renderer-safe shell substrate projection. */
  executionPlan?: HostShellExecutionPlanAuditProjection;
  /** Host-private terminal control. Structural lookalikes are ignored. */
  authorizationRequired?: AuthorizationRequiredControl;
  /** Wall-clock pipeline duration, including every terminal path. */
  durationMs: number;
}

export interface ToolExecutorCallbacks {
  onToolStart?: (name: string, input: Record<string, unknown>, meta: ToolCallMeta) => void;
  // Coalesced, capped display output; final results still arrive through onToolEnd.
  onToolOutput?: (name: string, text: string, meta: ToolCallMeta) => void;
  onPermissionReview?: (event: PermissionReviewEvent) => void;
  onToolEnd?: (
    name: string,
    result: string,
    isError: boolean,
    meta: ToolCallMeta,
    uiPayload: McpUiPayload | undefined,
    durationMs: number,
  ) => void;
}

export interface ToolPermissionContext {
  /** The host prepared a request-scoped rationale runtime for this invocation. */
  rationaleAvailable?: boolean;
  /** A fresh user-requested replay still passes every admission and forced floor. */
  manualRerun?: boolean;
  /** Host provenance; never inferred from argument text. */
  otherPrincipal?: boolean;
  admissionDenial?: PermissionDecisionRequest["admissionDenial"];
  floor?: PermissionDecisionRequest["floor"];
  paths?: PermissionDecisionRequest["paths"];
  secretRead?: boolean;
  headless?: boolean;
  // Native --exec uses headless review but honors the local owner's explicit rules and durable grants first.
  ownerUnattended?: boolean;
  /** Host-owned UI capability, independent of routine/headless tool scope. */
  approvalSurface?: ApprovalSurface;
  allowedPluginIds?: ReadonlySet<string>;
  /** Derived only after hooks finalize the invocation arguments. */
  approvalCacheKey?: string;
  /** What a remembered decision is keyed on; host-derived with approvalCacheKey. */
  approvalMemory?: ApprovalMemory;
  /** Configured project roots only; excludes implicit temp, app-data and scratch grants. */
  projectDirectories?: readonly string[];
  /** Snapshot of user-configured Layer 1 roots. */
  additionalDirectories?: readonly string[];
  /** Fresh accessor used to observe earlier grants in an ordered batch. */
  getAdditionalDirectories?: () => readonly string[];
  trustOrigin: ToolTrustOrigin;
  /** Immutable host-owned remote-controller authority; never a tool or wire field. */
  remoteControllerAuthority?: RemoteControllerAuthority;
  // Host-selected guest for grading process and filesystem effects; never supplied by tools or wire data.
  disposableSubstrate?: DisposableSubstrate;
  /** Direct plugin panel/renderer user activation marker. */
  pluginPanelUserAction?: boolean;
  /** Host-derived app identity and optional opaque one-shot grant. Never copied into tool metadata. */
  pluginOperation?: PluginOperationInvocationContext;
  /** Host-owned stale-card binding checked against the final resolved registry Tool. */
  expectedMcpServerId?: string;
  /** Recent user-authored intent for reviewer context only. */
  userIntent?: string;
  /** Current assistant step observed by the host; context for logical review, never a grant. */
  currentTaskStep?: string;
  // Host-detected permission-store corruption; never a tool or wire field.
  permissionStoreError?: string;
  onTurnDirectoryGrant?: (approvedDirectory: string) => void;
  onSessionDirectoryGrant?: (approvedDirectory: string) => void;
}

// Host-private auth lifecycle must never be visible or supplied through plugin permission data.
// Run beforeHandler at the final no-await authorization boundary and settle before releasing the operation lease.
export interface HostPluginAuthLifecycle {
  readonly binding: Readonly<{
    pluginId: string;
    generationId: string;
    toolName: string;
    appSessionId: string;
    accountScopeHash: string;
  }>;
  beforeHandler(
    principal: PluginOperationPrincipal,
    domainKey: string,
  ): void;
  completeSuccess(rawResult: unknown): void;
  completeFailure(reason: unknown): void;
}

export interface ExecuteOptions {
  callbacks?: ToolExecutorCallbacks;
  /** Final model-facing result, after invocation cleanup; awaited before ordered execution continues. */
  onToolResult?: (result: ToolResult) => void | Promise<void>;
  sessionId?: string;
  overlayTriggerOrigin?: string | null;
  spawnDepth?: number;
  // Default-project memory selection includes unscoped legacy notes; memory tools must use the same set.
  memoryIncludeUnscoped?: boolean;
  supportsA2AParentDelivery?: boolean;
  approvalReasonPrefix?: string;
  a2aCausalContext?: A2AAgentCausalContext;
  abortSignal?: AbortSignal;
  toolResultChunkReader?: ToolResultChunkReader;
  toolOutputCaptureFactory?: ToolOutputCaptureFactory;
  permissionContext?: ToolPermissionContext;
  executionCwd?: string;
  /** Host-issued replay invalidation check; never a permission grant or wire input. */
  replayRootBinding?: ReplayRootBinding;
  /** Host-only lifecycle for an exact governed auth Tool; never plugin data. */
  pluginAuthLifecycle?: HostPluginAuthLifecycle;
}

export interface ConversationExecuteOptions extends ExecuteOptions {
  executionCwd: string;
}

export type InterceptedMetaToolHandler = (
  toolUse: ToolUseBlock,
) => Promise<ToolResult | null>;

export interface ConversationBatchExecuteOptions extends ConversationExecuteOptions {
  rationaleRuntime?: RationaleHostRuntime;
  interceptedMetaToolHandler?: InterceptedMetaToolHandler;
}

export interface RationaleResumeExecuteOptions extends ConversationExecuteOptions {
  rationaleResumeRuntime?: RationaleResumeHostRuntime;
}

export type ConversationBatchExecutionOutcome =
  | {
      outcome: "completed";
      results: ToolResult[];
    }
  | {
      outcome: "rationale-required";
      completedResults: ToolResult[];
      control: RationaleExecutorControlOutcome;
    };

export const RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT =
  "Rationale-authorized action ran, but its terminal audit could not be committed. " +
  "The execution outcome is unknown; the action will not be retried automatically.";
