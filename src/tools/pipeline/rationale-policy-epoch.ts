import { canonicalStringify } from "../../shared/canonical-json.js";
import type { HookRunner } from "../../hooks/hook-runner.js";
import type { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import type { PermissionManager } from "../../permissions/permission-manager.js";
import type { ApprovalDecision, ApprovalPolicyMutation } from "../../permissions/approval-gate.js";
import { getCategoryRegistryGeneration } from "../../permissions/category-registry.js";
import { getUserApprovalGeneration } from "../../permissions/user-approval-store.js";
import { isPathAllowed } from "../../permissions/allowed-directories.js";
import { caseFoldForMatch } from "../../permissions/sensitive-paths.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";

export interface RationalePolicyEpochSources {
  permissionManager?: PermissionManager;
  hookRunner: HookRunner;
  scriptHookManager?: ScriptHookManager;
  additionalDirectories: readonly string[];
}

export interface RationalePolicySnapshot {
  readonly epoch: string;
  readonly permission: string;
  readonly hooks: string;
  readonly scriptHooks: string;
  readonly approvals: string;
  readonly categories: string;
  readonly additionalDirectories: readonly string[];
}

interface ApprovalMutationAuthority {
  consumeApprovalPolicyMutation?(decision: ApprovalDecision): ApprovalPolicyMutation | undefined;
}

// Empty objects carry no reconstructable authority; the original decision and snapshots live only in this module.
export interface RationaleApprovalPolicyTransition {
  readonly kind: "approved-policy-transition";
}

const issuedSnapshots = new WeakSet<RationalePolicySnapshot>();
const approvalTransitions = new WeakMap<RationaleApprovalPolicyTransition, {
  readonly decision: ApprovalDecision;
  readonly actionDigest: string;
  readonly requestId: string;
  readonly beforeEpoch: string;
  readonly currentEpoch: string;
  readonly directory?: string;
}>();

function normalizedDirectories(directories: readonly string[]): readonly string[] {
  return [...new Set(directories)].sort();
}

function sameDirectories(left: readonly string[], right: readonly string[]): boolean {
  return canonicalStringify(normalizedDirectories(left)) === canonicalStringify(normalizedDirectories(right));
}

// Capture every mutable permission-suffix input from the live host; directory order is not policy.
export function captureRationalePolicySnapshot(sources: RationalePolicyEpochSources): RationalePolicySnapshot {
  const components = {
    permission: sources.permissionManager?.getPolicyEpoch() ?? "unmanaged",
    hooks: sources.hookRunner.getGeneration(),
    scriptHooks: sources.scriptHookManager?.getGeneration() ?? "unwired" as const,
    approvals: getUserApprovalGeneration(),
    categories: getCategoryRegistryGeneration(),
    additionalDirectories: Object.freeze(normalizedDirectories(sources.additionalDirectories)),
  };
  const snapshot = Object.freeze({ ...components, epoch: sha256Hex(canonicalStringify(components)) });
  issuedSnapshots.add(snapshot);
  return snapshot;
}

export function captureRationalePolicyEpoch(sources: RationalePolicyEpochSources): string {
  return captureRationalePolicySnapshot(sources).epoch;
}

// Only the exact authenticated card's host-validated mutations may explain an epoch delta.
export function issueRationaleApprovalPolicyTransition(input: {
  readonly before: RationalePolicySnapshot;
  readonly after: RationalePolicySnapshot;
  readonly decision: ApprovalDecision;
  readonly actionDigest: string;
  readonly requestId: string;
  readonly approvalGate: object;
}): RationaleApprovalPolicyTransition | null {
  const { before, after, decision } = input;
  if (!issuedSnapshots.has(before) || !issuedSnapshots.has(after) ||
      decision.requestId !== input.requestId || !/^[a-f0-9]{64}$/.test(input.actionDigest) ||
      !["allow-once", "allow-session", "allow-always"].includes(decision.choice)) return null;
  const proof = (input.approvalGate as ApprovalMutationAuthority).consumeApprovalPolicyMutation?.(decision);
  if (!proof || before.hooks !== after.hooks || before.scriptHooks !== after.scriptHooks || before.categories !== after.categories) return null;
  if (before.permission !== after.permission &&
      (proof.permission?.from !== before.permission || proof.permission.to !== after.permission)) return null;
  if (before.approvals !== after.approvals &&
      (proof.approvals?.from !== before.approvals || proof.approvals.to !== after.approvals)) return null;
  if (!sameDirectories(before.additionalDirectories, after.additionalDirectories)) {
    const directories = proof.directories;
    if (!directories || !sameDirectories(directories.from, before.additionalDirectories) || !sameDirectories(directories.to, after.additionalDirectories) ||
        !sameDirectories(after.additionalDirectories, [...before.additionalDirectories, directories.directory])) return null;
  }
  const receipt: RationaleApprovalPolicyTransition = Object.freeze({ kind: "approved-policy-transition" });
  approvalTransitions.set(receipt, { decision, actionDigest: input.actionDigest, requestId: input.requestId, beforeEpoch: before.epoch, currentEpoch: after.epoch,
    ...(proof.directories ? { directory: proof.directories.directory } : {}),
  });
  return receipt;
}

// Repeated identity checks may inspect the same receipt, but cannot transfer it to a new action or later epoch.
export function validateRationaleApprovalPolicyTransition(
  receipt: RationaleApprovalPolicyTransition | null | undefined,
  input: { readonly decision: ApprovalDecision; readonly actionDigest: string; readonly requestId: string; readonly beforeEpoch: string; readonly currentEpoch: string },
): boolean {
  const authority = receipt ? approvalTransitions.get(receipt) : undefined;
  return authority !== undefined && authority.decision === input.decision && authority.actionDigest === input.actionDigest &&
    authority.requestId === input.requestId && authority.beforeEpoch === input.beforeEpoch && authority.currentEpoch === input.currentEpoch;
}

// A selected folder may replace only provisional descendants of that same folder.
// Every unrelated sealed root must remain, and the card cannot add another root.
export function matchesRationaleApprovedDirectoryTransition(
  receipt: RationaleApprovalPolicyTransition | null | undefined,
  input: { readonly beforeDirectories: readonly string[]; readonly currentDirectories: readonly string[] },
): boolean {
  const authority = receipt ? approvalTransitions.get(receipt) : undefined;
  if (!authority?.directory) return false;
  const identity = (path: string): string | null => {
    let normalized = path.split("\\").join("/");
    while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    if (!normalized || normalized.split("/").some(part => part === "." || part === "..")) return null;
    return caseFoldForMatch(normalized);
  };
  const directory = identity(authority.directory);
  const before = input.beforeDirectories.map(identity);
  const current = input.currentDirectories.map(identity);
  if (directory === null || before.some(path => path === null) || current.some(path => path === null)) return false;
  const previousRoots = new Set(before as string[]);
  const currentRoots = new Set(current as string[]);
  if (!currentRoots.has(directory)) return false;
  for (const path of currentRoots) {
    if (path !== directory && !previousRoots.has(path)) return false;
  }
  for (const path of previousRoots) {
    if (currentRoots.has(path)) continue;
    if (path === directory || !isPathAllowed(path, { directories: [directory] })) return false;
  }
  return true;
}
