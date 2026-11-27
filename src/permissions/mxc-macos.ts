import { randomBytes } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import type { HostResources } from "../main/host-resources.js";
import type { MacRawIpVerdict, MxcRawIpUdpArrival, SandboxMacContainerShellSupport, SandboxMacContainerShellUnavailableReason } from "../shared/sandbox-capability-info.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { INVOCATION_PROXY_REFUSED_STATUS, openInvocationProxyListener } from "./egress-invocation-listener.js";
import pins from "./mxc-launcher-pins.json" with { type: "json" };
import { openMxcRawIpUdpListener, type MxcRawIpUdpSend } from "./mxc-raw-ip-udp.js";
import {
  parseRawIpProbeOutput, RAW_IP_PROBE_BUDGET_S, RAW_IP_PROBER, rawIpProbeShellLines, RAW_IP_TARGET_DEADLINE_S, rawIpVerdict, seatbeltProfileAllowsOnlyProxyEgress,
} from "./mxc-macos-raw-ip.js";
import { atOrUnder, canonicalPath, posixPolicyLookups, rankPosixContainerRows, type PosixPolicyLookups } from "./mxc-posix.js";
import { requireMxcContainerStartRoot } from "./mxc-runtime-root.js";
import { mxcShellSupervisorLocation, stageMxcShellRequest, startMxcShellSupervisor } from "./mxc-shell-supervisor-client.js";
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

type CanaryVerdict = "available" | "request-rejected" | "shell-start-failed" | "launcher-mismatch";

/** What one canary start found: availability, and the raw-IP verdict measured in the same start. */
type CanaryResult =
  | { readonly verdict: "available"; readonly rawIpProbe: MacRawIpVerdict }
  | { readonly verdict: Exclude<CanaryVerdict, "available"> };

interface MacShellProbeDependencies {
  readonly arch: string;
  libraryExists(): boolean;
  requireRuntimeRoot(): string;
  canary(root: string): Promise<CanaryResult>;
}

async function detectMxcMacShellSupport(deps: MacShellProbeDependencies): Promise<SandboxMacContainerShellSupport> {
  const unavailable = (reason: SandboxMacContainerShellUnavailableReason): SandboxMacContainerShellSupport =>
    ({ state: "unavailable", reason });
  if (deps.arch !== "arm64") return unavailable("unsupported-arch");
  if (!deps.libraryExists()) return unavailable("binary-missing");
  let root: string;
  try {
    root = deps.requireRuntimeRoot();
  } catch {
    return unavailable("runtime-root-unproved");
  }
  const result = await deps.canary(root);
  return result.verdict === "available" ? { state: "available", rawIpProbe: result.rawIpProbe } : unavailable(result.verdict);
}

export function detectHostMxcMacShellSupport(resources: HostResources, signal?: AbortSignal): Promise<SandboxMacContainerShellSupport> {
  signal?.throwIfAborted();
  const location = mxcShellSupervisorLocation(resources);
  return detectMxcMacShellSupport({
    arch: process.arch,
    libraryExists: () => existsSync(join(location.nodeModules, pins.sdk.packages["@microsoft/mxc-sdk"],
      pins.targets["darwin-arm64"].library.member)),
    requireRuntimeRoot: requireMxcContainerStartRoot,
    async canary(root) {
      try {
        return await runSeatbeltCanary(location, root, signal);
      } catch {
        signal?.throwIfAborted();
        return { verdict: "shell-start-failed" };
      }
    },
  });
}

const MAX_UNIX_SOCKET_PATH_BYTES = 103;
const CANARY_CONTROL = "container-shell-control\n";

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

/** The host's primary non-loopback IPv4 address: the first one the interface table lists, or undefined offline. */
function primaryIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return undefined;
}

/** A port that was free on `address` a moment ago: bound ephemerally, then closed just before the run. */
async function closedPortOn(address: string): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, address, () => {
      const bound = server.address();
      if (bound === null || typeof bound === "string") reject(new Error("Invalid raw-IP probe port"));
      else resolve(bound.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * The host-side raw-IP targets on `address`: a just-closed TCP port and the UDP arrival listener, both or neither.
 * A bind that fails there (say `EADDRNOTAVAIL` for an address the host no longer holds) is missing evidence about
 * raw IP, never a reason the container is unavailable: the caller then runs the prober without them.
 */
async function bindRawIpHostTargets(
  address: string, nonce: string, deadline: number, adopt: (close: () => Promise<void>) => void,
) {
  let tlPort: number;
  try {
    tlPort = await closedPortOn(address);
  } catch {
    return undefined;
  }
  const udp = await openMxcRawIpUdpListener(address, nonce, deadline, adopt);
  return udp === undefined ? undefined : { address, tlPort, udp };
}

/**
 * Native tests only: replace the prober text, edit the staged profile, or aim the host-side targets at another
 * address, to drive the raw-IP failure and control cases.
 */
interface CanaryTestOverrides {
  readonly prober?: string;
  readonly editProfile?: (profile: string, hostPorts: { readonly tl: number; readonly udp: number } | undefined) => string;
  readonly hostAddress?: string;
  /** The watchdog's delay in seconds, so a test can find its own watchdog among the host's processes. */
  readonly watchdogSeconds?: string;
}

async function runSeatbeltCanary(
  location: ReturnType<typeof mxcShellSupervisorLocation>, root: string, signal?: AbortSignal, overrides: CanaryTestOverrides = {},
): Promise<CanaryResult> {
  let scratch: string | undefined;
  let socketAlias: string | undefined;
  let otherPortConnected = false;
  let unixSocketConnected = false;
  // The raw-IP control goes through a real invocation listener: it refuses `<nonce>.localhost` as a loopback
  // destination and reports that refusal here. It forwards nothing, since the canary holds no egress grant.
  const nonce = randomBytes(16).toString("hex");
  let nonceRecorded = false;
  const unix = createServer(socket => { unixSocketConnected = true; socket.destroy(); });
  const other = createServer(socket => { otherPortConnected = true; socket.destroy(); });
  let proxy: Awaited<ReturnType<typeof openInvocationProxyListener>> | undefined;
  let closeUdp: (() => Promise<void>) | undefined;
  const teardown = async () => {
    await proxy?.close();
    await closeUdp?.();
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
    const prober = join(working, "raw-ip.pl");
    const rawIpOutput = join(working, "raw-ip.out");
    await writeFile(protectedFile, "canary-sealed-file\n", { flag: "wx", mode: 0o600 });
    await writeFile(prober, overrides.prober ?? RAW_IP_PROBER, { flag: "wx", mode: 0o600 });

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
    proxy = await openInvocationProxyListener({
      upstream: () => undefined,
      onRefused: (destination) => { if (destination === `${nonce}.localhost`) nonceRecorded = true; },
    });
    const proxyPort = proxy.port;
    const otherPort = await listenOnLoopback(other);
    await new Promise<void>((resolve, reject) => {
      unix.once("error", reject);
      unix.listen(unixPath, resolve);
    });
    const timeoutMs = TOOL_TIMEOUT_POLICY.mxcMacShellProbeMs + TOOL_TIMEOUT_POLICY.mxcRawIpProbeMs;
    const hostAddress = overrides.hostAddress ?? primaryIpv4();
    // The UDP listener counts an arrival until the run ends and the datagram's own window after it has passed.
    const udpDeadline = Date.now() + timeoutMs + RAW_IP_TARGET_DEADLINE_S * 1_000;
    const host = hostAddress === undefined ? undefined
      : await bindRawIpHostTargets(hostAddress, nonce, udpDeadline, (close) => { closeUdp = close; });
    const config = join(scratch, "canary.json");
    const availability = [
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
    ];
    // Availability is decided by the checks above alone: their status is taken first, and the raw-IP prober writes
    // only to its own file, so nothing it does or prints can change it. It runs only after availability passed.
    const rawIpArgs = [proxyPort, nonce, host?.address ?? "-", host?.tlPort ?? 0, host?.address ?? "-", host?.udp.port ?? 0]
      .map((value) => quoteSandboxWrappedWord(String(value))).join(" ");
    const commandLine = [
      "(", ...availability, ")",
      "status=$?",
      'if [ "$status" -eq 0 ]; then',
      ...rawIpProbeShellLines({
        prober: `/usr/bin/perl ${quoteSandboxWrappedWord(prober)} ${rawIpArgs}`, output: quoteSandboxWrappedWord(rawIpOutput),
        watchdogSeconds: overrides.watchdogSeconds ?? String(RAW_IP_PROBE_BUDGET_S + 1),
      }),
      "fi",
      'exit "$status"',
    ].join("\n");
    const { request } = buildSeatbeltShellRequest({
      model, lookups, commandLine, cwd: working, timeoutMs,
      env: { HOME: working, PATH: "/usr/bin:/bin" }, proxyUrl: proxy.url,
    });
    if (overrides.editProfile !== undefined) request.seatbelt.profileOverride = overrides.editProfile(request.seatbelt.profileOverride,
      host === undefined ? undefined : { tl: host.tlPort, udp: host.udp.port });
    const staged = await stageMxcShellRequest(config, request);
    const launch = startMxcShellSupervisor(staged, timeoutMs, signal,
      () => { void proxy?.close(); }, "macos-shell-canary", location);
    let stdout = "";
    launch.child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    launch.child.stderr.resume();
    const start = await launch.completion;
    signal?.throwIfAborted();
    if (start.failure?.code === "integrity") return { verdict: "launcher-mismatch" };
    if (start.failure?.code === "start-refused" && start.failure.sdkCode === "malformed_request") {
      return { verdict: "request-rejected" };
    }
    const available = seatbeltCanaryPassed({
      status: start.code, timedOut: start.timedOut, stdout,
      control: existsSync(control) ? await readFile(control, "utf8") : null,
      outsideWrite: lstatSync(outsideWrite, { throwIfNoEntry: false }) !== undefined,
      otherPortConnected, unixSocketConnected,
      protectedNewFile: existsSync(laterFile),
      protectedParentInPlace: existsSync(protectedChild) && !existsSync(renamed),
    });
    if (!available) return { verdict: "shell-start-failed" };
    const output = existsSync(rawIpOutput) ? parseRawIpProbeOutput(await readFile(rawIpOutput, "utf8")) : undefined;
    // An arrival counts whatever the prober printed. A datagram that was sent is waited for up to its own window; a
    // send refused in the container leaves nothing to wait on; no send at all is unmeasured.
    const udpPrinted = output?.targets.UA;
    const udpSend: MxcRawIpUdpSend = udpPrinted === "0" ? "sent"
      : udpPrinted !== undefined && /^\d+$/u.test(udpPrinted) ? "refused-local" : "unmeasured";
    const udpArrival: MxcRawIpUdpArrival = host === undefined ? "unmeasured"
      : await host.udp.observe(udpSend, RAW_IP_TARGET_DEADLINE_S * 1_000);
    return {
      verdict: "available",
      rawIpProbe: rawIpVerdict({
        ran: true, ...(output === undefined ? {} : { output }), expectedStatus: INVOCATION_PROXY_REFUSED_STATUS,
        nonceRecorded, tlRan: host !== undefined, udpArrival,
        structuralIpv6: seatbeltProfileAllowsOnlyProxyEgress(request.seatbelt.profileOverride, proxyPort),
      }),
    };
  } finally {
    await teardown();
  }
}

export {
  detectMxcMacShellSupport as _detectMxcMacShellSupportForTest,
  runSeatbeltCanary as _runSeatbeltCanaryForTest,
  seatbeltCanaryPassed as _seatbeltCanaryPassedForTest,
};
