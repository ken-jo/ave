import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { posix } from "node:path";
import { promisify } from "node:util";
import { expandReadDenyGlobLinuxSteps } from "@anthropic-ai/sandbox-runtime/dist/sandbox/read-deny-glob.js";
import { finishInTurns, type GlobWalkListings } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { createLogger } from "../lib/logger.js";
import type { HostResources } from "../main/host-resources.js";
import { containerTarget } from "../shared/container-platform.js";
import { errorMessage } from "../shared/error-message.js";
import { isRecord } from "../shared/is-record.js";
import type { ContainerRawIpVerdict, SandboxContainerShellSupport, SandboxContainerShellUnavailableReason } from "../shared/sandbox-capability-info.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { INVOCATION_PROXY_REFUSED_STATUS, openInvocationProxyListener } from "./egress-invocation-listener.js";
import { launcherPathFor, pinnedLauncherSha256 } from "./mxc-launcher.js";
import { holdMxcLinuxPlaceholders } from "./mxc-linux-placeholders.js";
import {
  LINUX_RAW_IP_PROBER, linuxRawIpProberArguments, linuxRawIpVerdict, openLinuxRawIpHostTargets, parseLinuxRawIpProbeOutput, primaryIpv4,
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
  | { readonly state: "available"; readonly rawIp: ContainerRawIpVerdict }
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
  return verdict.state === "available" ? { state: "available", rawIp: verdict.rawIp } : unavailable(verdict.state);
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
  const env = Object.entries(input.env).flatMap(([key, value]) =>
    key && !key.includes("=") && !PROXY_VARIABLES.test(key) ? [`${key}=${value}`] : []);
  const home = input.env.HOME;
  // Git expects its global config to be a file. A masked, absent config has no settings to read.
  if (home !== undefined && input.env.GIT_CONFIG_GLOBAL === undefined
    && grants.placeholders?.some(row => row.path === posix.join(home, ".gitconfig"))) env.push("GIT_CONFIG_GLOBAL=/dev/null");
  const bootstrap = `export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1\n${input.commandLine}`;
  return {
    version: "0.9.0-alpha",
    containment: "bubblewrap",
    process: { commandLine: `${quote(helper)} /bin/sh -c ${quote(bootstrap)}`, cwd, timeout: input.timeoutMs, inheritDefaultEnv: false, env },
    filesystem: { readwritePaths: grants.readwrite, readonlyPaths, deniedPaths: grants.denied },
    network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
    runtimeConfig: { networkProxy: input.proxyUrl },
  } as const;
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

/** Native tests only: replace the prober text to drive the raw-IP failure and control cases. */
interface LinuxCanaryTestOverrides {
  readonly prober?: string;
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
    targets = await openLinuxRawIpHostTargets(primaryIpv4(), nonce);
    const udp = targets?.udp;
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
      const proberArguments = linuxRawIpProberArguments({ nonce, host: targets?.address, closedPort: targets?.closedPort, udpPort: udp?.port })
        .map(quote).join(" ");
      const commandLine = [
        "(", ...availability, ")",
        "status=$?",
        `if [ "$status" -eq 0 ]; then /usr/bin/timeout -s KILL ${TOOL_TIMEOUT_POLICY.mxcLinuxRawIpProbeMs / 1000} `
          + `/bin/bash raw-ip.sh ${proberArguments} > raw-ip.out 2> /dev/null < /dev/null; fi`,
        'exit "$status"',
      ].join("\n");
      const timeout = TOOL_TIMEOUT_POLICY.mxcLinuxShellProbeMs + TOOL_TIMEOUT_POLICY.mxcLinuxRawIpProbeMs;
      const request = buildBubblewrapShellRequest({
        grants: held.grants, lookups, cwd: working, commandLine, timeoutMs: timeout,
        env: { HOME: working, TMPDIR: working, PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
        proxyUrl: proxy.url, helper: programs.helper,
      });
      const config = posix.join(scratch, "request.json");
      await writeFile(config, JSON.stringify(request), { mode: 0o600, flag: "wx" });
      const options = { signal, env: programs.env, timeout: timeout + TOOL_TIMEOUT_POLICY.mxcLinuxShellStopMs, killSignal: "SIGKILL" as const };
      try { await runFile(programs.launcher, ["--dry-run", "--config", config], options); } catch {
        signal?.throwIfAborted();
        return { state: "request-rejected" };
      }
      held.validate();
      const execution = runFile(programs.launcher, ["--config", config], options);
      const pid = execution.child.pid;
      const [{ stdout }] = await Promise.all([execution, pid === undefined ? undefined : held.recordLauncher(pid)]);
      const control = await readFile(posix.join(working, "control"), "utf8");
      if (hostConnected || stdout !== "boundary-control\n" || control !== stdout) return { state: "shell-start-failed" };
      // A prober that left no readable output is no evidence; it never makes the container unavailable.
      const output = await readFile(posix.join(working, "raw-ip.out"), "utf8").then(parseLinuxRawIpProbeOutput, (error: unknown) => {
        log.warn("Linux raw-IP prober output unreadable: %s", (error as NodeJS.ErrnoException).code);
        return undefined;
      });
      const udpArrived = udp !== undefined && output?.targets.UA === "0" ? await udp.settle() : udp?.arrived === true;
      const rawIp = linuxRawIpVerdict({
        ran: true, ...(output === undefined ? {} : { output }), expectedStatus: INVOCATION_PROXY_REFUSED_STATUS,
        nonceRecorded, tlRan: targets !== undefined, udpArrived,
      });
      return { state: "available", rawIp };
    } finally {
      await held.release();
    }
  } catch (error) {
    signal?.throwIfAborted();
    log.warn("Linux container canary failed (%s): %s", isRecord(error) ? error.code : undefined, errorMessage(error));
    return { state: "shell-start-failed" };
  } finally {
    await proxy?.close();
    await targets?.udp.close();
    host.close();
    unix.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

export { detectMxcLinuxShellSupport as _detectMxcLinuxShellSupportForTest, runLinuxCanary as _runLinuxCanaryForTest, trustedLinuxPath as _trustedLinuxPathForTest };
