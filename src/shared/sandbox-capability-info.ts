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
  | "degrade-windows-not-installed"
  | "degrade-default-cannot-activate"
  | "abort-explicit-cannot-activate"
  | "degrade-linux-runtime-probe-failed"
  | "abort-linux-runtime-probe-failed";

/**
 * Why a requested sandbox did not start, as a stable code the renderer can
 * localize. ASRT's own dependency messages are English free text that can carry
 * local paths, so they stay in the main-process log; boot classifies them once
 * ({@link SandboxBootOutcome.causes}) and every surface renders the code.
 * - `missing-bwrap` / `missing-socat` / `missing-ripgrep`: a Linux dependency
 *   is not installed or not executable.
 * - `dependency-check-failed`: the dependency check failed for a reason ASRT
 *   did not name as one of the above (for example running as root).
 * - `windows-setup-incomplete`: the srt-win sandbox user or WFP filters are
 *   not ready — the one-time administrator setup has not completed.
 * - `linux-runtime-probe-failed`: the dependencies are present but the bwrap
 *   runtime probe failed (for example user namespaces are disabled).
 * - `init-failed`: ASRT failed to start for any other reason.
 */
export type SandboxStartFailureCause =
  | "missing-bwrap"
  | "missing-socat"
  | "missing-ripgrep"
  | "dependency-check-failed"
  | "windows-setup-incomplete"
  | "linux-runtime-probe-failed"
  | "init-failed";

/**
 * Why the shell sandbox is requested for this session but host shells still
 * run without it: a start failure, a platform without a sandbox, or a Windows
 * sandbox that is active but cannot contain one-shot shells.
 */
export type ShellSandboxUnavailableCause =
  | SandboxStartFailureCause
  | "platform-unsupported"
  | "windows-shell-not-contained"
  | "shell-not-contained";

/**
 * The shell sandbox as the chat input's permission card shows it.
 * - `on`: requested, and host shells run inside the sandbox this session.
 * - `off`: not requested, and nothing is waiting for a restart.
 * - `unavailable`: requested this session, but shells run without it;
 *   `causes` says why.
 * - `pending-on` / `pending-off`: the setting changed after startup. The
 *   sandbox is initialized once at boot, so the change applies on the next
 *   start and this session keeps the state it booted with. Turning off a
 *   sandbox that never contained shells this session is plain `off`.
 * - `unsupported`: this platform has no OS sandbox.
 * - `unknown`: the boot gate has not run in this process, so nothing about
 *   effectiveness can be claimed.
 */
type ShellSandboxState =
  | "on"
  | "off"
  | "unavailable"
  | "pending-on"
  | "pending-off"
  | "unsupported"
  | "unknown";

/** The shell-scope status the sandboxCapability snapshot carries for the permission card. */
export interface ShellSandboxStatusInfo {
  readonly state: ShellSandboxState;
  /** The stored `features.osToolSandbox` value — what the checkbox writes. */
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
  readonly boot: SandboxBootOutcome | null;
  /** The route the host shell execution plan selects for a default shell. */
  readonly shellPlanMode: "asrt" | "plain" | "blocked";
  /** That plan's fallback reason. */
  readonly shellPlanFallback:
    | "none"
    | "windows-partial-shell-acl-unsafe"
    | "requested-sandbox-unavailable"
    | "active-sandbox-not-shell-contained";
}

/**
 * Decide the shell sandbox state from what the host observed. The one place
 * that decides it: the IPC snapshot calls it, the renderer only renders the
 * result. Throws on a combination the boot and plan contracts rule out, so a
 * drift between them fails here rather than showing a made-up state.
 */
export function describeShellSandboxStatus(input: ShellSandboxStatusInput): ShellSandboxStatusInfo {
  const base = { setting: input.setting, envForced: input.envForced };
  if (!input.platformSupported) {
    return { ...base, state: "unsupported", causes: ["platform-unsupported"] };
  }
  const requestedNow = input.setting || input.envForced;
  if (input.boot === null) return { ...base, state: "unknown", causes: [] };
  // The gate runs once per process, so a setting changed after boot is a
  // restart away from taking effect, whatever the plan says now.
  if (requestedNow && !input.requestedAtBoot) return { ...base, state: "pending-on", causes: [] };
  if (!requestedNow && input.requestedAtBoot) {
    // Pending only when a restart changes something for shells: a sandbox
    // that never contained them (a degraded boot, Windows Plan B) is already
    // off for shells, and saying it "stays on" would be false.
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
  /**
   * The same failure as stable codes, classified once at the gate. Non-empty
   * exactly when `action` is `degrade` or `abort`.
   */
  readonly causes: readonly SandboxStartFailureCause[];
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
  /** The shell sandbox as the chat input's permission card shows it. */
  shell: ShellSandboxStatusInfo;
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
