/** Choose Windows substrates at boot and report degradation; start mode cannot change mid-session. */
import type {
  SandboxCapability,
} from "../../permissions/sandbox-capability.js";
import type {
  SandboxMxcUnavailableReason,
  SandboxWindowsSubstrateInfo,
} from "../../shared/sandbox-capability-info.js";

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
  readonly windowsBuild: string | null;
  /** ASRT's Windows dependency check passed (srt-win provisioned, WFP fence usable). */
  readonly srtWinReady: boolean;
}

export interface WindowsSandboxPlan {
  readonly start: WindowsAsrtStart;
  readonly substrate: SandboxWindowsSubstrateInfo;
}

export function planWindowsSandbox(input: WindowsSandboxPlanInputs): WindowsSandboxPlan {
  const start: WindowsAsrtStart = input.srtWinReady ? "srt-win" : mxcCandidate(input) ? "proxy-only" : "none";
  return { start, substrate: windowsSubstrateFor(input, start) };
}

function mxcCandidate(input: WindowsSandboxPlanInputs): boolean {
  return input.mxc.state !== "unavailable" && input.shellRequested;
}

/** Retry failed session setup as proxy-only only while container shells remain a candidate and none has run. */
export function canRetryWindowsAsProxyOnly(input: WindowsSandboxPlanInputs, started: WindowsAsrtStart): boolean {
  return started === "srt-win" && mxcCandidate(input);
}

/** A failed probe on proxy-only boot keeps the proxy running; shells use the approved host route. */
export function windowsSubstrateFor(input: WindowsSandboxPlanInputs, started: WindowsAsrtStart): SandboxWindowsSubstrateInfo {
  const shells: SandboxWindowsSubstrateInfo["shells"] =
    started === "none" || !input.shellRequested ? "none" : input.mxc.state === "available" ? "mxc" : "approved-host";
  const extensions: SandboxWindowsSubstrateInfo["extensions"] =
    started === "srt-win" && input.workerRequested ? "srt-win" : "none";
  return {
    mxc: input.mxc.state === "unavailable" ? { state: "unavailable", reason: input.mxc.reason } : { state: input.mxc.state },
    windowsBuild: input.windowsBuild,
    srtWinReady: input.srtWinReady,
    shells,
    extensions,
    shellEgressIdentity: shells === "mxc" ? "kernel-channel" : "shared",
    extensionEgressIdentity: "shared",
  };
}

export function windowsSubstrateWithoutAsrt(substrate: SandboxWindowsSubstrateInfo): SandboxWindowsSubstrateInfo {
  return { ...substrate, shells: "none", extensions: "none", shellEgressIdentity: "shared" };
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
      "nothing else is confined (extension confinement needs the one-time Windows sandbox install)",
    confines: { filesystem: false, process: false, network: false },
  };
}
