import {
  isIssuedHostShellExecutionPlanAuditProjection,
  type HostShellExecutionPlanAuditProjection,
} from "../permissions/host-shell-execution-plan.js";
import type { ToolCategory, ToolSource } from "./permission-review-status.js";

/** Whether this host process can present and settle a local approval request. */
export type ApprovalSurface = "interactive" | "unavailable";

/**
 * Safe, machine-readable description of an authorization boundary that stopped
 * a turn. Raw tool arguments, commands, paths, prompts, and reviewer prose are
 * deliberately absent: this shape is emitted by native CLI and owner streams.
 */
export interface AuthorizationRequiredState {
  readonly kind: "tool" | "directory" | "host-execution";
  readonly toolName: string;
  readonly source: ToolSource;
  readonly category: ToolCategory;
  readonly reason:
    | "approval-surface-unavailable"
    | "directory-authorization-required"
    | "host-execution-authorization-required";
  readonly deferredRequestId?: string;
  readonly executionPlan?: HostShellExecutionPlanAuditProjection;
}

/**
 * Host-private control carried by one ToolResult. A structural lookalike from
 * a plugin, MCP server, model, or test double is not authority to stop a turn.
 */
export interface AuthorizationRequiredControl {
  readonly type: "authorization_required";
  readonly state: AuthorizationRequiredState;
}

const issuedControls = new WeakSet<object>();
const issuedStates = new WeakSet<object>();

export function issueAuthorizationRequiredControl(
  state: AuthorizationRequiredState,
): AuthorizationRequiredControl {
  // Rebuild the public state field by field. Even a mistaken internal caller
  // passing an object with extra command/path/prompt fields cannot make those
  // fields part of CLI or owner-stream terminal metadata.
  const safeState: AuthorizationRequiredState = Object.freeze({
    kind: state.kind,
    toolName: state.toolName,
    source: state.source,
    category: state.category,
    reason: state.reason,
    ...(state.deferredRequestId === undefined
      ? {}
      : { deferredRequestId: state.deferredRequestId }),
    ...(state.executionPlan !== undefined &&
        isIssuedHostShellExecutionPlanAuditProjection(state.executionPlan)
      ? { executionPlan: state.executionPlan }
      : {}),
  });
  issuedStates.add(safeState);
  const control: AuthorizationRequiredControl = Object.freeze({
    type: "authorization_required",
    state: safeState,
  });
  issuedControls.add(control);
  return control;
}

/** Return a safe terminal state only for a control minted in this process. */
export function authorizationRequiredStateOf(
  value: unknown,
): AuthorizationRequiredState | undefined {
  if (!value || typeof value !== "object" || !issuedControls.has(value as object)) {
    return undefined;
  }
  const control = value as AuthorizationRequiredControl;
  return control.type === "authorization_required" ? control.state : undefined;
}

/** Project only host-issued, already allowlisted terminal metadata to output. */
export function authorizationRequiredStateForOutput(
  value: unknown,
): AuthorizationRequiredState | undefined {
  return value && typeof value === "object" && issuedStates.has(value as object)
    ? value as AuthorizationRequiredState
    : undefined;
}

/**
 * Host-issued authority for one windowless turn that the local owner started
 * from this process's own command line. It selects the unattended policy lane
 * for that turn — reviewer-routed asks, deferred directory holds, and a
 * fail-closed answer to explicit host execution — without changing the loop's
 * tool, plugin, MCP, or egress scope, which stays owned by the routine-only
 * `headless` loop flag. A turn that arrives through a remote surface never
 * carries it, so an attached client cannot borrow the owner's unattended lane
 * from a retained session. A structural lookalike from chat input, a plugin,
 * an MCP server, a model, or a test double is not this authority.
 */
export interface UnattendedTurnAuthority {
  readonly kind: "native-exec";
}

const issuedUnattendedTurnAuthorities = new WeakSet<object>();

export function issueUnattendedTurnAuthority(): UnattendedTurnAuthority {
  const authority: UnattendedTurnAuthority = Object.freeze({ kind: "native-exec" });
  issuedUnattendedTurnAuthorities.add(authority);
  return authority;
}

/** True only for an authority minted in this process. */
export function isIssuedUnattendedTurnAuthority(
  value: unknown,
): value is UnattendedTurnAuthority {
  return typeof value === "object" && value !== null
    && issuedUnattendedTurnAuthorities.has(value);
}
