/** Sandbox execution telemetry uses a separate JSONL schema from permission decisions (docs/research/sandbox-isolation.md). */

import type { SandboxKind, SandboxCapability } from "../permissions/sandbox-capability.js";
import type { UserApprovalVerdict } from "../shared/permissions-events.js";
import type { ToolTrustOrigin } from "../tools/types.js";
import type { RiskLevel } from "../shared/permission-review-status.js";
import type { EgressDenial, EgressDenialSource } from "../shared/egress-denials.js";
import type { EgressGrantScope } from "../shared/sandbox-capability-info.js";

/** Events observed by sandbox backends while intercepting filesystem or network operations. */
export type SandboxEvent =
  | {
      type: "egress_attempted";
      blocked: boolean;
      target: string;
    }
  | {
      type: "fs_write_attempted";
      blocked: boolean;
      path: string;
    };

/** One row per sandboxed invocation: tool identity, confinement events, timing, and reviewer provenance. */
export interface SandboxAuditEntry {
  timestamp: string;  // ISO 8601

  tool: {
    name: string;
    /** Callers must DLP-mask arguments before emitting their JSON representation. */
    args: string;
    source: string;
    /** Trust origin mirrors ToolInvocationContext.trustOrigin. */
    trustOrigin?: ToolTrustOrigin;
    /** Optional authority-sensitive approval identity for this invocation. */
    approvalCacheKey?: string;
  };

  sandbox: {
    kind: SandboxKind;
    confidence: SandboxCapability["confidence"];
    events: SandboxEvent[];
    /** Wall-clock ms from spawn() call to first byte of child stdout. */
    spawnLatencyMs: number;
    /** Percentage overhead is spawnLatencyMs / totalExecutionMs * 100, rounded to two decimals. */
    overheadPercent: number;
  };

  reviewer: {
    ruleVerdict: RiskLevel;
    /** Raw parsed model verdict, or high on fail-closed errors; null when rules or cached approval supplied the verdict. */
    llmVerdict: RiskLevel | null;
    /** Use max(rule, model), or max(rule, stored approval verdict) on a memory hit. */
    finalVerdict: RiskLevel;
    /** Only rules that overrode the base verdict are recorded. */
    compositionRulesTriggered: Array<{
      rule: string;
      reason: string;
    }>;
    /** Null when approval or denial occurred without user interaction. */
    userApprovalUsed: {
      memoryHit: boolean;
      /** Null when the user supplied no justification. */
      nlJustification: string | null;
      /** Verdict recorded when the approval prompt was shown. */
      verdictAtApproval: UserApprovalVerdict | null;
    } | null;
  };
}

/** The builder alone supplies the UTC timestamp; the sink owns persistence. */
export function buildSandboxAuditEntry(params: {
  tool: SandboxAuditEntry["tool"];
  sandbox: SandboxAuditEntry["sandbox"];
  reviewer: SandboxAuditEntry["reviewer"];
}): SandboxAuditEntry {
  // Copy fields explicitly so callers cannot override the timestamp through a spread.
  return {
    timestamp: new Date().toISOString(),
    tool: params.tool,
    sandbox: params.sandbox,
    reviewer: params.reviewer,
  };
}

/** Record invocation ownership without its live token; forged, stale, or absent tokens are unattributed. */
export type SandboxEgressDenyInvocation = EgressDenialSource;

/** Proxy-denial rows use entryKind; tool-execution rows use reviewer and no entryKind. */
export interface SandboxEgressDenyAuditEntry {
  timestamp: string; // ISO 8601, when ASRT recorded the deny
  entryKind: "egress-deny";
  sandbox: {
    kind: SandboxKind;
    confidence: SandboxCapability["confidence"];
    /** Exactly one `egress_attempted` event with `blocked: true`. */
    events: [Extract<SandboxEvent, { type: "egress_attempted" }>];
  };
  invocation: SandboxEgressDenyInvocation;
  deny: EgressDenial;
}

export function buildSandboxEgressDenyAuditEntry(params: {
  timestamp: Date;
  sandbox: { kind: SandboxKind; confidence: SandboxCapability["confidence"] };
  invocation: SandboxEgressDenyInvocation;
  deny: SandboxEgressDenyAuditEntry["deny"];
}): SandboxEgressDenyAuditEntry {
  const target = params.deny.port === null ? params.deny.host : `${params.deny.host}:${params.deny.port}`;
  return {
    timestamp: params.timestamp.toISOString(),
    entryKind: "egress-deny",
    sandbox: {
      kind: params.sandbox.kind,
      confidence: params.sandbox.confidence,
      events: [{ type: "egress_attempted", blocked: true, target }],
    },
    invocation: params.invocation,
    deny: params.deny,
  };
}

/** A failed transport leg records no permission decision. */
export interface SandboxEgressFailureAuditEntry {
  timestamp: string;
  entryKind: "egress-failure";
  sandbox: { kind: SandboxKind; confidence: SandboxCapability["confidence"] };
  invocation: SandboxEgressDenyInvocation;
  destination: { host: string; port: number };
  failure: { kind: "dns" | "connect" | "timeout" | "routing"; httpStatus: 502 | 504; reason: string };
}

export type EgressDecisionBasis =
  /** A plugin worker reached a host its extension declares (or the host's model endpoint). */
  | "extension-allowlist"
  /** A shell reached a host a standing grant covers. */
  | "grant"
  /** A `Network(...)` host rule decided it (deny, or allow for a public destination). */
  | "rule"
  | "prompt"
  /** Refused before any lookup: unattributed, wrong kind of identity, or a rule. */
  | "policy"
  /** Proxy-level refusal precedes the callback: denied or malformed hosts, another invocation's listener, or proxy routing back to this host. */
  | "sandbox";

/** Decision rows record resolution and user choice; refusals also generate a proxy-denial row. */
export interface SandboxEgressDecisionAuditEntry {
  timestamp: string;
  entryKind: "egress-decision";
  invocation: SandboxEgressDenyInvocation;
  /** DLP-mask the destination host as for denial rows. */
  destination: { host: string; port: number | null };
  decision: "allow" | "deny";
  basis: EgressDecisionBasis;
  /** Null when no grant matched or was selected. */
  scope: EgressGrantScope | null;
  /** Null for allowed requests. */
  reason: string | null;
}

/** A v1 "This workspace" network grant the v1 → v2 grant-file migration dropped instead of widening it: its directory was inside a repository, and a v2 "This project" grant keys on the repository root. DLP-mask the host and both directories as for denial rows. */
export interface SandboxEgressGrantMigrationAuditEntry {
  timestamp: string;
  entryKind: "egress-grant-migration";
  action: "dropped";
  destination: { host: string; port: number };
  /** The v1 grant's exact directory. */
  workspaceRoot: string;
  /** The repository root a v2 project grant would have covered. */
  projectRoot: string;
}

/** Record skipped unusable proxy routes once per lookup, not connection.
 * DLP-mask hosts and entries; never record credentials, and name environment entries only by variable. */
export interface SandboxEgressRouteAuditEntry {
  timestamp: string;
  entryKind: "egress-route";
  destination: { host: string; port: number };
  /** Where the routes came from (`UpstreamProxySource`). */
  source: string;
  skipped: string[];
}
