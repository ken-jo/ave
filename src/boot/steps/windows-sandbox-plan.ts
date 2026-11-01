/** Choose Windows substrates at boot and report degradation; start mode cannot change mid-session. */
import type {
  SandboxCapability,
} from "../../permissions/sandbox-capability.js";
import type {
  SandboxMxcUnavailableReason,
  SandboxWindowsSubstrateInfo,
} from "../../shared/sandbox-capability-info.js";

import SRT_WIN_PINS from "../../permissions/srt-win-pins.json" with { type: "json" };
import { planWindowsExtensionHolder, type WindowsExtensionMxcState } from "../../permissions/mxc-extension-readiness.js";

type WindowsAsrtStart = "srt-win" | "proxy-only" | "none";

type WindowsMxcState =
  | { readonly state: "available" }
  | { readonly state: "checking" }
  | { readonly state: "unavailable"; readonly reason: SandboxMxcUnavailableReason };

export interface WindowsSandboxPlanInputs {
  readonly shellRequested: boolean;
  readonly workerRequested: boolean;
  /** While the post-boot shell probe is checking, prepare the proxy but do not use container shells yet. */
  readonly mxc: WindowsMxcState;
  /** Dedicated SDK/request readiness; a successful shell launcher probe cannot supply this evidence. */
  readonly extensionMxc?: WindowsExtensionMxcState;
  /** Readiness must belong to this boot, and the installed fallback must have the exact version. */
  readonly fallbackVersion?: string;
  readonly holderOrAncestorAdmitted?: boolean;
  readonly windowsBuild: string | null;
  /** ASRT's Windows dependency check passed (srt-win provisioned, WFP fence usable). */
  readonly srtWinReady: boolean;
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
  return started === "srt-win" && input.holderOrAncestorAdmitted !== true && mxcCandidate(input);
}

/** A failed probe on proxy-only boot keeps the proxy running; shells use the approved host route. */
export function windowsSubstrateFor(input: WindowsSandboxPlanInputs, started: WindowsAsrtStart): SandboxWindowsSubstrateInfo {
  const shells: SandboxWindowsSubstrateInfo["shells"] =
    started === "none" || !input.shellRequested ? "none" : input.mxc.state === "available" ? "mxc" : "approved-host";
  const extensionPlan = planWindowsExtensionHolder({
    requested: input.workerRequested,
    mxc: input.extensionMxc ?? { state: "unavailable", reason: "native-validation-required" },
    fallback: { version: input.fallbackVersion ?? SRT_WIN_PINS.version, ready: started === "srt-win" && input.srtWinReady },
    holderOrAncestorAdmitted: input.holderOrAncestorAdmitted ?? false,
  });
  const extensions = started === "none" ? "none" : extensionPlan.selectedBackend;
  return {
    mxc: input.mxc.state === "unavailable" ? { state: "unavailable", reason: input.mxc.reason } : { state: input.mxc.state },
    windowsBuild: input.windowsBuild,
    srtWinReady: input.srtWinReady,
    shells,
    extensions,
    shellEgressIdentity: shells === "mxc" ? "kernel-channel" : "shared",
    extensionEgressIdentity: extensions === "mxc" ? "kernel-channel" : "shared",
    extensionPlan: started === "none" && extensionPlan.selectedBackend !== "none" ? { ...extensionPlan, selectedBackend: "none", readiness: "unavailable", reason: "runtime-unavailable", fallbackVersion: null, egressIdentity: "shared" } : extensionPlan,
  };
}

export function windowsSubstrateWithoutAsrt(substrate: SandboxWindowsSubstrateInfo): SandboxWindowsSubstrateInfo {
  return { ...substrate, shells: "none", extensions: "none", shellEgressIdentity: "shared", extensionEgressIdentity: "shared",
    ...(substrate.extensionPlan ? { extensionPlan: substrate.extensionPlan.selectedBackend === "none"
      ? substrate.extensionPlan
      : { ...substrate.extensionPlan, selectedBackend: "none", readiness: "unavailable", reason: "runtime-unavailable", fallbackVersion: null, egressIdentity: "shared" } } : {}),
  };
}

/** Container confinement covers processes and outbound connections, not DNS signaling or inbound traffic. */
export function mxcShellCapability(): SandboxCapability {
  return {
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason:
      "Microsoft Execution Containers (BaseContainer) — each command in its own container with per-command " +
      "filesystem grants, outbound connections only through its own proxy port, and no process outliving the " +
      "command; DNS lookups still go through the host resolver, and inbound relies on Windows Firewall",
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
