/**
 * Windows agent-shell confinement through Microsoft Execution Containers (MXC).
 *
 * Owner decision 2026-10-19 (proxy-egress PR 9): on a Windows host whose OS
 * offers MXC's ProcessContainer BaseContainer tier (PSEC), each Bash/PowerShell
 * tool command runs in its own MXC container, launched through the signed
 * `wxc-exec.exe` from `@microsoft/mxc-sdk` (MIT). The container gets:
 *
 * - filesystem grants for that one command (`readwritePaths`/`readonlyPaths`/
 *   `deniedPaths`), mapped from the same per-command policy the ASRT wrap gets
 *   ({@link buildMxcShellRequest});
 * - network only to ONE loopback port: MXC's per-container WFP filter permits
 *   egress to the configured `runtimeConfig.networkProxy` endpoint and nothing
 *   else. Ave gives every invocation its own proxy listener
 *   (`egress-invocation-listener.ts`), so the port a connection arrives on is
 *   the invocation that opened it, enforced by the kernel rather than by a
 *   username the client presents.
 *
 * Measured on Windows 11 26H2 26300.9711 with MXC 1.0.0 (2026-10-19; the
 * evidence is in the PR 9 description and docs/architecture/architecture.md,
 * "OS Execution Sandbox"): two
 * concurrent containers each reached only their own port; neither reached the
 * other's port directly or as a proxy, nor any other loopback listener, nor a
 * public address directly; the per-command filesystem lists held (a deny or a
 * read-only entry inside a write grant wins; a deny on a path that does not
 * exist yet still blocks its creation; a read-only entry on a missing path
 * does not); a container could not terminate a host process; killing
 * `wxc-exec.exe` tore the container down with every descendant.
 *
 * Why the CLI and not the Node SDK in-process: the SDK needs Node 24.21.0 or
 * later for Windows native stdio and Electron 44.3.0 ships Node 24.20.0. The
 * CLI relays stdin/stdout/stderr and the exit code (measured), and keeps the
 * 108 MB package out of the app: only `bin/<arch>/wxc-exec.exe` ships
 * (`scripts/fetch-mxc.mjs`).
 *
 * What is NOT here: plugin processes and the workspace terminal. MXC's proxy
 * mode forbids every direct egress rule (`runtimeConfig.networkProxy requires
 * network.egress.default='deny' with no direct allow or deny rules`,
 * measured), so a Windows plugin worker's loopback TCP control connection
 * cannot exist inside a container; those stay on srt-win. The terminal is a
 * user surface (owner 2026-10-16) and MXC kills background descendants with
 * the foreground.
 */
import { win32 as winPath } from "node:path";

import { errorMessage } from "../shared/error-message.js";
import type { SandboxMxcUnavailableReason } from "../shared/sandbox-capability-info.js";

/**
 * The stable MXC configuration schema version every request is written in.
 * The launcher is `@microsoft/mxc-sdk` 1.0.0's, pinned by scripts/fetch-mxc.mjs.
 */
const MXC_CONFIG_SCHEMA_VERSION = "1.0.0";

/** Why MXC cannot carry agent shells on this host. Stable codes, shown in Settings. */
type MxcUnavailableReason = SandboxMxcUnavailableReason;

export type MxcSupport =
  | { readonly state: "available"; readonly windowsBuild: string | null }
  | {
      readonly state: "unavailable";
      readonly reason: MxcUnavailableReason;
      readonly windowsBuild: string | null;
      /** Main-process diagnostic; may hold local paths, never sent to the renderer. */
      readonly detail: string;
    };

/** The architectures MXC ships `wxc-exec.exe` for. */
const MXC_ARCHES = new Set(["x64", "arm64"]);

/** `<resources>/mxc/<arch>/wxc-exec.exe`, or undefined for an arch MXC does not ship. */
export function wxcExecPathFor(resourcePath: string, arch: string): string | undefined {
  if (!MXC_ARCHES.has(arch)) return undefined;
  return winPath.join(resourcePath, "mxc", arch, "wxc-exec.exe");
}

/** The fields of `wxc-exec --probe` Ave reads. */
export interface MxcProbeReport {
  readonly tier: string | undefined;
  readonly needsDaclAugmentation: boolean | undefined;
}

/** Parse `wxc-exec --probe` stdout (one JSON object), or undefined when it is not one. */
export function parseMxcProbeOutput(stdout: string): MxcProbeReport | undefined {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as { tier?: unknown; needsDaclAugmentation?: unknown };
  return {
    tier: typeof record.tier === "string" ? record.tier : undefined,
    needsDaclAugmentation: typeof record.needsDaclAugmentation === "boolean" ? record.needsDaclAugmentation : undefined,
  };
}

export type MxcDryRunResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/**
 * Judge `wxc-exec --dry-run`: the request must validate AND select the
 * BaseContainer tier. Anything else (a parse error such as an identity-less
 * proxy the host's PSEC contract cannot carry, an AppContainer tier) is a
 * rejection; its first diagnostic line is kept for the log.
 */
export function parseMxcDryRunOutput(exitCode: number | null, stdout: string, stderr: string): MxcDryRunResult {
  const text = `${stdout}\n${stderr}`;
  if (
    exitCode === 0 &&
    /selected isolation tier: base-container/i.test(text) &&
    /validation passed/i.test(text)
  ) {
    return { ok: true };
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const diagnostic =
    lines.find((line) => /^configuration parse error/i.test(line)) ??
    lines.find((line) => /"message"\s*:/.test(line)) ??
    lines.find((line) => /selected isolation tier/i.test(line)) ??
    lines.find((line) => /error/i.test(line) && !/^warning:/i.test(line)) ??
    `exit ${String(exitCode)}`;
  return { ok: false, detail: diagnostic.slice(0, 500) };
}

export interface MxcRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DetectMxcSupportDeps {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The app's resource root (`getHostResources().resourcePath`). */
  readonly resourcePath: string;
  /** `major.minor.build.ubr`, for the Settings reason only; never the gate. */
  readonly windowsBuild: string | null;
  readonly exists: (path: string) => boolean;
  readonly run: (file: string, args: readonly string[], timeoutMs: number) => Promise<MxcRunResult>;
  /** An existing directory the dry-run request may name as its working directory. */
  readonly probeDirectory: string;
}

const MXC_PROBE_TIMEOUT_MS = 20_000;

/**
 * Decide, once at boot, whether agent shells can run in MXC on this host.
 *
 * The OS build number is not the gate: MXC 1.0.0 needs the PSEC 1.1 ingress
 * contract for an identity-less loopback proxy while 1.0.1 relaxes that, so a
 * build floor would be wrong now and drift on the next bump. The gate is what
 * the shipped binary reports: `--probe` must select `base-container`, and
 * `--dry-run` of the exact request shape Ave launches (proxy mode, DACL
 * fallback refused) must validate on that tier.
 */
export async function detectMxcSupport(deps: DetectMxcSupportDeps): Promise<MxcSupport> {
  const unavailable = (reason: MxcUnavailableReason, detail: string): MxcSupport => ({
    state: "unavailable",
    reason,
    windowsBuild: deps.windowsBuild,
    detail,
  });
  if (deps.platform !== "win32") return unavailable("not-windows", `platform ${deps.platform}`);
  const wxcExec = wxcExecPathFor(deps.resourcePath, deps.arch);
  if (wxcExec === undefined) return unavailable("unsupported-arch", `arch ${deps.arch}`);
  if (!deps.exists(wxcExec)) return unavailable("binary-missing", wxcExec);

  let probe: MxcRunResult;
  try {
    probe = await deps.run(wxcExec, ["--probe"], MXC_PROBE_TIMEOUT_MS);
  } catch (error) {
    return unavailable("probe-failed", errorMessage(error));
  }
  const report = probe.code === 0 ? parseMxcProbeOutput(probe.stdout) : undefined;
  if (report === undefined) return unavailable("probe-failed", `--probe exit ${String(probe.code)}`);
  if (report.tier !== "base-container") return unavailable("tier-unsupported", `tier ${report.tier ?? "unknown"}`);

  const request = buildMxcShellRequest({
    commandLine: "cmd.exe /d /c exit 0",
    cwd: deps.probeDirectory,
    grants: { readwrite: [deps.probeDirectory], readonly: [], denied: [] },
    env: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: deps.probeDirectory },
    proxyUrl: "http://127.0.0.1:9",
    timeoutMs: 1_000,
  });
  let dryRun: MxcRunResult;
  try {
    dryRun = await deps.run(wxcExec, ["--dry-run", ...mxcRequestArgs(request)], MXC_PROBE_TIMEOUT_MS);
  } catch (error) {
    return unavailable("probe-failed", errorMessage(error));
  }
  const verdict = parseMxcDryRunOutput(dryRun.code, dryRun.stdout, dryRun.stderr);
  if (!verdict.ok) return unavailable("request-rejected", verdict.detail);
  return { state: "available", windowsBuild: deps.windowsBuild };
}

/** The filesystem lists of one MXC launch, already ranked. */
export interface MxcFilesystemGrants {
  readonly readwrite: readonly string[];
  readonly readonly: readonly string[];
  readonly denied: readonly string[];
}

/** The per-command policy Ave's shells already compute for an ASRT wrap. */
export interface ShellFilesystemPolicy {
  readonly allowWrite: readonly string[];
  readonly allowRead: readonly string[];
  /** Broad and floor read denies (HOME, sandbox private roots, credential paths…). */
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  /**
   * The protected floor (credential paths, the user data directory, trusted
   * custom denies). A grant at or beneath one is dropped, as Windows ASRT
   * drops a grant beneath a credentials entry.
   */
  readonly protectedFloor: readonly string[];
  /**
   * Grants the shell holds INSIDE the protected floor on purpose (the saved
   * session history, `getBuiltinShellReadPolicy().floorPierces`). A grant at
   * or beneath one is not dropped by the floor.
   */
  readonly floorPierces?: readonly string[];
}

function foldPath(path: string): string {
  const normalized = winPath.normalize(path).replace(/[\\/]+$/, "");
  return (normalized.endsWith(":") ? `${normalized}\\` : normalized).toLowerCase();
}

/** True when `child` is `parent` or lies beneath it (Windows, case-insensitive). */
export function isWindowsPathAtOrUnder(child: string, parent: string): boolean {
  const c = foldPath(child);
  const p = foldPath(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith("\\") ? p : `${p}\\`);
}

function strictlyUnder(child: string, parent: string): boolean {
  return foldPath(child) !== foldPath(parent) && isWindowsPathAtOrUnder(child, parent);
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = foldPath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(winPath.normalize(path));
  }
  return out;
}

/**
 * Rank the ASRT-shaped per-command policy into MXC's three lists.
 *
 * MXC denies every path it is not given (system directories excepted), and a
 * more specific entry wins over a broader one (measured: a grant under a
 * denied parent is readable, a deny or read-only entry under a write grant
 * holds). So:
 *
 * - a grant at or beneath the protected floor is dropped, unless it is one
 *   of the floor's deliberate pierces (the saved session history);
 * - a write grant at or beneath a `denyWrite` path becomes read-only;
 * - a `denyWrite` path strictly inside a write grant becomes read-only when it
 *   exists and denied when it does not (a read-only entry on a missing path
 *   does not stop its creation; a deny does — measured);
 * - a `denyRead` path strictly inside any grant is denied, existing or not;
 *   one that is an ancestor of a grant (HOME above the workspace) is omitted,
 *   since everything outside the grants is denied already;
 * - grants that do not exist are dropped (MXC would warn and skip them).
 */
export function rankMxcFilesystem(policy: ShellFilesystemPolicy, exists: (path: string) => boolean): MxcFilesystemGrants {
  const pierces = policy.floorPierces ?? [];
  const floored = (path: string): boolean =>
    policy.protectedFloor.some((floor) => isWindowsPathAtOrUnder(path, floor)) &&
    !pierces.some((pierce) => isWindowsPathAtOrUnder(path, pierce));
  const writeDenied = (path: string): boolean => policy.denyWrite.some((deny) => isWindowsPathAtOrUnder(path, deny));

  const writeGrants = dedupe(policy.allowWrite).filter((path) => exists(path) && !floored(path));
  const readwrite = writeGrants.filter((path) => !writeDenied(path));
  const demoted = writeGrants.filter((path) => writeDenied(path));
  const readGrants = dedupe(policy.allowRead).filter((path) => exists(path) && !floored(path));

  const readonlyOut: string[] = [...readGrants, ...demoted];
  const denied: string[] = [];
  for (const deny of dedupe(policy.denyWrite)) {
    if (!readwrite.some((grant) => strictlyUnder(deny, grant))) continue;
    if (exists(deny)) readonlyOut.push(deny);
    else denied.push(deny);
  }
  const allGrants = [...readwrite, ...readonlyOut];
  for (const deny of dedupe([...policy.denyRead, ...policy.protectedFloor])) {
    if (allGrants.some((grant) => strictlyUnder(deny, grant))) denied.push(deny);
  }
  return {
    readwrite,
    readonly: dedupe(readonlyOut).filter((path) => !readwrite.some((grant) => foldPath(grant) === foldPath(path))),
    denied: dedupe(denied),
  };
}

/** The MXC 1.0.0 one-shot request Ave launches. Only the fields Ave sets. */
export interface MxcContainerRequest {
  readonly version: typeof MXC_CONFIG_SCHEMA_VERSION;
  readonly containment: "processcontainer";
  readonly process: {
    readonly commandLine: string;
    readonly cwd: string;
    readonly env: readonly string[];
    readonly inheritDefaultEnv: false;
    readonly timeout: number;
  };
  readonly filesystem: {
    readonly readwritePaths: readonly string[];
    readonly readonlyPaths: readonly string[];
    readonly deniedPaths: readonly string[];
  };
  readonly fallback: { readonly allowDaclMutation: false };
  readonly network: {
    readonly egress: { readonly default: "deny" };
    readonly ingress: { readonly default: "allow"; readonly hostLoopback: "allow" };
  };
  readonly runtimeConfig: { readonly networkProxy: string };
  readonly ui: { readonly disable: false; readonly clipboard: "none"; readonly injection: false };
}

export interface MxcShellRequestInput {
  readonly commandLine: string;
  readonly cwd: string;
  readonly grants: MxcFilesystemGrants;
  /** The child's whole environment. Proxy variables are dropped: MXC sets them. */
  readonly env: Readonly<Record<string, string>>;
  /** `http://127.0.0.1:<port>` of this invocation's own listener. */
  readonly proxyUrl: string;
  /** MXC's own timeout, a backstop behind the host's lifetime watch. */
  readonly timeoutMs: number;
}

/** Variables MXC derives from `runtimeConfig.networkProxy`; a caller value would contradict it. */
const PROXY_ENV_KEYS = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy"]);
/** MXC refuses a caller-owned environment block without these (schema.md, "Environment"). */
const REQUIRED_ENV_KEYS = ["SYSTEMROOT", "LOCALAPPDATA"] as const;

/**
 * Build the request for one confined command. Every security-relevant field is
 * fixed here rather than left to MXC's defaults:
 *
 * - `inheritDefaultEnv: false` with the caller's secret-stripped block: an
 *   omitted `process.env` hands the child the user's whole environment
 *   (measured);
 * - `fallback.allowDaclMutation: false`: never the AppContainer tier that
 *   stamps host ACLs;
 * - proxy-only egress on an identity-less loopback proxy, which is what pins
 *   the container to the one port;
 * - `ui.disable: false` because Windows PowerShell 5.1 and node fail
 *   `STATUS_DLL_INIT_FAILED` without Win32k (measured); clipboard and input
 *   injection stay closed.
 */
export function buildMxcShellRequest(input: MxcShellRequestInput): MxcContainerRequest {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(input.proxyUrl)) {
    throw new Error(`MXC proxy must be an http://127.0.0.1:<port> URL, got ${input.proxyUrl}`);
  }
  const grants = [...input.grants.readwrite, ...input.grants.readonly];
  if (!grants.some((grant) => isWindowsPathAtOrUnder(input.cwd, grant))) {
    throw new Error("MXC working directory must lie inside a granted path");
  }
  const env: string[] = [];
  const present = new Set<string>();
  for (const [key, value] of Object.entries(input.env)) {
    if (key.length === 0 || key.includes("=") || PROXY_ENV_KEYS.has(key.toLowerCase())) continue;
    env.push(`${key}=${value}`);
    present.add(key.toUpperCase());
  }
  const missing = REQUIRED_ENV_KEYS.filter((key) => !present.has(key));
  if (missing.length > 0) throw new Error(`MXC environment is missing ${missing.join(", ")}`);
  return {
    version: MXC_CONFIG_SCHEMA_VERSION,
    containment: "processcontainer",
    process: {
      commandLine: input.commandLine,
      cwd: winPath.normalize(input.cwd),
      env,
      inheritDefaultEnv: false,
      timeout: Math.max(1, Math.ceil(input.timeoutMs)),
    },
    filesystem: {
      readwritePaths: [...input.grants.readwrite],
      readonlyPaths: [...input.grants.readonly],
      deniedPaths: [...input.grants.denied],
    },
    fallback: { allowDaclMutation: false },
    network: { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" } },
    runtimeConfig: { networkProxy: input.proxyUrl },
    ui: { disable: false, clipboard: "none", injection: false },
  };
}

/** The `wxc-exec.exe` arguments carrying a request (no temp file, nothing secret in it). */
export function mxcRequestArgs(request: MxcContainerRequest): string[] {
  return ["--config-base64", Buffer.from(JSON.stringify(request), "utf8").toString("base64")];
}

/** Windows PowerShell 5.1 at its System32 path: never MSIX `pwsh`, which MXC refuses. */
function windowsPowerShellPath(systemRoot: string): string {
  return winPath.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The container command line for one PowerShell command. `-EncodedCommand`
 * carries the command as UTF-16LE base64, so no quoting of the command's own
 * text can change how the line splits.
 */
export function powerShellMxcCommandLine(systemRoot: string, command: string): string {
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  return `"${windowsPowerShellPath(systemRoot)}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/** Why the Bash tool does not run under MXC, for the tool result. */
export const MXC_BASH_UNAVAILABLE_MESSAGE =
  "Bash cannot run in the Windows sandbox on this host: Ave confines shell commands with " +
  "Microsoft Execution Containers here, and Git Bash (MSYS2) cannot start inside a container " +
  "(it is denied the named-object directory it creates at startup). Use the PowerShell tool " +
  "for this command. To run it in Git Bash anyway, retry with executionMode \"host\" and a " +
  "justification; that runs it unsandboxed after your approval.";

/** `<resources>/mxc/<arch>/wxc-exec.exe` for this host; throws when it does not ship here. */
export async function resolveHostWxcExecPath(): Promise<string> {
  const { getHostResources } = await import("../main/host-resources.js");
  const path = wxcExecPathFor(getHostResources().resourcePath, process.arch);
  if (path === undefined) throw new Error(`Microsoft Execution Containers do not ship for ${process.arch}`);
  return path;
}

/** {@link detectMxcSupport} against this host's shipped binary. */
export async function detectHostMxcSupport(): Promise<MxcSupport> {
  const [{ execFile }, { existsSync }, os, { getHostResources }] = await Promise.all([
    import("node:child_process"),
    import("node:fs"),
    import("node:os"),
    import("../main/host-resources.js"),
  ]);
  return detectMxcSupport({
    platform: process.platform,
    arch: process.arch,
    resourcePath: getHostResources().resourcePath,
    windowsBuild: process.platform === "win32" ? os.release() : null,
    exists: existsSync,
    probeDirectory: os.tmpdir(),
    run: (file, args, timeoutMs) =>
      new Promise((resolve, reject) => {
        execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
          if (error !== null && code === null) {
            reject(error);
            return;
          }
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
  });
}
