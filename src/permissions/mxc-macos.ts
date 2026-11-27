import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { createLogger } from "../lib/logger.js";
import { raceWithTimeout } from "../shared/abortable-deadline.js";
import type { SandboxMacContainerShellSupport, SandboxMacContainerShellUnavailableReason } from "../shared/sandbox-capability-info.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { launcherPathFor, resolveHostLauncherPath } from "./mxc-launcher.js";
import { atOrUnder, canonicalPath, posixPolicyLookups, rankPosixContainerRows, type PosixPolicyLookups } from "./mxc-posix.js";
import { requireMxcContainerStartRoot } from "./mxc-runtime-root.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, type PolicyModel } from "./policy-model.js";
import { buildSeatbeltShellProfile, splitSeatbeltPolicyRows } from "./seatbelt-profile.js";
import { quoteSandboxWrappedWord } from "./sandbox-wrapped-command.js";

const PROXY_ENV_KEYS = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy"]);

class SeatbeltShellRequestError extends Error {
  constructor(readonly code: "cwd-ungranted" | "proxy-invalid" | "env-invalid", message: string) {
    super(message);
    this.name = "SeatbeltShellRequestError";
  }
}

export function buildSeatbeltShellRequest(input: {
  readonly commandLine: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly model: PolicyModel;
  readonly lookups: PosixPolicyLookups;
  readonly proxyUrl: string;
}) {
  const { lookups, model } = input;
  const proxyPort = Number(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(input.proxyUrl)?.[1]);
  if (!Number.isInteger(proxyPort) || proxyPort > 65535) {
    throw new SeatbeltShellRequestError("proxy-invalid", "Container proxy must be an IPv4 loopback listener");
  }
  const grants = rankPosixContainerRows(splitSeatbeltPolicyRows(model).literalModel, "seatbelt", lookups);
  const cwd = canonicalPath(input.cwd, true, lookups);
  const coversCwd = (root: string) => atOrUnder(cwd, root, lookups.foldsCase);
  const inChain = grants.chainFolders.some(root => coversCwd(root) && atOrUnder(root, cwd, lookups.foldsCase));
  if (!lookups.exists(cwd) || grants.denied.some(coversCwd)
    || (!inChain && ![...grants.readonly, ...grants.readwrite].some(coversCwd))) {
    throw new SeatbeltShellRequestError("cwd-ungranted", `Container shell working directory is outside its filesystem grants: ${cwd}`);
  }
  const profileOverride = buildSeatbeltShellProfile({ model, grants, lookups, unixSocketRoots: [], proxyPort });
  const env = Object.entries(input.env).flatMap(([key, value]) =>
    key && !key.includes("=") && !PROXY_ENV_KEYS.has(key.toLowerCase()) ? [`${key}=${value}`] : []);
  return {
    grants,
    request: {
      version: "1.0.0",
      containment: "seatbelt",
      process: { commandLine: input.commandLine, cwd, timeout: input.timeoutMs, inheritDefaultEnv: false, env },
      filesystem: { readwritePaths: grants.readwrite, readonlyPaths: grants.readonly, deniedPaths: grants.denied },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      runtimeConfig: { networkProxy: input.proxyUrl },
      seatbelt: { profileOverride, nestedPty: false },
      ui: { disable: true, clipboard: "none", injection: false },
    },
  };
}

export function mapSeatbeltShellRequest(wire: ReturnType<typeof buildSeatbeltShellRequest>["request"]): ContainerRequest {
  const { process, seatbelt, filesystem, network, runtimeConfig, ui } = wire;
  return {
    command: process.commandLine,
    workingDirectory: process.cwd,
    timeoutMs: process.timeout,
    environment: Object.fromEntries(process.env.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) throw new SeatbeltShellRequestError("env-invalid", "Invalid container environment entry");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    })),
    inheritDefaultEnvironment: process.inheritDefaultEnv,
    containment: { type: "seatbelt", config: seatbelt },
    filesystem: {
      readwritePaths: [...filesystem.readwritePaths],
      readonlyPaths: [...filesystem.readonlyPaths],
      deniedPaths: [...filesystem.deniedPaths],
    },
    network: { ...network as ContainerRequest["network"], runtimeConfig },
    ui: { disable: ui.disable, clipboard: ui.clipboard as NonNullable<ContainerRequest["ui"]>["clipboard"], allowInputInjection: ui.injection },
  };
}

type CanaryVerdict = "available" | "request-rejected" | "shell-start-failed";

interface MacShellProbeDependencies {
  readonly arch: string;
  launcherPath(): string | undefined;
  exists(path: string): boolean;
  verifyPin(path: string): Promise<boolean>;
  requireRuntimeRoot(): string;
  canary(launcher: string, root: string): Promise<CanaryVerdict>;
}

async function detectMxcMacShellSupport(deps: MacShellProbeDependencies): Promise<SandboxMacContainerShellSupport> {
  const unavailable = (reason: SandboxMacContainerShellUnavailableReason): SandboxMacContainerShellSupport =>
    ({ state: "unavailable", reason });
  if (deps.arch !== "arm64") return unavailable("unsupported-arch");
  const launcher = deps.launcherPath();
  if (launcher === undefined || !deps.exists(launcher)) return unavailable("binary-missing");
  if (!await deps.verifyPin(launcher)) return unavailable("launcher-mismatch");
  let root: string;
  try {
    root = deps.requireRuntimeRoot();
  } catch {
    return unavailable("runtime-root-unproved");
  }
  const verdict = await deps.canary(launcher, root);
  return verdict === "available" ? { state: "available" } : unavailable(verdict);
}

export function detectHostMxcMacShellSupport(resourcePath: string, signal?: AbortSignal): Promise<SandboxMacContainerShellSupport> {
  signal?.throwIfAborted();
  if (!isAbsolute(resourcePath)) throw new Error("Container launcher resources must be absolute");
  return detectMxcMacShellSupport({
    arch: process.arch,
    launcherPath: () => launcherPathFor(resourcePath, "darwin", process.arch),
    exists: existsSync,
    verifyPin: () => resolveHostLauncherPath("darwin-arm64", resourcePath).then(() => true, () => false),
    requireRuntimeRoot: requireMxcContainerStartRoot,
    async canary(launcher, root) {
      try {
        return await runSeatbeltCanary(launcher, root, signal);
      } catch {
        signal?.throwIfAborted();
        return "shell-start-failed";
      }
    },
  });
}

const MAX_UNIX_SOCKET_PATH_BYTES = 103;
const CANARY_CONTROL = "container-shell-control\n";
const CANARY_HOST_TIMEOUT_MS = TOOL_TIMEOUT_POLICY.mxcMacShellProbeMs + TOOL_TIMEOUT_POLICY.mxcMacShellProbeGraceMs;
const log = createLogger("mxc-macos");

interface SeatbeltCanaryEvidence {
  readonly status: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly control: string | null;
  readonly outsideWrite: boolean;
  readonly otherPortConnected: boolean;
  readonly unixSocketConnected: boolean;
  readonly protectedNewFile: boolean;
  readonly protectedParentInPlace: boolean;
}

function seatbeltCanaryPassed(evidence: SeatbeltCanaryEvidence): boolean {
  return evidence.status === 0 && !evidence.timedOut && evidence.stdout === CANARY_CONTROL
    && evidence.control === CANARY_CONTROL && !evidence.outsideWrite
    && !evidence.otherPortConnected && !evidence.unixSocketConnected
    && !evidence.protectedNewFile && evidence.protectedParentInPlace;
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("Invalid container probe listener"));
      else resolve(address.port);
    });
  });
}

function runCanaryRequest(launcher: string, config: string, flags: readonly string[], signal?: AbortSignal):
Promise<Pick<SeatbeltCanaryEvidence, "status" | "timedOut" | "stdout"> & { stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(launcher, [...flags, "--config", config], {
      cwd: dirname(launcher),
      env: buildSafeChildEnv(),
      encoding: "utf8",
      ...(flags.length > 0 ? { timeout: CANARY_HOST_TIMEOUT_MS, signal } : {}),
    }, (error, stdout, stderr) => {
      if (signal?.aborted || (error && typeof error.code !== "number" && !error.killed)) {
        reject(error);
      } else {
        resolve({
          status: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          timedOut: error?.killed === true,
          stdout, stderr,
        });
      }
    });
  });
}

async function runSeatbeltCanary(launcher: string, root: string, signal?: AbortSignal): Promise<CanaryVerdict> {
  let scratch: string | undefined;
  let socketAlias: string | undefined;
  let running: ReturnType<typeof runCanaryRequest> | undefined;
  let otherPortConnected = false;
  let unixSocketConnected = false;
  const unix = createServer(socket => { unixSocketConnected = true; socket.destroy(); });
  const proxy = createServer(socket => socket.destroy());
  const other = createServer(socket => { otherPortConnected = true; socket.destroy(); });
  const teardown = async () => {
    proxy.close();
    other.close();
    unix.close();
    if (socketAlias !== undefined) await rm(socketAlias, { recursive: true });
    if (scratch !== undefined) await rm(scratch, { recursive: true });
  };
  try {
    scratch = await mkdtemp(join(root, "p-"));
    const working = join(scratch, "w");
    const sealed = join(scratch, "sealed");
    const opened = join(sealed, "open");
    const parent = join(working, "control-parent");
    const protectedChild = join(parent, "protected");
    await mkdir(protectedChild, { recursive: true, mode: 0o700 });
    await mkdir(opened, { recursive: true, mode: 0o700 });
    const protectedFile = join(sealed, "secret");
    const outsideWrite = join(sealed, "new-file");
    const control = join(working, "control");
    const renamed = join(working, "renamed");
    let unixPath = join(working, "s");
    const laterFile = join(working, "later", "file.locked");
    await writeFile(protectedFile, "canary-sealed-file\n", { flag: "wx", mode: 0o600 });

    const lookups = posixPolicyLookups(working, existsSync(join(scratch, "W")));
    const floors = [
      policyFloorRow(sealed, "denied", "read-boundary", true),
      policyFloorRow(protectedChild, "ro", "protected-name", true),
      policyFloorRow(`${working}/**/*.locked`, "ro", "protected-name", false),
    ];
    if (Buffer.byteLength(unixPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
      // The socket still binds inside the granted project. The alias keeps its
      // name within the kernel's Unix-address limit for deeply nested homes.
      socketAlias = await mkdtemp(join(tmpdir(), "p-"));
      const alias = join(socketAlias, "w");
      await symlink(working, alias);
      unixPath = join(alias, "s");
    }
    const model = buildPolicyModel({
      floors, userGrants: [], extensionManifests: [],
      launchGrants: [
        policyGrantRow(scratch, "ro", "launch-grant", true),
        policyGrantRow(working, "rw", "launch-grant", true),
        policyGrantRow(opened, "ro", "launch-grant", true),
        ...(socketAlias === undefined ? [] : [policyGrantRow(socketAlias, "ro", "launch-grant", true)]),
      ],
    });
    const proxyPort = await listenOnLoopback(proxy);
    const otherPort = await listenOnLoopback(other);
    await new Promise<void>((resolve, reject) => {
      unix.once("error", reject);
      unix.listen(unixPath, resolve);
    });
    const config = join(scratch, "canary.json");
    const commandLine = [
      `printf '%s' ${quoteSandboxWrappedWord(CANARY_CONTROL)} > ${quoteSandboxWrappedWord(control)} || exit 11`,
      `/bin/cat ${quoteSandboxWrappedWord(control)} || exit 12`,
      `if /bin/cat ${quoteSandboxWrappedWord(protectedFile)}; then exit 13; fi`,
      `if (printf x > ${quoteSandboxWrappedWord(outsideWrite)}); then exit 14; fi`,
      `/usr/bin/nc -z -w 1 127.0.0.1 ${proxyPort} || exit 15`,
      `if /usr/bin/nc -z -w 1 127.0.0.1 ${otherPort}; then exit 16; fi`,
      `if /bin/mv ${quoteSandboxWrappedWord(parent)} ${quoteSandboxWrappedWord(renamed)}; then exit 17; fi`,
      `if /usr/bin/stat ${quoteSandboxWrappedWord(protectedFile)}; then exit 18; fi`,
      `if /usr/bin/nc -z -U ${quoteSandboxWrappedWord(unixPath)}; then exit 19; fi`,
      "/bin/mkdir later || exit 20",
      `if (printf x > ${quoteSandboxWrappedWord(laterFile)}); then exit 21; fi`,
    ].join("\n");
    const { request } = buildSeatbeltShellRequest({
      model, lookups, commandLine, cwd: working, timeoutMs: TOOL_TIMEOUT_POLICY.mxcMacShellProbeMs,
      env: { HOME: working, PATH: "/usr/bin:/bin" }, proxyUrl: `http://127.0.0.1:${proxyPort}`,
    });
    await writeFile(config, JSON.stringify(request), { flag: "wx", mode: 0o600 });
    const dryRun = await runCanaryRequest(launcher, config, ["--dry-run"], signal).catch(() => {
      signal?.throwIfAborted();
      return null;
    });
    if (dryRun === null || dryRun.status !== 0 || dryRun.timedOut) return "request-rejected";
    signal?.throwIfAborted();
    // The launcher's own deadline reaps the contained child. Signalling the launcher alone can orphan it.
    running = runCanaryRequest(launcher, config, []).finally(() => { running = undefined; });
    const start = await raceWithTimeout(running, CANARY_HOST_TIMEOUT_MS, () => new Error("Container canary exit unconfirmed"));
    signal?.throwIfAborted();
    return seatbeltCanaryPassed({
      ...start,
      control: existsSync(control) ? await readFile(control, "utf8") : null,
      outsideWrite: lstatSync(outsideWrite, { throwIfNoEntry: false }) !== undefined,
      otherPortConnected, unixSocketConnected,
      protectedNewFile: existsSync(laterFile),
      protectedParentInPlace: existsSync(protectedChild) && !existsSync(renamed),
    }) ? "available" : "shell-start-failed";
  } finally {
    if (running === undefined) {
      await teardown();
    } else {
      // The watchdog bounds boot's wait. Keep the fixture live until the launcher actually finishes.
      proxy.unref();
      other.unref();
      unix.unref();
      void running.then(teardown, teardown).catch(error => log.warn({ err: error }, "Container canary cleanup failed"));
    }
  }
}

export {
  detectMxcMacShellSupport as _detectMxcMacShellSupportForTest,
  runSeatbeltCanary as _runSeatbeltCanaryForTest,
  seatbeltCanaryPassed as _seatbeltCanaryPassedForTest,
};
