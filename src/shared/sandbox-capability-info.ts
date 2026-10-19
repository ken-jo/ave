/**
 * Honest, platform-aware description of what the OS tool sandbox actually
 * enforces. Shared between main (IPC handler) and any caller that needs to
 * report capability truthfully — NO overclaiming.
 *
 * Platform reality (now backed by the Anthropic Sandbox Runtime — see
 * src/permissions/asrt-sandbox.ts):
 *   - macOS (Seatbelt via ASRT): filesystem + process confinement, AND network
 *     — ASRT routes egress through a loopback proxy enforcing the global
 *     strict-union allow-list, so egress IS contained (no longer the old
 *     sandbox-exec fake floor that left loopback/IPv6/DNS open).
 *   - Linux (bwrap via ASRT): filesystem + process + network.
 *   - Windows (srt-win via ASRT): filesystem ACL + network egress confinement.
 *     ASRT provisions a dedicated `srt-sandbox` user, applies filesystem rules
 *     through its Windows ACL backend, and enforces egress with WFP + the
 *     loopback proxy. Windows still has NO process isolation, so this remains a
 *     PARTIAL-confine substrate. Its filesystem confinement is against the
 *     host only: every confined process — every plugin's child, worker, hook
 *     and server included — runs as that one account, so plugins are NOT
 *     isolated from each other there (owner decision 2026-10-10,
 *     `plugin-hostapi-protocol.md` §9.8 A2). `filesystem: true` below never
 *     means isolation between plugins.
 */

/** What the sandbox confines, by platform. `network` is false where egress is not contained. */
export interface SandboxConfinement {
  filesystem: boolean;
  process: boolean;
  network: boolean;
}

/**
 * Windows srt-win install readiness, returned to the renderer's consent panel.
 *
 * `ready` is the single boolean the UI gates on: ASRT's dedicated
 * `srt-sandbox` user is provisioned (`userState === "ready"`) AND the WFP
 * filter set is installed (`wfpState === "installed"`). Until both hold, the
 * sandbox cannot confine filesystem/network access and boot keeps
 * `isAsrtSandboxActive()` false.
 *
 * `applicable` is false on every non-win32 platform — the renderer renders the
 * macOS/Linux capability copy instead of the Windows consent flow. The state
 * fields are `null` there (no Windows backend to query).
 *
 * `instructions` is the VERBATIM ASRT `windowsInstallInstructions(...)` text.
 * Empty string when not applicable.
 */
export interface SandboxWindowsStatusInfo {
  /** True only on win32. Non-win32 → false, with null state fields. */
  applicable: boolean;
  /** `absent` | `incomplete` | `ready`, or null off-win32. */
  userState: "absent" | "incomplete" | "ready" | null;
  /** `absent` | `installed` | `cannot-read`, or null off-win32. */
  wfpState: "absent" | "installed" | "cannot-read" | null;
  /**
   * True when the sandbox user is ready and WFP is either directly observed as
   * installed or `cannot-read` plus ASRT behavioral egress verification succeeds.
   * Always false off-win32.
   */
  ready: boolean;
  /** Verbatim ASRT install instructions. Empty off-win32. */
  instructions: string;
}

/**
 * What one Windows "Re-provision" click led to. Every value is a state the
 * Settings panel shows on its own, so the click never ends looking like nothing
 * happened (issue #1608). Main reads status first, after validating the
 * click's gesture intent, and raises the UAC prompt only when it is needed.
 * - `ready`: the install ran and the sandbox is proven ready.
 * - `already-ready`: the sandbox was already ready, so no elevation was asked.
 * - `installed-unverified`: the install ran (exit 0), but Ave could not prove
 *   readiness afterwards; `userState`/`wfpState` say what it saw.
 * - `cancelled`: elevation was not granted (the prompt was dismissed, or
 *   Windows could not show it). Nothing changed.
 * - `timed-out`: setup exceeded the runtime's 120 s window. Its final state
 *   is unconfirmed; partial setup changes may remain.
 * - `failed`: the install or a step after it failed; `errorCode` is ASRT's
 *   stable `WindowsSandboxError` code or `unexpected`.
 */
type SandboxWindowsInstallOutcome =
  | "ready"
  | "installed-unverified"
  | "already-ready"
  | "cancelled"
  | "timed-out"
  | "failed";

/**
 * Result of the user-consented Windows install (one self-elevating UAC).
 * `outcome` is always set; the other fields add detail to it. It carries no
 * free-text diagnostic: ASRT's messages hold srt-win output and local paths
 * (including the user name), so they stay in the main-process log.
 */
export interface SandboxWindowsInstallResult {
  outcome: SandboxWindowsInstallOutcome;
  /** Set with `outcome: "cancelled"` (kept for older readers). */
  cancelled?: true;
  /** Sandbox user state after the install (or the pre-check, for `already-ready`). */
  userState?: "absent" | "incomplete" | "ready";
  /** WFP state after the install (or the pre-check, for `already-ready`). */
  wfpState?: "absent" | "installed" | "cannot-read";
  /** Readiness, using the same WFP verification rule as status. */
  ready?: boolean;
  /** With `outcome: "failed"`: a stable machine code. */
  errorCode?: string;
}

/** Which branch the boot-time sandbox gate took. */
export type SandboxGateAction = "skip" | "activate" | "degrade" | "abort";

/** Stable machine reason for the branch the boot gate took. */
export type SandboxGateReason =
  | "gate-off"
  | "deps-present"
  /** Windows: srt-win not installed, ASRT runs as the proxy for agent shells in MXC containers. */
  | "activate-windows-mxc-proxy-only"
  | "degrade-windows-not-installed"
  | "degrade-default-cannot-activate"
  | "abort-explicit-cannot-activate"
  | "degrade-linux-runtime-probe-failed"
  | "abort-linux-runtime-probe-failed";

/**
 * What the sandbox gate actually decided for THIS process, sealed at boot.
 *
 * The runtime snapshot cannot answer this. When the gate degrades, no capability
 * is ever registered, so the runtime SOT falls back to its "no OS sandbox
 * configured" default — the same answer it gives when the user never turned the
 * sandbox on. Those two states are not the same thing to the person using the
 * app: one is a setting they chose, the other is a setting they chose that did
 * not take effect. Without this, the reason the gate degraded lived only in the
 * boot log, which a packaged app's user has no way to read.
 */
export interface SandboxBootOutcome {
  readonly action: SandboxGateAction;
  readonly reason: SandboxGateReason;
  /** Which on-signal drove the gate: the env override, the setting, or neither. */
  readonly onSignal: "explicit-env" | "default-settings" | "off";
  /**
   * Why the sandbox could not activate, verbatim from the dependency check —
   * these carry the install command the user has to run. Empty when the gate
   * did not fail on dependencies.
   */
  readonly dependencyErrors: readonly string[];
}

/**
 * How strongly the egress proxy knows which invocation opened a connection.
 *
 * - `kernel-channel`: the OS pins each confined process to its own proxy
 *   listener, so the port a connection arrives on names the invocation
 *   (Windows MXC per-container WFP; `egress-invocation-listener.ts`). A
 *   process cannot present another invocation's identity.
 * - `shared`: confined processes share one proxy endpoint and the identity is
 *   a label the client presents (ASRT's proxy username). Attribution, not a
 *   boundary between concurrent invocations.
 */
export type EgressIdentityStrength = "kernel-channel" | "shared";

/** The scopes an egress grant can be given, narrowest first. */
export type EgressGrantScope = "once" | "conversation" | "workspace" | "always";

/**
 * The widest egress-grant scope an identity strength can carry. With a shared
 * identity another invocation of the same session can present the id a grant
 * was given to, so a grant must not outlive the conversation it was given in.
 * The egress ask (proxy-egress PR 4) is to cap the scopes it offers with
 * this; until it does, nothing calls it and no surface claims the cap.
 */
export function maxEgressGrantScope(strength: EgressIdentityStrength): EgressGrantScope {
  return strength === "kernel-channel" ? "always" : "conversation";
}

/** Why Microsoft Execution Containers cannot carry agent shells on this host (`mxc-windows.ts`). */
export type SandboxMxcUnavailableReason =
  | "not-windows"
  | "unsupported-arch"
  | "binary-missing"
  | "probe-failed"
  | "tier-unsupported"
  | "request-rejected"
  /** The shipped launcher's sha256 is not the pinned one (`mxc-launcher-pins.json`). */
  | "launcher-mismatch"
  /** Windows PowerShell 5.1 did not start inside a real container on this host. */
  | "powershell-start-failed"
  /**
   * It failed to initialize its UI subsystem (`STATUS_DLL_INIT_FAILED`), which
   * a non-interactive session (a service, SSH) causes: whether it starts for the
   * signed-in user is unverified, so MXC is not claimed.
   */
  | "unverified-session";

/**
 * Windows only: which substrate carries each kind of process this boot, and
 * how strongly their egress is attributed. Sealed at boot, like the gate.
 */
export interface SandboxWindowsSubstrateInfo {
  /** Whether MXC can confine agent shells here, with the stable reason when not. */
  readonly mxc:
    | { readonly state: "available" }
    | { readonly state: "unavailable"; readonly reason: SandboxMxcUnavailableReason };
  /** `major.minor.build.ubr` of the host, for the reason text; null if unread. */
  readonly windowsBuild: string | null;
  /** Whether srt-win (the one-time administrator install) was ready at boot. */
  readonly srtWinReady: boolean;
  /**
   * Bash/PowerShell tool commands: each in its own MXC container (`mxc`), or —
   * with srt-win active and no MXC — as an ordinary process after a per-command
   * approval (`approved-host`), or without the sandbox at all (`none`).
   */
  readonly shells: "mxc" | "approved-host" | "none";
  /** Plugin processes: under srt-win's shared account, or not confined. */
  readonly extensions: "srt-win" | "none";
  readonly shellEgressIdentity: EgressIdentityStrength;
  readonly extensionEgressIdentity: EgressIdentityStrength;
}

/** Runtime snapshot returned to the renderer for startup/runtime honesty. */
export interface SandboxRuntimeCapabilityInfo {
  /** Whether the current process has an active sandbox runner registered. */
  available: boolean;
  /** Runtime confinement strength observed in this process, not platform potential. */
  kind: "full" | "partial" | "none";
  /** Human-readable reason from the runtime SOT. */
  reason: string;
}

/** Capability snapshot returned to the renderer for the settings toggle. */
export interface SandboxCapabilityInfo {
  platform: NodeJS.Platform;
  /** Whether the shell sandbox setting (`features.osToolSandbox`, or its env
   *  escape-hatch `AVE_SANDBOX_ENABLED=1`) is currently enabled. */
  enabled: boolean;
  /** Whether THIS PLATFORM can confine tools (its potential), independent of
   * whether a runner is currently registered — so the toggle can be shown
   * before the user opts in. macOS/Linux/Windows → true, others → false. */
  available: boolean;
  /** The platform's confinement strength ("full" macOS/Linux | "partial" Windows |
   * "none"), derived from the platform, not from a registered runner. */
  kind: "full" | "partial" | "none";
  /** Back-compat summary. Prefer `potentialReason` and `runtime.reason`. */
  reason: string;
  /** Human-readable reason for this platform's potential capability. */
  potentialReason?: string;
  /** What host SHELLS run under in this process (the shell sandbox scope). */
  runtime?: SandboxRuntimeCapabilityInfo;
  /** What EXTENSION processes run under in this process (the plugin-worker
   *  confinement scope). ASRT is one runtime, so either scope can be active
   *  while the other reports none. */
  workerRuntime?: SandboxRuntimeCapabilityInfo;
  /**
   * What the boot gate decided for this process. `null` when boot has not run
   * the gate (tests, or a host that never called sandbox init) — absence is not
   * "off", so the renderer must not render it as such.
   */
  boot?: SandboxBootOutcome | null;
  /**
   * Windows: which substrate carries shells and extensions this boot, and how
   * strongly their egress is attributed. `null` off Windows, and on Windows
   * when boot never ran the gate.
   */
  windowsSubstrate?: SandboxWindowsSubstrateInfo | null;
  /** What the sandbox actually confines on this platform when active. */
  confines: SandboxConfinement;
}

/**
 * Compute the per-platform confinement profile — a pure (no-I/O) mapping of
 * `(platform, kind)` to what is confined. `kind` is authoritative: `"full"`
 * means every dimension is confined, `"partial"` means a known weaker profile,
 * and `"none"` reports nothing confined. Unsupported platforms fail closed even
 * if a non-none kind is passed.
 */
export function sandboxConfinementForPlatform(
  platform: NodeJS.Platform,
  kind: "full" | "partial" | "none",
): SandboxConfinement {
  if (kind === "none") {
    return { filesystem: false, process: false, network: false };
  }
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return { filesystem: false, process: false, network: false };
  }
  if (kind === "full") {
    return { filesystem: true, process: true, network: true };
  }
  if (platform === "win32") {
    // srt-win via ASRT confines filesystem access through the dedicated
    // `srt-sandbox` user ACL backend and confines egress with WFP + loopback
    // proxy routing. Process isolation is still unavailable on Windows, so the
    // substrate remains partial.
    //
    // ASRT 0.0.73 hardened the filesystem half: `srt-win install` now also
    // deny-stamps the stock world-writable system directories (ProgramData,
    // PUBLIC, %SystemRoot%\Temp/Tasks, System32\spool\PRINTERS, the FxsTmp /
    // com\dmp pairs, …) for the sandbox user. Those were ambient write targets
    // no per-exec `--deny-write` ever covered, so `filesystem: true` here is a
    // stronger claim than it was — while `process: false` is unchanged. It is
    // a claim about the host's files, not about one plugin's files against
    // another's: there is one sandbox account for every confined process.
    return { filesystem: true, process: false, network: true };
  }
  // Generic partial profile for any future non-Windows partial backend:
  // filesystem + network may be present, but process isolation is not claimed.
  return { filesystem: true, process: false, network: true };
}
