import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebContents } from "electron";
import { approvalSurfaceRegistry } from "./approval-surface-registry.js";
import { t } from "../i18n/index.js";
import { approvalActionSummary } from "../shared/approval-action-summary.js";
import { resolveConversationTitle } from "../shared/conversation-title.js";
import type { PolicyFile } from "./policy-store.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { NotificationService } from "../main/notification-service.js";
import type { ToolCategory } from "../tools/types.js";
import type { RiskVerdict } from "./reviewer/risk-classifier.js";
import type { RiskLevel, ToolSource } from "../shared/permission-review-status.js";
import {
  resolveReviewerSandboxCapability,
  type SandboxCapability,
} from "./sandbox-capability.js";
import type { PermissionEvaluationContext } from "./evaluation-context.js";
import { matchesReviewerApprovalBasis, type ReviewerApprovalBasis, type ReviewerDispatchOutcome } from "./permission-manager.js";
import { matchesApprovalRuleBasis, type ApprovalRuleBasis } from "./approval-rule-evidence.js";
import { NO_APPROVER_MESSAGE } from "./decision-pipeline.js";
import { isIssuedToolApprovalWait, withToolApprovalWait, type ToolApprovalWait } from "../tools/executor-ceiling.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import type {
  ParentEscalationNotice,
} from "../shared/parent-escalation-notice.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import { resolveUserApprovalVerdict, type ApprovalMemory } from "../shared/permissions-events.js";
import { buildHostTerminalRuleApproval, buildShellRuleApproval, type HostTerminalApprovalBinding } from "./rules/shell-rule-approval.js";
import type { ShellRuleApproval } from "../shared/permissions-events.js";
import { captureApprovalWorkingDirectory } from "./user-approval-store.js";
import type {
  RemoteControllerAuthority,
  RemoteControllerOrigin,
} from "../shared/chat-origin.js";
import {
  parseRationaleApprovalDisplay,
  type RationaleApprovalDisplay,
  sealMaskedRationaleApprovalDisplay,
} from "../shared/rationale-approval-display.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import type { ApprovalPurposeSuggestion } from "../shared/permission-review-status.js";
import {
  type HostShellExecutionPermitBinding,
} from "./host-shell-execution-permit.js";
import {
  getHostShellExecutionPlanAuditProjection,
  isIssuedHostShellExecutionPlanAuditProjection,
  parseHostShellExecutionInput,
  type HostShellExecutionPlanAuditProjection,
} from "./host-shell-execution-plan.js";
import { errorMessage } from "../shared/error-message.js";
import { isEgressGrantScope, type EgressGrantNetwork, type EgressGrantScope } from "../shared/egress-grant-scopes.js";
import { isTerminalTabId } from "../shared/tab-id.js";

// Args DLP masking

function maskArgsForDisplay(value: unknown, detections: Set<string>): unknown {
  if (typeof value === "string") {
    const { masked, detections: hits } = maskSensitiveData(value);
    for (const h of hits) detections.add(h);
    return masked;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskArgsForDisplay(v, detections));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskArgsForDisplay(v, detections);
    }
    return out;
  }
  return value;
}

function maskApprovalPurposeForDisplay(
  purpose: ApprovalPurposeSuggestion,
  detections: Set<string>,
): ApprovalPurposeSuggestion {
  const { masked, detections: hits } = maskSensitiveData(purpose.text);
  for (const hit of hits) detections.add(hit);
  return { ...purpose, text: masked };
}

// ask_all still shows the dock for read-only calls; absence uses default read auto-approval.
export type ApprovalMode = "default" | "ask_all" | "full_auto";

// Permission policy.5 — discriminated kinds for the approval dock. Default `"tool"` is the normal Layer 3 ask; `"out-of-allowed-dir"` is the Layer 1 directory-confirm variant; and `"agent-action"` is a plugin-origin host approval request that does not correspond to a host tool execution.
export type ApprovalKind =
  "tool" | "out-of-allowed-dir" | "agent-action" | "rationale" | "egress-host";

// The egress-host ask's payload (`kind: "egress-host"`): a sandboxed shell call or workspace terminal tab wants to reach `host:port`, and the person picks how long an allow lasts from `scopes`. Built by `egress-approval.ts`.
interface EgressHostApproval {
  readonly host: string;
  readonly port: number;
  // Offered scopes, narrowest first; the answer must name one of them.
  readonly scopes: readonly EgressGrantScope[];
  // `local`: this machine or a private network (loopback, RFC 1918, ULA…). `unverified`: the upstream proxy resolves the name; Ave could not check the address. For both the card warns, and only Allow once / This conversation (a terminal: This tab) are offered.
  readonly network: EgressGrantNetwork;
  // Confined terminal identity. Conversation attribution must match its main-owned delivery binding; its lifetime grant remains `tab` rather than the shell tool's `session` scope.
  readonly terminalTabId?: string;
  // The exact `Network(<host>:<port>)` host rule "Always deny" stores unless edited (owner 2026-10-25), host-derived; null for a destination the rule grammar cannot name (an address literal).
  readonly rule: string | null;
  // A shell call's working directory: where a project host rule is saved. Set only when This project is offered.
  readonly projectCwd?: string;
}

export interface ApprovalRequest {
  id: string;
  category: "tool" | "agent-action";
  // Permission policy.5 — discriminator for the renderer to pick the right card. Defaults to `"tool"` when omitted (backwards-compatible).
  kind?: ApprovalKind;
  // Choices the host will accept for this request.
  allowedChoices?: readonly ApprovalChoice[];
  // Host-derived permission to remember an exact allow for this request.
  persistentAllowAllowed?: boolean;
  // Host-derived: the exact-approval store may record a decision for this request at all (an Always deny included). False for a one-shot request, which the record handler refuses with `one-shot-not-recordable`; the card then offers no remembered choice of that store.
  exactRecordAllowed?: boolean;
  // Canonical scope captured by the host before a remembered decision is shown.
  persistentApprovalCwd?: string;
  // Host-derived command-rule editor context.
  shellRule?: ShellRuleApproval;
  toolName: string;
  // Permission policy category for the invocation shown in the UI.
  toolCategory?: ToolCategory;
  // Layer 5 reviewer verdict when the ask came from auto-review.
  reviewerVerdict?: RiskVerdict;
  // host-computed rule-classifier verdict for an unreviewed shell ask. Grades the dock's remember options in place of the blanket `shell → high`; destructive commands still grade HIGH (once-only).
  ruleVerdict?: RiskVerdict;
  // Single captured tool-call evaluation context shown to the user.
  evaluationContext?: PermissionEvaluationContext;
  // Suggested natural-language purpose shown in the approval dock.
  approvalPurpose?: ApprovalPurposeSuggestion;
  // Present iff tier 2 ran for this ask and handed the decision back to the user. It is the dock's only account of a stage the user never saw, and without it a parent-escalated ask is indistinguishable from one that was never eligible for a parent at all. Host-composed and outbound-only: the host writes it after the parent answers, the renderer displays it, and no decision field echoes it back. It is deliberately NOT part of the signApprovalRequest preimage — that signature authenticates the renderer round trip, and a field with no echoed copy has nothing to authenticate (see that function for the same argument applied to `remoteControllerOrigin`).
  parentEscalation?: ParentEscalationNotice;
  args: unknown;
  reason: string;
  // Host-composed label naming the cross-agent message that was influencing the caller when this ask was raised (`[Sub-Agent: <title>]`), when one was. The same string is already the leading segment of reason, so carrying it structurally discloses nothing new — it just stops the consumers that need the FACT from having to parse it back out of prose. Host-composed and outbound-only, for the reason parentEscalation is: the host writes it, no decision field echoes it back, and it is not part of the signApprovalRequest preimage.
  approvalReasonPrefix?: string;
  source?: ToolSource;
  // Plugin id that issued this approval request, when source === "plugin".
  sourcePluginId?: string;
  // Manifest-declared plugin approval scope for agent-action requests.
  approvalScope?: string;
  createdAt: number;

  requireExplicit: boolean;
  // Permission policy.5 — Layer 1 directory-confirm payload. Present iff `kind === "out-of-allowed-dir"`. Carries the candidate parent path + adjacency warnings so the renderer can render the auto-suggest UI without re-running validation.
  outOfAllowedDir?: {
    candidatePath: string;
    suggestedParent: string | null;
    currentAllowed: readonly string[];
    adjacencyWarnings: readonly string[];
  };
  // Present iff `kind === "egress-host"`.
  egressHost?: EgressHostApproval;
  // Permission policy.5 — trust origin classification (user-keyboard / plugin-emitted / app-emitted / llm-tool-arg / file-content). Audited; renderer may surface badge.
  trustOrigin?: string;
  // OS-level execution sandbox SOT, surfaced to the approval dock so the user can see whether the tool will run under the ASRT OS sandbox (macOS Seatbelt / Linux bwrap) or with no isolation. Captured at request build time by the executor (and by ApprovalGate for non-tool approvals) from detectSandboxCapability; immutable thereafter. Typed as the canonical SandboxCapability (not a structural mirror) to keep the `platform: NodeJS.Platform` enum tight. Mirror declarations in the renderer type SHOULD use the same shape.
  sandboxCapability?: SandboxCapability;
  // Renderer-safe, allowlist-only execution substrate snapshot for a host shell action. It intentionally contains no command, CWD, directory scope, approval binding, permit, nonce, or HMAC material.
  executionPlan?: HostShellExecutionPlanAuditProjection;
  // Actual shell cwd derived from the bound host action; caller values are ignored.
  executionCwd?: string;
  // Sensitive target paths hard-block before the dock and cannot be overridden.
  target?: {
    filePath?: string;
  };
  // Read-only calls skip the dock unless ask_all requires every prompt.
  isReadOnly?: boolean;
  // ask_all still prompts for reads; other modes retain read auto-approval.
  mode?: ApprovalMode;
  // Sensitive-pattern metadata is diagnostic only; requestAndWait owns the authoritative hard block before any dock.
  sensitivePathPattern?: string | null;
  // Cache key for approval record/lookup symmetry. Propagated from executor's approvalCacheKeyFor result so the renderer can record and look up entries using the same key that dispatchReviewer uses. Without this field the renderer receives undefined and the record key mismatches the lookup key → approval cache hit rate 0% for tools like routine_schedule / bash / fs_write.
  approvalCacheKey?: string;
  // What a remembered decision for this request is keyed on: the exact args, or the tool's opted-in target scope. Host-derived; the record IPC refuses a request carrying a policy key without it, and the card states this scope as what "remember" will cover.
  approvalMemory?: ApprovalMemory;
  // Host-owned attribution: the conversation (session) whose turn raised this approval. Side chats and sub-agents block on approval docks while the user is looking at a different conversation, so the dock and the audit trail both need to name the asking conversation. It is set by the host tool path from the session id it already carries; it is never derived from provider output and never accepted from the renderer. Absent only for approval surfaces that genuinely have no conversation (boot-time and plugin agent-action asks). Part of the signApprovalRequest preimage — see that function for why absence is signed as an explicit null.
  sessionId?: string;
  // Confused-deputy defense — random nonce bound to this request. The renderer MUST echo this value back unchanged in the ApprovalDecision. Paired with hmac for integrity.
  nonce?: string;
  // Hex-encoded signApprovalRequest digest over the request's `(id, nonce, toolName, sessionId, args)`. The main process re-derives this from the stored pending entry on receipt of the decision and rejects on mismatch.
  hmac?: string;
}

// Audit attribution for an approval surface that has no conversation.
export const UNATTRIBUTED_APPROVAL_SESSION_ID = "unattributed-approval";

// Fields bound into an approval request's integrity signature.
export interface ApprovalSignatureFields {
  id: string;
  nonce: string;
  toolName: string;
  // Conversation attribution; `undefined` is signed as an explicit null.
  sessionId: string | undefined;
  args: unknown;
  // Host-resolved shell working directory, when the approval binds a shell action.
  executionCwd?: string;
}

// Emit and resolve share canonical JSON signing with explicit null session attribution, preventing delimiter collisions or stripped-attribution equivalence. Keys live only for this gate, so no legacy signature is needed. Host-only origin never transits the renderer; derive the answerer at receipt rather than signing a future choice.
export function signApprovalRequest(
  sessionKey: Buffer,
  fields: ApprovalSignatureFields,
): string {
  const preimage = canonicalStringify({
    id: fields.id,
    nonce: fields.nonce,
    toolName: fields.toolName,
    sessionId: fields.sessionId ?? null,
    args: fields.args,
    executionCwd: fields.executionCwd ?? null,
  });
  return createHmac("sha256", sessionKey).update(preimage).digest("hex");
}

// Input accepted by ApprovalGate.requestAndWait before the host seals nonce/HMAC and derives the renderer-facing `requireExplicit` field. `forceExplicit` is deliberately one-way: callers can only make a prompt stricter than the current policy, never relax it. It is used by execution routes whose substrate requires per-invocation, affirmative consent.
export type ApprovalRequestInput = Omit<
  ApprovalRequest,
  "requireExplicit" | "executionPlan" | "persistentAllowAllowed" | "exactRecordAllowed" | "persistentApprovalCwd" | "shellRule"
> & {
  // Host-only native execution proof; removed before renderer/audit payloads.
  readonly verifiedShellCommand?: import("./verified-shell-command.js").VerifiedShellCommand;
  // Host-owned assessment provenance; never inferred from the displayed reason.
  readonly reviewerOutcome?: ReviewerDispatchOutcome;
  readonly reviewerApprovalBasis?: ReviewerApprovalBasis;
  readonly approvalRuleBasis?: ApprovalRuleBasis;
  // Host-issued safe projection; structural lookalikes are rejected before IPC.
  readonly executionPlan?: HostShellExecutionPlanAuditProjection;
  readonly forceExplicit?: true;
  readonly ownerUnattended?: boolean;
  // Host-only execution budget handle for approval requests arriving through a transport callback.
  readonly toolApprovalWait?: ToolApprovalWait;
  // Host-only memory capability for this request. One-shot approval routes set this false so a renderer cannot turn a per-invocation decision into a user-approval-store record. It is retained only in pending state.
  readonly durableApprovalRecordAllowed?: boolean;
  // Host-only binding for an explicit plain-shell fallback permit. It is retained only in the pending entry and never serialized to the renderer or audit payload.
  readonly hostShellExecutionPermitBinding?: HostShellExecutionPermitBinding;
  // Host-only: this request types one command into the user's own host terminal. Only the desktop window answers it (no remote, plugin,
  // parked observer or away answer), it is never remembered, and its saves store only the exact `HostTerminal(...)` rule. Set by the
  // executor from the sealed terminal target, never by a renderer.
  readonly hostTerminal?: HostTerminalApprovalBinding;
  // Derive remote origin only from host-owned controller authority, never reason text or renderer input. Keep it off ApprovalRequest and all renderer payloads; absence means no host-observed remote controller.
  readonly remoteControllerOrigin?: RemoteControllerOrigin;
  // Host-only live controller authority. Its presence requires a one-shot human answer and never reaches renderer or audit payloads.
  readonly remoteControllerAuthority?: RemoteControllerAuthority;
  // Host-only: EVERY path this call would touch, for scope checks that must not be satisfied by the single path the dock happens to display. `target.filePath` is a display field and is the FIRST extracted path only. A tool declaring more than one path field — `move_file` names a source and a destination — would pass a check that read the display value while the other path went anywhere. Like the other host-only fields it is destructured out before the renderer payload is built.
  readonly scopeTargetFilePaths?: readonly string[];
  // Observe turn abort while parked so Stop releases the execution lease immediately instead of waiting for approval timeout. Keep the live signal out of renderer, pending-entry and audit payloads; absent means no turn cancellation.
  readonly abortSignal?: AbortSignal;
  // Host-tracked child provenance forces one-shot human approval and stays off renderer requests.
  readonly childProvenance?: ChildAgentProvenance;
};

// The sub-agent run behind an approval ask. Every field is host-owned: the ids come from the run registry and the summary from the parent's own spawn input.
interface ChildAgentProvenance {
  // Session id of the child run whose turn raised the ask.
  childSessionId: string;
  // Display title of the child run, as the dock already labels it.
  childTitle: string;
  // Session the child was spawned from — the parent that would adjudicate.
  originSessionId: string;
  // Host truncation of the parent-authored spawn task.
  spawnTaskSummary: string;
  // Whether the run executes in the background — the host's own fact about how it was started, never the child model's. Absent means foreground, which is the answer that keeps the pre-existing modal route: a run whose posture the host cannot establish is treated as one somebody is watching.
  background?: boolean;
}

export type ApprovalChoice =
  "allow-once" | "allow-session" | "allow-always" | "deny-once" | "deny-always";

export interface ApprovalDecision {
  requestId: string;
  choice: ApprovalChoice;
  // For an `egress-host` ask answered `allow-once`: how long the allow lasts, one of the request's `egressHost.scopes`. Required there, ignored everywhere else; a missing or unoffered scope makes the answer a deny.
  egressScope?: EgressGrantScope;

  rememberPattern?: string;
  // One-shot structured content captured by renderer-only approval surfaces. Currently used for MCP `elicitation/create` form-mode requests; never persisted in the user-approval memory store.
  elicitationContent?: Record<string, unknown>;
  // Nonce originally issued with the ApprovalRequest. The renderer echoes it back verbatim. Missing or mismatched values cause the decision to be rejected and treated as deny-once.
  nonce?: string;
  // HMAC originally issued with the ApprovalRequest. Echoed back by the renderer. The main process re-computes the expected HMAC from the pending entry and compares using timingSafeEqual.
  hmac?: string;
}

export const IPC_APPROVAL_REQUEST = "ave:approval:request";
export const IPC_APPROVAL_RESPOND = "ave:approval:respond";
// main→renderer: one parked request is no longer answerable. A renderer takes its card down when the turn that asked ends, and that covers the case where the surface holding the turn is still on screen. It is not the only way a request ends: the host retires a parked ask when the tile that asked closes, when a navigation lets go of the tile, on timeout, on abort, on shutdown. In those the surface that would have dropped the card has already unmounted, and without this announcement the card outlives its request — answerable on screen, answering nothing.
export const IPC_APPROVAL_SETTLED = "ave:approval:settled";

// Host-only timeout provenance; renderer objects can never enter this set.
const hostTimeoutDecisions = new WeakSet<ApprovalDecision>();

export function isHostApprovalTimeoutDecision(
  decision: ApprovalDecision | null | undefined,
): decision is ApprovalDecision {
  return (
    decision !== null &&
    decision !== undefined &&
    hostTimeoutDecisions.has(decision)
  );
}

// Host-generated fail-closed denials are not user-authored deny choices.
const hostRejectedApprovalDecisions = new WeakSet<ApprovalDecision>();

export function isHostApprovalRejectedDecision(
  decision: ApprovalDecision | null | undefined,
): decision is ApprovalDecision {
  return (
    decision !== null &&
    decision !== undefined &&
    hostRejectedApprovalDecisions.has(decision)
  );
}

// An `egress-host` request is fully specified or it is a bug: it carries its payload with at least one offered scope, offers exactly allow-once and deny-once, and is never recorded in the user-approval store. Any other kind carrying the payload is a bug too.
function assertEgressHostRequestShape(req: ApprovalRequestInput): void {
  if (req.kind !== "egress-host") {
    if (req.egressHost !== undefined) throw new Error("approval: egressHost is only valid on an egress-host request");
    return;
  }
  const payload = req.egressHost;
  if (payload === undefined || payload.scopes.length === 0 || !payload.scopes.every(isEgressGrantScope)) {
    throw new Error("approval: an egress-host request needs egressHost with at least one valid scope");
  }
  if (payload.network !== "public" && payload.network !== "local" && payload.network !== "unverified") {
    throw new Error("approval: an egress-host request names its network (public, local or unverified)");
  }
  if (payload.network !== "public" && payload.scopes.some((scope) => scope === "project" || scope === "always")) {
    throw new Error("approval: a local, private or unverified destination is never offered a persistent scope");
  }
  if (payload.terminalTabId !== undefined) {
    if (!isTerminalTabId(payload.terminalTabId)) throw new Error("approval: terminalTabId is not a terminal tab id");
    if (req.sessionId !== undefined && approvalSurfaceRegistry.terminalSessionId(payload.terminalTabId) !== req.sessionId) {
      throw new Error("approval: terminal egress conversation binding mismatch");
    }
    if (payload.scopes.includes("session")) throw new Error("approval: a terminal tab is offered This tab, not This session");
    if (payload.scopes.includes("project")) throw new Error("approval: a terminal tab is never offered This project");
  } else if (payload.scopes.includes("tab")) {
    throw new Error("approval: only a terminal tab's egress ask offers This tab");
  }
  const choices = req.allowedChoices ?? [];
  if (choices.length !== 2 || !choices.includes("allow-once") || !choices.includes("deny-once")) {
    throw new Error("approval: an egress-host request offers exactly allow-once and deny-once");
  }
  if (req.durableApprovalRecordAllowed !== false) {
    throw new Error("approval: an egress-host request is never recorded in the user-approval store");
  }
}

function markHostApprovalRejectedDecision(
  decision: ApprovalDecision,
): ApprovalDecision {
  hostRejectedApprovalDecisions.add(decision);
  return decision;
}

// Renderer-visible approval decisions are ordinary objects. This private map records the exact object that completed an HMAC-verified, explicit, one-shot Plan-B approval, so a structural `{ choice: "allow-once" }` cannot mint a plain-shell capability.
const hostApprovedOneShotExecutionBindings = new WeakMap<
  ApprovalDecision,
  HostShellExecutionPermitBinding
>();

function sameHostShellExecutionPermitBinding(
  actual: HostShellExecutionPermitBinding,
  expected: HostShellExecutionPermitBinding,
): boolean {
  return (
    actual.planIdentity === expected.planIdentity &&
    actual.plan === expected.plan &&
    actual.toolName === expected.toolName &&
    actual.toolUseId === expected.toolUseId &&
    actual.command === expected.command &&
    actual.requestedCwd === expected.requestedCwd &&
    actual.executionCwd === expected.executionCwd &&
    actual.resolvedCwd === expected.resolvedCwd &&
    actual.timeoutSeconds === expected.timeoutSeconds &&
    actual.executionMode === expected.executionMode &&
    actual.justification === expected.justification &&
    actual.runInBackground === expected.runInBackground &&
    actual.allowedDirectories.length === expected.allowedDirectories.length &&
    actual.allowedDirectories.every(
      (directory, index) => directory === expected.allowedDirectories[index],
    )
  );
}

// The Plan-B binding is deliberately renderer-invisible, but it must describe exactly the shell action the renderer is asked to approve. Otherwise an in-process caller could present a benign request while retaining a binding for a different plain-host spawn. Normalize only the schema-relevant shell fields so an omitted default timeout has the same meaning on both sides.
function matchesHostShellExecutionPermitBindingRequest(
  request: Omit<ApprovalRequest, "requireExplicit">,
  binding: HostShellExecutionPermitBinding,
): boolean {
  if (
    request.category !== "tool" ||
    (request.kind !== undefined && request.kind !== "tool") ||
    request.source !== "builtin" ||
    request.toolCategory !== "shell" ||
    request.toolName !== binding.toolName ||
    typeof binding.resolvedCwd !== "string" || binding.resolvedCwd.trim().length === 0
  ) {
    return false;
  }
  try {
    const parsed = parseHostShellExecutionInput(request.args);
    if (parsed === undefined || parsed.executionMode !== binding.plan.executionRequest) return false;
    return canonicalStringify({
      command: parsed.command,
      cwd: parsed.cwd ?? null,
      timeoutSeconds: parsed.timeoutSeconds,
      executionMode: parsed.executionMode,
      justification: parsed.justification ?? null,
      runInBackground: parsed.runInBackground,
    }) === canonicalStringify({
      command: binding.command,
      cwd: binding.requestedCwd ?? null,
      timeoutSeconds: binding.timeoutSeconds,
      executionMode: binding.executionMode,
      justification: binding.justification ?? null,
      runInBackground: binding.runInBackground,
    });
  } catch {
    // A malformed/proxy argument or binding is never approval-equivalent.
    return false;
  }
}

// Verify and burn the host-only receipt for a Plan-B execution permit. A mismatch is terminal for that receipt to prevent action probing or replay.
export function consumeHostApprovedOneShotExecutionBinding(
  decision: ApprovalDecision | undefined,
  expected: HostShellExecutionPermitBinding,
): boolean {
  if (decision === undefined) return false;
  const actual = hostApprovedOneShotExecutionBindings.get(decision);
  if (actual === undefined) return false;
  hostApprovedOneShotExecutionBindings.delete(decision);
  return sameHostShellExecutionPermitBinding(actual, expected);
}

interface ApprovalPolicyTransition {
  readonly from: string;
  to: string;
  valid: boolean;
  saving: boolean;
}

interface PendingEntry {
  ruleSaveTransition?: ApprovalPolicyTransition;
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  // Permission origin captured with the approval prompt.
  trustOrigin: string;
  // Conversation attribution captured with the prompt, so the decided / timeout / cancelled audit rows name the same conversation the requested row did even though the request object is long gone by then.
  sessionId?: string;
  // Remote-controller origin captured with the prompt. Host-only, exactly as it is on ApprovalRequestInput — it is retained here and never sent anywhere, so the rows written long after the request object is gone (decided, timeout, cancelled) can still state where the blocked turn came from.
  remoteControllerOrigin?: RemoteControllerOrigin;
  toolName: string;
  // Raw host-owned finalized input; never forwarded from this pending entry.
  args: unknown;
  category: "tool" | "agent-action";
  kind?: ApprovalKind;
  allowedChoices?: readonly ApprovalChoice[];
  toolCategory?: ToolCategory;
  // Host-derived verdict shown by the renderer and enforced for recording.
  verdictAtApproval: RiskVerdict["level"];
  source?: ToolSource;
  sourcePluginId?: string;
  approvalScope?: string;
  // Host-resolved directory scope carried from the request. `/allow` reads it from HERE, not from the renderer's copy: the renderer sends only a request id and a sentence, so the paths an approval sentence can ever resolve to are the ones this process derived when it raised the prompt.
  outOfAllowedDir?: {
    candidatePath: string;
    suggestedParent: string | null;
  };
  // The scopes an `egress-host` ask offered, kept host-side for the answer check.
  egressScopes?: readonly EgressGrantScope[];
  // A workspace terminal tab's egress ask: only the window that owns the tab may fetch or answer it (`listPendingRendererRequests`, `resolveFromDesktopRenderer`).
  egressTerminalTabId?: string;
  // An `egress-host` ask's destination and host rule context, kept host-side for a card's rule save (`getRequestSnapshot`).
  egressRule?: {
    host: string;
    port: number;
    network: EgressGrantNetwork;
    rule: string | null;
    projectCwd?: string;
  };
  // approval cache key captured server-side at request emit time. The userApprovalRecord IPC handler reads this via ApprovalGate.getRequestSnapshot instead of trusting the renderer to echo it back. Optional because non-tool kinds (out-of-allowed-dir, agent-action) do not propagate a cache key.
  approvalCacheKey?: string;
  // Captured with approvalCacheKey; see ApprovalRequest.
  approvalMemory?: ApprovalMemory;
  // Host-owned permission to create a user-approval-store record.
  durableApprovalRecordAllowed: boolean;
  persistentAllowAllowed: boolean;
  shellRule?: ShellRuleApproval;
  verifiedShellCommand?: import("./verified-shell-command.js").VerifiedShellCommand;
  projectCwd?: string;
  workingDirectoryIdentity?: string;
  riskCeilingAtApproval?: RiskLevel;
  executionPlan?: HostShellExecutionPlanAuditProjection;
  hostShellExecutionPermitBinding?: HostShellExecutionPermitBinding;
  hostTerminal?: HostTerminalApprovalBinding;
  // Confused-deputy nonce issued for this request (echoed back verbatim)
  nonce: string;
  // Expected HMAC for this request (confused-deputy defense)
  expectedHmac: string;
  // The request exactly as the renderer received it — masked, sealed, signed — so a renderer that (re)loads while this entry is parked can be handed the same card again. Written right before the send: an entry a host observer settled during the park announcement never gets one, and needs none, because nothing is waiting on it any more.
  rendererRequest?: ApprovalRequest;
}

// Main-process observers answer through the same integrity/choice-checked resolve path using only coarse identity and echo credentials. Never expose args, paths, reason, verdict, nonce or HMAC over IPC/provider wires; those credentials are resolution capability.
export interface PendingApprovalView {
  readonly requestId: string;
  readonly toolName: string;
  readonly source?: ToolSource;
  readonly category: "tool" | "agent-action";
  readonly kind?: ApprovalKind;
  readonly allowedChoices?: readonly ApprovalChoice[];
  // Conversation attribution, as on the request; never renderer-supplied.
  readonly sessionId?: string;
  // Echo material ApprovalGate.resolve verifies; host-internal only.
  readonly nonce: string;
  readonly hmac: string;
}

// Host-internal observer of the gate's pending set. `onPending` fires when a request is parked for an interactive answer — after transport and card-integrity checks, so an observer can never offer a decision the desk was never offered. `onSettled` fires exactly when the parked request stops being answerable, whatever settled it: a desk answer, a remote answer, the timeout, a turn abort, a cancel, or shutdown. Observers must tolerate `onSettled` for ids they never saw and must never throw; a throwing observer is swallowed so it cannot alter approval flow.
export interface PendingApprovalObserver {
  onPending(view: PendingApprovalView): void;
  onSettled(requestId: string, decision: ApprovalDecision): void;
}

// Audit vocabulary for who answered an approval, and the closed set of answerers itself: ApprovalAnswerer is `keyof` this table, so the type cannot gain a member without that member also declaring the token it writes to the audit row. This table is the single authority; there is no path that widens one without the other. The dimension exists because an audit that cannot name the answerer cannot support a review of what happened while nobody was watching. It was recorded while `desk` was still the only answerer, which is what made adding the second one a one-line change here rather than a retrofit across every row.
const APPROVAL_ANSWERER_AUDIT_TOKENS = {
  // The app window: a renderer response to the approval dock.
  desk: "desk",
  // Historical answerer token retained for persisted audit records.
  "away-authority": "away-authority",
  // The parent agent of the sub-agent whose turn raised this ask (tier 2 of the sub-agent approval chain). Distinct from both of the above for the reason the dimension exists at all: a row a reviewer reads later must say whether a person decided this call or whether a model the person delegated to did, and neither `desk` nor `away-authority` can carry that fact. A parent answer is one-shot by construction, so a row bearing this token can never be the origin of a durable approval record.
  "parent-agent": "parent-agent",
  // The paired chat-platform surface: the owner pressed a decision button on a bridge card. Distinct from `desk` for the reason the dimension exists — a reviewer partitioning rows by where the owner was must not have to infer "away from the desk" from surrounding rows — and distinct from `away-authority` because a human answered THIS call rather than pre-authorizing a class of calls. Only host code relaying a verified paired owner's button press may pass it; the renderer's IPC route cannot.
  "platform-bridge": "platform-bridge",
  // The headless one-shot runner (`--exec`): no window, no owner, no dock. It answers every parked request with a deny so an unattended process cannot sit on the gate's timeout. Distinct from every token above for the reason the dimension exists — a reviewer must be able to tell "the owner declined this call" from "nobody was there and the host declined it on their behalf", and only this token can carry the second.
  "headless-exec": "headless-exec",
} as const;

// Who answered an approval. Host-derived at answer time from the code path that received the answer. It is never read out of the ApprovalDecision payload, out of the request, out of a provider's output, or inferred from the localizable free-text `reason` — a value any of those can influence is not attribution.
export type ApprovalAnswerer = keyof typeof APPROVAL_ANSWERER_AUDIT_TOKENS;

// Audit token for a value that is not a known ApprovalAnswerer.
const UNRECOGNIZED_APPROVAL_ANSWERER = "unrecognized-answerer";

// Unknown answerers render as an anomaly, never desk or raw text that could forge audit fields. Check own properties so inherited names cannot qualify.
export function approvalAnswererAuditToken(
  answeredBy: ApprovalAnswerer,
): string {
  return Object.hasOwn(APPROVAL_ANSWERER_AUDIT_TOKENS, answeredBy)
    ? APPROVAL_ANSWERER_AUDIT_TOKENS[answeredBy]
    : UNRECOGNIZED_APPROVAL_ANSWERER;
}

// Audit vocabulary for the remote controller behind an approval. A TOTAL `Record` over the authority kinds. `RemoteControllerOrigin` is owned by `shared/chat-origin.ts`, which is where the set of controllers is decided; making the table total means a new controller kind added there fails to compile here until it declares the token it writes. The set keeps its one owner and this table cannot silently fall behind it.
const REMOTE_CONTROLLER_ORIGIN_AUDIT_TOKENS: Record<
  RemoteControllerOrigin,
  string
> = {
  "tailnet-controller": "tailnet-controller",
  "platform-bridge": "platform-bridge",
};

// Audit token for an approval no remote controller stands behind.
const LOCAL_APPROVAL_ORIGIN = "none";

// Audit token for a value that is not a known RemoteControllerOrigin.
const UNRECOGNIZED_REMOTE_CONTROLLER_ORIGIN = "unrecognized-remote-origin";

// Every approval row states remote origin, including none; unknown values become anomalies without echoing raw text. Check own properties to reject inherited controller names.
export function remoteControllerOriginAuditToken(
  origin: RemoteControllerOrigin | undefined,
): string {
  if (origin === undefined) return LOCAL_APPROVAL_ORIGIN;
  return Object.hasOwn(REMOTE_CONTROLLER_ORIGIN_AUDIT_TOKENS, origin)
    ? REMOTE_CONTROLLER_ORIGIN_AUDIT_TOKENS[origin]
    : UNRECOGNIZED_REMOTE_CONTROLLER_ORIGIN;
}

interface ApprovalAuditFields {
  toolName: string;
  category: "tool" | "agent-action";
  kind?: ApprovalKind;
  toolCategory?: ToolCategory;
  source?: ToolSource;
  sourcePluginId?: string;
  approvalScope?: string;
  trustOrigin?: string;
  // Host-set marker for the remote controller behind the asking turn. Unlike answeredBy it is written on every row, because every approval either came from a remote turn or did not — there is no third state for an absence to encode.
  remoteControllerOrigin?: RemoteControllerOrigin;
  // Set only on a row that records an actual answer. Rows for outcomes the host reached on its own — timeout, sensitive-path hard-block, send failure, cancellation, read-only auto-approve — leave it undefined, because "nobody answered" is a different fact from "the desk answered" and the row marker already names which host outcome it was.
  answeredBy?: ApprovalAnswerer;
}

function formatApprovalAuditFields(
  fields: ApprovalAuditFields,
  executionPlan?: HostShellExecutionPlanAuditProjection,
): string {
  return [
    `toolName=${fields.toolName}`,
    `category=${fields.category}`,
    `toolCategory=${fields.toolCategory ?? "unknown"}`,
    `kind=${fields.kind ?? "tool"}`,
    `source=${fields.source ?? "unknown"}`,
    `sourcePluginId=${fields.sourcePluginId ?? "none"}`,
    `approvalScope=${fields.approvalScope ?? "none"}`,
    `trustOrigin=${fields.trustOrigin ?? "unknown"}`,
    `remoteControllerOrigin=${remoteControllerOriginAuditToken(fields.remoteControllerOrigin)}`,
    ...(fields.answeredBy === undefined
      ? []
      : [`answeredBy=${approvalAnswererAuditToken(fields.answeredBy)}`]),
    ...(executionPlan === undefined ? [] : [
      `executionPlan.version=${executionPlan.version}`,
      `executionPlan.identity=${executionPlan.identity}`,
      `executionPlan.platform=${executionPlan.platform}`,
      `executionPlan.requestedSandbox=${executionPlan.requestedSandbox}`,
      `executionPlan.executionRequest=${executionPlan.executionRequest}`,
      `executionPlan.mode=${executionPlan.mode}`,
      `executionPlan.fallbackReason=${executionPlan.fallbackReason}`,
      `executionPlan.requiresExplicitUserApproval=${executionPlan.requiresExplicitUserApproval}`,
      `executionPlan.capability.kind=${executionPlan.capability.kind}`,
      `executionPlan.capability.confidence=${executionPlan.capability.confidence}`,
      `executionPlan.capability.confines=${JSON.stringify(executionPlan.capability.confines ?? {})}`,
    ]),
  ].join(" ");
}
// Rationale cards have a narrow, host-audited display contract. Reject every malformed or semantically mismatched request before it can mint integrity material, notify the user, or cross the main-to-renderer boundary.
function parseValidRationaleApprovalDisplay(
  request: Omit<ApprovalRequest, "requireExplicit">,
): RationaleApprovalDisplay | null {
  if (request.kind !== "rationale") return null;
  try {
    const display = parseRationaleApprovalDisplay(request.args);
    return display !== null &&
      request.category === "tool" &&
      request.toolName === display.toolName &&
      request.reviewerVerdict !== undefined &&
      canonicalStringify(request.reviewerVerdict) ===
        canonicalStringify(display.effectiveVerdict)
      ? display
      : null;
  } catch {
    return null;
  }
}

// Rationale requests are assembled from a host-sealed projection, but callers still supply the generic ApprovalRequest shape. Never let that generic `reason` field become notification, audit, pending-state, or renderer data: it is not part of the rationale display contract and could otherwise carry model-controlled text.
const RATIONALE_HOST_OWNED_REASON =
  "Review the host-sealed action and its permission rationale.";

// The renderer needs an opaque request id to respond and a bounded rationale display card to inform the one-shot decision. It does not need execution metadata. Keep the full request in the main process for sensitive-path enforcement, audit, pending state, and HMAC verification, then whitelist this separate IPC payload after signing.
function createRendererSafeRationaleApprovalRequest(
  request: ApprovalRequest,
  display: RationaleApprovalDisplay,
  detections: Set<string>,
): ApprovalRequest {
  const maskedVerdict = maskSensitiveData(display.effectiveVerdict.reason);
  for (const hit of maskedVerdict.detections) detections.add(hit);
  return {
    id: request.id,
    category: "tool",
    kind: "rationale",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: display.toolName,
    reviewerVerdict: {
      level: display.effectiveVerdict.level,
      reason: maskedVerdict.masked,
    },
    // Emission integrity: the display was parse-guaranteed at construction and masking was the one mutation applied after that guarantee — a mask token pushing a near-cap field over its limit made the renderer's parse return null and the card lost its tool identity entirely. Seal per field with parser-identical validators so what ships ALWAYS parses; the renderer's null branch stays as defense-in-depth for forged payloads only.
    args: sealMaskedRationaleApprovalDisplay(display, (value) => {
      const { masked, detections: hits } = maskSensitiveData(value);
      for (const hit of hits) detections.add(hit);
      return masked;
    }) as unknown as Record<string, unknown>,
    reason: RATIONALE_HOST_OWNED_REASON,
    createdAt: request.createdAt,
    requireExplicit: true,
    // Attribution is an opaque host-owned id, not conversation content, and a rationale card blocks a conversation the same way a tool ask does.
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    nonce: request.nonce,
    hmac: request.hmac,
  };
}

// Constant-time comparison of the echoed (nonce, hmac) pair against the pending entry's expected values (confused-deputy defense). Returns false if either field is missing or malformed; returns true only when both the nonce and HMAC match byte-for-byte.
function verifyApprovalIntegrity(
  entry: PendingEntry,
  decision: ApprovalDecision,
): boolean {
  const { nonce, hmac } = decision;
  if (typeof nonce !== "string" || typeof hmac !== "string") return false;
  if (nonce.length !== entry.nonce.length) return false;
  if (hmac.length !== entry.expectedHmac.length) return false;
  const nonceA = Buffer.from(nonce);
  const nonceB = Buffer.from(entry.nonce);
  const hmacA = Buffer.from(hmac);
  const hmacB = Buffer.from(entry.expectedHmac);
  if (nonceA.length !== nonceB.length || hmacA.length !== hmacB.length) {
    return false;
  }
  return timingSafeEqual(nonceA, nonceB) && timingSafeEqual(hmacA, hmacB);
}

// ApprovalGate

// Resolves explicit host registrations for each session, terminal or unattributed host role. Re-evaluated for delivery, listing and answers; a missing registration has no approval surface.
export type ApprovalSurfaceResolver = (
  sessionId: string | undefined,
  // Set for a workspace terminal tab's ask: the window that owns the tab, or null.
  terminalTabId?: string,
) => WebContents | null;

export class ApprovalGate {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly ruleSaveTokens = new WeakMap<object, { requestId: string; entry: PendingEntry; before: string }>();
  private readonly approvedPolicyTransitions = new WeakMap<ApprovalDecision, { from: string; to: string }>();

  /** Capture a live card before its host-validated rule save. Tokens never cross IPC. */
  beginApprovalRuleSave(requestId: string, before: string): object | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    const transition = entry.ruleSaveTransition ??= { from: before, to: before, valid: true, saving: false };
    if (transition.saving || transition.to !== before) transition.valid = false;
    transition.saving = true;
    const token = Object.freeze({});
    this.ruleSaveTokens.set(token, { requestId, entry, before });
    return token;
  }

  /** Complete only a successful, validated allow save; any other mutation breaks the chain. */
  completeApprovalRuleSave(token: object | undefined, after: string, scope?: "session" | "project" | "always"): void {
    if (!token) return;
    const saved = this.ruleSaveTokens.get(token);
    this.ruleSaveTokens.delete(token);
    if (!saved || this.pending.get(saved.requestId) !== saved.entry) return;
    const transition = saved.entry.ruleSaveTransition!;
    transition.saving = false;
    const beforeParts = saved.before.split(":");
    const afterParts = after.split(":");
    const generation = Number(beforeParts[0]);
    const revision = Number(beforeParts[1]);
    // Rule saves increment the manager generation once and, for project rules,
    // the project revision once. Concurrent policy changes cannot join this receipt.
    if (scope === undefined || beforeParts.length !== 3 || afterParts.length !== 3 ||
      !Number.isSafeInteger(generation) || !Number.isSafeInteger(revision) || generation < 0 || revision < 0 ||
      afterParts[0] !== String(generation + 1) ||
      afterParts[1] !== String(revision + (scope === "project" ? 1 : 0)) ||
      afterParts[2] !== beforeParts[2]) transition.valid = false;
    transition.to = after;
  }

  /** Consume the exact authenticated answer's same-card policy transition once. */
  allowsPolicyTransition(decision: ApprovalDecision, before: string, current: string): boolean {
    const transition = this.approvedPolicyTransitions.get(decision);
    this.approvedPolicyTransitions.delete(decision);
    return transition !== undefined && transition.from === before && transition.to === current;
  }
  private readonly lifetime = new AbortController();
  // Renderers that displayed a pending card, including a former owner after a conversation move. Settlement removes stale cards from each of them.
  private readonly refetchedBy = new Map<string, Set<WebContents>>();
  // Null only for a gate built without any desktop surface (headless/tests).
  private readonly resolveSurface: ApprovalSurfaceResolver | null;
  // Timeout in milliseconds. Defaults to five minutes.
  private readonly timeoutMs: number;
  // Active policy, replaceable at runtime via setPolicy.
  private currentPolicy: PolicyFile;
  // Audit logger for scenario S8; silent when not provided.
  private readonly auditLogger?: AuditLogger;
  // optional NotificationService — when supplied, the gate fires an `approval` system notification at the entry of `requestAndWait` so the user sees the prompt even if the window is backgrounded.
  private readonly notificationService?: NotificationService;
  private conversationTitleResolver?: (sessionId: string) => string;
  // Per-instance HMAC secret for confused-deputy defense. 32 random bytes generated at construction time. Never leaves the main process — used only to sign/verify the nonce that rides along with approval requests. A fresh key each boot naturally scopes replay protection to the current ApprovalGate lifetime.
  private readonly sessionKey: Buffer = randomBytes(32);

  // Host-internal observers of the pending set; see observePendingApprovals.
  private readonly pendingObservers = new Set<PendingApprovalObserver>();

  private ownerAwayAutoSkipMinutes = 0;

  private readonly headlessDenied?: (requestId: string, toolName: string) => void;

  constructor(
    webContents: WebContents | ApprovalSurfaceResolver | null,
    initialPolicy?: PolicyFile,
    timeoutMs = TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs,
    auditLogger?: AuditLogger,
    notificationService?: NotificationService,
    headlessExec?: { onDenied: (requestId: string, toolName: string) => void },
  ) {
    if (headlessExec && webContents !== null) throw new Error("Headless approval mode requires no desktop surface");
    this.headlessDenied = headlessExec?.onDenied;
    if (typeof webContents === "function") {
      this.resolveSurface = webContents;
    } else if (webContents === null) {
      this.resolveSurface = null;
    } else {
      const fixed = webContents;
      this.resolveSurface = () => fixed;
    }
    this.timeoutMs = timeoutMs;
    this.auditLogger = auditLogger;
    this.notificationService = notificationService;
    this.currentPolicy = initialPolicy ?? {
      version: 1,
      requireExplicitApproval: true,
      managed: false,
      updatedAt: new Date().toISOString(),
    };
  }

  setOwnerAwayAutoSkipMinutes(minutes: number): void {
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 0) {
      throw new Error("Owner-away auto-skip minutes must be a nonnegative integer");
    }
    this.ownerAwayAutoSkipMinutes = minutes;
  }

  setConversationTitleResolver(resolve: (sessionId: string) => string): void {
    this.conversationTitleResolver = resolve;
  }

  private notificationBody(request: ApprovalRequest): string {
    const action = approvalActionSummary({
      ...request,
      args: maskArgsForDisplay(request.args, new Set<string>()),
      ...(request.target?.filePath ? { target: { filePath: maskSensitiveData(request.target.filePath).masked } } : {}),
      ...(request.outOfAllowedDir ? { outOfAllowedDir: {
        ...request.outOfAllowedDir,
        candidatePath: maskSensitiveData(request.outOfAllowedDir.candidatePath).masked,
      } } : {}),
    }, t, { maxCharacters: 30 });
    const segment = (value: string): string => {
      const characters = [...maskSensitiveData(value).masked];
      return characters.length > 30 ? characters.slice(0, 29).join("") + "…" : characters.join("");
    };
    const maskedAction = maskSensitiveData(action).masked;
    if (request.sessionId === undefined) return maskedAction;
    const title = request.sessionId === undefined ? ""
      : this.conversationTitleResolver?.(request.sessionId)
        ?? resolveConversationTitle({ sessionId: request.sessionId }, t);
    return t("be_approvalGate.conversationNotification", {
      action: maskedAction, title: segment(title),
    });
  }

  // Replace the runtime policy immediately from the ave:policy:set IPC handler.
  setPolicy(p: PolicyFile): void {
    this.currentPolicy = p;
  }

  // Register a host-internal observer of parked approvals. Returns the unsubscribe. See PendingApprovalView for what an observer receives and why registration is the only way to receive it.
  observePendingApprovals(observer: PendingApprovalObserver): () => void {
    this.pendingObservers.add(observer);
    return () => {
      this.pendingObservers.delete(observer);
    };
  }

  get isHeadlessExec(): boolean {
    return this.headlessDenied !== undefined;
  }

  // Fan one parked request out to observers; a throwing observer is inert.
  private notifyPendingParked(view: PendingApprovalView): void {
    for (const observer of [...this.pendingObservers]) {
      try {
        observer.onPending(view);
      } catch {
        // An observer failure must never alter approval flow.
      }
    }
  }

  // Tell the renderer one request is no longer answerable — see IPC_APPROVAL_SETTLED. Announced for EVERY settlement, including the renderer's own answer: an announcement the renderer has already acted on costs it a set lookup, and a closed list of "which settlements get announced" would be one more thing to keep in step with every caller of `settle`. The renderer reconciles rather than obeys — a request whose answer is in flight there is left to the answer.
  private announceSettledToRenderer(requestId: string, targets: ReadonlyArray<WebContents | null>): void {
    for (const target of new Set(targets)) {
      try {
        if (!target || target.isDestroyed()) continue;
        target.send(IPC_APPROVAL_SETTLED, { requestId });
      } catch {
        // A renderer that went away between the check above and the send has no card left to take down. Nothing else depends on this reaching it.
      }
    }
  }

  // The currently registered renderer, or null. Run kinds and visible chat holders do not imply ownership.
  private liveSurfaceFor(sessionId: string | undefined, terminalTabId?: string): WebContents | null {
    const surface = (terminalTabId === undefined
      ? this.resolveSurface?.(sessionId)
      : this.resolveSurface?.(sessionId, terminalTabId)) ?? null;
    return surface && !surface.isDestroyed() ? surface : null;
  }

  // Fan one settlement out to observers; a throwing observer is inert.
  private notifyPendingSettled(
    requestId: string,
    decision: ApprovalDecision,
  ): void {
    for (const observer of [...this.pendingObservers]) {
      try {
        observer.onSettled(requestId, decision);
      } catch {
        // An observer failure must never alter approval flow.
      }
    }
  }

  // Send an approval request to the renderer and wait for the response. ConversationLoop.executeOne awaits this and blocks the turn. The requireExplicit field controls renderer dismiss behavior.
  async requestAndWait(req: ApprovalRequestInput): Promise<ApprovalDecision> {
    assertEgressHostRequestShape(req);
    if (this.lifetime.signal.aborted) {
      return markHostApprovalRejectedDecision({ requestId: req.id, choice: "deny-once" });
    }
    const {
      forceExplicit: requestedForceExplicit = false,
      ownerUnattended = false,
      toolApprovalWait,
      durableApprovalRecordAllowed: requestedDurableApprovalRecordAllowed,
      hostShellExecutionPermitBinding,
      hostTerminal,
      executionPlan: requestedExecutionPlan,
      executionCwd: _requestedExecutionCwd,
      sandboxCapability: requestedSandboxCapability,
      remoteControllerOrigin,
      remoteControllerAuthority,
      scopeTargetFilePaths,
      abortSignal,
      childProvenance,
      reviewerOutcome,
      reviewerApprovalBasis,
      approvalRuleBasis,
      verifiedShellCommand,
      ...request
    } = req;
    if (toolApprovalWait !== undefined && !isIssuedToolApprovalWait(toolApprovalWait)) {
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "Approval execution budget was not issued by the host",
      });
    }
    const forceExplicit = requestedForceExplicit || childProvenance !== undefined ||
      remoteControllerOrigin !== undefined || remoteControllerAuthority !== undefined;
    // Strip bindings, controller authority, abort signals and child eligibility/provenance before spreading renderer requests; live host capability must not reach renderer or audit. Audit only allowlisted plan fields and inject origin into every row so absence cannot masquerade as desk provenance.
    const auditFieldsFor = (
      fields: ApprovalAuditFields,
      executionPlan?: HostShellExecutionPlanAuditProjection,
    ): string =>
      formatApprovalAuditFields(
        { ...fields, remoteControllerOrigin },
        executionPlan,
      );
    const rationaleDisplay = parseValidRationaleApprovalDisplay(req);

    // Rationale is a host-owned, one-shot approval surface. Validate its narrow explanatory card before any enrichment, notification, nonce minting, or renderer IPC so a malformed/mismatched request cannot turn into a clickable approval dock.
    if (req.kind === "rationale" && rationaleDisplay === null) {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: req.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:rationale-display-invalid] ${req.id} ${auditFieldsFor(req)} -> deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "invalid rationale approval display",
      });
    }

    const suppliedExecutionPlan = requestedExecutionPlan === undefined
      ? undefined
      : isIssuedHostShellExecutionPlanAuditProjection(requestedExecutionPlan)
        ? requestedExecutionPlan
        : undefined;
    if (requestedExecutionPlan !== undefined && suppliedExecutionPlan === undefined) {
      // Never copy a structural lookalike into an IPC payload or an audit row: even additional fields on an otherwise plausible object could leak the private Plan-B binding/action context.
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: req.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:execution-plan-invalid] ${req.id} ${auditFieldsFor(request)} -> deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "execution plan projection was not issued by the host",
      });
    }

    const requestedChoices = req.allowedChoices;
    const verdictAtApproval = resolveUserApprovalVerdict(req);
    const hasOneShotApprovalChoiceContract =
      requestedChoices?.length === 2 &&
      requestedChoices.includes("allow-once") &&
      requestedChoices.includes("deny-once");
    // Exact one-shot requests and rationale prompts are never eligible for a durable user-approval record. Treat this as an invariant instead of a caller preference: a future emitter must not be able to widen a per-invocation decision by setting the host-only option to `true`.
    const durableApprovalRecordAllowed =
      req.kind !== "rationale" && !forceExplicit &&
      !hasOneShotApprovalChoiceContract &&
      requestedDurableApprovalRecordAllowed !== false;
    const hasOneShotHostShellApprovalContract =
      forceExplicit === true &&
      hasOneShotApprovalChoiceContract;
    // A regular builtin command dock may save an escape rule and then answer allow-once. Its native action still uses the same authenticated receipt.
    if (hostTerminal !== undefined && (req.toolName !== "terminal_run" || req.source !== "builtin" || req.toolCategory !== "shell"
      || requestedDurableApprovalRecordAllowed !== false || req.sessionId !== hostTerminal.sessionId)) {
      throw new Error("approval: host terminal binding does not describe this request");
    }
    const hasShellRuleApprovalContract = !forceExplicit && requestedChoices === undefined &&
      req.source === "builtin" && (req.toolName === "bash" || req.toolName === "powershell" || hostTerminal !== undefined) && req.toolCategory === "shell" &&
      req.category === "tool" && (req.kind === undefined || req.kind === "tool");
    const hasHostShellApprovalContract = hasOneShotHostShellApprovalContract || hasShellRuleApprovalContract;
    if (
      hostShellExecutionPermitBinding !== undefined &&
      (
        !hasHostShellApprovalContract ||
        !matchesHostShellExecutionPermitBindingRequest(
          request,
          hostShellExecutionPermitBinding,
        )
      )
    ) {
      // Do not expose the host-only binding to the renderer, and do not retain it in pending state. A UI request that differs from the bound plain spawn must never mint a receipt, even after an authenticated response.
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: req.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:host-shell-binding-mismatch] ${req.id} ${auditFieldsFor(request)} -> deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "host shell approval binding did not match displayed request",
      });
    }
    const oneShotPermitBinding =
      hostShellExecutionPermitBinding !== undefined &&
      hasHostShellApprovalContract
        ? Object.freeze({
            ...hostShellExecutionPermitBinding,
            allowedDirectories: Object.freeze([...hostShellExecutionPermitBinding.allowedDirectories]),
          })
        : undefined;
    const boundExecutionPlan = oneShotPermitBinding === undefined
      ? undefined
      : getHostShellExecutionPlanAuditProjection(oneShotPermitBinding.plan);
    if (
      boundExecutionPlan !== undefined &&
      suppliedExecutionPlan !== undefined &&
      suppliedExecutionPlan !== boundExecutionPlan
    ) {
      // A Plan-B display must describe the exact host-sealed plan behind the hidden permit. Do not allow a second, even host-issued, projection to make the user approve a different substrate.
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: req.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:execution-plan-mismatch] ${req.id} ${auditFieldsFor(request, boundExecutionPlan)} -> deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "execution plan did not match the host shell binding",
      });
    }
    const executionPlanAudit = boundExecutionPlan ?? suppliedExecutionPlan;
    if (executionPlanAudit?.executionRequest === "host" &&
      (oneShotPermitBinding === undefined || remoteControllerOrigin !== undefined || remoteControllerAuthority !== undefined ||
        this.liveSurfaceFor(req.sessionId, req.egressHost?.terminalTabId) === null)) {
      return markHostApprovalRejectedDecision({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: this.liveSurfaceFor(req.sessionId, req.egressHost?.terminalTabId) === null
          ? NO_APPROVER_MESSAGE
          : "explicit host execution requires a local desktop approval",
      });
    }

    // Sandbox capability injection is scoped to the tool-execution approval surface. Non-execution surfaces (out-of-allowed-dir directory confirm, agent-action/mode-change config asks) have no sandbox row in their DOM and showing "isolation: none" on a config change is misleading because no tool will run. The injection guard checks BOTH `kind` AND `toolCategory`: - `kind === "out-of-allowed-dir"` → no injection - `kind === "agent-action"` → no injection - `toolCategory === "meta"` → no injection (catches mode-change asks that default `kind` to "tool") - else (tool execution) → inject Caller-supplied capability is always preserved (`??` semantics).
    const isExecutionKind =
      (req.kind === undefined ||
        req.kind === "tool" ||
        req.kind === "rationale") &&
      req.toolCategory !== "meta";
    const displayedSandboxCapability = requestedSandboxCapability ??
      (isExecutionKind && req.source !== undefined
        ? resolveReviewerSandboxCapability(req.source, req.toolName)
        : undefined);
    const canRememberRequest = durableApprovalRecordAllowed &&
      (req.kind === undefined || req.kind === "tool") && req.category === "tool" &&
      !forceExplicit &&
      remoteControllerOrigin === undefined && remoteControllerAuthority === undefined &&
      (requestedChoices === undefined || requestedChoices.includes("allow-always"));
    const assessmentUnavailable = reviewerOutcome === "unavailable" || reviewerOutcome === "error" ||
      reviewerOutcome === "timeout" || reviewerOutcome === "malformed";
    const unreviewed = reviewerOutcome === undefined || reviewerOutcome === "host-determined";
    const verifiedApprovalBasis = canRememberRequest && req.evaluationContext?.headless === false
      ? unreviewed && matchesApprovalRuleBasis(approvalRuleBasis, req)
        ? approvalRuleBasis
        : assessmentUnavailable && matchesReviewerApprovalBasis(reviewerApprovalBasis, req)
          ? reviewerApprovalBasis
          : undefined
      : undefined;
    const riskCeilingAtApproval = verifiedApprovalBasis?.ruleVerdict;
    // One-shot requests never persist a working-directory identity. Do not make their approval depend on validating an unrelated persistent-store scope.
    const workingDirectory = canRememberRequest
      ? verifiedApprovalBasis?.workingDirectory ?? (req.evaluationContext?.executionCwd
          ? captureApprovalWorkingDirectory(req.evaluationContext.executionCwd) : undefined)
      : undefined;
    const persistentAllowAllowed = canRememberRequest && workingDirectory !== undefined;
    const rawShellArgs = req.args && typeof req.args === "object" && !Array.isArray(req.args)
      ? req.args as Record<string, unknown> : undefined;
    const shellRuleCwd = req.evaluationContext?.executionCwd;
    // Ordinary shell cards may save a rule; forced one-shot cards cannot create remembered authority.
    const shellRuleSaveAllowed = hasShellRuleApprovalContract && !hasOneShotApprovalChoiceContract &&
      remoteControllerOrigin === undefined && remoteControllerAuthority === undefined;
    const shellRuleDialect = req.toolName === "bash" || req.toolName === "powershell" ? req.toolName : undefined;
    const shellRule = hostTerminal !== undefined
      // The person's own host terminal: an exact HostTerminal(...) allow, always user-global, never a session rule; a Bash deny still narrows.
      ? typeof rawShellArgs?.command === "string" && rawShellArgs.command === hostTerminal.command
        ? buildHostTerminalRuleApproval(hostTerminal, { allow: shellRuleSaveAllowed, deny: remoteControllerOrigin === undefined && remoteControllerAuthority === undefined })
        : (() => { throw new Error("approval: host terminal command does not match the request"); })()
      : req.source === "builtin" && shellRuleDialect !== undefined &&
      (req.kind === undefined || req.kind === "tool") && req.category === "tool" &&
      typeof rawShellArgs?.command === "string" && shellRuleCwd
      ? buildShellRuleApproval(shellRuleDialect, rawShellArgs.command, shellRuleCwd, {
        allow: shellRuleSaveAllowed,
        // A deny only narrows, so "Always deny" stays on one-shot cards too; never for a remote controller.
        deny: !forceExplicit && remoteControllerOrigin === undefined && remoteControllerAuthority === undefined,
      }, req.sessionId, verifiedShellCommand)
      : undefined;
    const fullReq: ApprovalRequest = {
      ...request,
      ...(executionPlanAudit === undefined
        ? {}
        : { executionPlan: executionPlanAudit }),
      ...(oneShotPermitBinding === undefined
        ? {}
        : { executionCwd: oneShotPermitBinding.resolvedCwd }),
      // Rationale's generic reason is deliberately not caller-controlled. Set this before all downstream handling, including audit, OS notification, HMAC sealing, pending state, and renderer narrowing.
      reason:
        req.kind === "rationale" && rationaleDisplay !== null
          ? RATIONALE_HOST_OWNED_REASON
          : req.reason,
      // A sealed execution plan is the only renderer-safe authority description for canonical host shells. Its projection deliberately excludes the host capability's free-form reason, so never retain or inject the raw capability alongside it.
      ...(executionPlanAudit === undefined
        ? {
            // Substrate-aware fallback: the gate does not get to answer the isolation question itself. `resolveReviewerSandboxCapability` is the authority the executor lane already uses, and it carries the NO-LEAK INVARIANT — never report `asrt` for a worker this process did not wrap. A process-global probe cannot honour that: it would claim host-shell ASRT confinement for a plugin/MCP call that runs in an unwrapped long-lived worker. `source` omitted ⇒ the substrate is unknown ⇒ no row, rather than a guessed one (fail closed; never fall back to "builtin", whose canonical-shell branch can legitimately report `asrt`).
            sandboxCapability:
              displayedSandboxCapability,
          }
        : {}),
      allowedChoices:
        req.kind === "rationale" || forceExplicit
          ? ["allow-once", "deny-once"]
          : req.allowedChoices,
      persistentAllowAllowed,
      exactRecordAllowed: durableApprovalRecordAllowed,
      ...(shellRule === undefined ? {} : { shellRule }),
      persistentApprovalCwd: persistentAllowAllowed ? workingDirectory?.path : undefined,
      requireExplicit:
        req.kind === "rationale"
          ? true
          // Only an explicit false relaxes it: a policy object that lost the field stays explicit.
          : oneShotPermitBinding !== undefined || hostTerminal !== undefined || forceExplicit || this.currentPolicy.requireExplicitApproval !== false,
    };

    // Missing or destroyed registered owners have the same fail-closed semantics as headless runs.
    if (this.liveSurfaceFor(fullReq.sessionId, fullReq.egressHost?.terminalTabId) === null) {
      const headless = this.headlessDenied !== undefined;
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: headless
          ? `[approval:decided] ${fullReq.id} ${auditFieldsFor({ ...fullReq, answeredBy: "headless-exec" }, executionPlanAudit)} choice=deny-once rememberPattern=no approval surface`
          : `[approval:send-failed] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} — no approval surface → deny-once`,
      });
      try { this.headlessDenied?.(fullReq.id, fullReq.toolName); } catch { /* Notification cannot change a deny. */ }
      return markHostApprovalRejectedDecision({
        requestId: fullReq.id,
        choice: "deny-once",
        rememberPattern: NO_APPROVER_MESSAGE,
      });
    }

    // phase: requested
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
      type: "approval",
      // Emit provenance fields needed to distinguish a host tool ask from a plugin-origin agent-action request during incident replay.
      input: `[approval:requested] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)}`,
    });

    // Aborted turns receive host-rejected deny-once with no remembered pattern, never a user-authored denial. Share the cancelled audit marker with rationale retirement and retain the stop reason to distinguish owner Stop from host tile release.
    const abortCause = (): string => {
      const reason: unknown = this.lifetime.signal.aborted ? this.lifetime.signal.reason : abortSignal?.reason;
      if (reason instanceof Error) return reason.message;
      return typeof reason === "string" ? reason : "unspecified";
    };
    const denyForAbortedTurn = (): ApprovalDecision => {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:cancelled] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} reason=turn-abort cause=${JSON.stringify(abortCause())} → deny-once`,
      });
      return markHostApprovalRejectedDecision({
        requestId: fullReq.id,
        choice: "deny-once",
      });
    };
    // Above the away answer, the OS notification and the renderer send, all for one reason: none of them should happen on behalf of a turn that is already over. An away grant in particular has a finite budget, and spending a unit of it to answer a dead turn spends it on nothing.
    if (this.lifetime.signal.aborted || abortSignal?.aborted) return denyForAbortedTurn();

    if (oneShotPermitBinding !== undefined) {
      const displayedArgs = maskArgsForDisplay(fullReq.args, new Set<string>());
      const displayedCwd = maskSensitiveData(oneShotPermitBinding.resolvedCwd).masked;
      if (canonicalStringify(displayedArgs) !== canonicalStringify(fullReq.args) ||
          displayedCwd !== oneShotPermitBinding.resolvedCwd) {
        // Exact host consent cannot authorize bytes hidden by display masking. Preserve masking and reject before signing or parking the request.
        const reason = "Host execution cannot be approved because sensitive-data masking would hide part of the command, working directory, or justification.";
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:host-display-inexact] ${fullReq.id} toolName=${fullReq.toolName} -> deny-once`,
        });
        return markHostApprovalRejectedDecision({ requestId: fullReq.id, choice: "deny-once", rememberPattern: reason });
      }
    }

    // surface a system notification when an approval is about to block the user. Approval is the most user-visible gate; default to urgent so the OS toast plays sound even when window is backgrounded.
    try {
      this.notificationService?.fire({
        kind: "approval",
        title: t("be_approvalGate.notificationTitle"),
        body: this.notificationBody(fullReq),
        contextRef: { approvalId: fullReq.id, sessionId: fullReq.sessionId },
        urgent: true,
      });
    } catch {
      // notification failure must never block approval flow
    }

    if (this.lifetime.signal.aborted || abortSignal?.aborted) return denyForAbortedTurn();

    // Mint nonce + HMAC, attach to outgoing request (confused-deputy defense)
    const nonce = randomBytes(16).toString("hex");
    const expectedHmac = signApprovalRequest(this.sessionKey, {
      id: fullReq.id,
      nonce,
      toolName: fullReq.toolName,
      sessionId: fullReq.sessionId,
      args: fullReq.args,
      executionCwd: fullReq.executionCwd,
    });
    const signedReq: ApprovalRequest = {
      ...fullReq,
      // Added after the preimage above rather than before it, deliberately. The signature authenticates what the renderer echoes back, and this field is outbound-only — see its declaration.
      nonce,
      hmac: expectedHmac,
    };

    const waitForHuman = (): Promise<ApprovalDecision> => new Promise((resolve, reject) => {
      // One teardown authority for every way this request can end. `settle` is what the pending entry stores, so the renderer answer, the timeout, the rationale cancel and the shutdown sweep each detach the abort listener without any of them having to know it exists. Otherwise a turn that asks a hundred times leaves a hundred live listeners on one signal, and `AbortSignal` is an `EventTarget`, which starts warning about exactly that at eleven.
      let detachAbortListener: (() => void) | undefined;
      // The renderer the card was sent to; the settle announcement reaches it and whichever renderer shows the session by then.
      let sentTo: WebContents | null = null;
      const settle = (decision: ApprovalDecision): void => {
        detachAbortListener?.();
        detachAbortListener = undefined;
        // Every way a PARKED request ends passes through here — desk answer, remote answer, timeout, turn abort, cancel, shutdown sweep — so this is the one place an observer's card — and the renderer's — can be told the request is no longer answerable.
        this.notifyPendingSettled(fullReq.id, decision);
        const refetchers = this.refetchedBy.get(fullReq.id) ?? [];
        this.refetchedBy.delete(fullReq.id);
        // Finalization is independent of optional delivery to a new owner.
        // Ownership contract errors still propagate on reads and answers.
        resolve(decision);
        const recipients = [sentTo, ...refetchers];
        this.announceSettledToRenderer(fullReq.id, recipients);
        try {
          const currentOwner = this.liveSurfaceFor(fullReq.sessionId, fullReq.egressHost?.terminalTabId);
          if (currentOwner && !recipients.includes(currentOwner)) {
            this.announceSettledToRenderer(fullReq.id, [currentOwner]);
          }
        } catch (error) {
          this.auditLogger?.log({
            timestamp: new Date().toISOString(),
            sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
            type: "approval",
            output: `[approval:notification-owner-failed] ${fullReq.id} error=${errorMessage(error)}`,
          });
        }
      };
      const waitMs = ownerUnattended
        ? this.ownerAwayAutoSkipMinutes * 60_000
        : this.timeoutMs;
      const deadline = Date.now() + waitMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expire = (): void => {
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
          const entry = this.pending.get(fullReq.id);
          if (entry) entry.timer = timer;
          return;
        }
        this.pending.delete(fullReq.id);
        // Timeout denies once without persisting authority.
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:timeout] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} → deny-once`,
        });
        const timeoutDecision: ApprovalDecision = {
          requestId: fullReq.id,
          choice: "deny-once",
          ...(ownerUnattended ? { rememberPattern: NO_APPROVER_MESSAGE } : {}),
        };
        hostTimeoutDecisions.add(timeoutDecision);
        settle(timeoutDecision);
      };
      if (waitMs > 0) timer = setTimeout(expire, Math.min(waitMs, 2_147_483_647));

      if (abortSignal !== undefined) {
        const onAbort = (): void => {
          clearTimeout(timer);
          // Drop the entry before resolving, so a renderer answer that crossed the abort in flight arrives as a harmless unknown-request replay instead of an answer to a turn that no longer exists.
          this.pending.delete(fullReq.id);
          settle(denyForAbortedTurn());
        };
        detachAbortListener = () =>
          abortSignal.removeEventListener("abort", onAbort);
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(fullReq.id, {
        resolve: settle,
        reject,
        timer,
        trustOrigin: fullReq.trustOrigin ?? "unknown",
        sessionId: fullReq.sessionId,
        // Carried from the request, not re-derived: the pending entry outlives the request object and is the only copy the decided/timeout/cancelled rows can read.
        remoteControllerOrigin,
        toolName: fullReq.toolName,
        args: fullReq.args,
        category: fullReq.category,
        kind: fullReq.kind,
        allowedChoices: fullReq.allowedChoices,
        toolCategory: fullReq.toolCategory,
        verdictAtApproval,
        source: fullReq.source,
        sourcePluginId: fullReq.sourcePluginId,
        approvalScope: fullReq.approvalScope,
        ...(fullReq.outOfAllowedDir === undefined
          ? {}
          : {
              outOfAllowedDir: {
                candidatePath: fullReq.outOfAllowedDir.candidatePath,
                suggestedParent: fullReq.outOfAllowedDir.suggestedParent,
              },
            }),
        ...(fullReq.egressHost === undefined
          ? {}
          : {
              egressScopes: [...fullReq.egressHost.scopes],
              ...(fullReq.egressHost.terminalTabId === undefined
                ? {}
                : { egressTerminalTabId: fullReq.egressHost.terminalTabId }),
              egressRule: {
                host: fullReq.egressHost.host,
                port: fullReq.egressHost.port,
                network: fullReq.egressHost.network,
                rule: fullReq.egressHost.rule,
                ...(fullReq.egressHost.projectCwd === undefined ? {} : { projectCwd: fullReq.egressHost.projectCwd }),
              },
            }),
        approvalCacheKey: fullReq.approvalCacheKey,
        approvalMemory: fullReq.approvalMemory,
        durableApprovalRecordAllowed,
        persistentAllowAllowed,
        shellRule,
        verifiedShellCommand,
        projectCwd: workingDirectory?.path,
        workingDirectoryIdentity: workingDirectory?.identity,
        riskCeilingAtApproval,
        ...(executionPlanAudit === undefined
          ? {}
          : { executionPlan: executionPlanAudit }),
        ...(oneShotPermitBinding !== undefined
          ? { hostShellExecutionPermitBinding: oneShotPermitBinding }
          : {}),
        ...(hostTerminal === undefined ? {} : { hostTerminal }),
        nonce,
        expectedHmac,
      });

      // Announce the parked request to host-internal observers. Positioned after `pending.set` so an observer's answer through `resolve` finds the entry, and below every host-only short circuit above (which all returned before a pending entry existed).
      // Desktop-only requests are never announced to host-internal observers (Telegram and other remote surfaces answer through them).
      if (oneShotPermitBinding?.executionMode !== "host" && hostTerminal === undefined) this.notifyPendingParked({
        requestId: fullReq.id,
        toolName: fullReq.toolName,
        ...(fullReq.source === undefined ? {} : { source: fullReq.source }),
        category: fullReq.category,
        ...(fullReq.kind === undefined ? {} : { kind: fullReq.kind }),
        ...(fullReq.allowedChoices === undefined
          ? {}
          : { allowedChoices: fullReq.allowedChoices }),
        ...(fullReq.sessionId === undefined
          ? {}
          : { sessionId: fullReq.sessionId }),
        nonce,
        hmac: expectedHmac,
      });

      // Send the request to the renderer (main→renderer one-way). Mask sensitive args for display; the original args stay inside the executor and are still used for tool execution. Attach nonce+hmac to the masked payload for confused-deputy defense.
      const dlpHits = new Set<string>();
      // Sealing is total by construction (the closing constructor throws rather than emitting an unparseable display), so this throw path should be unreachable — but an unreachable throw that would strand the pending entry until timeout is still a liveness hole. Mirror the send-failure branch below: clear pending, audit, deny once.
      let maskedSignedReq: ApprovalRequest;
      try {
        maskedSignedReq =
        fullReq.kind === "rationale" && rationaleDisplay !== null
          ? createRendererSafeRationaleApprovalRequest(
              signedReq,
              rationaleDisplay,
              dlpHits,
            )
          : {
              ...signedReq,
              args: maskArgsForDisplay(fullReq.args, dlpHits),
              ...(signedReq.approvalPurpose
                ? {
                    approvalPurpose: maskApprovalPurposeForDisplay(
                      signedReq.approvalPurpose,
                      dlpHits,
                    ),
                  }
                : {}),
            };
      } catch (sealErr) {
        clearTimeout(timer);
        this.pending.delete(fullReq.id);
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:seal-failed] ${fullReq.id} toolName=${fullReq.toolName} error=${errorMessage(sealErr)} → deny-once`,
        });
        settle(
          markHostApprovalRejectedDecision({
            requestId: fullReq.id,
            choice: "deny-once",
          }),
        );
        return;
      }
      if (dlpHits.size > 0) {
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:args-dlp-masked] ${fullReq.id} toolName=${fullReq.toolName} trustOrigin=${fullReq.trustOrigin ?? "unknown"} detections=${[...dlpHits].join(",")}`,
        });
      }
      // Keep what the renderer is about to receive, so a renderer that loads after this send can be handed the same card (see listPendingRendererRequests).
      const parked = this.pending.get(fullReq.id);
      if (parked !== undefined) parked.rendererRequest = maskedSignedReq;
      // on send failure (webContents destruction race), clear pending and deny once.
      let surfaceUnavailable = false;
      try {
        // Resolve the live owner again before sending; a conversation may have moved.
        const surface = this.liveSurfaceFor(fullReq.sessionId, fullReq.egressHost?.terminalTabId);
        if (!surface) {
          surfaceUnavailable = true;
          throw new Error("no approval surface");
        }
        if (this.lifetime.signal.aborted || !this.pending.has(fullReq.id)) return;
        sentTo = surface;
        surface.send(IPC_APPROVAL_REQUEST, maskedSignedReq);
      } catch (sendErr) {
        clearTimeout(timer);
        this.pending.delete(fullReq.id);
        // phase: send-failed
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: fullReq.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:send-failed] ${fullReq.id} ${auditFieldsFor(fullReq, executionPlanAudit)} error=${errorMessage(sendErr)} → deny-once`,
        });
        settle(
          markHostApprovalRejectedDecision({
            requestId: fullReq.id,
            choice: "deny-once",
            ...(surfaceUnavailable ? { rememberPattern: NO_APPROVER_MESSAGE } : {}),
          }),
        );
      }
    });
    return (toolApprovalWait ?? withToolApprovalWait)(() => {
      if (this.lifetime.signal.aborted || abortSignal?.aborted) {
        return Promise.resolve(denyForAbortedTurn());
      }
      return waitForHuman();
    });
  }

  // Resolve responses from non-native host surfaces. Ignores unknown pending entries, making duplicate responses safe. `answeredBy` is host-derived AT THE CALL SITE, never read from the decision payload: the renderer's IPC route and the plugin host-API route use separate entry points; the paired chat-platform card handler is the one caller that passes `"platform-bridge"`. Every answerer passes the same integrity and allowed-choice checks below — there is deliberately no second integrity or choice-validation implementation.
  resolve(
    requestId: string,
    decision: ApprovalDecision,
    answeredBy: ApprovalAnswerer = "desk",
  ): ApprovalDecision | null {
    return this.resolveDecision(requestId, decision, answeredBy, false);
  }

  // The IPC handler validates the exact app main frame; the gate validates its live ownership before any answer can acquire native consent provenance.
  resolveFromDesktopRenderer(
    requestId: string,
    decision: ApprovalDecision,
    responder: WebContents,
  ): ApprovalDecision | null {
    return this.resolveDecision(requestId, decision, "desk", true, responder);
  }

  // Additional terminal-tab ownership restriction for remembered rule writes.
  mayRecordFrom(requestId: string, contents: WebContents | undefined): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    return entry.egressTerminalTabId === undefined || this.isRendererOwner(entry, contents);
  }

  // Resolve on every read or answer: a pending card follows its conversation
  // or terminal when it moves, rather than retaining the original renderer.
  private isRendererOwner(entry: PendingEntry, contents: WebContents | undefined): boolean {
    if (contents === undefined || contents.isDestroyed()) return false;
    return this.liveSurfaceFor(entry.sessionId, entry.egressTerminalTabId) === contents;
  }

  // Request-bound renderer operations (answers, remembered choices and scope
  // proposals) share the same live owner check. Never infer ownership from a
  // nonce or a renderer-supplied conversation id.
  canAccessRendererRequest(
    requestId: string,
    contents: WebContents | undefined,
    answeredBy: ApprovalAnswerer,
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (this.isRendererOwner(entry, contents)) return true;
    const reason = entry.egressTerminalTabId === undefined ? "surface-owner-required" : "terminal-owner-required";
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
      type: "approval",
      output: `[approval:${reason}] ${requestId} ${formatApprovalAuditFields({ ...entry, answeredBy }, entry.executionPlan)} -> response-rejected`,
    });
    return false;
  }

  private resolveDecision(
    requestId: string,
    decision: ApprovalDecision,
    answeredBy: ApprovalAnswerer,
    nativeRenderer: boolean,
    responder?: WebContents,
  ): ApprovalDecision | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    if ((nativeRenderer || entry.egressTerminalTabId !== undefined) && !this.canAccessRendererRequest(requestId, responder, answeredBy)) {
      // Reject before integrity checks: a foreign response cannot settle or
      // damage the owner's pending request, even with valid signed contents.
      return null;
    }
    if ((entry.hostShellExecutionPermitBinding?.executionMode === "host" || entry.hostTerminal !== undefined) && !nativeRenderer) {
      // Signed card contents authenticate a request, not the answering surface. Reject plugin/platform answers while keeping the desktop request pending.
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:native-desktop-required] ${requestId} ${formatApprovalAuditFields({ ...entry, answeredBy }, entry.executionPlan)} -> response-rejected`,
      });
      return null;
    }

    // Confused-deputy defense — verify nonce + HMAC BEFORE honoring the decision. A mismatch indicates either a malicious/compromised renderer, a replay of a stale decision, or a cross-request mix-up. Force deny-once and audit the failure.
    if (!verifyApprovalIntegrity(entry, decision)) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:nonce-mismatch] ${requestId} ${formatApprovalAuditFields(entry, entry.executionPlan)} choice=${decision.choice} nonceProvided=${decision.nonce ? "yes" : "no"} hmacProvided=${decision.hmac ? "yes" : "no"} → deny-once (forced)`,
      });
      const forcedDecision: ApprovalDecision = {
        requestId,
        choice: "deny-once",
        rememberPattern: "approval integrity check failed",
      };
      hostRejectedApprovalDecisions.add(forcedDecision);
      entry.resolve(forcedDecision);
      return forcedDecision;
    }

    if (
      entry.allowedChoices &&
      !entry.allowedChoices.includes(decision.choice)
    ) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:choice-not-allowed] ${requestId} ${formatApprovalAuditFields(entry, entry.executionPlan)} choice=${decision.choice} allowed=${entry.allowedChoices.join(",")} → deny-once (forced)`,
      });
      const forcedDecision: ApprovalDecision = {
        requestId,
        choice: "deny-once",
        rememberPattern: "approval choice not allowed",
      };
      hostRejectedApprovalDecisions.add(forcedDecision);
      entry.resolve(forcedDecision);
      return forcedDecision;
    }
    // An egress-host allow names how long it lasts. Only the desktop window may answer one (a grant can outlive the conversation), and the scope must be one the card offered: anything else is a deny, never a guess.
    if (entry.kind === "egress-host" && !nativeRenderer) {
      // A grant can outlive the conversation, so only the desktop window may answer an egress ask, allow or deny: the person at the desktop is the one asked. Any other surface's answer is ignored and the request stays pending for the desktop, as for a host-shell execution permit.
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:native-desktop-required] ${requestId} ${formatApprovalAuditFields({ ...entry, answeredBy }, entry.executionPlan)} -> response-rejected`,
      });
      return null;
    }
    if (entry.kind === "egress-host" && decision.choice !== "deny-once") {
      const offered = entry.egressScopes ?? [];
      const problem = decision.choice !== "allow-once"
          ? "egress approval choice must be allow-once with a scope"
          : decision.egressScope === undefined || !offered.includes(decision.egressScope)
            ? "egress approval scope not offered"
            : undefined;
      if (problem !== undefined) {
        clearTimeout(entry.timer);
        this.pending.delete(requestId);
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
          type: "approval",
          output: `[approval:egress-scope-rejected] ${requestId} ${formatApprovalAuditFields({ ...entry, answeredBy }, entry.executionPlan)} choice=${decision.choice} scope=${decision.egressScope ?? "none"} → deny-once (forced)`,
        });
        const forcedDecision: ApprovalDecision = { requestId, choice: "deny-once", rememberPattern: problem };
        hostRejectedApprovalDecisions.add(forcedDecision);
        entry.resolve(forcedDecision);
        return forcedDecision;
      }
    }
    // A rationale response is a sealed, one-shot verdict. Do not pass any renderer-provided auxiliary text or structured content to audit or the caller after the authenticated choice has been accepted.
    const resolvedDecision: ApprovalDecision =
      entry.kind === "rationale"
        ? {
            requestId,
            choice: decision.choice,
            nonce: decision.nonce,
            hmac: decision.hmac,
          }
        : decision;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    const transition = entry.ruleSaveTransition;
    if (nativeRenderer && transition?.valid && !transition.saving && transition.from !== transition.to &&
      (resolvedDecision.choice === "allow-once" || resolvedDecision.choice === "allow-session" || resolvedDecision.choice === "allow-always")) {
      this.approvedPolicyTransitions.set(resolvedDecision, { from: transition.from, to: transition.to });
    }
    if (
      entry.hostShellExecutionPermitBinding !== undefined &&
      (resolvedDecision.choice === "allow-once" ||
        resolvedDecision.choice === "allow-session" ||
        resolvedDecision.choice === "allow-always")
    ) {
      hostApprovedOneShotExecutionBindings.set(
        resolvedDecision,
        entry.hostShellExecutionPermitBinding,
      );
    }
    // Derive answeredBy from the host caller, never response fields; renderer/plugin responses cannot forge the audit answerer.
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
      type: "approval",
      output: `[approval:decided] ${requestId} ${formatApprovalAuditFields({ ...entry, answeredBy }, entry.executionPlan)} choice=${resolvedDecision.choice} rememberPattern=${resolvedDecision.rememberPattern ?? "none"}${entry.kind === "egress-host" ? ` egressScope=${resolvedDecision.egressScope ?? "none"}` : ""}`,
    });
    entry.resolve(resolvedDecision);
    return resolvedDecision;
  }

  // Fail-closed cancellation boundary for the host-owned rationale flow. This deliberately refuses to cancel ordinary approval requests: callers may retire only the exact pending rationale request they own. Removing the entry before resolving it makes a late renderer response a harmless unknown-request replay.
  cancelPendingRationale(
    requestId: string,
    reason: "caller-abort" | "session-close" = "caller-abort",
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== "rationale") return false;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: entry.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
      type: "approval",
      output: `[approval:cancelled] ${requestId} ${formatApprovalAuditFields(entry, entry.executionPlan)} reason=${reason} → deny-once`,
    });
    entry.resolve(
      markHostApprovalRejectedDecision({
        requestId,
        choice: "deny-once",
        rememberPattern: `rationale approval cancelled: ${reason}`,
      }),
    );
    return true;
  }
  // server-side ApprovalRequest snapshot lookup. The userApprovalRecord IPC handler binds to an in-flight request by id and reads the canonical `trustOrigin` / `approvalCacheKey` / `toolName` / `source` from the main-process pending entry rather than trusting the renderer payload. Eliminates the "renderer pretends a different trustOrigin" attack class — a renderer XSS that spoofs `trustOrigin: "user-keyboard"` for an `llm-tool-arg` request can no longer fool the user-approval-store cache identity. Returns `null` when no pending entry exists for `requestId` (e.g. the approval already resolved or timed out).
  getRequestSnapshot(requestId: string): {
    toolName: string;
    args: unknown;
    source: ToolSource;
    trustOrigin: string;
    approvalCacheKey: string | undefined;
    approvalMemory: ApprovalMemory | undefined;
    durableApprovalRecordAllowed: boolean;
    persistentAllowAllowed: boolean;
    sessionId: string | undefined;
    projectCwd: string | undefined;
    shellRule: ShellRuleApproval | undefined;
    verifiedShellCommand?: import("./verified-shell-command.js").VerifiedShellCommand;
    egress: (NonNullable<PendingEntry["egressRule"]> & { scopes: readonly EgressGrantScope[]; terminalTabId?: string }) | undefined;
    workingDirectoryIdentity: string | undefined;
    riskCeilingAtApproval: RiskLevel | undefined;
    verdictAtApproval: RiskVerdict["level"];
  } | null {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind === "rationale") return null;
    return {
      toolName: entry.toolName,
      args: entry.args,
      // PendingEntry.source can be undefined for legacy callers — default to "builtin" so cache identity is conservative (high-trust source). The strict-record handler additionally validates against the SOT emitter; this default never widens an existing approval.
      source: entry.source ?? "builtin",
      trustOrigin: entry.trustOrigin,
      approvalCacheKey: entry.approvalCacheKey,
      approvalMemory: entry.approvalMemory,
      durableApprovalRecordAllowed: entry.durableApprovalRecordAllowed,
      persistentAllowAllowed: entry.persistentAllowAllowed,
      sessionId: entry.sessionId,
      projectCwd: entry.projectCwd,
      shellRule: entry.shellRule,
      ...(entry.verifiedShellCommand === undefined ? {} : { verifiedShellCommand: entry.verifiedShellCommand }),
      egress: entry.egressRule === undefined ? undefined : {
        ...entry.egressRule,
        scopes: entry.egressScopes ?? [],
        ...(entry.egressTerminalTabId === undefined ? {} : { terminalTabId: entry.egressTerminalTabId }),
      },
      workingDirectoryIdentity: entry.workingDirectoryIdentity,
      riskCeilingAtApproval: entry.riskCeilingAtApproval,
      verdictAtApproval: entry.verdictAtApproval,
    };
  }

  // Pending cards for this renderer's currently hosted sessions and terminals. Reloaded or moved conversations recover their signed cards without disclosing other windows' requests.
  listPendingRendererRequests(recipient: WebContents): ApprovalRequest[] {
    const out: ApprovalRequest[] = [];
    for (const [id, entry] of this.pending) {
      if (entry.rendererRequest === undefined) continue;
      if (!this.isRendererOwner(entry, recipient)) continue;
      out.push(entry.rendererRequest);
      // The reader now draws this card too; tell it when the request settles.
      const readers = this.refetchedBy.get(id) ?? new Set<WebContents>();
      readers.add(recipient);
      this.refetchedBy.set(id, readers);
    }
    return out;
  }

  // the host's own view of a pending out-of-allowed-dir request, for `/allow`. The renderer sends a request id and a sentence. Everything the option table and the selector envelope are built from is read back out of THIS map, so a renderer that lies about a path, a tool name or a set of allowed choices changes nothing: it is describing a request the host resolved. Returns `null` for any other kind, and for a request that already resolved or timed out. `/allow` has no meaning without a live prompt, and a stale id must not produce one.
  getApprovalSentenceState(requestId: string): {
    toolName: string;
    toolCategory: ToolCategory | undefined;
    source: ToolSource;
    candidatePath: string;
    suggestedParent: string | null;
    allowedChoices: readonly ApprovalChoice[] | undefined;
  } | null {
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== "out-of-allowed-dir") return null;
    if (!entry.outOfAllowedDir) return null;
    return {
      toolName: entry.toolName,
      toolCategory: entry.toolCategory,
      source: entry.source ?? "builtin",
      candidatePath: entry.outOfAllowedDir.candidatePath,
      suggestedParent: entry.outOfAllowedDir.suggestedParent,
      allowedChoices: entry.allowedChoices,
    };
  }

  // Permanently close admission, cancel approval stages, and deny parked requests during app shutdown.
  disposeAll(): void {
    this.lifetime.abort(new Error("approval gate shutdown"));
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(
        markHostApprovalRejectedDecision({
          requestId: id,
          choice: "deny-once",
        }),
      );
    }
    this.pending.clear();
  }

  // Current pending request count (for tests).
  get pendingCount(): number {
    return this.pending.size;
  }

  // Currently active policy (for tests).
  get policy(): PolicyFile {
    return this.currentPolicy;
  }
}
