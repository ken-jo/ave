/** Choose Windows substrates from verified session readiness and report degradation. */
import type {
  SandboxCapability,
} from "../../permissions/sandbox-capability.js";
import {
  egressProtocolCoverageFor,
  type SandboxWindowsExtensionPlan,
  type SandboxWindowsSubstrateInfo,
} from "../../shared/sandbox-capability-info.js";

import SRT_WIN_PINS from "../../permissions/srt-win-pins.json" with { type: "json" };
import {
  planWindowsExtensionHolder,
  type AdmittedAncestorBackend,
  type WindowsExtensionMxcState,
} from "../../permissions/mxc-extension-readiness.js";

type WindowsAsrtStart = "srt-win" | "proxy-only" | "none";

export interface WindowsSandboxPlanInputs {
  readonly shellRequested: boolean;
  readonly workerRequested: boolean;
  /** While the post-boot shell probe is checking, prepare the proxy but do not use container shells yet. */
  readonly mxc: SandboxWindowsSubstrateInfo["mxc"];
  /** Whether extension holders may select the container. A successful shell launcher probe cannot supply this, and
   * neither can a holder's start evidence, which exists only after a start: it follows the install's release-gate record.
   * Boot supplies a settled state only: `checking` belongs to per-holder readiness. */
  readonly extensionMxc?: Exclude<WindowsExtensionMxcState, { readonly state: "checking" }>;
  /** Readiness must belong to this boot, and the installed fallback must have the exact version. */
  readonly fallbackVersion?: string;
  /** Backend of an already-admitted holder/ancestor, if any; boot itself has none. */
  readonly admittedAncestorBackend?: AdmittedAncestorBackend;
  readonly windowsBuild: string | null;
  /** ASRT's Windows dependency check passed (srt-win provisioned, WFP fence usable). */
  readonly srtWinReady: boolean;
  readonly accountBackendAbsent?: true;
}

export interface WindowsSandboxPlan {
  readonly start: WindowsAsrtStart;
  readonly substrate: SandboxWindowsSubstrateInfo;
}

export function planWindowsSandbox(input: WindowsSandboxPlanInputs): WindowsSandboxPlan {
  const fallbackReady = input.srtWinReady && (input.fallbackVersion ?? SRT_WIN_PINS.version) === "0.0.80";
  const start: WindowsAsrtStart = fallbackReady ? "srt-win" : mxcCandidate(input) ? "proxy-only" : "none";
  return { start, substrate: windowsSubstrateFor(input, start) };
}

function mxcCandidate(input: WindowsSandboxPlanInputs): boolean {
  return (input.mxc.state !== "unavailable" && input.shellRequested)
    || (input.workerRequested && input.extensionMxc !== undefined && input.extensionMxc.state !== "unavailable");
}

/** Retry failed session setup as proxy-only only while container shells remain a candidate and none has run. */
export function canRetryWindowsAsProxyOnly(input: WindowsSandboxPlanInputs, started: WindowsAsrtStart): boolean {
  return started === "srt-win" && input.admittedAncestorBackend === undefined && mxcCandidate(input);
}

/** A failed probe on proxy-only boot keeps the proxy running; shells use the approved host route. */
export function windowsSubstrateFor(input: WindowsSandboxPlanInputs, started: WindowsAsrtStart): SandboxWindowsSubstrateInfo {
  const shells: SandboxWindowsSubstrateInfo["shells"] =
    started === "none" || !input.shellRequested ? "none"
      : input.mxc.state === "available" ? "mxc" : "approved-host";
  const extensionPlan = planWindowsExtensionHolder({
    requested: input.workerRequested,
    mxc: input.extensionMxc ?? { state: "unavailable", reason: "native-validation-required" },
    fallback: { version: input.fallbackVersion ?? SRT_WIN_PINS.version, ready: started === "srt-win" && input.srtWinReady },
    ...(input.admittedAncestorBackend !== undefined ? { admittedAncestorBackend: input.admittedAncestorBackend } : {}),
  });
  const extensions = started === "none" ? "none" : extensionPlan.selectedBackend;
  return {
    mxc: input.mxc,
    windowsBuild: input.windowsBuild,
    srtWinReady: input.srtWinReady,
    ...(input.accountBackendAbsent === true ? { accountBackendAbsent: true } : {}),
    shells,
    extensions,
    shellEgressIdentity: shells === "mxc" ? "kernel-channel" : "shared",
    extensionEgressIdentity: extensions === "mxc" ? "kernel-channel" : "shared",
    extensionPlan: started === "none" ? withoutWindowsExtensionBackend(extensionPlan) : extensionPlan,
  };
}

export function windowsSubstrateWithoutAsrt(substrate: SandboxWindowsSubstrateInfo): SandboxWindowsSubstrateInfo {
  const { accountBackendAbsent: _absenceEvidence, ...degraded } = substrate;
  return { ...degraded, shells: "none", extensions: "none", shellEgressIdentity: "shared", extensionEgressIdentity: "shared",
    ...(substrate.extensionPlan ? { extensionPlan: withoutWindowsExtensionBackend(substrate.extensionPlan) } : {}),
  };
}

function withoutWindowsExtensionBackend(plan: SandboxWindowsExtensionPlan): SandboxWindowsExtensionPlan {
  if (plan.selectedBackend === "none") return plan;
  return {
    ...plan, selectedBackend: "none", readiness: "unavailable", reason: "runtime-unavailable",
    fallbackVersion: null, egressIdentity: "shared", egressProtocolCoverage: egressProtocolCoverageFor("none"),
  };
}

/** Container confinement covers processes and applies endpoint-scoped proxy policy. */
export function mxcShellCapability(): SandboxCapability {
  return {
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason:
      "Each command runs in its own container with per-command filesystem grants, a dedicated egress proxy, " +
      "and a process tree scoped to the invocation.",
    confines: { filesystem: true, process: true, network: true },
  };
}

/** Proxy-only mode confines no process outside shell containers; global capability dimensions must stay false. */
export function windowsProxyOnlyCapability(substrate?: SandboxWindowsSubstrateInfo): SandboxCapability {
  const shellReason = substrate === undefined
    ? "agent shell confinement depends on the container substrate"
    : substrate.shells === "mxc"
      ? "agent shell commands run in containers"
      : substrate.mxc.state === "checking"
        ? "container start check pending; agent shell commands require host approval"
        : "containers unavailable; agent shell commands require host approval";
  return {
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason:
      `Proxy only — ${shellReason}; ` +
      "extension confinement is selected separately for each admitted holder",
    confines: { filesystem: false, process: false, network: false },
  };
}

/** The boot warning for requested extension confinement with no extension substrate, true to what happens next:
 * a checking or rejected plan refuses extension starts; a settled no-backend plan, including one whose readiness deadline
 * expired, runs each only after its own approval. */
export function windowsExtensionBootWarning(substrate: SandboxWindowsSubstrateInfo): string | undefined {
  if (substrate.extensions !== "none") return undefined;
  const plan = substrate.extensionPlan;
  if (plan?.readiness === "checking" || plan?.readiness === "rejected") {
    return `boot: extension confinement is ON and no extension backend admitted this session (${plan.readiness}, ${plan.reason}) — ` +
      "plugin workers, plugin children, plugin hooks and MCP stdio servers are REFUSED until a backend is admitted; nothing runs unconfined.";
  }
  // The shell clause describes this substrate's shells, never a container route it does not have.
  const shells = substrate.shells !== "mxc" && !(substrate.shells === "approved-host" && substrate.mxc.state === "checking")
    ? ""
    : substrate.shells === "mxc"
      ? "; agent shells run in Microsoft Execution Containers"
      : "; agent shells run in Microsoft Execution Containers once the container start check passes";
  const late = plan?.reason === "readiness-deadline" ? "the extension backend did not become ready in time (readiness-deadline) and " : "";
  return `boot: extension confinement is ON but ${late}the Windows sandbox (srt-win) is NOT ready — ` +
    "plugin workers, plugin children, plugin hooks and MCP stdio servers each wait for a per-start approval and then run with NO OS isolation " +
    `until the one-time administrator install completes${shells}.`;
}
