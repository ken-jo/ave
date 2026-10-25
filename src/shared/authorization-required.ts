import {
  isIssuedHostShellExecutionPlanAuditProjection,
  type HostShellExecutionPlanAuditProjection,
} from "../permissions/host-shell-execution-plan.js";
import type { ToolCategory, ToolSource } from "./permission-review-status.js";

/** Whether this host process can present and settle a local approval request. */
export type ApprovalSurface = "interactive" | "unavailable";

/** Public authorization metadata excludes arguments, commands, paths, prompts, and reviewer prose. */
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

/** Only host-minted controls may stop a turn; structural lookalikes from untrusted sources grant no authority. */
export interface AuthorizationRequiredControl {
  readonly type: "authorization_required";
  readonly state: AuthorizationRequiredState;
}

const issuedControls = new WeakSet<object>();
const issuedStates = new WeakSet<object>();

export function issueAuthorizationRequiredControl(
  state: AuthorizationRequiredState,
): AuthorizationRequiredControl {
  // Rebuild allow-listed fields so extra internal properties cannot leak into terminal metadata.
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

/** One locally minted authority selects unattended policy for one CLI turn without widening tool, plugin, MCP, or egress scope. Remote turns cannot inherit it. */
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

/** Consume once; retained references, steering reruns, and lookalikes cannot authorize another turn. */
export function consumeUnattendedTurnAuthority(value: unknown): boolean {
  if (!isIssuedUnattendedTurnAuthority(value)) return false;
  issuedUnattendedTurnAuthorities.delete(value);
  return true;
}
