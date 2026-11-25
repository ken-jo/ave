

import { MxcExtensionReadinessRefusedError, MxcNativeEntryRequiredError, MxcProcessContractError, WorkerTransportUnsupportedError } from "./mxc-extension-errors.js";
import { assertMxcExtensionFilesystemOwnership, type MxcExtensionFilesystemOwnership } from "./mxc-filesystem-ownership.js";
import { mxcRuntimeRootFloorPath } from "./mxc-runtime-root.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, type PolicyFloorRow, type PolicyGrantRow, type PolicyModel } from "./policy-model.js";
import { srtWriteFloorRow, toSrtConfig } from "./srt-policy-adapter.js";
import { issueFilesystemSandboxBlock, type SandboxBlock } from "../shared/sandbox-block.js";
import { buildLauncherEnvironment } from "./launcher-environment.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { hostScriptWriteDenyPaths } from "../main/host-script-runtime.js";
import { normalizePathForSandbox } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { containsGlobChars, containsGlobCharsWin, expandWindowsEnvRefs, globPatternBaseDir, isUncPath, stripExtendedPathPrefix, toForwardSlashes } from "./sandbox-path-spelling.js";
import { existingWindowsGrants, pinWindowsFilesystemConfig, windowsPinnedPaths } from "./windows-stamp-targets.js";
import { assertWindowsGrantGrammar, pinWindowsGrantTargets } from "./windows-grant-targets.js";
import { assertWindowsAclPolicyBudget, expandWindowsAclDenyLists, expandWindowsFsPaths, setWindowsAclRecoveryListener, WindowsSandboxError, type WindowsAclRecoveryReport } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { readAsrtSignalReleaseClaim } from "./asrt-signal-ownership.js";
import { getSrtWinArchitecture, markSrtWinRuntimeReleased, markSrtWinRuntimeReleasePending, prepareSrtWinExecutable, srtWinPrivateDirectories } from "./srt-win-integrity.js";
import { noteConfinedProcessesMayRun } from "../lib/confined-process-phase.js";
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { listAuthorizedWorkspaceRoots } from "./workspace-authorized-roots.js";
import { createRequire } from "node:module";
import { type AveHomeBoundarySnapshot, currentAveHomeBoundarySnapshot, inAveHomeBoundarySnapshot } from "./ave-home-boundary-snapshot.js";
import { EOL, homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { admitWindowsReparse, pinWindowsPaths, windowsObjectKey, windowsPathKey, type WindowsPathFacts } from "../shared/windows-path-facts.js";
import { isHomeAnchor, policyHomeAnchors } from "../shared/policy-home.js";
import { aveHome, assertAveHomePrivacyForConfinement, getAveHomePrivacyFailure, isAveHomePrivacyApprovable, AVE_HOME_BOUNDARY_UNVERIFIED_ERROR_CODE } from "../shared/ave-home.js";
import {
  ExtensionStartConsentRequiredError, isExtensionStartConsentRequired, presentExtensionStartConsent,
  type ExtensionStartPresentation, type ExtensionStartRecheck,
} from "./extension-start-consent.js";
import { agentPluginDataRoot } from "../marketplace/content/agent-plugin-data.js";
import { AVE_HOME_ISOLATION_GUARD_ACTIVE, checkSandboxStampTargets, testSandboxPrivateBase } from "../shared/ave-home-test-guard.js";
import { expandLeadingTilde, leadingTildeHome } from "../shared/home-tilde.js";
import { holdSandboxGitWrites, setHostGitWorkspaceGuard } from "../shared/host-git.js";
import { projectLocalWindowsFilesystemPath, resolvePhysicalFilesystemPath } from "../shared/shell-filesystem-path.js";
import { compileGlobMatcher, globMatch } from "../lib/glob-matcher.js";
import { llmRouteBaseUrls } from "../shared/llm-vendor-defaults.js";
import { isAveHomeReadReallowed } from "./ave-home-read-boundary.js";
import { isBoundStageWorkspacePath } from "./stage-workspace-binding.js";
import { canonicalizePathForMatch, caseFoldForMatch, getConfiguredSessionReadPolicy, getRuntimeSensitiveKeyPaths, MAX_WALK_UP, resolvePathForPolicy, SENSITIVE_PATH_ENTRIES, sensitiveEntryOnSandboxFloor } from "./sensitive-paths.js";
import { hardenLinuxSandboxWrap } from "./linux-sandbox-wrap.js";
import { assertMacSandboxWrapperSize, hardenMacSandboxGitMetadata } from "./macos-sandbox-wrap.js";
import { prepareSandboxBareRepositoryCleanup } from "./sandbox-bare-repository-cleanup.js";
import { createLogger } from "../lib/logger.js";
import { createSerialQueue } from "../lib/with-file-lock.js";
import { errorMessage } from "../shared/error-message.js";
import { findHostProgram, hostProgramSearchDirectories } from "../shared/host-program-path.js";
import { t } from "../i18n/index.js";
import { hostDirectoryFloorPierces } from "../plugins/sandbox-authority.js";
import { resolvePluginPaths } from "../plugins/plugin-paths.js";
import { assertSandboxWritePolicySize, buildMandatorySandboxWritePolicy, compactSandboxWriteDenies, isGrantPathWithin, restrictSandboxGitControlSnapshot, type SandboxGitControlSnapshot, windowsDenyOperandKey } from "./sandbox-write-policy.js";
export { isGrantPathWithin } from "./sandbox-write-policy.js";
import { egressInvocationOwner, onEgressInvocationReleased, openEgressInvocation } from "./egress-invocations.js";
import {
  closeAllEgressRelayConnections,
  closeEgressRelayConnections,
  egressRelayOwnsKey,
  isEgressRelayListener,
  egressRelayViolationLines,
  startEgressRelayService,
  stopEgressRelayService,
  subscribeEgressRelayViolations,
} from "./egress-relay/relay.js";
import { asrtInvocationListenersSupported, noteAsrtUnixSocketPolicy } from "./egress-identity.js";
import {
  getWindowsExtensionBackendPlan,
  isPluginWorkerConfinementRequestedAtBoot,
  isShellSandboxRequestedAtBoot,
} from "./sandbox-capability.js";
import { defaultHooksDir } from "../hooks/hook-discovery.js";
import { readWindowsReadDenyEvidence, recheckWindowsReadDenyEvidence, windowsReadDenyEvidence, windowsReadDenyKey, type WindowsReadDenyEvidence, type WindowsReadDenySnapshot } from "../shared/windows-read-deny-evidence.js";
import type { SandboxWindowsStatusInfo } from "../shared/sandbox-capability-info.js";
import { readWindowsDenyAcls, WINDOWS_READ_DENY_MASK, WINDOWS_WRITE_DENY_MASK } from "./windows-deny-acl.js";
import { isWatchedWorkspaceConsumable, placeholderLeftovers, pruneWatchedRows, resetWatchedRows, sweepWatchedRows, watchAbsentProtectedRow, watchedProtectedRows } from "./windows-watched-rows.js";

import type {
  SandboxRuntimeConfig,
  NetworkConfig,
  FilesystemConfig,
  FilesystemPathEntry,
  WindowsConfig,
  WindowsBinShell,
  SandboxAskCallback,
  ParentProxyRouter,
} from "@anthropic-ai/sandbox-runtime";

const log = createLogger("asrt-sandbox");
// Platform simulation must not turn a non-native host into a native helper host.
const HOST_PLATFORM = process.platform;

// Install-time proxy permits and runtime bind ports must use this same range or all egress fails. Mirror the package constant to avoid static bundling that breaks binary resolution; a drift test pins equality.
export const DEFAULT_WINDOWS_PROXY_PORT_RANGE: readonly [number, number] = [
  60080, 60089,
];

// Binary and ACL payload paths share the app.asar -> app.asar.unpacked rewrite; virtual archive paths are not executable on disk. Development paths remain unchanged.
const APP_ASAR_PATH_SEGMENT = /(^|[\\/])app\.asar(?=$|[\\/])/i;

export function rewriteAsarPathToUnpacked(pathValue: string): string {
  return pathValue.replace(APP_ASAR_PATH_SEGMENT, "$1app.asar.unpacked");
}

// Every initialization, dependency and grant helper must receive the explicit trusted binary path; implicit resolution could execute a planted workspace broker. Resolve the unpacked architecture payload synchronously and pin layout equality with the package export.
export function getVendoredSrtWinExePath(): string {
  const packageJson = createRequire(import.meta.url).resolve(
    "@anthropic-ai/sandbox-runtime/package.json",
  );
  const root = rewriteAsarPathToUnpacked(dirname(packageJson));
  const arch = getSrtWinArchitecture();
  return join(root, "vendor", "srt-win", arch, "srt-win.exe");
}

// The verified private execution image; the package path is never executed.
export function getVerifiedSrtWinExePath(): string {
  return prepareSrtWinExecutable(getVendoredSrtWinExePath());
}

// ASRT's vendored seccomp arch directories (`getVendorArchitecture`); ia32 and others have none.
const SECCOMP_VENDOR_ARCH: Partial<Record<string, string>> = { x64: "x64", arm64: "arm64" };

// The seccomp helper must be executable and visible inside the namespace even under read denies. Canonicalize its unpacked disk path so execution and read grants agree; virtual archive existence is insufficient. Unsupported/missing helpers return undefined with a one-time warning, and capability requires a successful native probe.
export function getVendoredApplySeccompPath(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const arch = SECCOMP_VENDOR_ARCH[process.arch];
  if (arch === undefined) return undefined;
  const packageJson = createRequire(import.meta.url).resolve(
    "@anthropic-ai/sandbox-runtime/package.json",
  );
  const root = rewriteAsarPathToUnpacked(dirname(packageJson));
  const path = join(root, "vendor", "seccomp", arch, "apply-seccomp");
  let real: string;
  try {
    real = realpathSync(path);
  } catch (error) {
    warnSeccompHelperUnavailable(`unreadable (${(error as NodeJS.ErrnoException).code ?? "error"}): ${path}`);
    return undefined;
  }
  if (!lstatSync(real).isFile()) {
    warnSeccompHelperUnavailable(`not a file: ${real}`);
    return undefined;
  }
  return real;
}

let seccompHelperWarned = false;

// Report missing Unix socket filtering once before capability verification fails.
function warnSeccompHelperUnavailable(detail: string): void {
  if (seccompHelperWarned) return;
  seccompHelperWarned = true;
  log.warn(
    `[sandbox-seccomp-unavailable] Vendored apply-seccomp helper is ${detail}; ` +
      "Linux sandbox capability remains unavailable without Unix socket filtering",
  );
}

// The seccomp helper file when one of a wrap's configured read denies would hide it, else `undefined` (always off Linux). The wrap then re-allows exactly that file, which ASRT emits as one `--ro-bind` of itself inside the deny's tmpfs — never its directory or the package.
function seccompHelperHiddenBy(denyRead: readonly string[]): string | undefined {
  const helper = getVendoredApplySeccompPath();
  if (helper === undefined) return undefined;
  const canonical = canonicalizePathForMatch(helper);
  return denyRead.some((denied) => readDenyCoversPath(denied, canonical)) ? helper : undefined;
}

// Resolve the external JVM's agent from the physical packaged payload.
export function getVendoredJavaProxyAgentJarPath(): string {
  const packageJson = createRequire(import.meta.url).resolve(
    "@anthropic-ai/sandbox-runtime/package.json",
  );
  const root = rewriteAsarPathToUnpacked(dirname(packageJson));
  const path = join(root, "vendor", "java-proxy-agent", "srt-proxy-agent.jar");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error("[sandbox-java-agent-unavailable] Packaged JVM proxy agent is missing or invalid");
  }
  return path;
}

// Only trusted host/user settings may enable weakening flags; never source them from manifests, project config or servers. Keep allowedDomains empty with strict mode off so every connection reaches its attributed ask policy; global domains bypass asks for all processes. Weak network isolation can exfiltrate through trust services, and all-socket access removes socket scoping.
export interface TrustedSandboxSettings {
  // Domains every sandboxed process may reach without the ask callback. Boot passes none (see the note above); with `strictAllowlist: true` any other host is hard-denied before the callback is consulted.
  readonly allowedDomains?: readonly string[];
  // Domains explicitly denied (takes precedence over allow).
  readonly deniedDomains?: readonly string[];
  // Enforce the allow-list strictly (no implicit infra domains).
  readonly strictAllowlist?: boolean;
  // Paths the child may read.
  readonly allowRead?: readonly string[];
  // Paths the child is denied reading (takes precedence).
  readonly denyRead?: readonly string[];
  // Paths the child may write.
  readonly allowWrite?: readonly string[];
  // Paths the child is denied writing (takes precedence).
  readonly denyWrite?: readonly FilesystemPathEntry[];
  // macOS-only: directories whose Unix-domain sockets the child may bind / connect (emitted as `network.allowUnixSockets`, the seatbelt `(subpath <dir>)` allow). The worker-UDS control channel uses this — see the WORKER UDS header. TRUSTED-ONLY: host-allocated worker control-socket dirs, never a plugin-supplied value. Ignored on Linux (seccomp is path-blind — the `allowAllUnixSockets` weakening + the `--bind` of the writable dir apply instead) and on Windows (no UDS primitive). Maintained additively at runtime via registerWorkerUnixSocketDir.
  readonly allowUnixSocketDirs?: readonly string[];
  // Sandbox-weakening flags. TRUSTED-ONLY (see the trust-boundary note above). Never wire a plugin/project-config path to any field in this object.
  readonly weakening?: {
    readonly allowAppleEvents?: boolean;
    readonly enableWeakerNetworkIsolation?: boolean;
    readonly allowAllUnixSockets?: boolean;
  };
  // Set both parent proxy values explicitly: empty strings enforce direct connection, while undefined fields or {} inherit ambient host proxy variables. Only explicit trusted URLs may opt into chaining.
  readonly upstreamProxy?: {
    readonly http?: string;
    readonly https?: string;
    readonly noProxy?: string;
    // Trust an upstream proxy that runs on this host (cntlm, px, …) to resolve names this host cannot. Off (the default), such a name is refused, with a reason saying so: a proxy on this host resolves the name itself after Ave's check and could connect back to this host (DNS rebinding). On, the name is forwarded like to a remote upstream and treated as unverified (at most This conversation) — accepting that residual risk. A remote upstream always gets that treatment; names this host resolves are pinned either way. TRUSTED-ONLY, like the URLs.
    readonly resolvesNames?: boolean;
  };
  // The per-destination route hook (carried ASRT patch part 4, `SandboxManager.setParentProxyRouter`). TRUSTED-ONLY. When present it replaces upstreamProxy for routing: ASRT asks it once per destination decision and dials over the answered routes in order. Boot passes the router built from the main-owned `upstreamProxy` setting (`src/permissions/upstream-proxy.ts`); the static `parentProxy` stays the explicit-empty floor, so the ambient environment is never inherited by ASRT itself.
  readonly upstreamRouter?: ParentProxyRouter;
  // Windows-only sandbox settings (srt-win network backend). TRUSTED-ONLY — the proxy port range must agree with what the install flow WFP-permits. `proxyPortRange`: the loopback PERMIT range srt-win's egress proxy binds. Defaults to DEFAULT_WINDOWS_PROXY_PORT_RANGE when omitted (which is also what the install WFP-permits by default), so the proxy bind range always matches the WFP rule. Set explicitly only when an enterprise install used a non-default range. Has no effect off win32.
  readonly windows?: {
    readonly proxyPortRange?: readonly [number, number];
    /** Start the proxy first and prepare session isolation concurrently. */
    readonly backgroundInitialization?: boolean;
    // Start the proxy for commands confined by another substrate. Native wraps refuse and confinement gates stay off in this mode.
    readonly externalConfinement?: boolean;
  };
  // The REAL Electron `app.getPath("userData")` for this process, threaded in from a TRUSTED main-process caller (boot.ts) that CAN import `electron`. When present: this EXACT path is denied (handles `--user-data-dir`, XDG_CONFIG_HOME, and future productName changes correctly). When absent: getDefaultSensitiveReadDenyPaths falls back to a per-platform os.homedir + literal derivation so there is always SOME coverage even without the threaded value (e.g. the mcp-client wrap path). do NOT derive this from plugin manifests, project config, or any untrusted source — only from `electron.app.getPath("userData")` in the main process.
  readonly userDataDir?: string;
  // Trusted host lookup for the current user's Documents known folder.
  readonly resolveWindowsDocumentsPath?: () => string;
}

// Per-command config may contain only filesystem scoping, never network or weakening flags. Windows rejects nonempty per-exec allow lists; long-lived workers need dedicated holder grants instead. Map to the exact filesystem slice before calling the runtime.
export interface PerCommandFilesystem {
  // Paths the child may write for this command (the derived write-jail).
  readonly allowWrite?: readonly string[];
  // Paths the child may read (e.g. cwd re-allowed after a HOME-wide deny).
  readonly allowRead?: readonly string[];
  // Paths the child is denied reading (e.g. $HOME, to fix the read-jail leak).
  readonly denyRead?: readonly string[];
  // Paths the child is denied writing (takes precedence over allowWrite).
  readonly denyWrite?: readonly FilesystemPathEntry[];
  // The child may write INSIDE each `allowWrite` root but not unlink, rename or replace the root itself. Set by every wrap of PLUGIN-OWNED code — the plugin child, its workers, bundled hooks and MCP stdio servers — whose write roots are directories the host created and keeps resolving, a plugin's data root above all. Never by a wrap of the user's own shell or tools, whose write roots are the user's workspaces. Narrows only: it adds write denies (see PINNED_WRITE_ROOT_MARKER), so it requires `denyWrite` to be restated, since a per-command `denyWrite` replaces the shared floor rather than extending it.
  readonly pinWriteRoots?: boolean;
  // Reads this wrap may hold inside the protected read floor, each one also named in `allowRead`. Without it every `allowRead` entry under the floor is withheld. Composers set it for an exact user hook script, the builtin shell's configured saved-session root, or a plugin's declared `hostDirectory` that pierces the floor (`certs`). Anything else is refused (see readGrantsOutsideReadDenies).
  readonly floorPierces?: readonly string[];
  // Every plugin/third-party wrap denies all plugin storage roots, re-allowing only its own generation/data; create roots before wrapping because Linux skips absent denies. Restore writable binds shadowed by read re-allows. Refuse this mode on Windows, where a shared sandbox account cannot isolate neighbouring grants.
  readonly denyPluginsRoot?: boolean;
}

export interface WindowsWorkerFilesystemGrant {
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  release(): void;
}

// Per-command wrap options. `filesystem` scopes the per-command read/write jail (the only thing allowed to vary per command — see PerCommandFilesystem).
export interface WrapOptions {
  readonly filesystem?: PerCommandFilesystem;
  readonly abortSignal?: AbortSignal;
  // Pass bare command text plus a trusted detected shell, never a pre-rendered nested shell or workspace-selected executable. POSIX uses the same resolved dialect; Windows exact {exe,args} supports cmd with delayed expansion disabled rather than registry defaults.
  readonly binShell?: string | WindowsBinShell;
  // Refuse Unix sockets for a host shell, regardless of worker socket grants.
  readonly denyUnixSockets?: boolean;
}

const DEFAULT_POSIX_WRAPPER_SHELL = "/bin/bash";

function wrapperShell(binShell: WrapOptions["binShell"]): WrapOptions["binShell"] {
  return binShell ?? (process.platform === "win32" ? undefined : DEFAULT_POSIX_WRAPPER_SHELL);
}

// What every wrap must carry: the invocation's egress token (`egress-invocations.ts`), passed to ASRT as `commandId`. ASRT records the proxy denies of the wrapped process under it and puts it in the proxy username, so a deny can be attributed to the tool call, terminal tab or worker that opened the connection. Without it ASRT keys on the command text, which two invocations can share and which the violation store compares on its first 100 characters only, so it is required, not defaulted.
export interface AttributedWrapOptions extends WrapOptions {
  readonly commandId: string;
  // The invocation's boundary snapshot, shared with its read policy; a fresh one when absent.
  readonly boundarySnapshot?: AveHomeBoundarySnapshot;
}

// `network.allowLocalBinding` opens outbound loopback to every port, which would let any sandboxed process reach any other invocation's proxy listener and be attributed to it. Ave never sets it; a config that does is a bug, refused here (the carried ASRT patch refuses the wrap as well).
function assertNoLocalBinding(config: SandboxRuntimeConfig): void {
  if (config.network.allowLocalBinding === true) {
    throw new Error("ASRT config: network.allowLocalBinding would void per-invocation egress identity; Ave never sets it");
  }
}

function assertCommandId(caller: string, commandId: string): void {
  if (typeof commandId !== "string" || commandId.length < 22) {
    throw new Error(`${caller}: a wrap needs the invocation's egress token as commandId (22 characters or more)`);
  }
}

// Give the invocation its own proxy listener before it is wrapped (macOS and Linux; the carried ASRT patch). The wrap then pins that listener in the sandbox profile, and every connection that arrives there is attributed to this invocation by the kernel-enforced channel, not by the forgeable proxy username. A listener that cannot be opened (the per-session bound, an ended invocation) fails the wrap: falling back to the shared port would hand the ask callback an identity it does not trust, so the invocation would get no network at all without saying why.
async function openEgressListener(
  SandboxManager: Awaited<ReturnType<typeof loadSandboxManager>>,
  caller: string,
  commandId: string,
): Promise<void> {
  if (!asrtInvocationListenersSupported()) return;
  try {
    await SandboxManager.openInvocationListener(commandId);
  } catch (error) {
    const message = errorMessage(error);
    // Ended macOS listeners hold their ports for a quarantine (longer while their process group lives); an app restart releases them at once.
    const hint = /invocation listeners are held/u.test(message) ? " Restart Ave to release them." : "";
    throw new Error(`${caller}: could not open the invocation's egress listener: ${message}${hint}`, { cause: error });
  }
}

// Close every open connection the proxy let through to `host:port` for these invocations (a revoked grant's tunnels). Returns how many were closed; 0 before initialization (nothing can be open then).
export function closeEgressConnections(tokens: readonly string[], host: string, port: number): number {
  if (tokens.length === 0) return 0;
  return (loadedSandboxManagerForRelease?.closeInvocationConnections(tokens, host, port) ?? 0) + closeEgressRelayConnections(tokens, host, port);
}

// Close every connection the proxy allowed, for every invocation: when the upstream proxy setting changes, a tunnel opened through the old upstream (or direct, before one was required) must not outlive it, as a revoked grant's connections do not. Returns how many were closed.
export function closeAllEgressConnections(): number {
  return (loadedSandboxManagerForRelease?.closeAllInvocationConnections() ?? 0) + closeAllEgressRelayConnections();
}

// Retained after initialization so revocation can close connections synchronously.
let loadedSandboxManagerForRelease: Awaited<ReturnType<typeof loadSandboxManager>> | undefined;
// The session's config when Windows children are confined in containers only: the wrap runtime is then never loaded or initialized.
let containerOnlyConfig: SandboxRuntimeConfig | undefined;

function assertWrapRuntime(caller: string): void {
  if (containerOnlyConfig !== undefined) throw new Error(`${caller}: this session confines Windows children in containers; the wrap runtime is not initialized`);
}
interface PendingGitCleanup {
  cleanup: () => string | undefined | Promise<string | undefined>;
  complete: (outcome: SandboxCleanupOutcome) => void;
  releaseHostGit: () => void;
}
const bareRepositoryCleanups = new Map<string, PendingGitCleanup>();

async function completeBareRepositoryCleanup(pending: PendingGitCleanup): Promise<void> {
  let failure: string | undefined;
  let notice: string | undefined;
  try {
    notice = await pending.cleanup();
    pending.releaseHostGit();
  } catch (error) {
    failure = t("sandboxPolicy.cleanupFailed", { reason: errorMessage(error) });
    log.error(failure);
  } finally { pending.complete({ ...(notice ? { notice } : {}), ...(failure ? { failure } : {}) }); }
}

setHostGitWorkspaceGuard(workspace => {
  try { return isWatchedWorkspaceConsumable(workspace); }
  catch { return false; }
});

function warnWindowsPlaceholderLeftovers(filesystem: Partial<FilesystemConfig> | undefined): void {
  try {
    const leftovers = placeholderLeftovers(spelledPathEntries(filesystem?.denyWrite ?? [], "denyWrite").filter(path => isAbsolute(path) && !containsGlobCharsWin(path)));
    if (leftovers.length > 0) log.warn(t("sandboxPolicy.placeholderLeftovers", { paths: leftovers.join("\n") }));
  } catch (error) { log.warn(`[sandbox-placeholder-leftovers] scan failed: ${errorMessage(error)}`); }
}

// Rows stay watched while a session or live worker write root reaches them; Windows wraps carry no write roots of their own.
function watchedRootsInUse(session: AsrtSandboxSession | undefined): string[] {
  return [...liveWindowsWriteRoots(session), ...expandedWindowsDenyGrants(_baseTrustedSettings?.allowWrite ?? [], windowsProfileHome())];
}

// Command end is a detection point: a created watched row is quarantined before the result reaches its owner.
function watchedRowsCleanup(commandId: string, command: string): PendingGitCleanup["cleanup"] | undefined {
  if (process.platform !== "win32" || watchedProtectedRows().length === 0) return undefined;
  return () => sweepWatchedRows({ commandId, command: command.slice(0, 200) });
}

// Worker release is a detection point; a failed quarantine stays fail-closed for host consumers.
function sweepWatchedRowsAfterRelease(session: AsrtSandboxSession, commandId: string): void {
  void sweepWatchedRows({ commandId }).catch(error => { log.error(errorMessage(error)); })
    .finally(() => { pruneWatchedRows(watchedRootsInUse(session)); });
}

// A released token's listener refuses every further connection from then on. On macOS the ended port stays bound for a quarantine, longer while the invocation's process group still has a process in it.
onEgressInvocationReleased((token, { processGroup }) => {
  const pending = bareRepositoryCleanups.get(token);
  if (pending) {
    bareRepositoryCleanups.delete(token);
    void completeBareRepositoryCleanup(pending);
  }
  loadedSandboxManagerForRelease?.closeInvocationListener(token, processGroup === undefined ? undefined : { processGroup });
});

// Worker socket allowances must update shared config before wrapping; per-command network overrides are inert. macOS requires the socket directory, while Linux requires AF_UNIX plus the writable bind. Add/remove live worker allowances without replacing trusted base settings.

// The trusted settings last applied via initializeAsrtSandbox. Remembered so worker-UDS register/unregister can rebuild the SHARED config additively (the manifest egress union, denyRead floor, weakening flags, etc. are preserved). Undefined before the first init.
let _baseTrustedSettings: TrustedSandboxSettings | undefined;
// Shared config already trusts init-time evidence; reuse adds no TOCTOU window. ACL widening during a session is picked up at the next init.
let _baseReadDenyEvidence: WindowsReadDenySnapshot | undefined;

export function _getWindowsReadDenySnapshotForTest(): WindowsReadDenySnapshot | undefined {
  return _baseReadDenyEvidence;
}

// The shared loopback range that confined extension processes can reach.
export function getWindowsProxyPortRange(): readonly [number, number] {
  return _baseTrustedSettings?.windows?.proxyPortRange ?? DEFAULT_WINDOWS_PROXY_PORT_RANGE;
}

interface WindowsLiveGrantCounts {
  read: number;
  write: number;
}

interface WindowsWrapDenies {
  readonly read: string[];
  readonly write: FilesystemPathEntry[];
}

type WindowsDocumentsQuery = (signal?: AbortSignal) => Promise<string>;

interface AsrtSandboxSession {
  readonly linuxWrapperPrograms?: LinuxWrapperPrograms;
  readonly queryWindowsDocumentsPath?: WindowsDocumentsQuery;
  sharedWindowsDocumentsPath?: () => string;
  readonly windowsLiveGrants: Map<string, WindowsLiveGrantCounts>;
  windowsLiveGrantCount: number;
  windowsLiveGrantRevision: number;
  readonly windowsWrapDenyRead: Set<string>;
  readonly windowsWrapDenyWrite: Map<string, FilesystemPathEntry>;
  readonly windowsPendingWrapDenies: Set<WindowsWrapDenies>;
  windowsDenyRevision: number;
  windowsDenyFailure?: Error;
}

interface WindowsLiveGrantSnapshot {
  readonly allowRead?: readonly FilesystemPathEntry[];
  readonly allowWrite?: readonly FilesystemPathEntry[];
}

let sandboxSession: AsrtSandboxSession | undefined;
const windowsDocumentsPathScope = new AsyncLocalStorage<{
  readonly session: AsrtSandboxSession;
  readonly resolvePath: () => string;
}>();

function scopedWindowsDocumentsPath(): (() => string) | undefined {
  const scope = windowsDocumentsPathScope.getStore();
  return scope?.session === sandboxSession ? scope?.resolvePath : undefined;
}

async function resolveWindowsDocumentsPath(query: WindowsDocumentsQuery, signal?: AbortSignal): Promise<() => string> {
  signal?.throwIfAborted();
  let path: string;
  try { path = await query(signal); }
  catch { path = ""; }
  signal?.throwIfAborted();
  return () => path;
}

/** Nested policy composers share the same Documents answer for this operation. */
export async function runWithSandboxWritePreflight<T>(signal: AbortSignal | undefined, compose: () => T | Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const session = sandboxSession;
  if (process.platform !== "win32" || session?.queryWindowsDocumentsPath === undefined || scopedWindowsDocumentsPath() !== undefined) return compose();
  const resolvePath = await resolveWindowsDocumentsPath(session.queryWindowsDocumentsPath, signal);
  assertWindowsSession(session);
  return windowsDocumentsPathScope.run({ session, resolvePath }, compose);
}

function assertWindowsDenyProtection(): void {
  if (sandboxSession?.windowsDenyFailure !== undefined) throw sandboxSession.windowsDenyFailure;
}

function assertWindowsSession(session: AsrtSandboxSession | undefined, revision?: number): void {
  if (process.platform !== "win32") return;
  if (session === undefined || sandboxSession !== session || !active) {
    throw new Error("Windows sandbox session was reset");
  }
  assertWindowsDenyProtection();
  if (revision !== undefined && session.windowsDenyRevision !== revision) {
    throw new Error("Windows deny obligations changed");
  }
}

function snapshotWindowsLiveGrants(session: AsrtSandboxSession | undefined): WindowsLiveGrantSnapshot {
  const entries = [...(session?.windowsLiveGrants ?? [])];
  return {
    allowRead: entries.filter(([, counts]) => counts.read > 0).map(([path]) => ({ path, literal: true })),
    allowWrite: entries.filter(([, counts]) => counts.write > 0).map(([path]) => ({ path, literal: true })),
  };
}

function liveWindowsWriteRoots(session: AsrtSandboxSession | undefined): string[] {
  return [...(session?.windowsLiveGrants ?? [])].filter(([, counts]) => counts.write > 0).map(([path]) => path);
}

function filesystemDenyEntryKey(entry: FilesystemPathEntry): string {
  return typeof entry === "string" ? `pattern:${entry}` : `literal:${entry.path}`;
}

function checkWindowsWrapDenyUnion(session: AsrtSandboxSession | undefined, filesystem: PerCommandFilesystem | undefined): WindowsWrapDenies | undefined {
  if (process.platform !== "win32" || session === undefined || filesystem === undefined || !hasConfiguredDenies(filesystem)) return;
  assertWindowsPolicyBudget(filesystem, true);
  const { windowsWrapDenyRead, windowsWrapDenyWrite } = session;
  const knownRead = new Set([...(_baseTrustedSettings?.denyRead ?? []), ...windowsWrapDenyRead]);
  const knownWrite = new Map(windowsWrapDenyWrite);
  for (const entry of _baseTrustedSettings?.denyWrite ?? []) knownWrite.set(filesystemDenyEntryKey(entry), entry);
  const read = [...new Set(filesystem.denyRead)].filter(path => !knownRead.has(path));
  const write = new Map<string, FilesystemPathEntry>();
  for (const entry of filesystem.denyWrite ?? []) {
    const key = filesystemDenyEntryKey(entry);
    if (!knownWrite.has(key)) write.set(key, entry);
  }
  if (read.length === 0 && write.size === 0) return;
  assertWindowsPolicyBudget({
    denyRead: [...knownRead, ...read],
    denyWrite: [...knownWrite.values(), ...write.values()],
  }, true);
  return { read, write: [...write.values()] };
}

function withWindowsWrapDenyAdmission<T>(
  session: AsrtSandboxSession | undefined,
  filesystem: PerCommandFilesystem | undefined,
  wrap: (filesystem: PerCommandFilesystem | undefined) => Promise<T>,
): Promise<T> {
  if (process.platform !== "win32" || filesystem === undefined) return wrap(filesystem);
  // Use the same raw deny inputs for policy assembly and later retention.
  const snapshot = {
    ...filesystem,
    ...(filesystem.denyRead === undefined ? {} : { denyRead: [...filesystem.denyRead] }),
    ...(filesystem.denyWrite === undefined ? {} : { denyWrite: [...filesystem.denyWrite] }),
  };
  const additions = checkWindowsWrapDenyUnion(session, snapshot);
  if (session === undefined || additions === undefined) return wrap(snapshot);
  // Fence overlapping worker write grants during admission. Publish retained
  // denies and advance the revision only after the full wrap succeeds.
  session.windowsPendingWrapDenies.add(additions);
  return wrap(snapshot).finally(() => { session.windowsPendingWrapDenies.delete(additions); });
}

// Retain accepted raw obligations for the shared principal until session teardown.
// The Windows runtime prepares a descriptor. ACL changes begin only when it is run.
function commitWindowsWrapDenies(
  session: AsrtSandboxSession | undefined, grantRevision: number | undefined, filesystem: PerCommandFilesystem | undefined,
): void {
  if (process.platform !== "win32") return;
  assertWindowsSession(session);
  // A worker grant can make additional deny targets reachable while the wrap awaits the runtime.
  if (session === undefined || session.windowsLiveGrantRevision !== grantRevision) {
    throw new Error("Windows sandbox grants changed while preparing the command");
  }
  // Another wrap may have joined the retained union while this policy was being prepared.
  const additions = checkWindowsWrapDenyUnion(session, filesystem);
  if (additions === undefined) return;
  for (const path of additions.read) session.windowsWrapDenyRead.add(path);
  for (const entry of additions.write) session.windowsWrapDenyWrite.set(filesystemDenyEntryKey(entry), entry);
  session.windowsDenyRevision += additions.read.length + additions.write.length;
}

// Refcount shared socket directories across overlapping generations; one release must not remove another holder's allowance. Resolve registration only after config update and pair every successful register with unregister; Linux socket permission is path-blind.
interface WorkerUnixSocketDirEntry {
  readonly holders: Set<object>;
  registered: boolean;
  // Settles when the push that first added this dir to the shared config lands or fails.
  readonly pushed: Promise<void>;
}
const _workerUnixSocketDirs = new Map<string, WorkerUnixSocketDirEntry>();

// Merge the live worker-UDS state into a base TrustedSandboxSettings to produce the effective settings for the SHARED config. macOS: union the registered dirs into `allowRead`-independent `allowUnixSockets` via a new field; Linux: when ANY worker dir is registered, force the trusted `allowAllUnixSockets` weakening on (the base value otherwise).
function withWorkerUnixSockets(
  base: TrustedSandboxSettings,
  pendingDir?: string,
  resolveDocumentsPath = sandboxSession?.sharedWindowsDocumentsPath,
): TrustedSandboxSettings {
  if (process.platform === "win32" && sandboxSession !== undefined) {
    base = {
      ...base,
      resolveWindowsDocumentsPath: resolveDocumentsPath ?? base.resolveWindowsDocumentsPath,
      denyRead: [...(base.denyRead ?? []), ...sandboxSession.windowsWrapDenyRead],
      denyWrite: [...(base.denyWrite ?? []), ...sandboxSession.windowsWrapDenyWrite.values()],
    };
  }
  const dirs = [..._workerUnixSocketDirs]
    .filter(([dir, entry]) => entry.registered || dir === pendingDir)
    .map(([dir]) => dir);
  if (dirs.length === 0) return base;
  return {
    ...base,
    allowUnixSocketDirs: [
      ...(base.allowUnixSocketDirs ?? []),
      ...dirs,
    ],
    weakening: {
      ...base.weakening,
      // Linux needs the AF_UNIX seccomp re-permit for any worker UDS; macOS ignores this (it uses the path-scoped allowUnixSockets above).
      allowAllUnixSockets:
        process.platform === "linux"
          ? true
          : base.weakening?.allowAllUnixSockets,
    },
  };
}

// Map the trust-safe PerCommandFilesystem to the `customConfig` slice ASRT merges for this command. Only the `filesystem` section is ever produced here: network and weakening flags are intentionally unreachable from a per-command call so the trusted-settings gate cannot be bypassed.
export function hasPerExecFilesystemAllowGrants(
  filesystem: PerCommandFilesystem | undefined,
): boolean {
  return (
    (filesystem?.allowRead?.length ?? 0) > 0 ||
    (filesystem?.allowWrite?.length ?? 0) > 0
  );
}

export function assertPerExecFilesystemSupported(
  filesystem: PerCommandFilesystem | undefined,
  caller: string,
): void {
  if (process.platform !== "win32" || !hasPerExecFilesystemAllowGrants(filesystem)) {
    return;
  }
  throw new Error(
    `${caller}: ASRT 0.0.80 on Windows does not support per-exec ` +
      "filesystem.allowRead/allowWrite; only per-exec denyRead/denyWrite " +
      "are supported. Long-lived plugin workers must use the holder-PID " +
      "Windows ACL grant path instead.",
  );
}

// A denied child marker makes its macOS write root unremovable/unreplaceable through later ancestor-unlink rules while leaving contents writable; do not create the marker. Linux bind mounts already pin roots with EBUSY.
const PINNED_WRITE_ROOT_MARKER = ".ave-pinned-write-root";

// The marker denies for PerCommandFilesystem.pinWriteRoots. Built here, inside the wrap, after the caller has created every root it grants — the principal's temp directory included (ensureSandboxTempPrincipalDir) — so each one exists when its marker is computed.
function pinnedWriteRootDenies(writeRoots: readonly string[]): string[] {
  if (process.platform !== "darwin") return [];
  const denies: string[] = [];
  for (const root of writeRoots) {
    // Canonical, because Seatbelt matches real paths and ASRT canonicalises only paths that exist: the marker never does, so `/var/…` would stay `/var/…` and its derived literal would never match `/private/var/…`. A root that does not exist is dropped from the grant by ASRT, so there is nothing to pin.
    let real: string;
    try {
      real = realpathSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    denies.push(join(real, PINNED_WRITE_ROOT_MARKER));
  }
  return denies;
}

// Canonicalize macOS private-root denies and spell the last character as a glob class so late deny emission preserves own-directory re-allows under broader grants. Literal denies would override them; other private directories stay denied. Linux keeps literal masks because grants bind back inside them.
function asrtReadDenyPaths(denyRead: readonly string[], exactRoots: readonly string[]): string[] {
  if (process.platform !== "darwin") return [...denyRead];
  const roots = new Set(exactRoots.flatMap((path) => [path, normalizePathForSandbox(path)]));
  return denyRead.map((path) => (roots.has(path) ? exactSeatbeltDenyGlob(path) : path));
}

function exactSeatbeltDenyGlob(root: string): string {
  let real = root;
  try {
    real = realpathSync(root);
  } catch (error) {
    // Not created yet: nothing is under it to read, and the deny still names it.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (/[*?[\]]/.test(real)) {
    throw new Error(`sandbox: ${real} contains glob characters; the read deny cannot name it exactly`);
  }
  return `${real.slice(0, -1)}[${real.slice(-1)}]`;
}

// The roots PerCommandFilesystem.denyPluginsRoot refuses, each created (`0o700`) if absent so the deny exists on Linux before anything is installed under it. Their layouts are owned elsewhere: the plugins root by `plugin-paths.ts`; an agent plugin's data by the `agent-plugin-data` feature namespace (`agent-plugin-hook-runtime.ts`, `agent-plugin-mcp-runtime.ts`); its installed versions by the content store's `<packages>/<kind>/<name>/<version>` (`content/store.ts`) under `<AVE_HOME>/packages` (`marketplace-content.ts`). What a wrap owns under them — an agent plugin's generation and data for its hook or bundled server — is re-allowed by the caller, as for the plugins root.
function ensurePluginOwnedReadRoots(): string[] {
  const roots = pluginOwnedReadRoots();
  for (const root of roots) mkdirSync(root, { recursive: true, mode: 0o700 });
  return roots;
}

function pluginOwnedReadRoots(): string[] {
  const home = aveHome();
  return [resolvePluginPaths().pluginsRoot, agentPluginDataRoot(), join(home, "packages", "agent-plugin")];
}

// Grant only the outermost approved envelope: nested junctions can be swapped before ACL stamping, which follows targets. Host-created roots rely on protected parents; chosen roots rely on user consent and unwritable parents. Shared-account grants provide no inter-plugin isolation, and overlapping chosen roots remain a limitation.
export function outermostContainingRoots(paths: readonly string[], roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const containing = roots.filter((root) => isGrantPathWithin(root, path));
    const outermost = containing.find((root) => !containing.some((other) =>
      other !== root && isGrantPathWithin(other, root) && !isGrantPathWithin(root, other)));
    if (outermost === undefined) {
      throw new Error(`[asrt-sandbox] ${path} lies under none of ${roots.join(", ")}`);
    }
    if (!out.includes(outermost)) out.push(outermost);
  }
  return out;
}

// The paths of a Windows plugin grant that would reach past the plugin's own directories into the roots macOS and Linux refuse every plugin-owned wrap (PerCommandFilesystem.denyPluginsRoot). Windows has no such deny, so the grant itself is held to it: a path may lie inside the plugins root only under the plugin's own install (`<plugins>/<id>`) or generation cache (`<plugins>/.cache/<id>`); never inside an agent plugin's roots, which no `entry` plugin owns; and never at or above any of the roots, since an inheriting grant there would cover every plugin under it. Empty when the grant is the plugin's own.
export function pluginGrantPathsBeyondOwnRoots(pluginId: string, paths: readonly string[]): string[] {
  const fold = (path: string): string => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  const within = (path: string, root: string): boolean => {
    const rel = relative(fold(root), fold(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const roots = pluginOwnedReadRoots();
  const { pluginsRoot, cacheRoot } = resolvePluginPaths();
  const own = [join(pluginsRoot, pluginId), join(cacheRoot, pluginId)];
  return paths.filter((path) =>
    roots.some((root) => within(root, path))
    || (roots.some((root) => within(path, root)) && !own.some((ownRoot) => within(path, ownRoot))));
}

const admittedWindowsPolicies = new WeakMap<object, Partial<FilesystemConfig>>();

interface WindowsDenyLists {
  readonly denyRead?: readonly FilesystemPathEntry[] | undefined;
  readonly denyWrite?: readonly FilesystemPathEntry[] | undefined;
}

function windowsAclBudgetError(error: unknown, configured: boolean): unknown {
  return error instanceof WindowsSandboxError && error.code === "acl_policy_too_large"
    ? new Error(t(configured ? "sandboxPolicy.configuredDeniesTooLarge" : "sandboxPolicy.tooLarge"), { cause: error })
    : error;
}

function hasConfiguredDenies(filesystem: WindowsDenyLists | undefined): boolean {
  return Boolean(filesystem?.denyRead?.length || filesystem?.denyWrite?.length);
}

function assertWindowsPolicyBudget(filesystem: WindowsDenyLists, configured = false): void {
  if (process.platform !== "win32") return;
  try {
    assertWindowsAclPolicyBudget(filesystem.denyRead, filesystem.denyWrite);
  } catch (error) {
    throw windowsAclBudgetError(error, configured);
  }
}

// Grant admission pins first, checks the pinned result, and hands off those same entries.
// Denies retain their own conservative projection; uncertainty must keep a deny, never admit a grant.
function admitFilesystemPolicy<T extends Pick<TrustedSandboxSettings, "allowRead" | "allowWrite" | "denyRead" | "denyWrite">>(filesystem: T): T {
  if (process.platform === "win32") {
    const pinned = pinWindowsFilesystemConfig<Partial<FilesystemConfig>>({
      allowRead: [...(filesystem.allowRead ?? [])], allowWrite: [...(filesystem.allowWrite ?? [])],
    });
    for (const entry of [...(pinned.allowRead ?? []), ...(pinned.allowWrite ?? [])]) {
      if (typeof entry !== "string") void entry.path;
    }
    // Preserve requested breadth as well as the resolved target after pinning.
    try {
      assertWindowsMachineRootWriteGrants(filesystem.allowWrite ?? []);
    } catch (cause) {
      throw new Error(`Windows filesystem grant reparse target refused: ${errorMessage(cause)}`, { cause });
    }
    const paths: Partial<Record<"allowRead" | "allowWrite", string[]>> = {};
    for (const field of ["allowRead", "allowWrite"] as const) {
      if (filesystem[field] !== undefined) paths[field] = windowsPinnedPaths(pinned[field] ?? []);
    }
    const admitted = { ...filesystem, ...paths };
    try {
      assertWindowsMachineRootWriteGrants(admitted.allowWrite ?? []);
    } catch (cause) {
      throw new Error(`Windows filesystem grant reparse target refused: ${errorMessage(cause)}`, { cause });
    }
    admittedWindowsPolicies.set(admitted, pinned);
    return admitted;
  }
  const normalize = (path: string): string => {
    const normalized = normalizePathForSandbox(path);
    const expansionHome = leadingTildeHome(path);
    // The runtime's pattern parser has no escape syntax. An expanded literal must never become a pattern.
    if (process.platform !== "win32" && (
      (expansionHome !== undefined && containsGlobChars(expansionHome)) ||
      (!isAbsolute(path) && expansionHome === undefined && containsGlobChars(process.cwd())) ||
      (!containsGlobChars(path) && containsGlobChars(normalized))
    )) {
      throw new Error(`filesystem-expansion-glob: expanded path cannot be represented literally: ${JSON.stringify(path)}`);
    }
    return normalized;
  };
  const admitted = {
    ...filesystem,
    ...(filesystem.allowRead !== undefined ? { allowRead: filesystem.allowRead.map(normalize) } : {}),
    ...(filesystem.allowWrite !== undefined ? { allowWrite: filesystem.allowWrite.map(normalize) } : {}),
    ...(filesystem.denyRead !== undefined ? { denyRead: filesystem.denyRead.map(normalize) } : {}),
    ...(filesystem.denyWrite !== undefined ? { denyWrite: filesystem.denyWrite.map(entry => typeof entry === "string"
      ? normalize(entry) : { ...entry, path: normalizePathForSandbox(entry.path, { literal: true }) }) } : {}),
  };
  // Refuse requested roots before discovery can narrow them away.
  assertWindowsMachineRootWriteGrants(admitted.allowWrite ?? []);
  return admitted;
}

function finishFilesystemPolicy(
  filesystem: Partial<FilesystemConfig>, admitted: object, configuredDenies: readonly FilesystemPathEntry[], hasOverrides: boolean,
): Partial<FilesystemConfig> {
  const denyWrite = compactSandboxWriteDenies(filesystem.denyWrite ?? []);
  if (Object.isFrozen(filesystem.denyWrite)) Object.freeze(denyWrite);
  filesystem = { ...filesystem, denyWrite };
  assertSandboxWritePolicySize(filesystem.denyWrite ?? [], undefined, compactSandboxWriteDenies(configuredDenies));
  if (process.platform !== "win32") return filesystem;
  assertWindowsPolicyBudget(filesystem, hasOverrides);
  const pinned = admittedWindowsPolicies.get(admitted);
  if (pinned === undefined) throw new Error("Filesystem policy was not admitted");
  const retain = (entries: readonly FilesystemPathEntry[], source: readonly FilesystemPathEntry[]): FilesystemPathEntry[] => {
    const grants = new Map(source.map(entry => [typeof entry === "string" ? entry : entry.path, entry] as const));
    return existingWindowsGrants(entries.map(entry => {
      const path = typeof entry === "string" ? entry : entry.path;
      const original = grants.get(path);
      if (original === undefined) throw new Error("Filesystem grant differs from pinned admission");
      if (typeof original !== "string") void original.path;
      return original;
    }));
  };
  // Only grants cross the pin boundary. Composed denies keep their spellings and uncertainty semantics.
  return { ...filesystem,
    allowRead: retain(filesystem.allowRead ?? [], pinned.allowRead ?? []),
    allowWrite: retain(filesystem.allowWrite ?? [], pinned.allowWrite ?? []),
  };
}

/** Admit only this holder's roots. This path never consults live account grants or changes host ACLs. */
export function admitMxcExtensionFilesystem(
  ...args: Parameters<typeof admitMxcExtensionFilesystemInSnapshot>
): ReturnType<typeof admitMxcExtensionFilesystemInSnapshot> {
  return inAveHomeBoundarySnapshot(undefined, () => admitMxcExtensionFilesystemInSnapshot(...args));
}

function admitMxcExtensionFilesystemInSnapshot(filesystem: PerCommandFilesystem, ownership?: MxcExtensionFilesystemOwnership): {
  /** The holder's admitted policy as rows, every path literal. */
  readonly model: PolicyModel;
  readonly assertStillValid: () => void;
} {
  if (process.platform !== "win32") throw new Error("Container filesystem admission requires win32");
  if (filesystem.allowRead === undefined || filesystem.allowWrite === undefined) {
    throw new Error("Container filesystem admission requires explicit holder read and write roots");
  }
  const lexicalNamespaces = [...pluginOwnedReadRoots(), resolvePluginPaths().cacheRoot, ...appOwnedSandboxPrivateRoots()];
  const namespacePins = pinWindowsFilesystemConfig<Partial<FilesystemConfig>>({ allowRead: lexicalNamespaces, allowWrite: [] });
  const namespaceRoots = [...lexicalNamespaces, ...windowsPinnedPaths(namespacePins.allowRead ?? [])];
  assertMxcExtensionFilesystemOwnership({ ...filesystem, allowRead: filesystem.allowRead, allowWrite: filesystem.allowWrite,
    pluginNamespaceRoots: namespaceRoots, ownership });
  const ownershipPins = ownership === undefined ? undefined : pinWindowsFilesystemConfig<Partial<FilesystemConfig>>({
    allowRead: [...ownership.readRoots, ...ownership.hostStorageRoots], allowWrite: [...ownership.writeRoots],
  });
  const pinnedOwnership = ownershipPins === undefined ? undefined : {
    readRoots: windowsPinnedPaths((ownershipPins.allowRead ?? []).slice(0, ownership?.readRoots.length ?? 0)),
    hostStorageRoots: windowsPinnedPaths((ownershipPins.allowRead ?? []).slice(ownership?.readRoots.length ?? 0)),
    writeRoots: windowsPinnedPaths(ownershipPins.allowWrite ?? []),
  };
  const admitted = admitFilesystemPolicy({
    allowRead: [...filesystem.allowRead], allowWrite: [...filesystem.allowWrite],
    denyRead: [...(filesystem.denyRead ?? []), ...(_baseTrustedSettings?.denyRead ?? [])],
    denyWrite: [...(filesystem.denyWrite ?? []), ...(_baseTrustedSettings?.denyWrite ?? [])],
  });
  const pinned = admittedWindowsPolicies.get(admitted);
  if (pinned === undefined) throw new Error("Container filesystem admission has no pinned identity");
  if ([pinned.allowRead, pinned.allowWrite].some(entries => entries !== undefined && existingWindowsGrants(entries).length !== entries.length)) {
    throw new Error("Container filesystem grant target is missing");
  }
  if ([...admitted.allowRead, ...admitted.allowWrite].some(path => win32.parse(path).root === win32.normalize(path))) {
    throw new Error("Container filesystem volume roots permit query access only");
  }
  assertMxcExtensionFilesystemOwnership({ allowRead: admitted.allowRead, allowWrite: admitted.allowWrite,
    pluginNamespaceRoots: namespaceRoots, ownership: pinnedOwnership });
  const floor = getProtectedReadDenyPaths();
  const pierces = filesystem.floorPierces ?? [];
  const sensitiveWriteDenies = getDefaultSensitiveWriteDenyEntries();
  const mandatory = buildMandatorySandboxWritePolicy(
    pinned.allowWrite ?? [], _baseTrustedSettings?.userDataDir,
    spelledPathEntries(sensitiveWriteDenies, "denyWrite"),
  );
  // Pattern denies cannot be represented by a fixed literal container policy, including future matches.
  const literalDenies = (entries: readonly FilesystemPathEntry[], write = false): readonly string[] => [...new Set(entries.flatMap(entry => {
    const raw = typeof entry === "string" ? entry : entry.path;
    if (/^\/(?!\/)/.test(raw)) return [];
    const expanded = write && typeof entry !== "string" ? raw : expandLeadingTilde(expandWindowsEnvRefs(raw));
    if (containsGlobCharsWin(expanded) || !win32.isAbsolute(expanded) || isUncPath(expanded)) {
      throw new Error("Container filesystem deny cannot be represented literally");
    }
    const literal = win32.normalize(expanded);
    try { return [literal, stripExtendedPathPrefix(realpathSync.native(literal))]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [literal];
      throw error;
    }
  }))];
  // Only the shared private/namespace masks are re-openable by this holder's own leaf roots.
  // An explicit literal deny below those masks, or anywhere else, remains a hard floor.
  const reallowableMasks = literalDenies([...appOwnedSandboxPrivateRoots(), ...namespaceRoots, ...aveHomeReadBoundaryMasks()]);
  const samePath = (left: string, right: string): boolean =>
    win32.normalize(left).replace(/[\\/]+$/, "").toLowerCase() === win32.normalize(right).replace(/[\\/]+$/, "").toLowerCase();
  const explicitReadFloor = literalDenies(admitted.denyRead).filter(path => !reallowableMasks.some(mask => samePath(path, mask)));
  const protectedFloor = [...new Set([...literalDenies(floor), ...explicitReadFloor])];
  const allowRead = readGrantsOutsideReadDenies(admitted.allowRead, protectedFloor, pierces);
  const readDenies = literalDenies([
    ...getDefaultSensitiveReadDenyPaths(), ...admitted.denyRead,
    ...namespaceRoots, ...(pinnedOwnership?.hostStorageRoots ?? []),
  ]);
  const writeFloor = literalDenies([...sensitiveWriteDenies, ...admitted.denyWrite, ...mandatory.denyWrite], true);
  const model = buildPolicyModel({
    floors: [
      ...readDenies.map((path) => policyFloorRow(path, "denied", "read-boundary", true)),
      ...writeFloor.map((path) => policyFloorRow(path, "ro", "protected-name", true)),
      ...protectedFloor.map((path) => policyFloorRow(path, "denied", "secrets", true)),
    ],
    userGrants: [],
    extensionManifests: [
      ...mandatory.allowWrite.map((path) => policyGrantRow(path, "rw", "extension-manifest", true)),
      ...allowRead.map((path) => policyGrantRow(path, "ro", "extension-manifest", true)),
      ...pierces.map((path) => policyGrantRow(path, "ro", "floor-pierce", true)),
    ],
    launchGrants: [],
  });
  assertSandboxWritePolicySize(writeFloor, undefined, admitted.denyWrite);
  const assertStillValid = (): void => {
    for (const entry of [...(pinned.allowRead ?? []), ...(pinned.allowWrite ?? []),
      ...(ownershipPins?.allowRead ?? []), ...(ownershipPins?.allowWrite ?? []), ...(namespacePins.allowRead ?? [])]) {
      if (typeof entry !== "string") void entry.path;
    }
    assertMxcExtensionFilesystemOwnership({ allowRead: admitted.allowRead, allowWrite: admitted.allowWrite,
      pluginNamespaceRoots: namespaceRoots, ownership: pinnedOwnership });
  };
  assertStillValid();
  return { model, assertStillValid };
}

export function buildPerCommandSandboxCustomConfig(
  filesystem: PerCommandFilesystem | undefined,
  onNotice?: (notice: string) => void,
  onGitControlSnapshot?: (snapshot: SandboxGitControlSnapshot) => void,
  readDenyEvidence?: WindowsReadDenySnapshot,
  liveGrants: WindowsLiveGrantSnapshot = {},
): Partial<SandboxRuntimeConfig> | undefined {
  // One boundary snapshot for the whole per-command composition: the enclosing one, else a new one.
  return inAveHomeBoundarySnapshot(undefined, () => {
    const hasOverrides = hasConfiguredDenies(filesystem) || hasConfiguredDenies(_baseTrustedSettings);
    // Restate Windows denies even without overrides: the session snapshot may no longer exist.
    if (process.platform === "win32") {
      if (filesystem !== undefined) assertWindowsPolicyBudget(filesystem, true);
      filesystem = { ...filesystem, denyRead: filesystem?.denyRead ?? getDefaultSensitiveReadDenyPaths(_baseTrustedSettings?.userDataDir) };
      readDenyEvidence ??= _baseReadDenyEvidence;
    }
    // Shared initialization is not a command snapshot: newly appeared Git metadata must be discovered again even without an explicit override.
    filesystem ??= {};
    if (filesystem.pinWriteRoots === true && filesystem.denyWrite === undefined) {
      throw new Error(
        "buildPerCommandSandboxCustomConfig: pinWriteRoots needs denyWrite restated; a per-command denyWrite "
          + "replaces the shared deny floor",
      );
    }
    if (filesystem.denyPluginsRoot === true) {
      if (process.platform === "win32") {
        throw new Error(
          "buildPerCommandSandboxCustomConfig: denyPluginsRoot is refused on Windows; a deny there is an ACE for the "
            + "one sandbox account every confined process shares, so it would refuse each plugin its own directories",
        );
      }
      if (filesystem.denyRead === undefined) {
        throw new Error(
          "buildPerCommandSandboxCustomConfig: denyPluginsRoot needs denyRead restated; a per-command denyRead "
            + "replaces the shared deny floor",
        );
      }
    }
    const configured = {
      allowWrite: filesystem.allowWrite ?? _baseTrustedSettings?.allowWrite ?? [],
      allowRead: filesystem.allowRead ?? _baseTrustedSettings?.allowRead,
      denyRead: [...(filesystem.denyRead ?? []), ...(_baseTrustedSettings?.denyRead ?? [])],
      denyWrite: [...(filesystem.denyWrite ?? []), ...(_baseTrustedSettings?.denyWrite ?? [])],
    };
    if (process.platform === "win32") {
      configured.denyRead = [...new Set(configured.denyRead)];
      configured.denyWrite = [...new Map(configured.denyWrite.map(entry => [filesystemDenyEntryKey(entry), entry])).values()];
      assertWindowsPolicyBudget(configured, true);
    }
    const grants = admitFilesystemPolicy(configured);
    const fs: Partial<FilesystemConfig> = {};
    // The wrap's policy as rows. Each package list is read off the rows as soon as its own are stated, so every later check and
    // notice keeps its place in the composition.
    const floors: PolicyFloorRow[] = [];
    const launchGrants: PolicyGrantRow[] = [];
    const lists = () => toSrtConfig(buildPolicyModel({ floors, userGrants: [], extensionManifests: [], launchGrants }));
    const floor = getProtectedReadDenyPaths();
    // A per-command deny REPLACES the shared one, so the trusted custom denies are restated here once for every wrap rather than by each composer.
    let hiddenSeccompHelper: string | undefined;
    // What the wrap may be granted on Windows: per-exec grants are refused there (see above), so the session's and the live worker grants.
    const windowsWriteGrants: FilesystemPathEntry[] = [
      ...(process.platform === "win32" ? (loadedSandboxManagerForRelease?.getConfig() ?? containerOnlyConfig)?.filesystem.allowWrite ?? [] : []),
      ...(_baseTrustedSettings?.allowWrite ?? []),
      ...(filesystem.allowWrite ?? []),
      ...grants.allowWrite,
      ...(liveGrants.allowWrite ?? []),
    ];
    const windowsGrants: FilesystemPathEntry[] = [
      ...(filesystem.allowRead ?? _baseTrustedSettings?.allowRead ?? []),
      ...(grants.allowRead ?? []),
      ...(liveGrants.allowRead ?? []),
      ...windowsWriteGrants,
    ];
    if (filesystem.denyRead !== undefined) {
      const pluginRoots = filesystem.denyPluginsRoot === true ? ensurePluginOwnedReadRoots() : [];
      const denyRead = [...new Set([...grants.denyRead, ...pluginRoots])];
      hiddenSeccompHelper = seccompHelperHiddenBy(denyRead);
      // Each row names the floor its path came from, judged on the spelling the caller gave: the protected read floor, the Ave
      // home boundary, or anything else the caller restated.
      const protectedRows = new Set(floor);
      const boundaryRows = new Set(aveHomeReadBoundaryDenies());
      const requested = new Map(grants.denyRead.map((path, index) => [path, configured.denyRead[index] ?? path] as const));
      floors.push(...denyRead.map((path) => {
        const spelling = requested.get(path) ?? path;
        return policyFloorRow(path, "denied",
          protectedRows.has(spelling) ? "secrets" : boundaryRows.has(spelling) ? "ave-home" : "read-boundary", false);
      }));
      fs.denyRead = windowsDenyTargets(
        asrtReadDenyPaths(
          lists().denyRead,
          // The plugin roots are spelled exactly for the reason the private roots are: a wrap whose reads include an ancestor of one (a worker's or a bundled process's host temp directory, above a test `AVE_HOME`) would otherwise lose its own plugin directories to the re-emitted deny.
          [...appOwnedSandboxReallowableRoots(), ...pluginRoots, ...aveHomeReadBoundaryMasks()],
        ),
        _baseTrustedSettings?.userDataDir,
        windowsGrants,
        windowsWriteGrants,
        "read",
        readDenyEvidence,
      );
    }
    const sensitiveDenyWrite = getDefaultSensitiveWriteDenyEntries(_baseTrustedSettings?.userDataDir);
    const sensitiveWritePaths = spelledPathEntries(sensitiveDenyWrite, "denyWrite");
    const mandatory = buildMandatorySandboxWritePolicy(
      admittedWindowsPolicies.get(grants)?.allowWrite ?? grants.allowWrite,
      _baseTrustedSettings?.userDataDir,
      sensitiveWritePaths,
      sensitiveWritePaths.filter(path => isAbsolute(path) && !/[*?\[\]]/.test(path)),
    );
    launchGrants.push(...(process.platform === "win32" ? [] : writeRootsOutsideReadDenies(mandatory.allowWrite, floor))
      .map((path) => policyGrantRow(path, "rw", "launch-grant", false)));
    fs.allowWrite = lists().allowWrite;
    const reasonKeys = {
      "entry-budget": "sandboxPolicy.scanEntryBudget",
      "path-budget": "sandboxPolicy.scanPathBudget",
      "filesystem-access": "sandboxPolicy.scanInaccessible",
      "routing-link": "sandboxPolicy.scanRouting",
    } as const;
    for (const reason of new Set(mandatory.narrowedWriteRoots.map(entry => entry.reason))) {
      const notice = t("sandboxPolicy.scanNarrowed", {
        reason: t(reasonKeys[reason]),
        roots: fs.allowWrite.length ? fs.allowWrite.map(root => JSON.stringify(root)).join(", ") : t("sandboxPolicy.noWriteRoots"),
        removed: mandatory.narrowedWriteRoots.filter(entry => entry.reason === reason).map(entry => JSON.stringify(entry.root)).join(", "),
      });
      onNotice?.(notice);
      log.warn(notice);
    }
    {
      const writeFloor = [...new Set([
        ...sensitiveDenyWrite,
        ...mandatory.denyWrite,
        ...grants.denyWrite,
        ...(filesystem.pinWriteRoots === true ? pinnedWriteRootDenies(filesystem.allowWrite === undefined ? [] : grants.allowWrite) : []),
      ])];
      floors.push(...writeFloor.map(srtWriteFloorRow));
      fs.denyWrite = windowsDenyTargets(
        lists().denyWrite,
        _baseTrustedSettings?.userDataDir,
        windowsGrants,
        windowsWriteGrants,
        "write",
      );
    }
    if (filesystem.allowRead !== undefined || hiddenSeccompHelper !== undefined) {
      // A per-command allowRead REPLACES the shared one, so a wrap that only restates its denies keeps the shared grants alongside the seccomp helper. The helper joins before the floor filter: a protected deny still wins.
      const readGrants = grants.allowRead ?? [];
      launchGrants.push(...readGrantsOutsideReadDenies(
        hiddenSeccompHelper === undefined || readGrants.includes(hiddenSeccompHelper) ? readGrants : [...readGrants, hiddenSeccompHelper],
        floor,
        // Restated shared grants keep the shared config's pierces (none, as in buildSandboxConfig); a wrap's own pierces cover only its own grants.
        filesystem.allowRead !== undefined ? (filesystem.floorPierces ?? []) : [],
      ).map((path) => policyGrantRow(path, "ro", "launch-grant", false)));
      fs.allowRead = lists().allowRead;
    }
    if (Object.keys(fs).length === 0) return undefined;
    // The runtime and Linux mount replay consume one discovery snapshot. Freeze its lists so neither consumer can change the other's policy mid-wrap.
    for (const entries of Object.values(fs)) {
      if (Array.isArray(entries)) {
        for (const entry of entries) if (typeof entry === "object") Object.freeze(entry);
        Object.freeze(entries);
      }
    }
    if (mandatory.gitControlSnapshot) {
      const snapshot = restrictSandboxGitControlSnapshot(
        mandatory.gitControlSnapshot, spelledPathEntries(fs.allowWrite ?? [], "allowWrite"), gitQuarantineExclusions(fs, floor),
      );
      onGitControlSnapshot?.(snapshot);
    }
    return { filesystem: Object.freeze(finishFilesystemPolicy(fs, grants, grants.denyWrite, hasOverrides)) as FilesystemConfig };
  });
}

// Remembered exclusion answers per invocation; past it, answers are recomputed.
const MAX_GIT_EXCLUSION_ANSWERS = 65_536;

// Cleanup cannot move host entries hidden or made read-only by this policy.
function gitQuarantineExclusions(filesystem: Partial<FilesystemConfig>, floor: readonly string[]): (path: string, includesChildren?: boolean) => boolean {
  // The floor, read masks and write denies repeat many of the same paths; resolve each spelling once for this build.
  const normalized = new Map<string, string>();
  const normalize = (path: string): string => {
    let physical = normalized.get(path);
    if (physical === undefined) {
      physical = resolvePhysicalFilesystemPath(expandLeadingTilde(path), process.cwd(), MAX_WALK_UP);
      normalized.set(path, physical);
    }
    return physical;
  };
  const protectedReads = floor.map(normalize);
  const readMasks = spelledPathEntries(filesystem.denyRead ?? [], "denyRead").map(normalize);
  const writeRoots = spelledPathEntries(filesystem.allowWrite ?? [], "allowWrite").map(normalize);
  const writeDenies = (filesystem.denyWrite ?? []).map(entry => typeof entry === "string"
    ? { path: normalize(entry), literal: false }
    : { path: normalize(entry.path), literal: entry.literal === true });
  for (const pattern of [...protectedReads, ...readMasks, ...writeDenies.filter(entry => !entry.literal).map(entry => entry.path)]) {
    if (/[\[\]]/u.test(pattern) || (pattern.includes("\\") && /[*?]/u.test(pattern))) {
      throw new Error("Linux Git quarantine cannot represent a filesystem deny pattern");
    }
  }
  // The cleanup asks this for every scanned directory and candidate, against every pattern, so each glob compiles once here rather than per ancestor per call (readDenyCoversPath's per-call compile made a few dozen entries cost seconds). Same matches as readDenyCoversPath(pattern, path, true).
  const globCovers = new Map<string, (path: string) => boolean>();
  for (const pattern of [...protectedReads, ...readMasks, ...writeDenies.filter(entry => !entry.literal).map(entry => entry.path)]) {
    if (!/[*?]/u.test(pattern) || globCovers.has(pattern)) continue;
    const match = compileGlobMatcher(pattern);
    globCovers.set(pattern, (path) => {
      for (let candidate = path; ; candidate = dirname(candidate)) {
        if (match(candidate) || match(`${candidate}/`)) return true;
        if (dirname(candidate) === candidate) return false;
      }
    });
  }
  // Every pattern above is an absolute normalized path, so off Windows the grant test is a prefix test; isGrantPathWithin re-resolves both sides.
  const within = process.platform === "win32" ? isGrantPathWithin : (root: string, path: string): boolean =>
    path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  const covers = (pattern: string, path: string): boolean => {
    const glob = globCovers.get(pattern);
    return glob ? glob(path) : within(pattern, path);
  };
  const intersects = (pattern: string, path: string): boolean => {
    if (covers(pattern, path)) return true;
    const wildcard = pattern.search(/[*?\[\]]/u);
    if (wildcard < 0) return within(path, pattern);
    const literalPrefix = pattern.slice(0, wildcard);
    const prefix = literalPrefix.endsWith("/") ? literalPrefix.replace(/\/+$/u, "") || "/" : dirname(literalPrefix);
    return within(path, prefix) || within(prefix, path);
  };
  const excluded = (path: string, includesChildren: boolean): boolean => {
    const matches = includesChildren ? intersects : covers;
    if (protectedReads.some(denied => matches(denied, path))) return true;
    if (readMasks.some(denied => matches(denied, path)
      && !writeRoots.some(root => covers(denied, root) && within(root, path)))) return true;
    return writeDenies.some(denied => denied.literal
      ? within(denied.path, path) || (includesChildren && within(path, denied.path))
      : matches(denied.path, path));
  };
  // The policy is fixed for the invocation and the answer depends on the path string alone, so the before and after sweeps share one answer per path.
  const answers = new Map<string, boolean>();
  return (path, includesChildren = false) => {
    const normalized = process.platform === "win32" ? path : resolve(path);
    const key = `${includesChildren ? "1" : "0"}${normalized}`;
    const cached = answers.get(key);
    if (cached !== undefined) return cached;
    const answer = excluded(normalized, includesChildren);
    if (answers.size < MAX_GIT_EXCLUSION_ANSWERS) answers.set(key, answer);
    return answer;
  };
}

// The host spawns this; ASRT never spawns the workload itself.
export interface SandboxCleanupOutcome {
  readonly notice?: string;
  readonly failure?: string;
}

export interface SandboxWrapResult {
  readonly argv: string[];
  readonly env: NodeJS.ProcessEnv;
  // Invocation-owned post-exit cleanup outcome; retained by its result owner.
  readonly cleanupCompleted?: Promise<SandboxCleanupOutcome>;
  readonly notices?: readonly string[];
  // The immutable discovery snapshot supplied to this invocation's runtime.
  readonly filesystemPolicy?: Readonly<Pick<FilesystemConfig, "allowWrite" | "denyWrite">>;
  // Git identities captured by the same scan that selected the mounted denies.
  readonly gitControlSnapshot?: SandboxGitControlSnapshot;
}

function trackBareRepositoryCleanup(wrapped: SandboxWrapResult, commandId: string, cleanup: PendingGitCleanup["cleanup"] | undefined, released: () => boolean): SandboxWrapResult {
  if (!cleanup) return wrapped;
  const releaseHostGit = holdSandboxGitWrites(spelledPathEntries(wrapped.filesystemPolicy?.allowWrite ?? [], "allowWrite"));
  const cleanupCompleted = new Promise<SandboxCleanupOutcome>(complete => {
    const pending = { cleanup, complete, releaseHostGit };
    if (released()) void completeBareRepositoryCleanup(pending);
    else bareRepositoryCleanups.set(commandId, pending);
  });
  return { ...wrapped, cleanupCompleted };
}

// Read re-allows remain plain spellings; write-deny literals retain exact paths.
function spelledPathEntries(entries: readonly FilesystemPathEntry[], field: string): string[] {
  return entries.map((entry) => {
    if (typeof entry !== "string") {
      if (field === "denyWrite" && entry.literal === true) return entry.path;
      throw new Error(
        `applySandboxFilesystemPolicy: per-command ${field} holds a marked literal entry; `
          + "the Linux wrapper replays plain spellings only",
      );
    }
    return entry;
  });
}

function applySandboxFilesystemPolicy(
  wrapped: SandboxWrapResult,
  applied: Partial<FilesystemConfig> | undefined,
  cleanupAfterCommand: () => void,
): SandboxWrapResult {
  try {
    if (process.platform === "darwin") return hardenMacSandboxGitMetadata(wrapped);
    if (process.platform !== "linux") return wrapped;
    // The same slice the wrap was built from — the re-allows and write denies ASRT was given, after the floor withheld what it withholds.
    return hardenLinuxSandboxWrap(wrapped, {
      ...(applied?.allowRead !== undefined ? { allowRead: spelledPathEntries(applied.allowRead, "allowRead") } : {}),
      ...(applied?.denyWrite !== undefined ? { denyWrite: spelledPathEntries(applied.denyWrite, "denyWrite") } : {}),
    });
  } catch (error) {
    cleanupAfterCommand();
    throw error;
  }
}

// Dynamically import the ESM-only ASRT package. Kept in one place so the dynamic-import shape (and the ESM-in-Electron rationale above) lives in a single spot. Resolved lazily — importing this module has no side effects.
async function loadSandboxManager() {
  const mod = await import("@anthropic-ai/sandbox-runtime");
  return mod.SandboxManager;
}

// Whether initializeAsrtSandbox has run to completion in this process. This is the host-tool spawn path's gate: tool code (bash.ts/powershell.ts) asks THIS module — not the settings service — whether to route through ASRT, so the gate is decided once at boot and cannot be re-evaluated mid-run. That preserves the seal-after-boot security property the registry had: there is no runtime channel to flip the sandbox on/off after boot. Set to `true` only on a successful `initialize`; stays `false` after resetAsrtSandbox.
let active = false;
let sandboxInitializationPending = false;
let sandboxResetPending: Promise<void> | undefined;
// Set with `active` when boot initialized ASRT as the Windows proxy only.
let windowsExternalConfinement = false;

// Whether the ASRT runtime is initialized in this process. ASRT activates when the shell sandbox OR plugin-worker confinement was requested, so this alone does not say a given substrate is confined: a spawn path asks isShellSandboxActive or isPluginWorkerConfinementActive. The raw state is for the runtime's own plumbing (wrap self-gates, the shared network config refresh) and for paths that serve both kinds.
export function isAsrtSandboxActive(): boolean {
  return active;
}

/** Offline host processes always require OS isolation, independently of shell and extension routing. */
export function isOfflineProcessConfinementActive(): boolean {
  return active && !windowsExternalConfinement && getAveHomePrivacyFailure() === undefined;
}

// Host-shell spawn gate (bash / powershell tools, the workspace terminal): ASRT is active AND the shell sandbox (`features.osToolSandbox`) was requested at boot.
export function isShellSandboxActive(): boolean {
  return active && isShellSandboxRequestedAtBoot();
}

// Extension confinement status: ASRT is active AND plugin-worker confinement (`features.pluginWorkerConfinement`) was requested at boot. The shell sandbox setting never decides this.
export function isPluginWorkerConfinementActive(): boolean {
  if (getAveHomePrivacyFailure() !== undefined) return false;
  return active && isPluginWorkerConfinementRequestedAtBoot() && !windowsExternalConfinement;
}

/** What the gate answers a waiting start now, with no consent: a backend that became ready after boot confines it. */
export function probeExtensionStart(holder?: "worker"): ExtensionStartRecheck {
  try {
    assertExtensionStartAllowed(holder === undefined ? undefined : { holder });
    return "confined";
  } catch (error) {
    return isExtensionStartConsentRequired(error) ? error.unconfinedCause : "refused";
  }
}

// Refuse an extension start that nothing would confine unless a person consented to this one start.
// `backend: "mxc"` is the native entry. A legacy adapter may declare `holder: "worker"` so a selected container backend refuses it with the worker transport code (D1); every other legacy holder gets the holder-neutral native-entry refusal.
// `start` carries the per-start consent. `hostOwned` is a host process (the inference child): it has no consent route and keeps its own gate.
export function assertExtensionStartAllowed(options?: { readonly backend: "mxc" } | {
  readonly holder?: "worker";
  readonly start?: ExtensionStartPresentation;
  readonly hostOwned?: true;
}): void {
  const plan = process.platform === "win32" ? getWindowsExtensionBackendPlan() : undefined;
  const nativeEntry = options !== undefined && "backend" in options;
  const legacy = options !== undefined && "backend" in options ? undefined : options;
  if (plan?.readiness === "checking" || plan?.readiness === "rejected") {
    throw new MxcExtensionReadinessRefusedError();
  }
  if (plan?.selectedBackend === "mxc" && !nativeEntry) {
    throw legacy?.holder === "worker" ? new WorkerTransportUnsupportedError() : new MxcNativeEntryRequiredError();
  }
  if (nativeEntry && (plan?.selectedBackend !== "mxc" || plan.readiness !== "ready")) {
    throw new MxcProcessContractError("Native extension backend is not ready for this start");
  }
  // Intentionally gated by the boot request: a user who turned isolation off is not asked.
  if (process.platform !== "win32" || !isPluginWorkerConfinementRequestedAtBoot()) return;
  const waivable = !nativeEntry && legacy?.hostOwned !== true;
  const failure = getAveHomePrivacyFailure();
  // An unpublished home, a helper that gave no answer, and every start with no consent route are refused here.
  if (failure === undefined || !isAveHomePrivacyApprovable(failure.category) || !waivable) assertAveHomePrivacyForConfinement();
  if (!waivable) return;
  // An expired readiness deadline is this same no-backend ask; it keeps its reason for the card and the notice.
  const cause = failure !== undefined ? "home-privacy-unverified"
    : isPluginWorkerConfinementActive() ? undefined
      : plan?.reason === "readiness-deadline" ? "readiness-deadline" : "no-backend";
  if (cause === undefined) return;
  // No setting, rule or earlier answer stands in for it: one consent, one start.
  const start = legacy?.start;
  if (!presentExtensionStartConsent(start)) {
    throw new ExtensionStartConsentRequiredError(cause, start === undefined ? undefined : { key: start.key, identity: start.identity });
  }
}

// Reads are deny-only: allowRead only re-allows within a covering deny, so unknown paths remain readable. Project the canonical sensitive table plus trusted runtime userData and private temp/HOME roots; re-allow only each process's own private directory.
// Do not deny whole home/config/cwd/system/temp roots; use literal host-derived paths, never untrusted userData. Missing paths do not imply allow; Linux skips absent binds. Windows retains its ACL floor; private roots stay outside the write floor so each process can write its own directory.
// The Ave home is one directory deny (aveHomeReadBoundaryRoots), so its file rows are left out here; they stay on the protected floor and the write floor.
// A profile-child home's top-level children are enumerated once per composition snapshot (AveHomeBoundarySnapshot), never across commands or spawns.
export function getDefaultSensitiveReadDenyPaths(userDataDir = _baseTrustedSettings?.userDataDir): string[] {
  return sensitiveReadFloorRows(userDataDir).map((row) => row.path);
}

// The same list as policy rows: each path keeps the floor it came from.
function sensitiveReadFloorRows(userDataDir = _baseTrustedSettings?.userDataDir): PolicyFloorRow[] {
  const children = aveHomeProfileChildren();
  const seen = new Set<string>();
  return [
    ...getDefaultSensitiveDenyPaths(userDataDir, undefined, true, children).map((path) => policyFloorRow(path, "denied", "secrets", false)),
    ...aveHomeReadBoundaryDenies(children).map((path) => policyFloorRow(path, "denied", "ave-home", false)),
    ...appOwnedSandboxPrivateRoots().map((path) => policyFloorRow(path, "denied", "read-boundary", false)),
  ].filter(({ path }) => {
    const key = caseFoldForMatch(path.replace(/[\\/]+$/, ""));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Every spelling of the Ave home the sensitive table anchors to. Read-denied as a whole directory, so a child added later, a file created after a stamp, or a rename-over beneath it stays denied; a wrap re-opens only children AVE_HOME_READ_REALLOWS names.
function aveHomeReadBoundaryRoots(): string[] {
  const seen = new Set<string>();
  return [aveHome(), ...sensitiveDenyHomes().map((home) => join(home, ".ave"))].filter((root) => {
    const key = caseFoldForMatch(resolve(root));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The roots denied as one directory. On Windows a root directly beneath the OS profile is not: a stamp also denies FILE_DELETE_CHILD
// inheritably on the target's parent, and on the profile root that propagates through the whole profile and exceeds the init timeout
// (why windowsDenyTargets filters profile-child read denies). Such a home denies its top-level children instead, so the parent stamp
// lands on the home. The grant ceiling still covers every root.
function aveHomeReadBoundaryDirectoryRoots(): string[] {
  return aveHomeReadBoundaryRoots().filter((root) => !isWindowsProfileChild(root));
}

function isWindowsProfileChild(root: string): boolean {
  const profile = process.platform === "win32" ? windowsProfileHome() : undefined;
  return profile !== undefined && caseFoldForMatch(dirname(resolve(root))) === caseFoldForMatch(resolve(profile));
}

// Per profile-child home (keyed by its folded path), the top-level directories that are not wholly re-allowed, admitted through one
// native pin by the shared reparse rule. Any link, reparse point or unpinnable entry refuses; see the decision tree's Windows limit note.
function aveHomeProfileChildren(): ReadonlyMap<string, readonly string[]> {
  const roots = aveHomeReadBoundaryRoots().filter(isWindowsProfileChild);
  const snapshot = currentAveHomeBoundarySnapshot();
  if (snapshot === undefined) return projectAveHomeProfileChildren(roots);
  const key = roots.map((root) => caseFoldForMatch(resolve(root))).join("|");
  if (snapshot.taken?.key !== key) {
    try {
      snapshot.taken = { key, children: projectAveHomeProfileChildren(roots) };
    } catch (error) {
      snapshot.taken = { key, error };
    }
  }
  if ("error" in snapshot.taken) throw snapshot.taken.error;
  return snapshot.taken.children;
}

function projectAveHomeProfileChildren(roots: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const children = new Map<string, string[]>();
  for (const root of roots) {
    let names: string[] | undefined;
    try {
      names = readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AveHomeBoundaryUnverifiedError("unlisted", root, `${root} cannot be enumerated (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`, { cause: error });
      }
    }
    const candidates = (names ?? []).filter((name) => !isAveHomeReadReallowed([caseFoldForMatch(name)]));
    const [home, ...entries] = pinBoundaryFacts(root, [root, ...candidates.map((name) => join(root, name))]);
    if (home === undefined) throw new AveHomeBoundaryUnverifiedError("unlisted", root, `${root} has no pinned path facts`);
    admitBoundaryEntry(home, root, root);
    if (home.exists === false && names === undefined) {
      children.set(caseFoldForMatch(resolve(root)), []);
      continue;
    }
    if (home.exists !== true || !home.directory || names === undefined) {
      throw new AveHomeBoundaryUnverifiedError("unlisted", root, `${root} changed or is not a directory during enumeration`);
    }
    children.set(caseFoldForMatch(resolve(root)), candidates.filter((name, index) => {
      const entry = entries[index];
      if (entry === undefined) throw new AveHomeBoundaryUnverifiedError("unlisted", root, `${join(root, name)} has no pinned path facts`);
      admitBoundaryEntry(entry, root, join(root, name));
      if (entry.exists !== true) throw new AveHomeBoundaryUnverifiedError("unlisted", root, `${join(root, name)} vanished during enumeration`);
      return entry.directory;
    }));
  }
  return children;
}

function admitBoundaryEntry(facts: WindowsPathFacts, home: string, path: string): void {
  if (facts.exists === null) throw new AveHomeBoundaryUnverifiedError("unlisted", home, `${path} cannot be pinned (the native walk stopped above it)`);
  if (admitWindowsReparse(facts) !== true) throw new AveHomeBoundaryUnverifiedError("link", home, `${path} is, or lies beneath, a link or reparse point`);
}

function pinBoundaryFacts(home: string, paths: readonly string[]): readonly WindowsPathFacts[] {
  try {
    return pinWindowsPaths(paths);
  } catch (error) {
    throw new AveHomeBoundaryUnverifiedError("unlisted", home, `path facts are unavailable for ${paths.length} entries`, { cause: error });
  }
}

// A confined launch refused because a profile-child Ave home's read boundary cannot be projected; `reason` says whether a link or
// reparse point, or an unlistable home, caused it. Boot maps it to the AVE_HOME privacy refusal (aveHomeBoundaryFailure).
class AveHomeBoundaryUnverifiedError extends Error {
  readonly code = AVE_HOME_BOUNDARY_UNVERIFIED_ERROR_CODE;
  constructor(readonly reason: "link" | "unlisted", readonly home: string, detail: string, options?: ErrorOptions) {
    super(`sandbox: refusing confinement, the Ave home read boundary cannot be projected: ${detail}`, options);
    this.name = "AveHomeBoundaryUnverifiedError";
  }
}

// Each directory root, and each denied top-level child of a profile-child home.
function aveHomeReadBoundaryDenies(children: ReadonlyMap<string, readonly string[]> = aveHomeProfileChildren()): string[] {
  return [
    ...aveHomeReadBoundaryDirectoryRoots(),
    ...aveHomeReadBoundaryRoots().flatMap((root) => (children.get(caseFoldForMatch(resolve(root))) ?? []).map((name) => join(root, name))),
  ].map((path) => (process.platform === "win32" ? path.replace(/[\\/]+$/, "") + sep : path));
}

// The same denies as bare paths, for the composers that treat them as re-openable masks.
function aveHomeReadBoundaryMasks(): string[] {
  return aveHomeReadBoundaryDenies().map((path) => path.replace(/[\\/]+$/, ""));
}

// The Ave home root covering `path` when `path` is that root or lies outside every re-allowed child.
export function aveHomeReadBoundaryCovering(path: string): string | undefined {
  return aveHomeReadBoundaryMatcher()(canonicalizePathForMatch(path));
}

function aveHomeReadBoundaryMatcher(): (canonicalPath: string) => string | undefined {
  // The deepest root decides: an Ave home relocated beneath another spelling is judged by its own re-allowed children.
  const roots = aveHomeReadBoundaryRoots()
    .map((root) => ({ root, key: caseFoldForMatch(canonicalizePathForMatch(root)).replace(/\/+$/, "") }))
    .sort((left, right) => right.key.length - left.key.length);
  const sessionId = currentAveHomeBoundarySnapshot()?.sessionId;
  return (canonicalPath) => {
    const folded = caseFoldForMatch(canonicalPath);
    const owner = roots.find(({ key }) => folded === key || folded.startsWith(`${key}/`));
    if (owner === undefined) return undefined;
    if (folded === owner.key) return owner.root;
    const segments = folded.slice(owner.key.length + 1).split("/");
    if (!isAveHomeReadReallowed(segments)) return owner.root;
    // Beneath `worktrees` the ceiling row is open only to the session this composition is for, and only for the stage workspace it is bound to.
    return segments[0] === "worktrees" && !isBoundStageWorkspacePath(sessionId, canonicalPath) ? owner.root : undefined;
  };
}

// Only builtin shell workloads receive primary saved-history read access. Per-command read denies replace the shared runtime floor, so this projection carries every other default deny as well as the grant's nested exclusions.
export function getBuiltinShellSessionReadPolicy(
  ...args: Parameters<typeof getBuiltinShellSessionReadPolicyInSnapshot>
): ReturnType<typeof getBuiltinShellSessionReadPolicyInSnapshot> {
  return inAveHomeBoundarySnapshot(undefined, () => getBuiltinShellSessionReadPolicyInSnapshot(...args));
}

function getBuiltinShellSessionReadPolicyInSnapshot(userDataDir = _baseTrustedSettings?.userDataDir): {
  readonly allowRead: readonly string[];
  readonly denyRead: readonly string[];
} {
  const sessionPolicy = getConfiguredSessionReadPolicy();
  const sessionRoot = sessionPolicy.allowRead[0];
  const children = aveHomeProfileChildren();
  const otherDenies = [
    ...getDefaultSensitiveDenyPaths(userDataDir, sessionRoot, true, children),
    ...(_baseTrustedSettings?.denyRead ?? []),
  ];
  // A session allowance must not carve into another protected namespace or a trusted custom deny.
  if (sessionRoot !== undefined && readDenyCovering(otherDenies)(sessionRoot) !== undefined) {
    return Object.freeze({
      allowRead: Object.freeze([]),
      denyRead: Object.freeze([...getDefaultSensitiveReadDenyPaths(userDataDir), ...(_baseTrustedSettings?.denyRead ?? [])]),
    });
  }
  // The session root is a re-allowed child of the Ave home boundary, so the boundary joins after the carve check.
  return Object.freeze({
    allowRead: sessionPolicy.allowRead,
    denyRead: Object.freeze([...otherDenies, ...aveHomeReadBoundaryDenies(children), ...sessionPolicy.denyRead]),
  });
}

// Compose broad invocation reads while retaining protected host/private paths. `sandboxHome` is the invocation's own sandbox HOME. The sandbox private roots are read-denied like the rest of the floor, and a read grant under them is dropped — a working directory there must not reopen another process's HOME — except the invocation's own HOME and what is inside it.
export function getBuiltinShellReadPolicy(
  readPaths: readonly string[],
  hostHome: string | undefined,
  sandboxHome?: string,
  boundarySnapshot?: AveHomeBoundarySnapshot,
): {
  readonly allowRead: readonly string[];
  readonly denyRead: readonly string[];
  // The saved-session grant, the one read the shell holds inside the floor.
  readonly floorPierces: readonly string[];
} {
  void hostHome;
  return inAveHomeBoundarySnapshot(boundarySnapshot, () => composeBuiltinShellReadPolicy(readPaths, sandboxHome));
}

function composeBuiltinShellReadPolicy(readPaths: readonly string[], sandboxHome: string | undefined): ReturnType<typeof getBuiltinShellReadPolicy> {
  const sessions = getBuiltinShellSessionReadPolicy();
  const privateRoots = appOwnedSandboxPrivateRoots();
  const ownHome = sandboxHome === undefined ? undefined : canonicalizePathForMatch(sandboxHome);
  // Refusing saved-session access restates private roots too. Those roots still
  // allow this invocation's own HOME; an explicit protected deny keeps priority.
  const protectedDenies = new Set(getProtectedReadDenyPaths());
  const boundaryDenies = new Set(aveHomeReadBoundaryDenies());
  const sessionDenyCovering = readDenyCovering(sessions.denyRead.filter((denied) =>
    (!privateRoots.includes(denied) || protectedDenies.has(denied)) && !boundaryDenies.has(denied)));
  const privateRootCovering = readDenyCovering(privateRoots);
  const boundaryCovering = aveHomeReadBoundaryMatcher();
  const allowRead = [...readPaths, ...sessions.allowRead].filter((path) => {
    const resolved = canonicalizePathForMatch(path);
    // An explicit working directory must not reopen protected user data or a custom deny when removing a broader ancestor changes native rule order.
    if (sessionDenyCovering(resolved) !== undefined) return false;
    // Inside the Ave home only a re-allowed child is granted.
    if (boundaryCovering(resolved) !== undefined) return false;
    const insideOwnHome = ownHome !== undefined && (resolved === ownHome || resolved.startsWith(`${ownHome}/`));
    if (!insideOwnHome && privateRootCovering(resolved) !== undefined) return false;
    return true;
  });
  return Object.freeze({
    allowRead: Object.freeze(allowRead),
    denyRead: Object.freeze([...sessions.denyRead, ...privateRoots]),
    floorPierces: sessions.allowRead,
  });
}

// The protected read-deny floor every wrap is held to: the sensitive paths, the exact user data directory the sandbox was configured with, and the trusted custom denies. Two things restated with it are not part of it: a configured session read exceptions, and the sandbox private roots (appOwnedSandboxPrivateRoots), under which every wrap is granted its own temp directory and HOME by design.
function getProtectedReadDenyPaths(
  userDataDir = _baseTrustedSettings?.userDataDir,
  customDenies = _baseTrustedSettings?.denyRead,
): readonly string[] {
  return [...getDefaultSensitiveDenyPaths(userDataDir), ...(customDenies ?? [])];
}

// The protected read-deny floor, for a confinement layer that ranks its own lists (Windows MXC, `mxc-windows.ts` `rankMxcFilesystem`): a grant beneath one of these is dropped there, as ASRT drops it on every platform.
export function getProtectedReadDenyFloor(): readonly string[] {
  return getProtectedReadDenyPaths();
}

// The protected read deny covering `path`, if any. A plugin's chosen directory is refused when one does: its read half would re-allow the deny on every platform, and on Linux its write half would too.
export function protectedReadDenyCovering(path: string, floor: readonly FilesystemPathEntry[] = getProtectedReadDenyPaths()): string | undefined {
  return protectedReadDenyMatcher(floor)(path);
}

// protectedReadDenyCovering for many paths against one floor: each entry compiles once, not once per path and ancestor.
export function protectedReadDenyMatcher(floor: readonly FilesystemPathEntry[] = getProtectedReadDenyPaths()): (path: string) => string | undefined {
  const covering = readDenyCovering(floor);
  return (path) => covering(canonicalizePathForMatch(path));
}

// Keep write roots from reopening reads the floor denies. Seatbelt keeps a write grant write-only, but bubblewrap grants a write by binding the host directory read-write over the deny's tmpfs mask, which exposes everything under it. So on Linux a write root covered by the floor is not granted, for every wrap: the user's shell, plugin children and workers, bundled hooks, MCP stdio servers and the terminal all reach ASRT through buildPerCommandSandboxCustomConfig, and the shared config through buildSandboxConfig. macOS keeps the root, since the grant stays write-only there. Ordinary working trees remain writable.
function writeRootsOutsideReadDenies(roots: readonly string[], floor: readonly string[]): string[] {
  if (process.platform !== "linux") return [...roots];
  return withholdUnder(roots, floor, [], "write root");
}

// The only reads a wrap may ask to hold inside the floor: the configured saved-session root and a host directory catalog row that pierces the floor. Exact user hook files are checked separately when a wrap names its pierces. A ceiling, not a grant — each wrap names its own in `floorPierces`.
function floorPierceCeiling(): string[] {
  return [...getConfiguredSessionReadPolicy().allowRead, ...hostDirectoryFloorPierces()]
    .map((path) => canonicalizePathForMatch(path));
}

// Only regular files physically beneath the hook directory can pierce its read floor.
function isHookScriptRead(path: string): boolean {
  const canonical = resolve(canonicalizePathForMatch(path));
  const root = caseFoldForMatch(resolve(defaultHooksDir()));
  if (!caseFoldForMatch(canonical).startsWith(`${root}${sep}`)) return false;
  try {
    return lstatSync(canonical).isFile();
  } catch {
    return false;
  }
}

// An `allowRead` entry re-allows inside a covering deny on both platforms, so one under the floor re-opens it. It is not granted unless it lies inside one of this wrap's own `floorPierces`. A wrap's own temp directory and HOME sit under the private roots, which are not floor. A pierce outside the ceiling is a composer bug and fails the wrap.
function readGrantsOutsideReadDenies(
  grants: readonly string[],
  floor: readonly string[],
  floorPierces: readonly string[],
): string[] {
  const ceiling = floorPierceCeiling();
  for (const pierce of floorPierces) {
    if (!ceiling.includes(canonicalizePathForMatch(pierce)) && !isHookScriptRead(pierce)) {
      throw new Error(`sandbox: ${pierce} is not a read the host lets re-open the protected floor`);
    }
  }
  return withholdUnder(grants, floor, floorPierces, "read grant");
}

function withholdUnder(
  paths: readonly string[],
  floor: readonly string[],
  pierces: readonly string[],
  kind: string,
): string[] {
  const canonicalPierces = pierces.map((pierce) => canonicalizePathForMatch(pierce));
  const floorCovering = paths.length === 0 ? () => undefined : readDenyCovering(floor);
  // The Ave home boundary is a ceiling over every wrap: a grant there re-opens the root deny unless it is a re-allowed child.
  const boundaryCovering = paths.length === 0 ? () => undefined : aveHomeReadBoundaryMatcher();
  return paths.filter((path) => {
    const resolved = canonicalizePathForMatch(path);
    const denied = floorCovering(resolved) ?? boundaryCovering(resolved);
    if (denied === undefined) return true;
    if (canonicalPierces.some((pierce) => resolved === pierce || resolved.startsWith(`${pierce}/`))) return true;
    // Withheld silently, a later EACCES/EROFS/ENOENT in the child would have no visible cause.
    log.debug({ path, deny: denied }, `sandbox: ${kind} withheld under the protected read floor`);
    return false;
  });
}

// readDenyCoversPath over a fixed list: the first entry, in list order, that covers a path. Each entry is canonicalized and compiled once per call of this function instead of once per tested path and ancestor, so a check of P paths against D entries costs D compiles, not P x D x depth.
function readDenyCovering(denied: readonly FilesystemPathEntry[]): (canonicalPath: string) => string | undefined {
  // Compiled on first use, as readDenyCoversPath reaches an entry only when no earlier one covered the path.
  const matchers = new Map<number, (candidate: string) => boolean>();
  const matcher = (index: number, entry: FilesystemPathEntry): (candidate: string) => boolean => {
    let match = matchers.get(index);
    if (match === undefined) {
      if (typeof entry === "string") {
        match = compileGlobMatcher(canonicalizePathForMatch(expandLeadingTilde(entry)));
      } else {
        const literal = canonicalizePathForMatch(entry.path).replace(/\/+$/, "");
        match = candidate => candidate === literal;
      }
      matchers.set(index, match);
    }
    return match;
  };
  return (canonicalPath) => {
    const candidates: string[] = [];
    for (let candidate = canonicalPath; ; candidate = dirname(candidate)) {
      candidates.push(candidate);
      if (dirname(candidate) === candidate) break;
    }
    for (let index = 0; index < denied.length; index += 1) {
      const entry = denied[index]!;
      if (typeof entry === "string" && (/[\[\]]/.test(entry) || (process.platform === "win32" && entry.includes("%")))) return entry;
      const match = matcher(index, entry);
      if (candidates.some((candidate) => match(candidate) || match(`${candidate}/`))) return typeof entry === "string" ? entry : entry.path;
    }
    return undefined;
  };
}

// Use the shared policy grammar; unrepresented runtime patterns keep the deny.
function readDenyCoversPath(denied: string, canonicalPath: string, normalized = false): boolean {
  // Native patterns additionally support character classes and, on Windows, environment references. Do not claim a safe carve-out from those forms.
  if (/[\[\]]/.test(denied) || (process.platform === "win32" && denied.includes("%"))) return true;
  const pattern = normalized ? denied : canonicalizePathForMatch(expandLeadingTilde(denied));
  for (let candidate = canonicalPath; ; candidate = dirname(candidate)) {
    if (globMatch(candidate, pattern) || globMatch(`${candidate}/`, pattern)) return true;
    if (dirname(candidate) === candidate) return false;
  }
}

function sensitiveDenyHomes(): string[] {
  return policyHomeAnchors();
}

// The Electron userData dirs to deny: the exact dir when a trusted caller provides it; otherwise derived from each policy home and the platform layout, without a desktop runtime import — safe for any non-renderer context. On win32 each carries its trailing separator so srt-win never materializes the deny as an empty file.
function electronUserDataDirs(userDataDir: string | undefined, homes: readonly string[]): string[] {
  if (userDataDir !== undefined) {
    return [process.platform === "win32" ? userDataDir.replace(/[/\\]+$/, "") + sep : userDataDir];
  }
  return homes.map((home) =>
    (process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Ave")
      : process.platform === "win32"
        ? join(home, "AppData", "Roaming", "Ave") + sep
        : join(
            // Linux: honor XDG_CONFIG_HOME, mirroring Electron's own resolution.
            process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
            "Ave",
          )));
}

const POSIX_CRON_DENIES = [
  "/usr/lib/cron/tabs", // macOS user crontab spool
  "/var/spool/cron/crontabs", // Linux (Debian/Ubuntu) user crontab spool
  "/var/spool/cron", // Linux (RHEL/Fedora) user crontab spool
  "/etc/cron.d", // system cron drop-in dir
] as const;
const POSIX_ASRT_TEMP_DENIES = ["/tmp/claude", "/private/tmp/claude"] as const;

// The directories among the write-persistence denies (see getDefaultSensitiveWriteDenyPaths).
function writePersistenceDirectories(homes: readonly string[]): string[] {
  return [
    ...(process.platform === "win32" ? srtWinPrivateDirectories() : []),
    ...homes.flatMap((home) => [
      join(home, ".config"),
      join(home, "Library", "LaunchAgents"),
      join(home, ".npm", "_logs"),
      join(home, ".claude", "debug"),
    ]),
    dirname(dirname(getVendoredSrtWinExePath())),
  ];
}

// The Windows user profile, or undefined when it cannot be resolved. A drive root or other non-home value is rejected: treating `C:\` as the profile would prune every deny on the drive that no grant overlaps.
function windowsProfileHome(): string | undefined {
  let home: string;
  try {
    home = homedir();
  } catch {
    return undefined;
  }
  return isHomeAnchor(home, process.platform) ? home : undefined;
}

function windowsMachineRoots(): string[] {
  const drive = process.env.SystemDrive ?? "C:";
  return [
    process.env.ProgramData ?? "C:\\ProgramData",
    process.env.ProgramFiles ?? `${drive}\\Program Files`,
    process.env["ProgramFiles(x86)"] ?? `${drive}\\Program Files (x86)`,
    process.env.ProgramW6432, process.env.CommonProgramFiles,
    process.env["CommonProgramFiles(x86)"], process.env.CommonProgramW6432,
    process.env.SystemRoot ?? process.env.windir ?? `${drive}\\Windows`, process.env.windir,
  ].filter((path): path is string => Boolean(path));
}

function assertWindowsMachineRootWriteGrants(grants: readonly string[]): void {
  if (process.platform !== "win32") return;
  for (const grant of grants) {
    // Preserve requested pattern breadth as well as pinned literal identity. A `**` tail also matches its base.
    const normalized = normalizePathForSandbox(grant);
    const pattern = containsGlobCharsWin(normalized);
    const base = pattern ? globPatternBaseDir(toForwardSlashes(normalized)).replace(/^([A-Za-z]:)?$/, "$1/").replace(/\//g, "\\") : grant;
    for (const root of windowsMachineRoots()) {
      if (!isGrantPathWithin(base, root)) continue;
      if (!pattern || !isGrantPathWithin(root, base) || normalized.includes("**")) {
        throw new Error(`Windows write grant ${grant} contains machine root ${root}`);
      }
    }
  }
}

async function gatherWindowsReadDenyEvidence(
  settings: TrustedSandboxSettings,
  paths: readonly string[] = [],
  snapshot?: WindowsReadDenySnapshot,
): Promise<WindowsReadDenySnapshot | undefined> {
  if (process.platform !== "win32") return undefined;
  const profile = windowsProfileHome();
  if (profile === undefined) return undefined;
  const targets = [...getDefaultSensitiveReadDenyPaths(settings.userDataDir), ...(settings.denyRead ?? []), ...paths];
  const candidates = targets.filter(path => {
    if (containsGlobCharsWin(path)) return false;
    try { return isGrantPathWithin(profile, path); }
    catch { return true; }
  });
  const uncovered = [...new Map(candidates.filter(path => !snapshot?.has(windowsReadDenyKey(path)))
    .map(path => [windowsReadDenyKey(path), path])).values()];
  if (uncovered.length === 0) return snapshot ?? new Map();
  const evidence = await readWindowsReadDenyEvidence(uncovered);
  return snapshot === undefined ? evidence : new Map([...snapshot, ...evidence]);
}

const windowsReadDenyWarnings = new Set<string>();
const windowsAbsentDenyWarnings = new Set<string>();
const windowsDenyStatWarnings = new Set<string>();
const windowsProfileReadDenyWarnings = new Map<string, NonNullable<SandboxWindowsStatusInfo["profileReadDenyWarnings"]>[number]>();

export function getWindowsProfileReadDenyWarnings(): SandboxWindowsStatusInfo["profileReadDenyWarnings"] {
  return [...windowsProfileReadDenyWarnings.values()].map(row => ({ ...row, ...(row.principals ? { principals: [...row.principals] } : {}) }));
}

function keepWindowsProfileReadDeny(path: string, profile: string, evidence: WindowsReadDenyEvidence): boolean {
  const key = windowsReadDenyKey(path);
  if (evidence.status === "missing" || evidence.status === "private") {
    windowsProfileReadDenyWarnings.delete(key);
    return false;
  }
  const parent = dirname(path.replace(/[\\/]+$/, ""));
  const profileParent = caseFoldForMatch(parent) === caseFoldForMatch(profile);
  if (profileParent) {
    windowsProfileReadDenyWarnings.set(key, { path: path.replace(/[\\/]+$/, ""),
      ...(evidence.status === "readable" && evidence.principals?.length ? { principals: evidence.principals } : {}) });
  }
  const reason = evidence.reason ?? evidence.status;
  const keep = evidence.status === "error" || evidence.status === "reparse" || !profileParent;
  if (!windowsReadDenyWarnings.has(key)) {
    windowsReadDenyWarnings.add(key);
    log.warn(`[sandbox-profile-read-deny] ${keep ? "Keeping" : "Filtering"} ${path}: ${evidence.principals?.join(", ") ?? reason}${profileParent ? "; profile-root stamping cannot protect this target" : ""}`);
  }
  return keep;
}

function posixOnlyDenyPaths(): Set<string> {
  return new Set([
    ...SENSITIVE_PATH_ENTRIES.filter(entry => entry.anchor === "root").map(entry => "/" + entry.segments.join("/")),
    ...POSIX_CRON_DENIES, ...POSIX_ASRT_TEMP_DENIES,
  ]);
}

function expandedWindowsDenyGrants(
  grants: readonly FilesystemPathEntry[],
  profile: string | undefined,
  preserveLiterals = false,
): string[] {
  // Match runtime home expansion before judging whether a deny is disjoint.
  return grants.flatMap((entry) => {
    if (preserveLiterals && typeof entry !== "string") return [entry.path];
    const raw = expandWindowsEnvRefs(typeof entry === "string" ? entry : entry.path);
    const grant = profile === undefined ? raw : raw === "~" ? profile : /^~[\\/]/.test(raw) ? profile + raw.slice(1) : raw;
    if (typeof entry !== "string" && entry.literal) return [grant];
    const spelling = stripExtendedPathPrefix(grant);
    const uncertain = /[\0%]|~\d+(?:\.|[\\/]|$)/.exec(spelling);
    const pattern = containsGlobCharsWin(spelling) ? /[*?]/.exec(spelling) : null;
    const boundary = Math.min(uncertain?.index ?? spelling.length, pattern?.index ?? spelling.length);
    if (boundary === spelling.length) return [grant];
    const prefix = spelling.slice(0, boundary);
    // An unresolved pattern can reach its static directory, never every unrelated row.
    return [grant, /[\\/]$/.test(prefix) ? prefix : dirname(prefix)];
  });
}

// Stamping changes parent DACLs; never stamp the profile root for a disjoint read deny.
function windowsDenyTargets<T extends FilesystemPathEntry>(
  entries: readonly T[],
  userDataDir: string | undefined,
  grants: readonly FilesystemPathEntry[],
  writeGrants: readonly FilesystemPathEntry[],
  kind: "read" | "write",
  readDenyEvidence?: WindowsReadDenySnapshot,
): (T | string)[] {
  if (process.platform !== "win32") return [...entries];
  // Reuse identities only within this deny decision; the next rebuild observes filesystem changes again.
  const canonicalPaths = new Map<string, string>();
  const canonicalize = (path: string): string => {
    const known = canonicalPaths.get(path);
    if (known !== undefined) return known;
    const canonical = canonicalizePathForMatch(path);
    canonicalPaths.set(path, canonical);
    return canonical;
  };
  const grantWithin = (root: string, path: string): boolean => isGrantPathWithin(root, path, canonicalize);
  let machineRoots: readonly string[] | undefined;
  try {
    const roots = windowsMachineRoots();
    if (!roots.some(root => /[\0*?\[\]%]|~\d+(?:\.|[\\/]|$)/.test(stripExtendedPathPrefix(root)))) {
      machineRoots = roots.map(root => caseFoldForMatch(canonicalize(root)).replace(/\/+$/, ""));
    }
  } catch {
    // An unproven machine-root identity must never remove a deny.
  }
  // Only the OS profile qualifies for omission; a HOME elsewhere or an unresolved profile keeps every row.
  const profile = windowsProfileHome();
  const expandedGrants = expandedWindowsDenyGrants(grants, profile);
  const expandedWriteGrants = expandedWindowsDenyGrants(writeGrants, profile, kind === "write");
  const retainedMachineRows = new Set<T>();
  const expandedPaths = new Map<T, string>();
  entries = entries.filter((entry) => {
    try {
      const raw = typeof entry === "string" ? entry : entry.path;
      const path = stripExtendedPathPrefix(kind === "write" && typeof entry !== "string" ? raw : expandWindowsEnvRefs(expandLeadingTilde(raw)));
      expandedPaths.set(entry, path);
      if (machineRoots === undefined) {
        retainedMachineRows.add(entry);
        return true;
      }
      const identity = caseFoldForMatch(canonicalize(path));
      const containingRoots = machineRoots.filter(root => identity === root || identity.startsWith(`${root}/`));
      if (containingRoots.length === 0) return true;
      const retained = kind === "read" || /[\0*?\[\]%]|~\d+(?:\.|[\\/]|$)/.test(stripExtendedPathPrefix(path))
        || !containingRoots.some((root) =>
          !expandedGrants.some((grant) => (grantWithin(grant, path) || grantWithin(path, grant)) && !grantWithin(grant, root)));
      if (retained) retainedMachineRows.add(entry);
      return retained;
    } catch {
      // An unproven identity must never remove a deny.
      retainedMachineRows.add(entry);
      return true;
    }
  });
  const literals = entries.filter((entry) => typeof entry !== "string")
    .filter(entry => (retainedMachineRows.has(entry) && !expandedPaths.has(entry)) || keepWindowsDenyTarget(entry, expandedPaths.get(entry)!, expandedWriteGrants, grantWithin));
  const paths = entries.filter((entry): entry is T & string => typeof entry === "string");
  const homes = sensitiveDenyHomes();
  const aveHomes = [aveHome(), ...homes.map((home) => join(home, ".ave"))];
  const directories = new Set(
    [
      ...SENSITIVE_PATH_ENTRIES.filter((entry) => entry.kind === "dir" && entry.anchor !== "root").flatMap((entry) =>
        (entry.anchor === "ave-home" ? aveHomes : homes).map((home) => join(home, ...entry.segments)),
      ),
      ...electronUserDataDirs(userDataDir, homes).map((path) => path.replace(/[\\/]+$/, "")),
      ...aveHomeReadBoundaryRoots().map((path) => path.replace(/[\\/]+$/, "")), ...aveHomeReadBoundaryMasks(),
      ...writePersistenceDirectories(homes),
    ].map(path => caseFoldForMatch(path.replaceAll("\\", "/"))),
  );
  const posixRooted = posixOnlyDenyPaths();
  const checkedReadEvidence = kind === "read" && readDenyEvidence !== undefined
    ? HOST_PLATFORM === "win32"
      ? recheckWindowsReadDenyEvidence([...expandedPaths.values()], readDenyEvidence)
      : readDenyEvidence
    : undefined;
  return paths
    .filter((path) => !posixRooted.has(path))
    .filter((original) => {
      const path = expandedPaths.get(original) ?? original;
      try {
        // Use admission's canonical identity, including links and native aliases. Patterns and unresolved short names cannot prove disjointness.
        if ([path].some((candidate) => /[\0*?\[\]%]|~\d+(?:\.|[\\/]|$)/
          .test(candidate.replace(/^\\\\\?\\/, "")))) return true;
        return profile === undefined || !grantWithin(profile, path)
          || expandedGrants.some((grant) => grantWithin(grant, path) || grantWithin(path, grant))
          || (kind === "read" && keepWindowsProfileReadDeny(path, profile,
            checkedReadEvidence?.get(windowsReadDenyKey(path)) ?? windowsReadDenyEvidence(path, readDenyEvidence)));
      } catch {
        // An unproven identity must never remove a deny.
        return true;
      }
    })
    .filter(path => (retainedMachineRows.has(path) && !expandedPaths.has(path)) || keepWindowsDenyTarget(path, expandedPaths.get(path)!, expandedWriteGrants, grantWithin))
    .map((path): T | string => (!/[\\/]$/.test(path) && directories.has(caseFoldForMatch(path.replaceAll("\\", "/"))) ? `${path}\\` : path))
    .concat(literals);
}

function keepWindowsDenyTarget(
  entry: FilesystemPathEntry,
  expanded: string,
  expandedGrants: readonly string[],
  grantWithin: (root: string, path: string) => boolean,
): boolean {
  const path = typeof entry === "string" ? entry : entry.path;
  if (isUncPath(expanded) || ((typeof entry === "string" || !entry.literal) && containsGlobCharsWin(expanded))) return true;
  const target = resolve(toForwardSlashes(expanded));
  let reachingGrants: readonly string[];
  try {
    reachingGrants = expandedGrants.filter(grant => grantWithin(grant, target) || grantWithin(target, grant));
  } catch {
    // An unproven grant identity cannot justify leaving a target unprotected.
    reachingGrants = expandedGrants;
  }
  let present: boolean;
  try {
    present = lstatSync(target, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      const key = windowsReadDenyKey(target);
      if (!windowsDenyStatWarnings.has(key)) {
        windowsDenyStatWarnings.add(key);
        log.warn(`[sandbox-deny-target] Keeping ${path}: stat failed (${code ?? "unknown"})`);
      }
      return true;
    }
    present = false;
  }
  if (!present) {
    // Never hand an absent row to the native stamp: it would create it. A reachable row is watched instead.
    if (reachingGrants.length > 0) {
      watchAbsentProtectedRow(target, reachingGrants);
      return false;
    }
    const key = windowsReadDenyKey(target);
    if (!windowsAbsentDenyWarnings.has(key)) {
      windowsAbsentDenyWarnings.add(key);
      log.warn(`[sandbox-deny-target] Filtering ${path}: absent at stamp time`);
    }
  }
  return present;
}

// `readProjection` leaves out the Ave home file rows a boundary deny covers: all of them under a directory root, and those inside a
// denied top-level child of a profile-child home (`profileChildren`). Root files of a profile-child home keep their rows.
function getDefaultSensitiveDenyPaths(
  userDataDir: string | undefined,
  readablePrimarySessionRoot?: string,
  readProjection = false,
  profileChildren: ReadonlyMap<string, readonly string[]> = new Map(),
): string[] {
  const homes = sensitiveDenyHomes();
  const ave = aveHome();
  const aveHomes = [ave, ...homes.map((home) => join(home, ".ave"))];
  const directoryRoots = new Set(readProjection ? aveHomeReadBoundaryDirectoryRoots().map((root) => caseFoldForMatch(resolve(root))) : []);
  const coveredFileRow = (home: string, segments: readonly string[]): boolean => {
    const key = caseFoldForMatch(resolve(home));
    if (directoryRoots.has(key)) return true;
    const denied = profileChildren.get(key);
    if (denied === undefined || segments.length <= 1) return false;
    const child = segments[0];
    if (child === undefined) throw new Error("Ave home file row has no top-level segment");
    return denied.some((name) => caseFoldForMatch(name) === caseFoldForMatch(child));
  };
  // Electron userData dir — see electronUserDataDirs.
  const electronUserData = electronUserDataDirs(userDataDir, homes);
  const raw = [
    // The sensitive-path table, projected to literal absolute paths Projected from the single authority, SENSITIVE_PATH_ENTRIES in src/permissions/sensitive-paths.ts, which the in-process host-tool guard projects into globs. Do NOT hand-add a `join(home, …)` entry here — add a row to that table and BOTH surfaces deny it.
    ...SENSITIVE_PATH_ENTRIES.filter((entry) => sensitiveEntryOnSandboxFloor(entry)).flatMap((entry) => {
      let paths: string[];
      switch (entry.anchor) {
        case "ave-home":
          paths = (readProjection && entry.kind === "file"
            ? aveHomes.filter((home) => !coveredFileRow(home, entry.segments)) : aveHomes)
            .map((home) => join(home, ...entry.segments));
          break;
        case "home":
          paths = homes.map((home) => join(home, ...entry.segments));
          break;
        case "root":
          // POSIX-rooted (`/etc/…`). Kept literal rather than `join`ed so the string stays a seatbelt/bwrap subpath on the platforms that have it. On win32 srt-win would create it on the current drive, so windowsDenyTargets drops it at the ASRT boundary.
          paths = ["/" + entry.segments.join("/")];
          break;
        default: {
          // Fail closed: an unrecognised anchor must not silently push `undefined` into the deny list ASRT is configured from.
          const exhaustive: never = entry.anchor;
          throw new Error(
            `sensitive-path entry has an unknown anchor: ${String(exhaustive)}`,
          );
        }
      }
      // A missing directory leaf needs its separator to avoid a file placeholder.
      return paths.filter((path) => {
        if (readablePrimarySessionRoot === undefined || entry.anchor !== "ave-home" || entry.access !== "read-only") return true;
        return caseFoldForMatch(canonicalizePathForMatch(path)) !== caseFoldForMatch(readablePrimarySessionRoot);
      }).map((path) => process.platform === "win32" && entry.kind === "dir" && entry.anchor !== "root"
        // A POSIX-rooted row never reaches srt-win (windowsDenyTargets drops it by its exact spelling), so it keeps that spelling.
        ? path + sep : path);
    }),
    // Operator-selected external keys can live inside a granted workspace. Keep the same frozen literal targets as the in-process host guard.
    ...getRuntimeSensitiveKeyPaths(),
    // Electron userData dir (whole dir — deny-by-default for future artefacts) Contains plugin OAuth session cookies/tokens, Cookies (SQLite), Local/Session Storage, Network Persistent State, Trust Tokens, ave-secrets.json. Not a table row: the EXACT dir is only knowable at runtime from `app.getPath("userData")`. The host guard pins the per-platform DEFAULT locations as static globs in SENSITIVE_PATH_PATTERNS instead.
    ...electronUserData,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    // Lexical key: a link alias is a separate spelling the sandbox must deny.
    const key = caseFoldForMatch(resolve(p));
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

const WINDOWS_PROFILE_WRITE_FLOOR_ERROR = "Windows profile write floor could not establish all profile paths";

function windowsProfileWriteDenies(homes: readonly string[], resolveDocumentsPath: (() => string) | undefined) {
  const roots = homes.map(home => win32.join(home, "Documents"));
  let bounded = true;
  if (resolveDocumentsPath !== undefined) {
    try {
      const path = stripExtendedPathPrefix(resolveDocumentsPath());
      if (/^[a-z]:[\\/]/i.test(path) && !/[\0\r\n*?:]/.test(path.slice(2))) roots.push(win32.normalize(path));
      // Direct UNC paths cannot be reached by local filesystem grants.
      else if (!isUncPath(path)) bounded = false;
    } catch {
      bounded = false;
    }
  }
  const paths = roots.flatMap(root => ["WindowsPowerShell", "PowerShell"].flatMap(engine =>
    ["profile.ps1", "Microsoft.PowerShell_profile.ps1"].flatMap(name => {
      const path = win32.join(root, engine, name);
      if (isUncPath(path)) return [path];
      try {
        const physical = HOST_PLATFORM === "win32" ? projectLocalWindowsFilesystemPath(path, MAX_WALK_UP) : resolvePathForPolicy(path);
        return [path, stripExtendedPathPrefix(physical)];
      } catch {
        bounded = false;
        return [path];
      }
    })));
  return { paths, bounded };
}

// The write floor overrides write grants and includes sensitive stores, saved conversations and persistence/re-exec paths, including config, shell startup and scheduler files; reading secrets alone does not prevent sandbox escape through later execution.
// Use literal host-derived paths without allow-if-missing behavior. Project the sensitive table directly, excluding private temp/HOME roots that each process must write; unlike read policy, config-wide write denial is deliberate.
export function getDefaultSensitiveWriteDenyPaths(
  userDataDir = _baseTrustedSettings?.userDataDir,
  resolveDocumentsPath?: () => string,
): string[] {
  return spelledPathEntries(getDefaultSensitiveWriteDenyEntries(userDataDir, resolveDocumentsPath), "denyWrite");
}

export function getDefaultSensitiveWriteDenyEntries(
  userDataDir = _baseTrustedSettings?.userDataDir,
  resolveDocumentsPath = scopedWindowsDocumentsPath() ?? sandboxSession?.sharedWindowsDocumentsPath ?? _baseTrustedSettings?.resolveWindowsDocumentsPath,
): FilesystemPathEntry[] {
  const floor = buildSensitiveWriteFloor(userDataDir, resolveDocumentsPath);
  if (!floor.bounded) throw new Error(WINDOWS_PROFILE_WRITE_FLOOR_ERROR);
  return floor.entries;
}

function buildSensitiveWriteFloor(userDataDir: string | undefined, resolveDocumentsPath: (() => string) | undefined) {
  const homes = sensitiveDenyHomes();
  const readDeny = getDefaultSensitiveDenyPaths(userDataDir);
  const profiles = process.platform === "win32" ? windowsProfileWriteDenies(homes, resolveDocumentsPath) : undefined;
  // Non-device default grants are removed at the runtime source, so no compensating cache denies are needed.
  const homeWritePersistence = homes.flatMap((home) => [
    // POSIX shell startup files — a write here re-executes on the next shell
    join(home, ".zshenv"),
    join(home, ".zprofile"),
    join(home, ".zshrc"),
    join(home, ".zlogin"),
    join(home, ".zlogout"),
    join(home, ".bash_profile"),
    join(home, ".bash_login"),
    join(home, ".bashrc"),
    join(home, ".bash_logout"),
    join(home, ".profile"),
    // XDG config root — autostart entries, systemd --user units, app config
    join(home, ".config") + (process.platform === "win32" ? sep : ""),
    // macOS per-user Launch Agents — launchd runs the plist at login
    join(home, "Library", "LaunchAgents") + (process.platform === "win32" ? sep : ""),
  ]);
  const writePersistence = [
    ...hostScriptWriteDenyPaths(),
    ...(profiles === undefined ? [] : [...srtWinPrivateDirectories(), ...profiles.paths]),
    ...homeWritePersistence,
    // Deny cron persistence paths because later scheduler execution escapes the sandbox.
    ...POSIX_CRON_DENIES,
    // ASRT vendored srt-win backend dir (re-exec vector) A sandboxed process must never be able to WRITE/overwrite the broker binary it is itself spawned through. 0.0.67's explicit srt-win path closes the IMPLICIT-resolution vector; denying WRITE to the vendored srt-win tree also closes the PLANTED-binary vector (ASRT's own VENDORED_SRT_WIN_EXE doc warns that in a dev checkout this exe can sit inside a write grant). Grandparent of the exe → covers every arch subdir + build script. Inert off win32.
    dirname(dirname(getVendoredSrtWinExePath())),
  ];
  const seen = new Set<string>();
  const profilePaths = new Set(profiles?.paths);
  const out: FilesystemPathEntry[] = [];
  for (const p of [...readDeny, ...writePersistence]) {
    // Lexical key: a link alias is a separate spelling the sandbox must deny.
    const key = caseFoldForMatch(resolve(p));
    if (!seen.has(key)) {
      seen.add(key);
      out.push(profilePaths.has(p) ? Object.freeze({ path: p, literal: true }) : p);
    }
  }
  return { entries: out, bounded: profiles?.bounded ?? true };
}

interface LinuxWrapperPrograms {
  readonly bwrapPath: string;
  readonly socatPath: string;
  readonly ripgrep: { readonly command: string };
}

function discoverLinuxWrapperPrograms(): { programs: LinuxWrapperPrograms } | { errors: string[] } {
  const bwrapPath = findHostProgram("bwrap");
  const socatPath = findHostProgram("socat");
  const rg = findHostProgram("rg");
  if (bwrapPath && socatPath && rg) return { programs: { bwrapPath, socatPath, ripgrep: { command: rg } } };

  const searched = hostProgramSearchDirectories().join(":") || "(no fully qualified entries)";
  const errors: string[] = [];
  if (rg === null) errors.push(`ripgrep (rg) not found on PATH. Searched ${searched}`);
  if (bwrapPath === null) errors.push(`bubblewrap (bwrap) not installed on PATH. Searched ${searched}`);
  if (socatPath === null) errors.push(`socat not installed on PATH. Searched ${searched}`);
  return { errors };
}

function requireLinuxWrapperPrograms(): LinuxWrapperPrograms {
  const result = discoverLinuxWrapperPrograms();
  if ("errors" in result) throw new Error(result.errors.join("\n"));
  return result.programs;
}

function configuredLinuxWrapperPrograms(): LinuxWrapperPrograms | undefined {
  if (process.platform !== "linux") return undefined;
  if (sandboxSession?.linuxWrapperPrograms !== undefined) return sandboxSession.linuxWrapperPrograms;
  // Tests can compose a configuration outside a session. Initialization requires every program before installing it.
  const result = discoverLinuxWrapperPrograms();
  return "programs" in result ? result.programs : undefined;
}

// Build a fully-resolved SandboxRuntimeConfig from TRUSTED settings. Deny-by-default: when no `allowedDomains` are supplied the network section has an empty allow-list, which ASRT treats as "no egress". Weakening flags default to `false`/absent and are only set when explicitly present in the trusted `weakening` object. @internal Exported for unit tests only (the Windows-logic tests assert the win32 `windows.proxyPortRange` emission with `process.platform` forced). Not part of the module's runtime API — boot uses initializeAsrtSandbox.
export function buildSandboxConfig(
  trustedSettings: TrustedSandboxSettings,
  readDenyEvidence?: WindowsReadDenySnapshot,
  liveGrants: WindowsLiveGrantSnapshot = {},
): SandboxRuntimeConfig {
  assertWindowsPolicyBudget(trustedSettings, true);
  const requestedSettings = trustedSettings;
  trustedSettings = admitFilesystemPolicy(trustedSettings);
  const srtWinPath = process.platform === "win32" && trustedSettings.windows?.externalConfinement !== true
    ? getVerifiedSrtWinExePath() : undefined;
  if (srtWinPath !== undefined) {
    assertPrivateHelperGrants(trustedSettings.allowRead ?? [], trustedSettings.allowWrite ?? []);
  }
  const network: NetworkConfig = {
    // Deny-by-default — empty allow-list ⇒ no network egress.
    allowedDomains: [...(trustedSettings.allowedDomains ?? [])],
    deniedDomains: [...(trustedSettings.deniedDomains ?? [])],
    ...(trustedSettings.strictAllowlist !== undefined
      ? { strictAllowlist: trustedSettings.strictAllowlist }
      : {}),
    // TRUSTED-ONLY weakening: only ever from trusted host/user settings.
    ...(trustedSettings.weakening?.allowAllUnixSockets !== undefined
      ? { allowAllUnixSockets: trustedSettings.weakening.allowAllUnixSockets }
      : {}),
    // macOS worker-UDS control-channel allow (the seatbelt `(subpath <dir>)` rule). Host-allocated worker control-socket dirs only. Emitted whenever present; ASRT ignores it off macOS. See the WORKER UDS header.
    ...(trustedSettings.allowUnixSocketDirs !== undefined &&
    trustedSettings.allowUnixSocketDirs.length > 0
      ? { allowUnixSockets: [...trustedSettings.allowUnixSocketDirs] }
      : {}),
    // Use explicit empty http/https proxy strings to block ambient proxy inheritance; {} still falls through to host env. Only trusted URLs opt into chaining; noProxy merely bypasses and has no inheritance hazard.
    parentProxy: {
      http: trustedSettings.upstreamProxy?.http ?? "",
      https: trustedSettings.upstreamProxy?.https ?? "",
      ...(trustedSettings.upstreamProxy?.noProxy !== undefined
        ? { noProxy: trustedSettings.upstreamProxy.noProxy }
        : {}),
      ...(trustedSettings.upstreamProxy?.resolvesNames === true ? { resolvesNames: true } : {}),
    },
  };

  // denyRead floor: ALWAYS union the centralized host-secret / sensitive read deny-list (getDefaultSensitiveReadDenyPaths) onto any caller-supplied denyRead. This is the SHARED config's read deny — the floor ASRT applies when a per-command wrap supplies NO `customConfig.filesystem.denyRead` of its own (ASRT's wrapWithSandbox does `customConfig?.filesystem?.denyRead ?? config.filesystem.denyRead` — a per-command denyRead REPLACES this, it does not union, so wraps that need this floor must restate it; see openWrapped in mcp-client.ts). Deduped, order-stable (sensitive floor first, then caller's).
  const sensitiveDenyRead = sensitiveReadFloorRows(trustedSettings.userDataDir);
  const denyReadUnion: PolicyFloorRow[] = [];
  const denyReadSeen = new Set<string>();
  for (const row of [...sensitiveDenyRead, ...(trustedSettings.denyRead ?? []).map((path) => policyFloorRow(path, "denied", "secrets", false))]) {
    if (!denyReadSeen.has(row.path)) {
      denyReadSeen.add(row.path);
      denyReadUnion.push(row);
    }
  }
  // denyWrite floor: same boot-level belt as denyRead for callers that do not supply per-command filesystem.denyWrite. Per-command wraps still restate this SOT because ASRT's customConfig filesystem section replaces the shared arrays, but the session config now has a real persistence-vector floor too.
  const writeFloor = buildSensitiveWriteFloor(trustedSettings.userDataDir, trustedSettings.resolveWindowsDocumentsPath);
  const sensitiveWritePaths = spelledPathEntries(writeFloor.entries, "denyWrite");
  if (!writeFloor.bounded && liveGrants.allowWrite?.length) throw new Error(WINDOWS_PROFILE_WRITE_FLOOR_ERROR);
  const requestedWrite = admittedWindowsPolicies.get(trustedSettings)?.allowWrite ?? trustedSettings.allowWrite ?? [];
  // One floor function for every write root: shared allowWrite and live worker-grant roots get the same rows.
  const writeRootFloor = (roots: readonly FilesystemPathEntry[]) => buildMandatorySandboxWritePolicy(
    roots,
    trustedSettings.userDataDir,
    sensitiveWritePaths,
    sensitiveWritePaths.filter(path => isAbsolute(path) && !/[*?\[\]]/.test(path)),
  );
  const mandatory = writeRootFloor(writeFloor.bounded ? requestedWrite : []);
  const grantFloor = liveGrants.allowWrite?.length ? writeRootFloor(liveGrants.allowWrite) : undefined;
  if (grantFloor !== undefined && grantFloor.narrowedWriteRoots.length > 0) {
    throw new Error(`Windows worker grant floor could not cover every write root: ${grantFloor.narrowedWriteRoots.map(entry => entry.root).join(", ")}`);
  }
  const denyWriteUnion: FilesystemPathEntry[] = [];
  const denyWriteSeen = new Set<string>();
  for (const p of [...writeFloor.entries, ...mandatory.denyWrite, ...(grantFloor?.denyWrite ?? []), ...(trustedSettings.denyWrite ?? [])]) {
    const key = filesystemDenyEntryKey(p);
    if (!denyWriteSeen.has(key)) {
      denyWriteSeen.add(key);
      denyWriteUnion.push(p);
    }
  }
  const sharedFloor = getProtectedReadDenyPaths(trustedSettings.userDataDir, trustedSettings.denyRead);
  const allowWrite = writeRootsOutsideReadDenies(mandatory.allowWrite, sharedFloor);
  const allowRead =
    trustedSettings.allowRead !== undefined ? readGrantsOutsideReadDenies(trustedSettings.allowRead, sharedFloor, []) : undefined;
  assertWindowsMachineRootWriteGrants(allowWrite);
  if (srtWinPath !== undefined) assertPrivateHelperGrants(allowRead ?? [], allowWrite);
  // Deny coverage retains requested envelopes and admitted roots, with write coverage separate from read coverage.
  const windowsWriteGrants: FilesystemPathEntry[] = [...allowWrite, ...(trustedSettings.allowWrite ?? []),
    ...(requestedSettings.allowWrite ?? []),
    ...(liveGrants.allowWrite ?? [])];
  const windowsGrants: FilesystemPathEntry[] = [...windowsWriteGrants, ...(requestedSettings.allowRead ?? []), ...(trustedSettings.allowRead ?? []), ...(allowRead ?? []), ...(liveGrants.allowRead ?? [])];
  // The session's policy as rows; the package config below is one projection of them.
  const lists = toSrtConfig(buildPolicyModel({
    floors: [...denyReadUnion, ...denyWriteUnion.map(srtWriteFloorRow)],
    userGrants: [
      ...allowWrite.map((path) => policyGrantRow(path, "rw", "user-grant", false)),
      ...(allowRead ?? []).map((path) => policyGrantRow(path, "ro", "user-grant", false)),
    ],
    extensionManifests: [],
    launchGrants: [],
  }));
  const filesystem: FilesystemConfig = {
    denyRead: windowsDenyTargets(
      asrtReadDenyPaths(lists.denyRead, [...appOwnedSandboxReallowableRoots(), ...aveHomeReadBoundaryRoots()]),
      trustedSettings.userDataDir,
      windowsGrants,
      windowsWriteGrants,
      "read",
      readDenyEvidence,
    ),
    allowWrite: lists.allowWrite,
    denyWrite: windowsDenyTargets(lists.denyWrite, trustedSettings.userDataDir, windowsGrants, windowsWriteGrants, "write"),
    // An absent read list keeps the package's own default; an empty one grants nothing.
    ...(allowRead !== undefined ? { allowRead: lists.allowRead } : {}),
  };

  // Windows-only: pin the egress proxy bind range so it matches the WFP permit (the install flow permits the SAME range — see DEFAULT_WINDOWS_PROXY_PORT_RANGE). Always emitted on win32 (default range when not supplied) so the runtime config and the WFP rule never desync. Inert on mac/linux — ASRT ignores the `windows` section off Windows, but we only emit it on win32 to keep the config minimal and the non-Windows config shape unchanged. Part 6 of the carried ASRT patch reads `externalConfinement`; the package's own WindowsConfig type does not declare it.
  const windows: (WindowsConfig & { externalConfinement?: "embedder" }) | undefined =
    process.platform === "win32"
      ? {
          ...(trustedSettings.windows?.externalConfinement === true
            ? { externalConfinement: "embedder" as const }
            : {}),
          proxyPortRange: [
            ...(trustedSettings.windows?.proxyPortRange ??
              DEFAULT_WINDOWS_PROXY_PORT_RANGE),
          ] as [number, number],
          // ASRT 0.0.80: srt-win path is REQUIRED — no implicit vendored resolution. Supply the explicit SoT path so SandboxManager.initialize (+ wrapWithSandboxArgv + the in-initialize dependency check) can spawn the backend instead of throwing. See getVendoredSrtWinExePath.
          ...(srtWinPath !== undefined ? { srtWin: { path: srtWinPath } } : {}),
        }
      : undefined;
  // Linux-only: pin the helper bwrap execs to the one path each wrap is granted (see getVendoredApplySeccompPath); ASRT's own search would find an `app.asar` virtual path in a packaged build.
  const applySeccompPath = getVendoredApplySeccompPath();

  return {
    network,
    filesystem: finishFilesystemPolicy(filesystem, trustedSettings, trustedSettings.denyWrite ?? [], hasConfiguredDenies(trustedSettings)) as FilesystemConfig,
    ...(windows !== undefined ? { windows } : {}),
    ...(applySeccompPath !== undefined ? { seccomp: { applyPath: applySeccompPath } } : {}),
    ...configuredLinuxWrapperPrograms(),
    ...(process.platform === "darwin" || process.platform === "linux"
      ? { javaAgentJarPath: getVendoredJavaProxyAgentJarPath() }
      : {}),
    // TRUSTED-ONLY weakening flags (see TrustedSandboxSettings trust-boundary note). Only set when explicitly supplied by trusted settings.
    ...(trustedSettings.weakening?.allowAppleEvents !== undefined
      ? { allowAppleEvents: trustedSettings.weakening.allowAppleEvents }
      : {}),
    ...(trustedSettings.weakening?.enableWeakerNetworkIsolation !== undefined
      ? {
          enableWeakerNetworkIsolation:
            trustedSettings.weakening.enableWeakerNetworkIsolation,
        }
      : {}),
  };
}

// A fixed, no-I/O workload used only to prove that Linux can actually start the configured ASRT/bwrap wrapper. ASRT 0.0.80's dependency check verifies binaries, but cannot detect hosts that prohibit the wrapper's user namespace / seccomp setup until a wrapped process starts. This command has no arguments, performs no writes, and makes no network request. It is passed through the SAME initialized ASRT config that tools use (no custom config), so a successful probe proves the real wrapper path rather than merely the presence of `bwrap` on PATH.
const ASRT_LINUX_RUNTIME_PROBE_COMMAND = "true";
const ASRT_LINUX_RUNTIME_PROBE_TIMEOUT_MS = 5_000;
// A SIGKILL request is not proof that bwrap has released its mount state. Give the child a short, bounded chance to emit `close` before ASRT cleanup/reset.
const ASRT_LINUX_RUNTIME_PROBE_CLOSE_GRACE_MS = 1_000;

// Stable machine code for a Linux ASRT wrapper that cannot actually execute.
export const ASRT_LINUX_RUNTIME_PROBE_ERROR_CODE = "asrt-linux-runtime-probe-failed";

// Typed boot-time degradation signal for a Linux ASRT wrapper runtime failure. Boot catches this separately from generic initialization failures so audit telemetry can distinguish a missing binary from a host policy that blocks the configured bwrap/user-namespace/seccomp path. The message is deliberately bounded and never includes child stdout/stderr or environment data.
export class AsrtLinuxRuntimeProbeError extends Error {
  readonly code = ASRT_LINUX_RUNTIME_PROBE_ERROR_CODE;

  constructor(detail: string, options?: ErrorOptions) {
    super(`ASRT Linux runtime probe failed: ${detail}`, options);
    this.name = "AsrtLinuxRuntimeProbeError";
  }
}

export function isAsrtLinuxRuntimeProbeError(
  error: unknown,
): error is AsrtLinuxRuntimeProbeError {
  return error instanceof AsrtLinuxRuntimeProbeError;
}

// Stable failure code for a host that cannot execute its configured profile.
export const ASRT_MAC_RUNTIME_PROBE_ERROR_CODE = "asrt-macos-runtime-probe-failed";

export class AsrtMacRuntimeProbeError extends Error {
  readonly code = ASRT_MAC_RUNTIME_PROBE_ERROR_CODE;
  constructor(detail: string, options?: ErrorOptions) {
    super(`ASRT macOS runtime probe failed: ${detail}`, options);
    this.name = "AsrtMacRuntimeProbeError";
  }
}

export function isAsrtMacRuntimeProbeError(error: unknown): error is AsrtMacRuntimeProbeError {
  return error instanceof AsrtMacRuntimeProbeError;
}

type AsrtRuntimeProbeError = AsrtLinuxRuntimeProbeError | AsrtMacRuntimeProbeError;

// Spawn the exact argv returned by ASRT for the fixed runtime-probe command. There is intentionally no host-shell/plain-spawn retry: the caller needs a real ASRT execution or a typed boot degradation, never a false active state.
function executeAsrtRuntimeProbe(
  wrapped: SandboxWrapResult,
  abortController: AbortController,
): Promise<void> {
  const RuntimeProbeError = process.platform === "darwin" ? AsrtMacRuntimeProbeError : AsrtLinuxRuntimeProbeError;
  const [executable, ...args] = wrapped.argv;
  if (typeof executable !== "string" || executable.length === 0) {
    return Promise.reject(
      new RuntimeProbeError("configured ASRT wrapper returned no executable"),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let closeGraceTimeout: ReturnType<typeof setTimeout> | undefined;
    let timeoutFailure: AsrtRuntimeProbeError | undefined;
    const finish = (error?: AsrtRuntimeProbeError) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (closeGraceTimeout !== undefined) clearTimeout(closeGraceTimeout);
      if (error !== undefined) reject(error);
      else resolve();
    };

    let child: ReturnType<typeof spawn>;
    try {
      // Use ASRT's exact descriptor and shell:false. `true` is the only workload here; this probe never falls back to a plain host shell command.
      child = spawn(executable, args, {
        cwd: process.cwd(),
        windowsHide: true,
        env: process.platform === "linux" ? buildLauncherEnvironment() : wrapped.env,
        shell: false,
        stdio: "ignore",
      });
    } catch {
      finish(
        new RuntimeProbeError("configured ASRT wrapper could not be spawned"),
      );
      return;
    }

    child.once("error", () => {
      // Once SIGKILL has been requested, wait for `close` (or the bounded grace) so cleanup cannot race bwrap's exit/mount teardown.
      if (timeoutFailure !== undefined) return;
      finish(
        new RuntimeProbeError("configured ASRT wrapper could not be spawned"),
      );
    });
    child.once("close", (code, signal) => {
      if (timeoutFailure !== undefined) {
        finish(timeoutFailure);
        return;
      }
      if (code === 0 && signal == null) {
        finish();
        return;
      }
      finish(
        new RuntimeProbeError(
          signal != null
            ? `configured ASRT wrapper terminated by ${signal}`
            : `configured ASRT wrapper exited with status ${code ?? "unknown"}`,
        ),
      );
    });
    timeout = setTimeout(() => {
      // Mark the timeout before kill so a synchronous `close` is still classified as timeout, then wait for exit before cleanup/reset.
      timeoutFailure = new RuntimeProbeError(
        `configured ASRT wrapper timed out after ${ASRT_LINUX_RUNTIME_PROBE_TIMEOUT_MS}ms`,
      );
      closeGraceTimeout = setTimeout(() => {
        // Do not wait forever for a broken ChildProcess implementation. The probe remains failed; this merely bounds boot before best-effort cleanup/reset runs.
        finish(timeoutFailure);
      }, ASRT_LINUX_RUNTIME_PROBE_CLOSE_GRACE_MS);
      abortController.abort();
      try {
        child.kill("SIGKILL");
      } catch {
        // The grace still bounds the failed probe before best-effort cleanup.
      }
    }, ASRT_LINUX_RUNTIME_PROBE_TIMEOUT_MS);
  });
}

// Verify the actual configured native wrapper on supported Unix hosts before publishing activity. Dependency presence alone cannot prove OS admission.
async function verifyAsrtRuntime(
  SandboxManager: Awaited<ReturnType<typeof loadSandboxManager>>,
): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const RuntimeProbeError = process.platform === "darwin" ? AsrtMacRuntimeProbeError : AsrtLinuxRuntimeProbeError;
  if (process.platform === "linux" && getVendoredApplySeccompPath() === undefined) {
    throw new RuntimeProbeError("Unix socket filtering helper is unavailable");
  }

  const abortController = new AbortController();
  const invocation = openEgressInvocation({
    kind: "shell", toolName: "bash", toolUseId: undefined,
    context: { sessionId: undefined, workspaceRoot: process.cwd(), approvalSurface: "unavailable" },
  }, { abortSignal: abortController.signal });
  let listenerOpened = false;
  let wrapped = false;
  try {
    await openEgressListener(SandboxManager, "sandbox runtime probe", invocation.token);
    listenerOpened = true;
    // The probe uses the regular wrapper's default shell and initialized configuration with the fixed `true` command.
    const probe = await SandboxManager.wrapWithSandboxArgv(
      ASRT_LINUX_RUNTIME_PROBE_COMMAND,
      DEFAULT_POSIX_WRAPPER_SHELL,
      undefined,
      abortController.signal,
      process.cwd(),
      { commandId: invocation.token, denyUnixSockets: true },
    );
    wrapped = true;
    if (process.platform === "darwin") assertMacSandboxWrapperSize(probe.argv);
    await executeAsrtRuntimeProbe(process.platform === "linux" ? hardenLinuxSandboxWrap(probe) : probe, abortController);
  } catch (error) {
    if (isAsrtLinuxRuntimeProbeError(error) || isAsrtMacRuntimeProbeError(error)) throw error;
    throw new RuntimeProbeError("configured ASRT wrapper could not be prepared", { cause: error });
  } finally {
    abortController.abort();
    if (listenerOpened) SandboxManager.closeInvocationListener(invocation.token);
    invocation.release();
    if (wrapped) {
      try {
        // bwrap may leave mount-point artifacts even for this no-I/O command.
        SandboxManager.cleanupAfterCommand();
      } catch {
        // Cleanup failure means the configured runtime path is not healthy enough to publish. The initialize caller resets the singleton before surfacing this typed degradation.
        throw new RuntimeProbeError("configured ASRT wrapper cleanup failed");
      }
    }
  }
}

// srt-win's crash recovery at initialize (carried patch part 13): what a previous session that never released its ACEs (a crash, a kill, a failed
// quit) left behind. Counts only; nothing to report when both are zero.
function logWindowsAclRecovery({ deadBrokers, acesRevoked }: WindowsAclRecoveryReport): void {
  if (deadBrokers === 0 && acesRevoked === 0) return;
  log.info("Windows sandbox ACL recovery: pruned %d dead holder(s), revoked %d orphan ACE(s)", deadBrokers, acesRevoked);
  if (acesRevoked > 0) {
    log.warn("Windows sandbox ACLs left behind by a previous session were revoked (%d ACE(s))", acesRevoked);
  }
}

// srt-win dropped these rows without releasing them (`mismatch`: the path now names another object, whose ACE is left as it was, so a deny stays
// fail-closed; `missing`: the path is gone). Retrying changes nothing, so the reset still succeeds.
// Match redactFsPath's <home> convention, with the more specific <ave-home> first.
// Keys fold case/slashes and strip extended prefixes. Unknown roots use a process-private
// HMAC key: correlation lasts this process, and logs cannot confirm guessed usernames.
const windowsAclLogKey = randomBytes(32);
function windowsAclTargetKey(target: string): string {
  const canonical = (path: string): string => win32.normalize(stripExtendedPathPrefix(path)).replace(/[\\/]+$/, "").toLowerCase();
  const path = canonical(target);
  let homes: string[] = [];
  try { homes = policyHomeAnchors(); } catch { /* Unknown homes use opaque keys. */ }
  const roots: [string, string][] = [
    [aveHome(), "<ave-home>"],
    ...[...homes, process.env.HOME, process.env.USERPROFILE].filter((home): home is string => !!home)
      .sort((a, b) => b.length - a.length).map(home => [home, "<home>"] as [string, string]),
  ];
  for (const [root, label] of roots) {
    const base = canonical(root);
    if (path === base || path.startsWith(`${base}\\`)) return label + path.slice(base.length);
  }
  return `<outside-home>:${createHmac("sha256", windowsAclLogKey).update(path).digest("hex").slice(0, 24)}`;
}

function windowsAclTargetLabel(target: string, status: string): string {
  const key = windowsAclTargetKey(target);
  const entry = SENSITIVE_PATH_ENTRIES.find(entry => entry.anchor === "ave-home" && entry.kind === "file"
    && aveHomeReadBoundaryRoots().some(root => windowsAclTargetKey(join(root, ...entry.segments)) === key));
  if (!entry) return key;
  return `${key} (per-file floor${status === "mismatch" ? "; identity changed" : ""})`;
}

type SandboxResetReport = Awaited<ReturnType<Awaited<ReturnType<typeof loadSandboxManager>>["reset"]>>;

// A failed reset carries the rows its ACL release dropped (carried patch part 3); any other failure carries none.
function failedResetReport(error: unknown): SandboxResetReport | undefined {
  try {
    const rows: unknown = error instanceof Error ? (error as { windowsAclUnreleased?: unknown }).windowsAclUnreleased : undefined;
    return Array.isArray(rows) ? { windowsAclUnreleased: rows as SandboxResetReport["windowsAclUnreleased"] } : undefined;
  } catch {
    return undefined;
  }
}

function logUnreleasedWindowsAces(report: SandboxResetReport | undefined): void {
  const unreleased = report?.windowsAclUnreleased ?? [];
  if (unreleased.length === 0) return;
  log.warn("sandbox runtime reset: Windows ACE rows dropped without release (%s); an explicit ACE may remain on earlier aside copies or targets of dropped rows",
    unreleased.map(({ step, status, count, targets }) => `${step} ${status} x${count} [${targets.map(target => step === "deny restore" ? windowsAclTargetLabel(target, status) : windowsAclTargetKey(target)).join(",")}]`).join(", "));
}

// Logging a reset's rows never fails a reset that succeeded, skips its release mark, or replaces a failed reset's error.
function logResetRows(report: SandboxResetReport | undefined): void {
  try {
    logUnreleasedWindowsAces(report);
  } catch {
    try {
      log.warn("sandbox runtime reset: the dropped ACE rows could not be logged");
    } catch {
      // The log sink itself failed; nothing is left to report through.
    }
  }
}

// Forget a just-initialized ASRT singleton after the runtime probe fails. `active` is not set until after the probe, but the manager may already own proxy/helper state; reset it best-effort without masking the typed failure.
async function discardFailedAsrtInitialization(
  SandboxManager: Awaited<ReturnType<typeof loadSandboxManager>> | undefined,
): Promise<void> {
  active = false;
  loadedSandboxManagerForRelease = undefined;
  containerOnlyConfig = undefined;
  windowsExternalConfinement = false;
  await stopEgressRelayService().catch((error: unknown) => {
    log.error("discarding a failed initialization: egress relay stop failed: %s", errorMessage(error));
  });
  _baseTrustedSettings = undefined;
  _baseReadDenyEvidence = undefined;
  sandboxSession?.windowsLiveGrants.clear();
  sandboxSession = undefined;
  resetWatchedRows();
  _workerUnixSocketDirs.clear();
  if (SandboxManager === undefined) return;
  try {
    logResetRows(await SandboxManager.reset());
    markSrtWinRuntimeReleased();
  } catch (error) {
    logResetRows(failedResetReport(error));
    // The caller must still receive the probe error and boot must remain degraded; a reset failure cannot make the capability verified.
    try {
      log.error("discarding a failed initialization: sandbox runtime reset failed: %s", errorMessage(error));
    } catch {
      // The probe error still reaches the caller.
    }
  }
}

// Initialize once from trusted settings and publish activity only after native execution succeeds. Empty global allow lists plus non-strict mode route each connection to the ask callback; on macOS/Linux accept only listener-vouched identities and literal true allows. Log monitoring defaults off.
function windowsDenyTargetPresent(path: string): boolean {
  try { return lstatSync(path, { throwIfNoEntry: false }) !== undefined; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // An unreadable target is not proven absent; it keeps its stamp.
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

// The only gate between Ave and the native stamp: an absent literal row there would be created as a placeholder. Never reached by a shipping caller; a hit is a policy bug or a race and fails closed.
function assertWindowsDenyTargetsPresent(paths: readonly string[]): void {
  if (process.platform !== "win32") return;
  for (const path of paths) {
    const spelling = stripExtendedPathPrefix(path);
    if (isUncPath(spelling) || containsGlobCharsWin(spelling) || !isAbsolute(spelling)) continue;
    if (!windowsDenyTargetPresent(spelling)) throw new Error(`Windows deny target is absent and would be created: ${spelling}`);
  }
}

function checkWindowsSandboxStampTargets(filesystem: Partial<FilesystemConfig> | undefined): void {
  if (process.platform !== "win32") return;
  assertWindowsDenyTargetsPresent([...spelledPathEntries(filesystem?.denyRead ?? [], "denyRead"), ...spelledPathEntries(filesystem?.denyWrite ?? [], "denyWrite")]);
  if (!AVE_HOME_ISOLATION_GUARD_ACTIVE) return;
  // Check the deny path's runtime expansion without subjecting protective rows to grant admission.
  const targets = [...expandWindowsFsPaths([
    ...(filesystem?.denyRead ?? []),
    ...(filesystem?.allowWrite ?? []), ...(filesystem?.allowRead ?? []),
  ], { mode: "deny" }), ...expandWindowsAclDenyLists([], filesystem?.denyWrite).denyWrite].filter(path => !isUncPath(path));
  checkSandboxStampTargets(targets);
}

export type WindowsIsolationResult =
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled" };

export interface AsrtSandboxInitialization {
  readonly windowsIsolation?: Promise<WindowsIsolationResult>;
  readonly isCurrent: () => boolean;
}

export async function initializeAsrtSandbox(
  { queryWindowsDocumentsPath, linuxWrapperPrograms, ...settings }: TrustedSandboxSettings & {
    readonly queryWindowsDocumentsPath?: WindowsDocumentsQuery;
    /** The helpers this boot attempt's dependency check resolved; absent, initialization resolves them once. */
    readonly linuxWrapperPrograms?: LinuxWrapperPrograms;
  },
  askCb?: SandboxAskCallback,
  enableLogMonitor = false,
  startupSignal?: AbortSignal,
): Promise<AsrtSandboxInitialization> {
  startupSignal?.throwIfAborted();
  if (sandboxResetPending !== undefined) {
    throw new Error("initializeAsrtSandbox: sandbox reset is pending");
  }
  if (active || sandboxInitializationPending) {
    throw new Error("initializeAsrtSandbox: already active or initializing — refusing to re-initialize");
  }
  sandboxInitializationPending = true;
  // Cancellation must not release the startup barrier before its current resource owner settles.
  try {
    const trustedSettings = process.platform === "win32" && queryWindowsDocumentsPath !== undefined
      ? { ...settings, resolveWindowsDocumentsPath: await resolveWindowsDocumentsPath(queryWindowsDocumentsPath, startupSignal) }
      : settings;
    return await initializeSandboxRuntime(trustedSettings, askCb, enableLogMonitor, startupSignal, queryWindowsDocumentsPath, linuxWrapperPrograms);
  } finally {
    sandboxInitializationPending = false;
  }
}

async function initializeSandboxRuntime(
  trustedSettings: TrustedSandboxSettings,
  askCb: SandboxAskCallback | undefined,
  enableLogMonitor: boolean,
  startupSignal: AbortSignal | undefined,
  queryWindowsDocumentsPath: WindowsDocumentsQuery | undefined,
  preflightLinuxPrograms: LinuxWrapperPrograms | undefined,
): Promise<AsrtSandboxInitialization> {
  assertWindowsPolicyBudget(trustedSettings, true);
  const configuredDenies = hasConfiguredDenies(trustedSettings);
  if (trustedSettings.windows?.externalConfinement !== true) {
    assertAveHomePrivacyForConfinement();
  }
  // Containers confine this session's Windows children, so only the egress relay serves them: the wrap runtime stays unloaded.
  const SandboxManager = process.platform === "win32" && trustedSettings.windows?.externalConfinement === true
    ? undefined : await loadSandboxManager();
  startupSignal?.throwIfAborted();
  const linuxWrapperPrograms = process.platform === "linux" ? preflightLinuxPrograms ?? requireLinuxWrapperPrograms() : undefined;
  const backgroundInitialization = process.platform === "win32"
    && trustedSettings.windows?.backgroundInitialization === true
    && trustedSettings.windows.externalConfinement !== true;
  const initialSettings = backgroundInitialization
    ? { ...trustedSettings, windows: { ...trustedSettings.windows, externalConfinement: true } }
    : trustedSettings;
  // Remember the base settings so worker-UDS register/unregister can rebuild the SHARED config additively (see the WORKER UDS header). On a fresh init there are no registered worker sockets yet, so the effective config equals the base; withWorkerUnixSockets is a no-op until a worker registers.
  _baseTrustedSettings = initialSettings;
  sandboxSession = { linuxWrapperPrograms, queryWindowsDocumentsPath, sharedWindowsDocumentsPath: trustedSettings.resolveWindowsDocumentsPath,
    windowsLiveGrants: new Map(), windowsLiveGrantCount: 0, windowsLiveGrantRevision: 0, windowsWrapDenyRead: new Set(), windowsWrapDenyWrite: new Map(), windowsPendingWrapDenies: new Set(), windowsDenyRevision: 0 };
  const session = sandboxSession;
  let fullConfig: SandboxRuntimeConfig;
  windowsProfileReadDenyWarnings.clear();
  windowsReadDenyWarnings.clear();
  windowsAbsentDenyWarnings.clear();
  windowsDenyStatWarnings.clear();
  _workerUnixSocketDirs.clear();
  try {
    useAppOwnedSandboxTempRoot();
    _baseReadDenyEvidence = await gatherWindowsReadDenyEvidence(trustedSettings);
    startupSignal?.throwIfAborted();
    const config = buildSandboxConfig(withWorkerUnixSockets(trustedSettings), _baseReadDenyEvidence, snapshotWindowsLiveGrants(sandboxSession));
    fullConfig = config;
    assertNoLocalBinding(config);
    noteAsrtUnixSocketPolicy(config.network.allowAllUnixSockets === true);
    // Every contained Windows route gets its egress from the relay. Its allow list stays empty: each destination goes to the ask callback,
    // and without one the service is not started, so no route opens.
    if (process.platform === "win32" && askCb !== undefined) {
      startEgressRelayService({ ask: askCb, ...(trustedSettings.upstreamRouter ? { router: trustedSettings.upstreamRouter } : {}) });
    }
    if (SandboxManager === undefined) {
      checkWindowsSandboxStampTargets(config.filesystem);
      containerOnlyConfig = config;
      windowsExternalConfinement = true;
      active = true;
      return { isCurrent: (): boolean => active && sandboxSession === session };
    }
    // Installed before the proxy starts, so no connection is routed without it; reset (including a failed initialization's) clears it.
    SandboxManager.setParentProxyRouter(trustedSettings.upstreamRouter);
    setWindowsAclRecoveryListener(logWindowsAclRecovery);
    // A host that claimed its signals (asrt-signal-ownership.ts) drains confined children before it resets the runtime; the runtime's own signal
    // handler would reset it, and revoke its ACEs, while they still run (carried patch part 12).
    if (readAsrtSignalReleaseClaim()) SandboxManager.setSignalCleanupOwnedByHost(true);
    checkWindowsSandboxStampTargets(config.filesystem);
    if (process.platform === "win32") warnWindowsPlaceholderLeftovers(config.filesystem);
    // From here the runtime may stamp ACEs that only its reset, spawning the private helper copy, releases.
    markSrtWinRuntimeReleasePending();
    const initialConfig = backgroundInitialization
      ? { ...config, windows: { ...config.windows, externalConfinement: "embedder" as const } }
      : config;
    // A contained endpoint's ports are no destination of the shared proxy, whatever its caller is allowed: a front port asks for no
    // credential and its relay speaks as the shell. Refused before the policy is asked, by name and again by resolved address.
    // The runtime skips this ask for a destination one of its own lists allows; boot passes it no allow list and nothing registers a
    // per-command one (pinned in sandbox-boot-outcome.test.ts), so no destination gets past the refusal.
    // A key its relay owns is learned from that relay alone: named by a shared proxy username it attributes nothing.
    const sharedAsk: SandboxAskCallback | undefined = askCb === undefined || process.platform !== "win32" ? askCb
      : async (destination, context) => {
        const dialed = context?.phase === "resolved" ? context.addresses : [];
        if ([destination.host, ...dialed].some((host) => isEgressRelayListener(host, destination.port))) {
          return { allow: false, reason: "destination is a contained egress endpoint of this host" };
        }
        return askCb(destination, context?.attributionKey !== undefined && egressRelayOwnsKey(context.attributionKey)
          ? { ...context, attributionKey: undefined } : context);
      };
    await SandboxManager.initialize(initialConfig, sharedAsk, enableLogMonitor);
    startupSignal?.throwIfAborted();
    if (sandboxSession !== session) throw new Error("Sandbox initialization was cancelled");
    // A host may reject a configured profile even when every dependency exists. Publish activity only after a real confined workload starts.
    await verifyAsrtRuntime(SandboxManager);
    startupSignal?.throwIfAborted();
    if (sandboxSession !== session) throw new Error("Sandbox initialization was cancelled");
  } catch (error) {
    await discardFailedAsrtInitialization(SandboxManager);
    throw windowsAclBudgetError(error, configuredDenies);
  }
  windowsExternalConfinement =
    process.platform === "win32" && initialSettings.windows?.externalConfinement === true;
  loadedSandboxManagerForRelease = SandboxManager;
  active = true;
  const isCurrent = (): boolean => active && sandboxSession === session;
  if (!backgroundInitialization) return { isCurrent };
  const windowsIsolation = SandboxManager.initializeWindowsIsolation(fullConfig).then(
    (): WindowsIsolationResult => {
      if (!isCurrent()) return { status: "cancelled" };
      _baseTrustedSettings = trustedSettings;
      windowsExternalConfinement = false;
      return { status: "ready" };
    },
    (error: unknown): WindowsIsolationResult =>
      !isCurrent() ? { status: "cancelled" } : { status: "failed", error: windowsAclBudgetError(error, configuredDenies) },
  );
  return { windowsIsolation, isCurrent };
}

// Probe dependencies asynchronously with the explicit verified binary path; missing dependencies must fail the active boot gate rather than silently claim isolation.
export async function checkAsrtDependencies(): Promise<{
  errors: string[];
  warnings: string[];
  dependencyFailure?: unknown;
  linuxWrapperPrograms?: LinuxWrapperPrograms;
}> {
  if (process.platform === "win32") {
    const mod = await import("@anthropic-ai/sandbox-runtime");
    // A missing bundled binary is a failed check, not a boot crash: ASRT's own implicit-resolve path reports it the same way, and the gate turns it into `windows-sandbox-missing` (sandbox-start-failure.ts).
    let srtWin: ReturnType<typeof mod.resolveSrtWin>;
    try {
      srtWin = mod.resolveSrtWin({ path: getVerifiedSrtWinExePath() });
    } catch (error) {
      return { errors: [errorMessage(error)], warnings: [], dependencyFailure: error };
    }
    return mod.checkWindowsDependenciesAsync({ srtWin });
  }
  const SandboxManager = await loadSandboxManager();
  if (process.platform === "linux" && SandboxManager.isSupportedPlatform()) {
    const result = discoverLinuxWrapperPrograms();
    if ("errors" in result) return { errors: result.errors, warnings: [] };
    const [{ checkLinuxDependencies }, { getApplySeccompBinaryPathAsync }] = await Promise.all([
      import("@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js"),
      import("@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js"),
    ]);
    const { bwrapPath, socatPath } = result.programs;
    const applyPath = getVendoredApplySeccompPath();
    await getApplySeccompBinaryPathAsync(applyPath);
    const checked = await checkLinuxDependencies({ bwrapPath, socatPath, seccompConfig: { applyPath } });
    return { ...checked, linuxWrapperPrograms: result.programs };
  }
  return SandboxManager.checkDependenciesAsync();
}

// Wrap a TOOL command for sandboxed execution, returning the `{ argv, env }` the host must spawn. Uses `wrapWithSandboxArgv` (the cross-platform form; unlike `wrapWithSandbox` it does not throw on Windows).
export async function wrapToolCommand(
  command: string,
  options: AttributedWrapOptions,
): Promise<SandboxWrapResult> {
  const invocation = egressInvocationOwner(options.commandId);
  // Self-enforcing gate. Do not depend on the caller to check isAsrtSandboxActive first — a wrap with no initialized SandboxManager is a bug, so throw rather than silently wrapping against an uninitialized singleton.
  if (!isAsrtSandboxActive()) {
    throw new Error("wrapToolCommand: ASRT sandbox is not active (initialize at boot first)");
  }
  assertWrapRuntime("wrapToolCommand");
  assertWindowsDenyProtection();
  // A wrapped command is a confined process that may write a plugin tree.
  noteConfinedProcessesMayRun();
  // Publish before wrapping: the runtime sets TMPDIR inside the command, ahead of any environment the spawning caller supplies. Idempotent.
  useAppOwnedSandboxTempRoot();
  assertPerExecFilesystemSupported(options.filesystem, "wrapToolCommand");
  const session = sandboxSession;
  return runWithSandboxWritePreflight(options.abortSignal, () => withWindowsWrapDenyAdmission(session, options.filesystem, async filesystem => {
    assertCommandId("wrapToolCommand", options.commandId);
    const SandboxManager = await loadSandboxManager();
    await openEgressListener(SandboxManager, "wrapToolCommand", options.commandId);
    const notices: string[] = [];
    let gitControlSnapshot: SandboxGitControlSnapshot | undefined;
    let grantRevision: number | undefined;
    const customConfig = await inAveHomeBoundarySnapshot(options.boundarySnapshot, async () => {
      const readDenyEvidence = filesystem?.denyRead === undefined ? undefined
        : await gatherWindowsReadDenyEvidence(_baseTrustedSettings ?? {}, filesystem.denyRead, _baseReadDenyEvidence);
      grantRevision = session?.windowsLiveGrantRevision;
      return buildPerCommandSandboxCustomConfig(filesystem, notice => notices.push(notice), snapshot => { gitControlSnapshot = snapshot; }, readDenyEvidence, snapshotWindowsLiveGrants(session));
    });
    const cleanupBare = process.platform === "linux"
      ? await prepareSandboxBareRepositoryCleanup(spelledPathEntries(customConfig?.filesystem?.allowWrite ?? [], "allowWrite"), options.commandId, gitControlSnapshot) : undefined;
    checkWindowsSandboxStampTargets(customConfig?.filesystem);
    assertWindowsSession(session);
    const pendingWrap = SandboxManager.wrapWithSandboxArgv(
      command,
      wrapperShell(options.binShell),
      customConfig,
      options.abortSignal,
      undefined,
      { commandId: options.commandId, denyUnixSockets: options.denyUnixSockets },
    );
    const wrapped = await pendingWrap.catch(error => {
      throw windowsAclBudgetError(error, hasConfiguredDenies(filesystem) || hasConfiguredDenies(_baseTrustedSettings));
    });
    checkWindowsSandboxStampTargets(customConfig?.filesystem);
    const result = applySandboxFilesystemPolicy(wrapped, customConfig?.filesystem, () => SandboxManager.cleanupAfterCommand());
    commitWindowsWrapDenies(session, grantRevision, filesystem);
    return trackBareRepositoryCleanup({ ...result, ...(gitControlSnapshot ? { gitControlSnapshot } : {}), ...(customConfig?.filesystem ? { filesystemPolicy: customConfig.filesystem } : {}), ...(notices.length ? { notices: Object.freeze(notices) } : {}) }, options.commandId, cleanupBare ?? watchedRowsCleanup(options.commandId, command),
      () => invocation !== undefined && egressInvocationOwner(options.commandId) === undefined);
  }));
}

// The host-owned root used for the runtime's inline TMPDIR assignment. Non-device write roots come only from caller policy; setting TMPDIR alone grants no access. Confined principals receive their own directory below this root, with the root read-denied and only their own directory granted.
export function appOwnedSandboxTempRoot(): string {
  return join(sandboxPrivateBase(), "tmp");
}

// The directory the sandbox private roots live in: `<AVE_HOME>/sandbox`. Under the test runner with no `AVE_HOME` of its own, it is the per-run directory `vitest.globalSetup.ts` makes instead. These roots hold every confined process's HOME and temp directory, and the boot sweep empties them, so a test resolving them to the developer's real `~/.ave` would put its directories where a running app's boot deletes them — and a test that swept would delete the running app's. A test process without that directory is refused rather than defaulted to the real one. The app's seam answers nothing (`ave-home-test-guard.ts`); only the test runner's guard does.
function sandboxPrivateBase(): string {
  return testSandboxPrivateBase() ?? join(aveHome(), "sandbox");
}

// Where every confined process's throwaway sandbox HOME is created on macOS and Linux (`sandbox-process-home.ts`), one `mkdtemp` directory each; Windows keeps them under the container runtime root (`mxcSandboxHomesParent`). App-owned, beside the temp root, rather than under the host's temp directory: there, nothing denied reading it, so any confined process could list the host temp directory and read another one's HOME. Under this root the read floor denies it (getDefaultSensitiveReadDenyPaths) and each wrap re-allows its own HOME alone.
export function appOwnedSandboxHomeRoot(): string {
  return join(sandboxPrivateBase(), "home");
}

// Where the workspace terminal hands its sandboxed shell command to the trampoline it spawned on the pty (`terminal-tty-handoff.ts`): one `mkdtemp` directory with one fifo per spawn. The host alone writes here. No wrap grants it, so no confined process can write the fifo (which the trampoline runs unsandboxed), and the read floor denies it, so none can read the command and environment out of it either.
export function appOwnedTerminalHandoffRoot(): string {
  return join(sandboxPrivateBase(), "handoff");
}

// The private roots a wrap re-opens its own directory inside: each confined process's HOME and temp live under them, and the terminal's handoff. Their macOS denies are spelled exactly (asrtReadDenyPaths) so the re-allow survives.
function appOwnedSandboxReallowableRoots(): string[] {
  if (process.platform === "win32") return [];
  return [appOwnedSandboxTempRoot(), appOwnedSandboxHomeRoot(), appOwnedTerminalHandoffRoot()];
}

// The roots of the confined processes' private directories, read-denied by the floor. The container runtime root is one of them on every platform, and the only one on Windows, where it is spelled as that platform's directory rows are, with a trailing separator: it holds what used to be staged under the Ave home, outside it, and stays as unreadable to every other confined process as it was there. On Windows it also holds every sandbox HOME (`homes`), and a confined process is re-opened its own HOME alone. Naming it never throws, whatever state the account's cache directory is in.
export function appOwnedSandboxPrivateRoots(): string[] {
  if (process.platform === "win32") return [mxcRuntimeRootFloorPath() + sep];
  return [...appOwnedSandboxReallowableRoots(), mxcRuntimeRootFloorPath()];
}

// Create a sandbox private root `0o700` if it is absent, and refuse one that is not a real directory. Its ancestors may be links (`AVE_HOME` may be one); the root itself is the host's, and every directory a wrap grants is made inside it, so a link here would put them somewhere the read floor does not name.
export function ensureSandboxPrivateRoot(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const entry = lstatSync(root);
  if (!entry.isDirectory()) {
    throw new Error(`sandbox: ${root} is not a directory the host created; refusing to create sandbox directories in it`);
  }
  return root;
}

let appOwnedTempRootReady = false;

// Whose temp directory a confined process gets: a plugin, covering its child, its workers and its bundled hooks, one MCP stdio server, or a user command hook.
export interface SandboxTempPrincipal {
  readonly kind: "plugin" | "mcp" | "hook";
  readonly id: string;
}

const SANDBOX_TEMP_PRINCIPAL_KINDS: ReadonlySet<string> = new Set(["plugin", "mcp", "hook"]);

// The longest id, in UTF-8 bytes, that names a temp directory. Its hex form after the longest kind prefix stays under the 255-byte name limit every supported filesystem has.
const MAX_SANDBOX_TEMP_PRINCIPAL_ID_BYTES = 120;

// The directory name a principal's temp directory has under the shared root: `<kind>-<hex of the id's UTF-8 bytes>`. Lowercase hex is one spelling per id on case-insensitive and case-sensitive filesystems alike, carries no separator, dot or link-like segment whatever the id holds (an agent plugin's id contains `/`), and the kind prefix keeps a plugin and an MCP server with the same id apart. An id that is empty, longer than MAX_SANDBOX_TEMP_PRINCIPAL_ID_BYTES, or not well-formed text (whose UTF-8 bytes would be shared with another id's) is refused.
export function sandboxTempPrincipalDirName(principal: SandboxTempPrincipal): string {
  if (!SANDBOX_TEMP_PRINCIPAL_KINDS.has(principal.kind)) {
    throw new Error(`sandbox temp: unknown principal kind ${JSON.stringify(principal.kind)}`);
  }
  const bytes = Buffer.from(principal.id, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_SANDBOX_TEMP_PRINCIPAL_ID_BYTES || bytes.toString("utf8") !== principal.id) {
    throw new Error(
      `sandbox temp: ${principal.kind} id ${JSON.stringify(principal.id)} cannot name a temp directory `
        + `(empty, longer than ${MAX_SANDBOX_TEMP_PRINCIPAL_ID_BYTES} UTF-8 bytes, or not well-formed text)`,
    );
  }
  return `${principal.kind}-${bytes.toString("hex")}`;
}

const createdSandboxTempPrincipalDirs = new Set<string>();

// The principal temp directories this process has handed to a wrap. The boot sweep keeps them: a directory a process started during this boot is using is never removed, whatever order boot and the first wrap run in.
export function sandboxTempPrincipalDirsInUse(): ReadonlySet<string> {
  return createdSandboxTempPrincipalDirs;
}

// Grant only the real principal temp directory and deny its shared root; same-user mode bits alone cannot protect neighbours. Refuse links and sweep legacy planted entries before any wrap.
export function ensureSandboxTempPrincipalDir(principal: SandboxTempPrincipal): { readonly dir: string; readonly root: string } {
  const root = ensureSandboxPrivateRoot(appOwnedSandboxTempRoot());
  const dir = join(root, sandboxTempPrincipalDirName(principal));
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = lstatSync(dir);
  if (!entry.isDirectory()) {
    throw new Error(`sandbox temp: ${dir} is not a directory the host created; refusing to grant it`);
  }
  // A principal may have narrowed its own directory's mode; the host decides it.
  if ((entry.mode & 0o7777) !== 0o700) chmodSync(dir, 0o700);
  createdSandboxTempPrincipalDirs.add(dir);
  return { dir, root };
}

// The sandbox wrapper supplies its own TMPDIR. Set the principal's temp variables inside the sandbox.
export function sandboxTempEnvLaunch(
  dir: string,
  command: string,
  args: readonly string[],
): { readonly command: string; readonly args: string[] } {
  // env(1) reads an executable containing '=' as an assignment. Pass that pathname as a positional argument.
  const launch = command.includes("=") ? ["/bin/bash", "-c", 'exec -- "$@"', "sandbox-temp", command, ...args] : [command, ...args];
  return {
    command: SANDBOX_TEMP_ENV_LAUNCHER,
    args: [`TMPDIR=${dir}`, `TMP=${dir}`, `TEMP=${dir}`, ...launch],
  };
}

// `env(1)`, never a `PATH` lookup: both platforms that wrap ship it here.
const SANDBOX_TEMP_ENV_LAUNCHER = "/usr/bin/env";

export function useAppOwnedSandboxTempRoot(): string {
  const root = appOwnedSandboxTempRoot();
  if (appOwnedTempRootReady) return root;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // The current name and the one ASRT keeps for compatibility. Both, because reading which one a given ASRT version prefers is a fact that can change under us, and disagreeing with ourselves would put the child somewhere neither we nor the reader expects.
  process.env.CLAUDE_CODE_TMPDIR = root;
  process.env.CLAUDE_TMPDIR = root;
  appOwnedTempRootReady = true;
  return root;
}

// Worker egress uses its private listener and owning extension policy; it never inherits shell grants or another plugin's domains and never prompts. Per-command network overrides are inert. Register shared UDS allowances before wrapping with the writable socket-directory bind; host shells override that shared allowance with denyUnixSockets.
export async function wrapWorkerCommand(
  command: string,
  options: AttributedWrapOptions,
): Promise<SandboxWrapResult> {
  return wrapLongLivedCommand("wrapWorkerCommand", command, options, undefined);
}

// Wrap the workspace terminal's login shell. The same wrap as wrapWorkerCommand, plus ONE terminal grant: macOS `file-ioctl` on `ownTty`, the pty slave the shell is spawned on, and on no other terminal. Without it the shell cannot turn off echo or take the terminal for a foreground job (every command is printed twice, job control is off), and ASRT's only other grant, `allowPty: true`, covers every `/dev/ttys*` of the user. ASRT refuses an `ownTty` that is not `/dev/ttys` + 3 or more digits. Only the terminal passes a tty: tool and worker wraps never get one.
export async function wrapTerminalCommand(
  command: string,
  options: AttributedWrapOptions & { readonly ownTty: string },
): Promise<SandboxWrapResult> {
  return wrapLongLivedCommand("wrapTerminalCommand", command, options, { ttys: [options.ownTty] });
}

async function wrapLongLivedCommand(
  caller: string,
  command: string,
  options: AttributedWrapOptions,
  wrapOptions: { readonly ttys: readonly string[] } | undefined,
): Promise<SandboxWrapResult> {
  assertAveHomePrivacyForConfinement();
  assertWrapRuntime(caller);
  const invocation = egressInvocationOwner(options.commandId);
  // Self-enforcing gate — same rationale as wrapToolCommand.
  if (!isAsrtSandboxActive()) {
    throw new Error(`${caller}: ASRT sandbox is not active (initialize at boot first)`);
  }
  if (process.platform === "linux" && options.denyUnixSockets === true && getVendoredApplySeccompPath() === undefined) {
    throw new Error(`${caller}: Unix socket filtering helper is unavailable`);
  }
  assertWindowsDenyProtection();
  noteConfinedProcessesMayRun();
  // Publish before wrapping: the runtime sets TMPDIR inside the command, ahead of any environment the spawning caller supplies. Idempotent.
  useAppOwnedSandboxTempRoot();
  assertPerExecFilesystemSupported(options.filesystem, caller);
  const session = sandboxSession;
  return runWithSandboxWritePreflight(options.abortSignal, () => withWindowsWrapDenyAdmission(session, options.filesystem, async filesystem => {
    assertCommandId(caller, options.commandId);
    const SandboxManager = await loadSandboxManager();
    await openEgressListener(SandboxManager, caller, options.commandId);
    const notices: string[] = [];
    let gitControlSnapshot: SandboxGitControlSnapshot | undefined;
    let grantRevision: number | undefined;
    const customConfig = await inAveHomeBoundarySnapshot(options.boundarySnapshot, async () => {
      const readDenyEvidence = filesystem?.denyRead === undefined ? undefined
        : await gatherWindowsReadDenyEvidence(_baseTrustedSettings ?? {}, filesystem.denyRead, _baseReadDenyEvidence);
      grantRevision = session?.windowsLiveGrantRevision;
      return buildPerCommandSandboxCustomConfig(filesystem, notice => notices.push(notice), snapshot => { gitControlSnapshot = snapshot; }, readDenyEvidence, snapshotWindowsLiveGrants(session));
    });
    const cleanupBare = process.platform === "linux"
      ? await prepareSandboxBareRepositoryCleanup(spelledPathEntries(customConfig?.filesystem?.allowWrite ?? [], "allowWrite"), options.commandId, gitControlSnapshot) : undefined;
    // `wrapOptions` carries a tty only for the terminal.
    checkWindowsSandboxStampTargets(customConfig?.filesystem);
    assertWindowsSession(session);
    const pendingWrap = SandboxManager.wrapWithSandboxArgv(
      command,
      wrapperShell(options.binShell),
      customConfig,
      options.abortSignal,
      undefined,
      { ...wrapOptions, commandId: options.commandId, denyUnixSockets: options.denyUnixSockets },
    );
    const wrapped = await pendingWrap.catch(error => {
      throw windowsAclBudgetError(error, hasConfiguredDenies(filesystem) || hasConfiguredDenies(_baseTrustedSettings));
    });
    checkWindowsSandboxStampTargets(customConfig?.filesystem);
    const result = applySandboxFilesystemPolicy(wrapped, customConfig?.filesystem, () => SandboxManager.cleanupAfterCommand());
    commitWindowsWrapDenies(session, grantRevision, filesystem);
    return trackBareRepositoryCleanup({ ...result, ...(gitControlSnapshot ? { gitControlSnapshot } : {}), ...(customConfig?.filesystem ? { filesystemPolicy: customConfig.filesystem } : {}), ...(notices.length ? { notices: Object.freeze(notices) } : {}) }, options.commandId, cleanupBare ?? watchedRowsCleanup(options.commandId, command),
      () => invocation !== undefined && egressInvocationOwner(options.commandId) === undefined);
  }));
}

// Bare domain grants mean apex plus strict subdomains in host policy; emit both d and *.d for runtime parity. Preserve explicit wildcards, drop empty/deny-all entries and deduplicate in order.
export function normalizeUnionForAsrt(
  domains: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (entry: string): void => {
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  };
  for (const raw of domains) {
    if (typeof raw !== "string") continue;
    const d = raw.trim().toLowerCase();
    if (d.length === 0 || d === "*") continue;
    if (d.startsWith("*.")) {
      // Already a wildcard — pass through (no apex implied by a bare `*.d`).
      add(d);
      continue;
    }
    // Bare domain: emit apex + every strict subdomain to mirror Ave's dot-boundary suffix match against ASRT's exact/`*.` two-branch matcher.
    add(d);
    add(`*.${d}`);
  }
  return out;
}

// The TRUSTED host-settings slice computeDynamicEndpointHosts reads. Intentionally a structural subset of `AppSettings` (not an import of it) so the function is pure, unit-testable in isolation, and tolerant of partial settings shapes (test doubles, pre-migration files). Only the LLM vendor blocks' user-configured `baseUrl`s are consulted — the dynamic endpoints a sandboxed worker actually reaches.
export interface DynamicEndpointSettings {
  readonly llm?: {
    readonly vendors?: Record<string, { readonly baseUrl?: string } | undefined>;
    // The active provider preset carries its own endpoint outside the generic custom-provider block; include it when composing worker domain policy.
    readonly marketplaceProviderPresetId?: string;
  };
  readonly marketplace?: {
    readonly installedProviderPresets?:
      | readonly { readonly providerId: string; readonly baseUrl?: string }[]
      | undefined;
  };
}

// Reduce trusted, host-configured endpoint URLs to distinct hostnames for worker policy composition. Malformed URLs contribute no grant. This helper supplies names only; the invocation proxy separately checks resolved network addresses before connecting. These endpoints do not bypass shell approval.
export function computeDynamicEndpointHosts(
  settings: DynamicEndpointSettings | undefined,
): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  const baseUrls = llmRouteBaseUrls({
    vendors: settings?.llm?.vendors,
    marketplaceProviderPresetId: settings?.llm?.marketplaceProviderPresetId,
    installedProviderPresets: settings?.marketplace?.installedProviderPresets,
  });
  for (const trimmed of baseUrls) {
    let hostname: string;
    try {
      // Strip trailing dot from FQDN-style URLs (e.g. `res.openai.azure.com.`) so they normalize to the bare hostname the ASRT matcher expects.
      hostname = new URL(trimmed).hostname.replace(/\.$/, "");
    } catch {
      // Malformed endpoint — NOT a wildcard, NOT an allow-all fallback. It simply contributes no host (deny-by-default per the no-fallback rule).
      continue;
    }
    const host = hostname.trim().toLowerCase();
    if (host.length === 0 || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

// Only host-allocated socket directories may update shared policy; never accept plugin/manifest/server paths. Register before wrapping, refcount holders and preserve trusted base config. macOS needs a directory subpath; Linux needs AF_UNIX plus the writable bind, since per-command network overrides are inert.
export async function registerWorkerUnixSocketDir(socketDir: string, holder: object): Promise<void> {
  if (!active || _baseTrustedSettings === undefined) {
    throw new Error(
      "registerWorkerUnixSocketDir: ASRT sandbox is not active (initialize at boot first)",
    );
  }
  const existing = _workerUnixSocketDirs.get(socketDir);
  if (existing !== undefined) {
    // A later holder resolves only once the FIRST holder's push has landed: it is about to wrap a child, and a wrap generated before the push would carry no allow. If that push fails, the whole entry is rolled back and every waiter fails with it, so no caller believes it holds a dir that was never pushed.
    existing.holders.add(holder);
    await existing.pushed;
    if (!existing.holders.has(holder) || _workerUnixSocketDirs.get(socketDir) !== existing) {
      throw new Error("Socket directory registration was released before acquisition completed");
    }
    return;
  }
  let resolvePushed!: () => void;
  let rejectPushed!: (error: unknown) => void;
  const pushed = new Promise<void>((resolvePush, rejectPush) => {
    resolvePushed = resolvePush;
    rejectPushed = rejectPush;
  });
  // Observed here so a failed push with no waiter is not an unhandled rejection.
  pushed.catch(() => undefined);
  const entry: WorkerUnixSocketDirEntry = { holders: new Set([holder]), registered: false, pushed };
  _workerUnixSocketDirs.set(socketDir, entry);
  try {
    const SandboxManager = await loadSandboxManager();
    if (_workerUnixSocketDirs.get(socketDir) !== entry || !active || _baseTrustedSettings === undefined) {
      throw new Error("Socket directory registration was released before acquisition completed");
    }
    // Other pending dirs belong to their own push. Including them here could retain an allowance after that dir's push fails and its holders reject.
    const config = buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings, socketDir), _baseReadDenyEvidence, snapshotWindowsLiveGrants(sandboxSession));
    checkWindowsSandboxStampTargets(config.filesystem);
    SandboxManager.updateConfig(config);
    entry.registered = true;
  } catch (error) {
    // Every holder of this entry — this caller and any waiter — sees the throw, treats the dir as not registered, and will not release it.
    if (_workerUnixSocketDirs.get(socketDir) === entry) _workerUnixSocketDirs.delete(socketDir);
    rejectPushed(error);
    throw error;
  }
  resolvePushed();
  if (!entry.holders.has(holder)) {
    throw new Error("Socket directory registration was released before acquisition completed");
  }
}

// Release one holder of a socket dir's UDS allowance; the last release drops it and pushes the rebuilt SHARED config. Unknown dirs are a no-op. Called by spawnWorker on worker exit/stop and by a plugin child's teardown, so a dead holder's allowance does not linger and a live one's is not dropped.
export async function unregisterWorkerUnixSocketDir(socketDir: string, holder: object): Promise<void> {
  const entry = _workerUnixSocketDirs.get(socketDir);
  if (entry === undefined || !entry.holders.delete(holder)) return;
  if (entry.holders.size > 0) return;
  _workerUnixSocketDirs.delete(socketDir);
  // If the sandbox was already torn down, there is nothing to update — the reset cleared the live config and the worker set; this is a no-op.
  if (!active || _baseTrustedSettings === undefined) return;
  const SandboxManager = await loadSandboxManager();
  if (!active || _baseTrustedSettings === undefined) return;
  const config = buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings), _baseReadDenyEvidence, snapshotWindowsLiveGrants(sandboxSession));
  checkWindowsSandboxStampTargets(config.filesystem);
  SandboxManager.updateConfig(config);
}

// Windows worker grants name a dedicated holder PID. Apply session denies before access, then publish the logical config; use one verified binary descriptor throughout.
// Each turn keeps the read, stamp, verification and grant serialized. Final verification and grant do not yield.
const windowsGrantTurns = createSerialQueue();
let windowsGrantStamp: Promise<void> | undefined;

interface WindowsWorkerFilesystemGrantRequest {
  // A function starts the holder when the turn starts, so a refused turn starts none.
  readonly holderPid: number | (() => number);
  readonly allowRead?: readonly string[];
  readonly allowWrite?: readonly string[];
  // Checked at admission and again after stamping, before any allow ACL is granted.
  readonly assertStillValid?: () => void;
  // The caller's own sandbox HOME. It lies under a sandbox private root, where a grant is otherwise refused.
  readonly sandboxHome?: string;
}

export function grantWindowsWorkerFilesystemAccess(
  opts: WindowsWorkerFilesystemGrantRequest,
): Promise<WindowsWorkerFilesystemGrant> {
  return windowsGrantTurns(() => grantWindowsWorkerFilesystemAccessInTurn(opts));
}

type WindowsGrantTimingStep = "preflightMs" | "srtWinPrepMs" | "userStatusMs" | "pinsMs" | "denyReadMs" | "stampMs" | "assertMs" | "grantMs" | "grantRevokeMs" | "configMs";

interface WindowsGrantTiming {
  readonly steps: Record<WindowsGrantTimingStep, number>;
  rows: number;
  timeStep<T>(key: WindowsGrantTimingStep, operation: () => T): T;
}

async function grantWindowsWorkerFilesystemAccessInTurn(
  request: WindowsWorkerFilesystemGrantRequest,
): Promise<WindowsWorkerFilesystemGrant> {
  const started = performance.now();
  const liveGrants = sandboxSession?.windowsLiveGrantCount ?? 0;
  const timing: WindowsGrantTiming = {
    steps: { preflightMs: 0, srtWinPrepMs: 0, userStatusMs: 0, pinsMs: 0, denyReadMs: 0, stampMs: 0, assertMs: 0, grantMs: 0, grantRevokeMs: 0, configMs: 0 },
    rows: 0,
    timeStep: (key, operation) => {
      const stepStarted = performance.now();
      try { return operation(); }
      finally { timing.steps[key] += performance.now() - stepStarted; }
    },
  };
  try { return await runWithSandboxWritePreflight(undefined, () => grantWindowsWorkerFilesystemAccessTurnBody(request, timing)); }
  finally {
    // A refused turn's rows are unreachable; only write roots still in use keep rows watched.
    pruneWatchedRows(watchedRootsInUse(sandboxSession));
    // totalMs is turn wall time, including the dynamic import yield.
    const fields = { ...timing.steps, liveGrants, totalMs: performance.now() - started, rows: timing.rows };
    log.info(fields, "windows grant turn timing");
    if (fields.totalMs > 5000) log.warn(fields, "windows grant turn timing");
  }
}

async function grantWindowsWorkerFilesystemAccessTurnBody(
  request: WindowsWorkerFilesystemGrantRequest,
  timing: WindowsGrantTiming,
): Promise<WindowsWorkerFilesystemGrant> {
  const { timeStep } = timing;
  const { assertStillValid, holderPid: requestedHolderPid, sandboxHome, ...opts } = request;
  timeStep("preflightMs", () => assertStillValid?.());
  if (process.platform === "win32") {
    for (const path of [...(opts.allowRead ?? []), ...(opts.allowWrite ?? [])]) {
      const prefix = containsGlobCharsWin(path) ? globPatternBaseDir(toForwardSlashes(path)) : path;
      assertWindowsGrantGrammar(prefix);
    }
  }
  timeStep("preflightMs", () => assertAveHomePrivacyForConfinement());
  const session = sandboxSession;
  const SandboxManager = loadedSandboxManagerForRelease;
  if (!active || _baseTrustedSettings === undefined || session === undefined || SandboxManager === undefined) {
    throw new Error(
      "grantWindowsWorkerFilesystemAccess: ASRT sandbox is not active (initialize at boot first)",
    );
  }
  if (process.platform !== "win32") {
    throw new Error("grantWindowsWorkerFilesystemAccess is only valid on win32");
  }
  const baseTrustedSettings = _baseTrustedSettings;
  const admitted = timeStep("preflightMs", () => admitFilesystemPolicy({ allowRead: [...(opts.allowRead ?? [])], allowWrite: [...(opts.allowWrite ?? [])] }));
  if (AVE_HOME_ISOLATION_GUARD_ACTIVE) timeStep("preflightMs", () => checkSandboxStampTargets([...admitted.allowRead, ...admitted.allowWrite]));
  const pinned = admittedWindowsPolicies.get(admitted)!;
  if ([pinned.allowRead, pinned.allowWrite].some(entries =>
    entries !== undefined && timeStep("preflightMs", () => existingWindowsGrants(entries)).length !== entries.length)) {
    throw new Error("Windows filesystem grant identity is unproven: requested target is missing");
  }
  timeStep("preflightMs", () => checkWindowsSandboxStampTargets(pinned));
  const [
    { getWindowsSandboxUserStatus, grantWindowsAcl, revokeWindowsAcl, resolveSrtWin },
    { stampWindowsAclAsync },
  ] = await Promise.all([
    import("@anthropic-ai/sandbox-runtime"),
    import("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js"),
  ]);

  if (sandboxSession !== session || !active) {
    throw new Error("Windows filesystem grant session was reset");
  }
  assertWindowsDenyProtection();

  const srtWin = timeStep("srtWinPrepMs", () => resolveSrtWin({ path: getVerifiedSrtWinExePath() }));
  const user = timeStep("userStatusMs", () => getWindowsSandboxUserStatus({ srtWin }));
  const sandboxUserSid = user.sid;
  if (!user.provisioned || !user.credPresent || sandboxUserSid === undefined) {
    throw new Error(
      "grantWindowsWorkerFilesystemAccess: Windows sandbox user is not provisioned",
    );
  }

  const requestedWrite = windowsPinnedPaths(timeStep("preflightMs", () => existingWindowsGrants(pinned.allowWrite ?? [])));
  const requestedRead = [
    ...windowsPinnedPaths(timeStep("preflightMs", () => existingWindowsGrants(pinned.allowRead ?? []))),
    ...requestedWrite,
  ];

  for (const path of requestedRead) assertWindowsGrantGrammar(path);
  const pins = timeStep("pinsMs", () => pinWindowsGrantTargets(requestedRead, { validatePath: assertWindowsGrantGrammar }));
  const identities = new Map(pins.map(pin => [windowsObjectKey(pin), pin]));
  const requests = pins.map(pin => ({ path: stripExtendedPathPrefix(pin.canonical!), identity: windowsObjectKey(pin) }));
  const allowRead = requests.map(request => request.path);
  const allowWrite = requests.slice(requestedRead.length - requestedWrite.length).map(request => request.path);
  timeStep("preflightMs", () => assertWindowsGrantBoundaries(allowRead, allowWrite, sandboxHome));
  timeStep("preflightMs", () => checkWindowsSandboxStampTargets(pinned));

  const resolveDocumentsPath = scopedWindowsDocumentsPath();
  const settings = timeStep("configMs", () => withWorkerUnixSockets(baseTrustedSettings, undefined, resolveDocumentsPath));
  const revision = session.windowsDenyRevision;
  const grantRevision = session.windowsLiveGrantRevision;
  const pending = timeStep("configMs", () => {
    const liveGrants = snapshotWindowsLiveGrants(session);
    return buildSandboxConfig(settings, _baseReadDenyEvidence, {
      allowRead: [...(liveGrants.allowRead ?? []), ...allowRead.map(path => ({ path, literal: true as const }))],
      allowWrite: [...(liveGrants.allowWrite ?? []), ...allowWrite.map(path => ({ path, literal: true as const }))],
    });
  });
  const rows = timeStep("preflightMs", () => {
    const distinct = new Map<string, { path: string; read: boolean }>();
    for (const kind of ["denyRead", "denyWrite"] as const) {
      // Raw rows include omitted targets and unmatched patterns from initialization and every earlier wrap.
      for (const entry of [...(settings[kind] ?? []), ...pending.filesystem[kind]]) {
        const overlap = overlappingWindowsDeny(entry, allowWrite, kind === "denyWrite");
        if (overlap === undefined) continue;
        const { expanded, path, glob } = overlap;
        if (glob) throw new Error("Windows filesystem write grant overlaps a deny glob");
        // Retain the first operand so a read deny keeps its stronger mask.
        const key = windowsDenyOperandKey(expanded);
        if (!distinct.has(key)) distinct.set(key, { path, read: kind === "denyRead" });
      }
    }
    // An absent row is watched, never stamped: the native stamp would create it.
    return [...distinct.values()].filter(row => {
      if (windowsDenyTargetPresent(row.path)) return true;
      watchAbsentProtectedRow(row.path, allowWrite.filter(root => lexicalWindowsOverlap(root, row.path)));
      return false;
    });
  });
  const targets = rows.map(row => row.path);
  timing.rows = rows.length;
  assertWindowsDenyTargetsPresent(targets);
  assertWindowsPolicyBudget({ denyWrite: targets }, hasConfiguredDenies(settings));
  const previous = timeStep("denyReadMs", () => readWindowsDenyAcls(targets, sandboxUserSid));
  assertWindowsGrantDenySnapshot(session, revision, allowWrite);
  const denyRead = rows.filter((row, index) => row.read || (previous[index]!.denyMask & ~WINDOWS_WRITE_DENY_MASK) !== 0).map(row => row.path);
  const denyWrite = targets;
  assertWindowsPolicyBudget({ denyRead, denyWrite }, hasConfiguredDenies(settings));
  let stampFailure: Error | undefined;
  if (targets.length > 0) {
    const stampStarted = performance.now();
    try {
      windowsGrantStamp = stampWindowsAclAsync({ sandboxUserSid, holderPid: process.pid, denyRead, denyWrite, srtWin });
      await windowsGrantStamp;
    } catch (error) {
      stampFailure = error instanceof Error ? error : new Error(errorMessage(error));
    } finally {
      windowsGrantStamp = undefined;
      timing.steps.stampMs += performance.now() - stampStarted;
    }
    if (stampFailure !== undefined) {
      log.warn(`[sandbox-deny-target] Refusing Windows filesystem grant: ${stampFailure.message}`);
    }
    // Verify even after a partial stamp. Never release the session holder on failure.
    try {
      const native = timeStep("denyReadMs", () => readWindowsDenyAcls(targets, sandboxUserSid));
      const readTargets = new Set(denyRead);
      for (const [index, row] of rows.entries()) {
        const state = native[index]!;
        const mask = readTargets.has(row.path) ? WINDOWS_READ_DENY_MASK : WINDOWS_WRITE_DENY_MASK;
        if ((state.denyMask & mask) !== mask || (state.parentMask & 0x40) !== 0x40
          || (state.directory && (state.inheritableMask & mask) !== mask)) {
          throw new Error("Windows deny DACL verification failed");
        }
      }
    } catch (error) {
      // Keep activity sealed on so callers cannot fall back to host execution.
      session.windowsDenyFailure = new Error("Windows deny DACL verification failed; reset the sandbox session", { cause: error });
      throw session.windowsDenyFailure;
    }
  }

  assertWindowsGrantDenySnapshot(session, revision, allowWrite);
  if (_baseTrustedSettings !== baseTrustedSettings || session.windowsLiveGrantRevision !== grantRevision) {
    throw new Error("Windows sandbox policy changed while stamping the worker grant");
  }
  timeStep("preflightMs", () => assertWindowsGrantBoundaries(allowRead, allowWrite, sandboxHome));
  timeStep("preflightMs", () => assertStillValid?.());
  if (stampFailure !== undefined) throw stampFailure;
  // Resolved after every refusal above, so a refused turn starts no holder.
  const holderPid = timeStep("preflightMs", () => typeof requestedHolderPid === "number" ? requestedHolderPid : requestedHolderPid());
  if (allowRead.length > 0 || allowWrite.length > 0) {
    try {
      timeStep("assertMs", () => assertWindowsGrantPins(requests, identities));
      // srt-win writes the DACL by name: a swap between the pre-pin and native write
      // cannot be excluded. Only the post-pin and revoke detect that remaining window.
      // A swap restored before the post-pin is undetected; a crash before it skips
      // compensation. After holder exit, a later native ACL operation prunes its
      // tracked hold; sweepStaleSrtWinDirectories cleans stale helper copies.
      // Neither recovers a by-name grant to an object absent from that ledger.
      // Root protection is point-in-time: a garbage-collected loop's roots drop out
      // even if an ACL holder survives, and later root changes do not revalidate
      // existing grants. Provider-backed non-surrogate (cloud) ancestor descent
      // remains unexercised on this host.
      timeStep("grantMs", () => grantWindowsAcl({
        sandboxUserSid,
        holderPid,
        read: allowRead,
        write: allowWrite,
        srtWin,
      }));
      timeStep("assertMs", () => assertWindowsGrantPins(requests, identities));
    } catch (err) {
      let outcome: ReturnType<typeof revokeWindowsAcl> = undefined;
      let cleanupError: unknown;
      let exitedOk = true;
      try { outcome = timeStep("grantRevokeMs", () => revokeWindowsAcl({ sandboxUserSid, holderPid, srtWin, onExit: ok => { exitedOk = ok; } })); }
      catch (error) { cleanupError = error; }
      if (!hasWindowsGrantCleanup(requests, outcome, exitedOk)) {
        // Keep confinement active: disabling it would permit host execution fallback.
        session.windowsDenyFailure = new Error(`Windows filesystem grant cleanup failed for ${allowRead.join(", ")}; reset the sandbox session`, { cause: cleanupError ?? err });
        log.error(`[sandbox-grant-cleanup] paths=${JSON.stringify(allowRead)} holder=${holderPid} outcome=${JSON.stringify(outcome)} error=${cleanupError === undefined ? "none" : errorMessage(cleanupError)}`);
        throw session.windowsDenyFailure;
      }
      throw err;
    }
  }

  const writable = new Set(allowWrite);
  session.windowsLiveGrantCount += 1;
  if (allowRead.length > 0) session.windowsLiveGrantRevision += 1;
  for (const path of allowRead) {
    const counts = session.windowsLiveGrants.get(path) ?? { read: 0, write: 0 };
    counts.read += 1;
    if (writable.has(path)) counts.write += 1;
    session.windowsLiveGrants.set(path, counts);
  }

  let released = false;
  let revokeMs = 0;
  let configMs = 0;
  const revokeGrant = (): boolean => {
    let outcome: ReturnType<typeof revokeWindowsAcl> = undefined;
    let cleanupError: unknown;
    let exitedOk = true;
    const revokeStarted = performance.now();
    try { outcome = revokeWindowsAcl({ sandboxUserSid, holderPid, srtWin, onExit: ok => { exitedOk = ok; } }); }
    catch (error) { cleanupError = error; }
    finally { revokeMs = performance.now() - revokeStarted; }
    if (!hasWindowsGrantCleanup(requests, outcome, exitedOk)) {
      session.windowsDenyFailure = new Error(`Windows filesystem grant cleanup failed for ${allowRead.join(", ")}; reset the sandbox session`, { cause: cleanupError ?? outcome });
      log.error(`[sandbox-grant-cleanup] paths=${JSON.stringify(allowRead)} holder=${holderPid} outcome=${JSON.stringify(outcome)} error=${cleanupError === undefined ? "none" : errorMessage(cleanupError)}`);
      return false;
    }
    return true;
  };
  const releaseWithTiming = (releaseBody: () => void): void => {
    if (released) return;
    released = true;
    const releaseStarted = performance.now();
    const liveGrants = session.windowsLiveGrantCount;
    try { releaseBody(); }
    finally {
      const fields = { revokeMs, configMs, liveGrants, totalMs: performance.now() - releaseStarted };
      log.info(fields, "windows grant release timing");
      if (fields.totalMs > 5000) log.warn(fields, "windows grant release timing");
    }
  };
  const grant: WindowsWorkerFilesystemGrant = {
    allowRead,
    allowWrite,
    release: () => releaseWithTiming(() => {
      session.windowsLiveGrantCount -= 1;
      if (allowRead.length > 0) session.windowsLiveGrantRevision += 1;
      for (const path of allowRead) {
        const counts = session.windowsLiveGrants.get(path);
        if (counts === undefined) continue;
        counts.read -= 1;
        if (writable.has(path)) counts.write -= 1;
        if (counts.read === 0) session.windowsLiveGrants.delete(path);
      }
      const revoked = revokeGrant();
      if (allowWrite.length > 0) sweepWatchedRowsAfterRelease(session, `windows-grant-${holderPid}`);
      if (!revoked) return;
      if (sandboxSession === session && active && _baseTrustedSettings !== undefined) {
        const configStarted = performance.now();
        try {
          SandboxManager.updateConfig(
            buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings), _baseReadDenyEvidence, snapshotWindowsLiveGrants(session)),
          );
        } catch (cause) {
          session.windowsDenyFailure = new Error(`Windows filesystem grant config cleanup failed for ${allowRead.join(", ")}; reset the sandbox session`, { cause });
          log.error(session.windowsDenyFailure);
        } finally {
          configMs += performance.now() - configStarted;
        }
      }
    }),
  };
  try {
    timeStep("configMs", () => SandboxManager.updateConfig(
      buildSandboxConfig(withWorkerUnixSockets(baseTrustedSettings, undefined, resolveDocumentsPath), _baseReadDenyEvidence, snapshotWindowsLiveGrants(session)),
    ));
    if (resolveDocumentsPath !== undefined) session.sharedWindowsDocumentsPath = resolveDocumentsPath;
  } catch (error) {
    grant.release();
    timing.steps.grantRevokeMs += revokeMs;
    timing.steps.configMs += configMs;
    throw error;
  }
  return grant;
}

// Whether `path` is at or inside `sandboxHome`, and that HOME is a directory directly inside a private root's `homes`.
function insideOwnWindowsSandboxHome(path: string, sandboxHome: string | undefined): boolean {
  if (sandboxHome === undefined) return false;
  const home = win32.resolve(sandboxHome).toLowerCase();
  if (!appOwnedSandboxPrivateRoots().some(root => win32.dirname(home) === win32.join(root, "homes").toLowerCase())) return false;
  const resolved = win32.resolve(path).toLowerCase();
  return resolved === home || resolved.startsWith(home + win32.sep);
}

function assertWindowsGrantBoundaries(read: readonly string[], write: readonly string[], sandboxHome?: string): void {
  assertPrivateHelperGrants(read, write);
  assertWindowsMachineRootWriteGrants(write);
  for (const path of read) {
    if (windowsMachineRoots().some(root => win32.resolve(path).toLowerCase() === win32.resolve(root).toLowerCase())) {
      throw new Error(`Windows filesystem grant refuses a machine root: ${path}`);
    }
    if ([...listAuthorizedWorkspaceRoots(), aveHome()]
      .some(root => isGrantPathWithin(path, root))) {
      throw new Error(`Windows filesystem grant refuses an ancestor of the workspace or Ave home: ${path}`);
    }
    // The private roots are closed to every grant but the caller's own HOME.
    const privateRoots = insideOwnWindowsSandboxHome(path, sandboxHome) ? [] : appOwnedSandboxPrivateRoots();
    if (protectedReadDenyCovering(path, [...getDefaultSensitiveDenyPaths(_baseTrustedSettings?.userDataDir), ...privateRoots])) {
      throw new Error(`Windows filesystem grant is inside a protected sensitive target: ${path}`);
    }
    if (aveHomeReadBoundaryCovering(path) !== undefined) {
      throw new Error(`Windows filesystem grant is inside the Ave home outside a re-allowed child: ${path}`);
    }
  }
  const writeDenyCovering = write.length > 0 ? protectedReadDenyMatcher(getDefaultSensitiveWriteDenyEntries()) : undefined;
  for (const path of write) {
    if (writeDenyCovering?.(path) !== undefined) {
      throw new Error(`Windows filesystem write grant is inside a protected sensitive target: ${path}`);
    }
  }
}

function overlappingWindowsDeny(entry: FilesystemPathEntry, allowWrite: readonly string[], preserveLiteral = false) {
  if (allowWrite.length === 0) return;
  const raw = typeof entry === "string" ? entry : entry.path;
  const expanded = preserveLiteral && typeof entry !== "string" ? raw : expandWindowsEnvRefs(expandLeadingTilde(raw));
  const path = stripExtendedPathPrefix(expanded);
  const glob = (typeof entry === "string" || !entry.literal) && containsGlobCharsWin(path);
  const boundary = glob ? globPatternBaseDir(toForwardSlashes(path)) : path;
  if (allowWrite.some(grant => isGrantPathWithin(grant, boundary) || isGrantPathWithin(boundary, grant)
    || lexicalWindowsOverlap(grant, boundary))) return { expanded, path, glob };
}

function assertWindowsGrantDenySnapshot(session: AsrtSandboxSession, revision: number, allowWrite: readonly string[]): void {
  assertWindowsSession(session, revision);
  if (allowWrite.length === 0) return;
  for (const { read, write } of session.windowsPendingWrapDenies) {
    if (read.some(entry => overlappingWindowsDeny(entry, allowWrite) !== undefined)
      || write.some(entry => overlappingWindowsDeny(entry, allowWrite, true) !== undefined)) {
      throw new Error("Windows deny obligations changed while verifying the write grant");
    }
  }
}

function lexicalWindowsOverlap(left: string, right: string): boolean {
  // A conservative deny-overlap check can overmatch case; it never merges object identities.
  const a = caseFoldForMatch(toForwardSlashes(win32.resolve(left))).replace(/\/+$/, "");
  const b = caseFoldForMatch(toForwardSlashes(win32.resolve(right))).replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

interface WindowsGrantTarget {
  readonly path: string;
  readonly identity: string;
}

// Match the runtime's "ACL release outcome" patch; its status sets are not exported.
const WINDOWS_GRANT_RELEASED_STATUSES = new Set(["revoked", "stillHeld", "downgraded", "relocated", "noRow", "restored", "alreadyOriginal"]);
const WINDOWS_GRANT_STALE_STATUSES = new Set(["mismatch", "missing"]);

function hasWindowsGrantCleanup(requests: readonly WindowsGrantTarget[], outcome: unknown, exitedOk: boolean): boolean {
  if (!exitedOk || !Array.isArray(outcome) || outcome.some(row => row === null || typeof row !== "object"
    || typeof row.path !== "string" || (!WINDOWS_GRANT_RELEASED_STATUSES.has(row.status) && !WINDOWS_GRANT_STALE_STATUSES.has(row.status)))) return false;
  const staleCounts = new Map<string, number>();
  for (const row of outcome) {
    if (WINDOWS_GRANT_STALE_STATUSES.has(row.status)) staleCounts.set(row.status, (staleCounts.get(row.status) ?? 0) + 1);
  }
  if (staleCounts.size > 0) log.warn("Windows grant release dropped stale rows (%s); recovery cannot revisit dropped rows",
    [...staleCounts].map(([status, count]) => `${status} x${count}`).join(", "));
  // A clean empty ledger means the holder was already removed or pruned. Dropped release paths require a non-zero exit.
  if (outcome.length === 0) return true;
  const objects = new Map<string, string[]>();
  for (const request of requests) objects.set(request.identity, [...(objects.get(request.identity) ?? []), request.path]);
  const spellings = [...objects.values()];
  const spelling = (path: string): string => win32.normalize(stripExtendedPathPrefix(path)).replace(/[\\/]+$/, "");
  const used = new Set<number>();
  return spellings.every(paths => {
    let index = outcome.findIndex((row, offset) => !used.has(offset) && paths.some(path => spelling(row.path) === spelling(path)));
    if (index < 0) {
      index = outcome.findIndex((row, offset) => !used.has(offset)
        && paths.some(path => windowsPathKey(row.path) === windowsPathKey(path))
        // Fold only unambiguous ledger spellings, never distinct case-only objects.
        && spellings.filter(other => other.some(path => windowsPathKey(row.path) === windowsPathKey(path))).length === 1);
    }
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}

function assertWindowsGrantPins(requests: readonly WindowsGrantTarget[], identities: ReadonlyMap<string, WindowsPathFacts>): void {
  const paths = requests.map(request => request.path);
  let rows: readonly WindowsPathFacts[];
  try { rows = pinWindowsPaths(paths); }
  catch (cause) { throw new Error(`Windows filesystem grant identity check failed: ${paths.join(", ")}`, { cause }); }
  for (const [index, path] of paths.entries()) {
    const row = rows[index]!;
    const expected = identities.get(requests[index]!.identity)!;
    if (admitWindowsReparse(row, "grant") !== true || row.exists !== true
      || row.volumeSerial !== expected.volumeSerial || row.fileId !== expected.fileId) {
      throw new Error(`Windows filesystem grant target identity changed: ${path}`);
    }
  }
}

function assertPrivateHelperGrants(read: readonly string[], write: readonly string[]): void {
  // Direct grants would override the image's DACL. A writable ancestor could replace the whole directory using its delete-child right, even though the image itself does not inherit the ancestor's permissions.
  if (srtWinPrivateDirectories().some((bin) =>
    read.some((path) => isGrantPathWithin(dirname(bin), path)) ||
    write.some((path) => isGrantPathWithin(dirname(bin), path) || isGrantPathWithin(path, dirname(bin))))) {
    throw new Error("Windows filesystem grant overlaps a private helper image");
  }
}

// Per-command cleanup pass-through (`SandboxManager.cleanupAfterCommand`). Call after a wrapped command finishes.
export async function cleanupAsrtSandboxAfterCommand(): Promise<void> {
  if (containerOnlyConfig !== undefined) return;
  const SandboxManager = await loadSandboxManager();
  SandboxManager.cleanupAfterCommand();
}

// Full teardown pass-through (`SandboxManager.reset`). Stops proxy servers and clears state.
export function resetAsrtSandbox(): Promise<void> {
  sandboxResetPending ??= resetSandboxRuntime().finally(() => {
    sandboxResetPending = undefined;
  });
  return sandboxResetPending;
}

async function resetSandboxRuntime(): Promise<void> {
  // The host owns the processes. Their invocation release, after termination, still owns bare-layout cleanup even if the runtime is reset first.
  active = false;
  loadedSandboxManagerForRelease = undefined;
  windowsExternalConfinement = false;
  const containerOnly = containerOnlyConfig !== undefined;
  containerOnlyConfig = undefined;
  // Reset base settings and live socket holders so reinitialization cannot inherit stale allowances.
  _baseTrustedSettings = undefined;
  _baseReadDenyEvidence = undefined;
  sandboxSession?.windowsLiveGrants.clear();
  sandboxSession = undefined;
  resetWatchedRows();
  windowsProfileReadDenyWarnings.clear();
  windowsReadDenyWarnings.clear();
  windowsAbsentDenyWarnings.clear();
  windowsDenyStatWarnings.clear();
  _workerUnixSocketDirs.clear();
  // Invalidate admission before the first await; pending wraps must not reach
  // the native runtime once teardown has been requested.
  // Let an in-flight grant stamp settle before restoring its session deny ACLs.
  if (windowsGrantStamp !== undefined) await windowsGrantStamp.catch(() => {});
  try {
    // A relay port still bound rejects after the rest of the teardown, and a later reset retries it.
    try {
      await stopEgressRelayService();
    } finally {
      if (!containerOnly) await resetWrapRuntime();
    }
  } finally {
    // Drop every wrapped-worker marker (MCP servers AND host-spawned plugin workers) so a torn-down sandbox cannot leave a stale `asrt` signal the reviewer would honour. Lazy import keeps the module-load edge one-way (sandbox-capability is renderer-safe and never imports back into this main-only module).
    const { clearWrappedMcpServers, clearWrappedPluginWorkers, clearConfinedPluginChildren } =
      await import("./sandbox-capability.js");
    clearWrappedMcpServers();
    clearWrappedPluginWorkers();
    clearConfinedPluginChildren();
  }
}

// A failed Windows ACL release (carried patch part 12), or an invocation listener port still bound (part 3), rejects after the rest of the
// teardown; the release then stays pending, so the private helper copy is kept for the runtime's exit handler and the next boot's recovery
// to retry.
async function resetWrapRuntime(): Promise<void> {
  const SandboxManager = await loadSandboxManager();
  try {
    logResetRows(await SandboxManager.reset());
    markSrtWinRuntimeReleased();
  } catch (error) {
    logResetRows(failedResetReport(error));
    throw error;
  }
}

// The quit sequence's release: after every confined child is down, reset an initialized runtime while its private helper copy still exists, so on
// Windows the session's ACEs are revoked and restored now rather than by the next boot's recovery. A failure propagates to the caller's shutdown outcome.
export async function releaseAsrtSandboxForExit(): Promise<void> {
  // An initializing owner can already hold proxies or bridges without an active capability.
  if (active || sandboxInitializationPending || sandboxResetPending !== undefined) await resetAsrtSandbox();
}

// Introspection: whether the current platform supports ASRT sandboxing. Pass-through to `SandboxManager.isSupportedPlatform`.
export async function isAsrtSandboxSupported(): Promise<boolean> {
  const SandboxManager = await loadSandboxManager();
  return SandboxManager.isSupportedPlatform();
}

// Append the sandbox violations ASRT recorded under `commandId` to a command's output, as a `<sandbox_violations>` block (ASRT's `annotateStderrWithSandboxFailures`), so the model reads why a host or path failed instead of a bare connection error. Returns the text unchanged when nothing was recorded. A proxy deny line names `host:port` and the reason; ASRT has already reduced a refused URL's query string to `?…`. Host notices (write narrowing, quarantine) are appended to the same text, and a protected-`.git` failure gets the host-approval hint.
export async function annotateWithSandboxViolations(
  commandId: string,
  text: string,
  command?: string,
  notices: readonly string[] = [],
): Promise<string> {
  const joined = [text, ...new Set(notices)].filter(Boolean).join("\n");
  const wrapped = containerOnlyConfig !== undefined ? joined
    : (await loadSandboxManager()).annotateStderrWithSandboxFailures(commandId, joined);
  // A contained route's refusals are the relay's records, in the same block.
  const relayed = egressRelayViolationLines(commandId);
  const annotated = relayed.length === 0 ? wrapped : `${wrapped}${EOL}<sandbox_violations>${EOL}${relayed.join(EOL)}${EOL}</sandbox_violations>`;
  if (annotated.includes("`.git` metadata is protected; rerun outside the sandbox after approval")) return annotated;
  const deniedMetadata = /\.git(?:[\\/\s:'"`]|$)/iu.test(annotated)
    && /(?:permission denied|operation not permitted|read.only file system|sandbox.*deny|sandbox.*violation|invalid gitfile format|not a directory)/iu.test(annotated);
  // Protected metadata can make repository creation fail before a direct write error is reported. This only explains the existing host-approval route.
  const blockedCloneDestination = command !== undefined && /\bgit\b[^\n]*\bclone\b/u.test(command)
    && /destination path .*already exists and is not an empty directory/iu.test(annotated);
  if (deniedMetadata || blockedCloneDestination) {
    return `${annotated}\n\`.git\` metadata is protected; rerun outside the sandbox after approval\n`
      + 'Use the existing shell request with executionMode: "host" and a justification; host approval is required.';
  }
  return annotated;
}

/** Only per-command native filesystem denial records establish escalation evidence.
 * Proxy denials and transport errors are separate policy decisions, never a host retry signal. */
export async function filesystemSandboxBlockForCommand(commandId: string, command: string, cwd: string): Promise<SandboxBlock | undefined> {
  assertCommandId("filesystemSandboxBlockForCommand", commandId);
  if (containerOnlyConfig !== undefined) return undefined;
  const SandboxManager = await loadSandboxManager();
  const records = SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId);
  const denied = records.some(({ line }) => !/^(?:deny|fail)\s/u.test(line)
    && /^[^()\r\n]+\([1-9]\d*\) deny\([1-9]\d*\) file-(?:read|write)(?:-[a-z0-9-]+)?(?:\s|$)/u.test(line));
  return denied ? issueFilesystemSandboxBlock(command, cwd) : undefined;
}

// One violation as ASRT's store reports it.
export interface AsrtViolationRecord {
  readonly line: string;
  readonly encodedCommand?: string;
  readonly timestamp: Date;
}

// Subscribe to ASRT's violation store. The listener receives the store's whole retained tail on every change (and once at subscription), not only the new entries; the caller tells new ones apart by identity, since the store keeps the same objects while they are retained.
export async function subscribeAsrtViolations(
  listener: (violations: readonly AsrtViolationRecord[]) => void,
): Promise<() => void> {
  const offRelay = subscribeEgressRelayViolations(listener);
  const SandboxManager = await loadSandboxManager();
  const offStore = SandboxManager.getSandboxViolationStore().subscribe(listener);
  return () => {
    offRelay();
    offStore();
  };
}
