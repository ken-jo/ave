import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { createLogger } from "../lib/logger.js";
import type { ContainerRawIpUnknownReason, ContainerRawIpVerdict } from "../shared/sandbox-capability-info.js";
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

// Linux column of the rules. The prober is plain bash, which reports a failed connect by its C-locale message, not
// its number. EPERM/EACCES are a local policy refusal; a connect, or ECONNREFUSED, means the packet reached a peer.
const LINUX_RESULTS = {
  refusedLocal: new Set(["Operation not permitted", "Permission denied"]),
  allowed: new Set(["0", "Connection refused"]),
  noRoute: new Set([
    "Network is unreachable", "No route to host", "Cannot assign requested address", "Address family not supported by protocol",
  ]),
  timeout: new Set(["Connection timed out", "deadline"]),
} as const;

/** One printed result (`0`, `deadline`, or the C-locale error message), as the rules classify it on Linux. */
export function classifyLinuxRawIpTarget(result: string | undefined): RawIpTargetResult {
  if (result === undefined) return { class: "inconclusive", kind: "unclassified" };
  if (LINUX_RESULTS.refusedLocal.has(result)) return { class: "refused-local" };
  if (LINUX_RESULTS.allowed.has(result)) return { class: "allowed" };
  if (LINUX_RESULTS.noRoute.has(result)) return { class: "inconclusive", kind: "no-route" };
  if (LINUX_RESULTS.timeout.has(result)) return { class: "inconclusive", kind: "timeout" };
  return { class: "inconclusive", kind: "unclassified" };
}

type RawIpTargetName = "T4" | "T6" | "TL" | "UA";

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
    const [, name, value] = /^(T4|T6|TL|UA) (\S.*)$/u.exec(line) ?? [];
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
  readonly output?: LinuxRawIpProbeOutput;
  /** The refusal status the invocation listener answers with, from the listener module. */
  readonly expectedStatus: number;
  /** The host-side listener recorded a refusal whose destination carries this run's nonce. */
  readonly nonceRecorded: boolean;
  /** TL ran: the host had a primary non-loopback IPv4 to aim at. */
  readonly tlRan: boolean;
  /** The UDP nonce reached the host-side listener. */
  readonly udpArrived: boolean;
}

function unknown(reason: ContainerRawIpUnknownReason): ContainerRawIpVerdict {
  return { verdict: "unknown", reason };
}

/** The verdict, in the rules' order. `blocked` needs this boot's measurement with the control passed. */
export function linuxRawIpVerdict(measurement: LinuxRawIpMeasurement): ContainerRawIpVerdict {
  const { output } = measurement;
  // Rule 1: probe not run, nothing printed, or the control did not pass on both sides.
  if (!measurement.ran || output === undefined) return unknown("no-evidence");
  const control = output.control;
  if (control === undefined && Object.keys(output.targets).length === 0) return unknown("no-evidence");
  if (control === undefined || control.status !== String(measurement.expectedStatus) || control.refusal === "none"
    || control.refusal === "" || !measurement.nonceRecorded) return unknown("control-failed");
  const t4 = classifyLinuxRawIpTarget(output.targets.T4);
  const t6 = classifyLinuxRawIpTarget(output.targets.T6);
  const tl = measurement.tlRan ? classifyLinuxRawIpTarget(output.targets.TL) : undefined;
  // Rule 2: anything that reached a peer, by TCP or by the UDP arrival check.
  const reached = ([["T4", t4], ["T6", t6], ["TL", tl]] as const).filter(([, result]) => result?.class === "allowed")
    .map(([name]) => name as string);
  if (measurement.udpArrived) reached.push("udp");
  if (reached.length > 0) {
    log.warn(`raw-ip-reachable (${reached.join(", ")})`);
    return unknown("raw-ip-reachable");
  }
  // Owner ruling: with no IPv6 route, a network namespace holding nothing but `lo` is structural evidence for T6.
  const onlyLoopback = output.interfaces !== undefined && output.interfaces.length === 1 && output.interfaces[0] === "lo";
  const t6Structural = t6.class === "inconclusive" && t6.kind === "no-route" && onlyLoopback;
  // Rule 3.
  if (t4.class === "refused-local" && (t6.class === "refused-local" || t6Structural) && tl !== undefined) {
    const evidence = t6.class === "refused-local" ? "measured" : "structural";
    log.info(`raw-ip blocked, evidence ${evidence}`);
    return { verdict: "blocked", evidence };
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
 * The host-side TL and UDP targets on the host's primary IPv4. A host whose address cannot be bound runs neither, so
 * the verdict is `unknown`; it never makes the container itself unavailable.
 */
export async function openLinuxRawIpHostTargets(address: string | undefined, nonce: string) {
  if (address === undefined) return undefined;
  try {
    const closedPort = await closedPortOn(address);
    const udp = await openUdpArrival(address, nonce);
    return { address, closedPort, udp };
  } catch (error) {
    log.warn(`raw-ip host targets unavailable on ${address}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    return undefined;
  }
}

/**
 * The in-container prober: bash only, since the canary may not assume any interpreter beyond the shell. Every target
 * runs at once and each one has the per-target deadline, so the whole probe takes about one deadline. A target with
 * no result by then prints `deadline`. Results go to stdout only, which the canary sends to the prober's own file.
 * Arguments: deadline seconds, nonce, TL and UDP host (or "-" for none), TL port, UDP port. The control CONNECT goes
 * to the container's own `HTTPS_PROXY`, which the launcher sets to the invocation listener.
 */
export const LINUX_RAW_IP_PROBER = String.raw`set -u
export LC_ALL=C
deadline=$1 nonce=$2 host=$3 closed=$4 udp=$5
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
  names="$names TL UA"
  tcp TL "/dev/tcp/$host/$closed" & pids="$pids $!"
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
}): readonly string[] {
  return [String(TARGET_DEADLINE_S), input.nonce, input.host ?? "-", String(input.closedPort ?? 0), String(input.udpPort ?? 0)];
}
