import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import {
  type ConfirmedExit, type ManagedResources, observeManagedProcessGroup, spawnGatedManagedProcess,
} from "../main/managed-child-processes.js";
import { parseProcStat } from "../main/terminal/shell-process.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { MxcHolderStartRefusedError, MxcProcessCleanupError, MxcProcessContractError } from "./mxc-extension-errors.js";
import { measurePosixExecutableIdentity } from "./holder-admission-darwin.js";
import { currentMxcRuntimeHost } from "./mxc-runtime-root.js";

/**
 * The translation step of a Linux extension holder (design 1.3). The pinned launcher turns Ave's request into one
 * bwrap call. Ave runs the launcher with a capture folder first on its PATH, whose `bwrap` is the filter helper:
 * invoked under that name, it writes the call to a socket Ave inherited to the launcher and exits without running
 * it. Ave checks the record's structure here, before anything runs, and later replays it with the system bwrap.
 */

/** The descriptor the launcher inherits from Ave and its `bwrap` writes the record to. */
const CAPTURE_FD = 9;
/** The most bytes a record may hold: the call's words and two small data descriptors. */
const RECORD_LIMIT = 4 * 1024 * 1024;
const RECORD_MAGIC = Buffer.from("AVEBWRAP");

/** A translation refused before anything ran: `request-rejected`, with the named cause and no fallback. */
class LinuxHolderRequestRejected extends MxcHolderStartRefusedError {
  constructor(cause: string) {
    super("request-rejected", cause);
    this.name = "LinuxHolderRequestRejected";
  }
}

class LinuxCaptureFolderUntrusted extends Error {
  readonly code = "capture-folder-untrusted";

  constructor(readonly path: string, reason: string) {
    super(`Linux bwrap capture folder ${JSON.stringify(path)} is not trusted: ${reason}`);
    this.name = "LinuxCaptureFolderUntrusted";
  }
}

/** Every option of the measured call and how many words follow it. Nothing else may appear. */
const OPTION_ARITY: Readonly<Record<string, number>> = {
  "--new-session": 0, "--unshare-user": 0, "--unshare-pid": 0, "--unshare-ipc": 0, "--unshare-uts": 0,
  "--die-with-parent": 0, "--unshare-net": 0, "--symlink": 2, "--ro-bind-try": 2, "--dev": 1, "--proc": 1,
  "--tmpfs": 1, "--dir": 1, "--file": 2, "--remount-ro": 1, "--ro-bind": 2, "--bind": 2, "--chdir": 1,
  "--clearenv": 0, "--setenv": 2, "--seccomp": 1,
};
const REQUIRED_OPTIONS = ["--new-session", "--unshare-user", "--unshare-pid", "--die-with-parent", "--unshare-net", "--seccomp"] as const;
/** Mount destinations the launcher adds on its own: a private /tmp and the resolver folder it fills from `--file`. */
const LAUNCHER_BASELINE_MOUNTS = new Set(["/tmp", "/run/systemd/resolve"]);
/** Where the replay puts the two recorded data descriptors and the options. */
const LINUX_HOLDER_SECCOMP_FD = 5;
const LINUX_HOLDER_RESOLVER_FD = 6;
export const LINUX_HOLDER_OPTIONS_FD = 7;

/** The subset of a launcher request the structure checks compare against. */
export interface LinuxHolderRequestShape {
  readonly process: { readonly commandLine: string };
  readonly filesystem: { readonly readwritePaths: readonly string[]; readonly readonlyPaths: readonly string[]; readonly deniedPaths: readonly string[] };
}

/** A checked call: the options before `--` with the data descriptors renumbered, and their bytes. */
export interface LinuxHolderCall {
  readonly options: readonly string[];
  readonly command: readonly string[];
  readonly seccomp: Buffer;
  readonly resolver?: Buffer;
}

type BwrapRecord = { readonly words: readonly string[]; readonly descriptors: ReadonlyMap<number, Buffer> };

/** Reads one record the capture wrote; an error record or any malformed byte refuses. */
export function parseBwrapRecord(bytes: Buffer): BwrapRecord {
  let offset = 0;
  const take = (length: number) => {
    if (offset + length > bytes.length) throw new LinuxHolderRequestRejected("the bwrap record is truncated");
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  const u32 = () => take(4).readUInt32LE(0);
  if (!take(RECORD_MAGIC.length).equals(RECORD_MAGIC)) throw new LinuxHolderRequestRejected("the bwrap record has no header");
  const kind = take(1).toString("latin1");
  if (kind === "E") throw new LinuxHolderRequestRejected(`the launcher's bwrap call was refused by the capture: ${take(u32()).toString("utf8")}`);
  if (kind !== "R") throw new LinuxHolderRequestRejected("the bwrap record has an unknown kind");
  const words = Array.from({ length: u32() }, () => {
    const word = take(u32());
    if (word.includes(0)) throw new LinuxHolderRequestRejected("a bwrap word holds a NUL byte");
    return word.toString("utf8");
  });
  const descriptors = new Map<number, Buffer>();
  for (let count = u32(); count > 0; count -= 1) {
    const fd = u32();
    if (descriptors.has(fd)) throw new LinuxHolderRequestRejected(`descriptor ${fd} is recorded twice`);
    descriptors.set(fd, Buffer.from(take(u32())));
  }
  if (offset !== bytes.length) throw new LinuxHolderRequestRejected("the launcher made more than one bwrap call");
  return { words, descriptors };
}

function canonicalOrSelf(path: string): string {
  try { return realpathSync.native(path); } catch { return path; }
}

/** The structure checks of design 1.3, in order. Any failure names its reason and has no fallback. */
export function checkBwrapCall(record: BwrapRecord, request: LinuxHolderRequestShape): LinuxHolderCall {
  const words = record.words;
  const present = new Set<string>();
  const counts = new Map<string, number>();
  const rows = new Set([...request.filesystem.readwritePaths, ...request.filesystem.readonlyPaths, ...request.filesystem.deniedPaths]
    .flatMap(path => [path, canonicalOrSelf(path)]));
  const denied = new Set(request.filesystem.deniedPaths.flatMap(path => [path, canonicalOrSelf(path)]));
  // Walked by arity, so an operand (an environment value of `--`, `--seccomp` or `--file`) is never read as an option
  // and the command starts at the `--` that stands where an option would.
  const descriptorFds = new Map<string, number>();
  const renumbered: string[] = [];
  let end = -1;
  for (let index = 0; index < words.length;) {
    const option = words[index] ?? "";
    if (option === "--") { end = index; break; }
    const arity = OPTION_ARITY[option];
    if (arity === undefined) throw new LinuxHolderRequestRejected(`the bwrap call has an option outside the allowlist: ${option}`);
    if (index + arity >= words.length && arity > 0) throw new LinuxHolderRequestRejected(`${option} is missing its operands`);
    const operands = words.slice(index + 1, index + 1 + arity);
    present.add(option);
    counts.set(option, (counts.get(option) ?? 0) + 1);
    if (option === "--bind" || option === "--ro-bind" || option === "--tmpfs") {
      const destination = operands.at(-1) ?? "";
      if (!LAUNCHER_BASELINE_MOUNTS.has(destination) && !rows.has(destination)) {
        throw new LinuxHolderRequestRejected(`${option} mounts ${JSON.stringify(destination)}, which is not a path of the request`);
      }
      // The launcher denies a file by binding the empty device over it, read-only; only a denied path may take it.
      const deniesFile = option === "--ro-bind" && operands[0] === "/dev/null" && denied.has(destination);
      if (option !== "--tmpfs" && operands[0] !== destination && !deniesFile) {
        throw new LinuxHolderRequestRejected(`${option} mounts ${JSON.stringify(operands[0])} at another path`);
      }
    }
    // The two data descriptors are renumbered where they stand as options, never where an operand spells the word.
    const renumber = option === "--seccomp" ? LINUX_HOLDER_SECCOMP_FD : option === "--file" ? LINUX_HOLDER_RESOLVER_FD : undefined;
    if (renumber !== undefined) descriptorFds.set(option, Number(operands[0]));
    renumbered.push(option, ...(renumber === undefined ? operands : [String(renumber), ...operands.slice(1)]));
    index += 1 + arity;
  }
  if (end < 0) throw new LinuxHolderRequestRejected("the bwrap call has no command");
  const command = words.slice(end + 1);
  for (const required of REQUIRED_OPTIONS) {
    if (!present.has(required)) throw new LinuxHolderRequestRejected(`the bwrap call lacks ${required}`);
  }
  if ((counts.get("--seccomp") ?? 0) !== 1 || (counts.get("--file") ?? 0) > 1) {
    throw new LinuxHolderRequestRejected("the bwrap call must name one --seccomp and at most one --file descriptor");
  }
  const seccompFd = descriptorFds.get("--seccomp");
  const resolverFd = descriptorFds.get("--file");
  const named = [seccompFd, resolverFd].filter((fd): fd is number => fd !== undefined);
  if (record.descriptors.size !== named.length || named.some(fd => !record.descriptors.has(fd))) {
    throw new LinuxHolderRequestRejected("the recorded descriptors are not the ones the call names");
  }
  if (command.length !== 3 || command[0] !== "sh" || command[1] !== "-c" || command[2] !== request.process.commandLine) {
    throw new LinuxHolderRequestRejected("the bwrap call's command is not the request's command line");
  }
  const seccomp = record.descriptors.get(seccompFd ?? -1);
  if (seccomp === undefined || seccomp.length === 0) throw new LinuxHolderRequestRejected("the bwrap call's filter is empty");
  const resolver = resolverFd === undefined ? undefined : record.descriptors.get(resolverFd);
  return { options: renumbered, command, seccomp, ...(resolver === undefined ? {} : { resolver }) };
}

/**
 * How the replay starts the system bwrap. The options travel NUL-separated on a descriptor, never as arguments: the
 * launcher writes the holder's environment into them as `--setenv`, and a command line is readable by every process
 * of the user. Only `--args`, `--` and the request's command remain on the command line.
 */
export function linuxHolderReplay(call: LinuxHolderCall) {
  return {
    argv: ["--args", String(LINUX_HOLDER_OPTIONS_FD), "--", ...call.command],
    descriptors: new Map<number, Buffer>([
      [LINUX_HOLDER_SECCOMP_FD, call.seccomp],
      ...(call.resolver === undefined ? [] : [[LINUX_HOLDER_RESOLVER_FD, call.resolver] as const]),
      [LINUX_HOLDER_OPTIONS_FD, Buffer.from(call.options.map(word => `${word}\0`).join(""))],
    ]),
  } as const;
}

/**
 * The capture folder: one Ave-owned folder under the container start root holding only `bwrap`, a byte copy of the
 * pinned filter helper. Created on first use; on every use it must still be exactly that.
 */
export function establishLinuxCaptureFolder(root: string, helper: string, helperSha256: string): string {
  const folder = posix.join(root, "bwrap-capture");
  const file = posix.join(folder, "bwrap");
  try { mkdirSync(folder, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (readdirSync(folder).length === 0) {
    copyFileSync(helper, file);
    chmodSync(file, 0o500);
  }
  assertLinuxCaptureFolder(folder, helperSha256);
  return folder;
}

export function assertLinuxCaptureFolder(folder: string, helperSha256: string): void {
  const file = posix.join(folder, "bwrap");
  const refuse = (reason: string) => { throw new LinuxCaptureFolderUntrusted(folder, reason); };
  if (realpathSync.native(folder) !== folder) refuse("its path holds a link");
  const entries = readdirSync(folder);
  if (entries.length !== 1 || entries[0] !== "bwrap") refuse(`it holds ${JSON.stringify(entries)}, not only bwrap`);
  const uid = process.getuid?.();
  for (const [path, kind] of [[folder, "folder"], [file, "file"]] as const) {
    const stat = lstatSync(path);
    if (kind === "folder" ? !stat.isDirectory() : !stat.isFile()) refuse(`${path} is not a ${kind}`);
    if (stat.uid !== 0 && stat.uid !== uid) refuse(`${path} has another owner`);
    if ((stat.mode & 0o022) !== 0) refuse(`${path} is writable by group or others`);
  }
  if ((lstatSync(file).mode & 0o100) === 0) refuse("bwrap is not executable");
  if (createHash("sha256").update(readFileSync(file)).digest("hex") !== helperSha256) refuse("bwrap is not the pinned helper");
}

/** The launcher's own reason for a refusal, from its log: its `Error:` lines, never stderr. */
function launcherRefusal(log: string): string {
  const lines = log.replace(/\[\d+\] /gu, "").split("\n").filter(line => line.startsWith("Error: "));
  return lines.at(-1)?.slice("Error: ".length) ?? "the launcher refused the request";
}

/**
 * Runs the launcher once against a staged request with the capture folder first on its PATH, and returns the checked
 * call. The launcher's own exit status must be 0, and it must have made exactly one launch call.
 */
export async function translateLinuxHolderRequest(input: {
  readonly launcher: string; readonly env: Readonly<Record<string, string>>;
  readonly captureFolder: string; readonly helperSha256: string; readonly bwrap: string;
  readonly requestPath: string; readonly logPath: string; readonly request: LinuxHolderRequestShape;
  readonly signal?: AbortSignal;
}): Promise<LinuxHolderCall> {
  assertLinuxCaptureFolder(input.captureFolder, input.helperSha256);
  const stdio = ["ignore", "ignore", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "pipe"] as const;
  const child = spawn(input.launcher, ["--log-file", input.logPath, "--config", input.requestPath], {
    env: { ...input.env, PATH: `${input.captureFolder}:${input.env.PATH ?? ""}`, AVE_BWRAP_CAPTURE_FD: String(CAPTURE_FD), AVE_BWRAP_PATH: input.bwrap },
    stdio: [...stdio], timeout: TOOL_TIMEOUT_POLICY.mxcLinuxShellProbeMs, killSignal: "SIGKILL",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const chunks: Buffer[] = [];
  let kept = 0;
  let overflowed = false;
  ((child.stdio as readonly unknown[])[CAPTURE_FD] as Readable).on("data", (chunk: Buffer) => {
    kept += chunk.length;
    if (kept > RECORD_LIMIT) {
      overflowed = true;
      child.kill("SIGKILL");
      return;
    }
    if (!overflowed) chunks.push(chunk);
  });
  child.stderr?.resume();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  input.signal?.throwIfAborted();
  if (overflowed) throw new LinuxHolderRequestRejected(`the bwrap record exceeds ${RECORD_LIMIT} bytes`);
  const bytes = Buffer.concat(chunks);
  if (code !== 0) {
    // A call the capture refused leaves an error record; that is the reason, not the launcher's reaction to it.
    if (bytes.length > 0) parseBwrapRecord(bytes);
    let log = "";
    try { log = readFileSync(input.logPath, "utf8"); } catch { log = ""; }
    throw new LinuxHolderRequestRejected(launcherRefusal(log));
  }
  if (bytes.length === 0) throw new LinuxHolderRequestRejected("the launcher made no bwrap call");
  return checkBwrapCall(parseBwrapRecord(bytes), input.request);
}

// ---------------------------------------------------------------------------------------------------------------
// The run (design 1.4, 1.5, 5): the gate shell execs the system bwrap with the replay; the helper inside writes the
// ready byte once the filter is on.

/** The system bwrap as the holder canary found it; every run compares it again. */
interface LinuxHolderBwrap {
  readonly path: string;
  readonly identity: string;
}

/** What admission saw: the staged request's bytes, the checked call and the holder executable's identity. */
export function linuxHolderLaunchDigest(input: { readonly request: Buffer; readonly call: LinuxHolderCall; readonly executable: string }): string {
  const hash = createHash("sha256");
  for (const part of [input.request, Buffer.from(JSON.stringify([input.call.options, input.call.command])), input.call.seccomp,
    input.call.resolver ?? Buffer.alloc(0), Buffer.from(measurePosixExecutableIdentity(input.executable))]) {
    hash.update(String(part.length)).update(":").update(part);
  }
  return hash.digest("hex");
}

interface LinuxHolderProcess {
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** The holder's exit after it started. A stdin write that failed because it had exited never replaces this. */
  readonly completion: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

export interface LinuxHolder {
  readonly process: LinuxHolderProcess;
  readonly confinement: "linux-container";
  /** The holder's TERM, bwrap's TERM, the group kill; resolves with the receipt only when every resident process is gone. */
  dispose(reason?: string): Promise<ConfirmedExit>;
}

export interface StartLinuxHolderOptions {
  readonly label: string;
  readonly bwrap: LinuxHolderBwrap;
  readonly cwd: string;
  /** The digest admitted for this launch, and how to recompute it now. The gate refuses when they differ. */
  readonly admittedDigest: string;
  readonly currentDigest: () => string;
  /** The row-2 recheck. It runs synchronously after the group is registered and before the release byte. */
  readonly assertStillValid: () => void;
  /** Synchronous, inside the gate after every check and before the release byte: the outer bwrap's marker (design 3 rule 4). */
  readonly recordHolder?: (pid: number) => void;
  /** Runs before the gate releases: the Git snapshot of the write roots. */
  readonly beforeRelease?: () => Promise<void>;
  /**
   * Runs only once the stop is verified: the Git sweep, then the release of the listener, the staging folder, the Git
   * hold and any placeholder ownership. An unverified stop keeps all of them.
   */
  readonly afterVerifiedStop?: () => Promise<void>;
  readonly resources?: ManagedResources;
  readonly startMs?: number;
  /** Whether the call bridges a proxy socket: the helper is then the bridge and the holder its child (design 2.3). */
  readonly online: boolean;
}

const DIAGNOSTIC_BYTES = 4 * 1024;

type ResidentProcess = { readonly pid: number; readonly start: string };

/** What the resident set is read from. Production reads `/proc` through the runtime host; a unit test supplies its own. */
export interface LinuxProcessReader {
  /** The runtime host's start identity (boot and start ticks), or null once the process is gone. */
  start(pid: number): string | null;
  parent(pid: number): number | undefined;
  /** The pids `/proc/<pid>/task/<pid>/children` lists, or undefined when it cannot be read. */
  children(pid: number): readonly number[] | undefined;
  /** The words of `/proc/<pid>/cmdline`, or undefined when it cannot be read. */
  commandLine(pid: number): readonly string[] | undefined;
}

const procReader: LinuxProcessReader = {
  start: (pid) => currentMxcRuntimeHost().processStart(pid),
  parent: (pid) => {
    try { return parseProcStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8")).ppid; } catch { return undefined; }
  },
  children: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/u).filter(Boolean).map(Number);
    } catch {
      return undefined;
    }
  },
  commandLine: (pid) => {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1); } catch { return undefined; }
  },
};

/**
 * The resident set at the ready byte: outer bwrap, inner bwrap, the launcher's `sh -c` when that shell did not exec its
 * one command (dash does not), and the filter helper, each a child of the one before (the inner bwrap may also hold the
 * holder's orphans, which its namespace ends with it). Online the helper is
 * the bridge and the holder is its single child; offline the helper executed the holder and is it. Anything short of
 * that is named, never filled in: a missing member would shrink what "verified" means.
 */
export function readLinuxResidentSet(outer: number, online: boolean, launcherCommand: readonly string[], reader: LinuxProcessReader = procReader):
  { readonly processes: readonly ResidentProcess[]; readonly holder: ResidentProcess; readonly helper: ResidentProcess } | string {
  const member = (pid: number, name: string): ResidentProcess | string => {
    const start = reader.start(pid);
    return start === null ? `the ${name} is gone` : { pid, start };
  };
  const only = (parent: ResidentProcess, name: string): ResidentProcess | string => {
    const children = reader.children(parent.pid);
    if (children === undefined) return `the ${name}'s children cannot be read`;
    if (children.length !== 1) return `the ${name} has ${children.length} children, not one`;
    return member(children[0] as number, `child of the ${name}`);
  };
  const outerBwrap = member(outer, "outer bwrap");
  if (typeof outerBwrap === "string") return outerBwrap;
  const innerBwrap = only(outerBwrap, "outer bwrap");
  if (typeof innerBwrap === "string") return innerBwrap;
  // The inner bwrap is its namespace's init: a holder that daemonized already has its orphans here, beside the one
  // launcher member. The launcher's shell is recognised by its exact words, `sh -c <the request's command line>`, never
  // by its name; without one, the helper is the child that started first (each orphan descends from it).
  const innerChildren = reader.children(innerBwrap.pid);
  if (innerChildren === undefined) return "the inner bwrap's children cannot be read";
  const isShell = (pid: number): boolean => {
    const words = reader.commandLine(pid);
    return words !== undefined && words.length === launcherCommand.length && words.every((word, index) => word === launcherCommand[index]);
  };
  const shells = innerChildren.filter(isShell);
  if (shells.length > 1) return `the inner bwrap has ${shells.length} launcher shells, not one`;
  let below: ResidentProcess | string;
  if (shells.length === 1) below = member(shells[0] as number, "launcher shell");
  else if (innerChildren.length === 1) below = member(innerChildren[0] as number, "child of the inner bwrap");
  else if (innerChildren.length === 0) return "the inner bwrap has no children";
  else {
    const ticks = (start: string): number => Number(start.slice(start.lastIndexOf(":") + 1));
    const started = innerChildren.flatMap((pid) => { const start = reader.start(pid); return start === null ? [] : [{ pid, start }]; })
      .sort((a, b) => ticks(a.start) - ticks(b.start));
    if (started.length === 0) return "the inner bwrap's children are gone";
    if (started.length > 1 && ticks(started[0]!.start) === ticks(started[1]!.start)) {
      return `the inner bwrap has ${innerChildren.length} children and no single first one`;
    }
    below = started[0]!;
  }
  if (typeof below === "string") return below;
  const shell = shells.length === 1 ? below : undefined;
  const helper = shell === undefined ? below : only(shell, "launcher shell");
  if (typeof helper === "string") return helper;
  const processes = [outerBwrap, innerBwrap, ...(shell === undefined ? [] : [shell]), helper];
  if (!online) return { processes, holder: helper, helper };
  const holder = only(helper, "bridge");
  if (typeof holder === "string") return holder;
  if (reader.parent(holder.pid) !== helper.pid) return "the holder under the bridge is gone";
  return { processes, holder, helper };
}

/** Still the same process: alive with the start identity recorded at the ready byte. */
function alive(process: ResidentProcess): boolean {
  return procReader.start(process.pid) === process.start;
}

type StartObservation =
  | { readonly kind: "ready" }
  | { readonly kind: "closed"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: "stalled" };

/**
 * Start one Linux holder through the launch gate and the system bwrap. It counts as started only once the ready byte
 * arrives from the helper inside; a start that ends or stalls before that is stopped and refused, with no fallback.
 */
export async function startLinuxHolder(call: LinuxHolderCall, options: StartLinuxHolderOptions): Promise<LinuxHolder> {
  // bwrap's parent-death signal belongs to the thread that created it (prctl(2) PR_SET_PDEATHSIG).
  if (!isMainThread) throw new MxcProcessContractError("A Linux holder must be started from the main thread");
  const replay = linuxHolderReplay(call);
  let observed: ReturnType<typeof observeManagedProcessGroup> | undefined;
  let spawned: ChildProcess | undefined;
  // The caller's copies of the holder's output, piped from the spawn on. Node drains a child's unread stdout and stderr
  // when it exits, and a short run can exit before the start returns (it is waited for below): unpiped, its output is lost.
  const output = { stdout: new PassThrough(), stderr: new PassThrough() };
  await options.beforeRelease?.();
  const stdio: ("pipe" | "ignore")[] = ["pipe", "pipe", "pipe", "ignore", "pipe", "pipe", "pipe", "pipe"];
  const child = await spawnGatedManagedProcess(options.bwrap.path, replay.argv, { cwd: options.cwd, env: {}, stdio }, {
    label: options.label,
    onSpawn: (started) => {
      spawned = started;
      started.stdout?.pipe(output.stdout);
      started.stderr?.pipe(output.stderr);
      observed = observeManagedProcessGroup(started, options.resources);
      // A write after the holder exited fails with EPIPE; the exit result stands (the caller reads `completion`).
      started.stdin?.on("error", () => {});
      for (const [fd, bytes] of replay.descriptors) {
        const pipe = (started.stdio as readonly unknown[])[fd] as Writable;
        pipe.on("error", () => {});
        pipe.end(bytes);
      }
    },
    assertStillValid: () => {
      options.assertStillValid();
      if (measurePosixExecutableIdentity(options.bwrap.path) !== options.bwrap.identity) {
        throw new MxcHolderStartRefusedError("integrity", "the system bwrap changed since the holder canary proved it");
      }
      if (options.currentDigest() !== options.admittedDigest) {
        throw new MxcProcessContractError("Container holder launch changed after admission");
      }
      // Last, once nothing refuses: the gate shell's pid is bwrap's once the release byte lets it exec.
      if (spawned?.pid !== undefined) options.recordHolder?.(spawned.pid);
    },
  }).catch(async (error: unknown) => {
    // Nothing passed the gate. Its shell was killed by the gate; wait for its group so the owner can release.
    if (spawned !== undefined && observed !== undefined) await observed.confirmExit("holder launch gate refused");
    throw error;
  });
  const exit = observed as ReturnType<typeof observeManagedProcessGroup>;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let diagnostic = "";
  const onDiagnostic = (chunk: Buffer): void => {
    if (diagnostic.length < DIAGNOSTIC_BYTES) diagnostic += chunk.toString("utf8").slice(0, DIAGNOSTIC_BYTES - diagnostic.length);
  };
  child.stderr?.on("data", onDiagnostic);
  const ready = child.stdio[4] as Readable;
  const observation = await new Promise<StartObservation>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "stalled" }), options.startMs ?? TOOL_TIMEOUT_POLICY.mxcLinuxHolderStartMs);
    timer.unref?.();
    ready.once("data", () => { clearTimeout(timer); resolve({ kind: "ready" }); });
    void closed.then(({ code, signal }) => { clearTimeout(timer); resolve({ kind: "closed", code, signal }); });
  });
  ready.destroy();
  child.stderr?.off("data", onDiagnostic);
  // The resident set, read once at the ready byte (review #758 P2-3). One short of a member stops and refuses the start
  // below, unless the whole run already ended, which leaves nothing resident to stop.
  let set: { readonly processes: readonly ResidentProcess[]; readonly holder?: ResidentProcess; readonly helper?: ResidentProcess } = { processes: [] };
  let unread: string | undefined;
  if (observation.kind === "ready") {
    const read = readLinuxResidentSet(child.pid as number, options.online, call.command);
    if (typeof read === "string") unread = read;
    else set = read;
  }

  let disposing: Promise<ConfirmedExit> | undefined;
  const dispose = (reason = "holder released"): Promise<ConfirmedExit> => disposing ??= (async () => {
    if (child.stdin?.writable) child.stdin.end();
    const finished = () => child.exitCode !== null || child.signalCode !== null;
    // A holder that ended by itself keeps what it wrote: its owner releases it at completion, often before the caller
    // read its output (a hook, a one-shot server). Its streams end on their own; only a stopped holder's are cut.
    const endedByItself = finished();
    // 1. The holder's own TERM, so it can see it: TERM to bwrap ends the namespace before the holder runs its handler.
    //    Signalled only while it is still the process recorded at the ready byte, under the same parent.
    const holder = set.holder;
    if (holder !== undefined && alive(holder) && (set.helper === holder || procReader.parent(holder.pid) === set.helper?.pid)) {
      try { process.kill(holder.pid, "SIGTERM"); } catch { /* gone since the check */ }
    }
    // 2. Its grace, ended early when bwrap closes.
    if (!finished()) await Promise.race([closed, sleep(TOOL_TIMEOUT_POLICY.mxcLinuxHolderTermGraceMs, undefined, { ref: false })]);
    // 3. TERM to the outer bwrap; 4. its group's KILL after the stop grace.
    if (!finished() && child.pid !== undefined) {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* gone */ }
      await Promise.race([closed, sleep(TOOL_TIMEOUT_POLICY.mxcLinuxShellStopMs, undefined, { ref: false })]);
      if (!finished()) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
    for (const stream of endedByItself ? [child.stdin] : [child.stdin, child.stdout, child.stderr, output.stdout, output.stderr]) stream?.destroy();
    // 5. Verified only when the group ended and every resident process is gone within the tree-kill bound.
    const receipt = await exit.confirmExit(reason);
    const deadline = Date.now() + TOOL_TIMEOUT_POLICY.processTreeKillMs;
    while (set.processes.some(alive) && Date.now() < deadline) await sleep(20, undefined, { ref: false });
    const survivors = set.processes.filter(alive);
    if (receipt !== undefined && survivors.length === 0) {
      await options.afterVerifiedStop?.();
      return receipt;
    }
    const why = receipt === undefined ? "its process group did not end" : `pids ${survivors.map(entry => entry.pid).join(", ")} are still running`;
    throw new MxcProcessCleanupError(`Container holder stopped, cleanup unverified: ${why}`);
  })();

  if (observation.kind !== "ready") {
    await dispose(observation.kind === "stalled" ? "holder start stalled" : "holder start refused");
    if (observation.kind === "stalled") throw new MxcHolderStartRefusedError("holder-start-failed", "the holder did not start in time");
    const what = `the launch ended before the holder started (${observation.signal ?? `exit ${observation.code}`})`;
    throw new MxcHolderStartRefusedError("holder-start-failed", diagnostic.trim() ? `${what}: ${diagnostic.trim()}` : what);
  }
  if (unread !== undefined) {
    // The process's own exit, not its streams' close: a caller reads the holder's output only once the start returns.
    const ended = child.exitCode !== null || child.signalCode !== null || await Promise.race([
      new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
      sleep(TOOL_TIMEOUT_POLICY.processTreeKillMs, false, { ref: false }),
    ]);
    if (!ended) {
      await dispose("holder resident set incomplete");
      throw new MxcHolderStartRefusedError("holder-start-failed", `the holder's resident set at its ready byte is incomplete: ${unread}`);
    }
  }
  const holderProcess: LinuxHolderProcess = Object.freeze({
    // Only a run that ended before its set could be read has no holder pid; the outer bwrap's then names that run.
    pid: set.holder === undefined ? child.pid as number : set.holder.pid,
    stdin: child.stdin as Writable,
    stdout: output.stdout,
    stderr: output.stderr,
    completion: closed,
  });
  return Object.freeze({ process: holderProcess, confinement: "linux-container" as const, dispose });
}
