/**
 * Which substrate carries each kind of process on a Windows boot, decided once
 * from what the host offers (proxy-egress PR 9, owner decision 2026-10-19).
 *
 * MXC is decided in two steps: the boot-path checks (launcher pin, probe, dry
 * run) and, after boot, a real PowerShell start (`checking` until it settles;
 * shells use the non-MXC route meanwhile). The table is the settled state.
 *
 * | MXC (agent shells requested) | srt-win ready | ASRT runs as             | shells        | extensions |
 * |------------------------------|---------------|--------------------------|---------------|------------|
 * | available                    | yes           | srt-win (as before)      | MXC           | srt-win    |
 * | available                    | no            | proxy only (patch part 3) | MXC          | none       |
 * | unavailable                  | yes           | srt-win (as before)      | approved host | srt-win    |
 * | unavailable                  | no            | not started (degrade)    | none          | none       |
 *
 * No row falls back silently: each one is recorded for Settings
 * ({@link SandboxWindowsSubstrateInfo}) and logged at boot. Where MXC is
 * unavailable the egress identity is `shared`; the egress ask (PR 4, not yet
 * wired) is to cap such grants with `maxEgressGrantScope`.
 */
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
  /**
   * `checking`: the boot-path checks passed and the PowerShell start probe
   * runs after boot. ASRT starts as if MXC were available (so a later pass
   * needs no restart), but shells do not use MXC until the probe passes.
   */
  readonly mxc: WindowsMxcState;
  readonly windowsBuild: string | null;
  /** ASRT's Windows dependency check passed (srt-win provisioned, WFP fence usable). */
  readonly srtWinReady: boolean;
}

export interface WindowsSandboxPlan {
  /** How to start ASRT this boot, or `none` to leave it stopped. */
  readonly start: WindowsAsrtStart;
  /** What Settings shows if ASRT starts as planned. */
  readonly substrate: SandboxWindowsSubstrateInfo;
}

export function planWindowsSandbox(input: WindowsSandboxPlanInputs): WindowsSandboxPlan {
  const mxcCandidate = input.mxc.state !== "unavailable" && input.shellRequested;
  const start: WindowsAsrtStart = input.srtWinReady ? "srt-win" : mxcCandidate ? "proxy-only" : "none";
  return { start, substrate: windowsSubstrateFor(input, start) };
}

/**
 * What carries shells and extensions once ASRT has started as `started`. Used
 * at boot and again when the PowerShell start probe settles, since the start
 * mode cannot change mid-session: a proxy-only boot whose probe fails keeps
 * the proxy running and its shells take the approved host route (the
 * process-wide capability confines nothing, so the host-shell plan asks).
 */
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

/** The substrate to record when ASRT did not start after all (init failed). */
export function windowsSubstrateWithoutAsrt(substrate: SandboxWindowsSubstrateInfo): SandboxWindowsSubstrateInfo {
  return { ...substrate, shells: "none", extensions: "none", shellEgressIdentity: "shared" };
}

/**
 * The capability a Bash/PowerShell tool command gets inside its MXC
 * container. Process confinement is claimed on measured grounds: a container
 * cannot terminate a host process of the same user, and every descendant
 * ends with the command (MXC's job object; also when `wxc-exec.exe` itself
 * is killed).
 *
 * `network` means outbound connections: WFP lets the container reach only its
 * own proxy port (measured). It does not cover name resolution, which goes
 * through the host's DNS client service (measured: public names resolve inside
 * the container, so a command can signal through lookups without the proxy),
 * nor inbound: proxy mode requires `ingress.default: "allow"`
 * (`privateNetworkClientServer`), and no connection from the host, the LAN,
 * Tailscale or another container reached a listening container when measured
 * with Windows Firewall's default inbound blocking on. The reason text says so.
 */
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

/**
 * The process-wide capability when ASRT runs on Windows only as the MXC
 * shells' proxy. Nothing outside those containers is confined, so every
 * dimension is false: the workspace terminal and plugin surfaces, which read
 * this capability, must not believe otherwise.
 */
export function windowsProxyOnlyCapability(): SandboxCapability {
  return {
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason:
      "ASRT proxy only — agent shell commands run in Microsoft Execution Containers; " +
      "nothing else is confined (extension confinement needs the one-time Windows sandbox install)",
    confines: { filesystem: false, process: false, network: false },
  };
}
