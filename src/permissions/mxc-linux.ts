import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { HostResources } from "../main/host-resources.js";
import { containerTarget } from "../shared/container-platform.js";
import { isRecord } from "../shared/is-record.js";
import type { SandboxContainerShellSupport, SandboxContainerShellUnavailableReason } from "../shared/sandbox-capability-info.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { launcherPathFor, pinnedLauncherSha256 } from "./mxc-launcher.js";
import { holdMxcLinuxPlaceholders } from "./mxc-linux-placeholders.js";
import { atOrUnder, canonicalPath, posixPolicyLookups, rankPosixContainerRows, type PosixFilesystemGrants, type PosixPolicyLookups } from "./mxc-posix.js";
import { requireMxcContainerStartRoot } from "./mxc-runtime-root.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow } from "./policy-model.js";
import { quoteSandboxWrappedWord as quote } from "./sandbox-wrapped-command.js";

const runFile = promisify(execFile);
const SYSTEM_TOOL_DIRS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
const LINUX_TOOLS = ["bwrap", "slirp4netns", "unshare", "nsenter", "ip", "iptables", "ip6tables", "iptables-restore", "ip6tables-restore"];
const PROXY_VARIABLES = /^(?:https?|all|no|ftp)_proxy$/iu;

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

interface LinuxShellProbeDependencies {
  readonly supportedHelper: boolean;
  readonly launcherExists: boolean;
  verifyLauncher(): Promise<boolean>;
  requireRuntimeRoot(): string;
  missingTools(): readonly string[];
  listBackends(): Promise<unknown>;
  canary(root: string): Promise<"available" | "request-rejected" | "shell-start-failed">;
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
  return verdict === "available" ? { state: "available" } : unavailable(verdict);
}

export interface MxcLinuxShellPrograms {
  readonly launcher: string;
  readonly helper: string;
  readonly env: Readonly<Record<string, string>>;
}

const launcherChecks = new Map<string, Promise<boolean>>();

function verifyLinuxLauncher(launcher: string, expected: string): Promise<boolean> {
  let verified = launcherChecks.get(launcher);
  if (verified === undefined) {
    verified = readFile(launcher).then((bytes) => createHash("sha256").update(bytes).digest("hex") === expected, () => false);
    launcherChecks.set(launcher, verified);
  }
  return verified;
}

function linuxShellPrograms(resources: HostResources, arch: string) {
  const target = containerTarget("linux", arch);
  const launcher = launcherPathFor(resources.resourcePath, "linux", arch);
  const helper = target === undefined ? undefined : posix.join(resources.resourcePath, "linux-shell-seccomp", arch, "apply-seccomp");
  const directories = trustedLinuxPath(process.env.PATH);
  return {
    target, launcher, helper, directories,
    env: { PATH: directories.join(":"), LC_ALL: "C" },
  };
}

export async function detectHostMxcLinuxShellSupport(resources: HostResources, signal?: AbortSignal): Promise<SandboxContainerShellSupport> {
  signal?.throwIfAborted();
  const { target, launcher, helper, directories, env } = linuxShellPrograms(resources, process.arch);
  const probeOptions = { env, signal, timeout: TOOL_TIMEOUT_POLICY.mxcLinuxShellProbeMs, killSignal: "SIGKILL" as const };
  return detectMxcLinuxShellSupport({
    supportedHelper: helper !== undefined && executable(helper),
    launcherExists: launcher !== undefined && executable(launcher),
    verifyLauncher: () => launcher !== undefined && target !== undefined
      ? verifyLinuxLauncher(launcher, pinnedLauncherSha256(target)) : Promise.resolve(false),
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
      if (launcher === undefined || helper === undefined) return "shell-start-failed";
      try { return await runLinuxCanary(root, { launcher, helper, env }, signal); } catch {
        signal?.throwIfAborted();
        return "shell-start-failed";
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

async function runLinuxCanary(root: string, programs: MxcLinuxShellPrograms, signal?: AbortSignal) {
  const scratch = await mkdtemp(posix.join(root, "p-"));
  const proxy = createServer(socket => { socket.resume(); socket.end(); });
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
    const model = buildPolicyModel({
      floors: [policyFloorRow(sealed, "denied", "read-boundary", true), policyFloorRow(protectedLeaf, "ro", "protected-name", true)],
      launchGrants: [policyGrantRow(scratch, "ro", "launch-grant", true), policyGrantRow(working, "rw", "launch-grant", true)],
      userGrants: [], extensionManifests: [],
    });
    const proxyPort = await listenLoopback(proxy);
    const otherPort = await listenLoopback(host);
    await new Promise<void>((resolve, reject) => {
      unix.once("error", reject);
      unix.listen(posix.join(working, "u"), resolve);
    });
    const lookups = posixPolicyLookups(working, false);
    const held = await holdMxcLinuxPlaceholders(lookups, (current) => rankPosixContainerRows(model, "bubblewrap", current));
    try {
      const commandLine = [
        "printf 'boundary-control\\n' > control && /bin/cat control || exit 11",
        `if /bin/cat ${quote(posix.join(sealed, "secret"))}; then exit 12; fi`,
        `if (printf x > ${quote(posix.join(sealed, "new"))}); then exit 13; fi`,
        "if /bin/mv -T control-parent renamed; then exit 14; fi",
        "printf sibling > control-parent/sibling || exit 15",
        `/bin/bash -c 'exec 3<>/dev/tcp/10.0.2.2/${proxyPort}' || exit 16`,
        `if /bin/bash -c 'exec 3<>/dev/tcp/10.0.2.2/${otherPort}'; then exit 17; fi`,
        `${quote(programs.helper)} --check-unix-socket u || exit 18`,
        "if unshare -Ur /bin/true; then exit 19; fi",
      ].join("\n");
      const timeout = TOOL_TIMEOUT_POLICY.mxcLinuxShellProbeMs;
      const request = buildBubblewrapShellRequest({
        grants: held.grants, lookups, cwd: working, commandLine, timeoutMs: timeout,
        env: { HOME: working, TMPDIR: working, PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
        proxyUrl: `http://127.0.0.1:${proxyPort}`, helper: programs.helper,
      });
      const config = posix.join(scratch, "request.json");
      await writeFile(config, JSON.stringify(request), { mode: 0o600, flag: "wx" });
      const options = { signal, env: programs.env, timeout, killSignal: "SIGKILL" as const };
      try { await runFile(programs.launcher, ["--dry-run", "--config", config], options); } catch {
        signal?.throwIfAborted();
        return "request-rejected" as const;
      }
      held.validate();
      const execution = runFile(programs.launcher, ["--config", config], options);
      const pid = execution.child.pid;
      const [{ stdout }] = await Promise.all([execution, pid === undefined ? undefined : held.recordLauncher(pid)]);
      const control = await readFile(posix.join(working, "control"), "utf8");
      return !hostConnected && stdout === "boundary-control\n" && control === stdout
        ? "available" as const : "shell-start-failed" as const;
    } finally {
      await held.release();
    }
  } catch {
    signal?.throwIfAborted();
    return "shell-start-failed" as const;
  } finally {
    proxy.close();
    host.close();
    unix.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

export { detectMxcLinuxShellSupport as _detectMxcLinuxShellSupportForTest, trustedLinuxPath as _trustedLinuxPathForTest };
