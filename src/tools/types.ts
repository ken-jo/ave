/**
 * Shared tool governance types. Single source of truth — referenced by
 * every module in src/tools/, the registry, the executor, the permission
 * manager, the MCP layer, and plugin registration.
 *
 * This module deliberately contains only data types + the pure
 * {@link trustFromSource} mapping. No classes, no registry, no
 * side effects. Import here when you need to:
 *   - Tag a tool with its origin (builtin/plugin/mcp).
 *   - Translate source → trust (§6.4 governance).
 *   - Describe the per-invocation execution context / result shape.
 *   - Carry §6.3 Layer 1 deny rules through the registry.
 */
import type { ChatInputOrigin } from "../shared/chat-origin.js";
import type { ToolCategory, ToolSource } from "../shared/permission-review-status.js";

// Owned by `shared/permission-review-status.ts` so renderer/lib code can name them without depending on the tools domain; re-exported here for tools callers.
export type { ToolCategory, ToolSource };
import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import type { HostShellExecutionPermit } from "../permissions/host-shell-execution-permit.js";
import type { ExecutionGrant } from "../permissions/execution-router.js";
export type TrustLevel = "high" | "medium" | "low";

/** Builtin meta overrides either ask normally or execute an already-interactive question with audit; never add a second approval for asking the user. */
export type ToolDecisionOverride = "always-allow-with-audit" | "ask";

/** Derive trust origin at the concrete model/tool boundary, not from typed turn input or app claims.
 * Propagate it through audit, approval, reviewer prompts, and cache identity so trusted verdicts cannot authorize untrusted content. */
export type ToolTrustOrigin = ChatInputOrigin;

/** Source trust decreases from builtins to plugins to external servers.
 * Registered tool names use the manifest-mirrored underscore grammar; names remain verbatim except governance prefixes, while remote runtimes own their separate wire grammars. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isValidToolName(name: unknown): name is string {
  return typeof name === "string" && TOOL_NAME_PATTERN.test(name);
}

export function trustFromSource(source: ToolSource): TrustLevel {
  switch (source) {
    case "builtin":
      return "high";
    case "plugin":
      return "medium";
    case "mcp":
      return "low";
  }
}

/** Per-invocation execution context threaded through the §4.5.6 tool executor pipeline. `cwd` is the session
 * working directory enforced by the sandbox path validator; `metadata` is a free-form bag for hooks and future plumbing. */
export interface ToolExecutionContext {
  cwd: string;
  /** Host-derived execution surface; UI-opening tools must refuse unattended calls. */
  headless?: boolean;
  /** Host-built per-hop permission gate for mediated network requests. */
  authorizeNetworkTarget?: (url: URL) => Promise<void>;
  /** User-authorized filesystem roots beyond `cwd` for this invocation. The executor derives this once from `permissions.additionalDirectories` and
   * every native file/shell tool reuses the same extra scope for its internal sandbox check. The full allow-list is `cwd ∪ extraAllowedDirectories`. */
  extraAllowedDirectories: readonly string[];
  /** `permissions.blockReadsOutsideWorkingDirectories`; re-fence READ-tier path operands to the same allow-list writes are confined to. Threaded here because a shell tool re-runs the path policy on its own execution surface, and
   * running it with a different answer than the permission layer used would refuse at execute time exactly what the executor had just admitted. Absent is the shipped policy; reads are not confined; the setting ships off and has no UI. */
  blockReadsOutsideWorkingDirectories?: boolean;
  /**
   * Owner plugin sandbox root (`~/.ave/plugins/<pluginId>/`) when the
   * invoking tool is plugin-owned, else undefined for builtins. Threaded
   * from the executor so the OS sandbox write-jail (see
   * {@link ../permissions/sandbox-write-jail.js deriveSandboxWritePaths})
   * can confine writes to the plugin's namespace rather than the bare cwd.
   */
  ownerPluginSandboxRoot?: string;
  /** Host-generated once before permission processing for builtin bash/PowerShell. Tool code must use this plan rather than recomputing a late fallback. */
  hostShellExecutionPlan?: HostShellExecutionPlan;
  /** Host-private, immutable, one-shot proof of the route selected for this exact shell action. It is created
   * after authorization and never originates in model input, plugin arguments, renderer payloads, or persisted state. */
  executionRouteGrant?: ExecutionGrant;
  preparedShellInvocation?: import("./prepared-shell-invocation.js").PreparedShellInvocation;
  /** Host-private: the route sealed for a command typed into the user's own host terminal. `recheck` re-proves, before each write to that
   * terminal, that the route is still the host and its path-policy relaxations are the ones the permission decision saw; it throws otherwise. */
  hostTerminalRoute?: { recheck(): Promise<void> };
  /** Host-issued native image and environment proof for this exact shell invocation. */
  verifiedShellCommand?: import("../permissions/verified-shell-command.js").VerifiedShellCommand;
  /** Opaque one-shot approval proof for a requested-sandbox plain-shell fallback. It is minted only after allow-once and is consumed by bash/PowerShell. */
  hostShellExecutionPermit?: HostShellExecutionPermit;
  /** Per-invocation bookkeeping the executor threads to tools. `sessionId` is declared OPTIONAL on purpose: an invocation can be raised with no conversation behind it, and tools that cannot function unattributed
   * (`ask_user_question`, `skill_load`, `session_tasks`) refuse when it is missing. The executor therefore omits the key rather than substituting a placeholder, which would make every one of those refusals unreachable. */
  metadata: { sessionId?: string } & Record<string, unknown>;

  abortSignal?: AbortSignal;
}

/** An image a tool returns for the model to SEE (e.g. `view_image`). Carried on a sibling field of {@link ToolExecutionResult} so `output` stays a plain-text placeholder for every string-only consumer
 * (token estimation, persistence, renderer replay). Each transport maps the retained image to its native visual input while preserving the source tool result. `data` is raw base64 without a `data:` URL prefix. */
export interface ToolResultImage {
  data: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes?: number;
}

/** Canonical tool return shape. Executor Step 6 expects this triple and maps it to the tool_use_id-scoped LLM response + audit entry in Step 8. Tools
 * return `isError: true` for normal failures instead of throwing; throws are caught by the executor and surfaced as `is_error` tool results in the same way. */
export interface ToolExecutionResult {
  output: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
  /** Optional image for the model to see; see {@link ToolResultImage}. */
  image?: ToolResultImage;
  /** Host-private terminal control emitted by a trusted builtin. The executor accepts only controls
   * minted by the host; structural values returned by a plugin, MCP server, or test double are ignored. */
  authorizationRequired?: import("../shared/authorization-required.js").AuthorizationRequiredControl;
}

/** §6.3 Layer 1 deny rule. When a rule matches a tool name the tool is hidden from {@link
 * ToolRegistry.getVisibleTools} entirely; the LLM never sees its existence, which is the architectural security boundary for blocked tools. */
export interface DenyRule {
  /** Glob-like pattern: "meeting.*", "*.delete" */
  pattern: string;
}
