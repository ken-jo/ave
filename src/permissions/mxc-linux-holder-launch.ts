import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

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

class LinuxHolderRequestRejected extends Error {
  readonly code = "request-rejected";

  constructor(readonly reason: string) {
    super(`Linux holder request rejected: ${reason}`);
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
  const end = record.words.indexOf("--");
  if (end < 0) throw new LinuxHolderRequestRejected("the bwrap call has no command");
  const options = record.words.slice(0, end);
  const command = record.words.slice(end + 1);
  const present = new Set<string>();
  const counts = new Map<string, number>();
  const rows = new Set([...request.filesystem.readwritePaths, ...request.filesystem.readonlyPaths, ...request.filesystem.deniedPaths]
    .flatMap(path => [path, canonicalOrSelf(path)]));
  const renumbered = [...options];
  for (let index = 0; index < options.length;) {
    const option = options[index] ?? "";
    const arity = OPTION_ARITY[option];
    if (arity === undefined) throw new LinuxHolderRequestRejected(`the bwrap call has an option outside the allowlist: ${option}`);
    if (index + arity >= options.length && arity > 0) throw new LinuxHolderRequestRejected(`${option} is missing its operands`);
    const operands = options.slice(index + 1, index + 1 + arity);
    present.add(option);
    counts.set(option, (counts.get(option) ?? 0) + 1);
    if (option === "--bind" || option === "--ro-bind" || option === "--tmpfs") {
      const destination = operands.at(-1) ?? "";
      if (!LAUNCHER_BASELINE_MOUNTS.has(destination) && !rows.has(destination)) {
        throw new LinuxHolderRequestRejected(`${option} mounts ${JSON.stringify(destination)}, which is not a path of the request`);
      }
      if (option !== "--tmpfs" && operands[0] !== destination) {
        throw new LinuxHolderRequestRejected(`${option} mounts ${JSON.stringify(operands[0])} at another path`);
      }
    }
    if (option === "--seccomp") renumbered[index + 1] = String(LINUX_HOLDER_SECCOMP_FD);
    if (option === "--file") renumbered[index + 1] = String(LINUX_HOLDER_RESOLVER_FD);
    index += 1 + arity;
  }
  for (const required of REQUIRED_OPTIONS) {
    if (!present.has(required)) throw new LinuxHolderRequestRejected(`the bwrap call lacks ${required}`);
  }
  if ((counts.get("--seccomp") ?? 0) !== 1 || (counts.get("--file") ?? 0) > 1) {
    throw new LinuxHolderRequestRejected("the bwrap call must name one --seccomp and at most one --file descriptor");
  }
  const descriptorOf = (option: string) => {
    const index = options.indexOf(option);
    return index < 0 ? undefined : Number(options[index + 1]);
  };
  const seccompFd = descriptorOf("--seccomp");
  const resolverFd = descriptorOf("--file");
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
