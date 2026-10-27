// Measured sandbox chain: nested bwrap → bash/socat → apply-seccomp → script → interactive shell.
import { describe, expect, it } from "vitest";
import { findSandboxedShell, parseInnermostNsPid, parseProcStat, sandboxShellOwnProcesses, sandboxTerminalHolders, type OpenFileIdentity, type ProcEntry } from "../shell-process.js";

function entry(pid: number, ppid: number, command: string, extra: Partial<ProcEntry> = {}): ProcEntry {
  return { pid, ppid, command, pgrp: pid, session: pid, ttyNr: 0, tpgid: -1, ...extra };
}

function snapshot(...entries: ProcEntry[]): ReadonlyMap<number, ProcEntry> {
  return new Map(entries.map((e) => [e.pid, e]));
}

const MEASURED = [
  entry(493, 488, "MainThread"),
  entry(517, 493, "socat"),
  entry(538, 493, "bwrap"),
  entry(540, 538, "bwrap"),
  entry(541, 540, "bash"),
  entry(542, 541, "socat"),
  entry(543, 541, "socat"),
  entry(544, 541, "apply-seccomp"),
  entry(545, 544, "apply-seccomp"),
  entry(546, 545, "script"),
  entry(547, 546, "zsh", { ttyNr: 34816, tpgid: 547, session: 547 }),
];

describe("findSandboxedShell", () => {
  it("follows the wrap's one chain to the shell under the pty relay", () => {
    const found = findSandboxedShell(snapshot(...MEASURED), 538, "zsh");
    expect(found).toMatchObject({ ok: true, shell: { pid: 547, command: "zsh" } });
    expect(found.relay.map((r) => r.pid)).toEqual([546]);
  });

  it("finds the shell while it runs commands: they are its children, below the relay", () => {
    const busy = snapshot(...MEASURED, entry(600, 547, "sleep"), entry(601, 547, "zsh"));
    expect(findSandboxedShell(busy, 538, "zsh")).toMatchObject({ ok: true, shell: { pid: 547 } });
  });

  it.each([538, 540, 544, 545])("refuses an orphan reparented to wrapper %i regardless of its program name", (parent) => {
    for (const command of ["reader", "socat"]) {
      const orphan = entry(600, parent, command, { ttyNr: 34816, pgrp: 547, session: 547, tpgid: 547 });
      expect(findSandboxedShell(snapshot(...MEASURED, orphan), 538, "zsh")).toMatchObject({ ok: false });
    }
  });

  it("exempts only bridge pids at the verified outer launcher, without trusting their names", () => {
    const renamed = MEASURED.map((process) => process.pid === 542 ? { ...process, command: "bridge" } : process);
    expect(findSandboxedShell(snapshot(...renamed), 538, "zsh")).toMatchObject({ ok: true, busyProcesses: [] });
    const misplaced = snapshot(...MEASURED, entry(600, 546, "socat"));
    expect(findSandboxedShell(misplaced, 538, "zsh")).toMatchObject({ ok: false });
  });

  it.each(["reader", "socat"])("marks an independently parented %s in the shell's foreground group as busy", (command) => {
    const peer = entry(600, 1, command, { ttyNr: 34816, pgrp: 547, session: 547, tpgid: 547 });
    expect(findSandboxedShell(snapshot(...MEASURED, peer), 538, "zsh")).toMatchObject({ ok: true, busyProcesses: [peer] });
  });

  it("marks another group in the shell's terminal session as busy", () => {
    const peer = entry(600, 1, "reader", { ttyNr: 34816, pgrp: 600, session: 547, tpgid: 547 });
    expect(findSandboxedShell(snapshot(...MEASURED, peer), 538, "zsh")).toMatchObject({ ok: true, busyProcesses: [peer] });
  });

  it("does not confuse another terminal's matching device number with the shell's session", () => {
    const unrelated = entry(600, 1, "reader", { ttyNr: 34816, pgrp: 600, session: 600, tpgid: 600 });
    expect(findSandboxedShell(snapshot(...MEASURED, unrelated), 538, "zsh")).toMatchObject({ ok: true, busyProcesses: [] });
  });

  it("follows util-linux before 2.35, whose script forks itself once", () => {
    const old = snapshot(...MEASURED.slice(0, -1), entry(548, 546, "script"), entry(547, 548, "zsh"));
    const found = findSandboxedShell(old, 538, "zsh");
    expect(found).toMatchObject({ ok: true, shell: { pid: 547 } });
    expect(found.relay.map((r) => r.pid)).toEqual([546, 548]);
  });

  it("follows a chain without network bridges or the seccomp helper", () => {
    const bare = snapshot(entry(10, 1, "bwrap"), entry(11, 10, "bwrap"), entry(12, 11, "bash"), entry(13, 12, "script"), entry(14, 13, "bash"));
    expect(findSandboxedShell(bare, 10, "bash")).toMatchObject({ ok: true, shell: { pid: 14 } });
  });

  it("reports the relay without a shell while the relay is still starting it", () => {
    const starting = snapshot(...MEASURED.slice(0, -1), entry(547, 546, "sh"));
    const found = findSandboxedShell(starting, 538, "zsh");
    expect(found).toMatchObject({ ok: false, reason: expect.stringContaining('"sh"') });
    expect(found.relay.map((r) => r.pid)).toEqual([546]);
  });

  it("refuses anything but the expected chain", () => {
    // Not the sandbox at all.
    expect(findSandboxedShell(snapshot(...MEASURED), 547, "zsh")).toMatchObject({ ok: false, relay: [] });
    expect(findSandboxedShell(snapshot(...MEASURED), 9999, "zsh")).toMatchObject({ ok: false });
    // A second child where the wrap has one.
    expect(findSandboxedShell(snapshot(...MEASURED, entry(700, 541, "apply-seccomp")), 538, "zsh")).toMatchObject({ ok: false });
    // An unknown process in the chain.
    const foreign = snapshot(...MEASURED.map((e) => (e.pid === 544 ? { ...e, command: "python3" } : e)));
    expect(findSandboxedShell(foreign, 538, "zsh")).toMatchObject({ ok: false, reason: expect.stringContaining("python3") });
    // A second process under the relay.
    expect(findSandboxedShell(snapshot(...MEASURED, entry(701, 546, "zsh")), 538, "zsh")).toMatchObject({ ok: false });
    // Another shell than the terminal's.
    expect(findSandboxedShell(snapshot(...MEASURED), 538, "bash")).toMatchObject({ ok: false });
    // A relay that never comes: the walk is bounded.
    const deep = snapshot(entry(1, 0, "bwrap"), ...Array.from({ length: 12 }, (_, i) => entry(i + 2, i + 1, "bash")));
    expect(findSandboxedShell(deep, 1, "zsh")).toMatchObject({ ok: false, reason: expect.stringMatching(/more wrapper processes/) });
  });
});

describe("/proc parsing", () => {
  it("reads stat fields after a program name holding spaces and parentheses", () => {
    expect(parseProcStat(42, "42 (a b) c)) S 7 42 42 34816 42 4194560 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0")).toEqual({
      pid: 42,
      command: "a b) c)",
      ppid: 7,
      pgrp: 42,
      session: 42,
      ttyNr: 34816,
      tpgid: 42,
    });
    expect(() => parseProcStat(1, "garbage")).toThrow(/expected format/);
  });

  it("takes the innermost NSpid value", () => {
    expect(parseInnermostNsPid("Name:\tzsh\nPid:\t547\nNSpid:\t547\t7\t2\nNSpgid:\t547\t7\t2\n")).toBe(2);
    expect(parseInnermostNsPid("Name:\tzsh\nNSpid:\t547\n")).toBe(547);
    expect(parseInnermostNsPid("Name:\tzsh\n")).toBeNull();
  });
});

describe("sandboxTerminalHolders", () => {
  const TERMINAL: OpenFileIdentity = { dev: 22n, rdev: 34816n, characterDevice: true };
  const OTHER: OpenFileIdentity = { dev: 22n, rdev: 34817n, characterDevice: true };
  const FILE: OpenFileIdentity = { dev: 22n, rdev: 34816n, characterDevice: false };
  const EXEMPT = new Set([546, 547]);
  // A detached process (setsid) reparented inside the sandbox, a peer outside it, and the exempt relay and shell holding the terminal.
  const detached = entry(700, 540, "python3");
  const outside = entry(800, 1, "gpg-agent");
  const snapshot_ = snapshot(...MEASURED, detached, outside);

  it("finds a sandbox process holding the shell's terminal open, only among the sandbox's own processes", async () => {
    const read = async (pid: number) => pid === 700 || pid === 546 || pid === 547 || pid === 800 ? [OTHER, TERMINAL] : [FILE, OTHER];
    const found = await sandboxTerminalHolders(snapshot_, 538, EXEMPT, TERMINAL, read);
    expect(found).toEqual({ holders: [detached], unreadable: null });
  });

  it("does not count a regular file or another terminal with the same numbers", async () => {
    const found = await sandboxTerminalHolders(snapshot_, 538, EXEMPT, TERMINAL, async () => [FILE, OTHER]);
    expect(found).toEqual({ holders: [], unreadable: null });
  });

  it("skips a process that exited while it was read, and refuses one whose open files cannot be read", async () => {
    expect(await sandboxTerminalHolders(snapshot_, 538, EXEMPT, TERMINAL, async (pid) => pid === 700 ? "gone" : [])).toEqual({ holders: [], unreadable: null });
    const denied = await sandboxTerminalHolders(snapshot_, 538, EXEMPT, TERMINAL, async (pid) => pid === 700 ? "denied" : []);
    expect(denied.unreadable).toContain("pid 700");
    // Outside the sandbox nothing is read, so an unreadable host process does not refuse.
    expect(await sandboxTerminalHolders(snapshot_, 538, EXEMPT, TERMINAL, async (pid) => pid === 800 ? "denied" : [])).toEqual({ holders: [], unreadable: null });
  });
});

describe("the shell's own processes in the terminal holder check", () => {
  const TERMINAL: OpenFileIdentity = { dev: 22n, rdev: 34816n, characterDevice: true };
  // Not dumpable (apply-seccomp, bwrap): their open files cannot be read, and they may hold the terminal as the shell's wrappers.
  const LAUNCHER_PIDS = new Set([538, 540, 541, 542, 543, 544, 545]);

  function ownProcesses(...extra: ProcEntry[]) {
    const snap = snapshot(...MEASURED, ...extra);
    const chain = findSandboxedShell(snap, 538, "zsh");
    if (!chain.ok) throw new Error(chain.reason);
    return { snap, own: sandboxShellOwnProcesses(chain) };
  }

  it("names the verified launcher chain, its bridges, the relay and the shell by their place in the chain", () => {
    expect([...ownProcesses().own].sort()).toEqual([538, 540, 541, 542, 543, 544, 545, 546, 547]);
  });

  it("accepts the shell's launcher chain even though its open files cannot be read", async () => {
    const { snap, own } = ownProcesses();
    const read = async (pid: number) => LAUNCHER_PIDS.has(pid) ? "denied" as const : [TERMINAL];
    expect(await sandboxTerminalHolders(snap, 538, own, TERMINAL, read)).toEqual({ holders: [], unreadable: null });
  });

  it("refuses any other sandbox process holding the terminal, and one whose open files cannot be read", async () => {
    // Under a bridge, where the chain walk does not look: a process the shell's wrappers did not start.
    const foreign = entry(700, 542, "python3");
    const { snap, own } = ownProcesses(foreign);
    expect(own.has(700)).toBe(false);
    const holding = await sandboxTerminalHolders(snap, 538, own, TERMINAL, async (pid) => pid === 700 ? [TERMINAL] : "denied");
    expect(holding).toEqual({ holders: [foreign], unreadable: null });
    const unreadable = await sandboxTerminalHolders(snap, 538, own, TERMINAL, async () => "denied");
    expect(unreadable.unreadable).toContain('"python3" (pid 700)');
  });
});
