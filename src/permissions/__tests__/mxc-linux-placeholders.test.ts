import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.js";
import { launcherPathFor } from "../mxc-launcher.js";
import { holdMxcLinuxPlaceholders, sweepMxcLinuxPlaceholders, takeMxcLinuxPlaceholderRecoveryNotice } from "../mxc-linux-placeholders.js";
import { posixPolicyLookups, rankPosixContainerRows, type PosixPolicyLookups } from "../mxc-posix.js";
import { _forgetMxcRuntimeRootForTest, currentMxcRuntimeHost, establishMxcRuntimeRoot, requireMxcContainerStartRoot, type MxcRuntimeHost } from "../mxc-runtime-root.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow } from "../policy-model.js";

// A host whose mkdir creates the folder and then fails, as a crash between the two would leave it.
const mkdirFault = vi.hoisted(() => ({ path: undefined as string | undefined }));
// A host where a folder made again at a path takes back the inode number of the one removed (ext4 does this at once):
// lstat of `path` reports `reused`'s device and inode with its own, later, birth time.
const inodeReuse = vi.hoisted(() => ({ path: undefined as string | undefined, reused: undefined as { dev: bigint; ino: bigint } | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    mkdirSync: ((path: string, options?: unknown) => {
      const result = fs.mkdirSync(path, options as never);
      if (path === mkdirFault.path) throw Object.assign(new Error("injected failure after mkdir"), { code: "EIO" });
      return result;
    }) as typeof fs.mkdirSync,
    lstatSync: ((path: string, options?: unknown) => {
      const entry = fs.lstatSync(path, options as never);
      const reused = inodeReuse.reused;
      if (path !== inodeReuse.path || reused === undefined || entry === undefined || typeof entry.ino !== "bigint") return entry;
      return Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, { dev: reused.dev, ino: reused.ino });
    }) as typeof fs.lstatSync,
  };
});

describe.runIf(process.platform === "linux")("Linux placeholder ownership", () => {
  let root: string;
  let work: string;
  let leaf: string;
  let host: MxcRuntimeHost;
  let lookups: PosixPolicyLookups;
  let rank: (lookups: PosixPolicyLookups) => ReturnType<typeof rankPosixContainerRows>;

  beforeEach(() => {
    // The runtime root rejects writable ancestors. The system temporary directory is sticky.
    root = mkdtempSync("/tmp/ave-placeholder-");
    work = join(root, "work");
    mkdirSync(work);
    leaf = join(work, "missing", "deep", "locked");
    host = { ...currentMxcRuntimeHost(), cacheHome: join(root, "cache"), aveHome: join(root, "state") };
    establishMxcRuntimeRoot(host);
    lookups = posixPolicyLookups(root, false);
    const model = buildPolicyModel({
      floors: [policyFloorRow(leaf, "ro", "protected-name", true)],
      launchGrants: [policyGrantRow(work, "rw", "launch-grant", true)],
      userGrants: [], extensionManifests: [],
    });
    rank = (policyLookups) => rankPosixContainerRows(model, "bubblewrap", policyLookups);
  });

  const journalPath = () => join(requireMxcContainerStartRoot(host), "shell-placeholders.json");
  const journal = () => JSON.parse(readFileSync(journalPath(), "utf8")) as { directories: unknown[] };

  afterEach(() => {
    mkdirFault.path = undefined;
    _forgetMxcRuntimeRootForTest(host.cacheHome);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps an absent leaf and its pinned parents until the last run leaves", async () => {
    const first = await holdMxcLinuxPlaceholders(lookups, rank, host);
    const second = await holdMxcLinuxPlaceholders(lookups, rank, host);
    expect(first.grants.pins).toEqual([dirname(leaf), join(work, "missing")]);
    expect(second.grants.denied).toEqual([leaf]);
    expect(second.grants.readonly).toEqual([]);
    await first.release();
    second.validate();
    expect(existsSync(leaf)).toBe(true);
    await second.release();
    expect(existsSync(join(work, "missing"))).toBe(false);
  });

  it("sweeps on the next acquisition only after both the owner and the launcher are gone", async () => {
    const owners = new Map([[51, "owner"], [52, "launcher"]]);
    const liveness = { processExists: (pid: number) => owners.has(pid), processStart: (pid: number) => owners.get(pid) ?? null };
    const first = await holdMxcLinuxPlaceholders(lookups, rank, { ...host, ...liveness, pid: 51 });
    await first.recordLauncher(52);
    owners.delete(51);
    await sweepMxcLinuxPlaceholders({ ...host, ...liveness });
    expect(existsSync(leaf)).toBe(true);
    owners.set(52, "reused");
    const second = await holdMxcLinuxPlaceholders(lookups, (current) => {
      expect(existsSync(join(work, "missing"))).toBe(false);
      return rank(current);
    }, { ...host, ...liveness, pid: 52 });
    second.validate();
    await second.release();
    expect(existsSync(join(work, "missing"))).toBe(false);
  });

  it("refuses a replaced ancestor and leaves the replacement untouched", async () => {
    const replaceWork = () => {
      renameSync(work, join(root, "original"));
      mkdirSync(work);
    };
    await expect(holdMxcLinuxPlaceholders(lookups, (current) => {
      const grants = rank(current);
      replaceWork();
      return grants;
    }, host)).rejects.toThrow("Container placeholder ancestor changed");
    expect(existsSync(leaf)).toBe(false);
  });

  it("journals a placeholder before creating it, so a creation that failed is still removed", async () => {
    mkdirFault.path = join(work, "missing");
    await expect(holdMxcLinuxPlaceholders(lookups, rank, host)).rejects.toThrow("injected failure after mkdir");
    expect(existsSync(join(work, "missing"))).toBe(false);
    expect(journal().directories).toEqual([]);
  });

  describe("a pending entry left by a run that died between journalling and creating", () => {
    const dead = { processExists: (pid: number) => pid !== 81, processStart: (pid: number) => pid === 81 ? null : "live" };
    function leavePending(path: string, notBefore: bigint, owner = { pid: 81, start: "gone" }) {
      const run = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
      const parent = lstatSync(dirname(path), { bigint: true });
      writeFileSync(journalPath(), JSON.stringify({
        runs: [{ id: run, owner }],
        directories: [{ path, parent: { device: String(parent.dev), inode: String(parent.ino) }, leaf: false, owners: [run],
          pending: { notBefore: String(notBefore) } }],
      }));
    }

    it("is removed at the next sweep when the folder is empty and newer than the entry", async () => {
      leavePending(join(work, "missing"), BigInt(Date.now() - 1_000) * 1_000_000n);
      mkdirSync(join(work, "missing"));
      await sweepMxcLinuxPlaceholders({ ...host, ...dead });
      expect(existsSync(join(work, "missing"))).toBe(false);
      expect(journal().directories).toEqual([]);
    });

    it("leaves a folder the user made before the entry, and drops the entry", async () => {
      mkdirSync(join(work, "missing"));
      leavePending(join(work, "missing"), BigInt(Date.now() + 60_000) * 1_000_000n);
      await sweepMxcLinuxPlaceholders({ ...host, ...dead });
      expect(existsSync(join(work, "missing"))).toBe(true);
      expect(journal().directories).toEqual([]);
    });

    it("leaves a folder that is not empty, and drops the entry", async () => {
      leavePending(join(work, "missing"), BigInt(Date.now() - 1_000) * 1_000_000n);
      mkdirSync(join(work, "missing"));
      writeFileSync(join(work, "missing", "user-file"), "mine");
      await sweepMxcLinuxPlaceholders({ ...host, ...dead });
      expect(readFileSync(join(work, "missing", "user-file"), "utf8")).toBe("mine");
      expect(journal().directories).toEqual([]);
    });

    it("never satisfies another launch's claim while its run is live", async () => {
      leavePending(join(work, "missing"), BigInt(Date.now() - 1_000) * 1_000_000n, { pid: process.pid, start: host.processStart(process.pid) ?? "x" });
      mkdirSync(join(work, "missing"));
      await expect(holdMxcLinuxPlaceholders(lookups, rank, host)).rejects.toThrow("Container placeholder changed");
    });
  });

  describe("a journal that cannot be read", () => {
    beforeEach(() => {
      takeMxcLinuxPlaceholderRecoveryNotice();
      writeFileSync(journalPath(), "{");
    });

    it("refuses a launch by name and asks for a restart", async () => {
      await expect(holdMxcLinuxPlaceholders(lookups, rank, host)).rejects.toThrow(
        expect.objectContaining({ name: "ContainerPlaceholderJournalError", message: expect.stringMatching(/shell-placeholders\.json.*restart Ave/su) }));
      // An ordinary sweep, such as one during a launch, does not touch it either.
      await expect(sweepMxcLinuxPlaceholders(host)).rejects.toThrow(expect.objectContaining({ name: "ContainerPlaceholderJournalError" }));
      expect(readFileSync(journalPath(), "utf8")).toBe("{");
    });

    it("is moved aside at the boot sweep, which starts empty with one notice, and the next launch works", async () => {
      await sweepMxcLinuxPlaceholders(host, { recoverCorruptJournal: { ownsHostInstance: () => true } });
      const folder = dirname(journalPath());
      const aside = readdirSync(folder).filter(name => /^shell-placeholders\.corrupt-\d+\.json$/u.test(name));
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(folder, aside[0] ?? ""), "utf8")).toBe("{");
      expect(takeMxcLinuxPlaceholderRecoveryNotice()).toBe(t("sandboxPolicy.linuxPlaceholderJournalRecovered", { file: join(folder, aside[0] ?? "") }));
      expect(takeMxcLinuxPlaceholderRecoveryNotice()).toBeUndefined();
      const hold = await holdMxcLinuxPlaceholders(lookups, rank, host);
      expect(existsSync(leaf)).toBe(true);
      await hold.release();
      expect(journal().directories).toEqual([]);
    });

    it("is not moved by a boot sweep that does not hold the host instance lock", async () => {
      await expect(sweepMxcLinuxPlaceholders(host, { recoverCorruptJournal: { ownsHostInstance: () => false } }))
        .rejects.toThrow("host instance lock");
      expect(readFileSync(journalPath(), "utf8")).toBe("{");
    });
  });

  describe("two sessions with different protected sets", () => {
    it("holds a folder another run created when this launch mounts on it, so it outlives that run", async () => {
      const first = await holdMxcLinuxPlaceholders(lookups, rank, host);
      const mounted = dirname(leaf);
      const model = buildPolicyModel({ floors: [], launchGrants: [policyGrantRow(mounted, "rw", "launch-grant", true)], userGrants: [], extensionManifests: [] });
      const second = await holdMxcLinuxPlaceholders(lookups, (current) => rankPosixContainerRows(model, "bubblewrap", current), host);
      expect(second.grants.readwrite).toContain(mounted);
      await first.release();
      expect(existsSync(mounted)).toBe(true);
      second.validate();
      await second.release();
      expect(existsSync(join(work, "missing"))).toBe(false);
    });

    it("denies another run's live placeholder under its write roots, and holds it, when its own set lacks the name", async () => {
      const first = await holdMxcLinuxPlaceholders(lookups, rank, host);
      const model = buildPolicyModel({ floors: [], launchGrants: [policyGrantRow(work, "rw", "launch-grant", true)], userGrants: [], extensionManifests: [] });
      const second = await holdMxcLinuxPlaceholders(lookups, (current) => rankPosixContainerRows(model, "bubblewrap", current), host);
      expect(second.grants.denied).toContain(leaf);
      await first.release();
      expect(existsSync(leaf)).toBe(true);
      await second.release();
      expect(existsSync(join(work, "missing"))).toBe(false);
    });

    it("leaves a placeholder outside its write roots alone", async () => {
      const first = await holdMxcLinuxPlaceholders(lookups, rank, host);
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere);
      const model = buildPolicyModel({ floors: [], launchGrants: [policyGrantRow(elsewhere, "rw", "launch-grant", true)], userGrants: [], extensionManifests: [] });
      const second = await holdMxcLinuxPlaceholders(lookups, (current) => rankPosixContainerRows(model, "bubblewrap", current), host);
      expect(second.grants.denied).not.toContain(leaf);
      await first.release();
      expect(existsSync(join(work, "missing"))).toBe(false);
      await second.release();
    });

    it("names a placeholder replaced on the host after the start when validated again", async () => {
      const hold = await holdMxcLinuxPlaceholders(lookups, rank, host);
      hold.validate();
      // The original is moved aside first, so its inode is still allocated and the new folder cannot take its number.
      const aside = join(root, "aside");
      renameSync(leaf, aside);
      mkdirSync(leaf);
      expect(lstatSync(leaf, { bigint: true }).ino).not.toBe(lstatSync(aside, { bigint: true }).ino);
      expect(() => hold.validate()).toThrow(`Container placeholder changed before start: ${leaf}`);
      rmSync(leaf, { recursive: true });
      renameSync(aside, leaf);
      await hold.release();
    });

    it("names a placeholder made again at a reused inode number, by its birth time", async () => {
      const hold = await holdMxcLinuxPlaceholders(lookups, rank, host);
      const original = lstatSync(leaf, { bigint: true });
      if (original.birthtimeNs === 0n) throw new Error("this filesystem reports no birth time; the reuse case cannot be told apart here");
      rmSync(leaf, { recursive: true });
      mkdirSync(leaf);
      // Forced, not left to the allocator: the new folder reports the removed one's device and inode.
      inodeReuse.path = leaf;
      inodeReuse.reused = { dev: original.dev, ino: original.ino };
      try {
        const again = lstatSync(leaf, { bigint: true });
        expect([again.dev, again.ino]).toEqual([original.dev, original.ino]);
        expect(again.birthtimeNs).not.toBe(original.birthtimeNs);
        expect(() => hold.validate()).toThrow(`Container placeholder changed before start: ${leaf}`);
      } finally {
        inodeReuse.path = undefined;
        inodeReuse.reused = undefined;
      }
      await hold.release();
    });
  });

  it("cleans the protected leaf and leaves an ordinary file in a created parent", async () => {
    const hold = await holdMxcLinuxPlaceholders(lookups, rank, host);
    const sibling = join(dirname(leaf), "ordinary");
    writeFileSync(sibling, "kept");
    await hold.release();
    expect(existsSync(leaf)).toBe(false);
    expect(readFileSync(sibling, "utf8")).toBe("kept");
  });

  if (process.env.AVE_RUN_MXC_LINUX_BOUNDARY === "1") it("refuses to rename a pre-created parent and writes to its sibling natively", async () => {
    const hold = await holdMxcLinuxPlaceholders(lookups, rank, host);
    try {
      const launcher = launcherPathFor(join(process.cwd(), "resources"), process.platform, process.arch);
      if (launcher === undefined) throw new Error("Linux test launcher is unavailable");
      const config = join(root, "config.json");
      const commandLine = [
        "if mv -T missing moved; then exit 21; fi",
        "if mv -T missing/deep missing/moved; then exit 22; fi",
        "if touch missing/deep/locked/file; then exit 23; fi",
        "printf writable > missing/deep/sibling",
      ].join("\n");
      writeFileSync(config, JSON.stringify({
        version: "0.9.0-alpha", containment: "bubblewrap", process: { commandLine, cwd: work },
        filesystem: { readwritePaths: hold.grants.readwrite, readonlyPaths: [], deniedPaths: hold.grants.denied },
        network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      }));
      hold.validate();
      const result = spawnSync(launcher, ["--config", config], { encoding: "utf8", timeout: 5_000 });
      expect(result.status, String(result.error ?? result.stderr)).toBe(0);
      expect(result.stderr.match(/Device or resource busy/gu)).toHaveLength(2);
      expect(existsSync(join(work, "moved"))).toBe(false);
      expect(readFileSync(join(dirname(leaf), "sibling"), "utf8")).toBe("writable");
    } finally {
      await hold.release();
    }
    expect(existsSync(leaf)).toBe(false);
  });

  it("lets a holder that only masks another run's placeholder own it until its ready byte", async () => {
    const shell = await holdMxcLinuxPlaceholders(lookups, rank, host);
    // This holder's own rows have no protected name there: it holds the shell's placeholder only to mask it.
    const holder = await holdMxcLinuxPlaceholders(lookups, (policyLookups) => rankPosixContainerRows(buildPolicyModel({
      floors: [], launchGrants: [policyGrantRow(work, "rw", "launch-grant", true)], userGrants: [], extensionManifests: [],
    }), "bubblewrap", policyLookups), host);
    expect(holder.grants.denied).toContain(leaf);
    await holder.releaseForeignClaims();
    holder.validate();
    await shell.release();
    expect(existsSync(leaf)).toBe(false);
    expect(existsSync(join(work, "missing"))).toBe(false);
    await holder.release();
  });

  it("keeps a placeholder another run made first when the holder's own rows need it (N10)", async () => {
    const shell = await holdMxcLinuxPlaceholders(lookups, rank, host);
    const holder = await holdMxcLinuxPlaceholders(lookups, rank, host);
    await holder.releaseForeignClaims();
    await shell.release();
    holder.validate();
    expect(existsSync(leaf)).toBe(true);
    await holder.release();
    expect(existsSync(leaf)).toBe(false);
  });

  describe("a holder whose Ave exited (boot orphan stop)", () => {
    const noPlaceholders = (policyLookups: PosixPolicyLookups) => rankPosixContainerRows(buildPolicyModel({
      floors: [], launchGrants: [policyGrantRow(work, "rw", "launch-grant", true)], userGrants: [], extensionManifests: [],
    }), "bubblewrap", policyLookups);
    const markers = () => join(requireMxcContainerStartRoot(host), "holder-markers");
    const markerFiles = () => existsSync(markers()) ? readdirSync(markers()) : [];
    // `killed` ends pid 82 for the fake host, as a KILL would.
    let killed = false;
    // Ave (pid 81) is gone; the holder marker is pid 82, alive with start "s82" and executable /usr/bin/bwrap.
    const aveGone = (over: { start?: string } = {}) => ({
      processExists: (pid: number) => (pid === 82 && !killed) || pid === host.pid,
      processStart: (pid: number) => pid === 82 ? over.start ?? "s82" : pid === host.pid ? currentMxcRuntimeHost().processStart(pid) : null,
    });
    function leaveMarker(holder: { pid: number; start: string | null; executable: string } = { pid: 82, start: "s82", executable: "/usr/bin/bwrap" }) {
      mkdirSync(markers(), { recursive: true, mode: 0o700 });
      writeFileSync(join(markers(), "7c9e6679-7425-40de-944b-e07fc1f90ae7.json"), JSON.stringify({ owner: { pid: 81, start: "gone" }, holder }));
    }

    it("writes a holder's marker synchronously, even with no placeholder, and removes it at release", async () => {
      const hold = await holdMxcLinuxPlaceholders(lookups, noPlaceholders, host);
      const result = hold.recordHolder(process.pid, "/usr/bin/bwrap");
      expect(result).toBeUndefined();
      const [name] = markerFiles();
      expect(JSON.parse(readFileSync(join(markers(), name as string), "utf8"))).toEqual({
        owner: { pid: host.pid, start: expect.any(String) }, holder: { pid: process.pid, start: expect.any(String), executable: "/usr/bin/bwrap" },
      });
      expect((lstatSync(join(markers(), name as string)).mode & 0o777).toString(8)).toBe("600");
      await hold.release();
      expect(markerFiles()).toEqual([]);
    });

    it("stops the recorded bwrap only when its start time and executable both match, and removes the marker", async () => {
      for (const [name, over, executable, stopped] of [
        ["both match", {}, "/usr/bin/bwrap", true],
        ["start time changed", { start: "other" }, "/usr/bin/bwrap", false],
        ["executable changed", {}, "/usr/bin/sleep", false],
      ] as const) {
        leaveMarker();
        killed = false;
        const kill = vi.fn(() => { killed = true; });
        await sweepMxcLinuxPlaceholders({ ...host, ...aveGone(over) }, { stopOrphanHolders: { executable: () => executable, kill } });
        expect(kill.mock.calls, name).toEqual(stopped ? [[82]] : []);
        expect(markerFiles(), name).toEqual([]);
      }
    });

    // Review #758 P3-3: start ticks count from boot, so the recorded start carries this boot's id and a marker from
    // another boot can never match a live process (the "start time changed" case above).
    it.runIf(process.platform === "linux")("records the holder's start with this boot's id", async () => {
      const hold = await holdMxcLinuxPlaceholders(lookups, noPlaceholders, host);
      hold.recordHolder(process.pid, "/usr/bin/bwrap");
      const [name] = markerFiles();
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      expect(JSON.parse(readFileSync(join(markers(), name as string), "utf8")).holder.start).toMatch(new RegExp(`^${boot}:\\d+$`, "u"));
      await hold.release();
    });

    it("waits for the stopped bwrap to end, and keeps the marker of one that outlives the KILL", async () => {
      leaveMarker();
      killed = false;
      const started = Date.now();
      await sweepMxcLinuxPlaceholders({ ...host, ...aveGone() }, { stopOrphanHolders: { executable: () => "/usr/bin/bwrap", kill: vi.fn() } });
      expect(Date.now() - started).toBeGreaterThanOrEqual(TOOL_TIMEOUT_POLICY.processTreeKillMs - 50);
      expect(markerFiles()).toHaveLength(1);
    });

    it("leaves a live holder alone at an ordinary sweep, and keeps the marker of a live Ave", async () => {
      leaveMarker();
      killed = false;
      const kill = vi.fn();
      await sweepMxcLinuxPlaceholders({ ...host, ...aveGone() });
      expect(kill).not.toHaveBeenCalled();
      await sweepMxcLinuxPlaceholders({ ...host, ...aveGone(), processExists: () => true, processStart: (pid: number) => pid === 81 ? "gone" : "s82" },
        { stopOrphanHolders: { executable: () => "/usr/bin/bwrap", kill } });
      expect(kill).not.toHaveBeenCalled();
      expect(markerFiles()).toHaveLength(1);
    });

    it("runs even when the journal is unreadable and set aside", async () => {
      leaveMarker();
      killed = false;
      writeFileSync(journalPath(), "{");
      const kill = vi.fn(() => { killed = true; });
      await sweepMxcLinuxPlaceholders({ ...host, ...aveGone() }, {
        recoverCorruptJournal: { ownsHostInstance: () => true }, stopOrphanHolders: { executable: () => "/usr/bin/bwrap", kill },
      });
      expect(kill.mock.calls).toEqual([[82]]);
      takeMxcLinuxPlaceholderRecoveryNotice();
    });

    it("stops a real orphaned process group by its recorded executable", async () => {
      const orphan = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
      await new Promise(done => orphan.once("spawn", done));
      const pid = orphan.pid as number;
      leaveMarker({ pid, start: currentMxcRuntimeHost().processStart(pid), executable: readlinkSync(`/proc/${pid}/exe`) });
      let signal: NodeJS.Signals | null = null;
      orphan.once("exit", (_code, ended) => { signal = ended; });
      // Waited for: the pid is gone (reaped by this test's own exit handler) when the sweep returns.
      await sweepMxcLinuxPlaceholders({ ...host, processExists: (candidate: number) => candidate !== 81 && signal === null && currentMxcRuntimeHost().processExists(candidate) },
        { stopOrphanHolders: true });
      expect(signal).toBe("SIGKILL");
    });
  });
});
