// Flag-off is exact pass-through; flag-on gates every async write from the effect table or an explicit exclusion. Keep sync methods sync; hostFetch self-gates from the same single verb snapshot as the wire. Headless fails closed before grant lookup, so foreground grants cannot authorize unattended mutations.
// Order gate -> record -> implementation so denied writes never become observed effects; hostFetch deliberately records attempts before its inline gate. Classify from host-owned effects before reading hostile args, so getters cannot suppress approval; denials never invoke the implementation and all asks use gate nonce/HMAC protection.
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ApprovalGate, ApprovalChoice } from "./approval-gate.js";
import type { ApprovalSurface } from "../shared/authorization-required.js";
import {
  CHOKEPOINT_EFFECT,
  HOSTAPI_EFFECT_BY_PATH,
  writeClassifiedPaths,
  type Effect,
  type StaticChokepointKind,
} from "./effect-kind.js";
import { isPlainNamespace, INSTRUMENTED } from "./hostapi-effect-recorder.js";

// Generic gating covers async writes or explicit exclusions; synchronous APIs must retain their contract. Relaxed foreground plugins have no pre-exec ask: config.set remains bounded to own config/reload, and agentApproval.respond cannot gate itself without deadlock. hostFetch self-gates inline; external URL opening stays gated.
export const ENFORCEMENT_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  // Mutates the plugin's OWN config namespace + already triggers a guarded reload. Under the relaxation flag it runs UNGATED, but is BOUNDED to the plugin's own config (not user/external data).
  ["config.set", "own-config namespace mutation (not user/external data) + guarded reload → bounded ungated under the flag",
  ],
  // RESOLVES a pending approval — gating the approval machinery with itself is circular (would deadlock). Under the relaxation flag it runs UNGATED, BOUNDED by being confined to resolving HOST-OWNED approval state.
  ["agentApproval.respond", "resolves host-owned approval machinery (gating it with itself is circular/deadlock) → bounded ungated under the flag",
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

// Per-invocation enforcement context, bound by the executor around `tool.execute` (next to the effect ledger) and read by the effect-gate through AsyncLocalStorage. Carries the host-owned routine/headless scope independently from approval-surface availability, the tool name for the modal, and an invocation-scoped `allow-once` grant set so N writes to the same target inside ONE tool call pop at most one modal.
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
}

const gateContextStorage = new AsyncLocalStorage<EffectGateContext>();
const authorizationRequiredLatch = new WeakMap<EffectGateContext, () => void>();

// Run `fn` with an effect-gate context bound for the async chain of one tool invocation. A fresh `allow-once` grant set is minted per call so once-grants never leak across invocations. AsyncLocalStorage propagates through the loopback transport (the same path the effect ledger relies on), so the per-plugin hostApi closures see this context when they reach a gated effect.
export function runWithEffectGateContext<T>(
  context: Omit<EffectGateContext, "onceGrants">,
  fn: () => Promise<T>,
  onAuthorizationRequired?: () => void,
): Promise<T> {
  const frame: EffectGateContext = { ...context, onceGrants: new Set<string>() };
  if (onAuthorizationRequired) {
    // Keep the host-owned terminal latch off the context returned by currentEffectGateContext. An in-process adapter may inspect that context, but cannot manufacture a terminal control without reaching an actual host-classified write chokepoint.
    authorizationRequiredLatch.set(frame, onAuthorizationRequired);
  }
  return gateContextStorage.run(frame, fn);
}

// Read the ambient effect-gate context, or `undefined` outside a gated invocation.
export function currentEffectGateContext(): EffectGateContext | undefined {
  return gateContextStorage.getStore();
}

// Memory binds exact plugin/method/target descriptors without widening. Session/always grants last only this process; once grants stay per invocation and deny-always throws without another modal.
const descriptorGrants = new Map<string, ApprovalChoice>();

// Stable, non-widening grant key for one effect descriptor. The three components are JSON-encoded as a tuple so each is unambiguously escaped — a pluginId, methodPath, or target that itself contains the delimiter (or a quote) can never collide two distinct descriptors onto one key (which would widen a grant). A missing target is encoded as `null`, distinct from an empty-string target.
function descriptorKey(pluginId: string, methodPath: string, target: string | undefined,
): string {
  return JSON.stringify([pluginId, methodPath, target ?? null]);
}

// Thrown by the effect-gate when a mutating effect is denied; surfaced as a tool error.
export class EffectBoundaryDeniedError extends Error {
  readonly pluginId: string;
  readonly methodPath: string;
  readonly target: string | undefined;
  readonly reason: "denied" | "headless" | "approval-unavailable";
  constructor(pluginId: string, methodPath: string, target: string | undefined, reason: "denied" | "headless" | "approval-unavailable",
  ) {
    const where = target ? `${methodPath} → ${target}` : methodPath;
    const detail =
      reason === "headless"
        ? "no interactive approver in a headless/routine context"
        : reason === "approval-unavailable"
          ? "the local approval surface is unavailable"
          : "the user denied the effect approval";
    super(
      `[effect-gate] plugin '${pluginId}' blocked from ${where}: ${detail}`,
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
  // Live `hostClassifiesRisk` flag read — evaluated PER CALL so a Settings toggle is honoured.
  readonly flagEnabled: () => boolean;
  // Revalidate the exact HostApi incarnation after an async approval wait and immediately before the approved effect executes.
  readonly assertActive: () => void;
}

// Flag-off, reads and out-of-invocation calls pass through; headless denies before any remembered grant. Unavailable approval latches a host terminal and throws; only foreground may use descriptor grants or ask the gate before mutation.
export async function gateMutatingEffect(params: {
  pluginId: string;
  methodPath: string;
  effect: Effect;
  target: string | undefined;
  approvalGate: ApprovalGate;
  flagEnabled: () => boolean;
}): Promise<void> {
  if (!params.flagEnabled()) return; // FLAG OFF — pass-through (byte-for-byte today)
  if (params.effect !== "write") return; // reads never prompt

  const ctx = currentEffectGateContext();
  // Outside a gated tool invocation (boot, plugin lifecycle) there is no tool effect to gate and no approver — the pre-exec ask governs only tool invocations.
  if (!ctx) return;

  // Headless lane: a modal is impossible — fail CLOSED (never silently allow). EVALUATED BEFORE the grant short-circuits below: a grant (allow-session / allow-always) obtained while the user WATCHED in the foreground must NOT later auto-allow the same descriptor in an unattended headless/routine run (CLAUDE.md policy: headless/routine execution must not bypass write/shell/network gates through allow rules or auto mode). In a headless context the gate ALWAYS throws, regardless of any prior foreground grant. Headless mutations remain gated by the pre-exec headless lane.
  if (ctx.headless) {
    throw new EffectBoundaryDeniedError(
      params.pluginId,
      params.methodPath,
      params.target,
      "headless",
    );
  }

  // Native one-shot execution deliberately keeps normal foreground tool scope, so `headless` is false even though no approval UI exists. Latch the terminal before throwing. This also runs before remembered grants: a grant made while a user was present cannot authorize an unattended invocation.
  if (ctx.approvalSurface === "unavailable") {
    authorizationRequiredLatch.get(ctx)?.();
    throw new EffectBoundaryDeniedError(
      params.pluginId,
      params.methodPath,
      params.target,
      "approval-unavailable",
    );
  }

  const key = descriptorKey(params.pluginId, params.methodPath, params.target);

  // Honour a prior explicit FOREGROUND decision for this exact descriptor (dedup).
  if (ctx.onceGrants.has(key)) return;
  const remembered = descriptorGrants.get(key);
  if (remembered) {
    if (remembered === "deny-always") {
      throw new EffectBoundaryDeniedError(
        params.pluginId,
        params.methodPath,
        params.target,
        "denied",
      );
    }
    return; // allow-session / allow-always
  }

  // Foreground: ask at the effect boundary and await the user decision. The gate mints + verifies its own nonce+HMAC (confused-deputy defence) internally.
  const where = params.target
    ? `${params.methodPath} → ${params.target}`
    : params.methodPath;
  const decision = await params.approvalGate.requestAndWait({
    id: randomUUID(),
    category: "agent-action",
    kind: "agent-action",
    toolName: ctx.toolName,
    // Attribute the modal to the conversation that is blocked on it, the same way an invocation approval does.
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    // `meta` keeps the sandbox-capability row out of this non-execution modal.
    toolCategory: "meta",
    // NON-SECRET descriptor only (host-owned effect class + forensic target). When there is NO target the grant is METHOD-WIDE (any call to this method, e.g. callLlm / spawnWorker, that is allow-always'd). The `methodWide` breadth marker surfaces that to the renderer so the later effect-modal card can show "this allows the method for ALL targets" (target-scoped requests omit it). The marker carries no secret.
    args: {
      effect: params.effect,
      methodPath: params.methodPath,
      ...(params.target !== undefined
        ? { target: params.target }
        : { methodWide: true }),
    },
    reason: `Plugin "${params.pluginId}" is about to perform a host-mediated ${params.effect}: ${where}`,
    source: "plugin",
    sourcePluginId: params.pluginId,
    approvalScope: params.methodPath,
    trustOrigin: "plugin-emitted",
    createdAt: Date.now(),
  });

  switch (decision.choice) {
    case "allow-once":
      ctx.onceGrants.add(key);
      return;
    case "allow-session":
      descriptorGrants.set(key, "allow-session");
      return;
    case "allow-always":
      descriptorGrants.set(key, "allow-always");
      return;
    case "deny-always":
      descriptorGrants.set(key, "deny-always");
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

// Only gated async-write leaves await approval before delegation; other methods preserve behavior. Wrap outside recording, traverse the same own plain namespaces, and preserve both enforcement and recording markers so repeated instrumentation cannot double-record.
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

    if (typeof value === "function" && GATED_EFFECT_PATHS.has(path)) {
      const original = value as (...callArgs: unknown[]) => unknown;
      wrapped[key] = function enforced(
        this: unknown,
        ...callArgs: unknown[]
      ): unknown {
        // FLAG OFF — DIRECT pass-through: one boolean read then the identical delegation. No gate, no SOT lookup, no extra await; the return value, args, `this`, and throw are byte-for-byte today's behaviour.
        if (!deps.flagEnabled()) {
          return Reflect.apply(original, target, callArgs);
        }
        // FLAG ON — gate (async) then delegate. Every gated path is already async, so returning a Promise here preserves the method contract.
        return (async (): Promise<unknown> => {
          // Decide the effect from the host-owned SOT BEFORE touching any plugin-controlled arg, so a throwing/stateful arg getter can never flip the write or suppress the gate (mirrors the recorder's fix).
          const spec = HOSTAPI_EFFECT_BY_PATH[path];
          const effect: Effect = spec
            ? (CHOKEPOINT_EFFECT[spec.kind as StaticChokepointKind] ?? "write")
            : "write";
          // Snapshot the non-secret forensic target once so displayed scope and grant key cannot diverge through stateful getters. Fix the host-owned write effect first; getter failures may lose the descriptor but never suppress gating. The implementation may still reread its own args.
          let targetSnapshot: string | undefined;
          try {
            targetSnapshot = spec?.targetFromArgs?.(callArgs);
          } catch {
            // best-effort target — the gate still fires on the SOT write
          }
          await gateMutatingEffect({
            pluginId: deps.pluginId,
            methodPath: path,
            effect,
            target: targetSnapshot,
            approvalGate: deps.approvalGate,
            flagEnabled: deps.flagEnabled,
          });
          deps.assertActive();
          return Reflect.apply(original, target, callArgs);
        })();
      };
    } else if (typeof value === "function") {
      // Reads, sync methods, and the verb-derived hostFetch pass through unchanged (hostFetch is gated INLINE in its closure; sync methods cannot await).
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
