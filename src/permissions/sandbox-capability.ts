// Reviewer relaxation requires live OS isolation; none forbids intent-only downgrades from MEDIUM/HIGH to LOW. Inactive gates publish verified none; audit stores the resulting verdict rather than the full capability (docs/architecture/permission-policy-design.md).

import { assertSandboxWindowsExtensionPlan } from "../shared/sandbox-capability-info.js";
import { t } from "../i18n/index.js";
import type { ToolCategory, ToolSource } from "../tools/types.js";
import type {
  SandboxBootOutcome,
  SandboxConfinement,
  SandboxWindowsSubstrateInfo,
  SandboxWindowsExtensionPlan,
} from "../shared/sandbox-capability-info.js";
import {
  buildHostShellExecutionPlan,
  getHostShellExecutionPlanAuditProjection,
  type HostShellExecutionPlan,
  type HostShellExecutionRequest,
  type HostShellExecutionPlanAuditProjection,
} from "./host-shell-execution-plan.js";

// RENDERER-SAFETY: this module is imported by the renderer (ToolApprovalContent uses isWeakSandbox / the types), so it MUST NOT statically import `asrt-sandbox.js` — that package (`@anthropic-ai/sandbox-runtime`) pulls Node built-ins (`fs`/`child_process`/`net`) into the renderer webpack bundle. The "is a server genuinely wrapped" signal therefore comes from the MAIN-process wrapped registry below (only StdioTransport, main-only, populates it) plus the active capability snapshot — never a direct gate call into asrt-sandbox.

export type SandboxKind =
  | "none"
  // OS isolation provided by the Anthropic Sandbox Runtime (ASRT). Backend is bwrap on Linux, Seatbelt on macOS (both full-confine), and srt-win on Windows (filesystem + network, no process isolation). All report as a single `asrt` kind; the per-substrate `confines` field distinguishes full vs partial, which is what sandboxRelaxesCategory reads.
  | "asrt"
  // The invocation executes inside a host-issued disposable Linux guest (the workload broker only — the operator-attested container is same-process and never earns this kind; see DisposableSubstrate), not in this process. The guest owns its filesystem and process tree; the controller host, its profile and its environment are unreachable from it. Network is the guest's own policy and is NOT claimed as confined.
  | "disposable-container"
  // OS-level isolation present but evidence quality is PARTIAL.
  | "partial"
  // Filesystem-only isolation (landlock-only — future-proofing for Linux landlock runner).
  | "fs-only";

// Confidence in the detection result. - "verified" — actively checked (binary present + invocable, OS API reports the process is sandboxed, etc.). - "assumed" — inferred from platform without active probe (used when a probe is expensive or not yet implemented). - "policy-best-effort" — binary confirmed present + executable, but the sandbox profile is a best-effort policy with known bypass paths; enforcement is weaker than "verified". Reserved for a future PARTIAL backend; no current platform reports this (macOS + Linux are verified ASRT). Distinguishes a best-effort policy from "assumed".
export type SandboxConfidence = "verified" | "assumed" | "policy-best-effort";

export interface SandboxCapability {
  kind: SandboxKind;
  confidence: SandboxConfidence;
  // NodeJS.Platform value at detection time. Useful for audit replay.
  platform: NodeJS.Platform;
  // Short human-readable explanation, surfaced to UI + reviewer prompt.
  reason: string;
  // What this capability ACTUALLY confines (filesystem / process / network), for the substrate it describes. Machine-checkable so network honesty is auditable and future per-substrate enforcement can assert against it. Optional so existing callers/fixtures that only assert kind/confidence remain valid; the honest producers (setActiveSandboxCapability publish site + the substrate-aware resolver) populate it. Absence means "not declared" — callers MUST NOT read absence as "all confined".
  confines?: SandboxConfinement;
}

// Only executor-selected broker guests qualify as disposable substrates; never trust tool/wire metadata. Same-process operator containers share controller state, env and process namespace, so they retain host-shell grading.
export interface DisposableSubstrate {
  readonly authority: "workload-broker";
  // Workload identity the brokered route bound to.
  readonly id: string;
}

// Honest capability of a disposable guest. Filesystem and process effects stay inside the guest, so the reviewer may grade them as guest-scoped; network is the guest's own egress and stays unconfined here.
export function disposableContainerCapability(
  substrate: DisposableSubstrate,
): SandboxCapability {
  return {
    kind: "disposable-container",
    confidence: "verified",
    platform: "linux",
    reason: `disposable guest via workload broker (${substrate.id.slice(0, 12)}) — host filesystem, processes and controller environment are unreachable`,
    confines: { filesystem: true, process: true, network: false },
  };
}

// Verified guest whose filesystem and process tree are both disposable.
export function isDisposableSubstrateCapability(
  cap: SandboxCapability | undefined,
): boolean {
  return (
    cap !== undefined &&
    cap.kind === "disposable-container" &&
    cap.confidence === "verified" &&
    cap.confines?.filesystem === true &&
    cap.confines.process === true
  );
}

// Active capability cache. Set by setActiveSandboxCapability when the ASRT sandbox path is initialized at boot. Defaults to `undefined` (the SOT then reports `kind: "none"`).
let _activeCapability: SandboxCapability | undefined;
let _sandboxGeneration = 0;
let _shellSandboxRequestedAtBoot = false;
let _pluginWorkerConfinementRequestedAtBoot = false;
let _bootOutcome: SandboxBootOutcome | null = null;
let _windowsSubstrate: SandboxWindowsSubstrateInfo | null = null;
let _mxcShellCapability: SandboxCapability | undefined;
const _issuedHostShellExecutionPlans = new WeakMap<HostShellExecutionPlan, string>();

// Monotonic identity for capability and wrapped-worker membership changes.
export function getSandboxGeneration(): string {
  return String(_sandboxGeneration);
}

// Store the active sandbox capability after the ASRT sandbox is initialized at boot. Subsequent calls to detectSandboxCapability return this value. @internal — only the boot-time ASRT init path and tests should call this.
export function setActiveSandboxCapability(cap: SandboxCapability): void {
  _activeCapability = cap;
  _sandboxGeneration += 1;
}
// Publish the boot-time SHELL sandbox intent (`features.osToolSandbox` / `AVE_SANDBOX_ENABLED=1`). This is deliberately independent from the live active capability: requested-on-but-degraded and explicit-off both have kind="none", yet the host-shell plan must distinguish them without re-reading mutable renderer settings. It is also what scopes the published ASRT capability to shells: with it off, ASRT may still be active for plugin workers, and detectShellSandboxCapability reports `none`. @internal — only the boot-time sandbox init path and tests should call this.
export function setShellSandboxRequestedAtBoot(requested: boolean): void {
  if (_shellSandboxRequestedAtBoot !== requested) _sandboxGeneration += 1;
  _shellSandboxRequestedAtBoot = requested;
}

// True only when the shell sandbox was requested for this process at boot.
export function isShellSandboxRequestedAtBoot(): boolean {
  return _shellSandboxRequestedAtBoot;
}

// Publish the boot-time PLUGIN-WORKER confinement intent (`features.pluginWorkerConfinement` / `AVE_PLUGIN_WORKER_CONFINEMENT=1`). Sealed once per process like the shell intent, so a worker spawn never re-reads the mutable setting; `isPluginWorkerConfinementActive` in asrt-sandbox.ts combines it with the live ASRT state. @internal — only the boot-time sandbox init path and tests should call this.
export function setPluginWorkerConfinementRequestedAtBoot(requested: boolean): void {
  if (_pluginWorkerConfinementRequestedAtBoot !== requested) _sandboxGeneration += 1;
  _pluginWorkerConfinementRequestedAtBoot = requested;
}

// True only when plugin-worker confinement was requested for this process at boot.
export function isPluginWorkerConfinementRequestedAtBoot(): boolean {
  return _pluginWorkerConfinementRequestedAtBoot;
}

// Record what the boot gate decided. Written once per boot, at the same points that emit the gate's audit event, so the two cannot describe different outcomes. @internal — only the boot-time sandbox init path and tests should call this.
export function setSandboxBootOutcome(outcome: SandboxBootOutcome): void {
  _bootOutcome = Object.freeze({
    ...outcome,
    dependencyErrors: Object.freeze([...outcome.dependencyErrors]),
    causes: Object.freeze([...outcome.causes]),
  });
}

// What the boot gate decided, or `null` if it never ran. `null` is NOT "off": a caller that renders absence as a disabled sandbox would be asserting something this process never established.
export function getSandboxBootOutcome(): SandboxBootOutcome | null {
  return _bootOutcome;
}

// @internal — test teardown only.
export function __resetSandboxBootOutcomeForTest(): void {
  _bootOutcome = null;
}

// Record which substrate carries Windows shells and extensions this boot (`sandbox-init.ts`), and — when MXC carries the agent shells — the capability their host-shell plans get. That capability is published here and NOT through setActiveSandboxCapability: it describes one launch path (Bash/PowerShell tool commands in an MXC container), not the process-wide runtime, so the workspace terminal and the plugin surfaces, which read the process-wide capability, never inherit it. @internal — only the boot-time sandbox init path and tests should call this.
export function setWindowsSandboxSubstrate(
  info: SandboxWindowsSubstrateInfo,
  mxcShellCapability?: SandboxCapability,
): void {
  if (info.shells === "mxc" && mxcShellCapability === undefined) {
    throw new Error("setWindowsSandboxSubstrate: shells run in MXC but no MXC shell capability was given");
  }
  if (info.shells !== "mxc" && mxcShellCapability !== undefined) {
    throw new Error("setWindowsSandboxSubstrate: an MXC shell capability needs shells: \"mxc\"");
  }
  if (info.extensionPlan !== undefined) assertSandboxWindowsExtensionPlan(info.extensionPlan);
  if (!["mxc", "approved-host", "none"].includes(info.shells) || !["mxc", "srt-win", "none"].includes(info.extensions)
      || info.shellEgressIdentity !== (info.shells === "mxc" ? "kernel-channel" : "shared")) {
    throw new Error("setWindowsSandboxSubstrate: invalid substrate or shell egress identity");
  }
  if (info.extensions === "mxc" && (info.extensionPlan?.selectedBackend !== "mxc" || info.extensionPlan.readiness !== "ready")) {
    throw new Error("setWindowsSandboxSubstrate: MXC extensions require dedicated ready request evidence");
  }
  if (info.extensionPlan !== undefined && info.extensionPlan.selectedBackend !== info.extensions) {
    throw new Error("setWindowsSandboxSubstrate: extension plan contradicts the selected substrate");
  }
  if (info.extensionEgressIdentity !== (info.extensions === "mxc" ? "kernel-channel" : "shared")) {
    throw new Error("setWindowsSandboxSubstrate: extension egress identity contradicts the selected substrate");
  }
  _windowsSubstrate = Object.freeze({ ...info, mxc: Object.freeze({ ...info.mxc }),
    ...(info.extensionPlan ? { extensionPlan: Object.freeze({ ...info.extensionPlan }) } : {}),
  });
  _mxcShellCapability = mxcShellCapability === undefined ? undefined : Object.freeze({ ...mxcShellCapability });
  _sandboxGeneration += 1;
}

// What boot recorded for Windows, or null (off Windows, or before the gate ran).
export function getWindowsSandboxSubstrate(): SandboxWindowsSubstrateInfo | null {
  return _windowsSubstrate;
}

/** Selected extension plan; absent records confer no MXC authority. Per-process markers remain mandatory. */
export function getWindowsExtensionBackendPlan(): SandboxWindowsExtensionPlan | undefined {
  return _windowsSubstrate?.extensionPlan;
}

// The capability of a Bash/PowerShell tool command launched in an MXC container, or undefined when that route is not live: MXC carries the shells this boot, the shell sandbox was requested, and the process-wide ASRT runtime (whose proxy the containers reach) is still published.
export function detectMxcShellCapability(): SandboxCapability | undefined {
  if (_mxcShellCapability === undefined || !_shellSandboxRequestedAtBoot) return undefined;
  if (_activeCapability?.kind !== "asrt") return undefined;
  return _mxcShellCapability;
}

// @internal — test teardown only.
export function __resetWindowsSandboxSubstrateForTest(): void {
  if (_windowsSubstrate !== null || _mxcShellCapability !== undefined) _sandboxGeneration += 1;
  _windowsSubstrate = null;
  _mxcShellCapability = undefined;
}

// @internal — test teardown only.
export function __resetSandboxRequestedAtBootForTest(): void {
  if (_shellSandboxRequestedAtBoot || _pluginWorkerConfinementRequestedAtBoot) _sandboxGeneration += 1;
  _shellSandboxRequestedAtBoot = false;
  _pluginWorkerConfinementRequestedAtBoot = false;
}

// Reset the active capability cache. Used by test teardown. @internal
export function __resetActiveSandboxCapabilityForTest(): void {
  if (_activeCapability !== undefined) _sandboxGeneration += 1;
  _activeCapability = undefined;
}

// Detect the OS sandbox ASRT provides in this process. Returns the capability stored by setActiveSandboxCapability when the ASRT sandbox path was initialized at boot. Falls back to kind="none" when no sandbox is active (isolation=none). ASRT activates when EITHER the shell sandbox or plugin-worker confinement was requested, so this describes what a WRAPPED process gets, not that a given substrate is wrapped. Host shells read detectShellSandboxCapability; a worker, plugin child or MCP server reports this only when its own wrapped registry says it was wrapped (resolveReviewerSandboxCapability).
export function detectSandboxCapability(): SandboxCapability {
  if (_activeCapability) {
    return _activeCapability;
  }
  return {
    kind: "none",
    confidence: "verified",
    platform: process.platform,
    reason: "no OS sandbox configured for the host process",
  };
}

// The OS sandbox host shells (bash / powershell tools, the workspace terminal) get: the ASRT capability when the shell sandbox was requested at boot, and `none` otherwise — including when ASRT is active only because plugin-worker confinement is on, since no shell is wrapped then.
export function detectShellSandboxCapability(): SandboxCapability {
  if (_shellSandboxRequestedAtBoot) return detectSandboxCapability();
  return {
    kind: "none",
    confidence: "verified",
    platform: process.platform,
    reason: "shell sandbox not requested at boot (features.osToolSandbox off)",
  };
}
// The OS sandbox extension processes (plugin workers, plugin children, plugin hooks, MCP stdio servers) get when wrapped: the ASRT capability when plugin-worker confinement was requested at boot, `none` otherwise — including when ASRT is active only for the shell sandbox. A per-process claim still needs that process's wrapped registry (resolveReviewerSandboxCapability); this is the scope-level view the settings surface reports.
export function detectPluginWorkerSandboxCapability(): SandboxCapability {
  if (_pluginWorkerConfinementRequestedAtBoot && _windowsSubstrate?.extensions === "mxc") {
    return {
      kind: "none", confidence: "verified", platform: process.platform,
      reason: "container selection requires each extension process's native spawn and transport evidence",
      confines: { filesystem: false, process: false, network: false },
    };
  }
  if (_pluginWorkerConfinementRequestedAtBoot && _windowsSubstrate?.extensions === "none" && _activeCapability !== undefined) {
    // Windows with ASRT running as the MXC shells' proxy only: there is no substrate that confines plugin processes this boot.
    return {
      kind: "none",
      confidence: "verified",
      platform: process.platform,
      reason:
        "extension confinement is unavailable for the selected runtime/request; no per-holder isolation is established",
    };
  }
  if (_pluginWorkerConfinementRequestedAtBoot) return detectSandboxCapability();
  return {
    kind: "none",
    confidence: "verified",
    platform: process.platform,
    reason: "extension confinement not requested at boot (features.pluginWorkerConfinement off)",
  };
}
// Resolve the boot-sealed execution plan for builtin host shell tools. It is intentionally separate from detectSandboxCapability: Windows Plan B selects a plain child and must not present the process-global partial ASRT capability as if it confined that child.
export function getHostShellExecutionPlan(executionMode: HostShellExecutionRequest = "default"): HostShellExecutionPlan {
  const generation = getSandboxGeneration();
  const mxc = detectMxcShellCapability();
  const plan = buildHostShellExecutionPlan({
    platform: process.platform,
    requestedSandbox: isShellSandboxRequestedAtBoot(),
    activeCapability: mxc ?? detectShellSandboxCapability(),
    shellSubstrate: mxc === undefined ? "asrt" : "mxc",
    executionMode,
  });
  _issuedHostShellExecutionPlans.set(plan, generation);
  return plan;
}

// True only for a plan produced by the host's live provider. Shell tools use this to reject structural lookalikes passed by a direct in-process caller.
export function isIssuedHostShellExecutionPlan(
  plan: HostShellExecutionPlan,
): boolean {
  return _issuedHostShellExecutionPlans.has(plan);
}

// Capability generation captured atomically when the host issued this plan.
export function getIssuedHostShellExecutionPlanGeneration(
  plan: HostShellExecutionPlan,
): string | undefined {
  return _issuedHostShellExecutionPlans.get(plan);
}

// Only exact builtin bash/powershell names imply per-command shell wrapping. Do not merge this set with broad shell-name validation or canonical-instance checks; other builtins and loopback plugins run in-process, while external workers need their own live wrap records.
const ASRT_WRAPPED_SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

// External server generations own separate wrap tokens; old exits must not clear replacement markers. Report confinement only with a successful local wrap record and an active verified capability; failed/pre-existing/unwrapped or torn-down workers remain none.
const _wrappedMcpServerOwners = new Map<string, Set<symbol>>();

export type McpWrappedOwner = symbol;

// Record one transport generation of `serverId` as ASRT-wrapped. @internal — only StdioTransport's wrapped-spawn path and tests call this.
export function markMcpServerWrapped(serverId: string): McpWrappedOwner {
  const owner = Symbol(serverId);
  const owners = _wrappedMcpServerOwners.get(serverId);
  if (owners === undefined) {
    _wrappedMcpServerOwners.set(serverId, new Set([owner]));
    _sandboxGeneration += 1;
  } else {
    owners.add(owner);
  }
  return owner;
}

// Drop one transport generation's wrapped marker. Idempotent and owner-scoped. @internal — only StdioTransport and tests call this.
export function unmarkMcpServerWrapped(serverId: string, owner: McpWrappedOwner): void {
  const owners = _wrappedMcpServerOwners.get(serverId);
  if (owners === undefined || !owners.delete(owner)) return;
  if (owners.size === 0) {
    _wrappedMcpServerOwners.delete(serverId);
    _sandboxGeneration += 1;
  }
}

// Whether any live `serverId` transport generation is wrapped through ASRT. @internal — exported for the reviewer resolver + tests.
export function isMcpServerWrapped(serverId: string): boolean {
  return _wrappedMcpServerOwners.has(serverId);
}

// Drop every wrapped-MCP-server marker. Called by resetAsrtSandbox on sandbox teardown so no stale `asrt` signal survives, and by test teardown. @internal
export function clearWrappedMcpServers(): void {
  if (_wrappedMcpServerOwners.size > 0) _sandboxGeneration += 1;
  _wrappedMcpServerOwners.clear();
}

// Reset the wrapped-MCP-server registry. Test teardown only. @internal
export function __resetWrappedMcpServersForTest(): void {
  clearWrappedMcpServers();
}

// Mark plugin workers only after successful local wrapping and clear on exit/stop/failure; registry membership also requires a still-active capability. Global sandbox activation alone never proves this worker is confined.
const _wrappedPluginWorkerIds = new Set<string>();

// Key wrap records by an unambiguous pluginId/workerId pair; worker names alone or delimiter collisions could lend another plugin confinement. Relaxation also needs host-owned tool metadata for a genuinely worker-backed call.
function pluginWorkerKey(pluginId: string, workerId: string): string {
  // Length-prefix the pluginId so the (pluginId, workerId) split is unambiguous for ANY input — the leading `<len>:` fixes where pluginId ends, so even an id containing `:` cannot forge another pair's key: ("a:b","c") → "3:a:b:c" vs ("a","b:c") → "1:a:b:c" differ on the length prefix. Self-contained (does NOT lean on safeSegment stripping the delimiter — this is a no-leak security boundary), and the middle `:` keeps it readable for audit/telemetry.
  return `${pluginId.length}:${pluginId}:${workerId}`;
}

// Record that a plugin worker (`pluginId`/`workerId`) was spawned through the ASRT wrap. @internal — only spawnWorker's wrapped-spawn path and tests call this.
export function markPluginWorkerWrapped(pluginId: string, workerId: string): void {
  const key = pluginWorkerKey(pluginId, workerId);
  if (!_wrappedPluginWorkerIds.has(key)) _sandboxGeneration += 1;
  _wrappedPluginWorkerIds.add(key);
}

// Drop a plugin worker's wrapped marker (worker exited / stopped / wrap failed). Idempotent. @internal — only spawnWorker and tests call this.
export function unmarkPluginWorkerWrapped(pluginId: string, workerId: string): void {
  if (_wrappedPluginWorkerIds.delete(pluginWorkerKey(pluginId, workerId))) {
    _sandboxGeneration += 1;
  }
}

// Whether a plugin worker (`pluginId`/`workerId`) is currently wrapped through ASRT. @internal — exported for the reviewer resolver + tests.
export function isPluginWorkerWrapped(pluginId: string, workerId: string): boolean {
  return _wrappedPluginWorkerIds.has(pluginWorkerKey(pluginId, workerId));
}

// Confined plugin children mark only successful wraps and unmark on failure/exit; verify live capability as well. Bare pluginId is safe only because restart stops/unmarks the sole prior child before replacing it.
const _confinedPluginChildIds = new Set<string>();

// Record that a plugin's out-of-process child was spawned through the ASRT wrap. @internal — only `spawnConfinedPluginChild`'s wrapped path and tests call this.
export function markPluginChildConfined(pluginId: string): void {
  if (!_confinedPluginChildIds.has(pluginId)) _sandboxGeneration += 1;
  _confinedPluginChildIds.add(pluginId);
}

// Drop a plugin's confined-child marker (child exited / spawn failed). Idempotent. @internal — only `spawnConfinedPluginChild` and tests call this.
export function unmarkPluginChildConfined(pluginId: string): void {
  if (_confinedPluginChildIds.delete(pluginId)) {
    _sandboxGeneration += 1;
  }
}

// Whether a plugin's out-of-process child is currently ASRT-confined. @internal — exported for the reviewer resolver + tests.
export function isPluginChildConfined(pluginId: string): boolean {
  return _confinedPluginChildIds.has(pluginId);
}

// Drop every wrapped-plugin-worker marker. Called by resetAsrtSandbox on sandbox teardown so no stale `asrt` signal survives, and by test teardown. @internal
export function clearWrappedPluginWorkers(): void {
  if (_wrappedPluginWorkerIds.size > 0) _sandboxGeneration += 1;
  _wrappedPluginWorkerIds.clear();
}

// Drop every confined-plugin-child marker. Same teardown/no-leak contract as clearWrappedPluginWorkers. @internal
export function clearConfinedPluginChildren(): void {
  if (_confinedPluginChildIds.size > 0) _sandboxGeneration += 1;
  _confinedPluginChildIds.clear();
}

// Reset the wrapped-plugin-worker registry. Test teardown only. @internal
export function __resetWrappedPluginWorkersForTest(): void {
  clearWrappedPluginWorkers();
}

// Resolve the actual per-call substrate, never global capability: exact shell tools use their shell plan; external servers/workers require their own local wrap marker plus live verified runtime. Worker IDs must come from a host-owned descriptor, never manifest metadata.
// Unwrapped/unknown/in-process calls stay none so reviewer relaxation cannot authorize unconfined effects. Broker-selected disposable substrate takes precedence over host-shell and canonical file defaults because that is where effects actually land.
/** A command typed into the user's own host terminal: no confinement of any kind, whatever confines the isolated terminals. */
export const HOST_TERMINAL_SANDBOX_CAPABILITY: SandboxCapability = Object.freeze({
  kind: "none" as const,
  confidence: "verified" as const,
  platform: process.platform,
  reason: "typed into the user's own host terminal; runs with the user's permissions and no isolation",
  confines: Object.freeze({ filesystem: false, process: false, network: false }),
});

// Legacy wrap markers do not establish a native container spawn or transport handshake.
function detectMarkedExtensionCapability(): SandboxCapability {
  return _windowsSubstrate?.extensions === "mxc"
    ? detectPluginWorkerSandboxCapability()
    : detectSandboxCapability();
}

export function resolveReviewerSandboxCapability(
  source: ToolSource,
  toolName: string,
  mcpServerId?: string,
  workerId?: string,
  pluginId?: string,
  hostShellExecutionPlan?: HostShellExecutionPlan,
  disposableSubstrate?: DisposableSubstrate,
): SandboxCapability {
  if (disposableSubstrate !== undefined) {
    return disposableContainerCapability(disposableSubstrate);
  }
  if (source === "builtin" && ASRT_WRAPPED_SHELL_TOOLS.has(toolName)) {
    // The executor seals this plan before any reviewer/cache path. Never recompute a host-shell substrate after it has been selected for an invocation; an ASRT teardown must become a fail-closed execution error, not a reviewer verdict for a different late fallback.
    return hostShellExecutionPlan?.capability ?? getHostShellExecutionPlan().capability;
  }
  // Terminal commands qualify only while live shell capability proves confinement. Their policy was fixed at PTY spawn: later directory/network changes do not update the running jail even when capability kind remains the same.
  if (source === "builtin" && toolName === "terminal_run" && isActiveSandboxShellContained()) {
    const active = detectSandboxCapability();
    if (active.kind === "asrt") {
      return { ...active, reason: `workspace terminal shell ASRT-wrapped — ${active.reason}` };
    }
  }
  // Worker relaxation needs both its own successful local wrap marker and the still-live verified capability; failure/exit/teardown must return none.
  if (
    source === "plugin" &&
    pluginId !== undefined &&
    workerId !== undefined &&
    isPluginWorkerWrapped(pluginId, workerId)
  ) {
    const active = detectMarkedExtensionCapability();
    if (active.kind === "asrt") {
      return {
        ...active,
        reason: `plugin worker '${pluginId}/${workerId}' ASRT-wrapped — ${active.reason}`,
      };
    }
  }
  // An admitted OUT-OF-PROCESS plugin executes every tool inside its one host-spawned ASRT-confined child (`spawnConfinedPluginChild`) — no workerId exists on those Tool descriptors because the substrate is the plugin child itself, keyed by pluginId. Same TWO main-process-only signals as the branches around it: (1) the pluginId is in the confined-child registry (populated only by the confined spawn's wrapped path, cleared on exit/failure/teardown); (2) the active capability is a genuine verified `asrt`. Both must hold (no-leak). The wrapped-worker branch above stays first so a worker-backed call keeps its more specific reason string.
  if (
    source === "plugin" &&
    pluginId !== undefined &&
    isPluginChildConfined(pluginId)
  ) {
    const active = detectMarkedExtensionCapability();
    if (active.kind === "asrt") {
      return {
        ...active,
        reason: `plugin child '${pluginId}' ASRT-confined — ${active.reason}`,
      };
    }
  }
  // External server confinement needs both its successful local wrap record and the still-live verified published capability; teardown or missing markers returns none without renderer-unsafe runtime imports.
  if (source === "mcp" && mcpServerId !== undefined && isMcpServerWrapped(mcpServerId)) {
    const active = detectMarkedExtensionCapability();
    if (active.kind === "asrt") {
      return {
        ...active,
        reason: `external MCP stdio worker '${mcpServerId}' ASRT-wrapped — ${active.reason}`,
      };
    }
  }
  return {
    kind: "none",
    confidence: "verified",
    platform: process.platform,
    reason:
      source === "builtin"
        ? "in-process builtin tool — not ASRT-wrapped (isolation=none)"
        : "plugin/MCP worker not ASRT-wrapped (isolation=none)",
    confines: { filesystem: false, process: false, network: false },
  };
}

export interface ReviewerSandboxCacheState {
  readonly source: ToolSource;
  readonly substrate:
    | "host-shell"
    | "plugin-worker"
    | "mcp-worker"
    | "in-process"
    | "disposable-container";
  readonly wrapped: boolean;
  readonly mcpServerId?: string;
  readonly pluginId?: string;
  readonly workerId?: string;
  // Present only for a canonical builtin shell with a host-sealed plan.
  readonly hostShellExecutionPlan?: HostShellExecutionPlanAuditProjection;
  // Present only when the executor routed the call to a disposable guest.
  readonly disposableSubstrate?: DisposableSubstrate;
  readonly capability: {
    readonly kind: SandboxKind;
    readonly confidence: SandboxConfidence;
    readonly reason: string;
    readonly platform: NodeJS.Platform;
    readonly confines?: SandboxConfinement;
  };
}

// Cache-invalidation identity for reviewer sandbox composition. The reviewer cache may store a verdict relaxed because a long-lived MCP or plugin worker is ASRT-wrapped. That relaxation is valid only while the exact worker remains wrapped in THIS process. Fold the live wrap marker into the invalidation key so an un-wrap turns the previous relaxed verdict stale before any future producer can make plugin-worker relaxation live.
export function resolveReviewerSandboxCacheState(
  source: ToolSource,
  toolName: string,
  mcpServerId?: string,
  workerId?: string,
  pluginId?: string,
  hostShellExecutionPlan?: HostShellExecutionPlan,
  disposableSubstrate?: DisposableSubstrate,
): ReviewerSandboxCacheState {
  const capability = resolveReviewerSandboxCapability(
    source,
    toolName,
    mcpServerId,
    workerId,
    pluginId,
    hostShellExecutionPlan,
    disposableSubstrate,
  );
  const hostShellExecutionPlanAudit =
    source === "builtin" &&
    ASRT_WRAPPED_SHELL_TOOLS.has(toolName) &&
    hostShellExecutionPlan !== undefined
      ? getHostShellExecutionPlanAuditProjection(hostShellExecutionPlan)
      : undefined;
  const substrate = (() => {
    if (disposableSubstrate !== undefined) return "disposable-container" as const;
    if (source === "builtin" && ASRT_WRAPPED_SHELL_TOOLS.has(toolName)) {
      return "host-shell" as const;
    }
    if (source === "mcp") return "mcp-worker" as const;
    if (source === "plugin") return "plugin-worker" as const;
    return "in-process" as const;
  })();
  const wrapped =
    substrate === "host-shell"
      ? hostShellExecutionPlan !== undefined
        ? hostShellExecutionPlan.mode === "asrt"
        : capability.kind === "asrt"
      : substrate === "mcp-worker" && mcpServerId !== undefined
        ? isMcpServerWrapped(mcpServerId) && capability.kind === "asrt"
        : substrate === "plugin-worker" && pluginId !== undefined && workerId !== undefined
          ? isPluginWorkerWrapped(pluginId, workerId) && capability.kind === "asrt"
          : false;

  return {
    source,
    substrate,
    wrapped,
    ...(mcpServerId !== undefined ? { mcpServerId } : {}),
    ...(pluginId !== undefined ? { pluginId } : {}),
    ...(workerId !== undefined ? { workerId } : {}),
    ...(hostShellExecutionPlanAudit === undefined
      ? {}
      : { hostShellExecutionPlan: hostShellExecutionPlanAudit }),
    ...(disposableSubstrate === undefined ? {} : { disposableSubstrate }),
    capability: {
      kind: capability.kind,
      confidence: capability.confidence,
      reason: capability.reason,
      platform: capability.platform,
      ...(capability.confines !== undefined ? { confines: capability.confines } : {}),
    },
  };
}

// Keep prompt capability text stable for audit and expose per-dimension limits; filesystem/network isolation alone cannot justify shell relaxation without process isolation. Omit dimensions only when absent on the capability.
export function formatSandboxCapabilityForPrompt(capability: SandboxCapability): string {
  const kindLabel = (() => {
    switch (capability.kind) {
      case "none":         return "none";
      case "asrt":         return "asrt";
      case "disposable-container": return "disposable-container";
      case "partial":      return t("be_sandboxCapability.partialLabel");
      case "fs-only":      return t("be_sandboxCapability.fsOnlyLabel");
      default: {
        // Exhaustive check — if a new SandboxKind is added without updating this switch, the TypeScript compiler will report an error here.
        const _exhaustive: never = capability.kind;
        return _exhaustive;
      }
    }
  })();
  const confinesLabel = capability.confines
    ? ` confines[net:${capability.confines.network ? "✓" : "✗"} ` +
      `fs:${capability.confines.filesystem ? "✓" : "✗"} ` +
      `proc:${capability.confines.process ? "✓" : "✗"}]`
    : "";
  return (
    `executionSandbox=${kindLabel} (${capability.confidence}, ${capability.platform})` +
    `${confinesLabel} — ${capability.reason}`
  );
}

// Returns true when the capability is "weak" — i.e. the LLM reviewer MUST NOT downgrade a rule-based MEDIUM/HIGH verdict to LOW on this invocation. Centralised here so the reviewer + audit + UI agree. - `kind === "none"` → weak (no isolation) - `kind === "partial"` → weak (partial isolation = evidence gap) - `confidence === "assumed"` → weak (unverified isolation = no isolation) `fs-only` is NOT weak — it is strong-for-fs. The composition rule handles network egress separately for fs-only runners. Anything else (verified `asrt`) is "strong".
export function isWeakSandbox(cap: SandboxCapability): boolean {
  if (cap.kind === "none") return true;
  if (cap.kind === "partial") return true;
  if (cap.confidence === "assumed") return true;
  return false;
}

// Relax only the dimension covering the category: network needs network isolation, read/write/meta need filesystem, shell needs filesystem plus process. Partial confinement cannot inherit full-runtime relaxation.
export function sandboxRelaxesCategory(
  cap: SandboxCapability,
  category: ToolCategory,
): boolean {
  // none/partial/assumed never relax — unchanged from the binary gate.
  if (isWeakSandbox(cap)) return false;
  // LEGACY: a verified non-none capability WITHOUT a declared `confines` field keeps the old all-or-nothing behaviour, so existing fixtures and mac/linux-verified ASRT (published with full confines) are unaffected.
  if (!cap.confines) return true;
  if (category === "network") return cap.confines.network === true;
  if (category === "shell") {
    return cap.confines.filesystem === true && cap.confines.process === true;
  }
  // write / read / meta — filesystem-bearing effects.
  return cap.confines.filesystem === true;
}

// Foreground plugin relaxation requires filesystem containment because off-API writes lose their pre-exec ask; active-runtime status alone is insufficient. This is the shell snapshot only, so workers need narrower proofs; read published state without importing main-only runtime dependencies.
export function isActiveSandboxFilesystemContained(): boolean {
  return detectShellSandboxCapability().confines?.filesystem === true;
}

// Whether the active sandbox is strong enough for an arbitrary interactive shell surface. A shell can create subprocesses and persistence hooks, so it follows the same category rule as sandboxRelaxesCategory: filesystem AND process confinement must both be true.
export function isActiveSandboxShellContained(): boolean {
  return sandboxRelaxesCategory(detectShellSandboxCapability(), "shell");
}

export interface PluginEffectContainmentLookup {
  readonly source?: ToolSource;
  readonly name?: string;
  readonly toolName?: string;
  readonly pluginId?: string;
  readonly workerId?: string;
}

// Whether the foreground plugin effect-boundary can stand in for the removed pre-exec ask for THIS plugin tool call. The generic host-shell capability is deliberately not enough here. Plugin effect-boundary relaxation is valid only when the call is tied to a host-owned `Tool.workerId` and that exact `pluginId/workerId` is currently marked as ASRT-wrapped by spawnWorker. This keeps ordinary in-process plugin tools on the pre-exec ask path until their execution substrate is actually worker-backed.
export function isActiveSandboxFilesystemContainedForPluginEffects(
  input?: PluginEffectContainmentLookup,
): boolean {
  if (input?.source !== "plugin" || !input.pluginId || !input.workerId) {
    return false;
  }
  const capability = resolveReviewerSandboxCapability(
    "plugin",
    input.toolName ?? input.name ?? "",
    undefined,
    input.workerId,
    input.pluginId,
  );
  return sandboxRelaxesCategory(capability, "read");
}
