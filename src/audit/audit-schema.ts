/** Permission rows discriminate on decision in a dedicated channel; telemetry rows use type. See docs/architecture/permission-policy-design.md, Layer 7. */
import type { ToolCategory, ToolSource } from "../tools/types.js";
import type { ExecutionMode } from "../shared/permission-mode.js";
import type { HookTrustOrigin, ScriptHookType } from "../hooks/script-hook-types.js";
import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import type { ExecutionPlanAuditProjection } from "../permissions/execution-router.js";
import type {
  WorkloadBrokerOperation,
  WorkloadExecutionGrantProjection,
} from "../workload/protocol.js";
import type { JudgeAuditRecord } from "../permissions/judge/judge-engine.js";
import type { RiskLevel } from "../shared/permission-review-status.js";


/** Keep reviewer verdicts structurally compatible with RiskVerdict. */
interface RiskVerdict {
  level: RiskLevel;
  reason: string;
}

/** New hook fields are optional for stored-row compatibility; hookType remains the required derived event alias. */
export interface HookResult {
  hookName: string;
  /** Required legacy pre/post/perm projection of event. */
  hookType: ScriptHookType;
  action: "allow" | "deny";
  reason: string;
  durationMs: number;
  /** Closed-set lifecycle event corresponding to hookType. */
  event?: ScriptHookType;
  /** Absent matcher means match all. */
  matcher?: string;
  /** Command handler type. */
  handlerType?: "command";
  /** Hash the resolved script or verbatim unanchored command to identify exactly what ran. */
  commandIdentity?: string;
  /** Distinguish script hooks from declarative commands; older rows omit this field. */
  source?: "sh" | "config";
  /** Observe records non-blocking denial signals; blocking events emit allow or deny. */
  decision?: "allow" | "deny" | "observe";
  failureReason?: "timeout" | "nonzero-exit" | "spawn-error" | "bad-output";
}

/** Snapshot routine scope as an untyped record so audit shape survives runtime schema changes. */
type RoutineScopeSnapshot = Record<string, unknown>;

/** prevHash links exact serialized rows; entryHash authenticates the current tail and is optional only for older rows. */
interface AuditCommon {
  ts: string;
  auditId: string;
  toolUseId?: string;
  /** Public shell metadata must exclude arguments, paths, approvals, permits, nonces, HMACs, and capability reasons. */
  executionPlan?: HostShellExecutionPlanAuditProjection;
  /** A shadow decision proves neither authorization nor spawn. */
  executionRoute?: ExecutionPlanAuditProjection;
  /** Operation-grant lifecycle evidence contains metadata only. */
  pluginOperation?: {
    pluginId: string;
    operation: string;
    outcome:
      | "issued"
      | "denied"
      | "consumed"
      | "rejected"
      | "indeterminate"
      | "settled";
    grantId?: string;
  };

  trustOrigin: HookTrustOrigin;
  /** Hex HMAC of the previous serialized line; the first row hashes genesis. */
  prevHash: string;
  entryHash?: string;
  readonly workloadBrokerCorrelation?: ToolExecutionAuditMetadata["workloadBrokerCorrelation"];
}

/** Host-owned correlation metadata must never carry renderer data or approval material. */
export interface ToolExecutionAuditMetadata {
  readonly toolUseId?: string;
  readonly executionPlan?: HostShellExecutionPlanAuditProjection;
  readonly executionRoute?: ExecutionPlanAuditProjection;
  readonly workloadBrokerCorrelation?: Readonly<{
    version: "ave-workload-correlation/v1";
    kind: "tool-invocation";
    toolUseId: string;
    toolName: string;
    operation: Exclude<WorkloadBrokerOperation, "handshake">;
    grant: WorkloadExecutionGrantProjection;
  }>;
  /** Capture governance at tool resolution, not from the mutable registry later. Null means invalid or missing governance; undefined means ungoverned. */
  readonly governedOperation?: string | null;
}

/** Directory fields appear only for invocations declaring an explicit path surface. */
interface AuditAllow extends AuditCommon {
  decision: "allow";
  tool: string;
  source: ToolSource;
  category: ToolCategory;
  directory?: string;
  directoryAllowed?: true;
  scope?: RoutineScopeSnapshot;
  /** Record directory grant lifetime; degraded-to-turn marks a session-intent grant conservatively narrowed after propagation failed. */
  grantLifetime?: "turn" | "session" | "always" | "degraded-to-turn";
  /** Policy directory allows carry a rule id instead of grantLifetime; policy admission creates no user grant. */
  policyRule?: string;
  reviewer?: RiskVerdict;
  hookChain?: HookResult[];
  rateLimitRemaining?: number;
}

/** Ask records the prompt; the eventual gesture creates a separate allow or deny row. */
interface AuditAsk extends AuditCommon {
  decision: "ask";
  tool: string;
  source: ToolSource;
  category: ToolCategory;
  directory?: string;
  reason: string;
  hookChain?: HookResult[];
}

/** Short-circuit denials currently record one reason in the plural schema. */
interface AuditDeny extends AuditCommon {
  decision: "deny";
  tool: string;
  source: ToolSource;
  category: ToolCategory;
  denyReasons: ReadonlyArray<{ reason: string; source: string }>;
  hookChain?: HookResult[];
}

/** Mode slash commands require user-keyboard origin; retain the origin for forensic verification. */
interface AuditModeChange extends AuditCommon {
  decision: "mode_change";
  fromMode: ExecutionMode;
  toMode: ExecutionMode;
  durable: boolean;
  /** confirmationSource distinguishes direct settings/slash consent from externally initiated approval. trustOrigin records the human click in both cases; older rows omit the source. */
  confirmationSource?: "settings-ui" | "builtin-slash" | "local-api-approval";
}

/** Record and disable read-category plugins that attempt writes through the filesystem proxy. */
interface AuditManifestViolation extends AuditCommon {
  decision: "manifest_violation";
  pluginId: string;
  toolName: string;
  attemptedOperation: string;
}

/** Active judge decisions belong on the authenticated chain with redacted requests; shadow decisions stay on the shadow channel. */
interface AuditJudge extends AuditCommon {
  decision: "judge";
  tool: string;
  source: ToolSource;
  category: ToolCategory;
  judgeRecord: JudgeAuditRecord;
}

export type PermissionAuditEntry =
  | AuditJudge
  | AuditAllow
  | AuditAsk
  | AuditDeny
  | AuditModeChange
  | AuditManifestViolation;

export type PermissionAuditEntryInput = PermissionAuditEntry extends infer Entry
  ? Entry extends PermissionAuditEntry
    ? Omit<Entry, "prevHash" | "entryHash">
    : never
  : never;

export function isPermissionAuditEntry(value: unknown): value is PermissionAuditEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.decision === "string" && typeof obj.auditId === "string";
}
