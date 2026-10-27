// Verify shell markers against OS foreground process state before terminal_run trusts them.
// On macOS, lsof reads cwd without a native addon; unsupported platforms fail closed.
// Sandboxed Linux shells own an inner PTY, so discover the shell through the process tree rather than the outer foreground group.
import { execFile } from "node:child_process";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { basename } from "node:path";
import { sameFileIdentity, type FileIdentity } from "../../lib/file-identity.js";

interface TerminalForeground {
  // The foreground process group id: the shell's pid when the shell holds the terminal.
  readonly pid: number;
  // Program name of that process, without a login shell's leading `-`.
  readonly command: string;
  // Its working directory, as the operating system resolves it.
  readonly cwd: string;
}

// `busy`: the reading succeeded and found another process sharing the terminal (a command still finishing, a background job, or an orphan that kept the
// terminal), so whatever it writes would land in the next command's output.
export type TerminalForegroundReading =
  | { readonly ok: true; readonly foreground: TerminalForeground }
  | { readonly ok: false; readonly reason: string; readonly busy?: true };

export interface TerminalForegroundOptions {
  // Also require that no other process holds the terminal's device open: lsof on macOS, the sandbox's open files on Linux
  // ({@link readSandboxedShell}). Slower, so callers ask for it only at the last check before Enter.
  readonly exclusive?: boolean;
}

const PROBE_TIMEOUT_MS = 3_000;

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: PROBE_TIMEOUT_MS, encoding: "utf-8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" } }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function programName(raw: string): string {
  return basename(raw.trim()).replace(/^-/u, "");
}

// Fields after the `(comm)` of `/proc/<pid>/stat`, which may itself hold spaces and parentheses.
async function linuxStat(pid: number): Promise<{ ttyNr: number; tpgid: number }> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf-8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // state ppid pgrp session tty_nr tpgid …
  return { ttyNr: Number(fields[4]), tpgid: Number(fields[5]) };
}

async function readLinux(ptyPid: number): Promise<TerminalForegroundReading> {
  const leader = await linuxStat(ptyPid);
  if (!(leader.tpgid > 0)) return { ok: false, reason: "the terminal has no foreground process" };
  const foreground = await linuxStat(leader.tpgid);
  if (foreground.ttyNr !== leader.ttyNr) return { ok: false, reason: "the foreground process is on another terminal" };
  if (leader.tpgid === ptyPid) {
    // Check every task: a child can be owned by a non-leader thread.
    for (const task of await readdir(`/proc/${ptyPid}/task`)) {
      const children = await readFile(`/proc/${ptyPid}/task/${task}/children`, "utf-8");
      if (children.trim()) return { ok: false, reason: "the terminal shell has child processes", busy: true };
    }
    // An orphaned background job is no longer the shell's child but keeps the terminal as its own and can still write to it.
    const sharing = [...(await readProcSnapshot()).values()].filter((entry) => entry.pid !== ptyPid && entry.ttyNr === leader.ttyNr);
    if (sharing.length > 0) return { ok: false, reason: sharingReason(sharing), busy: true };
  }
  const command = programName(await readFile(`/proc/${leader.tpgid}/comm`, "utf-8"));
  const cwd = await readlink(`/proc/${leader.tpgid}/cwd`);
  return { ok: true, foreground: { pid: leader.tpgid, command, cwd } };
}

async function readDarwin(ptyPid: number, options: TerminalForegroundOptions): Promise<TerminalForegroundReading> {
  const [ttyRaw, tpgidRaw] = (await run("/bin/ps", ["-o", "tty=,tpgid=", "-p", String(ptyPid)])).trim().split(/\s+/u);
  const tpgid = Number(tpgidRaw);
  if (!ttyRaw || !(tpgid > 0)) return { ok: false, reason: "the terminal has no foreground process" };
  const [fgTty, ...commParts] = (await run("/bin/ps", ["-o", "tty=,comm=", "-p", String(tpgid)])).trim().split(/\s+/u);
  if (fgTty !== ttyRaw) return { ok: false, reason: "the foreground process is on another terminal" };
  if (tpgid === ptyPid) {
    // `comm` last: it may hold spaces.
    const table = (await run("/bin/ps", ["-axo", "pid=,ppid=,tty=,comm="])).split("\n").flatMap((line) => {
      const [pid, ppid, tty, ...comm] = line.trim().split(/\s+/u);
      return pid ? [{ pid: Number(pid), ppid: Number(ppid), tty, command: programName(comm.join(" ")) }] : [];
    });
    if (table.some((entry) => entry.ppid === ptyPid)) return { ok: false, reason: "the terminal shell has child processes", busy: true };
    // An orphaned background job is no longer the shell's child but keeps the terminal as its own and can still write to it.
    const sharing = table.filter((entry) => entry.pid !== ptyPid && entry.tty === ttyRaw);
    if (sharing.length > 0) return { ok: false, reason: sharingReason(sharing), busy: true };
    if (options.exclusive) {
      // A process that left the terminal's session (setsid) can still hold its device open. The host process holds it as the pty's owner.
      const holders = (await run("/usr/sbin/lsof", ["-w", "-t", `/dev/${ttyRaw}`])).split("\n").map(Number)
        .filter((pid) => pid > 0 && pid !== ptyPid && pid !== process.pid);
      if (holders.length > 0) {
        return { ok: false, reason: `another process holds the terminal open (pid ${holders.join(", ")})`, busy: true };
      }
    }
  }
  const command = programName(commParts.join(" "));
  // `-Fn`: one `n<path>` line for the cwd descriptor; `-a` ANDs the filters.
  const listing = await run("/usr/sbin/lsof", ["-a", "-n", "-P", "-w", "-p", String(tpgid), "-d", "cwd", "-Fn"]);
  const cwd = listing.split("\n").find((line) => line.startsWith("n"))?.slice(1);
  if (!cwd) return { ok: false, reason: "the operating system did not report the foreground process's directory" };
  return { ok: true, foreground: { pid: tpgid, command, cwd } };
}

function sharingReason(sharing: readonly { readonly pid: number; readonly command: string }[]): string {
  return `other processes share the terminal (${sharing.map(({ pid, command }) => `${JSON.stringify(command)} pid ${pid}`).join(", ")}): a command still finishing or a background job`;
}

// Read the foreground process of the terminal whose session leader (the process spawned on it) is `ptyPid`. Never throws: an unreadable process table is
// a reason, and the caller refuses.
export async function readTerminalForeground(ptyPid: number, options: TerminalForegroundOptions = {}): Promise<TerminalForegroundReading> {
  try {
    if (process.platform === "linux") return await readLinux(ptyPid);
    if (process.platform === "darwin") return await readDarwin(ptyPid, options);
    return { ok: false, reason: `the shell's directory cannot be read from the operating system on ${process.platform}` };
  } catch (error) {
    return { ok: false, reason: `the terminal's process could not be read (${(error as Error).message.split("\n")[0]})` };
  }
}

// One process as `/proc/<pid>/stat` reports it (pids as the host sees them).
export interface ProcEntry {
  readonly pid: number;
  readonly ppid: number;
  // `comm`: the program name, at most 15 bytes.
  readonly command: string;
  readonly pgrp: number;
  readonly session: number;
  // The controlling terminal's device number; 0 when the process has none.
  readonly ttyNr: number;
  // The foreground process group of that terminal; -1 when there is none.
  readonly tpgid: number;
  // When the process started, in clock ticks after boot: with the pid, it names one process even after the pid is reused.
  readonly starttime: number;
}

// Parse `/proc/<pid>/stat`; the `(comm)` field may itself hold spaces and parentheses.
export function parseProcStat(pid: number, text: string): ProcEntry {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) throw new Error(`/proc/${pid}/stat is not in the expected format`);
  // state ppid pgrp session tty_nr tpgid … (fields 3 to 8), then starttime at field 22.
  const fields = text.slice(close + 2).split(" ");
  const starttime = Number(fields[19]);
  if (!Number.isSafeInteger(starttime) || starttime < 0) throw new Error(`/proc/${pid}/stat has no start time`);
  return {
    pid,
    command: text.slice(open + 1, close),
    ppid: Number(fields[1]),
    pgrp: Number(fields[2]),
    session: Number(fields[3]),
    ttyNr: Number(fields[4]),
    tpgid: Number(fields[5]),
    starttime,
  };
}

// Every process visible in `/proc` at one moment; a process that exits while it is read is left out.
async function readProcSnapshot(): Promise<ReadonlyMap<number, ProcEntry>> {
  const pids = (await readdir("/proc")).filter((name) => /^[0-9]+$/u.test(name)).map(Number);
  const entries = await Promise.all(pids.map(async (pid) => {
    try {
      return parseProcStat(pid, await readFile(`/proc/${pid}/stat`, "utf-8"));
    } catch {
      return null;
    }
  }));
  return new Map(entries.filter((entry): entry is ProcEntry => entry !== null).map((entry) => [entry.pid, entry]));
}

// Recognize only the fixed sandbox wrapper chain; outer proxy bridges live outside the inner reaper namespace.
const SANDBOX_WRAPPERS: ReadonlySet<string> = new Set(["bwrap", "bash", "apply-seccomp"]);
// util-linux `script(1)`, which gives the shell its pty inside the sandbox.
const INNER_PTY_RELAY = "script";
// Bound on the wrapper chain; the measured chain has five wrappers.
const MAX_SANDBOX_WRAPPERS = 8;

export type SandboxedShellChain =
  | {
      readonly ok: true;
      // The pty relay: one `script` process, or two for util-linux before 2.35, which forks itself once.
      readonly relay: readonly ProcEntry[];
      readonly shell: ProcEntry;
      // The verified launcher chain from the spawned pty process down to the relay, with the bridges of its outer launcher: the shell's own wrappers,
      // identified by their place in that chain, never by name.
      readonly launcher: readonly ProcEntry[];
      // Shell children and other processes sharing its terminal session or foreground group.
      readonly busyProcesses: readonly ProcEntry[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      // The relay when the walk reached it (the shell may not have started yet).
      readonly relay: readonly ProcEntry[];
    };

// Walk the fixed wrapper chain to the relay’s single shell child; permit side bridges only under the verified outer launcher.
// Identify those children by parent and PID so terminal programs cannot impersonate wrappers or the shell.
export function findSandboxedShell(
  snapshot: ReadonlyMap<number, ProcEntry>,
  ptyPid: number,
  shellName: string,
): SandboxedShellChain {
  const childrenOf = (pid: number): ProcEntry[] => [...snapshot.values()].filter((entry) => entry.ppid === pid);
  const fail = (reason: string, relay: readonly ProcEntry[] = []): SandboxedShellChain => ({ ok: false, reason, relay });
  const top = snapshot.get(ptyPid);
  if (top === undefined || top.command !== "bwrap") return fail("the terminal's sandbox is not running");
  let node: ProcEntry = top;
  let outerReaperPid: number | undefined;
  const launcher: ProcEntry[] = [top];
  for (let depth = 0; ; depth++) {
    if (depth >= MAX_SANDBOX_WRAPPERS) return fail("the terminal's sandbox has more wrapper processes than expected");
    const children = childrenOf(node.pid);
    let next = children;
    if (depth === 2 && node.command === "bash" && node.ppid === outerReaperPid) {
      // Only this launcher has side bridges. Nothing under either reaper or a later wrapper is exempt, even if it adopts a bridge's program name.
      const continuation = children.filter((child) => child.command === "apply-seccomp" || child.command === INNER_PTY_RELAY);
      if (continuation.length !== 1) return fail(`the sandbox bridge launcher has no unique continuation among ${children.map((child) => JSON.stringify(child.command)).join(", ")}`);
      const bridgePids = new Set(children.filter((child) => child.pid !== continuation[0]!.pid).map((child) => child.pid));
      launcher.push(...children.filter((child) => bridgePids.has(child.pid)));
      next = children.filter((child) => !bridgePids.has(child.pid));
    }
    if (next.length !== 1) return fail(`the sandbox process ${JSON.stringify(node.command)} has ${next.length} children where one was expected`);
    node = next[0]!;
    if (depth === 0 && node.command === "bwrap") outerReaperPid = node.pid;
    if (node.command === INNER_PTY_RELAY) break;
    launcher.push(node);
    if (!SANDBOX_WRAPPERS.has(node.command)) return fail(`unexpected process ${JSON.stringify(node.command)} in the terminal's sandbox`);
  }
  const relay: ProcEntry[] = [node];
  let below = childrenOf(node.pid);
  if (below.length === 1 && below[0]!.command === INNER_PTY_RELAY) {
    relay.push(below[0]!);
    below = childrenOf(below[0]!.pid);
  }
  if (below.length !== 1) return fail(`the terminal's pty relay has ${below.length} children where one shell was expected`, relay);
  const shell = below[0]!;
  if (shell.command !== shellName) {
    return fail(`the terminal's pty relay runs ${JSON.stringify(shell.command)}, not its ${shellName} shell`, relay);
  }
  const busyProcesses = [...snapshot.values()].filter((entry) => entry.pid !== shell.pid && (
    entry.ppid === shell.pid
    || (shell.ttyNr !== 0 && entry.ttyNr === shell.ttyNr && (entry.session === shell.session || entry.pgrp === shell.tpgid))
  ));
  return { ok: true, relay, shell, launcher, busyProcesses };
}

// What the operating system says about a sandboxed Linux terminal's shell ({@link readSandboxedShell}).
interface SandboxedShell {
  // The shell's pid, as the host sees it.
  readonly pid: number;
  // Its pid in its own (innermost) pid namespace: what `$$` is inside the shell.
  readonly nsPid: number;
  readonly command: string;
  // The foreground process group of the shell's own terminal, and that group leader's program when it is known.
  readonly foreground: { readonly pgid: number; readonly command: string | null };
  // Shell children or other processes sharing its terminal session or foreground group.
  readonly children: readonly { readonly pid: number; readonly command: string }[];
  // With `exclusive`: other processes in the sandbox that hold the shell's terminal open, or why that could not be read.
  readonly holders: readonly { readonly pid: number; readonly command: string }[];
  readonly holdersUnreadable: string | null;
  // The shell's working directory as the link names it (for messages; not compared).
  readonly cwd: string;
  // Whether the shell's working directory is the very directory the reported path names on the host: same device and inode. False when that path does not
  // exist outside the sandbox.
  readonly cwdIsReported: boolean;
}

export type SandboxedShellReading =
  | { readonly ok: true; readonly shell: SandboxedShell }
  | { readonly ok: false; readonly reason: string };

// The last `NSpid` value in `/proc/<pid>/status`: the pid in the process's own namespace.
export function parseInnermostNsPid(status: string): number | null {
  const line = status.split("\n").find((entry) => entry.startsWith("NSpid:"));
  const last = line?.slice("NSpid:".length).trim().split(/\s+/u).at(-1);
  return last !== undefined && /^[0-9]+$/u.test(last) ? Number(last) : null;
}

async function directoryIdentity(path: string): Promise<FileIdentity | null> {
  try {
    const entry = await stat(path, { bigint: true });
    return entry.isDirectory() ? { dev: entry.dev, ino: entry.ino } : null;
  } catch {
    return null;
  }
}

// One open file's identity, as stat reports it through /proc/<pid>/fd.
export interface OpenFileIdentity {
  readonly dev: bigint;
  readonly rdev: bigint;
  readonly characterDevice: boolean;
}

// Every process in the sandbox (descendants of `ptyPid`) other than `exempt` that holds the terminal `terminal` open. A process that exits while it is read is
// left out; one whose descriptors cannot be read makes the whole answer unreadable (refused, never assumed clean). Exemption is by pid, so once the scan
// is done every exempt pid must still name the process the snapshot found (same start time, parent and program): a reused pid refuses.
export async function sandboxTerminalHolders(
  snapshot: ReadonlyMap<number, ProcEntry>,
  ptyPid: number,
  exempt: ReadonlySet<number>,
  terminal: OpenFileIdentity,
  openFiles: (pid: number) => Promise<readonly OpenFileIdentity[] | "gone" | "denied">,
  currentProcess: (pid: number) => Promise<ProcEntry | "gone">,
): Promise<{ readonly holders: ProcEntry[]; readonly unreadable: string | null }> {
  const inside = new Set<number>([ptyPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of snapshot.values()) {
      if (!inside.has(entry.pid) && inside.has(entry.ppid)) { inside.add(entry.pid); grew = true; }
    }
  }
  const holders: ProcEntry[] = [];
  for (const pid of inside) {
    if (exempt.has(pid)) continue;
    const files = await openFiles(pid);
    if (files === "gone") continue;
    if (files === "denied") return { holders, unreadable: `the open files of ${JSON.stringify(snapshot.get(pid)?.command ?? "unknown")} (pid ${pid}) could not be read` };
    if (files.some((file) => file.characterDevice && file.dev === terminal.dev && file.rdev === terminal.rdev)) holders.push(snapshot.get(pid)!);
  }
  for (const pid of exempt) {
    const found = snapshot.get(pid);
    const current = await currentProcess(pid);
    if (found === undefined || current === "gone" || current.starttime !== found.starttime || current.ppid !== found.ppid || current.command !== found.command) {
      return { holders, unreadable: `the shell's own process ${JSON.stringify(found?.command ?? "unknown")} (pid ${pid}) changed while the terminal was checked` };
    }
  }
  return { holders, unreadable: null };
}

// The processes that are the shell itself or its verified wrappers (launcher chain, bridges, pty relay). Every other sandbox process holding the terminal,
// readable or not, refuses.
export function sandboxShellOwnProcesses(chain: Extract<SandboxedShellChain, { ok: true }>): ReadonlySet<number> {
  return new Set([chain.shell.pid, ...chain.relay.map((relay) => relay.pid), ...chain.launcher.map((process) => process.pid)]);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function openFileIdentity(path: string): Promise<OpenFileIdentity> {
  const entry = await stat(path, { bigint: true });
  return { dev: entry.dev, rdev: entry.rdev, characterDevice: entry.isCharacterDevice() };
}

async function procCurrentProcess(pid: number): Promise<ProcEntry | "gone"> {
  try {
    return parseProcStat(pid, await readFile(`/proc/${pid}/stat`, "utf-8"));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ESRCH") return "gone";
    throw error;
  }
}

async function procOpenFiles(pid: number): Promise<readonly OpenFileIdentity[] | "gone" | "denied"> {
  let fds: string[];
  try {
    fds = await readdir(`/proc/${pid}/fd`);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ESRCH") return "gone";
    if (code === "EACCES" || code === "EPERM") return "denied";
    throw error;
  }
  const files: OpenFileIdentity[] = [];
  for (const fd of fds) {
    try {
      files.push(await openFileIdentity(`/proc/${pid}/fd/${fd}`));
    } catch (error) {
      const code = errorCode(error);
      // A descriptor closed while it was read; anything else (a denied one) is not proof it is not the terminal.
      if (code === "ENOENT" || code === "ESRCH") continue;
      if (code === "EACCES" || code === "EPERM") return "denied";
      throw error;
    }
  }
  return files;
}

// Compare reported cwd by device/inode because sandbox mounts can reuse host path names; unreadable process state returns refusal.
export async function readSandboxedShell(ptyPid: number, shellName: string, reportedCwd: string, options: TerminalForegroundOptions = {}): Promise<SandboxedShellReading> {
  try {
    const snapshot = await readProcSnapshot();
    const chain = findSandboxedShell(snapshot, ptyPid, shellName);
    if (!chain.ok) return { ok: false, reason: chain.reason };
    const { shell } = chain;
    const nsPid = parseInnermostNsPid(await readFile(`/proc/${shell.pid}/status`, "utf-8"));
    if (nsPid === null) return { ok: false, reason: "the operating system did not report the shell's namespace pid" };
    const [actual, reported, cwd] = await Promise.all([
      directoryIdentity(`/proc/${shell.pid}/cwd`),
      directoryIdentity(reportedCwd),
      readlink(`/proc/${shell.pid}/cwd`),
    ]);
    if (actual === null) return { ok: false, reason: "the operating system did not report the shell's directory" };
    // A process that left the shell's session can still hold its terminal open. The shell's standard input is its terminal.
    let holders: { readonly holders: ProcEntry[]; readonly unreadable: string | null } = { holders: [], unreadable: null };
    if (options.exclusive) {
      const terminal = await openFileIdentity(`/proc/${shell.pid}/fd/0`);
      holders = terminal.characterDevice
        ? await sandboxTerminalHolders(snapshot, ptyPid, sandboxShellOwnProcesses(chain), terminal, procOpenFiles, procCurrentProcess)
        : { holders: [], unreadable: "the shell's input is not a terminal" };
    }
    // The shell must still be the process the snapshot found (same parent, same program) once everything about it has been read.
    const after = parseProcStat(shell.pid, await readFile(`/proc/${shell.pid}/stat`, "utf-8"));
    if (after.starttime !== shell.starttime || after.ppid !== shell.ppid || after.command !== shell.command || after.tpgid !== shell.tpgid) {
      return { ok: false, reason: "the terminal's shell changed while it was being checked" };
    }
    return {
      ok: true,
      shell: {
        pid: shell.pid,
        nsPid,
        command: shell.command,
        foreground: { pgid: shell.tpgid, command: snapshot.get(shell.tpgid)?.command ?? null },
        children: chain.busyProcesses.map(({ pid, command }) => ({ pid, command })),
        holders: holders.holders.map(({ pid, command }) => ({ pid, command })),
        holdersUnreadable: holders.unreadable,
        cwd,
        cwdIsReported: reported !== null && sameFileIdentity(reported, actual),
      },
    };
  } catch (error) {
    return { ok: false, reason: `the terminal's process could not be read (${(error as Error).message.split("\n")[0]})` };
  }
}

// Forward resize to the inner relay’s separate session; before it starts, no signal is needed because it reads size at startup.
export async function forwardResizeToSandboxedPtyRelay(ptyPid: number, shellName: string): Promise<boolean> {
  const chain = findSandboxedShell(await readProcSnapshot(), ptyPid, shellName);
  if (chain.relay.length === 0) return false;
  for (const relay of chain.relay) process.kill(relay.pid, "SIGWINCH");
  return true;
}
