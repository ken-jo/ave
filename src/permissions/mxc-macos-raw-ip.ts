import { createLogger } from "../lib/logger.js";
import type { MacRawIpUnknownReason, MacRawIpVerdict, MxcRawIpTarget, MxcRawIpUdpArrival } from "../shared/sandbox-capability-info.js";

/**
 * Raw-IP measurement for the macOS shell container, by the verdict rules shared with Windows. The boot canary runs the
 * prober below inside a real container started the way a user shell starts; the host classifies what it printed.
 * Nothing here is persisted: the verdict lives in memory for this boot only.
 */

const log = createLogger("mxc-macos-raw-ip");

/** Per-target deadline and the whole probe's budget. */
export const RAW_IP_TARGET_DEADLINE_S = 3;
export const RAW_IP_PROBE_BUDGET_S = 12;

/** The documentation-range targets: an IPv4 and an IPv6 address no host answers for. */
const RAW_IP_T4 = { host: "192.0.2.1", port: 443 } as const;
const RAW_IP_T6 = { host: "2001:db8::1", port: 443 } as const;

type RawIpTargetClass = "refused-local" | "allowed" | "inconclusive";
type InconclusiveKind = "no-route" | "timeout" | "unclassified";
export interface RawIpTargetResult {
  readonly class: RawIpTargetClass;
  /** Why an inconclusive target was inconclusive. */
  readonly kind?: InconclusiveKind;
}

// macOS column of the rules. EPERM/EACCES are Seatbelt's own refusal; 0 or ECONNREFUSED means the packet reached a peer.
const MACOS_CODES = {
  refusedLocal: new Set(["1", "13"]),
  allowed: new Set(["0", "61"]),
  noRoute: new Set(["51", "65", "49", "47"]),
  timeout: new Set(["60", "deadline"]),
} as const;

/** One printed result (`<numeric errno> | 0 | deadline | nosocket`, or nothing) as the rules classify it on macOS. */
export function classifyRawIpTarget(result: string | undefined): RawIpTargetResult {
  if (result === undefined || !/^(?:\d{1,5}|deadline|nosocket)$/u.test(result)) return { class: "inconclusive", kind: "unclassified" };
  if (MACOS_CODES.refusedLocal.has(result)) return { class: "refused-local" };
  if (MACOS_CODES.allowed.has(result)) return { class: "allowed" };
  if (MACOS_CODES.noRoute.has(result)) return { class: "inconclusive", kind: "no-route" };
  if (MACOS_CODES.timeout.has(result)) return { class: "inconclusive", kind: "timeout" };
  return { class: "inconclusive", kind: "unclassified" };
}

/** What the prober printed, one value per target name; a missing or malformed line is absent. */
export interface RawIpProbeOutput {
  readonly control?: { readonly status: string; readonly refusal: string };
  readonly targets: Readonly<Partial<Record<"T4" | "T6" | "TL" | "UA", string>>>;
}

export function parseRawIpProbeOutput(text: string): RawIpProbeOutput {
  const targets: Partial<Record<"T4" | "T6" | "TL" | "UA", string>> = {};
  let control: RawIpProbeOutput["control"];
  for (const line of text.split("\n")) {
    const [, name, value] = /^(T4|T6|TL|UA) (\S+)$/u.exec(line) ?? [];
    if (name !== undefined && value !== undefined && targets[name as "T4"] === undefined) targets[name as "T4"] = value;
    const [, status, refusal] = /^C status=(\S+) refused=(.*)$/u.exec(line) ?? [];
    if (status !== undefined && refusal !== undefined && control === undefined) control = { status, refusal };
  }
  return control === undefined ? { targets } : { control, targets };
}

/**
 * Structural IPv6 evidence for macOS: the Ave-generated profile denies by default and its only outbound network allow
 * is the invocation proxy port on loopback. Read from the exact profile text staged for the probe run.
 */
export function seatbeltProfileAllowsOnlyProxyEgress(profile: string, proxyPort: number): boolean {
  const lines = profile.split("\n").map((line) => line.trim());
  if (!lines.includes("(deny default)")) return false;
  const allows = lines.filter((line) => line.startsWith("(allow") && /network/u.test(line));
  return allows.length === 1 && allows[0] === `(allow network-outbound (remote ip "localhost:${proxyPort}"))`;
}

export interface RawIpMeasurement {
  /** False when the probe did not run in a proven container (the shell canary did not pass). */
  readonly ran: boolean;
  readonly output?: RawIpProbeOutput;
  /** The refusal status the invocation listener answers with, from the listener module. */
  readonly expectedStatus: number;
  /** The host-side listener recorded a refusal whose destination carries this run's nonce. */
  readonly nonceRecorded: boolean;
  /** TL ran: the host had a primary non-loopback IPv4 to aim at. */
  readonly tlRan: boolean;
  /** What the host-side UDP listener saw of the nonce: `unmeasured` when nothing was sent or the listener failed. */
  readonly udpArrival: MxcRawIpUdpArrival;
  /** The staged profile is a default deny whose only outbound allow is the proxy port. */
  readonly structuralIpv6: boolean;
}

/** The verdict, in the rules' order. `blocked` needs this boot's measurement with the control passed. */
export function rawIpVerdict(measurement: RawIpMeasurement): MacRawIpVerdict {
  const { output, udpArrival } = measurement;
  const t4 = classifyRawIpTarget(output?.targets.T4);
  const t6 = classifyRawIpTarget(output?.targets.T6);
  const tl = measurement.tlRan ? classifyRawIpTarget(output?.targets.TL) : undefined;
  const reachableTargets: (MxcRawIpTarget | "udp")[] = output === undefined ? []
    : ([["t4", t4], ["t6", t6], ["tl", tl]] as const).filter(([, result]) => result?.class === "allowed").map(([name]) => name);
  const unknown = (reason: MacRawIpUnknownReason): MacRawIpVerdict => ({ rawIp: "unknown", reason, reachableTargets, udpArrival });
  // A datagram that arrived is reachable whatever else the run printed.
  if (udpArrival === "arrived") {
    reachableTargets.push("udp");
    log.warn(`raw-ip-reachable (${reachableTargets.join(", ")})`);
    return unknown("raw-ip-reachable");
  }
  // Rule 1: probe not run, or nothing printed, or the control did not pass on both sides.
  if (!measurement.ran || output === undefined) return unknown("no-evidence");
  const control = output.control;
  if (control === undefined && Object.keys(output.targets).length === 0) return unknown("no-evidence");
  if (control === undefined || control.status !== String(measurement.expectedStatus) || control.refusal === "none"
    || control.refusal === "" || !measurement.nonceRecorded) return unknown("control-failed");
  // Rule 2: anything that reached a peer by TCP.
  if (reachableTargets.length > 0) {
    log.warn(`raw-ip-reachable (${reachableTargets.join(", ")})`);
    return unknown("raw-ip-reachable");
  }
  // Owner ruling: with no IPv6 route, the profile's default deny is structural evidence for T6.
  const t6Structural = t6.class === "inconclusive" && t6.kind === "no-route" && measurement.structuralIpv6;
  // Rule 3. As on Windows, a datagram nobody measured leaves `blocked` unproved.
  if (t4.class === "refused-local" && (t6.class === "refused-local" || t6Structural) && tl !== undefined) {
    if (udpArrival === "unmeasured") return unknown("udp-unmeasured");
    const evidenceKind = t6.class === "refused-local" ? "measured" : "structural";
    log.info(`raw-ip blocked, evidence ${evidenceKind}`);
    return { rawIp: "blocked", reason: "blocked", evidenceKind, reachableTargets, udpArrival };
  }
  // Rule 4.
  if (tl === undefined) return unknown("no-evidence");
  const inconclusive = [t4, t6, tl].filter((result) => result.class === "inconclusive");
  if (inconclusive.some((result) => result.kind === "timeout")) return unknown("timeout");
  if (t4.kind === "no-route" || tl.kind === "no-route") return unknown("no-route");
  if (t6.kind === "no-route") return unknown("ipv6-unmeasured");
  return unknown("unclassified");
}

/**
 * The shell lines that run the prober in the background under a watchdog. The prober bounds each target itself; the
 * watchdog bounds the whole run, so a stalled prober is cut off before the canary's own deadline and only its missing
 * lines say so. `prober` is the command, already quoted; `output` the quoted file its stdout goes to.
 *
 * The watchdog is one process, a Perl wait that kills the prober when it fires, so killing it once the prober returns
 * ends the wait itself. A `( sleep; kill )` subshell would leave its sleep running after the subshell was killed.
 */
export function rawIpProbeShellLines(input: { readonly prober: string; readonly output: string; readonly watchdogSeconds: string }): string[] {
  if (!/^\d+(?:\.\d+)?$/u.test(input.watchdogSeconds)) throw new Error(`Invalid raw-IP watchdog delay: ${input.watchdogSeconds}`);
  return [
    `${input.prober} > ${input.output} 2>/dev/null &`,
    "prober=$!",
    `/usr/bin/perl -e 'select(undef, undef, undef, shift); kill 9, shift' ${input.watchdogSeconds} "$prober" >/dev/null 2>&1 &`,
    "watcher=$!",
    'wait "$prober" 2>/dev/null',
    'kill "$watcher" 2>/dev/null',
  ];
}

/**
 * The in-container prober: core-Perl sockets, one process, sequential targets with a per-target deadline inside one
 * overall budget. It prints numeric codes only; the container decides nothing. Arguments: proxy port, nonce, TL host
 * (or "-" for none), TL port, UDP host, UDP port.
 */
export const RAW_IP_PROBER = String.raw`use strict; use Socket qw(:DEFAULT inet_pton pack_sockaddr_in6); use Errno; use Fcntl;
my ($proxy,$nonce,$tlhost,$tlport,$udphost,$udpport)=@ARGV; my $end=time()+${RAW_IP_PROBE_BUDGET_S};
sub left { my $l=$end-time(); $l=${RAW_IP_TARGET_DEADLINE_S} if $l>${RAW_IP_TARGET_DEADLINE_S}; return $l<0?0:$l; }
sub addr { my ($fam,$host,$port)=@_; return $fam==6 ? (AF_INET6, pack_sockaddr_in6($port, inet_pton(AF_INET6,$host))) : (AF_INET, pack_sockaddr_in($port, inet_aton($host))); }
sub tcp { my ($fam,$host,$port)=@_; my ($d,$a)=addr($fam,$host,$port);
  socket(my $s,$d,SOCK_STREAM,0) or return ("nosocket",undef);
  fcntl($s,F_SETFL,fcntl($s,F_GETFL,0)|O_NONBLOCK);
  return ("0",$s) if connect($s,$a); return (($!+0),undef) unless $!{EINPROGRESS};
  my $w=''; vec($w,fileno($s),1)=1; return ("deadline",undef) unless select(undef,$w,undef,left());
  my $e=unpack('i',getsockopt($s,SOL_SOCKET,SO_ERROR)); return ("$e",$e==0?$s:undef); }
{ my ($r,$s)=tcp(4,"127.0.0.1",$proxy); my ($st,$h)=("none","none");
  if ($s) { fcntl($s,F_SETFL,fcntl($s,F_GETFL,0)&~O_NONBLOCK);
    syswrite($s,"CONNECT $nonce.localhost:443 HTTP/1.1\r\nHost: $nonce.localhost:443\r\n\r\n"); my $b='';
    while (length($b)<8192) { my $rd=''; vec($rd,fileno($s),1)=1; last unless select($rd,undef,undef,left()); my $n=sysread($s,my $c,4096); last unless $n; $b.=$c; last if $b=~/\r\n\r\n/; }
    ($st)=$b=~/^HTTP\/1\.[01] (\d{3})/; ($h)=$b=~/\r\nx-ave-egress-refused: ([^\r\n]+)/i; $st//='none'; $h//='none'; }
  print "C status=$st refused=$h\n"; }
{ my ($r)=tcp(4,"${RAW_IP_T4.host}",${RAW_IP_T4.port}); print "T4 $r\n"; }
{ my ($r)=tcp(6,"${RAW_IP_T6.host}",${RAW_IP_T6.port}); print "T6 $r\n"; }
if ($tlhost ne "-") { my ($r)=tcp(4,$tlhost,$tlport); print "TL $r\n"; }
if ($udphost ne "-") { my ($d,$a)=addr(4,$udphost,$udpport); if (socket(my $s,$d,SOCK_DGRAM,0)) { if (connect($s,$a)) { my $n=send($s,"$nonce",0); print "UA ".(defined $n?0:($!+0))."\n"; } else { print "UA ".($!+0)."\n"; } } else { print "UA nosocket\n"; } }
`;
