import { createSocket } from "node:dgram";
import { lstat, readdir, readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { posix } from "node:path";
import { createLogger } from "../lib/logger.js";
import type {
  LinuxRawIpTarget, LinuxRawIpUnknownReason, LinuxRawIpVerdict, MxcRawIpUdpArrival,
} from "../shared/sandbox-capability-info.js";
import type { MxcRawIpUdpSend } from "./mxc-raw-ip-udp.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

/**
 * Raw-IP measurement for the Linux shell container, by the verdict rules shared with macOS and Windows. The boot
 * canary runs the prober below inside a real container started the way a user shell starts; the host classifies what
 * it printed. Nothing here is persisted: the verdict lives in memory for this boot only.
 */

const log = createLogger("mxc-linux-raw-ip");

const TARGET_DEADLINE_S = TOOL_TIMEOUT_POLICY.mxcLinuxRawIpTargetMs / 1000;

type RawIpTargetClass = "refused-local" | "allowed" | "inconclusive";
type InconclusiveKind = "no-route" | "timeout" | "unclassified";
export interface RawIpTargetResult {
  readonly class: RawIpTargetClass;
  /** Why an inconclusive target was inconclusive. */
  readonly kind?: InconclusiveKind;
}

/**
 * The network a Linux canary's container had. `slirp`: the shell route, the launcher's slirp4netns backend with its
 * firewall. Each backend counts as a local refusal only the TCP result a canary has observed on it.
 */
export type LinuxRawIpBackend = "slirp";

// Linux column of the rules. The prober is plain bash, which reports a failed connect by its C-locale message, not
// its number. A connect, or ECONNREFUSED, means the packet reached a peer.
const LINUX_RESULTS = {
  // No canary has observed a TCP policy refusal (EPERM, EACCES) through slirp4netns: the launcher's firewall drops the
  // packet, which is judged by arrival. So no TCP result counts as refused locally there.
  tcpRefusedLocal: { slirp: new Set<string>() } satisfies Record<LinuxRawIpBackend, ReadonlySet<string>>,
  // A datagram's send is refused locally by EPERM or EACCES: the firewall's OUTPUT drop, as the canary measures.
  udpRefusedLocal: new Set(["Operation not permitted", "Permission denied"]),
  allowed: new Set(["0", "Connection refused"]),
  noRoute: new Set([
    "Network is unreachable", "No route to host", "Cannot assign requested address", "Address family not supported by protocol",
  ]),
  timeout: new Set(["Connection timed out", "deadline"]),
} as const;

/**
 * One printed result (`0`, `deadline`, or the C-locale error message), as the rules classify it on Linux. `refusedLocal`
 * is the set of results that count as a local policy refusal for this target: none unless the caller names a backend.
 */
export function classifyLinuxRawIpTarget(result: string | undefined, backend?: LinuxRawIpBackend, udp = false): RawIpTargetResult {
  if (result === undefined) return { class: "inconclusive", kind: "unclassified" };
  const refusedLocal = udp ? LINUX_RESULTS.udpRefusedLocal : backend === undefined ? undefined : LINUX_RESULTS.tcpRefusedLocal[backend];
  if (refusedLocal?.has(result) === true) return { class: "refused-local" };
  if (LINUX_RESULTS.allowed.has(result)) return { class: "allowed" };
  if (LINUX_RESULTS.noRoute.has(result)) return { class: "inconclusive", kind: "no-route" };
  if (LINUX_RESULTS.timeout.has(result)) return { class: "inconclusive", kind: "timeout" };
  return { class: "inconclusive", kind: "unclassified" };
}

type RawIpTargetName = "T4" | "T6" | "TL" | "TA" | "UA";

/** What the prober printed; a missing or malformed line is absent. */
export interface LinuxRawIpProbeOutput {
  readonly control?: { readonly status: string; readonly refusal: string };
  readonly targets: Readonly<Partial<Record<RawIpTargetName, string>>>;
  /** The network interfaces of the container's own network namespace. */
  readonly interfaces?: readonly string[];
}

export function parseLinuxRawIpProbeOutput(text: string): LinuxRawIpProbeOutput {
  const targets: Partial<Record<RawIpTargetName, string>> = {};
  let control: LinuxRawIpProbeOutput["control"];
  let interfaces: string[] | undefined;
  for (const line of text.split("\n")) {
    const [, name, value] = /^(T4|T6|TL|TA|UA) (\S.*)$/u.exec(line) ?? [];
    if (name !== undefined && value !== undefined && targets[name as RawIpTargetName] === undefined) {
      targets[name as RawIpTargetName] = value;
    }
    const [, status, refusal] = /^C status=(\S+) refused=(.*)$/u.exec(line) ?? [];
    if (status !== undefined && refusal !== undefined && control === undefined) control = { status, refusal };
    const [, names] = /^IF (\S*)$/u.exec(line) ?? [];
    if (names !== undefined && interfaces === undefined) interfaces = names === "" ? [] : names.split(",");
  }
  return { targets, ...(control === undefined ? {} : { control }), ...(interfaces === undefined ? {} : { interfaces }) };
}

export interface LinuxRawIpMeasurement {
  /** False when the probe did not run in a proven container (the shell canary did not pass). */
  readonly ran: boolean;
  readonly backend: LinuxRawIpBackend;
  /**
   * The host's primary IPv4, which the host-side targets bind, lies in the backend's own network: a datagram or connect
   * to it stays inside that network, so nothing arriving proves nothing.
   */
  readonly hostInBackendNetwork: boolean;
  readonly output?: LinuxRawIpProbeOutput;
  /** The refusal status the invocation listener answers with, from the listener module. */
  readonly expectedStatus: number;
  /** The host-side listener recorded a refusal whose destination carries this run's nonce. */
  readonly nonceRecorded: boolean;
  /** TL ran: the host had a primary non-loopback IPv4 to aim at. */
  readonly tlRan: boolean;
  /** Whether the UDP nonce reached the host-side listener (`linuxRawIpUdpArrival`). */
  readonly udpArrival: MxcRawIpUdpArrival;
  /**
   * The host-side TCP arrival listener on the host's primary IPv4, absent when it could not be opened: whether an
   * unconfined connect from this process reached it before the run, and whether anything else connected to it.
   */
  readonly arrival?: { readonly controlPassed: boolean; readonly arrived: boolean };
  /** The launcher's firewall for this container, read while it ran, drops every egress but loopback and the proxy. */
  readonly firewallDrops: boolean;
}

/**
 * What the prober's `UA` line says about the datagram: sent, refused in the container by a local policy error, or
 * neither (missing, timed out or unclassified), which is no send to measure.
 */
export function linuxRawIpUdpSend(printed: string | undefined): MxcRawIpUdpSend {
  if (printed === "0") return "sent";
  return classifyLinuxRawIpTarget(printed, undefined, true).class === "refused-local" ? "refused-local" : "unmeasured";
}

/**
 * The UDP arrival evidence, as on macOS: an arrival counts whatever was printed; otherwise it is `absent` only when a
 * host-side listener was open and the datagram was sent (and waited for) or refused locally.
 */
export function linuxRawIpUdpArrival(send: MxcRawIpUdpSend, listening: boolean, arrived: boolean): MxcRawIpUdpArrival {
  if (arrived) return "arrived";
  return listening && send !== "unmeasured" ? "absent" : "unmeasured";
}

/** The verdict, in the rules' order. `blocked` needs this boot's measurement with the control passed. */
export function linuxRawIpVerdict(measurement: LinuxRawIpMeasurement): LinuxRawIpVerdict {
  const { output, udpArrival } = measurement;
  const reachableTargets: (LinuxRawIpTarget | "udp")[] = [];
  const unknown = (reason: LinuxRawIpUnknownReason): LinuxRawIpVerdict => ({ rawIp: "unknown", reason, reachableTargets, udpArrival });
  // Rule 1: probe not run, nothing printed, or the control did not pass on both sides.
  if (!measurement.ran || output === undefined) return unknown("no-evidence");
  const control = output.control;
  if (control === undefined && Object.keys(output.targets).length === 0) return unknown("no-evidence");
  if (control === undefined || control.status !== String(measurement.expectedStatus) || control.refusal === "none"
    || control.refusal === "" || !measurement.nonceRecorded) return unknown("control-failed");
  const classify = (result: string | undefined) => classifyLinuxRawIpTarget(result, measurement.backend);
  const t4 = classify(output.targets.T4);
  const t6 = classify(output.targets.T6);
  const tl = measurement.tlRan ? classify(output.targets.TL) : undefined;
  const ta = measurement.arrival === undefined ? undefined : classify(output.targets.TA);
  // Rule 2: anything that reached a peer, by TCP, by the TCP arrival listener or by the UDP arrival check.
  // The arrival listener is `ta`: the container reached it whether the connect reported success or the listener saw it.
  reachableTargets.push(...([["t4", t4], ["t6", t6], ["tl", tl], ["ta", ta]] as const)
    .filter(([name, result]) => result?.class === "allowed" || (name === "ta" && measurement.arrival?.arrived === true))
    .map(([name]) => name));
  if (udpArrival === "arrived") reachableTargets.push("udp");
  if (reachableTargets.length > 0) {
    log.warn(`raw-ip-reachable (${reachableTargets.join(", ")})`);
    return unknown("raw-ip-reachable");
  }
  if (measurement.hostInBackendNetwork) {
    log.info("raw-ip arrival unprovable: the host address lies in the backend's own network");
    return unknown("arrival-unprovable");
  }
  // Owner ruling: with no IPv6 route, a network namespace holding nothing but `lo` is structural evidence for T6.
  const interfaces = output.interfaces;
  const onlyLoopback = interfaces !== undefined && interfaces.length === 1 && interfaces[0] === "lo";
  const t6Structural = t6.class === "inconclusive" && t6.kind === "no-route" && onlyLoopback;
  // Owner ruling (2): on a backend that drops direct TCP, a dropped target is refused-arrival only when the arrival
  // listener took the unconfined control, recorded nothing from the container, and the structure holds: the netns has
  // only `lo` and the backend's `tap0`, and the launcher's firewall drops egress by default.
  const structure = interfaces !== undefined && interfaces.length === 2 && interfaces[0] === "lo" && interfaces[1] === "tap0"
    && measurement.firewallDrops;
  const arrivalHolds = measurement.arrival?.controlPassed === true && structure;
  const refusedArrival = (result: RawIpTargetResult) =>
    arrivalHolds && result.class === "inconclusive" && (result.kind === "timeout" || result.kind === "no-route");
  const t4Refused = t4.class === "refused-local" || refusedArrival(t4);
  const t6Refused = t6.class === "refused-local" || t6Structural || refusedArrival(t6);
  // Rule 3.
  if (t4Refused && t6Refused && tl !== undefined) {
    // As on every POSIX backend, a datagram nobody measured leaves `blocked` unproved.
    if (udpArrival === "unmeasured") return unknown("udp-unmeasured");
    const evidenceKind = t4.class !== "refused-local" || (t6.class !== "refused-local" && !t6Structural) ? "arrival"
      : t6.class === "refused-local" ? "measured" : "structural";
    log.info(`raw-ip blocked, evidence ${evidenceKind}`);
    return { rawIp: "blocked", reason: "blocked", evidenceKind, reachableTargets, udpArrival };
  }
  if (measurement.arrival !== undefined && (t4.class === "inconclusive" || t6.class === "inconclusive")) {
    log.info(`raw-ip arrival evidence incomplete (control ${measurement.arrival.controlPassed ? "passed" : "failed"}, `
      + `interfaces ${interfaces?.join(",") ?? "unread"}, firewall ${measurement.firewallDrops ? "drops" : "unread"})`);
  }
  // Rule 4.
  if (tl === undefined) return unknown("no-evidence");
  const inconclusive = [t4, t6, tl].filter((result) => result.class === "inconclusive");
  if (inconclusive.some((result) => result.kind === "timeout")) return unknown("timeout");
  if (t4.kind === "no-route" || tl.kind === "no-route") return unknown("no-route");
  if (t6.kind === "no-route") return unknown("ipv6-unmeasured");
  return unknown("unclassified");
}

/** The host's primary non-loopback IPv4 address: the first one the interface table lists, or undefined offline. */
export function primaryIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return undefined;
}

/** slirp4netns' own network: its gateway, DNS and the container's address. */
const SLIRP_NETWORK_PREFIX = "10.0.2.";

/** Whether a host address lies in the slirp4netns network, where it would not be delivered to the host's listener. */
export function linuxRawIpHostInBackendNetwork(address: string | undefined): boolean {
  return address?.startsWith(SLIRP_NETWORK_PREFIX) === true && /^10\.0\.2\.\d{1,3}$/u.test(address);
}

/** One connection the host-side TCP arrival listener accepted. */
export interface LinuxRawIpTcpAccept { readonly address: string | undefined; readonly port: number | undefined }

/**
 * Whether anything but the control reached the listener. Accepts are counted: exactly one, the control's, is clean;
 * any more is an arrival, even one from the control's own source port.
 */
export function linuxRawIpTcpArrived(accepts: readonly LinuxRawIpTcpAccept[], control: LinuxRawIpTcpAccept | undefined): boolean {
  const controlTaken = control !== undefined && accepts.some((accept) => accept.address === control.address && accept.port === control.port);
  return accepts.length > (controlTaken ? 1 : 0);
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

/** A host-side UDP listener for the arrival check; `arrived` turns true when a datagram carrying `nonce` comes in. */
async function openUdpArrival(address: string, nonce: string) {
  const socket = createSocket("udp4");
  let arrived = false;
  let notify: (() => void) | undefined;
  socket.on("message", (message) => {
    if (message.toString("utf8").includes(nonce)) { arrived = true; notify?.(); }
  });
  const port = await new Promise<number>((resolve, reject) => {
    socket.once("error", (error) => { socket.close(); reject(error); });
    socket.bind(0, address, () => resolve(socket.address().port));
  });
  return {
    port,
    get arrived() { return arrived; },
    /** Waits up to the per-target deadline for a datagram that has not arrived yet. */
    async settle(): Promise<boolean> {
      if (arrived) return true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TOOL_TIMEOUT_POLICY.mxcLinuxRawIpTargetMs);
        notify = () => { clearTimeout(timer); resolve(); };
      });
      return arrived;
    },
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

/**
 * A host-side TCP listener for the arrival evidence. `control()` proves it reachable by an unconfined connect from this
 * process; every other connection it accepts, with or without a payload, is an arrival. The container's address is
 * not told apart by its source, since the backend translates it; accepts are counted instead.
 */
async function openTcpArrival(address: string) {
  const accepts: LinuxRawIpTcpAccept[] = [];
  let control: { readonly address: string; readonly port: number } | undefined;
  let notify: (() => void) | undefined;
  const isControl = (accept: (typeof accepts)[number]) => control !== undefined && accept.address === control.address
    && accept.port === control.port;
  const server = createServer((socket) => {
    accepts.push({ address: socket.remoteAddress, port: socket.remotePort });
    socket.destroy();
    notify?.();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, address, () => {
      const bound = server.address();
      if (bound === null || typeof bound === "string") reject(new Error("Invalid raw-IP arrival port"));
      else resolve(bound.port);
    });
  });
  return {
    port,
    /** Whether any connection but the control's reached the listener; one before the control is an arrival too. */
    get arrived() { return linuxRawIpTcpArrived(accepts, control); },
    /** Connects from this unconfined process and waits, up to the per-target deadline, for the listener to take it. */
    async control(): Promise<boolean> {
      await new Promise<void>((resolve) => {
        const client = connect({ host: address, port });
        const timer = setTimeout(done, TOOL_TIMEOUT_POLICY.mxcLinuxRawIpTargetMs);
        function done() { clearTimeout(timer); notify = undefined; client.destroy(); resolve(); }
        const check = () => { if (accepts.some(isControl)) done(); };
        client.once("connect", () => {
          if (client.localAddress !== undefined && client.localPort !== undefined) {
            control = { address: client.localAddress, port: client.localPort };
          }
          notify = check;
          check();
        });
        client.once("error", done);
      });
      return accepts.some(isControl);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The host-side TL, TCP arrival and UDP targets on the host's primary IPv4. A host whose address cannot be bound runs
 * none of them, so the verdict is `unknown`; it never makes the container itself unavailable.
 */
export async function openLinuxRawIpHostTargets(address: string | undefined, nonce: string) {
  if (address === undefined) return undefined;
  const opened: { close(): Promise<void> }[] = [];
  try {
    const closedPort = await closedPortOn(address);
    const tcp = await openTcpArrival(address);
    opened.push(tcp);
    const udp = await openUdpArrival(address, nonce);
    opened.push(udp);
    return { address, closedPort, tcp, udp, close: async () => { await Promise.all(opened.map((target) => target.close())); } };
  } catch (error) {
    await Promise.all(opened.map((target) => target.close()));
    log.warn(`raw-ip host targets unavailable on ${address}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    return undefined;
  }
}

/** The slirp4netns gateway, where the launcher's firewall lets the container reach its proxy. */
const SLIRP_GATEWAY = "10.0.2.2";

/**
 * Whether one address family's `iptables-restore` payload, as the pinned launcher writes it, drops every egress
 * except loopback and, for IPv4, TCP to the proxy port. Only the payload shape this launcher writes is understood:
 * any other table, chain, policy or rule, or an egress chain that does not end in DROP, is no evidence.
 */
export function linuxFirewallPayloadDrops(payload: string, family: 4 | 6, proxyPort: number): boolean {
  // Rules before the closing DROP may only accept loopback or the proxy, or drop.
  const allowed = new Set(["-o lo -j ACCEPT", "-j DROP", ...(family === 4 ? [`-p tcp -d ${SLIRP_GATEWAY} --dport ${proxyPort} -j ACCEPT`] : [])]);
  const egress: string[] = [];
  let outputJumps = 0;
  let inFilter = false;
  let committed = 0;
  for (const raw of payload.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line === "*filter" && !inFilter) { inFilter = true; continue; }
    if (!inFilter) return false;
    if (line === "COMMIT") { inFilter = false; committed += 1; continue; }
    if (line === ":MXC_EGRESS - [0:0]" || line === ":MXC_INGRESS - [0:0]" || line === "-A INPUT -j MXC_INGRESS") continue;
    if (line.startsWith("-A MXC_INGRESS ")) continue;
    if (line === "-A OUTPUT -j MXC_EGRESS") { outputJumps += 1; continue; }
    if (line.startsWith("-A MXC_EGRESS ")) { egress.push(line.slice("-A MXC_EGRESS ".length)); continue; }
    return false;
  }
  return !inFilter && committed > 0 && outputJumps === 1 && egress.at(-1) === "-j DROP"
    && egress.slice(0, -1).every((rule) => allowed.has(rule));
}

const SUPERVISOR_NAME = "mxc-bwrap-proxy-supervisor";
const STATE_DIR = /^mxc-bwrap-proxy-[A-Za-z0-9]+$/u;

async function ownedBy(path: string, kind: "directory" | "file"): Promise<boolean> {
  const stats = await lstat(path);
  return stats.uid === process.getuid?.() && (kind === "directory" ? stats.isDirectory() : stats.isFile());
}

/** The pinned launcher's network supervisor among `launcherPid`'s children, and the state folder it was handed. */
async function supervisorStateDir(launcherPid: number): Promise<string | undefined> {
  const tasks = await readdir(`/proc/${launcherPid}/task`);
  for (const task of tasks) {
    const children = (await readFile(`/proc/${launcherPid}/task/${task}/children`, "utf8")).trim().split(/\s+/u);
    for (const child of children) {
      if (!/^\d+$/u.test(child)) continue;
      const argv = (await readFile(`/proc/${child}/cmdline`, "utf8").catch(() => "")).split("\0");
      // `sh -c <script> mxc-bwrap-proxy-supervisor <state dir> ...`: the script's `$0` and `$1`.
      if (argv[1] !== "-c" || argv[3] !== SUPERVISOR_NAME) continue;
      const dir = argv[4];
      if (dir !== undefined && posix.isAbsolute(dir) && STATE_DIR.test(posix.basename(dir))) return dir;
    }
  }
  return undefined;
}

/** One family's payload files in transaction order, or undefined when the folder holds none. */
async function familyPayload(dir: string, family: 4 | 6): Promise<string | undefined> {
  const names = (await readdir(dir)).filter((name) => new RegExp(`^rules\\.v${family}\\.\\d{3}$`, "u").test(name)).sort();
  if (names.length === 0) return undefined;
  const parts: string[] = [];
  for (const name of names) {
    const path = posix.join(dir, name);
    if (!await ownedBy(path, "file")) return undefined;
    parts.push(await readFile(path, "utf8"));
  }
  return parts.join("\n");
}

/**
 * Reads the firewall the launcher programmed for this container, from the payloads its network supervisor applied,
 * once `started()` says the contained command runs (so the rules are in force). The container itself cannot read
 * them: it holds no capability in its network namespace. Anything unexpected, or the run ending first, is no evidence.
 */
export async function readLinuxLauncherFirewall(
  launcherPid: number, proxyPort: number, started: () => Promise<boolean>, ended: () => boolean,
): Promise<boolean> {
  try {
    for (;;) {
      if (ended()) return false;
      if (await started()) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const dir = await supervisorStateDir(launcherPid);
    if (dir === undefined || !await ownedBy(dir, "directory")) return false;
    const [v4, v6] = await Promise.all([familyPayload(dir, 4), familyPayload(dir, 6)]);
    return v4 !== undefined && v6 !== undefined && !ended()
      && linuxFirewallPayloadDrops(v4, 4, proxyPort) && linuxFirewallPayloadDrops(v6, 6, proxyPort);
  } catch (error) {
    log.warn(`raw-ip launcher firewall unreadable: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    return false;
  }
}

/**
 * The in-container prober: bash only, since the canary may not assume any interpreter beyond the shell. Every target
 * runs at once and each one has the per-target deadline, so the whole probe takes about one deadline. A target with
 * no result by then prints `deadline`. Results go to stdout only, which the canary sends to the prober's own file.
 * Arguments: deadline seconds, nonce, host-side target host (or "-" for none), TL port, UDP port, TCP arrival port. The
 * control CONNECT goes
 * to the container's own `HTTPS_PROXY`, which the launcher sets to the invocation listener.
 */
export const LINUX_RAW_IP_PROBER = String.raw`set -u
export LC_ALL=C
deadline=$1 nonce=$2 host=$3 closed=$4 udp=$5 arrival=$6
mkdir raw-ip.d || exit 0
result() { printf '%s %s\n' "$1" "$2" > "raw-ip.d/$1.t" && mv "raw-ip.d/$1.t" "raw-ip.d/$1"; }
failure() { local e; e=$(< "raw-ip.d/$1.err"); e=${"$"}{e##*: }; e=${"$"}{e//$'\n'/ }; result "$1" "${"$"}{e:-unclassified}"; }
tcp() { if ( exec 3<>"$2" ) 2> "raw-ip.d/$1.err"; then result "$1" 0; else failure "$1"; fi; }
datagram() { if ( printf '%s' "$nonce" > "$1" ) 2> raw-ip.d/UA.err; then result UA 0; else failure UA; fi; }
control() {
  local endpoint=${"$"}{HTTPS_PROXY:-} line status=none refused=none
  endpoint=${"$"}{endpoint#http://}; endpoint=${"$"}{endpoint%/}
  if exec 3<> "/dev/tcp/${"$"}{endpoint%:*}/${"$"}{endpoint##*:}"; then
    printf 'CONNECT %s.localhost:443 HTTP/1.1\r\nHost: %s.localhost:443\r\n\r\n' "$nonce" "$nonce" >&3
    if IFS= read -r line <&3; then
      line=${"$"}{line%$'\r'}; status=${"$"}{line#HTTP/1.? }; status=${"$"}{status%% *}
      while IFS= read -r line <&3; do
        line=${"$"}{line%$'\r'}; [ -z "$line" ] && break
        case ${"$"}{line,,} in x-ave-egress-refused:*) refused=${"$"}{line#*: } ;; esac
      done
    fi
  fi 2> /dev/null
  printf 'C status=%s refused=%s\n' "$status" "$refused" > raw-ip.d/C.t && mv raw-ip.d/C.t raw-ip.d/C
}
names="C T4 T6"
control & pids=$!
tcp T4 /dev/tcp/192.0.2.1/443 & pids="$pids $!"
tcp T6 /dev/tcp/2001:db8::1/443 & pids="$pids $!"
if [ "$host" != - ]; then
  names="$names TL TA UA"
  tcp TL "/dev/tcp/$host/$closed" & pids="$pids $!"
  tcp TA "/dev/tcp/$host/$arrival" & pids="$pids $!"
  datagram "/dev/udp/$host/$udp" & pids="$pids $!"
fi
for ((i = 0; i < deadline * 10; i++)); do
  pending=0
  for name in $names; do [ -e "raw-ip.d/$name" ] || pending=1; done
  [ "$pending" = 0 ] && break
  sleep 0.1
done
kill $pids 2> /dev/null
for name in $names; do
  if [ -e "raw-ip.d/$name" ]; then printf '%s\n' "$(< "raw-ip.d/$name")"
  elif [ "$name" = C ]; then printf 'C status=none refused=none\n'
  else printf '%s deadline\n' "$name"; fi
done
interfaces=
while IFS=: read -r name _; do
  name=${"$"}{name// /}
  case $name in Inter-*|face*|"") ;; *) interfaces="${"$"}{interfaces:+$interfaces,}$name" ;; esac
done < /proc/net/dev
printf 'IF %s\n' "$interfaces"
`;

/** The prober's arguments, in its order. */
export function linuxRawIpProberArguments(input: {
  readonly nonce: string; readonly host: string | undefined; readonly closedPort: number | undefined; readonly udpPort: number | undefined;
  readonly arrivalPort: number | undefined;
}): readonly string[] {
  return [String(TARGET_DEADLINE_S), input.nonce, input.host ?? "-", String(input.closedPort ?? 0), String(input.udpPort ?? 0),
    String(input.arrivalPort ?? 0)];
}
