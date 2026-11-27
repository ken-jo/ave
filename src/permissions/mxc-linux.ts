import { type ChildProcess, execFile, spawn, type StdioOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { posix } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { expandReadDenyGlobLinuxSteps } from "@anthropic-ai/sandbox-runtime/dist/sandbox/read-deny-glob.js";
import { finishInTurns, type GlobWalkListings } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { createLogger } from "../lib/logger.js";
import type { HostResources } from "../main/host-resources.js";
import { containerTarget } from "../shared/container-platform.js";
import { errorMessage } from "../shared/error-message.js";
import { isRecord } from "../shared/is-record.js";
import type { LinuxRawIpVerdict, SandboxContainerShellSupport, SandboxContainerShellUnavailableReason } from "../shared/sandbox-capability-info.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { INVOCATION_PROXY_REFUSED_STATUS, openInvocationProxyListener } from "./egress-invocation-listener.js";
import { assertShellExportableName } from "./launcher-environment.js";
import { launcherPathFor, pinnedLauncherSha256 } from "./mxc-launcher.js";
import { holdMxcLinuxPlaceholders } from "./mxc-linux-placeholders.js";
import {
  LINUX_RAW_IP_PROBER, linuxRawIpHostInBackendNetwork, linuxRawIpProberArguments, linuxRawIpUdpArrival, linuxRawIpUdpSend, linuxRawIpVerdict, openLinuxRawIpHostTargets, parseLinuxRawIpProbeOutput, primaryIpv4,
  readLinuxLauncherFirewall,
} from "./mxc-linux-raw-ip.js";
import filterPins from "./mxc-linux-seccomp-pins.json" with { type: "json" };
import { atOrUnder, canonicalPath, posixPolicyLookups, rankPosixContainerRows, type PosixFilesystemGrants, type PosixPolicyLookups } from "./mxc-posix.js";
import { requireMxcContainerStartRoot } from "./mxc-runtime-root.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow } from "./policy-model.js";
import { containsGlobChars, globPatternBaseDir } from "./sandbox-path-spelling.js";
import { quoteSandboxWrappedWord as quote } from "./sandbox-wrapped-command.js";
import { getConfiguredSessionReadPolicy } from "./sensitive-paths.js";

const runFile = promisify(execFile);
const log = createLogger("mxc-linux");
const SYSTEM_TOOL_DIRS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
const LINUX_TOOLS = ["bwrap", "slirp4netns", "unshare", "nsenter", "ip", "iptables", "ip6tables", "iptables-restore", "ip6tables-restore"];
const PROXY_VARIABLES = /^(?:https?|all|no|ftp)_proxy$/iu;

/**
 * The descriptor a Linux container shell reads its environment from. The pinned launcher hands a request's `env` to
 * bwrap as `--setenv NAME VALUE` arguments, and any local user can read `/proc/<pid>/cmdline`. So a request carries no
 * environment. The launcher passes its inherited descriptors through to the contained shell, which sources this one
 * before anything else runs. It reads a 0600 file in the request's staging folder, under the runtime root the
 * container cannot read by path.
 */
const LINUX_SHELL_ENVIRONMENT_FD = 9;
/**
 * The descriptor the shell's bootstrap inside the container writes one byte to once the filter is on and the
 * environment loaded, just before the command runs. Its arrival separates a launcher that refused to start from one
 * that failed after the command began.
 */
export const LINUX_SHELL_READY_FD = 4;
/** The bootstrap's exit status when the environment did not load; without the ready byte it is never the command's. */
export const LINUX_SHELL_ENVIRONMENT_FAILED_CODE = 125;

/** Writes the environment script into the launcher's environment socket and shuts down Ave's sending side. */
export function writeLinuxShellEnvironment(child: ChildProcess, bytes: Buffer): void {
  const pipe: unknown = (child.stdio as readonly unknown[])[LINUX_SHELL_ENVIRONMENT_FD];
  if (!(pipe instanceof Writable)) throw new Error("Linux container launcher has no environment socket");
  // A launcher that exits early closes the reading end; its own outcome reports that.
  pipe.on("error", () => {});
  pipe.end(bytes);
}

/** Descriptors 3 to 8 of a launcher spawn: the ready pipe at {@link LINUX_SHELL_READY_FD}, nothing else. */
export function linuxShellExtraDescriptors(): ("pipe" | "ignore")[] {
  return Array.from({ length: LINUX_SHELL_ENVIRONMENT_FD - 3 }, (_, index) => index + 3 === LINUX_SHELL_READY_FD ? "pipe" : "ignore");
}

/** The environment as a POSIX `sh` script of single-quoted exports. A name `sh` cannot export refuses the launch. */
function linuxShellEnvironmentScript(env: Readonly<Record<string, string>>): string {
  const lines = Object.entries(env).map(([key, value]) => {
    assertShellExportableName(key);
    return `export ${key}=${quote(value)}`;
  });
  return `${lines.join("\n")}\n`;
}

/** The saved-session grant and its generated exclusions use the same launch-time walk as the Linux wrap. */
export async function projectLinuxSavedSessionDenies(input: {
  readonly denyRead: readonly string[];
  readonly userDenyRead: readonly string[];
  readonly grants: readonly string[];
  readonly lookups: PosixPolicyLookups;
  readonly signal: AbortSignal;
}) {
  const { denyRead, userDenyRead, lookups, signal } = input;
  const session = getConfiguredSessionReadPolicy();
  const root = session.allowRead[0];
  const generated = new Set(session.denyRead);
  const configured = new Set(userDenyRead);
  const projected = new Map<string, { pattern: string; user: boolean }>();
  for (const entry of new Set([...denyRead, ...userDenyRead])) {
    if (root === undefined || !containsGlobChars(entry)) continue;
    const user = configured.has(entry);
    const pattern = entry.startsWith("~/") ? lookups.home + entry.slice(1) : entry;
    const base = globPatternBaseDir(pattern);
    if ((user && posix.isAbsolute(base) && atOrUnder(canonicalPath(base, true, lookups), root, false))
      || (generated.has(entry) && !user)) projected.set(entry, { pattern, user });
  }
  const grants = input.grants.map(path => canonicalPath(path, false, lookups));
  const listings: GlobWalkListings = new Map();
  const unlistable = new Set<string>();
  const rows = await finishInTurns((function* () {
    const rows: ReturnType<typeof policyFloorRow>[] = [];
    for (const { pattern, user } of projected.values()) {
      const matches = yield* expandReadDenyGlobLinuxSteps(pattern, grants, unlistable, {
        listings, ...(root !== undefined && pattern.startsWith(`${root}/`) ? { anchor: root } : {}),
      });
      rows.push(...matches.map(path => policyFloorRow(path, "denied", user ? "user-deny" : "read-boundary", true)));
    }
    return rows;
  })(), signal);
  for (const path of unlistable) {
    if (grants.some(grant => atOrUnder(grant, path, false))) {
      throw new Error(`Cannot resolve Linux container read denies beneath: ${path}`);
    }
  }
  return { denyRead: denyRead.filter(path => !projected.has(path)), userDenyRead: userDenyRead.filter(path => !projected.has(path)), rows };
}

function trustedDirectory(path: string): boolean {
  for (let directory = path; ; directory = posix.dirname(directory)) {
    const stat = statSync(directory);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
    if (directory === "/") return true;
  }
}

function trustedLinuxPath(path: string | undefined, trusted = trustedDirectory): readonly string[] {
  const directories = new Set<string>();
  for (const candidate of [...SYSTEM_TOOL_DIRS, ...(path?.split(":") ?? [])]) {
    if (!posix.isAbsolute(candidate)) continue;
    try {
      const resolved = realpathSync.native(candidate);
      if (trusted(resolved)) directories.add(resolved);
    } catch { /* an unresolved folder cannot supply launcher tools */ }
  }
  return [...directories];
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function trustedTool(path: string): boolean {
  try {
    const resolved = realpathSync.native(path);
    const stat = statSync(resolved);
    return stat.uid === 0 && (stat.mode & 0o022) === 0 && executable(resolved) && trustedDirectory(posix.dirname(resolved));
  } catch {
    return false;
  }
}

type LinuxCanaryResult =
  | { readonly state: "available"; readonly rawIpProbe: LinuxRawIpVerdict }
  | { readonly state: "request-rejected" | "shell-start-failed" };

interface LinuxShellProbeDependencies {
  readonly supportedHelper: boolean;
  readonly launcherExists: boolean;
  verifyLauncher(): Promise<boolean>;
  requireRuntimeRoot(): string;
  missingTools(): readonly string[];
  listBackends(): Promise<unknown>;
  canary(root: string): Promise<LinuxCanaryResult>;
}

async function detectMxcLinuxShellSupport(deps: LinuxShellProbeDependencies): Promise<SandboxContainerShellSupport> {
  const unavailable = (reason: SandboxContainerShellUnavailableReason): SandboxContainerShellSupport => ({ state: "unavailable", reason });
  if (!deps.supportedHelper) return unavailable("unsupported-arch");
  if (!deps.launcherExists) return unavailable("binary-missing");
  if (!await deps.verifyLauncher()) return unavailable("launcher-mismatch");
  let root: string;
  try { root = deps.requireRuntimeRoot(); } catch { return unavailable("runtime-root-unproved"); }
  const detail = deps.missingTools();
  if (detail.length > 0) return { state: "unavailable", reason: "tools-missing", detail };
  const backends = await deps.listBackends();
  if (!Array.isArray(backends) || !backends.some((entry: unknown) => isRecord(entry) && entry.backend === "bubblewrap"
    && Array.isArray(entry.capabilities) && entry.capabilities.includes("proxyEnforcement"))) return unavailable("namespaces-unavailable");
  const verdict = await deps.canary(root);
  return verdict.state === "available" ? { state: "available", rawIpProbe: verdict.rawIpProbe } : unavailable(verdict.state);
}

export interface MxcLinuxShellPrograms {
  readonly launcher: string;
  readonly helper: string;
  readonly env: Readonly<Record<string, string>>;
}

export async function requireMxcLinuxShellPrograms(resources: HostResources) {
  const { target, launcher, helper, helperArch, env } = linuxShellPrograms(resources, process.arch);
  if (target === undefined || launcher === undefined || helper === undefined || helperArch === undefined) {
    throw new Error("Linux container shell programs are unavailable on this architecture");
  }
  const inputs = [[launcher, pinnedLauncherSha256(target)], [helper, filterPins[helperArch]]] as const;
  const identities = inputs.map(([path]) => executableIdentity(path));
  const verified = await Promise.all(inputs.map(([path, pin]) => verifyLinuxExecutable(path, pin)));
  if (verified.includes(false) || inputs.some(([path], index) => executableIdentity(path) !== identities[index])) {
    throw new Error("Linux container shell programs do not match their pins");
  }
  return {
    launcher, helper, env,
    validate() {
      if (inputs.some(([path], index) => executableIdentity(path) !== identities[index])) {
        throw new Error("Linux container shell programs changed before launch");
      }
    },
  };
}

const executableChecks = new Map<string, Promise<boolean>>();

function verifyLinuxExecutable(path: string, expected: string): Promise<boolean> {
  let identity: string;
  try { identity = executableIdentity(path); } catch { return Promise.resolve(false); }
  const key = `${path}\0${expected}\0${identity}`;
  let verified = executableChecks.get(key);
  if (verified === undefined) {
    verified = readFile(path).then((bytes) => createHash("sha256").update(bytes).digest("hex") === expected
      && executableIdentity(path) === identity).catch(() => false);
    executableChecks.set(key, verified);
  }
  return verified;
}

function executableIdentity(path: string): string {
  const { dev, ino, size, mtimeNs, ctimeNs } = statSync(path, { bigint: true });
  return `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
}

function linuxShellPrograms(resources: HostResources, arch: string) {
  const target = containerTarget("linux", arch);
  const launcher = launcherPathFor(resources.resourcePath, "linux", arch);
  const helperArch = arch === "arm64" || arch === "x64" ? arch : undefined;
  const helper = helperArch === undefined ? undefined : posix.join(resources.resourcePath, "linux-shell-seccomp", helperArch, "apply-seccomp");
  const directories = trustedLinuxPath(process.env.PATH);
  return {
    target, launcher, helper, helperArch, directories,
    env: { PATH: directories.join(":"), LC_ALL: "C" },
  } as const;
}

export async function detectHostMxcLinuxShellSupport(resources: HostResources, signal?: AbortSignal): Promise<SandboxContainerShellSupport> {
  signal?.throwIfAborted();
  const { target, launcher, helper, helperArch, directories, env } = linuxShellPrograms(resources, process.arch);
  const probeOptions = { env, signal, timeout: TOOL_TIMEOUT_POLICY.mxcLinuxShellProbeMs, killSignal: "SIGKILL" as const };
  return detectMxcLinuxShellSupport({
    supportedHelper: helper !== undefined && executable(helper),
    launcherExists: launcher !== undefined && executable(launcher),
    async verifyLauncher() {
      if (launcher === undefined || target === undefined || helper === undefined || helperArch === undefined) return false;
      const [launcherVerified, helperVerified] = await Promise.all([
        verifyLinuxExecutable(launcher, pinnedLauncherSha256(target)),
        verifyLinuxExecutable(helper, filterPins[helperArch]),
      ]);
      return launcherVerified && helperVerified;
    },
    requireRuntimeRoot: requireMxcContainerStartRoot,
    missingTools: () => LINUX_TOOLS.filter(tool => {
      const candidate = directories.map(directory => posix.join(directory, tool)).find(executable);
      return candidate === undefined || !trustedTool(candidate);
    }),
    async listBackends() {
      if (launcher === undefined) return undefined;
      try {
        return JSON.parse((await runFile(launcher, ["--available-backends"], probeOptions)).stdout) as unknown;
      } catch {
        signal?.throwIfAborted();
        return undefined;
      }
    },
    async canary(root) {
      if (launcher === undefined || helper === undefined) return { state: "shell-start-failed" };
      try { return await runLinuxCanary(root, { launcher, helper, env }, signal); } catch {
        signal?.throwIfAborted();
        return { state: "shell-start-failed" };
      }
    },
  });
}

export function buildBubblewrapShellRequest(input: {
  readonly grants: PosixFilesystemGrants;
  readonly lookups: PosixPolicyLookups;
  readonly commandLine: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly proxyUrl: string;
  readonly helper: string;
}) {
  const { grants, lookups } = input;
  const port = Number(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(input.proxyUrl)?.[1]);
  if (!Number.isInteger(port) || port > 65535) throw new Error("Container proxy must be an IPv4 loopback listener");
  const cwd = canonicalPath(input.cwd, true, lookups);
  const covering = (paths: readonly string[]) => Math.max(-1, ...paths.filter(path => atOrUnder(cwd, path, false)).map(path => path.length));
  const access = covering([...grants.readwrite, ...grants.readonly]);
  if (!lookups.exists(cwd) || access <= covering(grants.denied)) {
    throw new Error(`Container shell working directory is outside its filesystem grants: ${cwd}`);
  }
  const helper = canonicalPath(input.helper, true, lookups);
  const helperFolder = posix.dirname(helper);
  if (grants.denied.some((path) => atOrUnder(helper, path, false) || atOrUnder(path, helperFolder, false))) {
    throw new Error("Container filter helper is covered by a filesystem deny");
  }
  const readonlyPaths = grants.readonly.includes(helperFolder) ? grants.readonly : [...grants.readonly, helperFolder];
  if (grants.readwrite.length + readonlyPaths.length + grants.denied.length > 400) {
    throw new Error("Container grant limit exceeded by the filter helper");
  }
  const env: Record<string, string> = Object.fromEntries(Object.entries(input.env).filter(([key]) => !PROXY_VARIABLES.test(key)));
  const home = input.env.HOME;
  // Git expects its global config to be a file. A masked, absent config has no settings to read.
  if (home !== undefined && input.env.GIT_CONFIG_GLOBAL === undefined
    && grants.placeholders?.some(row => row.path === posix.join(home, ".gitconfig"))) env.GIT_CONFIG_GLOBAL = "/dev/null";
  // The environment arrives on its descriptor, a socket Ave writes and closes, which the shell reads whole and closes
  // before the command. It is read into the positional parameters, never a named variable the environment could
  // hold; the trailing `.` proves the read finished and keeps trailing newlines. `command eval` keeps a failed export
  // from ending the shell before it reports the failure, in every POSIX sh. The ready byte follows the load.
  const fd = LINUX_SHELL_ENVIRONMENT_FD;
  const ready = LINUX_SHELL_READY_FD;
  const failed = LINUX_SHELL_ENVIRONMENT_FAILED_CODE;
  const bootstrap = `set -- "$(/bin/cat <&${fd} && printf .)" && exec ${fd}<&- || exit ${failed}\n`
    + `case $1 in *.) ;; *) exit ${failed} ;; esac\n`
    + `command eval "\${1%.}" || exit ${failed}\n`
    + "set --\n"
    + `printf '\\n' >&${ready} && exec ${ready}>&- || exit ${failed}\n`
    + `export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1\n${input.commandLine}`;
  return {
    request: {
      version: "0.9.0-alpha",
      containment: "bubblewrap",
      // The helper closes every other inherited descriptor (the launcher's proxy mode leaves one to its user namespace).
      process: { commandLine: `${quote(helper)} --close-other-fds --keep-fd ${fd} --keep-fd ${ready} -- /bin/sh -c ${quote(bootstrap)}`, cwd, timeout: input.timeoutMs, inheritDefaultEnv: false, env: [] },
      filesystem: { readwritePaths: grants.readwrite, readonlyPaths, deniedPaths: grants.denied },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      runtimeConfig: { networkProxy: input.proxyUrl },
    },
    environment: linuxShellEnvironmentScript(env),
  } as const;
}

const LINUX_CANARY_STDOUT_LIMIT = 64 * 1024;

/**
 * Runs the launcher like `execFile`, resolving to its stdout and rejecting on a non-zero exit, with the contained shell's
 * environment written into a pipe on {@link LINUX_SHELL_ENVIRONMENT_FD}.
 */
function runLauncherWithEnvironment(
  launcher: string, args: readonly string[], environment: Buffer,
  options: { readonly signal?: AbortSignal; readonly env: NodeJS.ProcessEnv; readonly timeout: number; readonly killSignal: NodeJS.Signals },
) {
  let child: ChildProcess;
  {
    const stdio: StdioOptions = ["ignore", "pipe", "pipe", ...linuxShellExtraDescriptors(), "pipe"];
    // The canary reads the firewall payloads the launcher writes, and takes them as evidence only when nobody else
    // could write them. The launcher creates them under the inherited umask, which is often 002, so the canary's
    // launcher runs under 077. `exec` keeps the pid the firewall reader looks under.
    child = spawn("/bin/sh", ["-c", 'umask 077 && exec "$0" "$@"', launcher, ...args],
      { env: options.env, stdio, ...(options.signal ? { signal: options.signal } : {}), killSignal: options.killSignal, timeout: options.timeout });
  }
  writeLinuxShellEnvironment(child, environment);
  // The canary's command prints one short line; output past the bound is drained, never kept, and stops the launcher.
  const stdout: Buffer[] = [];
  let kept = 0;
  let overflowed = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (overflowed) return;
    kept += chunk.length;
    if (kept > LINUX_CANARY_STDOUT_LIMIT) {
      overflowed = true;
      stdout.length = 0;
      child.kill("SIGKILL");
      return;
    }
    stdout.push(chunk);
  });
  child.stderr?.resume();
  (child.stdio[LINUX_SHELL_READY_FD] as NodeJS.ReadableStream | null)?.resume();
  const completion = new Promise<{ stdout: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (overflowed) reject(Object.assign(new Error(`Linux container launcher wrote more than ${LINUX_CANARY_STDOUT_LIMIT} bytes`), { code: "stdout-limit" }));
      else if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
      else reject(Object.assign(new Error(`Linux container launcher exited with ${code ?? signal}`), { code, signal }));
    });
  });
  return Object.assign(completion, { child });
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Invalid container probe listener");
  return address.port;
}

/** Native tests only: drive the raw-IP failure and control cases. */
interface LinuxCanaryTestOverrides {
  /** Replaces the prober text. */
  readonly prober?: string;
  /** Replaces the host's primary IPv4 the host-side targets bind. */
  readonly hostAddress?: string;
  /**
   * Runs while the container runs, with the TCP arrival listener's address, the launcher's pid and the container's
   * working folder, to force an arrival or to open the container's firewall.
   */
  readonly duringRun?: (arrival: {
    readonly address: string; readonly port: number; readonly launcherPid: number | undefined; readonly working: string;
  }) => Promise<void>;
}

async function runLinuxCanary(
  root: string, programs: MxcLinuxShellPrograms, signal?: AbortSignal, overrides: LinuxCanaryTestOverrides = {},
): Promise<LinuxCanaryResult> {
  const scratch = await mkdtemp(posix.join(root, "p-"));
  // The raw-IP control goes through a real invocation listener: it refuses `<nonce>.localhost` as a loopback
  // destination and reports that refusal here. It forwards nothing, since the canary holds no egress grant.
  const nonce = randomBytes(16).toString("hex");
  let nonceRecorded = false;
  let proxy: Awaited<ReturnType<typeof openInvocationProxyListener>> | undefined;
  let targets: Awaited<ReturnType<typeof openLinuxRawIpHostTargets>>;
  let hostConnected = false;
  const host = createServer(socket => { hostConnected = true; socket.destroy(); });
  const unix = createServer(socket => { hostConnected = true; socket.destroy(); });
  try {
    const working = posix.join(scratch, "w");
    const sealed = posix.join(scratch, "s");
    const protectedLeaf = posix.join(working, "control-parent", "locked");
    await mkdir(working);
    await mkdir(sealed);
    await writeFile(posix.join(sealed, "secret"), "container-canary-secret");
    await writeFile(posix.join(working, "raw-ip.sh"), overrides.prober ?? LINUX_RAW_IP_PROBER, { flag: "wx", mode: 0o600 });
    const model = buildPolicyModel({
      floors: [policyFloorRow(sealed, "denied", "read-boundary", true), policyFloorRow(protectedLeaf, "ro", "protected-name", true)],
      launchGrants: [policyGrantRow(scratch, "ro", "launch-grant", true), policyGrantRow(working, "rw", "launch-grant", true)],
      userGrants: [], extensionManifests: [],
    });
    proxy = await openInvocationProxyListener({
      upstream: () => undefined,
      onRefused: (destination) => { if (destination === `${nonce}.localhost`) nonceRecorded = true; },
    });
    const proxyPort = proxy.port;
    const otherPort = await listenLoopback(host);
    await new Promise<void>((resolve, reject) => {
      unix.once("error", reject);
      unix.listen(posix.join(working, "u"), resolve);
    });
    const hostAddress = overrides.hostAddress ?? primaryIpv4();
    targets = await openLinuxRawIpHostTargets(hostAddress, nonce);
    const udp = targets?.udp;
    // Measured, not assumed: the arrival listener must take an unconfined connect before the container runs.
    const arrivalControl = targets === undefined ? false : await targets.tcp.control();
    const lookups = posixPolicyLookups(working, false);
    const held = await holdMxcLinuxPlaceholders(lookups, (current) => rankPosixContainerRows(model, "bubblewrap", current));
    try {
      const connectTimeout = TOOL_TIMEOUT_POLICY.mxcLinuxShellProbeConnectionMs / 1000;
      const connect = (port: number) => `/usr/bin/timeout ${connectTimeout} /bin/bash -c 'exec 3<>/dev/tcp/10.0.2.2/${port}'`;
      const availability = [
        "printf 'boundary-control\\n' > control && /bin/cat control || exit 11",
        `if /bin/cat ${quote(posix.join(sealed, "secret"))}; then exit 12; fi`,
        `if (printf x > ${quote(posix.join(sealed, "new"))}); then exit 13; fi`,
        "if /bin/mv -T control-parent renamed; then exit 14; fi",
        "printf sibling > control-parent/sibling || exit 15",
        `${connect(proxyPort)} || exit 16`,
        `if ${connect(otherPort)}; then exit 17; fi`,
        `${quote(programs.helper)} --check-unix-socket u || exit 18`,
        "if unshare -Ur /bin/true; then exit 19; fi",
      ];
      // Availability is decided by the checks above alone: their status is taken first, and the raw-IP prober writes
      // only to its own file, so nothing it does or prints can change it. It runs only after availability passed, and
      // the watcher bounds it, so a stalled prober leaves only missing lines.
      const proberArguments = linuxRawIpProberArguments({
        nonce, host: targets?.address, closedPort: targets?.closedPort, udpPort: udp?.port, arrivalPort: targets?.tcp.port,
      }).map(quote).join(" ");
      const commandLine = [
        "(", ...availability, ")",
        "status=$?",
        `if [ "$status" -eq 0 ]; then /usr/bin/timeout -s KILL ${TOOL_TIMEOUT_POLICY.mxcLinuxRawIpProbeMs / 1000} `
          + `/bin/bash raw-ip.sh ${proberArguments} > raw-ip.out 2> /dev/null < /dev/null; fi`,
        'exit "$status"',
      ].join("\n");
      const timeout = TOOL_TIMEOUT_POLICY.mxcLinuxShellProbeMs + TOOL_TIMEOUT_POLICY.mxcLinuxRawIpProbeMs;
      const { request, environment } = buildBubblewrapShellRequest({
        grants: held.grants, lookups, cwd: working, commandLine, timeoutMs: timeout,
        env: { HOME: working, TMPDIR: working, PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
        proxyUrl: proxy.url, helper: programs.helper,
      });
      const config = posix.join(scratch, "request.json");
      await writeFile(config, JSON.stringify(request), { mode: 0o600, flag: "wx" });
      // Handed over on its descriptor as a pipe the run writes.
      const options = { signal, env: programs.env, timeout: timeout + TOOL_TIMEOUT_POLICY.mxcLinuxShellStopMs, killSignal: "SIGKILL" as const };
      try { await runFile(programs.launcher, ["--dry-run", "--config", config], options); } catch {
        signal?.throwIfAborted();
        return { state: "request-rejected" };
      }
      held.validate();
      const execution = runLauncherWithEnvironment(programs.launcher, ["--config", config], Buffer.from(environment), options);
      const pid = execution.child.pid;
      let ended = false;
      const settled = execution.then(() => { ended = true; }, () => { ended = true; });
      // The availability checks write `control` first, inside the running container, so the rules are in force by then.
      const firewall = pid === undefined ? Promise.resolve(false) : readLinuxLauncherFirewall(pid, proxyPort,
        () => stat(posix.join(working, "control")).then(() => true, () => false), () => ended);
      const forced = targets === undefined || overrides.duringRun === undefined ? undefined
        : overrides.duringRun({ address: targets.address, port: targets.tcp.port, launcherPid: pid, working });
      const [{ stdout }, firewallDrops] = await Promise.all([
        execution, firewall, pid === undefined ? undefined : held.recordLauncher(pid), forced, settled,
      ]);
      const control = await readFile(posix.join(working, "control"), "utf8");
      if (hostConnected || stdout !== "boundary-control\n" || control !== stdout) return { state: "shell-start-failed" };
      // A prober that left no readable output is no evidence; it never makes the container unavailable.
      const output = await readFile(posix.join(working, "raw-ip.out"), "utf8").then(parseLinuxRawIpProbeOutput, (error: unknown) => {
        log.warn("Linux raw-IP prober output unreadable: %s", (error as NodeJS.ErrnoException).code);
        return undefined;
      });
      const udpSend = linuxRawIpUdpSend(output?.targets.UA);
      const udpArrived = udp !== undefined && udpSend === "sent" ? await udp.settle() : udp?.arrived === true;
      const udpArrival = linuxRawIpUdpArrival(udpSend, udp !== undefined, udpArrived);
      const rawIpProbe = linuxRawIpVerdict({
        ran: true, backend: "slirp", hostInBackendNetwork: linuxRawIpHostInBackendNetwork(hostAddress), ...(output === undefined ? {} : { output }), expectedStatus: INVOCATION_PROXY_REFUSED_STATUS,
        nonceRecorded, tlRan: targets !== undefined, udpArrival, firewallDrops,
        ...(targets === undefined ? {} : { arrival: { controlPassed: arrivalControl, arrived: targets.tcp.arrived } }),
      });
      return { state: "available", rawIpProbe };
    } finally {
      await held.release();
    }
  } catch (error) {
    signal?.throwIfAborted();
    log.warn("Linux container canary failed (%s): %s", isRecord(error) ? error.code : undefined, errorMessage(error));
    return { state: "shell-start-failed" };
  } finally {
    await proxy?.close();
    await targets?.close();
    host.close();
    unix.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

export { detectMxcLinuxShellSupport as _detectMxcLinuxShellSupportForTest, runLinuxCanary as _runLinuxCanaryForTest, trustedLinuxPath as _trustedLinuxPathForTest };
