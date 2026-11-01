// Keep version-sensitive calls in this adapter. Incomplete machine credentials leave confinement inactive until idempotent installation repairs them; installation also seals ambient writable roots. Every helper needs the explicit verified binary descriptor, and status/install probes stay async so elevation cannot freeze the UI.
import { windowsPowerShellEnv } from "../shared/windows-powershell-env.js";
import { win32SystemBinary } from "../shared/windows-system-path.js";
import type {
  SandboxWindowsInstallResult,
  SandboxWindowsStatusInfo,
} from "../shared/sandbox-capability-info.js";
import type { SrtWinSpawn } from "@anthropic-ai/sandbox-runtime";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { prepareSrtWinExecutable, SrtWinIntegrityError } from "./srt-win-integrity.js";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  getWindowsProfileReadDenyWarnings,
  getVendoredSrtWinExePath,
  rewriteAsarPathToUnpacked,
} from "./asrt-sandbox.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("asrt-windows-support");

type WindowsUserState = NonNullable<SandboxWindowsStatusInfo["userState"]>;
type WindowsWfpState = NonNullable<SandboxWindowsStatusInfo["wfpState"]>;

export interface AsrtWindowsSandboxUserStatusLike {
  readonly provisioned?: boolean;
  readonly sid?: string;
  readonly groupExists?: boolean;
  readonly inBuiltinUsers?: boolean;
  readonly inSandboxGroup?: boolean;
  readonly hiddenFromLogon?: boolean;
  readonly credPresent?: boolean;
}

interface AsrtWindowsWfpStatusLike {
  readonly state?: unknown;
}

type VerifyWindowsWfpEgressFn = (opts?: {
  readonly proxyPortRange?: readonly [number, number];
  readonly srtWin?: SrtWinSpawn;
}) => Promise<unknown>;

// ASRT 0.0.81 installation stays async during elevation; skipProfileGrant preserves caller-owned profile access.
type InstallWindowsSandboxAsyncFn = (opts: {
  readonly proxyPortRange: readonly [number, number];
  readonly srtWin?: SrtWinSpawn;
  readonly skipProfileGrant: true;
}) => Promise<AsrtWindowsInstallCancelledLike | AsrtWindowsInstallSuccessLike>;

interface ExecFileOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly windowsHide?: boolean;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: Error | null) => void,
) => unknown;

interface AsrtWindowsInstallRuntimeLike {
  readonly installWindowsSandboxAsync: InstallWindowsSandboxAsyncFn;
  readonly verifyWindowsWfpEgress: VerifyWindowsWfpEgressFn;
}

interface AsrtWindowsInstallDependencies {
  readonly loadRuntime?: () => Promise<AsrtWindowsInstallRuntimeLike>;
  readonly grantBackendAcl?: () => Promise<void>;
  // The pre-install status read (default readAsrtWindowsStatus).
  readonly readStatus?: () => Promise<SandboxWindowsStatusInfo>;
}

interface AsrtWindowsAclDependencies {
  readonly execFile?: ExecFileFn;
  readonly pathExists?: (path: string) => boolean;
  readonly resolvePackageRoot?: () => string;
  readonly systemRoot?: string;
  readonly warn?: (message: string, error: unknown) => void;
}

interface AsrtWindowsInstallCancelledLike {
  readonly cancelled: true;
}

interface AsrtWindowsInstallSuccessLike {
  readonly user: AsrtWindowsSandboxUserStatusLike;
  readonly wfp: AsrtWindowsWfpStatusLike;
}

function resolveAsrtPackageRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));
}

// Resolve the ASRT module namespace + the EXPLICIT srt-win spawn descriptor in one spot. ASRT 0.0.67 removed implicit vendored resolution and 0.0.73 still has none, so every srt-win-backed helper (status/install/verify) needs this descriptor built from the srt-win path SoT (getVendoredSrtWinExePath in asrt-sandbox.ts).
async function loadSrtWin(runtime?: typeof import("@anthropic-ai/sandbox-runtime")): Promise<{
  mod: typeof import("@anthropic-ai/sandbox-runtime");
  srtWin: SrtWinSpawn;
}> {
  const mod = runtime ?? await import("@anthropic-ai/sandbox-runtime");
  const srtWin = mod.resolveSrtWin({ path: prepareSrtWinExecutable(getVendoredSrtWinExePath()) });
  return { mod, srtWin };
}

const runExecFile: ExecFileFn = (file, args, options, callback) =>
  execFile(file, [...args], options, (error) => callback(error));

const ACL_TARGET_ENV = "AVE_ASRT_ACL_TARGET";
const ICACLS_PATH_ENV = "AVE_ASRT_ICACLS_PATH";
const ELEVATED_ACL_SCRIPT = [
  `$target = [Environment]::GetEnvironmentVariable('${ACL_TARGET_ENV}', 'Process')`,
  `$icacls = [Environment]::GetEnvironmentVariable('${ICACLS_PATH_ENV}', 'Process')`,
  "if ([string]::IsNullOrWhiteSpace($target) -or [string]::IsNullOrWhiteSpace($icacls)) { exit 87 }",
  `$quotedTarget = '"' + $target + '"'`,
  "$arguments = @($quotedTarget, '/grant', 'sandbox-runtime-users:(OI)(CI)(RX)', '/T', '/C')",
  "try { $process = Start-Process -FilePath $icacls -ArgumentList $arguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop; exit $process.ExitCode } catch { Write-Error $_; exit 1 }",
].join("; ");
const ELEVATED_ACL_ENCODED_COMMAND = Buffer.from(ELEVATED_ACL_SCRIPT, "utf16le").toString(
  "base64",
);

function resolveAsrtWindowsAclTarget(
  packageRoot: string,
  pathExists: (path: string) => boolean,
): string {
  // Single-authority asar→asar.unpacked rewrite (hoisted to asrt-sandbox.ts).
  const target = rewriteAsarPathToUnpacked(packageRoot);
  if (!pathExists(target)) {
    throw new Error(`ASRT backend ACL target does not exist: ${target}`);
  }
  return target;
}

function isAccessDeniedError(error: Error): boolean {
  const details = error as Error & {
    readonly code?: number | string;
    readonly errno?: number | string;
  };
  return (
    details.code === 5 ||
    details.code === "5" ||
    details.code === "EACCES" ||
    details.code === "EPERM" ||
    details.errno === 5 ||
    details.errno === "5" ||
    details.errno === "EACCES" ||
    details.errno === "EPERM"
  );
}

function executeFile(
  exec: ExecFileFn,
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<Error | null> {
  return new Promise((resolve) => {
    exec(file, args, options, resolve);
  });
}

// Mirror the installer's persistent group ACL grant for the runtime repair path. This is deliberately best-effort: a failed repair must not brick Settings or suppress the readiness result from the provision/verification steps.
export async function grantAsrtWindowsBackendAcl(
  dependencies: AsrtWindowsAclDependencies = {},
): Promise<void> {
  const exec = dependencies.execFile ?? runExecFile;
  const pathExists = dependencies.pathExists ?? existsSync;
  const resolvePackageRoot =
    dependencies.resolvePackageRoot ?? resolveAsrtPackageRoot;
  const environment = dependencies.systemRoot === undefined ? process.env : { SystemRoot: dependencies.systemRoot };
  const icaclsPath = win32SystemBinary("icacls", environment);
  const powershellPath = win32SystemBinary("WindowsPowerShell/v1.0/powershell", environment);
  const warn = dependencies.warn ?? console.warn;

  try {
    const packageRoot = resolveAsrtWindowsAclTarget(resolvePackageRoot(), pathExists);
    const icaclsArgs = [
      packageRoot,
      "/grant",
      "sandbox-runtime-users:(OI)(CI)(RX)",
      "/T",
      "/C",
    ];
    const error = await executeFile(exec, icaclsPath, icaclsArgs, { windowsHide: true });
    if (!error) return;

    if (!isAccessDeniedError(error)) {
      warn("[sandbox] ASRT backend ACL grant failed (non-fatal)", error);
      return;
    }

    const elevatedError = await executeFile(
      exec,
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        ELEVATED_ACL_ENCODED_COMMAND,
      ],
      {
        env: windowsPowerShellEnv({
          ...process.env,
          [ACL_TARGET_ENV]: packageRoot,
          [ICACLS_PATH_ENV]: icaclsPath,
        }),
        windowsHide: true,
      },
    );
    if (elevatedError) {
      warn("[sandbox] ASRT backend ACL elevated grant failed (non-fatal)", elevatedError);
    }
  } catch (error) {
    warn("[sandbox] ASRT backend ACL grant failed (non-fatal)", error);
  }
}

function hasUserProvisionSignal(user: AsrtWindowsSandboxUserStatusLike): boolean {
  return Boolean(
    user.provisioned ||
      user.sid ||
      user.groupExists ||
      user.inBuiltinUsers ||
      user.inSandboxGroup ||
      user.hiddenFromLogon ||
      user.credPresent,
  );
}

export function normalizeAsrtWindowsUserState(
  user: AsrtWindowsSandboxUserStatusLike,
): WindowsUserState {
  if (!hasUserProvisionSignal(user)) return "absent";
  if (
    user.provisioned === true &&
    typeof user.sid === "string" &&
    user.sid.length > 0 &&
    user.groupExists === true &&
    user.inBuiltinUsers === true &&
    user.inSandboxGroup === true &&
    user.hiddenFromLogon === true &&
    user.credPresent === true
  ) {
    return "ready";
  }
  return "incomplete";
}

export function normalizeAsrtWindowsWfpState(
  wfp: AsrtWindowsWfpStatusLike,
): WindowsWfpState {
  return wfp.state === "installed" || wfp.state === "cannot-read"
    ? wfp.state
    : "absent";
}

export function isAsrtWindowsReady(
  userState: WindowsUserState,
  wfpState: WindowsWfpState,
): boolean {
  return userState === "ready" && wfpState === "installed";
}

// Read the stable WindowsSandboxError `.code` off a caught value without importing the class — keeps resolveAsrtWindowsReady pure and unit-testable with a plain throwing stub. Returns undefined for a non-ASRT error (no string `.code`).
function windowsSandboxErrorCode(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export async function resolveAsrtWindowsReady(
  userState: WindowsUserState,
  wfpState: WindowsWfpState,
  verifyWindowsWfpEgress: VerifyWindowsWfpEgressFn,
  srtWin?: SrtWinSpawn,
): Promise<boolean> {
  if (isAsrtWindowsReady(userState, wfpState)) return true;
  if (userState !== "ready" || wfpState !== "cannot-read") return false;

  // ASRT 0.0.80 reports `cannot-read` when BFE enumeration is admin-gated. The non-elevated readiness proof is behavioral WFP egress verification.
  try {
    await verifyWindowsWfpEgress({
      proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE,
      srtWin,
    });
    return true;
  } catch (error) {
    const code = windowsSandboxErrorCode(error);
    if (code === "wfp_fence_inactive") {
      // DEFINITIVE not-ready: srt-win proved DIRECT egress SUCCEEDED, so the WFP fence is absent — the sandbox is not actually fencing egress.
      return false;
    }
    // Any other failure (bind failed, unparseable, spawn error, timeout, …) means we could NOT prove the fence is active. Fail-closed (not ready), but surface the code as a diagnostic instead of swallowing it silently.
    console.warn(
      "[sandbox] ASRT Windows WFP egress verification did not confirm the fence " +
        `(code=${code ?? "unknown"}) — treating the sandbox as not ready`,
    );
    return false;
  }
}

export async function readAsrtWindowsStatus(): Promise<SandboxWindowsStatusInfo> {
  if (process.platform !== "win32") {
    return {
      applicable: false,
      userState: null,
      wfpState: null,
      ready: false,
      instructions: "",
    };
  }

  const { getAveHomePrivacyFailure, areExtensionsWithoutIsolationApproved } = await import("../shared/ave-home.js");
  const failure = getAveHomePrivacyFailure();
  const profileReadDenyWarnings = getWindowsProfileReadDenyWarnings();
  if (failure !== undefined) {
    return {
      applicable: true,
      userState: null,
      wfpState: null,
      ready: false,
      homePrivacyError: { path: failure.failedPath ?? failure.home, category: failure.category, extraPrincipals: failure.extraPrincipals,
        approvedForSession: areExtensionsWithoutIsolationApproved() },
      profileReadDenyWarnings,
      instructions: "",
    };
  }
  const mod = await import("@anthropic-ai/sandbox-runtime");
  let srtWin: SrtWinSpawn;
  try {
    ({ srtWin } = await loadSrtWin(mod));
  } catch (error) {
    if (!(error instanceof SrtWinIntegrityError) &&
        (!(error instanceof mod.WindowsSandboxError) || error.code !== "srt_win_not_found")) {
      throw error;
    }
    // Missing external helper/configuration is expected in proxy-only mode. Its absence says nothing about provisioned user/WFP state or MXC shells.
    return {
      applicable: true,
      userState: null,
      wfpState: null,
      ready: false,
      helperError: error instanceof SrtWinIntegrityError ? error.code : "srt-win-not-found",
      profileReadDenyWarnings,
      instructions: mod.windowsInstallInstructions(undefined),
    };
  }
  // ASRT 0.0.80: ONE `srt-win status` spawn returns BOTH the sandbox-user and WFP state (checkWindowsSandboxStatusAsync), non-blocking — replaces the two separate synchronous user + wfp probes.
  const { user, wfp } = await mod.checkWindowsSandboxStatusAsync({ srtWin });
  const userState = normalizeAsrtWindowsUserState(user);
  const wfpState = normalizeAsrtWindowsWfpState(wfp);
  const ready = await resolveAsrtWindowsReady(
    userState,
    wfpState,
    mod.verifyWindowsWfpEgress,
    srtWin,
  );

  return {
    applicable: true,
    userState,
    wfpState,
    ready,
    instructions: mod.windowsInstallInstructions(undefined),
    profileReadDenyWarnings,
  };
}

export async function installAsrtWindowsSandbox(
  dependencies: AsrtWindowsInstallDependencies = {},
): Promise<SandboxWindowsInstallResult> {
  // Status is read HERE, after the IPC handler has validated the click's gesture intent, and not in the renderer before it calls this: a status read can take ~45 s (15 s srt-win status + 30 s WFP egress verify), and the renderer's transient user activation lapses after ~5 s, so an install invoked after a renderer-side read is refused as `user-keyboard-required` on exactly the machines that need the repair. Already ready → no UAC. A status read that fails does not block the repair: the install is the way out of it.
  try {
    const before = await (dependencies.readStatus ?? readAsrtWindowsStatus)();
    if (before.applicable && before.ready) {
      return {
        outcome: "already-ready",
        userState: before.userState ?? undefined,
        wfpState: before.wfpState ?? undefined,
        ready: true,
      };
    }
  } catch (error) {
    log.warn({ err: error }, "Windows sandbox status could not be read before install; installing anyway");
  }

  // Resolve the real module (for the explicit srt-win descriptor + the WindowsSandboxError class) once; the install/verify functions may be overridden by the DI seam for tests.
  let mod: typeof import("@anthropic-ai/sandbox-runtime");
  let srtWin: SrtWinSpawn;
  let runtime: AsrtWindowsInstallRuntimeLike;
  try {
    ({ mod, srtWin } = await loadSrtWin());
    runtime = dependencies.loadRuntime ? await dependencies.loadRuntime() : mod;
  } catch (error) {
    return failedInstall(error, error instanceof SrtWinIntegrityError ? error.code : "unexpected");
  }

  // ASRT 0.0.80: the install is ASYNC — the modal UAC prompt is still shown, but the main-process event loop stays live (spinners/timers keep running) rather than freezing for the full consent wait (class). The srt-win descriptor is explicit (no implicit vendored fallback since 0.0.67).
  let result: AsrtWindowsInstallCancelledLike | AsrtWindowsInstallSuccessLike;
  try {
    result = await runtime.installWindowsSandboxAsync({
      proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE,
      srtWin,
      skipProfileGrant: true,
    });
  } catch (error) {
    if (error instanceof mod.WindowsSandboxError) {
      if (error.code === "install_timeout") {
        // The self-elevating install subprocess was killed by the 120 s spawn timeout. The elevation prompt may still be open, or setup may have started already; this does not prove rollback or an unchanged host.
        log.warn({ errorCode: error.code, err: error }, "Windows sandbox install timed out; result unconfirmed");
        return { outcome: "timed-out" };
      }
      // install_ambient_failed (ASRT 0.0.80 exit 17) lands here too: the WFP filters and the sandbox user may both be in place, but the ambient write-deny stamps on the stock world-writable system directories did not. Treating that as installed would be dishonest in the dangerous direction — the filesystem confinement Ave publishes for win32 (`sandboxConfinementForPlatform` → `filesystem: true`) assumes those stamps exist — so it is a failure like any other ASRT code.
      return failedInstall(error, error.code);
    }
    return failedInstall(error, "unexpected");
  }

  if ((result as AsrtWindowsInstallCancelledLike | undefined)?.cancelled) {
    return { outcome: "cancelled", cancelled: true };
  }

  try {
    await (dependencies.grantBackendAcl ?? grantAsrtWindowsBackendAcl)();
  } catch (error) {
    // The default grant never throws: it is best-effort and logs its own failures. This catch only keeps this function's never-throw contract against an injected implementation (tests / DI).
    return failedInstall(error, "unexpected");
  }

  // A result without user/wfp (an unexpected ASRT shape) normalizes to absent → not ready → `installed-unverified`: what Ave can claim, no more.
  const success = (result ?? {}) as Partial<AsrtWindowsInstallSuccessLike>;
  const userState = normalizeAsrtWindowsUserState(success.user ?? {});
  const wfpState = normalizeAsrtWindowsWfpState(success.wfp ?? {});
  const ready = await resolveAsrtWindowsReady(
    userState,
    wfpState,
    runtime.verifyWindowsWfpEgress,
    srtWin,
  );
  return {
    outcome: ready ? "ready" : "installed-unverified",
    userState,
    wfpState,
    ready,
  };
}

// The failure the panel sees is the stable code only. ASRT's message carries srt-win stdout/stderr and local paths (the user profile among them), so it is logged here, in the main process, and never sent to the renderer.
function failedInstall(error: unknown, errorCode: string): SandboxWindowsInstallResult {
  log.warn({ errorCode, err: error }, "Windows sandbox install failed");
  return { outcome: "failed", errorCode };
}
