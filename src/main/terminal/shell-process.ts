/**
 * What the operating system says about a terminal's foreground process: which
 * process holds the terminal for input, what program it is, and the directory
 * it is in. terminal_run checks this before it trusts the shell's own command
 * markers, because markers are text on the terminal's output stream and the
 * operating system's process table is not.
 *
 * The foreground process is the terminal's foreground process group (the
 * process that reads what is typed). At an idle prompt that group is the
 * shell itself, so the group id is the shell's pid.
 *
 * Sources, per platform:
 *  - Linux: `/proc/<pid>/stat` (controlling terminal, foreground group),
 *    `/proc/<pid>/comm` and the `/proc/<pid>/cwd` link.
 *  - macOS: `ps -o tty=,tpgid=` and `ps -o comm=` for the first two. The
 *    working directory of another process is exposed only through
 *    `proc_pidinfo(PROC_PIDVNODEPATHINFO)`, which Node cannot call without a
 *    native addon; `lsof -d cwd` is the stock, unprivileged reader of that
 *    same call, so it is used here.
 *  - Anything else: no reading, and callers refuse (they never assume).
 *
 * The sandboxed Linux terminal is read differently
 * ({@link readSandboxedShell}): bubblewrap starts the sandbox in a new session
 * (`--new-session`), so nothing inside it holds the pty node-pty opened, and
 * the shell runs on a pty of its own that util-linux `script` opens inside the
 * sandbox (terminal-inner-pty.ts). The shell is found by walking the process
 * tree down from the pty's process, and its foreground group is the one of
 * that inner pty.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { basename } from "node:path";

interface TerminalForeground {
  /** The foreground process group id: the shell's pid when the shell holds the terminal. */
  readonly pid: number;
  /** Program name of that process, without a login shell's leading `-`. */
  readonly command: string;
  /** Its working directory, as the operating system resolves it. */
  readonly cwd: string;
}

export type TerminalForegroundReading =
  | { readonly ok: true; readonly foreground: TerminalForeground }
  | { readonly ok: false; readonly reason: string };

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

/** Fields after the `(comm)` of `/proc/<pid>/stat`, which may itself hold spaces and parentheses. */
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
  // Check every task: a child can be owned by a non-leader thread.
  for (const task of leader.tpgid === ptyPid ? await readdir(`/proc/${ptyPid}/task`) : []) {
    const children = await readFile(`/proc/${ptyPid}/task/${task}/children`, "utf-8");
    if (children.trim()) return { ok: false, reason: "the terminal shell has child processes" };
  }
  const command = programName(await readFile(`/proc/${leader.tpgid}/comm`, "utf-8"));
  const cwd = await readlink(`/proc/${leader.tpgid}/cwd`);
  return { ok: true, foreground: { pid: leader.tpgid, command, cwd } };
}

async function readDarwin(ptyPid: number): Promise<TerminalForegroundReading> {
  const [ttyRaw, tpgidRaw] = (await run("/bin/ps", ["-o", "tty=,tpgid=", "-p", String(ptyPid)])).trim().split(/\s+/u);
  const tpgid = Number(tpgidRaw);
  if (!ttyRaw || !(tpgid > 0)) return { ok: false, reason: "the terminal has no foreground process" };
  const [fgTty, ...commParts] = (await run("/bin/ps", ["-o", "tty=,comm=", "-p", String(tpgid)])).trim().split(/\s+/u);
  if (fgTty !== ttyRaw) return { ok: false, reason: "the foreground process is on another terminal" };
  const table = await run("/bin/ps", ["-axo", "ppid="]);
  if (tpgid === ptyPid && table.split(/\s+/u).some((parent) => Number(parent) === ptyPid)) {
    return { ok: false, reason: "the terminal shell has child processes" };
  }
  const command = programName(commParts.join(" "));
  // `-Fn`: one `n<path>` line for the cwd descriptor; `-a` ANDs the filters.
  const listing = await run("/usr/sbin/lsof", ["-a", "-n", "-P", "-w", "-p", String(tpgid), "-d", "cwd", "-Fn"]);
  const cwd = listing.split("\n").find((line) => line.startsWith("n"))?.slice(1);
  if (!cwd) return { ok: false, reason: "the operating system did not report the foreground process's directory" };
  return { ok: true, foreground: { pid: tpgid, command, cwd } };
}

/**
 * Read the foreground process of the terminal whose session leader (the
 * process spawned on it) is `ptyPid`. Never throws: an unreadable process
 * table is a reason, and the caller refuses.
 */
export async function readTerminalForeground(ptyPid: number): Promise<TerminalForegroundReading> {
  try {
    if (process.platform === "linux") return await readLinux(ptyPid);
    if (process.platform === "darwin") return await readDarwin(ptyPid);
    return { ok: false, reason: `the shell's directory cannot be read from the operating system on ${process.platform}` };
  } catch (error) {
    return { ok: false, reason: `the terminal's process could not be read (${(error as Error).message.split("\n")[0]})` };
  }
}

/** One process as `/proc/<pid>/stat` reports it (pids as the host sees them). */
export interface ProcEntry {
  readonly pid: number;
  readonly ppid: number;
  /** `comm`: the program name, at most 15 bytes. */
  readonly command: string;
  readonly pgrp: number;
  readonly session: number;
  /** The controlling terminal's device number; 0 when the process has none. */
  readonly ttyNr: number;
  /** The foreground process group of that terminal; -1 when there is none. */
  readonly tpgid: number;
}

/** Parse `/proc/<pid>/stat`; the `(comm)` field may itself hold spaces and parentheses. */
export function parseProcStat(pid: number, text: string): ProcEntry {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) throw new Error(`/proc/${pid}/stat is not in the expected format`);
  // state ppid pgrp session tty_nr tpgid …
  const fields = text.slice(close + 2).split(" ");
  return {
    pid,
    command: text.slice(open + 1, close),
    ppid: Number(fields[1]),
    pgrp: Number(fields[2]),
    session: Number(fields[3]),
    ttyNr: Number(fields[4]),
    tpgid: Number(fields[5]),
  };
}

/** Every process visible in `/proc` at one moment; a process that exits while it is read is left out. */
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

/**
 * The processes the sandbox wrap puts between the pty's process and the pty
 * relay, by program name: bubblewrap (the outer process and its pid-namespace
 * init), the sandbox runtime's `bash -c` script, and `apply-seccomp` (which
 * forks once more into its own pid namespace). The outer script also starts
 * proxy bridges, outside the inner reaper's namespace.
 */
const SANDBOX_WRAPPERS: ReadonlySet<string> = new Set(["bwrap", "bash", "apply-seccomp"]);
/** util-linux `script(1)`, which gives the shell its pty inside the sandbox. */
const INNER_PTY_RELAY = "script";
/** Bound on the wrapper chain; the measured chain has five wrappers. */
const MAX_SANDBOX_WRAPPERS = 8;

export type SandboxedShellChain =
  | {
      readonly ok: true;
      /** The pty relay: one `script` process, or two for util-linux before 2.35, which forks itself once. */
      readonly relay: readonly ProcEntry[];
      readonly shell: ProcEntry;
      /** Shell children and other processes sharing its terminal session or foreground group. */
      readonly busyProcesses: readonly ProcEntry[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** The relay when the walk reached it (the shell may not have started yet). */
      readonly relay: readonly ProcEntry[];
    };

/**
 * Find the terminal's shell in a process snapshot, walking down from the
 * pty's process along the one chain the sandbox wrap builds:
 * `bwrap → bwrap → bash (+ socat) → apply-seccomp → apply-seccomp → script →
 * <shell>`. Every step must have exactly one child except the verified outer
 * bridge launcher (`bwrap → bwrap → bash`). Its side children are identified
 * by their parent and pid, never their program name. Shell descendants cannot
 * be reparented to that launcher: namespace orphans go to a reaper instead.
 * Every wrapper must be one of {@link SANDBOX_WRAPPERS}, and
 * the relay's one child must be the shell, by name. Nothing the shell starts
 * can appear above it, so a program in the terminal cannot pose as the shell
 * here; a nested shell is a child of the shell, not of the relay.
 */
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
  for (let depth = 0; ; depth++) {
    if (depth >= MAX_SANDBOX_WRAPPERS) return fail("the terminal's sandbox has more wrapper processes than expected");
    const children = childrenOf(node.pid);
    let next = children;
    if (depth === 2 && node.command === "bash" && node.ppid === outerReaperPid) {
      // Only this launcher has side bridges. Nothing under either reaper or
      // a later wrapper is exempt, even if it adopts a bridge's program name.
      const continuation = children.filter((child) => child.command === "apply-seccomp" || child.command === INNER_PTY_RELAY);
      if (continuation.length !== 1) return fail(`the sandbox bridge launcher has no unique continuation among ${children.map((child) => JSON.stringify(child.command)).join(", ")}`);
      const bridgePids = new Set(children.filter((child) => child.pid !== continuation[0]!.pid).map((child) => child.pid));
      next = children.filter((child) => !bridgePids.has(child.pid));
    }
    if (next.length !== 1) return fail(`the sandbox process ${JSON.stringify(node.command)} has ${next.length} children where one was expected`);
    node = next[0]!;
    if (depth === 0 && node.command === "bwrap") outerReaperPid = node.pid;
    if (node.command === INNER_PTY_RELAY) break;
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
  return { ok: true, relay, shell, busyProcesses };
}

/** What the operating system says about a sandboxed Linux terminal's shell ({@link readSandboxedShell}). */
interface SandboxedShell {
  /** The shell's pid, as the host sees it. */
  readonly pid: number;
  /** Its pid in its own (innermost) pid namespace: what `$$` is inside the shell. */
  readonly nsPid: number;
  readonly command: string;
  /** The foreground process group of the shell's own terminal, and that group leader's program when it is known. */
  readonly foreground: { readonly pgid: number; readonly command: string | null };
  /** Shell children or other processes sharing its terminal session or foreground group. */
  readonly children: readonly { readonly pid: number; readonly command: string }[];
  /** The shell's working directory as the link names it (for messages; not compared). */
  readonly cwd: string;
  /**
   * Whether the shell's working directory is the very directory the reported
   * path names on the host: same device and inode. False when that path does
   * not exist outside the sandbox.
   */
  readonly cwdIsReported: boolean;
}

export type SandboxedShellReading =
  | { readonly ok: true; readonly shell: SandboxedShell }
  | { readonly ok: false; readonly reason: string };

/** The last `NSpid` value in `/proc/<pid>/status`: the pid in the process's own namespace. */
export function parseInnermostNsPid(status: string): number | null {
  const line = status.split("\n").find((entry) => entry.startsWith("NSpid:"));
  const last = line?.slice("NSpid:".length).trim().split(/\s+/u).at(-1);
  return last !== undefined && /^[0-9]+$/u.test(last) ? Number(last) : null;
}

async function directoryIdentity(path: string): Promise<{ dev: bigint; ino: bigint } | null> {
  try {
    const entry = await stat(path, { bigint: true });
    return entry.isDirectory() ? { dev: entry.dev, ino: entry.ino } : null;
  } catch {
    return null;
  }
}

/**
 * Read the shell of a sandboxed Linux terminal whose pty's process is
 * `ptyPid`: found by {@link findSandboxedShell}, with its namespace pid, its
 * terminal's foreground group, its children and whether its working
 * directory is the one at `reportedCwd` on the host. The directory is
 * compared by device and inode, not by path: the sandbox can mount a
 * directory of its own (a tmpfs over a read-denied one) at a path that also
 * exists on the host. Never throws: an unreadable process table is a reason,
 * and the caller refuses.
 */
export async function readSandboxedShell(ptyPid: number, shellName: string, reportedCwd: string): Promise<SandboxedShellReading> {
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
    // The shell must still be the process the snapshot found (same parent,
    // same program) once everything about it has been read.
    const after = parseProcStat(shell.pid, await readFile(`/proc/${shell.pid}/stat`, "utf-8"));
    if (after.ppid !== shell.ppid || after.command !== shell.command || after.tpgid !== shell.tpgid) {
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
        cwd,
        cwdIsReported: reported !== null && reported.dev === actual.dev && reported.ino === actual.ino,
      },
    };
  } catch (error) {
    return { ok: false, reason: `the terminal's process could not be read (${(error as Error).message.split("\n")[0]})` };
  }
}

/**
 * Tell a sandboxed Linux terminal's pty relay that its outer terminal was
 * resized, so it copies the new size to the shell's pty (the relay is in
 * another session, so the kernel's own SIGWINCH never reaches it). Returns
 * false when the relay is not running yet: it reads the size when it starts.
 * SIGWINCH is ignored by default, so a signal that reached a reused pid would
 * do nothing.
 */
export async function forwardResizeToSandboxedPtyRelay(ptyPid: number, shellName: string): Promise<boolean> {
  const chain = findSandboxedShell(await readProcSnapshot(), ptyPid, shellName);
  if (chain.relay.length === 0) return false;
  for (const relay of chain.relay) process.kill(relay.pid, "SIGWINCH");
  return true;
}
