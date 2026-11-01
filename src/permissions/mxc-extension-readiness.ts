import type { SandboxWindowsExtensionPlan, SandboxWindowsExtensionReason } from "../shared/sandbox-capability-info.js";
import { MxcCapabilityUnavailableError } from "./mxc-extension-errors.js";
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
    dnsProtection: "host-resolver" as const,
    ancestorAccess: "query-enumerate-only" as const,
    ancestorNameExposure: true as const,
  };
  if (!input.requested) return { ...base, readiness: "off", reason: "not-requested" };
  if (input.mxc.state === "checking") return { ...base, readiness: "checking", reason: "checking" };
  const ancestor = input.admittedAncestorBackend;
  // One backend per holder tree: MXC is selectable only at the root or beneath an MXC ancestor.
  if (input.mxc.state === "available") {
    return ancestor === undefined || ancestor === "mxc"
      ? { ...base, selectedBackend: "mxc", readiness: "ready", reason: "ready", egressIdentity: "kernel-channel" }
      : { ...base, readiness: "rejected", reason: "ancestor-already-admitted" };
  }
  if (ancestor !== undefined) return { ...base, readiness: "rejected", reason: "ancestor-already-admitted" };
  if (input.fallback.version === "0.0.80" && input.fallback.ready) {
    return { ...base, selectedBackend: "srt-win", readiness: "fallback", reason: input.mxc.reason, fallbackVersion: "0.0.80" };
  }
  return { ...base, readiness: input.mxc.reason === "readiness-deadline" ? "rejected" : "unavailable", reason: input.mxc.reason };
}

/** Every field is an observation from the exact installed runtime/request probe, not a host version guess. */
export interface MxcExtensionReadinessEvidence {
  readonly installedPayloadVerified: boolean;
  readonly baseContainerReady: boolean;
  readonly exactRequestAccepted: boolean;
  readonly uiEnabledRuntimeStarted: boolean;
  readonly ancestorQueriesSupported: boolean;
  readonly standardStreamsRoundTrip: boolean;
  readonly cleanTermination: boolean;
  readonly ownProxySucceeded: boolean;
  readonly otherListenerRefused: boolean;
  readonly directEgressRefused: boolean;
  readonly forgedLabelsAttributed: boolean;
  readonly noWorkerPort: boolean;
  /** A reparse point substituted for an admitted grant path between admission and native open is refused. */
  readonly reparseSubstitutionRefused: boolean;
}

export function classifyMxcExtensionReadiness(evidence: MxcExtensionReadinessEvidence): WindowsExtensionMxcState {
  if (!evidence.ancestorQueriesSupported) return { state: "unavailable", reason: "ancestor-policy-unsupported" };
  if (!evidence.uiEnabledRuntimeStarted) return { state: "unavailable", reason: "runtime-start-failed" };
  if (![evidence.ownProxySucceeded, evidence.otherListenerRefused, evidence.directEgressRefused,
    evidence.forgedLabelsAttributed, evidence.noWorkerPort].every(value => value === true)) {
    return { state: "unavailable", reason: "endpoint-isolation-unverified" };
  }
  return [evidence.installedPayloadVerified, evidence.baseContainerReady, evidence.exactRequestAccepted,
    evidence.uiEnabledRuntimeStarted, evidence.ancestorQueriesSupported, evidence.standardStreamsRoundTrip,
    evidence.cleanTermination, evidence.ownProxySucceeded, evidence.otherListenerRefused, evidence.directEgressRefused,
    evidence.forgedLabelsAttributed, evidence.noWorkerPort, evidence.reparseSubstitutionRefused].every(value => value === true)
    ? { state: "available" }
    : { state: "unavailable", reason: "native-validation-required" };
}

/** A deadline selects an already-ready fallback or rejects. It never initializes a backend or retries a spawn. */
export async function settleWindowsExtensionReadiness(input: {
  readonly probe: (signal: AbortSignal) => Promise<MxcExtensionReadinessEvidence>;
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
      selectedBackend: "none", readiness: "rejected", reason: "request-rejected", fallbackVersion: null, egressIdentity: "shared" };
    return planWindowsExtensionHolder({ requested: true, mxc, fallback: input.fallback,
      admittedAncestorBackend: input.admittedAncestorBackend() });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancelled) input.signal?.removeEventListener("abort", cancelled);
  }
}
