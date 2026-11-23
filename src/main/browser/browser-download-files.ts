import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { replaceStagedFile } from "../../lib/atomic-file.js";
import { createLogger } from "../../lib/logger.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { forceKillManagedChildProcess, spawnManaged } from "../managed-child-processes.js";
import { windowsPathKindHelperIn } from "../windows-path-kind-launcher.js";

const log = createLogger("browser-download-files");

/** A directory a file operation acts in: its canonical path and the identity it was verified to have. */
export interface HeldDirectory {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Where an operation is, with its directories held: `ready` before it changes anything, `copied` before a copy's commit rename. */
type HeldStep = "ready" | "copied";

/** Asked at each step while the directories are held; false stops the operation there, removing anything it made. */
type Proceed = (step: HeldStep) => boolean;

/**
 * What refused an operation before it acted: `from` or `to` is not the verified directory (gone, unreadable, a link, or another
 * directory now at its path), the `source` entry is not an ordinary file, or the `target` name holds something other than an ordinary file.
 */
export type HeldRefusal = "from" | "to" | "source" | "target";

export class HeldDirectoryRefusedError extends Error {
  constructor(readonly refusal: HeldRefusal) {
    super(`a file operation in a held directory was refused: ${refusal}`);
  }
}

/**
 * The native helper that performs these operations on macOS and Windows is not where the install puts it, does not start, or does not keep
 * to its protocol: it crashed, ended with a status or a line it never gives, or stopped answering and was killed.
 */
export class HeldFileHelperUnavailableError extends Error {
  /**
   * The last step the helper was let past (`ready` before it acts, `copied` before a copy's commit) when it ended without a trustworthy
   * outcome, or null: after a step it may have changed files, and the operation's disposition is unknown.
   */
  passed: "ready" | "copied" | null = null;
  /** For a copy that ended after `ready` without its outcome: what removing its temporary file through the newly held chosen folder found. */
  partialCopy: "removed" | "absent" | "left" | null = null;
  /** For such a copy: the identity its temporary file had while the helper wrote it, or null when it was never seen. */
  partFile: FileIdentity | null = null;
  constructor(readonly helper: string, readonly why = "it is missing", message?: string) {
    super(message ?? `the download file helper ${helper} cannot be used: ${why}. Reinstall Ave; in a development checkout, build it (${HELPER_BUILD[process.platform] ?? "no build for this platform"}).`);
  }
}

/** The helper stopped answering, or did not end once stopped, within the stall bound, and was killed. */
export class HeldFileHelperStalledError extends HeldFileHelperUnavailableError {
  /** When `stillRunning`: settles once the helper is seen to end after its run was given up. */
  exited: Promise<void> | null = null;
  constructor(helper: string, why: string, readonly stillRunning: boolean) {
    super(helper, why, `the download file helper ${helper} ${why}; it was killed${stillRunning ? ", and has not been seen to end" : ""}`);
  }
}

/** A file's identity: a file put at its name since (even one moved over it) has another. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

/**
 * What is at `name` in `folder` now, against `expected`: the same ordinary file, nothing (`absent`), or anything else, including a
 * folder that is no longer the held one. Every failure to tell is `other`.
 */
export function compareFile(folder: HeldDirectory, name: string, expected: FileIdentity): "same" | "absent" | "other" {
  let info: BigIntStats | null;
  try {
    info = entryIn(folder, name);
  } catch {
    return "other";
  }
  if (info === null) return "absent";
  return info.isFile() && info.dev === expected.dev && info.ino === expected.ino && info.birthtimeNs === expected.birthtimeNs ? "same" : "other";
}

// The identity of the ordinary file `name` in `folder` while `folder` is still the held one, or null.
function identityOf(folder: HeldDirectory, name: string): FileIdentity | null {
  try {
    const info = entryIn(folder, name);
    return info?.isFile() ? { dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs } : null;
  } catch {
    return null;
  }
}

// The entry `name` in `folder`, or null when there is none; throws when `folder` is no longer the held one or cannot be read.
function entryIn(folder: HeldDirectory, name: string): BigIntStats | null {
  const held = lstatSync(folder.path, { bigint: true });
  if (!held.isDirectory() || held.isSymbolicLink() || held.dev !== folder.dev || held.ino !== folder.ino) throw new HeldDirectoryRefusedError("to");
  try {
    return lstatSync(join(folder.path, name), { bigint: true });
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * File operations that act inside held directories. Each one opens its directories, checks each is the plain directory with the given
 * identity, and names every file relative to that open directory, so a directory moved or replaced by a link after the check changes
 * nothing it does. Linux reaches files through the open descriptor's /proc/self/fd entry; macOS and Windows have no such path, so a
 * native helper holds the directories and performs the whole operation (native/macos-dir-ops, native/windows-path-kind dir-ops.h).
 */
export interface HeldFileOperations {
  /**
   * Rename `name` in `from` to `target` in `to`, replacing an ordinary file there; `cross-volume` when nothing moved because they are on
   * different volumes. `stop` aborting before the rename is let go ends it `cancelled`.
   */
  move(from: HeldDirectory, name: string, to: HeldDirectory, target: string, proceed: Proceed, stop: AbortSignal): Promise<"committed" | "cancelled" | "cross-volume">;
  /**
   * Copy `name` from `from` into the exclusive new file `part` in `to`, then rename it to `target`. The rename is the commit point: before it,
   * a stop (`proceed` answering false, or `stop` aborting while bytes are copied) removes `part` and reports `cancelled`.
   */
  copy(from: HeldDirectory, name: string, to: HeldDirectory, target: string, part: string, proceed: Proceed, stop: AbortSignal): Promise<"committed" | "cancelled">;
  /** Remove `name`, a file or a link, from `directory`; `stop` aborting before the removal is let go ends it `cancelled`. */
  remove(directory: HeldDirectory, name: string, proceed: Proceed, stop: AbortSignal): Promise<"removed" | "absent" | "cancelled">;
  /** Remove every file and link directly in `directory`, and nothing else; await it before anything is staged. */
  sweep(directory: HeldDirectory): Promise<number>;
}

const HELPER_BUILD: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "node scripts/build-macos-dir-ops.mjs",
  win32: "scripts/build-windows-job.ps1 -Helper path-kind",
};

/** The held-directory operations for this platform; `resourcePath` is the host resources folder the native helper ships in. */
export function heldFileOperations(resourcePath: string, platform: NodeJS.Platform = process.platform): HeldFileOperations {
  if (platform === "linux") return descriptorFileOperations();
  if (platform !== "darwin" && platform !== "win32") throw new Error(`held directory file operations are not available on ${platform}`);
  const helper = platform === "win32" ? windowsPathKindHelperIn(resourcePath) : join(resourcePath, "macos-dir-ops", process.arch, "ave-dir-ops");
  if (!existsSync(helper)) throw new HeldFileHelperUnavailableError(helper);
  return helperFileOperations(helper);
}

// The answers a directory check can get when the directory is missing, unreadable, not a directory, or a link: it cannot be verified.
const UNVERIFIABLE = new Set(["ELOOP", "ENOENT", "EACCES", "ENOTDIR", "EPERM"]);

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Linux: every name goes through the held descriptor's /proc/self/fd entry, which the kernel resolves to the open directory itself.

const COPY_CHUNK = 1024 * 1024;

function holdDescriptor(directory: HeldDirectory, refusal: "from" | "to"): number {
  let fd: number;
  try {
    fd = openSync(directory.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (UNVERIFIABLE.has(codeOf(error) ?? "")) throw new HeldDirectoryRefusedError(refusal);
    throw error;
  }
  const info = fstatSync(fd, { bigint: true });
  if (!info.isDirectory() || info.dev !== directory.dev || info.ino !== directory.ino) {
    closeSync(fd);
    throw new HeldDirectoryRefusedError(refusal);
  }
  return fd;
}

// Hold `directory` (and `also`, refused as `to`) for the length of `use`; every descriptor is closed afterwards.
async function holding<T>(directory: HeldDirectory, also: HeldDirectory | null, use: (fd: number, alsoFd: number) => Promise<T> | T): Promise<T> {
  const fd = holdDescriptor(directory, "from");
  try {
    const alsoFd = also === null ? -1 : holdDescriptor(also, "to");
    try {
      return await use(fd, alsoFd);
    } finally {
      if (alsoFd >= 0) closeSync(alsoFd);
    }
  } finally {
    closeSync(fd);
  }
}

function holdingSync<T>(directory: HeldDirectory, use: (fd: number) => T): T {
  const fd = holdDescriptor(directory, "from");
  try {
    return use(fd);
  } finally {
    closeSync(fd);
  }
}

const inHeld = (fd: number, name: string): string => `/proc/self/fd/${fd}/${name}`;

// The chosen name may hold nothing yet, or an ordinary file the user agreed to replace; never a link or anything else.
function assertReplaceable(path: string): void {
  try {
    if (!lstatSync(path).isFile()) throw new HeldDirectoryRefusedError("target");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw error;
  }
}

function assertOrdinarySource(path: string): void {
  try {
    if (!lstatSync(path).isFile()) throw new HeldDirectoryRefusedError("source");
  } catch (error) {
    if (codeOf(error) === "ENOENT") throw new HeldDirectoryRefusedError("source");
    throw error;
  }
}

// Write all of `length` bytes from `buffer`, however many each write takes; a write that makes no progress is a failure.
async function writeFully(target: FileHandle, buffer: Buffer, length: number): Promise<void> {
  for (let offset = 0; offset < length;) {
    const { bytesWritten } = await target.write(buffer, offset, length - offset);
    if (bytesWritten <= 0) throw Object.assign(new Error("the copy of a browser download stopped making progress"), { code: "EIO" });
    offset += bytesWritten;
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

function descriptorFileOperations(): HeldFileOperations {
  return {
    move: (from, name, to, target, proceed, stop) => holding(from, to, (fromFd, toFd) => {
      if (stop.aborted || !proceed("ready")) return "cancelled";
      assertOrdinarySource(inHeld(fromFd, name));
      assertReplaceable(inHeld(toFd, target));
      try {
        replaceStagedFile(inHeld(fromFd, name), inHeld(toFd, target));
      } catch (error) {
        if (codeOf(error) === "EXDEV") return "cross-volume";
        throw error;
      }
      return "committed";
    }),
    copy: (from, name, to, target, part, proceed, stop) => holding(from, to, async (fromFd, toFd) => {
      let source: FileHandle;
      try {
        source = await open(inHeld(fromFd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (codeOf(error) === "ENOENT" || codeOf(error) === "ELOOP") throw new HeldDirectoryRefusedError("source");
        throw error;
      }
      let created = false;
      try {
        const sourceInfo = await source.stat();
        if (!sourceInfo.isFile()) throw new HeldDirectoryRefusedError("source");
        if (!proceed("ready")) return "cancelled";
        assertReplaceable(inHeld(toFd, target));
        // The temporary file is created exclusively, never through a link, in the held folder.
        const copy = await open(inHeld(toFd, part), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, sourceInfo.mode & 0o777);
        created = true;
        try {
          const buffer = Buffer.alloc(COPY_CHUNK);
          for (let position = 0; ;) {
            if (stop.aborted) return "cancelled";
            const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            await writeFully(copy, buffer, bytesRead);
            position += bytesRead;
          }
          await copy.sync();
        } finally {
          await copy.close();
        }
        if (!proceed("copied")) return "cancelled";
        assertReplaceable(inHeld(toFd, target));
        replaceStagedFile(inHeld(toFd, part), inHeld(toFd, target));
        created = false;
        return "committed";
      } finally {
        await source.close();
        // A copy that did not reach its commit leaves nothing behind, and is removed only from the held folder.
        if (created) removeIfPresent(inHeld(toFd, part));
      }
    }),
    remove: (directory, name, proceed, stop) => holding(directory, null, (fd) => {
      if (stop.aborted || !proceed("ready")) return "cancelled";
      try {
        unlinkSync(inHeld(fd, name));
      } catch (error) {
        if (codeOf(error) === "ENOENT") return "absent";
        throw error;
      }
      return "removed";
    }),
    sweep: async (directory) => holdingSync(directory, (fd) => {
      let removed = 0;
      for (const entry of readdirSync(inHeld(fd, "."), { withFileTypes: true })) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        unlinkSync(inHeld(fd, entry.name));
        removed += 1;
      }
      return removed;
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// macOS and Windows: the native helper holds the directories for the whole operation (protocol: native/macos-dir-ops/README.md).

// Exit statuses the helper ends with; anything else means the helper itself is broken.
const EXIT_DONE = 0;
const EXIT_REFUSED = 3;
const EXIT_FAILED = 4;
const REFUSALS: ReadonlySet<string> = new Set<HeldRefusal>(["from", "to", "source", "target"]);
const PROGRESS = /^progress (\d+)$/u;
const FAILURE_DIAGNOSTIC = /^Windows error \d+(?: \(NTSTATUS 0x[0-9A-F]{8}, (?:NtCreateFile|NtSetInformationFile)\))?\r?\n$/u;

/** How long a helper may say nothing (`stallMs`), and how long its exit may take to be seen once it is killed (`killMs`). */
interface HelperBounds { readonly stallMs: number; readonly killMs: number }
const POLICY_BOUNDS: HelperBounds = {
  stallMs: TOOL_TIMEOUT_POLICY.browserDownloadHelperStallMs,
  // The same bound as every other owned process tree's termination on this platform.
  killMs: process.platform === "win32" ? TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs : TOOL_TIMEOUT_POLICY.processTreeKillMs,
};
// A stop that nothing aborts: cleanup steps that run to their end, within the stall bound.
const UNSTOPPED = new AbortController().signal;

function directoryArguments(directory: HeldDirectory): string[] {
  return [directory.path, directory.dev.toString(), directory.ino.toString()];
}

// Turn the helper's last line and exit status into the operation's outcome, or the error it ended with. A refusal and a filesystem failure
// the helper reports are answers about the operation; any other ending, an unknown status or line among them, means the helper is broken.
function helperOutcome(helper: string, status: number | null, signal: NodeJS.Signals | null, last: string, stderr: string): string | Error {
  if (status === EXIT_DONE && /^(?:committed|cancelled|cross-volume|removed|absent|swept \d+)$/u.test(last)) return last;
  const refused = /^refused (\w+)$/u.exec(last);
  const refusal = refused?.[1];
  if (status === EXIT_REFUSED && refusal !== undefined && REFUSALS.has(refusal)) {
    return new HeldDirectoryRefusedError(refusal as HeldRefusal);
  }
  const failed = /^failed (E[A-Z0-9_]+)$/u.exec(last);
  if (status === EXIT_FAILED && failed !== null) {
    return Object.assign(new Error(`the download file helper failed (${failed[1]})`), { code: failed[1] });
  }
  const why = signal !== null ? `signal ${signal}` : `exit ${status ?? "unknown"}`;
  return new HeldFileHelperUnavailableError(helper, `it ended unexpectedly (${why}, ${JSON.stringify(last)}${stderr.trim() ? `: ${stderr.trim()}` : ""})`);
}

// The status a helper that printed `last` and then exited would have ended with: a kill that lands after the outcome line does not change it.
function statusOf(last: string): number {
  if (last.startsWith("refused ")) return EXIT_REFUSED;
  if (last.startsWith("failed ")) return EXIT_FAILED;
  return EXIT_DONE;
}

/**
 * Run one mode in protocol order. Only an authorized step or advancing copy progress renews liveness. A stop or outcome fixes the exit
 * deadline; any stdout byte after the outcome invalidates the run. A failure may carry its one native diagnostic on stderr, whose
 * delivery order is independent of stdout. Killing and confirming exit share one independent `killMs` ceiling, including
 * when the platform's kill request does not finish. A valid outcome before a confirmed kill is retained only if the protocol stayed valid.
 */
function runHelper(helper: string, args: readonly string[], proceed: Proceed, stop: AbortSignal, bounds: HelperBounds, onProgress?: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnManaged(helper, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, env: {} }, { label: "browser-download-files" });
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) throw new Error("the download file helper was started without pipes");
    let pending = "";
    let outcome: string | null = null;
    let phase: "holding" | "copying" | "acting" | "copied" = "holding";
    let copiedBytes = 0n;
    let protocolFailure: string | null = null;
    const mode = args[0];
    let errors = "";
    let inputOpen = true;
    let thrown: unknown;
    let passed: HeldStep | null = null;
    let stopping = false;
    let killed: string | null = null;
    let settled = false;
    let startFailure: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    let lateExit: Promise<void> | null = null;
    const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
    const endInput = (): void => {
      if (!inputOpen) return;
      inputOpen = false;
      stdin.end();
    };
    const fail = (error: HeldFileHelperUnavailableError): void => {
      // An unavailable run has no trustworthy disposition, even if it printed an outcome before violating the protocol.
      error.passed = passed;
      reject(error);
    };
    const settle = (status: number | null, signal: NodeJS.Signals | null, stillRunning: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop.removeEventListener("abort", onStop);
      const last = outcome ?? "";
      if (thrown !== undefined) {
        reject(thrown instanceof Error ? thrown : new Error(String(thrown)));
        return;
      }
      if (startFailure !== null) {
        fail(new HeldFileHelperUnavailableError(helper, startFailure));
        return;
      }
      // Match the entire diagnostic stream, including its final newline: extra lines or partial diagnostics are not an answer.
      if (errors !== "" && (!last.startsWith("failed ") || FAILURE_DIAGNOSTIC.exec(errors)?.[0] !== errors)) {
        protocolFailure ??= "it wrote an invalid failure diagnostic";
      }
      if (protocolFailure !== null && !stillRunning) {
        fail(new HeldFileHelperUnavailableError(helper, protocolFailure));
        return;
      }
      if (killed !== null) {
        if (!stillRunning && outcome !== null && pending === "") {
          const answered = helperOutcome(helper, statusOf(outcome), null, outcome, errors);
          if (answered instanceof HeldFileHelperUnavailableError) fail(answered);
          else if (answered instanceof Error) reject(answered);
          else resolve(answered);
          return;
        }
        const stalled = new HeldFileHelperStalledError(helper, killed, stillRunning);
        stalled.exited = lateExit;
        fail(stalled);
        return;
      }
      const answered = pending === "" ? helperOutcome(helper, status, signal, last, errors)
        : new HeldFileHelperUnavailableError(helper, "it ended with an incomplete protocol line");
      if (answered instanceof HeldFileHelperUnavailableError) fail(answered);
      else if (answered instanceof Error) reject(answered);
      else resolve(answered);
    };
    // Kill the helper and wait for its exit; only an exit seen ends the run as stopped.
    const kill = (why: string): void => {
      if (killed !== null || settled) return;
      killed = why;
      clearTimeout(timer);
      endInput();
      // Start confirmation before requesting termination: a pending platform kill cannot defer this ceiling.
      timer = setTimeout(() => {
        if (exited()) settle(child.exitCode, child.signalCode, false);
        else {
          log.error({ helper, pid: child.pid ?? null }, "the download file helper did not end when killed");
          lateExit = new Promise((resolve) => {
            child.once("exit", () => { log.warn({ helper }, "the download file helper ended after its run was given up"); resolve(); });
          });
          settle(null, null, true);
        }
      }, bounds.killMs);
      try {
        void Promise.resolve(forceKillManagedChildProcess(child, "browser download file helper stalled")).catch((error: unknown) => {
          log.warn({ error: String(error) }, "the download file helper could not be killed");
        });
      } catch (error) {
        log.warn({ error: (error as Error).message }, "the download file helper could not be killed");
      }
    };
    const awaitLine = (phase: string): void => {
      if (stopping || killed !== null) return;
      clearTimeout(timer);
      timer = setTimeout(() => kill(`said nothing for ${bounds.stallMs} ms ${phase}`), bounds.stallMs);
    };
    // Once stopped, the deadline to end is fixed: progress the helper still writes does not extend it.
    const beginStopping = (): void => {
      endInput();
      if (stopping || killed !== null || outcome !== null) return;
      stopping = true;
      clearTimeout(timer);
      timer = setTimeout(() => kill(`did not end within ${bounds.stallMs} ms of being stopped`), bounds.stallMs);
    };
    // A helper that has already ended (refused, or failed) closes its input; its exit status is the outcome, not this write error.
    stdin.on("error", () => { inputOpen = false; });
    const onStop = (): void => beginStopping();
    stop.addEventListener("abort", onStop, { once: true });
    const violate = (): void => {
      protocolFailure ??= "it wrote output outside its mode or phase";
      kill(protocolFailure);
    };
    const isOutcome = (line: string): boolean => {
      if (/^refused (from|to|source|target)$/u.test(line) || /^failed E[A-Z0-9_]+$/u.test(line)) return true;
      if (line === "cancelled") return phase !== "holding" && stopping;
      if (mode === "--dir-copy") return line === "committed" && passed === "copied";
      if (passed !== "ready") return false;
      if (mode === "--dir-rename") return line === "committed" || line === "cross-volume";
      if (mode === "--dir-remove") return line === "removed" || line === "absent";
      const swept = /^swept (\d+)$/u.exec(line);
      return mode === "--dir-sweep" && swept !== null && Number.isSafeInteger(Number(swept[1]));
    };
    stdout.on("data", (chunk: Buffer) => {
      if (settled || chunk.length === 0) return;
      if (outcome !== null) { violate(); return; }
      if (killed !== null) return;
      pending += chunk.toString("utf8");
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        const progress = PROGRESS.exec(line)?.[1];
        if (progress !== undefined) {
          const bytes = BigInt(progress);
          if (mode !== "--dir-copy" || phase !== "copying" || passed !== "ready" || bytes <= copiedBytes) { violate(); return; }
          copiedBytes = bytes;
          onProgress?.();
          awaitLine("while copying");
          continue;
        }
        if (line !== "ready" && line !== "copied") {
          if (!isOutcome(line)) { violate(); return; }
          awaitLine("after its outcome");
          outcome = line;
          endInput();
          if (pending !== "" || errors !== "" && !line.startsWith("failed ")) violate();
          return;
        }
        if (line === "ready" ? phase !== "holding" : mode !== "--dir-copy" || phase !== "copying" || passed !== "ready") { violate(); return; }
        phase = line === "copied" ? "copied" : mode === "--dir-copy" ? "copying" : "acting";
        let go = false;
        try {
          go = inputOpen && !stopping && !stop.aborted && proceed(line as HeldStep);
        } catch (error) {
          thrown = error;
        }
        if (go) {
          passed = line as HeldStep;
          stdin.write("c");
          awaitLine(`after ${line}`);
        } else {
          beginStopping();
        }
      }
    });
    stderr.on("data", (chunk: Buffer) => {
      if (settled || chunk.length === 0) return;
      if (killed !== null && outcome === null) return;
      errors += chunk.toString("utf8");
      if (outcome !== null && !outcome.startsWith("failed ")) violate();
    });
    // The helper did not start (it cannot be executed); a helper that started reports through its exit status instead.
    child.once("error", (error) => {
      if (child.pid !== undefined) return;
      startFailure = error.message;
      settle(null, null, false);
    });
    child.once("close", (status, signal) => settle(status, signal, false));
    if (stop.aborted) beginStopping();
    else awaitLine("while holding its folders");
  });
}

function oneOf<T extends string>(helper: string, outcome: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(outcome)) return outcome as T;
  throw new HeldFileHelperUnavailableError(helper, `it answered ${JSON.stringify(outcome)}, not one of ${allowed.join(", ")}`);
}

/**
 * The helper operations through a given build of the helper and, optionally, shorter bounds: tests run its fault-injecting builds
 * (scripts/build-macos-dir-ops.mjs) and stand-ins for a helper that hangs.
 */
export function _helperFileOperationsForTest(helper: string, bounds?: HelperBounds): HeldFileOperations {
  return helperFileOperations(helper, bounds);
}

function helperFileOperations(helper: string, bounds: HelperBounds = POLICY_BOUNDS): HeldFileOperations {
  const run = (args: readonly string[], proceed: Proceed, stop: AbortSignal, onProgress?: () => void): Promise<string> =>
    runHelper(helper, args, proceed, stop, bounds, onProgress);
  // A copy that ended after `ready` without its outcome may have left its temporary file. It is removed through the chosen folder, held
  // anew and checked to be the same one, unless the helper may still be running; nothing else of that name is touched.
  const removePartialCopy = async (to: HeldDirectory, part: string, ended: HeldFileHelperUnavailableError): Promise<"removed" | "absent" | "left"> => {
    if (ended instanceof HeldFileHelperStalledError && ended.stillRunning) return "left";
    try {
      const removed = oneOf(helper, await run(["--dir-remove", ...directoryArguments(to), part], () => true, UNSTOPPED), ["removed", "absent"] as const);
      return removed;
    } catch (error) {
      log.warn({ error: (error as Error).message }, "the temporary file of a stopped download copy could not be removed");
      return "left";
    }
  };
  return {
    move: async (from, name, to, target, proceed, stop) => oneOf(helper,
      await run(["--dir-rename", ...directoryArguments(from), name, ...directoryArguments(to), target], proceed, stop),
      ["committed", "cancelled", "cross-volume"] as const),
    copy: async (from, name, to, target, part, proceed, stop) => {
      // The temporary file's identity, taken once the helper says it is writing it, so a later cleanup removes only that file.
      let partFile: FileIdentity | null = null;
      const seen = (): void => { partFile ??= identityOf(to, part); };
      const proceedSeeing: Proceed = (step) => {
        if (step === "copied") seen();
        return proceed(step);
      };
      try {
        return oneOf(helper, await run(["--dir-copy", ...directoryArguments(from), name, ...directoryArguments(to), target, part], proceedSeeing, stop, seen),
          ["committed", "cancelled"] as const);
      } catch (error) {
        if (error instanceof HeldFileHelperUnavailableError && error.passed !== null) {
          error.partFile = partFile;
          error.partialCopy = await removePartialCopy(to, part, error);
        }
        throw error;
      }
    },
    remove: async (directory, name, proceed, stop) => oneOf(helper,
      await run(["--dir-remove", ...directoryArguments(directory), name], proceed, stop),
      ["removed", "absent", "cancelled"] as const),
    sweep: async (directory) => Number((await run(["--dir-sweep", ...directoryArguments(directory)], () => true, UNSTOPPED)).slice("swept ".length)),
  };
}
