// Each shell command gets its own container, filesystem policy and kernel-bound proxy listener; deny/read-only entries outrank write grants, but missing read-only targets do not protect future paths. Killing the launcher tears down descendants, and containers cannot terminate host processes (docs/architecture/architecture.md).
// Use the signed CLI to relay stdio/exit while the embedded runtime lacks required native support. Plugin workers retain their separate sandbox because proxy mode forbids direct loopback control; terminals remain user-owned and need background descendants to survive.
import { win32 as winPath } from "node:path";
import { win32SystemBinary, windowsSystemRoot } from "../shared/windows-system-path.js";

import { errorMessage } from "../shared/error-message.js";
import type { SandboxMxcUnavailableReason } from "../shared/sandbox-capability-info.js";
import MXC_PINS from "./mxc-launcher-pins.json" with { type: "json" };

// The stable MXC configuration schema version every request is written in. The launcher is `@microsoft/mxc-sdk` 1.0.0's, pinned by scripts/fetch-mxc.mjs.
const MXC_CONFIG_SCHEMA_VERSION = "1.0.0";

// Why MXC cannot carry agent shells on this host. Stable codes, shown in Settings.
type MxcUnavailableReason = SandboxMxcUnavailableReason;

export type MxcSupport =
  | { readonly state: "available"; readonly windowsBuild: string | null }
  | {
      readonly state: "unavailable";
      readonly reason: MxcUnavailableReason;
      readonly windowsBuild: string | null;
      // Main-process diagnostic; may hold local paths, never sent to the renderer.
      readonly detail: string;
    };

// The architectures MXC ships `wxc-exec.exe` for.
const MXC_ARCHES = new Set(["x64", "arm64"]);

// The pinned sha256 of the launcher for `arch` (`mxc-launcher-pins.json`, the same file scripts/fetch-mxc.mjs stages against), or undefined for an arch MXC does not ship.
export function pinnedWxcExecSha256(arch: string): string | undefined {
  const pins: Readonly<Record<string, string>> = MXC_PINS.wxcExecSha256;
  return MXC_ARCHES.has(arch) ? pins[arch] : undefined;
}

// `<resources>/mxc/<arch>/wxc-exec.exe`, or undefined for an arch MXC does not ship.
export function wxcExecPathFor(resourcePath: string, arch: string): string | undefined {
  if (!MXC_ARCHES.has(arch)) return undefined;
  return winPath.join(resourcePath, "mxc", arch, "wxc-exec.exe");
}

// The fields of `wxc-exec --probe` Ave reads.
export interface MxcProbeReport {
  readonly tier: string | undefined;
  readonly needsDaclAugmentation: boolean | undefined;
}

// Parse `wxc-exec --probe` stdout (one JSON object), or undefined when it is not one.
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

// Judge `wxc-exec --dry-run`: the request must validate AND select the BaseContainer tier. Anything else (a parse error such as an identity-less proxy the host's PSEC contract cannot carry, an AppContainer tier) is a rejection; its first diagnostic line is kept for the log.
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
  // The app's resource root (`getHostResources.resourcePath`).
  readonly resourcePath: string;
  // `os.release` (`major.minor.build`), for the Settings reason only; never the gate.
  readonly windowsBuild: string | null;
  readonly exists: (path: string) => boolean;
  // Hex sha256 of a file's contents.
  readonly sha256: (path: string) => Promise<string>;
  // Run the launcher with its own directory as the working directory.
  readonly run: (file: string, args: readonly string[], timeoutMs: number) => Promise<MxcRunResult>;
  // An empty directory the probe containers may write (their cwd and LOCALAPPDATA).
  readonly probeDirectory: string;
  // `%SystemRoot%` of the host, for the PowerShell start probe.
  readonly systemRoot: string;
}

const MXC_PROBE_TIMEOUT_MS = 20_000;
// A cold Windows PowerShell start inside a fresh container.
const MXC_START_PROBE_TIMEOUT_MS = 60_000;

// Judge the PowerShell 5.1 start probe: exit 0 is a start. A UI-subsystem initialization failure (`STATUS_DLL_INIT_FAILED`, 0xC0000142) is what a non-interactive session produces (measured over SSH), so it is reported as unverified rather than as a host that cannot run PowerShell.
export function classifyMxcStartProbe(
  code: number | null,
  stdout: string,
  stderr: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: "powershell-start-failed" | "unverified-session"; readonly detail: string } {
  if (code === 0) return { ok: true };
  const text = `${stdout}\n${stderr}`;
  const detail = (text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? `exit ${String(code)}`).slice(0, 500);
  // 0xC0000142 as the unsigned exit code, or the launcher's own diagnostic.
  if (code === 0xc0000142 || /STATUS_DLL_INIT_FAILED|0xC0000142/i.test(text)) {
    return { ok: false, reason: "unverified-session", detail };
  }
  return { ok: false, reason: "powershell-start-failed", detail };
}

// Decide, once at boot, whether agent shells can run in MXC on this host. The OS build number is not the gate: MXC 1.0.0 needs the PSEC 1.1 ingress contract for an identity-less loopback proxy while 1.0.1 relaxes that, so a build floor would be wrong now and drift on the next bump. The gate is what the shipped binary reports: its sha256 must match the pin, `--probe` must select `base-container`, `--dry-run` of the exact request shape Ave launches (proxy mode, DACL fallback refused) must validate on that tier, and System32 Windows PowerShell 5.1 must actually start (`exit 0`) in a real container of that shape. Any failure leaves the shells on the approved-host route.
export async function detectMxcSupport(deps: DetectMxcSupportDeps): Promise<MxcSupport> {
  const prerequisites = await detectMxcPrerequisites(deps);
  if (prerequisites.state === "unavailable") return prerequisites;
  return await probeMxcPowerShellStart(deps);
}

// The fast half of detectMxcSupport, run on the boot path: platform, arch, launcher present and pinned, `--probe` tier, `--dry-run` of the shipped request shape. "available" here means only that the start probe is worth running; MXC is not claimed until probeMxcPowerShellStart passes.
export async function detectMxcPrerequisites(deps: DetectMxcSupportDeps): Promise<MxcSupport> {
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
  let digest: string;
  try {
    digest = await deps.sha256(wxcExec);
  } catch (error) {
    return unavailable("probe-failed", errorMessage(error));
  }
  if (digest !== pinnedWxcExecSha256(deps.arch)) return unavailable("launcher-mismatch", `${wxcExec} sha256 ${digest}`);

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

// The slow half of detectMxcSupport (a cold container start; up to a minute): run after detectMxcPrerequisites passed, off the boot path.
export async function probeMxcPowerShellStart(deps: DetectMxcSupportDeps): Promise<MxcSupport> {
  const unavailable = (reason: MxcUnavailableReason, detail: string): MxcSupport => ({
    state: "unavailable",
    reason,
    windowsBuild: deps.windowsBuild,
    detail,
  });
  const wxcExec = wxcExecPathFor(deps.resourcePath, deps.arch);
  if (wxcExec === undefined) return unavailable("unsupported-arch", `arch ${deps.arch}`);
  // A dry run proves the request is accepted, not that the shell starts. Start the real thing once: System32 Windows PowerShell 5.1 in a container of the shape every command gets (caller-owned reduced environment, proxy mode).
  const startRequest = buildMxcShellRequest({
    commandLine: powerShellMxcCommandLine(deps.systemRoot, "exit 0"),
    cwd: deps.probeDirectory,
    grants: { readwrite: [deps.probeDirectory], readonly: [], denied: [] },
    env: {
      SYSTEMROOT: deps.systemRoot,
      LOCALAPPDATA: deps.probeDirectory,
      TEMP: deps.probeDirectory,
      TMP: deps.probeDirectory,
      PATH: `${win32SystemBinary("", { SystemRoot: deps.systemRoot })};${deps.systemRoot}`,
    },
    // Nothing listens there: the probe makes no network call.
    proxyUrl: "http://127.0.0.1:9",
    timeoutMs: MXC_START_PROBE_TIMEOUT_MS,
  });
  let started: MxcRunResult;
  try {
    started = await deps.run(wxcExec, mxcRequestArgs(startRequest), MXC_START_PROBE_TIMEOUT_MS + 5_000);
  } catch (error) {
    return unavailable("powershell-start-failed", errorMessage(error));
  }
  const start = classifyMxcStartProbe(started.code, started.stdout, started.stderr);
  if (!start.ok) return unavailable(start.reason, start.detail);
  return { state: "available", windowsBuild: deps.windowsBuild };
}

// The filesystem lists of one MXC launch, already ranked.
export interface MxcFilesystemGrants {
  readonly readwrite: readonly string[];
  readonly readonly: readonly string[];
  readonly denied: readonly string[];
}

// The per-command policy Ave's shells already compute for an ASRT wrap.
export interface ShellFilesystemPolicy {
  readonly allowWrite: readonly string[];
  readonly allowRead: readonly string[];
  // Broad and floor read denies (HOME, sandbox private roots, credential paths…).
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  // The protected floor (credential paths, the user data directory, trusted custom denies). A grant at or beneath one is dropped, as Windows ASRT drops a grant beneath a credentials entry.
  readonly protectedFloor: readonly string[];
  // Grants the shell holds INSIDE the protected floor on purpose (the saved session history, `getBuiltinShellReadPolicy.floorPierces`). A grant at or beneath one is not dropped by the floor.
  readonly floorPierces?: readonly string[];
}

function foldPath(path: string): string {
  const normalized = winPath.normalize(path).replace(/[\\/]+$/, "");
  return (normalized.endsWith(":") ? `${normalized}\\` : normalized).toLowerCase();
}

// True when `child` is `parent` or lies beneath it (Windows, case-insensitive).
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

// Drop grants piercing protected floors except explicit history read exceptions; write denies downgrade grants to read-only. Missing write-deny targets must stay denied because read-only does not prevent creation. Preserve nested read denies, omit redundant denied ancestors, and drop nonexistent grants.
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

// The MXC 1.0.0 one-shot request Ave launches. Only the fields Ave sets.
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
  // The child's whole environment. Proxy variables are dropped: MXC sets them.
  readonly env: Readonly<Record<string, string>>;
  // `http://127.0.0.1:<port>` of this invocation's own listener.
  readonly proxyUrl: string;
  // MXC's own timeout, a backstop behind the host's lifetime watch.
  readonly timeoutMs: number;
}

// Variables MXC derives from `runtimeConfig.networkProxy`; a caller value would contradict it.
const PROXY_ENV_KEYS = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy"]);
// MXC refuses a caller-owned environment block without these (schema.md, "Environment").
const REQUIRED_ENV_KEYS = ["SYSTEMROOT", "LOCALAPPDATA"] as const;

// Never inherit host env or permit ACL-mutating fallback; pin proxy-only egress to one listener. GUI support is needed by shell runtimes but permits spoofed windows, which are never trusted; clipboard/input injection stay closed. Proxy mode forces ingress capability, so host firewall controls inbound reachability; DNS uses the host resolver.
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

// The `wxc-exec.exe` arguments carrying a request (no temp file, nothing secret in it).
export function mxcRequestArgs(request: MxcContainerRequest): string[] {
  return ["--config-base64", Buffer.from(JSON.stringify(request), "utf8").toString("base64")];
}

// The container command line for one PowerShell command. `-EncodedCommand` carries the command as UTF-16LE base64, so no quoting of the command's own text can change how the line splits.
export function powerShellMxcCommandLine(systemRoot: string, command: string): string {
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  return `"${win32SystemBinary("WindowsPowerShell/v1.0/powershell", { SystemRoot: systemRoot })}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

// Why the Bash tool does not run under MXC, for the tool result.
export const MXC_BASH_UNAVAILABLE_MESSAGE =
  "Bash cannot run in the Windows sandbox on this host: Ave confines shell commands with " +
  "Microsoft Execution Containers here, and Git Bash (MSYS2) cannot start inside a container " +
  "(it is denied the named-object directory it creates at startup). Use the PowerShell tool " +
  "for this command. To run it in Git Bash anyway, retry with executionMode \"host\" and a " +
  "justification; that runs it unsandboxed after your approval.";

async function sha256OfFile(path: string): Promise<string> {
  const [{ createHash }, { readFile }] = await Promise.all([import("node:crypto"), import("node:fs/promises")]);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// One verification per launcher path per process: boot, then every launch reuses it.
const verifiedLaunchers = new Map<string, Promise<string>>();

// `<resources>/mxc/<arch>/wxc-exec.exe` for this host, after its sha256 has matched the pin (once per process). Throws, so the command fails closed, when MXC does not ship for this arch or the file is not the pinned build. Assumption: the installer is per-machine (`nsis.perMachine`), so the file lives in a directory only administrators can write and cannot be swapped between this check and a later launch by the signed-in user. A source checkout's `resources/` is user-writable; that is a developer setup.
export async function resolveHostWxcExecPath(): Promise<string> {
  const { getHostResources } = await import("../main/host-resources.js");
  const path = wxcExecPathFor(getHostResources().resourcePath, process.arch);
  if (path === undefined) throw new Error(`Microsoft Execution Containers do not ship for ${process.arch}`);
  let verified = verifiedLaunchers.get(path);
  if (verified === undefined) {
    const pinned = pinnedWxcExecSha256(process.arch);
    verified = sha256OfFile(path).then((digest) => {
      if (digest !== pinned) throw new Error(`Microsoft Execution Containers launcher ${path} is not the pinned build`);
      return path;
    });
    verifiedLaunchers.set(path, verified);
  }
  return await verified;
}

type HostProbe = (deps: DetectMxcSupportDeps) => Promise<MxcSupport>;

// Run one detection step against this host's shipped binary, in a fresh probe directory.
async function withHostMxcDeps(step: HostProbe): Promise<MxcSupport> {
  const [{ execFile }, { existsSync }, { mkdtemp, rm }, os, path, { getHostResources }] = await Promise.all([
    import("node:child_process"),
    import("node:fs"),
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
    import("../main/host-resources.js"),
  ]);
  // The probe containers write only into a fresh directory of their own.
  const probeDirectory = process.platform === "win32" ? await mkdtemp(path.join(os.tmpdir(), "ave-mxc-probe-")) : os.tmpdir();
  try {
    return await step({
      platform: process.platform,
      arch: process.arch,
      resourcePath: getHostResources().resourcePath,
      windowsBuild: process.platform === "win32" ? os.release() : null,
      exists: existsSync,
      sha256: sha256OfFile,
      probeDirectory,
      systemRoot: process.platform === "win32" ? windowsSystemRoot() : "",
      run: (file, args, timeoutMs) =>
        new Promise((resolve, reject) => {
          execFile(file, [...args], { cwd: path.dirname(file), timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
            if (error !== null && code === null) {
              reject(error);
              return;
            }
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          });
        }),
    });
  } finally {
    if (probeDirectory !== os.tmpdir()) await rm(probeDirectory, { recursive: true, force: true });
  }
}

// detectMxcPrerequisites against this host's shipped binary (boot path).
export async function detectHostMxcPrerequisites(): Promise<MxcSupport> {
  return await withHostMxcDeps(detectMxcPrerequisites);
}

// probeMxcPowerShellStart against this host's shipped binary (after boot).
export async function probeHostMxcPowerShellStart(): Promise<MxcSupport> {
  return await withHostMxcDeps(probeMxcPowerShellStart);
}
