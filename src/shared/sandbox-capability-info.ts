import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import type { WindowsReadDenyPrincipal } from "./windows-read-deny-evidence.js";

/** Report actual confinement only: full filesystem/process/network on macOS/Linux; filesystem and egress on Windows.
 * Windows uses one sandbox account, so filesystem confinement protects the host and does not isolate plugins from each other. */

/** What the sandbox confines, by platform. `network` is false where egress is not contained. */
import type { AveHomePrincipal, AveHomePrivacyFailureCategory } from "./ave-home.js";

export interface SandboxConfinement {
  filesystem: boolean;
  process: boolean;
  network: boolean;
}

/** Windows readiness requires both the sandbox user and packet filters; shells may independently use containers.
 * Non-Windows or unobservable states are null; instructions preserve the runtime's install text. */
export interface SandboxWindowsStatusInfo {
  /** True only on win32. Non-win32 → false, with null state fields. */
  applicable: boolean;
  /** `absent` | `incomplete` | `ready`, or null when not observed. */
  userState: "absent" | "incomplete" | "ready" | null;
  /** `absent` | `installed` | `cannot-read`, or null when not observed. */
  wfpState: "absent" | "installed" | "cannot-read" | null;
  /** True only without a recorded broad profile read grant, when the sandbox user is ready and WFP is either directly observed as installed or
   * `cannot-read` plus ASRT behavioral egress verification succeeds. Always false off-win32. */
  ready: boolean;
  /** Expected helper resolution or policy refusal; never a provisioning claim. */
  helperError?: "srt-win-not-found" | "srt-win-integrity-mismatch" | "srt-win-profile-read-granted";
  /** Confinement is refused until this private directory verifies at restart. */
  homePrivacyError?: {
    approvedForSession?: boolean;
    path: string;
    category: AveHomePrivacyFailureCategory;
    extraPrincipals?: AveHomePrincipal[];
  };
  profileReadDenyWarnings?: readonly {
    path: string;
    principals?: readonly WindowsReadDenyPrincipal[];
  }[];
  /** Host setup diagnostics and recovery instructions. Empty off-win32. */
  instructions: string;
}

/** Validate gesture before status or elevation; skip elevation when already ready.
 * Successful setup still needs verification; cancellation changes nothing, timeout may leave partial setup, and failures carry stable codes. */
type SandboxWindowsInstallOutcome =
  | "ready"
  | "installed-unverified"
  | "already-ready"
  | "cancelled"
  | "timed-out"
  | "failed";

/** Result of the user-consented Windows install (one self-elevating UAC). `outcome` is always set; the other fields add detail to it. It carries
 * no free-text diagnostic: ASRT's messages hold srt-win output and local paths (including the user name), so they stay in the main-process log. */
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
  | "degrade-ave-home-privacy-failed"
  | "gate-off"
  | "deps-present"
  /** Windows: srt-win not installed, ASRT runs as the proxy for agent shells in MXC containers. */
  | "activate-windows-mxc-proxy-only"
  | "degrade-windows-not-installed"
  /** Windows: the sandbox passed its startup check but failed to start (the cause is in `dependencyErrors`). */
  | "degrade-windows-init-failed"
  | "degrade-default-cannot-activate"
  | "abort-explicit-cannot-activate"
  | "degrade-linux-runtime-probe-failed"
  | "abort-linux-runtime-probe-failed"
  | "degrade-macos-runtime-probe-failed"
  | "abort-macos-runtime-probe-failed";

/** Classify activation causes once for localization; keep free-text dependency diagnostics and local paths in main-process logs.
 * Distinguish missing setup, missing or untrusted helper, missing dependencies, runtime probe failure, and other initialization failures. */
export type SandboxStartFailureCause =
  | "ave-home-privacy-failed"
  | "missing-bwrap"
  | "missing-socat"
  | "missing-ripgrep"
  | "dependency-check-failed"
  | "windows-setup-incomplete"
  | "windows-sandbox-missing"
  | "windows-sandbox-integrity-failed"
  | "linux-runtime-probe-failed"
  | "init-failed";

/** Why the shell sandbox is requested for this session but host shells still run without it: a start failure, a platform without a sandbox, a Windows sandbox that is active
 * but cannot contain one-shot shells, or (`shell-not-contained`) an active sandbox that cannot contain shells at all, in which case shell commands are blocked rather than run. */
export type ShellSandboxUnavailableCause =
  | SandboxStartFailureCause
  | "platform-unsupported"
  | "windows-shell-not-contained"
  | "shell-not-contained";

/** Report requested versus effective shell confinement; setting changes take effect only after restart.
 * Unknown boot state makes no effectiveness claim, and contradictory observations fault only this snapshot row. */
type ShellSandboxState =
  | "on"
  | "off"
  | "unavailable"
  | "pending-on"
  | "pending-off"
  | "unsupported"
  | "unknown"
  | "error";

/** The shell-scope status the sandboxCapability snapshot carries for the permission card. */
export interface ShellSandboxStatusInfo {
  readonly state: ShellSandboxState;
  /** The stored `features.osToolSandbox` value; what the checkbox writes. */
  readonly setting: boolean;
  /** `AVE_SANDBOX_ENABLED=1` turns the shell sandbox on for this run whatever is stored. */
  readonly envForced: boolean;
  /** Non-empty exactly when `state` is `unavailable` or `unsupported`. */
  readonly causes: readonly ShellSandboxUnavailableCause[];
}

/** What {@link describeShellSandboxStatus} reads. Every field is host-observed. */
export interface ShellSandboxStatusInput {
  /** The platform can run an OS sandbox at all (`SandboxCapabilityInfo.available`). */
  readonly platformSupported: boolean;
  readonly setting: boolean;
  readonly envForced: boolean;
  /** The shell intent sealed at boot (`isShellSandboxRequestedAtBoot`). */
  readonly requestedAtBoot: boolean;
  readonly boot: SandboxBootOutcomeView | null;
  /** The route the host shell execution plan selects for a default shell. */
  readonly shellPlanMode: "asrt" | "plain" | "blocked";
  /** That plan's fallback reason. */
  readonly shellPlanFallback:
    | "none"
    | "disabled-by-setting"
    | "platform-unsupported"
    | "windows-partial-shell-acl-unsafe"
    | "requested-sandbox-unavailable"
    | "active-sandbox-not-shell-contained";
}

/** Decide the shell sandbox state from what the host observed. The one place that decides it: the IPC snapshot calls it, the renderer only renders
 * the result. Throws on a combination the boot and plan contracts rule out, so a drift between them fails here rather than showing a made-up state. */
export function describeShellSandboxStatus(input: ShellSandboxStatusInput): ShellSandboxStatusInfo {
  const base = { setting: input.setting, envForced: input.envForced };
  if (!input.platformSupported) {
    return { ...base, state: "unsupported", causes: ["platform-unsupported"] };
  }
  const requestedNow = input.setting || input.envForced;
  if (input.boot === null) return { ...base, state: "unknown", causes: [] };
  // The gate runs once per process, so a setting changed after boot is a restart away from taking effect, whatever the plan says now.
  if (requestedNow && !input.requestedAtBoot) return { ...base, state: "pending-on", causes: [] };
  if (!requestedNow && input.requestedAtBoot) {
    // Pending only when a restart changes something for shells: a sandbox that never contained them (a
    // degraded boot, Windows Plan B) is already off for shells, and saying it "stays on" would be false.
    return { ...base, state: input.shellPlanMode === "asrt" ? "pending-off" : "off", causes: [] };
  }
  if (!requestedNow) return { ...base, state: "off", causes: [] };
  if (input.shellPlanMode === "asrt") return { ...base, state: "on", causes: [] };
  if (input.boot.action === "degrade" || input.boot.action === "abort") {
    if (input.boot.causes.length === 0) {
      throw new Error(`describeShellSandboxStatus: boot ${input.boot.action} (${input.boot.reason}) recorded no cause`);
    }
    return { ...base, state: "unavailable", causes: [...input.boot.causes] };
  }
  if (input.shellPlanFallback === "windows-partial-shell-acl-unsafe") {
    return { ...base, state: "unavailable", causes: ["windows-shell-not-contained"] };
  }
  if (input.shellPlanFallback === "active-sandbox-not-shell-contained") {
    return { ...base, state: "unavailable", causes: ["shell-not-contained"] };
  }
  throw new Error(
    `describeShellSandboxStatus: shell sandbox requested at boot, gate ${input.boot.action}, ` +
      `but the shell plan is ${input.shellPlanMode}/${input.shellPlanFallback}`,
  );
}

/** What the sandbox gate actually decided for THIS process, sealed at boot. The runtime snapshot cannot answer this. When the gate degrades, no capability is ever registered, so the runtime SOT falls back to its "no OS sandbox configured" default; the same answer it gives when the user never
 * turned the sandbox on. Those two states are not the same thing to the person using the app: one is a setting they chose, the other is a setting they chose that did not take effect. Without this, the reason the gate degraded lived only in the boot log, which a packaged app's user has no way to read. */
export interface SandboxBootOutcome {
  readonly action: SandboxGateAction;
  readonly reason: SandboxGateReason;
  /** Which on-signal drove the gate: the env override, the setting, or neither. */
  readonly onSignal: "explicit-env" | "default-settings" | "off";
  /** Why the sandbox could not activate, verbatim from the dependency check; these carry the install command the user has to run. Empty when the gate did not fail on dependencies. */
  readonly dependencyErrors: readonly string[];
  /** The same failure as stable codes, classified once at the gate. Non-empty exactly when `action` is `degrade` or `abort`. */
  readonly causes: readonly SandboxStartFailureCause[];
}

/** The boot outcome as the renderer receives it: everything but the raw dependency messages. Those are ASRT's English free text and can carry local
 * paths (a binary location, the user name), so they stay in the main-process log; `causes` carries the same failure as codes the renderer can localize. */
export type SandboxBootOutcomeView = Omit<SandboxBootOutcome, "dependencyErrors">;

/** Project a sealed boot outcome onto what crosses into the renderer. */
export function sandboxBootOutcomeView(outcome: SandboxBootOutcome): SandboxBootOutcomeView {
  return {
    action: outcome.action,
    reason: outcome.reason,
    onSignal: outcome.onSignal,
    causes: [...outcome.causes],
  };
}

/** How strongly the egress proxy knows which invocation opened a connection. - `kernel-channel`: the OS pins each confined process to its own proxy listener, so the port a connection arrives on names the invocation (Windows MXC per-container WFP;
 * `egress-invocation-listener.ts`). A process cannot present another invocation's identity. - `shared`: confined processes share one proxy endpoint and the identity is a label the client presents (ASRT's proxy username). Attribution, not a boundary between concurrent invocations. */
export type EgressIdentityStrength = "kernel-channel" | "shared";

/** The scopes an egress grant can be given. A shell tool call's card offers Deny plus once, session, project, always (owner 2026-10-25, five-choice network card); a workspace terminal
 * tab's ladder is once, tab, always (`tab` takes the place of `session`: a terminal belongs to no conversation, design F). */
export type EgressGrantScope = "once" | "session" | "tab" | "project" | "always";

/** The widest egress-grant scope an identity strength can carry. With a shared identity another invocation of the same session can present the id a
 * grant was given to, so a grant must not outlive the session it was given in. The egress ask (proxy-egress PR 4) caps the scopes it offers with this. */
export function maxEgressGrantScope(strength: EgressIdentityStrength): EgressGrantScope {
  return strength === "kernel-channel" ? "always" : "session";
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
  /** It failed to initialize its UI subsystem (`STATUS_DLL_INIT_FAILED`), which a non-interactive session
   * (a service, SSH) causes: whether it starts for the signed-in user is unverified, so MXC is not claimed. */
  | "unverified-session";

/** Windows only: which substrate carries each kind of process this boot, and how strongly their egress is attributed. Sealed at boot, like the gate. */
export interface SandboxWindowsSubstrateInfo {
  /** Whether MXC can confine agent shells here, with the stable reason when not. `checking`: the boot-path
   * checks passed and the PowerShell start probe is still running; shells use the non-MXC route until it settles. */
  readonly mxc:
    | { readonly state: "available" }
    | { readonly state: "checking" }
    | { readonly state: "unavailable"; readonly reason: SandboxMxcUnavailableReason };
  /** `major.minor.build.ubr` of the host, for the reason text; null if unread. */
  readonly windowsBuild: string | null;
  /** Whether srt-win (the one-time administrator install) was ready at boot. */
  readonly srtWinReady: boolean;
  /** Bash/PowerShell tool commands: each in its own MXC container (`mxc`), or; with srt-win active and no MXC; as
   * an ordinary process after a per-command approval (`approved-host`), or without the sandbox at all (`none`). */
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
  /** Host-issued default shell route, distinct from the platform potential. */
  shellExecutionPlan?: HostShellExecutionPlanAuditProjection;
  homePrivacyError?: SandboxWindowsStatusInfo["homePrivacyError"];
  profileReadDenyWarnings?: SandboxWindowsStatusInfo["profileReadDenyWarnings"];
  platform: NodeJS.Platform;
  /** Whether the shell sandbox setting (`features.osToolSandbox`, or its env escape-hatch `AVE_SANDBOX_ENABLED=1`) is currently enabled. */
  enabled: boolean;
  /** Whether THIS PLATFORM can confine tools (its potential), independent of whether a runner is currently
   * registered; so the toggle can be shown before the user opts in. macOS/Linux/Windows → true, others → false. */
  available: boolean;
  /** The platform's confinement strength ("full" macOS/Linux | "partial" Windows | "none"), derived from the platform, not from a registered runner. */
  kind: "full" | "partial" | "none";
  /** Back-compat summary. Prefer `potentialReason` and `runtime.reason`. */
  reason: string;
  /** Human-readable reason for this platform's potential capability. */
  potentialReason?: string;
  /** What host SHELLS run under in this process (the shell sandbox scope). */
  runtime?: SandboxRuntimeCapabilityInfo;
  /** What EXTENSION processes run under in this process (the plugin-worker confinement scope). ASRT is one runtime, so either scope can be active while the other reports none. */
  workerRuntime?: SandboxRuntimeCapabilityInfo;
  workerRestartPending: boolean;
  /** What the boot gate decided for this process. `null` when boot has not run the gate (tests, or a host
   * that never called sandbox init); absence is not "off", so the renderer must not render it as such. */
  boot?: SandboxBootOutcomeView | null;
  /** Windows: which substrate carries shells and extensions this boot, and how strongly their egress is attributed. `null` off Windows, and on Windows when boot never ran the gate. */
  windowsSubstrate?: SandboxWindowsSubstrateInfo | null;
  /** The shell sandbox as the chat input's permission card shows it. */
  shell: ShellSandboxStatusInfo;
  /** What the sandbox actually confines on this platform when active. */
  confines: SandboxConfinement;
}

/** Compute the per-platform confinement profile; a pure (no-I/O) mapping of `(platform, kind)` to what is confined. `kind` is authoritative: `"full"` means every
 * dimension is confined, `"partial"` means a known weaker profile, and `"none"` reports nothing confined. Unsupported platforms fail closed even if a non-none kind is passed. */
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
    // Windows confines host filesystem access through account ACLs and egress through packet filters and the proxy.
    // Process isolation and separation between plugins are unavailable because all confined processes share the account.
    return { filesystem: true, process: false, network: true };
  }
  // Generic partial profile for any future non-Windows partial backend: filesystem + network may be present, but process isolation is not claimed.
  return { filesystem: true, process: false, network: true };
}
