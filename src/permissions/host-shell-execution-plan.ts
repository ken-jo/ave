// Path-string ACL grants cannot make one-shot filesystem leases reparse-safe; until handle-bound/no-follow grants exist, the plain-host Windows route requires per-invocation consent.

import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import type { SandboxCapability } from "./sandbox-capability.js";
import type { SandboxConfinement } from "../shared/sandbox-capability-info.js";
import { isRecord } from "../shared/is-record.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { isPowerShellStartupPinned } from "../shared/powershell-startup-policy.js";

export const HOST_SHELL_EXECUTION_PLAN_VERSION = "host-shell-execution-plan/v4" as const;

export type HostShellExecutionRequest = "default" | "host";

export type HostShellExecutionMode = "asrt" | "plain" | "blocked";

// What confines a sandboxed (`mode: "asrt"`) shell child: the ASRT wrap (Seatbelt, bubblewrap), or — on Windows hosts that offer it — a Microsoft Execution Containers container per command (`mxc-windows.ts`), whose network reaches only the invocation's own proxy port. `none` for every other mode.
type HostShellSubstrate = "asrt" | "mxc" | "none";

// Machine-readable, host-owned fallback state. Never derive authority from UI text.
export type HostShellFallbackReason =
  | "none"
  | "disabled-by-setting"
  | "platform-unsupported"
  | "windows-partial-shell-acl-unsafe"
  | "requested-sandbox-unavailable"
  | "active-sandbox-not-shell-contained";

export interface HostShellExecutionPlan {
  readonly version: typeof HOST_SHELL_EXECUTION_PLAN_VERSION;
  readonly platform: NodeJS.Platform;
  // Boot-sealed settings/env intent; never re-read from renderer settings.
  readonly requestedSandbox: boolean;
  // Explicit per-invocation request, separate from sandbox availability.
  readonly executionRequest: HostShellExecutionRequest;
  // Actual route selected before permission/reviewer processing.
  readonly mode: HostShellExecutionMode;
  // True only for the confined route this invocation will actually use.
  readonly sandboxed: boolean;
  // What confines the child when `mode` is `asrt`; `none` otherwise.
  readonly substrate: HostShellSubstrate;
  // Honest capability of the child selected by this plan.
  readonly capability: SandboxCapability;
  readonly fallbackReason: HostShellFallbackReason;
  // True whenever this plain shell needs a per-invocation host authorization before spawn: an explicit unsandboxed request or the Windows partial-ASRT Plan B (an exact `Bash(<command>)` allow rule or a fresh approval). A requested-but-unavailable sandbox is not one of them: it follows the same exact-rule policy and only records its `fallbackReason`.
  readonly requiresExplicitUserApproval: boolean;
  // Stable identity for audit/cache consumers; contains no command or raw path.
  readonly identity: string;
}

// The allowlist-only, serializable execution-plan view retained in audit data and shell result metadata. It deliberately excludes command arguments, directories, approval bindings, permits, nonces, HMACs, and free-form capability reasons.
export interface HostShellExecutionPlanAuditProjection {
  readonly version: typeof HOST_SHELL_EXECUTION_PLAN_VERSION;
  readonly identity: string;
  readonly platform: NodeJS.Platform;
  readonly requestedSandbox: boolean;
  // Explicit per-invocation request, separate from sandbox availability.
  readonly executionRequest: HostShellExecutionRequest;
  readonly mode: HostShellExecutionMode;
  // True only for the confined route this invocation will actually use.
  readonly sandboxed: boolean;
  readonly substrate: HostShellSubstrate;
  readonly fallbackReason: HostShellFallbackReason;
  readonly requiresExplicitUserApproval: boolean;
  readonly capability: Readonly<{
    kind: SandboxCapability["kind"];
    confidence: SandboxCapability["confidence"];
    platform: NodeJS.Platform;
    confines?: Readonly<SandboxConfinement>;
  }>;
}

const auditProjections = new WeakMap<
  HostShellExecutionPlan,
  HostShellExecutionPlanAuditProjection
>();
const issuedAuditProjections = new WeakSet<HostShellExecutionPlanAuditProjection>();

// Return the single immutable, public-safe projection for an issued plan. A WeakMap keeps the result identity stable through approval, audit, and the native shell result without retaining completed invocation plans.
export function getHostShellExecutionPlanAuditProjection(
  plan: HostShellExecutionPlan,
): HostShellExecutionPlanAuditProjection {
  const existing = auditProjections.get(plan);
  if (existing !== undefined) return existing;

  const confines = plan.capability.confines === undefined
    ? undefined
    : Object.freeze({ ...plan.capability.confines });
  const projection = Object.freeze({
    version: plan.version,
    identity: plan.identity,
    platform: plan.platform,
    requestedSandbox: plan.requestedSandbox,
    executionRequest: plan.executionRequest,
    mode: plan.mode,
    sandboxed: plan.sandboxed,
    substrate: plan.substrate,
    fallbackReason: plan.fallbackReason,
    requiresExplicitUserApproval: plan.requiresExplicitUserApproval,
    capability: Object.freeze({
      kind: plan.capability.kind,
      confidence: plan.capability.confidence,
      platform: plan.capability.platform,
      ...(confines === undefined ? {} : { confines }),
    }),
  });
  issuedAuditProjections.add(projection);
  auditProjections.set(plan, projection);
  return projection;
}

// Accept only an allowlist projection issued by this module. Approval payloads remain in-process until IPC serialization, so object identity gives the host a stronger boundary than trusting a structural lookalike with extra fields.
export function isIssuedHostShellExecutionPlanAuditProjection(
  projection: unknown,
): projection is HostShellExecutionPlanAuditProjection {
  return typeof projection === "object" &&
    projection !== null &&
    issuedAuditProjections.has(projection as HostShellExecutionPlanAuditProjection);
}

// Stable approval/reviewer-cache partition for a host shell execution plan. This deliberately hashes the complete renderer-safe projection instead of relying on HostShellExecutionPlan.identity alone. Requested intent, the actual sandboxed route and confinement dimensions must all partition approvals and reviewer verdicts.
export function getHostShellExecutionPlanCacheIdentity(
  projection: HostShellExecutionPlanAuditProjection,
): string {
  // Keep this explicit, ordered shape rather than relying on object insertion order. Every authority-relevant projection field participates, including the distinction between an omitted legacy `confines` value and all-false.
  const canonicalProjection = JSON.stringify({
    capability: {
      confidence: projection.capability.confidence,
      confines: projection.capability.confines === undefined
        ? null
        : {
            filesystem: projection.capability.confines.filesystem,
            network: projection.capability.confines.network,
            process: projection.capability.confines.process,
          },
      kind: projection.capability.kind,
      platform: projection.capability.platform,
    },
    fallbackReason: projection.fallbackReason,
    identity: projection.identity,
    mode: projection.mode,
    sandboxed: projection.sandboxed,
    substrate: projection.substrate,
    platform: projection.platform,
    requestedSandbox: projection.requestedSandbox,
    executionRequest: projection.executionRequest,
    requiresExplicitUserApproval: projection.requiresExplicitUserApproval,
    version: projection.version,
  });
  return "host-shell-execution-plan-cache/v4:" +
    sha256Hex(canonicalProjection);
}

const NO_CONFINEMENT: Readonly<SandboxConfinement> = Object.freeze({
  filesystem: false,
  process: false,
  network: false,
});

function freezeCapability(capability: SandboxCapability): SandboxCapability {
  const confines = capability.confines === undefined
    ? undefined
    : Object.freeze({ ...capability.confines });
  return Object.freeze({
    ...capability,
    ...(confines === undefined ? {} : { confines }),
  });
}

function noneCapability(platform: NodeJS.Platform, reason: string): SandboxCapability {
  return Object.freeze({
    kind: "none" as const,
    confidence: "verified" as const,
    platform,
    reason,
    confines: NO_CONFINEMENT,
  });
}

function hasShellContainment(capability: SandboxCapability): boolean {
  if (capability.kind !== "asrt" || capability.confidence !== "verified") return false;
  return capability.confines?.filesystem === true &&
    capability.confines.process === true && capability.confines.network === true;
}

// Build the immutable plan once per invocation, after final tool category/input are known and before permission routing. It intentionally does not attempt Windows ACL grants or an ASRT wrapper for the Plan-B branch.
export function buildHostShellExecutionPlan(input: {
  platform: NodeJS.Platform;
  requestedSandbox: boolean;
  activeCapability: SandboxCapability;
  // What would confine a sandboxed child: `mxc` only when the host's MXC route is live and `activeCapability` is that route's capability. Defaults to the ASRT wrap.
  shellSubstrate?: "asrt" | "mxc";
  executionMode?: HostShellExecutionRequest;
}): HostShellExecutionPlan {
  const shellSubstrate = input.shellSubstrate ?? "asrt";
  if (shellSubstrate === "mxc" && input.platform !== "win32") {
    throw new Error("The MXC shell substrate exists only on Windows");
  }
  const executionRequest = input.executionMode ?? "default";
  if (executionRequest !== "default" && executionRequest !== "host") {
    throw new Error("Invalid host shell execution request");
  }
  const requestedSandbox = input.requestedSandbox;

  if (executionRequest === "host") {
    return Object.freeze({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      platform: input.platform,
      requestedSandbox,
      executionRequest,
      mode: "plain" as const,
      sandboxed: false,
      substrate: "none" as const,
      capability: noneCapability(input.platform, "Explicit host execution runs as the current user without OS confinement."),
      fallbackReason: "none" as const,
      requiresExplicitUserApproval: true,
      identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":explicit-host",
    });
  }

  if (!requestedSandbox) {
    const fallbackReason: HostShellFallbackReason =
      input.platform === "darwin" || input.platform === "linux" || input.platform === "win32"
        ? "disabled-by-setting" : "platform-unsupported";
    return Object.freeze({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      platform: input.platform,
      requestedSandbox,
      executionRequest,
      mode: "plain" as const,
      sandboxed: false,
      substrate: "none" as const,
      capability: noneCapability(input.platform, "The OS shell sandbox is disabled for this host."),
      fallbackReason,
      requiresExplicitUserApproval: false,
      identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":" + fallbackReason,
    });
  }

  // A requested sandbox that is unavailable (missing bwrap/socat, start failure) yields an honest plain child on every platform. It takes the same policy path as explicit sandbox-off, floor and deny rules included, so it needs no one-shot permit: without a sandbox only an exact `Bash(<command>)` allow rule runs it unasked, and everything else asks (owner 2026-10-25, unsandboxed shell exact-rule requirement, superseding I3's normal-rule auto-allow). The fallback reason stays on the plan so the approval card, the tool result and audit can say the sandbox was unavailable.
  if (requestedSandbox && input.activeCapability.kind === "none") {
    const fallbackReason: HostShellFallbackReason = "requested-sandbox-unavailable";
    const capability = noneCapability(
      input.platform,
      "The requested OS sandbox is unavailable, so this shell will run without OS isolation until it is restored.",
    );
    return Object.freeze({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      platform: input.platform,
      requestedSandbox,
      executionRequest,
      mode: "plain" as const,
      sandboxed: false,
      substrate: "none" as const,
      capability,
      fallbackReason,
      requiresExplicitUserApproval: false,
      identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":" + fallbackReason,
    });
  }

  if (input.activeCapability.kind === "asrt" && hasShellContainment(input.activeCapability)) {
    const capability = freezeCapability(input.activeCapability);
    return Object.freeze({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      platform: input.platform,
      requestedSandbox,
      executionRequest,
      mode: "asrt" as const,
      sandboxed: true,
      substrate: shellSubstrate,
      capability,
      fallbackReason: "none" as const,
      requiresExplicitUserApproval: false,
      identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":" + shellSubstrate,
    });
  }

  // Windows remains special only when a real ASRT substrate is active but is not shell-contained. The execution authorization itself is generic.
  if (
    input.platform === "win32" &&
    requestedSandbox &&
    input.activeCapability.kind === "asrt"
  ) {
    const fallbackReason: HostShellFallbackReason = "windows-partial-shell-acl-unsafe";
    const capability = noneCapability(
      input.platform,
      "Windows ASRT partial shell confinement is unavailable: the host will not issue path-based ACL grants for one-shot shells.",
    );
    return Object.freeze({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      platform: input.platform,
      requestedSandbox,
      executionRequest,
      mode: "plain" as const,
      sandboxed: false,
      substrate: "none" as const,
      capability,
      fallbackReason,
      requiresExplicitUserApproval: true,
      identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":" + fallbackReason,
    });
  }

  // Only a full ASRT route and the explicitly modelled Windows ASRT Plan B may execute a requested shell. Future partial substrates (for example `partial` or `fs-only`) must not silently degrade to an ordinary host shell before they receive their own sealed execution contract.
  const fallbackReason: HostShellFallbackReason = "active-sandbox-not-shell-contained";
  const capability = noneCapability(
    input.platform,
    "The active OS sandbox does not provide both filesystem and process confinement required for shell execution.",
  );
  return Object.freeze({
    version: HOST_SHELL_EXECUTION_PLAN_VERSION,
    platform: input.platform,
    requestedSandbox,
    executionRequest,
    mode: "blocked" as const,
    sandboxed: false,
    substrate: "none" as const,
    capability,
    fallbackReason,
    requiresExplicitUserApproval: false,
    identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":" + fallbackReason,
  });
}

// An unpinned native parser needs one-shot authority before startup. Existing
// explicit-host and partial-sandbox gates remain independent of startup proof.
export function requiresExplicitHostShellApproval(plan: HostShellExecutionPlan, toolName?: string): boolean {
  return (plan.mode === "plain" && toolName === "powershell" && !isPowerShellStartupPinned(plan.platform)) || (plan.mode === "plain" &&
    (plan.executionRequest === "host" || plan.requestedSandbox === true) &&
    plan.capability.kind === "none" &&
    plan.requiresExplicitUserApproval === true);
}

// Schema-relevant input normalization shared by the host approval surface and the final native shell permit. It lives in this leaf module (which imports neither approval-gate nor the permit module) so the two host boundaries never form a runtime cycle through their shared parser.
export interface ParsedHostShellExecutionInput {
  readonly command: string;
  readonly cwd: string | undefined;
  readonly timeoutSeconds: number;
  readonly executionMode: HostShellExecutionRequest;
  readonly justification: string | undefined;
  readonly runInBackground: boolean;
}

// Normalize exactly the execution-relevant subset shared by BashTool and PowerShellTool. Undefined means the value cannot represent a native spawn.
export function parseHostShellExecutionInput(
  input: unknown,
): ParsedHostShellExecutionInput | undefined {
  if (!isRecord(input) || typeof input.command !== "string" || input.command.length === 0) {
    return undefined;
  }
  const executionMode = input.executionMode ?? "default";
  if (executionMode !== "default" && executionMode !== "host") return undefined;
  const justification = input.justification;
  if (justification !== undefined && typeof justification !== "string") return undefined;
  const runInBackground = input.run_in_background ?? false;
  if (typeof runInBackground !== "boolean") return undefined;
  if (executionMode === "host" && (!justification?.trim() || runInBackground)) return undefined;
  const cwd = input.cwd;
  if (cwd !== undefined && typeof cwd !== "string") return undefined;
  const timeoutSeconds = input.timeoutSeconds ??
    TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000;
  // Type sanity only: a deadline must exist and be a positive integer, but it has no upper bound — a retry after a timeout escalates the budget, and the permit must not refuse the spawn that retry asks for.
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1
  ) {
    return undefined;
  }
  return Object.freeze({ command: input.command, cwd, timeoutSeconds, executionMode, justification, runInBackground });
}
