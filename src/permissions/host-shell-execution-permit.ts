// Plans describe substrates, not authorization. Bind proof privately to one final action and consume it before plain-host spawn.
import type { ChildProcess } from "node:child_process";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";
import { captureShellWorkingDirectoryIdentity, holdShellWorkingDirectory, matchesShellWorkingDirectoryIdentity, pinShellWorkingDirectory, sameShellWorkingDirectoryIdentity, type ShellWorkingDirectoryIdentity } from "./shell-working-directory-identity.js";
import {
  parseHostShellExecutionInput,
  exactRulePassesUnsandboxedShellAsk,
  requiresExplicitHostShellApproval,
  requiresUnsandboxedShellAsk,
  type HostShellExecutionPlan,
  type HostShellExecutionRequest,
} from "./host-shell-execution-plan.js";
import {
  consumeHostApprovedOneShotExecutionBinding,
  type ApprovalDecision,
} from "./approval-gate.js";
import {
  consumeIssuedFloorSessionDecision,
  isIssuedFloorSessionDecision,
  consumeIssuedShellAllowRuleDecision,
  isShellAllowRuleAuthorizationCurrent,
  isShellAllowRulePolicyCurrent,
  type PermissionCheckResult,
  type PermissionManager,
  type ShellAllowRuleAuthorization,
} from "./permission-manager.js";
import { withShellPolicyHandoff } from "./shell-policy-handoff.js";

export type HostShellToolName = "bash" | "powershell";

export const HOST_SHELL_AUTHORIZATION_REVOKED_ERROR = "this host shell execution requires a one-shot host approval permit. The working directory or permission policy changed, or the permit is invalid or revoked. Request authorization again.";

// Renderer-invisible action description attached to the approval pending entry. The ApprovalGate issues a receipt only after an HMAC-verified allow-once response for exactly this binding.
export interface HostShellExecutionPermitBinding {
  readonly planIdentity: string;
  readonly plan: HostShellExecutionPlan;
  readonly toolName: HostShellToolName;
  readonly toolUseId: string;
  readonly command: string;
  readonly requestedCwd: string | undefined;
  readonly executionCwd: string;
  readonly resolvedCwd: string;
  readonly cwdIdentity?: ShellWorkingDirectoryIdentity;
  readonly timeoutSeconds: number;
  readonly executionMode: HostShellExecutionRequest;
  readonly justification: string | undefined;
  readonly runInBackground: boolean;
  readonly allowedDirectories: readonly string[];
}

declare const hostShellExecutionPermitBrand: unique symbol;

// Opaque, in-process capability. A structural lookalike is not valid.
export interface HostShellExecutionPermit {
  readonly [hostShellExecutionPermitBrand]: "host-shell-execution-permit";
}

interface PermitRecord extends HostShellExecutionPermitBinding {
  readonly plan: HostShellExecutionPlan;
  readonly allowRuleAuthorization: ShellAllowRuleAuthorization | undefined;
  readonly cwdIdentity: ShellWorkingDirectoryIdentity;
}

export interface HostShellSpawnAuthorization {
  readonly cwdIdentity: ShellWorkingDirectoryIdentity;
}

export function createShellApprovalDirectory(binding: HostShellExecutionPermitBinding) {
  let release: (() => void) | undefined;
  return {
    binding,
    get held() { return release !== undefined; },
    hold(): boolean {
      const { cwdIdentity, resolvedCwd } = binding;
      if (cwdIdentity === undefined) return false;
      if (release !== undefined) return matchesShellWorkingDirectoryIdentity(resolvedCwd, cwdIdentity);
      release = holdShellWorkingDirectory(resolvedCwd, cwdIdentity);
      return release !== undefined;
    },
    dispose(): void {
      const close = release;
      release = undefined;
      close?.();
    },
  };
}

export type ShellApprovalDirectory = ReturnType<typeof createShellApprovalDirectory>;

const permits = new WeakMap<HostShellExecutionPermit, PermitRecord>();
const pendingHandoffs = new WeakMap<HostShellSpawnAuthorization, PermitRecord>();

// Preserve the permit module's public API while moving the runtime parser to a neutral dependency shared with ApprovalGate.
export { parseHostShellExecutionInput } from "./host-shell-execution-plan.js";
export type { ParsedHostShellExecutionInput } from "./host-shell-execution-plan.js";

// Matches the exact cwd resolution used by BashTool and PowerShellTool.
export function resolveHostShellWorkingDirectory(
  executionCwd: string,
  requestedCwd: string | undefined,
): string {
  const resolvedExecutionCwd = pathResolve(executionCwd);
  if (!requestedCwd) return resolvedExecutionCwd;
  return isAbsolute(requestedCwd)
    ? pathResolve(requestedCwd)
    : pathResolve(resolvedExecutionCwd, requestedCwd);
}

// Stable set semantics for the same extra directory scope the tools validate.
export function canonicalizeHostShellAllowedDirectories(
  directories: readonly string[],
): readonly string[] {
  const canonical = directories
    .filter((directory) => directory.length > 0)
    .map((directory) => caseFoldForMatch(canonicalizePathForMatch(directory)));
  return Object.freeze([...new Set(canonical)].sort());
}

// Build the host-only action binding after all path grants and hooks have finalized the invocation. Undefined means the raw input cannot represent a native shell spawn, so the invocation must fail closed before requesting a permit.
export function buildHostShellExecutionPermitBinding(input: {
  plan: HostShellExecutionPlan;
  toolName: HostShellToolName;
  toolUseId: string;
  rawInput: unknown;
  executionCwd: string;
  extraAllowedDirectories: readonly string[];
}): HostShellExecutionPermitBinding | undefined {
  const parsed = parseHostShellExecutionInput(input.rawInput);
  if (parsed === undefined || parsed.executionMode !== input.plan.executionRequest) return undefined;
  const resolvedCwd = resolveHostShellWorkingDirectory(input.executionCwd, parsed.cwd);
  const cwdIdentity = captureShellWorkingDirectoryIdentity(resolvedCwd);
  return Object.freeze({
    planIdentity: input.plan.identity,
    plan: input.plan,
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    command: parsed.command,
    requestedCwd: parsed.cwd,
    executionCwd: input.executionCwd,
    resolvedCwd,
    ...(cwdIdentity === undefined ? {} : { cwdIdentity }),
    timeoutSeconds: parsed.timeoutSeconds,
    executionMode: parsed.executionMode,
    justification: parsed.justification,
    runInBackground: parsed.runInBackground,
    allowedDirectories: canonicalizeHostShellAllowedDirectories(
      input.extraAllowedDirectories,
    ),
  });
}

// Only the host authorization pipeline records these after its policy/reviewer gates pass. Bind to the exact in-process action, never renderer-supplied data.
const policyAuthorizations = new WeakSet<HostShellExecutionPermitBinding>();

// Record one host-policy authorization; it does not change any sandbox plan.
export function recordHostShellPolicyAuthorization(binding: HostShellExecutionPermitBinding): void {
  policyAuthorizations.add(binding);
}

// Consume only action-bound host proof: a verified one-shot receipt, an exact host-request rule decision, the exact-rule pass of the no-backend ask, or the authorization pipeline's normal-policy permit. The partial Windows plan rejects rule proof; structural, unrelated or differently bound decisions fail closed.
export function mintHostShellExecutionPermit(input: {
  plan: HostShellExecutionPlan;
  approvalDecision: ApprovalDecision | undefined;
  allowRuleDecision?: PermissionCheckResult | undefined;
  // A floor session allow `checkDetailed` issued for this action: the person's own "This session" answer on the sandbox-unavailable floor card.
  floorSessionDecision?: PermissionCheckResult | undefined;
  permissionManager?: Pick<PermissionManager, "getPolicyEpoch"> | undefined;
  binding: HostShellExecutionPermitBinding;
}): HostShellExecutionPermit | undefined {
  // The public TypeScript surface declares these fields as required, but module consumers can still arrive through untyped JavaScript or a stale compiled caller. Treat any incomplete input as an unauthorised request instead of throwing before the fail-closed decision.
  if (input.binding === undefined) return undefined;
  let allowRuleAuthorization: ShellAllowRuleAuthorization | undefined;
  // Consumed on every mint attempt, so a recorded authorization never outlives it.
  const policyApproved = policyAuthorizations.delete(input.binding);
  let floorSessionAuthorized = false;
  if (input.approvalDecision === undefined && policyApproved) {
    // The policy lane already decided this exact action.
  } else if (input.approvalDecision === undefined && isIssuedFloorSessionDecision(input.floorSessionDecision, input.permissionManager)) {
    // Burn the floor session proof before any plan check, so a mismatch cannot be probed or replayed.
    floorSessionAuthorized = consumeIssuedFloorSessionDecision(input.floorSessionDecision, {
      toolName: input.binding.toolName,
      dialect: input.binding.toolName,
      command: input.binding.command,
      cwd: input.binding.resolvedCwd,
      planIdentity: input.binding.planIdentity,
    }, input.permissionManager) !== undefined;
    if (!floorSessionAuthorized) return undefined;
  } else if (input.approvalDecision === undefined) {
    if (input.allowRuleDecision === undefined) return undefined;
    // Burn the rule proof before any plan check, so a mismatch cannot be probed or replayed.
    allowRuleAuthorization = consumeIssuedShellAllowRuleDecision(input.allowRuleDecision, {
      toolName: input.binding.toolName,
      dialect: input.binding.toolName,
      command: input.binding.command,
      cwd: input.binding.resolvedCwd,
    }, input.permissionManager);
    if (allowRuleAuthorization === undefined) return undefined;
    if (input.plan.executionRequest !== "host" && allowRuleAuthorization.floorPlanIdentity === undefined) return undefined;
  } else if (
    !consumeHostApprovedOneShotExecutionBinding(
      input.approvalDecision,
      input.binding,
    )
  ) return undefined;
  // Any receipt-bearing mint attempt consumes its receipt before checking plan compatibility, so a mismatch cannot be probed or replayed.
  if (!requiresExplicitHostShellApproval(input.plan, input.binding.toolName) && !policyApproved) return undefined;
  // On a plan under the sandbox-unavailable floor a saved rule stands in for fresh consent only as the exact-rule pass issued on this very plan
  // (tree T:128); policy records are made only after a human card. A pass proof answers no other plan.
  if (allowRuleAuthorization !== undefined && (requiresUnsandboxedShellAsk(input.plan)
    ? !exactRulePassesUnsandboxedShellAsk(input.plan) || allowRuleAuthorization.floorPlanIdentity !== input.plan.identity
    : allowRuleAuthorization.floorPlanIdentity !== undefined)) return undefined;
  // A floor session allow answers only the marked plan it was approved under.
  if (floorSessionAuthorized && (!requiresUnsandboxedShellAsk(input.plan) || input.plan.identity !== input.binding.planIdentity)) return undefined;
  if (
    input.binding.plan !== input.plan ||
    input.binding.planIdentity !== input.plan.identity
  ) return undefined;
  const { cwdIdentity } = input.binding;
  if (cwdIdentity === undefined ||
      (allowRuleAuthorization !== undefined && !sameShellWorkingDirectoryIdentity(cwdIdentity, allowRuleAuthorization.cwdIdentity)) ||
      !matchesShellWorkingDirectoryIdentity(input.binding.resolvedCwd, cwdIdentity)) return undefined;
  const permit = Object.freeze({}) as HostShellExecutionPermit;
  permits.set(permit, Object.freeze({ ...input.binding, plan: input.plan, allowRuleAuthorization, cwdIdentity }));
  return permit;
}

// Verify and irreversibly consume the permit. Delete before comparison so a mismatched/replayed attempt cannot probe or reuse an approved capability.
export function consumeHostShellExecutionPermitForSpawn(input: {
  permit: HostShellExecutionPermit | undefined;
  plan: HostShellExecutionPlan;
  toolName: HostShellToolName;
  toolUseId: string | undefined;
  command: string;
  requestedCwd: string | undefined;
  executionCwd: string;
  resolvedCwd: string;
  timeoutSeconds: number;
  executionMode: HostShellExecutionRequest;
  justification: string | undefined;
  runInBackground: boolean;
  allowedDirectories: readonly string[];
}): HostShellSpawnAuthorization | undefined {
  if (input.permit === undefined) return undefined;
  const record = permits.get(input.permit);
  if (record === undefined) return undefined;
  permits.delete(input.permit);
  const valid = (
    (record.allowRuleAuthorization === undefined || isShellAllowRuleAuthorizationCurrent(record.allowRuleAuthorization)) &&
    matchesShellWorkingDirectoryIdentity(record.resolvedCwd, record.cwdIdentity) &&
    record.plan === input.plan &&
    record.toolName === input.toolName &&
    record.toolUseId === input.toolUseId &&
    record.command === input.command &&
    record.requestedCwd === input.requestedCwd &&
    record.executionCwd === input.executionCwd &&
    record.resolvedCwd === input.resolvedCwd &&
    record.timeoutSeconds === input.timeoutSeconds &&
    record.executionMode === input.executionMode &&
    record.justification === input.justification &&
    record.runInBackground === input.runInBackground &&
    record.executionMode === input.plan.executionRequest &&
    record.allowedDirectories.length === input.allowedDirectories.length &&
    record.allowedDirectories.every(
      (directory, index) => directory === input.allowedDirectories[index],
    )
  );
  if (!valid) return undefined;
  const authorization = Object.freeze({ cwdIdentity: record.cwdIdentity });
  pendingHandoffs.set(authorization, record);
  return authorization;
}

function isHostShellSpawnDirectoryCurrent(record: PermitRecord): boolean {
  // POSIX launches from the physical path after consumption has checked the requested path.
  const cwd = process.platform === "win32" ? record.resolvedCwd : record.cwdIdentity.realpath;
  return matchesShellWorkingDirectoryIdentity(cwd, record.cwdIdentity);
}

export interface HostShellSpawnDirectoryHold {
  /** Keep the hold until this child closes. */
  bind(child: ChildProcess): void;
  /** Release now unless a child was bound. */
  dispose(): void;
}

const NO_DIRECTORY_HOLD: HostShellSpawnDirectoryHold = Object.freeze({ bind() {}, dispose() {} });

/** Windows children open their cwd by path, so the host holds the approved directory chain against rename and delete
 * from before the final check until the child closes. This is not a child-side proof. Other platforms check inside the child. */
export async function holdHostShellSpawnDirectory(authorization: HostShellSpawnAuthorization | undefined): Promise<HostShellSpawnDirectoryHold | undefined> {
  if (authorization === undefined || process.platform !== "win32") return NO_DIRECTORY_HOLD;
  const release = await pinShellWorkingDirectory(authorization.cwdIdentity);
  if (release === undefined) return undefined;
  let bound = false;
  return {
    bind(child) {
      bound = true;
      child.once("close", release);
      child.once("error", release);
    },
    dispose() { if (!bound) release(); },
  };
}

// Burn the spawn authority again at the final, serialized execution handoff.
export async function withHostShellExecutionHandoff<T>(
  authorization: HostShellSpawnAuthorization,
  handoff: (hold: HostShellSpawnDirectoryHold) => T & (T extends PromiseLike<unknown> ? never : unknown),
  prepare?: () => Promise<void>,
): Promise<T | undefined> {
  const record = pendingHandoffs.get(authorization);
  pendingHandoffs.delete(authorization);
  let hold: HostShellSpawnDirectoryHold | undefined;
  try {
    return await withShellPolicyHandoff(() => {
      if (record === undefined || hold === undefined ||
        (record.allowRuleAuthorization !== undefined && !isShellAllowRulePolicyCurrent(record.allowRuleAuthorization)) ||
        !isHostShellSpawnDirectoryCurrent(record)) return undefined;
      // This host's persisted policy mutations share this queue. Uncoordinated external edits after this final validation apply from the next command. The synchronous handoff grants the waiting child (or spawns it on platforms without a child guard); it must never await between validation and grant.
      return handoff(hold);
    }, async () => {
      await prepare?.();
      if (record !== undefined) hold = await holdHostShellSpawnDirectory(authorization);
    });
  } finally {
    hold?.dispose();
  }
}

export function assertHostShellSpawnDirectory(authorization: HostShellSpawnAuthorization | undefined): void {
  if (authorization === undefined) return;
  const record = pendingHandoffs.get(authorization);
  if (record === undefined ||
      !isHostShellSpawnDirectoryCurrent(record)) {
    throw new Error(HOST_SHELL_AUTHORIZATION_REVOKED_ERROR);
  }
  pendingHandoffs.delete(authorization);
}

export function consumeHostShellExecutionPermit(
  input: Parameters<typeof consumeHostShellExecutionPermitForSpawn>[0],
): boolean {
  return consumeHostShellExecutionPermitForSpawn(input) !== undefined;
}
