// A macOS holder (MCP server, plugin child, worker, hook, offline host child) runs as one exec chain in one pid, with no
// resident supervisor: the process-group launch gate, then `/usr/bin/sandbox-exec -p <profile>`, then a three-line
// ready shim, then the holder. Its stdio is its own fds 0/1/2 on pipes to Ave. The profile ends with the holder's label
// (`holder-label-sweep.ts`), so its stop can end every process it started, including ones that left its group.
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { posix } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  observeManagedProcessGroup, spawnGatedManagedProcess, terminateManagedProcessGroup, type ConfirmedExit, type ManagedResources,
} from "../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { assertHolderSweepHelperUnchanged, runHolderSweep, type HolderSweepHelper } from "./holder-label-sweep.js";
import { MxcHolderStartRefusedError, MxcProcessCleanupError, MxcProcessContractError } from "./mxc-extension-errors.js";
import { getDefaultSensitiveWriteDenyEntries, runWithSandboxWritePreflight, seatbeltHolderFloorRows } from "./asrt-sandbox.js";
import { assertConfiguredLauncherEnvironment, buildLauncherEnvironment } from "./launcher-environment.js";
import { atOrUnder, canonicalPath, posixPathFoldsCase, posixPolicyLookups, rankPosixContainerRows, type PosixFilesystemGrants, type PosixPolicyLookups } from "./mxc-posix.js";
import { buildPolicyModel, policyGrantRow, type PolicyFloorRow, type PolicyModel } from "./policy-model.js";
import { buildSeatbeltHolderProfile, splitSeatbeltPolicyRows, type SeatbeltHolderLabels } from "./seatbelt-profile.js";
import { buildSeatbeltSandboxWritePolicy } from "./sandbox-write-policy.js";
import { getPolicyHome } from "../shared/policy-home.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const HOLDER_SHELL = "/bin/sh";
/** The first sandboxed code: one byte on fd 4 proves the profile is applied and the holder is about to be exec'd. */
export const HOLDER_READY_SHIM = 'printf "\\n" >&4 || exit 70; exec 4>&-; exec "$@"';
const PROXY_ENV_KEYS = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy"]);
const HOLDER_PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
/** The read every macOS holder starts from: the whole volume, read-only, carved around every read deny (owner O4). */
const HOLDER_READ_BASE = "/";

export class SeatbeltHolderLaunchError extends Error {
  constructor(readonly code: "cwd-ungranted" | "proxy-invalid" | "read-base-supplied" | "command-invalid" | "write-root-withheld", message: string) {
    super(message);
    this.name = "SeatbeltHolderLaunchError";
  }
}

/** Where a holder may connect: its invocation's loopback proxy, or nowhere at all. */
export type SeatbeltHolderNetwork = { readonly proxyUrl: string } | "offline";

export interface SeatbeltHolderLaunchInput {
  /** The holder executable, absolute. It is exec'd with `args`; no shell evaluates them. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Exactly the environment the holder receives, before the host's own proxy variables. */
  readonly env: Readonly<Record<string, string>>;
  /** The holder's own reads beyond the read base (its data inside the Ave home, a declared host directory). */
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  /** Reads held inside the protected read floor on purpose; a user's deny over one refuses the start. */
  readonly floorPierces?: readonly string[];
  readonly network: SeatbeltHolderNetwork;
  readonly labels: SeatbeltHolderLabels;
}

/** Everything one holder start runs with, named by one digest. Nothing of it is written to disk. */
export interface SeatbeltHolderLaunch {
  readonly profile: string;
  /** The arguments of `sandbox-exec` (`SANDBOX_EXEC`), which the launch gate execs. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly proxyPort: number | null;
  readonly labels: SeatbeltHolderLabels;
  readonly grants: PosixFilesystemGrants;
  readonly digest: string;
}

/** The floors and write-root protections of one start: captured by the host, never supplied by the caller. */
export interface SeatbeltHolderFloors {
  readonly floors: readonly PolicyFloorRow[];
  /** The write roots as the mandatory write policy narrowed them. */
  readonly allowWrite: readonly string[];
  readonly lookups: PosixPolicyLookups;
}

/** The host's floors for a start with these write roots: `seatbeltHolderFloorRows` plus the write-root protections. */
export async function captureSeatbeltHolderFloors(input: Pick<SeatbeltHolderLaunchInput, "cwd" | "writeRoots">, signal?: AbortSignal): Promise<SeatbeltHolderFloors> {
  const sensitive = getDefaultSensitiveWriteDenyEntries();
  const mandatory = await runWithSandboxWritePreflight(signal, () => buildSeatbeltSandboxWritePolicy(
    [...input.writeRoots], undefined, sensitive.map(entry => typeof entry === "string" ? entry : entry.path)));
  // A shell reports a withheld root beside its result; a holder has no result, and running it without a root it was
  // admitted to write would fail later and opaquely, so the start is refused by name.
  if (mandatory.narrowedWriteRoots.length > 0) {
    throw new SeatbeltHolderLaunchError("write-root-withheld", `Container holder write roots could not be protected: ${
      mandatory.narrowedWriteRoots.map(({ root, reason }) => `${root} (${reason})`).join(", ")}`);
  }
  const home = getPolicyHome();
  const lookups = posixPolicyLookups(home, false);
  const foldsCase = [home, input.cwd, ...mandatory.allowWrite].every(path => posixPathFoldsCase(lookups.canonical(path)));
  return {
    floors: Object.freeze([...seatbeltHolderFloorRows(), ...mandatory.literalRows, ...mandatory.patternRows]),
    allowWrite: Object.freeze([...mandatory.allowWrite]),
    lookups: { ...lookups, foldsCase },
  };
}

function proxyPortOf(network: SeatbeltHolderNetwork): number | null {
  if (network === "offline") return null;
  const port = Number(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(network.proxyUrl)?.[1]);
  if (!Number.isInteger(port) || port > 65535) throw new SeatbeltHolderLaunchError("proxy-invalid", "Container proxy must be an IPv4 loopback listener");
  return port;
}

// The launch gate and the ready shim are `/bin/sh`, which on macOS is bash: a startup variable or an exported function
// would run before the sandbox exists, so the configured environment is checked here, where no caller can skip it.
function holderEnvironment(env: Readonly<Record<string, string>>, network: SeatbeltHolderNetwork): Record<string, string> {
  const configured: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (PROXY_ENV_KEYS.has(key.toLowerCase()) || key === "SHLVL") continue;
    configured[key] = value;
  }
  const { PATH: _path, ...checked } = configured;
  assertConfiguredLauncherEnvironment(checked);
  const launcher = buildLauncherEnvironment("darwin");
  const result: Record<string, string> = { ...launcher, ...configured, SHLVL: launcher.SHLVL as string };
  if (network !== "offline") for (const key of HOLDER_PROXY_KEYS) result[key] = network.proxyUrl;
  return result;
}

function launchDigest(launch: Omit<SeatbeltHolderLaunch, "digest" | "grants" | "labels">): string {
  const env = Object.entries(launch.env).toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([launch.profile, launch.argv, env, launch.cwd, launch.proxyPort])).digest("hex");
}

/** The digest of a launch record as it is now: the recheck before release compares it with the admitted one. */
export function seatbeltHolderLaunchDigest(launch: SeatbeltHolderLaunch): string {
  return launchDigest(launch);
}

/**
 * A holder's launch from Ave rows. The builder, not the caller, adds the read base, every floor and the label; a caller
 * that supplies the read base is refused, and rows cannot render a label rule. Offline holders get no network rule and
 * no proxy variable.
 */
export function composeSeatbeltHolderLaunch(input: SeatbeltHolderLaunchInput, host: SeatbeltHolderFloors): SeatbeltHolderLaunch {
  const { lookups } = host;
  if (!posix.isAbsolute(input.command) || input.command.includes("\0") || input.args.some(arg => arg.includes("\0"))) {
    throw new SeatbeltHolderLaunchError("command-invalid", "Container holder executable must be an absolute path");
  }
  for (const root of [...input.readRoots, ...input.writeRoots, ...(input.floorPierces ?? [])]) {
    if (canonicalPath(root, true, lookups) === HOLDER_READ_BASE) {
      throw new SeatbeltHolderLaunchError("read-base-supplied", "A holder's read base is added by its launch builder, not by its caller");
    }
  }
  const proxyPort = proxyPortOf(input.network);
  const model: PolicyModel = buildPolicyModel({
    floors: host.floors,
    userGrants: [],
    extensionManifests: [],
    launchGrants: [
      ...host.allowWrite.map(path => policyGrantRow(path, "rw", "launch-grant", false)),
      ...input.readRoots.map(path => policyGrantRow(path, "ro", "launch-grant", false)),
      ...(input.floorPierces ?? []).map(path => policyGrantRow(path, "ro", "floor-pierce", false)),
      policyGrantRow(HOLDER_READ_BASE, "ro", "launch-grant", true),
    ],
  });
  const grants = rankPosixContainerRows(splitSeatbeltPolicyRows(model).literalModel, "seatbelt", lookups);
  const cwd = canonicalPath(input.cwd, true, lookups);
  const coversCwd = (root: string) => atOrUnder(cwd, root, lookups.foldsCase);
  const inChain = grants.chainFolders.some(root => coversCwd(root) && atOrUnder(root, cwd, lookups.foldsCase));
  if (!lookups.exists(cwd) || grants.denied.some(coversCwd)
    || (!inChain && ![...grants.readonly, ...grants.readwrite].some(coversCwd))) {
    throw new SeatbeltHolderLaunchError("cwd-ungranted", `Container holder working directory is outside its filesystem grants: ${cwd}`);
  }
  const profile = buildSeatbeltHolderProfile({ model, grants, lookups, unixSocketRoots: [], proxyPort, labels: input.labels });
  const env = Object.freeze(holderEnvironment(input.env, input.network));
  const argv = Object.freeze(["-p", profile, HOLDER_SHELL, "-c", HOLDER_READY_SHIM, "ave-holder", input.command, ...input.args]);
  const record = { profile, argv, env, cwd, proxyPort };
  return Object.freeze({ ...record, labels: input.labels, grants, digest: launchDigest(record) });
}

/** Capture the host's floors for this start and compose its launch. */
export async function buildSeatbeltHolderLaunch(input: SeatbeltHolderLaunchInput, signal?: AbortSignal): Promise<SeatbeltHolderLaunch> {
  return composeSeatbeltHolderLaunch(input, await captureSeatbeltHolderFloors(input, signal));
}

// ---------------------------------------------------------------------------------------------------------------------
// The programs of the chain: constant, root-owned paths, measured at the boot check and compared at every start.

const SELECTED_SHELL = "/private/var/select/sh";
const SELECTED_SHELL_TARGETS = new Set(["/bin/bash", "/bin/dash", "/bin/zsh"]);

interface LauncherFile {
  readonly path: string;
  readonly sha256: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** `sandbox-exec`, `/bin/sh` and the interpreter `/private/var/select/sh` names, as the boot check found them. */
export interface SeatbeltHolderLaunchers {
  readonly files: readonly LauncherFile[];
}

function measureLauncher(path: string): LauncherFile {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.uid !== 0n || (Number(stat.mode) & 0o022) !== 0) {
    throw new MxcHolderStartRefusedError("integrity", `${path} is not a root-owned file nobody else can write`);
  }
  return {
    path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
  };
}

export function measureSeatbeltHolderLaunchers(): SeatbeltHolderLaunchers {
  const selected = readlinkSync(SELECTED_SHELL);
  if (!SELECTED_SHELL_TARGETS.has(selected) || lstatSync(SELECTED_SHELL, { bigint: true }).uid !== 0n) {
    throw new MxcHolderStartRefusedError("integrity", `${SELECTED_SHELL} does not name a system shell`);
  }
  return Object.freeze({ files: Object.freeze([SANDBOX_EXEC, HOLDER_SHELL, selected].map(measureLauncher)) });
}

export function assertSeatbeltHolderLaunchersUnchanged(launchers: SeatbeltHolderLaunchers): void {
  const now = measureSeatbeltHolderLaunchers();
  const same = now.files.length === launchers.files.length && now.files.every((file, index) => {
    const was = launchers.files[index] as LauncherFile;
    return file.path === was.path && file.sha256 === was.sha256 && file.dev === was.dev && file.ino === was.ino
      && file.size === was.size && file.mtimeNs === was.mtimeNs && file.ctimeNs === was.ctimeNs;
  });
  if (!same) throw new MxcHolderStartRefusedError("integrity", "a launcher of the holder chain changed since boot");
}

// ---------------------------------------------------------------------------------------------------------------------
// Start and stop.

/** The holder's own streams; Ave reads and writes them directly. */
export interface SeatbeltHolderProcess {
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** The holder's exit after it started. A stdin write that failed because it had exited never replaces this. */
  readonly completion: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

export interface SeatbeltHolder {
  readonly process: SeatbeltHolderProcess;
  readonly confinement: "macos-seatbelt";
  readonly labels: SeatbeltHolderLabels;
  /** Group stop, then the label sweep. Resolves with the receipt only when both were verified. */
  dispose(reason?: string): Promise<ConfirmedExit>;
}

export interface SeatbeltHolderEgress {
  release(): void;
  /** Opened with `holdPortAfterRelease`: closed on a verified stop, held refusing until quit otherwise. */
  readonly lease?: { close(): Promise<void> };
}

export interface StartSeatbeltHolderOptions {
  readonly label: string;
  readonly helper: HolderSweepHelper;
  readonly launchers: SeatbeltHolderLaunchers;
  /** The digest admitted for this launch; the recheck refuses a record that differs from it. */
  readonly admittedDigest: string;
  /** The row-2 recheck. It runs synchronously after the group is registered and before the release byte. */
  readonly assertStillValid: () => void;
  readonly egress?: SeatbeltHolderEgress;
  /** Aborted when the holder's admission is revoked after the gate released it: the start stops it and refuses, instead
   * of waiting for the ready byte. The caller's post-start recheck covers a revocation after the ready byte. */
  readonly revoked?: AbortSignal;
  readonly resources?: ManagedResources;
  readonly startMs?: number;
}

/** Leases whose holder stop was not verified: bound and refusing until Ave quits. */
const heldUnverifiedLeases = new Set<{ close(): Promise<void> }>();

export function heldUnverifiedHolderLeaseCount(): number {
  return heldUnverifiedLeases.size;
}

/** Quit: every held lease closes with the app. */
export async function closeHeldHolderLeases(): Promise<void> {
  const leases = [...heldUnverifiedLeases];
  heldUnverifiedLeases.clear();
  await Promise.allSettled(leases.map(lease => lease.close()));
}

const DIAGNOSTIC_BYTES = 4 * 1024;
const EXIT_PROFILE_REJECTED = 65;
const EXIT_SHIM_NOT_EXECUTED = 71;

type StartObservation =
  | { readonly kind: "ready" }
  | { readonly kind: "closed"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: "stalled" }
  | { readonly kind: "revoked" };

function startRefusal(code: number | null, signal: NodeJS.Signals | null, diagnostic: string): MxcHolderStartRefusedError {
  if (code === EXIT_PROFILE_REJECTED) return new MxcHolderStartRefusedError("request-rejected", diagnostic || "the kernel refused the profile");
  const what = code === EXIT_SHIM_NOT_EXECUTED ? "sandbox-exec could not run the ready shim" : `the launch ended before the holder started (${signal ?? `exit ${code}`})`;
  return new MxcHolderStartRefusedError("holder-start-failed", diagnostic ? `${what}: ${diagnostic}` : what);
}

/**
 * Start one holder through the launch gate and `sandbox-exec`. It is started only once the ready byte arrives from
 * inside the sandbox; a start that ends or stalls before that is stopped, swept, and refused with no fallback route.
 */
export async function startSeatbeltHolder(launch: SeatbeltHolderLaunch, options: StartSeatbeltHolderOptions): Promise<SeatbeltHolder> {
  // Every holder profile allows its instance's label, so no holder may run while the boot sweep could see it.
  await holderBootSequence;
  return startSeatbeltHolderNow(launch, options);
}

let holderBootSequence: Promise<unknown> | undefined;

/** Boot: holder starts wait on this sequence (boot check, boot sweep, watcher start) and never race it. */
export function gateSeatbeltHolderStartsOn(sequence: Promise<unknown>): void {
  if (holderBootSequence !== undefined) throw new Error("The holder boot sequence was already gated this app run");
  holderBootSequence = sequence.then(() => undefined, () => undefined);
}

// @internal — test teardown only.
export function __resetSeatbeltHolderBootGateForTest(): void {
  holderBootSequence = undefined;
}

/** The boot check's own canaries start here: they are part of the sequence the gate waits on. */
export async function startSeatbeltHolderNow(launch: SeatbeltHolderLaunch, options: StartSeatbeltHolderOptions): Promise<SeatbeltHolder> {
  assertSeatbeltHolderLaunchersUnchanged(options.launchers);
  assertHolderSweepHelperUnchanged(options.helper);
  let observed: ReturnType<typeof observeManagedProcessGroup> | undefined;
  let spawned: ChildProcess | undefined;
  const child = await spawnGatedManagedProcess(SANDBOX_EXEC, launch.argv, {
    cwd: launch.cwd, env: { ...launch.env }, stdio: ["pipe", "pipe", "pipe", "ignore", "pipe"],
  }, {
    label: options.label,
    onSpawn: (started) => {
      spawned = started;
      observed = observeManagedProcessGroup(started, options.resources);
      // A write after the holder exited fails with EPIPE; the exit result stands (the caller reads `completion`).
      started.stdin?.on("error", () => {});
    },
    assertStillValid: () => {
      options.assertStillValid();
      if (seatbeltHolderLaunchDigest(launch) !== options.admittedDigest) {
        throw new MxcProcessContractError("Container holder launch changed after admission");
      }
    },
  }).catch(async (error: unknown) => {
    // Nothing passed the gate. Its shell was killed by the gate; wait for its group so the owner can release.
    if (spawned !== undefined && observed !== undefined) await observed.confirmExit("holder launch gate refused");
    throw error;
  });
  const exit = observed as ReturnType<typeof observeManagedProcessGroup>;
  const streamsClosed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
  // The holder's own exit, then its output's tail: every consumer of `completion` reads the whole output, and a
  // descendant that keeps stdout open delays it by the bounded drain only.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => resolve({ code, signal }));
  }).then(async (result) => {
    await Promise.race([streamsClosed, sleep(TOOL_TIMEOUT_POLICY.mxcMacHolderOutputDrainMs, undefined, { ref: false })]);
    return result;
  });
  let diagnostic = "";
  const onDiagnostic = (chunk: Buffer): void => {
    if (diagnostic.length < DIAGNOSTIC_BYTES) diagnostic += chunk.toString("utf8").slice(0, DIAGNOSTIC_BYTES - diagnostic.length);
  };
  // The start reads stderr for its refusal diagnostic, which puts the stream in flowing mode. The holder's consumer reads
  // this buffer instead, so nothing the holder writes between the ready byte and the consumer's first read is dropped.
  const stderr = new PassThrough();
  child.stderr?.pipe(stderr);
  child.stderr?.on("data", onDiagnostic);
  const ready = child.stdio[4] as Readable;
  const observation = await new Promise<StartObservation>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "stalled" }), options.startMs ?? TOOL_TIMEOUT_POLICY.mxcMacHolderStartMs);
    timer.unref?.();
    const onRevoked = (): void => { clearTimeout(timer); resolve({ kind: "revoked" }); };
    ready.once("data", () => { clearTimeout(timer); options.revoked?.removeEventListener("abort", onRevoked); resolve({ kind: "ready" }); });
    void closed.then(({ code, signal }) => { clearTimeout(timer); options.revoked?.removeEventListener("abort", onRevoked); resolve({ kind: "closed", code, signal }); });
    if (options.revoked?.aborted) onRevoked();
    else options.revoked?.addEventListener("abort", onRevoked, { once: true });
  });
  ready.destroy();
  child.stderr?.off("data", onDiagnostic);

  let disposing: Promise<ConfirmedExit> | undefined;
  const dispose = (reason = "holder released"): Promise<ConfirmedExit> => disposing ??= (async () => {
    options.egress?.release();
    terminateManagedProcessGroup(child, TOOL_TIMEOUT_POLICY.mxcMacHolderTermGraceMs);
    await Promise.race([exit.wait(), sleep(TOOL_TIMEOUT_POLICY.mxcMacHolderTermGraceMs, undefined, { ref: false })]);
    // A process that left the group may still hold the holder's stdout; the group check must not wait on it. The tail
    // of the output gets a bounded drain, then Ave lets go of the streams.
    await Promise.race([streamsClosed, sleep(TOOL_TIMEOUT_POLICY.mxcMacHolderOutputDrainMs, undefined, { ref: false })]);
    for (const stream of [child.stdin, child.stdout, child.stderr, stderr]) stream?.destroy();
    const receipt = await exit.confirmExit(reason);
    const sweep = await runHolderSweep(options.helper, "sweep", launch.labels.holder, TOOL_TIMEOUT_POLICY.mxcMacHolderSweepMs);
    if (receipt !== undefined && sweep.verified) {
      await options.egress?.lease?.close();
      return receipt;
    }
    if (options.egress?.lease) heldUnverifiedLeases.add(options.egress.lease);
    const why = receipt === undefined ? "its process group did not end" : sweep.verified ? "" : sweep.reason;
    throw new MxcProcessCleanupError(`Container holder stopped, cleanup unverified: ${why}`);
  })();

  if (observation.kind !== "ready") {
    // A refused start still runs the sweep: something may have started between the profile and the failure.
    await dispose(observation.kind === "stalled" ? "holder start stalled" : observation.kind === "revoked" ? "holder start revoked" : "holder start refused");
    if (observation.kind === "revoked") throw new MxcProcessContractError("Container holder admission was revoked during its start");
    if (observation.kind === "stalled") throw new MxcHolderStartRefusedError("holder-start-failed", "the holder did not start in time");
    throw startRefusal(observation.code, observation.signal, diagnostic.trim());
  }
  const holderProcess: SeatbeltHolderProcess = Object.freeze({
    pid: child.pid as number,
    stdin: child.stdin as Writable,
    stdout: child.stdout as Readable,
    stderr,
    completion: closed,
  });
  return Object.freeze({ process: holderProcess, confinement: "macos-seatbelt" as const, labels: launch.labels, dispose });
}
