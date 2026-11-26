import { egressProtocolCoverageFor, type SandboxWindowsExtensionPlan, type SandboxWindowsExtensionReason } from "../shared/sandbox-capability-info.js";
import { MxcCapabilityUnavailableError } from "./mxc-extension-errors.js";
import type { MxcExtensionStartEvidence } from "./mxc-extension-protocol.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

/** Readiness of an exact runtime/request, separate from the shell launcher probe. */
export type WindowsExtensionMxcState =
  | { readonly state: "available" }
  | { readonly state: "checking" }
  | { readonly state: "unavailable"; readonly reason: SandboxWindowsExtensionReason };

/** The backend an already-admitted owner/parent of this start runs under. */
export type AdmittedAncestorBackend = SandboxWindowsExtensionPlan["selectedBackend"];

export interface WindowsExtensionHolderInputs {
  readonly requested: boolean;
  readonly mxc: WindowsExtensionMxcState;
  readonly fallback: { readonly version: string; readonly ready: boolean };
  /** Absent: no holder or ancestor is admitted. Present: its backend binds the whole tree. */
  readonly admittedAncestorBackend?: AdmittedAncestorBackend;
}

/** Select once before admission. A failed selected holder never calls this to downgrade. */
export function planWindowsExtensionHolder(input: WindowsExtensionHolderInputs): SandboxWindowsExtensionPlan {
  const base = {
    requestedBackend: input.requested ? "mxc" as const : "none" as const,
    selectedBackend: "none" as const,
    fallbackVersion: null,
    uiPolicy: "ui-enabled" as const,
    egressIdentity: "shared" as const,
    proxyOwnerVerified: false as const,
    hostLoopback: "bidirectional" as const,
    inboundProtection: "host-firewall" as const,
    egressProtocolCoverage: egressProtocolCoverageFor("none"),
    ancestorAccess: "query-enumerate-only" as const,
    ancestorNameExposure: true as const,
  };
  if (!input.requested) return { ...base, readiness: "off", reason: "not-requested" };
  if (input.mxc.state === "checking") return { ...base, readiness: "checking", reason: "checking" };
  const ancestor = input.admittedAncestorBackend;
  // One backend per holder tree: MXC is selectable only at the root or beneath an MXC ancestor.
  if (input.mxc.state === "available") {
    return ancestor === undefined || ancestor === "mxc"
      ? { ...base, selectedBackend: "mxc", readiness: "ready", reason: "ready", egressIdentity: "kernel-channel",
        egressProtocolCoverage: egressProtocolCoverageFor("mxc") }
      : { ...base, readiness: "rejected", reason: "ancestor-already-admitted" };
  }
  if (ancestor !== undefined) return { ...base, readiness: "rejected", reason: "ancestor-already-admitted" };
  if (input.fallback.version === "0.0.80" && input.fallback.ready) {
    return { ...base, selectedBackend: "srt-win", readiness: "fallback", reason: input.mxc.reason,
      fallbackVersion: "0.0.80", egressProtocolCoverage: egressProtocolCoverageFor("srt-win") };
  }
  // An expired readiness deadline is a start with no backend (per-start ask), not a refusal; the reason says which it was.
  return { ...base, readiness: "unavailable", reason: input.mxc.reason };
}

/** Contract fields 8-13. Install-wide: the native release gate gathers them once per release on the packaged build. A
 * holder start checks the registered record and never gathers them. Fields 1-5 are `MxcExtensionStartEvidence` (this
 * holder's own start); field 6 (stream round trip) is the MCP marker rule; field 7 (clean termination) is teardown evidence. */
export interface MxcExtensionReleaseGateEvidence {
  readonly ownProxySucceeded: boolean;
  readonly otherListenerRefused: boolean;
  readonly directEgressRefused: boolean;
  readonly forgedLabelsAttributed: boolean;
  readonly noWorkerPort: boolean;
  /** A reparse point substituted for an admitted grant path between admission and native open is refused. */
  readonly reparseSubstitutionRefused: boolean;
}

/** Per-start readiness: every one of fields 1-5, observed by the holder's own start. Absent counts as not observed. */
export function classifyMxcExtensionReadiness(evidence: MxcExtensionStartEvidence): WindowsExtensionMxcState {
  if (evidence.ancestorQueriesSupported !== true) return { state: "unavailable", reason: "ancestor-policy-unsupported" };
  if (evidence.uiEnabledRuntimeStarted !== true) return { state: "unavailable", reason: "runtime-start-failed" };
  return [evidence.installedPayloadVerified, evidence.baseContainerReady, evidence.exactRequestAccepted].every(value => value === true)
    ? { state: "available" }
    : { state: "unavailable", reason: "native-validation-required" };
}

/** Install-wide readiness: every one of fields 8-13 in the release-gate record. */
export function classifyMxcReleaseGate(evidence: MxcExtensionReleaseGateEvidence): WindowsExtensionMxcState {
  if (![evidence.ownProxySucceeded, evidence.otherListenerRefused, evidence.directEgressRefused,
    evidence.forgedLabelsAttributed, evidence.noWorkerPort].every(value => value === true)) {
    return { state: "unavailable", reason: "endpoint-isolation-unverified" };
  }
  return evidence.reparseSubstitutionRefused === true ? { state: "available" } : { state: "unavailable", reason: "native-validation-required" };
}

/** Bounds one readiness wait; `probe` is the holder's own start, which its lifetime owner cleans up. A deadline selects an
 * already-ready fallback or settles with no backend. It never initializes a backend or retries a spawn. */
export async function settleWindowsExtensionReadiness(input: {
  readonly probe: (signal: AbortSignal) => Promise<MxcExtensionStartEvidence>;
  readonly fallback: WindowsExtensionHolderInputs["fallback"];
  readonly admittedAncestorBackend: () => AdmittedAncestorBackend | undefined;
  readonly signal?: AbortSignal;
}): Promise<SandboxWindowsExtensionPlan> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled: (() => void) | undefined;
  const deadline = new Promise<WindowsExtensionMxcState>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ state: "unavailable", reason: "readiness-deadline" }); }, TOOL_TIMEOUT_POLICY.mxcExtensionReadinessMs);
    cancelled = () => { controller.abort(); resolve({ state: "unavailable", reason: "request-rejected" }); };
    input.signal?.addEventListener("abort", cancelled, { once: true });
    if (input.signal?.aborted) cancelled();
  });
  const observed = Promise.resolve().then(() => {
    if (controller.signal.aborted) return { state: "unavailable", reason: "request-rejected" } as const;
    return input.probe(controller.signal).then(classifyMxcExtensionReadiness);
  }).catch((error): WindowsExtensionMxcState => {
    if (error instanceof MxcCapabilityUnavailableError) return { state: "unavailable", reason: "probe-failed" };
    throw error;
  });
  try {
    const mxc = await Promise.race([deadline, observed]);
    if (input.signal?.aborted) return { ...planWindowsExtensionHolder({ requested: true, mxc,
      fallback: { ...input.fallback, ready: false }, admittedAncestorBackend: input.admittedAncestorBackend() }),
       selectedBackend: "none", readiness: "rejected", reason: "request-rejected", fallbackVersion: null, egressIdentity: "shared",
       egressProtocolCoverage: egressProtocolCoverageFor("none") };
    return planWindowsExtensionHolder({ requested: true, mxc, fallback: input.fallback,
      admittedAncestorBackend: input.admittedAncestorBackend() });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancelled) input.signal?.removeEventListener("abort", cancelled);
  }
}
