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
 */
import { execFile } from "node:child_process";
import { readFile, readlink, readdir } from "node:fs/promises";
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
