import { refreshRemoteControllerBoundToSession, isRemoteControllerBoundToSession, remoteControllerOriginOf } from "../shared/chat-origin.js";
// Actual host effects enter the common permission pipeline before recording and execution.
// Authorize before recording and execution; network audit also records denied attempts. Invalid input snapshots never reach implementation.
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ApprovalGate, ApprovalChoice } from "./approval-gate.js";
import type { PermissionCheckContext, PermissionManager } from "./permission-manager.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import { canonicalizePathForMatch } from "./sensitive-paths.js";
import { NO_APPROVER_MESSAGE } from "./decision-pipeline.js";
import { issueHostNetworkSubject } from "./host-network-subject.js";
import type { ApprovalSurface } from "../shared/authorization-required.js";
import {
  CHOKEPOINT_EFFECT,
  HOSTAPI_EFFECT_BY_PATH,
  writeClassifiedPaths,
  type Effect,
  type StaticChokepointKind,
} from "./effect-kind.js";
import { isPlainNamespace, INSTRUMENTED } from "./hostapi-effect-recorder.js";

// Actual asynchronous effects are mandatory inside tool calls. Approval completion cannot wait on itself; network effects authorize inline per hop.
export const ENFORCEMENT_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  // Approval completion resolves an already authorized host-owned request and cannot wait on itself.
  ["agentApproval.respond", "resolves host-owned approval machinery without introducing an external effect",
  ],
  // The lone VERB-derived egress — gated INLINE in its host closure from the single verb snapshot that also self-records + pins the wire (so the gate's read/write class can never diverge from what is sent). NOT ungated: it is caught at the SAME effect-gate, just inline. The generic wrapper skips it precisely because it self-gates.
  ["hostFetch", "verb-derived egress — self-gated INLINE in its closure (same effect-gate, not ungated); the generic wrapper skips it",
  ],
]);

// Gated paths and explicit exclusions must partition every write path; new async writes gate automatically and unexcluded sync writes fail completeness. Recheck effects per call so a later read classification passes through without prompting.
export const GATED_EFFECT_PATHS: ReadonlySet<string> = (() => {
  const gated = new Set<string>();
  for (const path of writeClassifiedPaths()) {
    if (ENFORCEMENT_EXCLUSIONS.has(path)) continue;
    // Only an ALREADY-async method can be gated by the await-based wrapper. A write-classified, non-excluded, NON-async path is a design gap the completeness test rejects — it is left out of the gated set here (it is also absent from the exclusions), so the partition assertion fails CI.
    if (HOSTAPI_EFFECT_BY_PATH[path]?.async) gated.add(path);
  }
  return gated;
})();

// Reads with filesystem targets must still pass admission, path floors and explicit rules.
export const pathReadEffectPaths: ReadonlySet<string> = new Set(Object.entries(HOSTAPI_EFFECT_BY_PATH)
  .filter(([, spec]) => spec.async && spec.kind === "storageRead")
  .map(([path]) => path));

// The executor binds a context for each invocation; exact one-shot grants live only in that frame.
export interface EffectGateContext {
  // True iff this invocation runs in a headless/routine policy lane.
  readonly headless: boolean;
  // Whether this host process can present and settle a local approval.
  readonly approvalSurface?: ApprovalSurface;
  // The executing tool's name — surfaced in the approval dock.
  readonly toolName: string;
  // The conversation whose turn is blocked on this effect, when there is one. It decides which tile draws the modal; without it the ask is drawn as a lane card in the focused pane, with no transcript waiting on it. Absent for effects raised outside a turn (a plugin's own background work).
  readonly sessionId?: string;
  // Invocation-scoped `allow-once` descriptor keys (discarded when the frame pops).
  readonly onceGrants: Set<string>;
  readonly executionCwd?: string;
  readonly permissionContext?: Pick<PermissionCheckContext, "admissionDenial" | "floor" | "exfiltration" | "manualRerun" | "ownerUnattended" | "remoteControllerAuthority" | "permissionStoreError">;
  readonly abortSignal?: AbortSignal;
}

const gateContextStorage = new AsyncLocalStorage<EffectGateContext>();
const authorizationRequiredLatch = new WeakMap<EffectGateContext, () => void>();
const noApproverLatch = new WeakMap<EffectGateContext, () => void>();

// Run `fn` with an effect-gate context bound for the async chain of one tool invocation. A fresh `allow-once` grant set is minted per call so once-grants never leak across invocations. AsyncLocalStorage propagates through the loopback transport (the same path the effect ledger relies on), so the per-plugin hostApi closures see this context when they reach a gated effect.
export function runWithEffectGateContext<T>(
  context: Omit<EffectGateContext, "onceGrants">,
  fn: () => Promise<T>,
  onAuthorizationRequired?: () => void,
  onNoApprover?: () => void,
): Promise<T> {
  const frame: EffectGateContext = { ...context, onceGrants: new Set<string>() };
  if (onAuthorizationRequired) {
    // Keep the host-owned terminal latch off the context returned by currentEffectGateContext. An in-process adapter may inspect that context, but cannot manufacture a terminal control without reaching an actual host-classified write chokepoint.
    authorizationRequiredLatch.set(frame, onAuthorizationRequired);
  }
  if (onNoApprover) noApproverLatch.set(frame, onNoApprover);
  return gateContextStorage.run(frame, fn);
}

/** Capture the host denial signal for a socket callback that outlives this async frame. */
export function captureEffectNoApprover(): (() => void) | undefined {
  const frame = gateContextStorage.getStore();
  return frame === undefined ? undefined : noApproverLatch.get(frame);
}

// Read the ambient effect-gate context, or `undefined` outside a gated invocation.
export function currentEffectGateContext(): EffectGateContext | undefined {
  return gateContextStorage.getStore();
}

// Process-local grants bind the complete payload and physical paths; session and invocation scopes never cross their boundaries.
const descriptorGrants = new Map<string, { choice: ApprovalChoice; sessionId: string | undefined }>();

// Copy data-bearing containers once; capabilities retain their identity but can never produce a reusable grant.
export function snapshotEffectArguments(input: readonly unknown[]): { args: unknown[]; identity: unknown; reusable: boolean } {
  let reusable = true;
  const ancestors = new WeakSet<object>();
  const copy = (value: unknown, depth: number): { value: unknown; identity: unknown } => {
    if (depth > 100) throw new Error("Effect input exceeds the supported depth");
    if (value === null) return { value, identity: ["null"] };
    const type = typeof value;
    if (typeof value === "function" || typeof value === "symbol") {
      reusable = false;
      return { value, identity: ["capability", randomUUID()] };
    }
    if (typeof value !== "object") return { value, identity: [type, typeof value === "bigint" ? String(value) : typeof value === "number" && !Number.isFinite(value) ? String(value) : value] };
    if (value instanceof URL) return { value: new URL(value.href), identity: ["url", value.href] };
    if (value instanceof URLSearchParams) return { value: new URLSearchParams(value), identity: ["parameters", value.toString()] };
    if (value instanceof Headers) return { value: new Headers(value), identity: ["headers", Array.from(value.entries())] };
    if (value instanceof Date) return { value: new Date(value.getTime()), identity: ["date", value.toISOString()] };
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      reusable = false;
      return { value: new Blob([value], { type: value.type }), identity: ["immutable-blob", value.type, value.size, randomUUID()] };
    }
    if (typeof FormData !== "undefined" && value instanceof FormData) {
      const snapshot = new FormData();
      const entries: unknown[] = [];
      for (const [name, entry] of value.entries()) {
        if (typeof entry === "string") {
          snapshot.append(name, entry);
          entries.push([name, ["string", entry]]);
        } else {
          snapshot.append(name, new Blob([entry], { type: entry.type }), entry.name);
          reusable = false;
          entries.push([name, ["immutable-file", entry.name, entry.type, entry.size, randomUUID()]]);
        }
      }
      return { value: snapshot, identity: ["form-data", entries] };
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const copied = Uint8Array.from(bytes);
      return { value: value instanceof ArrayBuffer ? copied.buffer : Buffer.isBuffer(value) ? Buffer.from(copied) : value instanceof DataView ? new DataView(copied.buffer) : copied,
        identity: ["bytes", Object.getPrototypeOf(value).constructor.name, Buffer.from(copied).toString("base64")] };
    }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      reusable = false;
      return { value, identity: ["capability", randomUUID()] };
    }
    if (ancestors.has(value)) throw new Error("Effect input cannot contain cycles");
    ancestors.add(value);
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    const entries: unknown[] = [];
    for (const key of Object.keys(value)) {
      const item = copy((value as Record<string, unknown>)[key], depth + 1);
      Object.defineProperty(result, key, { value: item.value, enumerable: true, writable: false, configurable: false });
      entries.push([key, item.identity]);
    }
    ancestors.delete(value);
    return { value: Object.freeze(result), identity: [Array.isArray(value) ? "array" : "record", entries] };
  };
  const snapshot = copy(input, 0);
  return { args: snapshot.value as unknown[], identity: snapshot.identity, reusable };
}

// These data APIs serialize their value after path I/O; materialize that serialization before permission can await.
function snapshotMethodArguments(methodPath: string, input: readonly unknown[]): ReturnType<typeof snapshotEffectArguments> {
  if (methodPath !== "storage.writeJson") return snapshotEffectArguments(input);
  if (input[2] !== undefined && typeof input[2] !== "number") throw new Error("JSON storage indentation must be a number");
  const serialized = JSON.stringify(input[1]);
  if (serialized === undefined) throw new Error("JSON storage requires a serializable value");
  return snapshotEffectArguments([input[0], JSON.parse(serialized), ...input.slice(2)]);
}

// Streaming bodies have not produced their bytes yet; a tool invocation cannot approve unknown future content.
export function assertSnapshotableRequestBody(body: unknown): void {
  if (!currentEffectGateContext() || body === null || body === undefined || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)
    || body instanceof URLSearchParams || typeof Blob !== "undefined" && body instanceof Blob || typeof FormData !== "undefined" && body instanceof FormData) return;
  throw new Error("Tool network effects require a snapshotable request body");
}

function descriptorKey(pluginId: string, methodPath: string, identity: unknown): string {
  return createHash("sha256").update(canonicalStringify([pluginId, methodPath, identity])).digest("hex");
}

type EffectPath = { lexical: string; canonical: string; effect: "read" | "write" };

function effectPaths(methodPath: string, effect: Effect, args: readonly unknown[], resolveStoragePath?: (relativePath: string) => string): EffectPath[] {
  const paths: EffectPath[] = [];
  if (methodPath.startsWith("storage.")) {
    const relativePath = methodPath === "storage.list" && args[0] === undefined ? "." : args[0];
    if (typeof relativePath !== "string" || !resolveStoragePath) throw new Error("Storage effects require a bound path resolver");
    const lexical = resolveStoragePath(relativePath);
    paths.push({ lexical, canonical: canonicalizePathForMatch(lexical), effect });
  }
  if (methodPath === "spawnWorker") {
    const worker = args[0];
    if (worker !== null && typeof worker === "object") {
      for (const [field, effect] of [["allowReadPaths", "read"], ["allowWritePaths", "write"]] as const) {
        const grants = (worker as Record<string, unknown>)[field];
        if (Array.isArray(grants)) for (const path of grants) {
          if (typeof path !== "string") throw new Error("Worker filesystem grants must be paths");
          paths.push({ lexical: path, canonical: canonicalizePathForMatch(path), effect });
        }
      }
    }
  }
  return paths;
}

function assertEffectPaths(paths: readonly EffectPath[]): void {
  if (paths.some((path) => canonicalizePathForMatch(path.lexical) !== path.canonical)) {
    throw new Error("Effect target changed during approval");
  }
}

// Thrown by the effect-gate when a mutating effect is denied; surfaced as a tool error.
export class EffectBoundaryDeniedError extends Error {
  readonly pluginId: string;
  readonly methodPath: string;
  readonly target: string | undefined;
  readonly reason: "denied" | "headless" | "approval-unavailable";
  constructor(pluginId: string, methodPath: string, target: string | undefined, reason: "denied" | "headless" | "approval-unavailable", reasonText?: string,
  ) {
    const where = target ? `${methodPath} → ${target}` : methodPath;
    const detail =
      reason === "headless"
        ? NO_APPROVER_MESSAGE
        : reason === "approval-unavailable"
          ? NO_APPROVER_MESSAGE
          : "the user denied the effect approval";
    super(
      `[effect-gate] plugin '${pluginId}' blocked from ${where}: ${reasonText ?? detail}`,
    );
    this.name = "EffectBoundaryDeniedError";
    this.pluginId = pluginId;
    this.methodPath = methodPath;
    this.target = target;
    this.reason = reason;
  }
}

// Dependencies the effect-gate needs at a chokepoint.
export interface EffectEnforcementDeps {
  // The calling plugin's id, bound at hostApi construction (never plugin-supplied at call time).
  readonly pluginId: string;
  // Await the main-process gate before allowing the effect.
  readonly approvalGate: ApprovalGate;
  readonly permissionManager?: PermissionManager;
  readonly resolveStoragePath?: (relativePath: string) => string;
  // Revalidate the exact HostApi incarnation after an async approval wait and immediately before the approved effect executes.
  readonly assertActive: () => void;
}

// Standalone lifecycle work is outside tool policy. Tool effects are evaluated independently of their enclosing tool's approval.
export async function gateMutatingEffect(params: {
  pluginId: string;
  methodPath: string;
  effect: Effect;
  target: string | undefined;
  input?: readonly unknown[];
  capabilityBound?: boolean;
  resolveStoragePath?: (relativePath: string) => string;
  approvalGate: ApprovalGate;
  permissionManager?: PermissionManager;
}): Promise<void> {
  if (params.effect !== "write" && params.methodPath !== "hostFetch" && !pathReadEffectPaths.has(params.methodPath)) return;
  const ctx = currentEffectGateContext();
  if (!ctx) return;
  const manager = params.permissionManager;
  if (!manager) throw new Error("Effect enforcement requires a permission manager");

  const snapshot = snapshotMethodArguments(params.methodPath, params.input ?? []);
  const executionCwd = ctx.executionCwd ?? process.cwd();
  await manager.ensureProjectRulesLoaded(executionCwd);
  const headless = ctx.headless || ctx.approvalSurface === "unavailable";
  const paths = effectPaths(params.methodPath, params.effect, snapshot.args, params.resolveStoragePath);
  const key = descriptorKey(params.pluginId, params.methodPath, [snapshot.identity, paths,
    ...(params.input === undefined || params.capabilityBound ? [randomUUID()] : [])]);
  const storedGrant = descriptorGrants.get(key);
  const remembered = storedGrant?.choice === "allow-session" && storedGrant.sessionId !== ctx.sessionId ? undefined : storedGrant?.choice;
  const authNavigation = params.methodPath === "openAuthWindow" || params.methodPath === "openAuthPartitionViewer";
  const network = params.methodPath === "hostFetch" || params.methodPath === "openExternalUrl" || authNavigation;
  const worker = params.methodPath === "spawnWorker" && snapshot.args[0] !== null && typeof snapshot.args[0] === "object" ? snapshot.args[0] as Record<string, unknown> : undefined;
  const workerCommand = worker && typeof worker.command === "string" && (!worker.args || Array.isArray(worker.args) && worker.args.every((arg) => typeof arg === "string"))
    ? [worker.command, ...((worker.args as string[] | undefined) ?? [])].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ") : undefined;
  const category = network ? "network" : workerCommand ? "shell" : params.effect === "read" ? "read" : "write";

  const authOptions = authNavigation && snapshot.args[0] !== null && typeof snapshot.args[0] === "object" ? snapshot.args[0] as Record<string, unknown> : undefined;
  const actualUrl = authNavigation ? authOptions?.url : network ? snapshot.args[0] : undefined;
  if (network && typeof actualUrl !== "string") throw new Error("Network effects require the exact URL");
  if (network && snapshot.args[1] !== null && typeof snapshot.args[1] === "object") {
    assertSnapshotableRequestBody((snapshot.args[1] as Record<string, unknown>).body);
  }
  // No enclosing-tool grant is reused: exact payloads have independent policy and cache identities.
  const effectToolName = `effect_${params.methodPath.replaceAll(".", "_")}`;
  let permission = manager.checkDetailed(effectToolName, "plugin", category, undefined, {
    ...ctx.permissionContext,
    headless,
    approvalCacheKey: key,
    projectRulesCwd: executionCwd,
    sessionId: ctx.sessionId,
    paths,
    ...(params.methodPath === "config.set" ? { floor: ctx.permissionContext?.floor ?? { code: "protected-path" as const, reason: "Plugin configuration is a protected control surface." } } : {}),
    ...(network ? { ruleSubject: issueHostNetworkSubject({ url: actualUrl as string }) } : workerCommand ? { ruleSubject: { kind: "shell" as const, dialect: "bash" as const, command: workerCommand, cwd: process.cwd() }, shellExecution: { runsSandboxed: false } } : {}),
    ...(remembered === "deny-always" ? { admissionDenial: { code: "effect-denied", reason: "The user denied this exact effect." } } : {}),
  });
  if (ctx.onceGrants.has(key) || remembered && remembered !== "deny-always") {
    permission = manager.resolveRememberedPermission(permission, "The user approved this exact effect.");
  }
  const effectInput = { pluginId: params.pluginId, methodPath: params.methodPath, effect: params.effect, target: params.target ?? null };
  const reviewInput = network
    ? { ...(authNavigation ? authOptions : snapshot.args[1] !== null && typeof snapshot.args[1] === "object" ? snapshot.args[1] : {}), url: actualUrl, ...effectInput }
    : workerCommand ? { ...worker, command: workerCommand, ...effectInput } : { ...effectInput, input: snapshot.args };
  if (permission.reviewer && permission.decision === "ask" && !permission.forceModal) {

    const review = await manager.dispatchReviewer(effectToolName, {
      permissionDecision: permission,
      invocationId: randomUUID(),
      source: "plugin", category, pathFields: [],
      finalInput: reviewInput,
      executionCwd, allowedDirectories: [executionCwd], sensitivePathsAdjacent: [],
      trustOrigin: "plugin-emitted", approvalCacheKey: key, pluginId: params.pluginId,
      ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    }, undefined, { lane: permission.reviewer.route, ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}) });
    permission = manager.resolveReviewedPermission(permission, review);
  }
  ctx.abortSignal?.throwIfAborted();
  if (permission.decision === "allow") {
    if (!await refreshRemoteControllerBoundToSession(ctx.permissionContext?.remoteControllerAuthority, ctx.sessionId)) throw new Error("remote-controller-revoked");
    assertEffectPaths(paths);
    return;
  }
  if (permission.decision === "deny" || headless) {
    const absentApprover = permission.reasonCode === "no-approver";
    if (absentApprover) noApproverLatch.get(ctx)?.();
    if (absentApprover && !ctx.headless && ctx.approvalSurface === "unavailable") authorizationRequiredLatch.get(ctx)?.();
    throw new EffectBoundaryDeniedError(params.pluginId, params.methodPath, params.target,
      absentApprover ? ctx.headless ? "headless" : "approval-unavailable" : "denied", permission.reason);
  }

  // Foreground: ask at the effect boundary and await the user decision. The gate mints + verifies its own nonce+HMAC (confused-deputy defence) internally.
  const where = params.target
    ? `${params.methodPath} → ${params.target}`
    : params.methodPath;
  const reusableGrant = snapshot.reusable && !params.capabilityBound && !permission.forceModal && params.input !== undefined;
  const policyEpoch = manager.getPolicyEpoch();
  const decision = await params.approvalGate.requestAndWait({
    id: randomUUID(),
    category: "agent-action",
    kind: "agent-action",
    toolName: ctx.toolName,
    // Attribute the modal to the conversation that is blocked on it, the same way an invocation approval does.
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    // `meta` keeps the sandbox-capability row out of this non-execution modal.
    toolCategory: "meta",
    // Display only the non-secret forensic descriptor; the grant binds the complete payload hash.
    args: {
      effect: params.effect,
      methodPath: params.methodPath,
      ...(params.target !== undefined ? { target: params.target } : {}),
    },
    reason: `Plugin "${params.pluginId}" is about to perform a host-mediated ${params.effect}: ${where}`,
    source: "plugin",
    sourcePluginId: params.pluginId,
    approvalScope: key,
    trustOrigin: "plugin-emitted",
    createdAt: Date.now(),
    ...(permission.forceModal ? { forceExplicit: true as const } : {}),
    ownerUnattended: ctx.permissionContext?.ownerUnattended,
    remoteControllerAuthority: ctx.permissionContext?.remoteControllerAuthority,
    remoteControllerOrigin: remoteControllerOriginOf(ctx.permissionContext?.remoteControllerAuthority),
    ...(!reusableGrant ? { allowedChoices: ["allow-once" as const, "deny-once" as const] } : {}),
    durableApprovalRecordAllowed: false,
    ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    ...(permission.reviewer?.verdict ? { reviewerVerdict: permission.reviewer.verdict } : {}),
  });

  ctx.abortSignal?.throwIfAborted();
  if (!await refreshRemoteControllerBoundToSession(ctx.permissionContext?.remoteControllerAuthority, ctx.sessionId)) throw new Error("remote-controller-revoked");
  if (policyEpoch !== manager.getPolicyEpoch()) throw new Error("Permission policy changed during effect approval");
  assertEffectPaths(paths);
  if (decision.rememberPattern === NO_APPROVER_MESSAGE) {
    noApproverLatch.get(ctx)?.();
    throw new EffectBoundaryDeniedError(params.pluginId, params.methodPath, params.target, "approval-unavailable", NO_APPROVER_MESSAGE);
  }
  switch (decision.choice) {
    case "allow-once":
      if (reusableGrant) ctx.onceGrants.add(key);
      return;
    case "allow-session":
      if (reusableGrant) descriptorGrants.set(key, { choice: "allow-session", sessionId: ctx.sessionId });
      return;
    case "allow-always":
      if (reusableGrant) descriptorGrants.set(key, { choice: "allow-always", sessionId: ctx.sessionId });
      return;
    case "deny-always":
      if (reusableGrant) descriptorGrants.set(key, { choice: "deny-always", sessionId: ctx.sessionId });
      throw new EffectBoundaryDeniedError(
        params.pluginId,
        params.methodPath,
        params.target,
        "denied",
      );
    default: // deny-once
      throw new EffectBoundaryDeniedError(
        params.pluginId,
        params.methodPath,
        params.target,
        "denied",
      );
  }
}

// Marks an already-enforced object so a nested re-wrap is a no-op (idempotent).
const ENFORCED = Symbol("ave.hostApiEffectEnforced");

// Async writes and path-bearing reads authorize before delegation. Preserve recorder markers so repeated wrapping cannot double-record.
export function enforceMutatingEffects<T extends object>(
  target: T,
  deps: EffectEnforcementDeps,
  prefix = "",
): T {
  if ((target as Record<symbol, unknown>)[ENFORCED]) return target;

  const wrapped: Record<string, unknown> = {};
  for (const key of Object.keys(target)) {
    const value = (target as Record<string, unknown>)[key];
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "function" && (GATED_EFFECT_PATHS.has(path) || pathReadEffectPaths.has(path))) {
      const original = value as (...callArgs: unknown[]) => unknown;
      wrapped[key] = function enforced(
        this: unknown,
        ...callArgs: unknown[]
      ): unknown {
        // Standalone lifecycle calls retain their original delegation.
        if (!currentEffectGateContext()) {
          return Reflect.apply(original, target, callArgs);
        }
        // Permission waits preserve the asynchronous method contract.
        return (async (): Promise<unknown> => {
          // Decide the effect from the host-owned SOT BEFORE touching any plugin-controlled arg, so a throwing/stateful arg getter can never flip the write or suppress the gate (mirrors the recorder's fix).
          const spec = HOSTAPI_EFFECT_BY_PATH[path];
          const effect: Effect = spec
            ? (CHOKEPOINT_EFFECT[spec.kind as StaticChokepointKind] ?? "write")
            : "write";
          // Seal data once before awaiting policy; target, reviewer identity and execution share this snapshot.
          const snapshot = snapshotMethodArguments(path, callArgs);
          const targetSnapshot = spec?.targetFromArgs?.(snapshot.args);
          const paths = effectPaths(path, effect, snapshot.args, deps.resolveStoragePath);
          await gateMutatingEffect({
            pluginId: deps.pluginId,
            methodPath: path,
            effect,
            target: targetSnapshot,
            approvalGate: deps.approvalGate,
            permissionManager: deps.permissionManager,
            input: snapshot.args,
            resolveStoragePath: deps.resolveStoragePath,
          });
          deps.assertActive();
          const effectContext = currentEffectGateContext();
          if (!isRemoteControllerBoundToSession(effectContext?.permissionContext?.remoteControllerAuthority, effectContext?.sessionId)) throw new Error("remote-controller-revoked");
          assertEffectPaths(paths);
          return Reflect.apply(original, target, snapshot.args);
        })();
      };
    } else if (typeof value === "function") {
      // Other reads and synchronous methods keep their contracts; hostFetch authorizes inline per actual hop.
      wrapped[key] = value;
    } else if (isPlainNamespace(value)) {
      wrapped[key] = enforceMutatingEffects(value, deps, path);
    } else {
      wrapped[key] = value;
    }
  }
  Object.defineProperty(wrapped, ENFORCED, { value: true, enumerable: false });
  // PROPAGATE the recorder's idempotence symbol onto the fresh enforced object so an enforced (and thus already-recorder-instrumented) object is still seen as INSTRUMENTED — a later `instrumentEffectsByPath` over it stays a no-op and can never double-wrap/double-record. Mirrors the recorder stamping it on its own wrapper; copied per-level so nested namespaces keep the guard too.
  if ((target as Record<symbol, unknown>)[INSTRUMENTED]) {
    Object.defineProperty(wrapped, INSTRUMENTED, {
      value: true,
      enumerable: false,
    });
  }
  return wrapped as T;
}

// @internal Test only — clears the process-lifetime descriptor grant memory.
export function __resetEffectGrantsForTest(): void {
  descriptorGrants.clear();
}
