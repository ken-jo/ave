/** A host tab's output kept across a restart: what is written to disk, who may read it, and what a new shell in the tab continues from.
 * A fake PTY stands for the shell; the store is the real one, on a real directory. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

type DataCb = (chunk: string) => void;
type ExitCb = (e: { exitCode: number; signal?: number }) => void;
class FakePty {
  pid = 4242;
  private dataCb: DataCb | null = null;
  private exitCbs = new Set<ExitCb>();
  onData(cb: DataCb) { this.dataCb = cb; return { dispose: () => { this.dataCb = null; } }; }
  onExit(cb: ExitCb) { this.exitCbs.add(cb); return { dispose: () => { this.exitCbs.delete(cb); } }; }
  write() {}
  resize() {}
  kill() { for (const cb of [...this.exitCbs]) cb({ exitCode: 0 }); }
  emitData(chunk: string) { this.dataCb?.(chunk); }
}
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({ spawn: () => { const pty = new FakePty(); ptys.push(pty); return pty; } }));
vi.mock("../shell-process.js", () => ({
  readTerminalForeground: vi.fn(async () => ({ ok: true, foreground: { pid: 4242, command: "zsh", cwd: "/w" } })),
  readSandboxedShell: vi.fn(),
  forwardResizeToSandboxedPtyRelay: vi.fn(),
}));

import {
  __resetTerminalsForTest, forceKillAllTerminalsForShutdown, forgetTerminalScrollback, keepTerminalOutput, killTerminal, killTerminalsOwnedBy,
  setTerminalEmitter, setTerminalScrollbackStore, spawnTerminal,
} from "../pty-manager.js";
import {
  TERMINAL_SCROLLBACK_DIRECTORY, savedTerminalTabIds, terminalScrollbackProfile, terminalScrollbackStore, unresolvedTerminalScrollbackProfile, windowsKeptFileReader,
  type TerminalScrollbackStore, type WindowsKeptFileFacts,
} from "../terminal-scrollback-store.js";
import type { WindowsDaclFacts } from "../../../shared/windows-path-facts.js";
import { isAveHomeReadReallowed } from "../../../permissions/ave-home-read-boundary.js";
import { isAdmissionDeniedPath, isSensitivePath } from "../../../permissions/sensitive-paths.js";
import { TERMINAL_REPLAY_MAX_BYTES } from "../../../shared/terminal-session.js";
import type { MainLayoutSnapshot } from "../../../shared/main-layout.js";
import { openFeatureNamespace } from "../../storage/feature-namespace.js";

const TAB = "terminal:0000c0de-1";
/** The settings file of the profile whose tabs these are. */
const PROFILE_DIR = mkdtempSync(join(tmpdir(), "ave-scrollback-profile-"));
const PROFILE = terminalScrollbackProfile(PROFILE_DIR);
afterAll(() => { rmSync(PROFILE_DIR, { recursive: true, force: true }); });
const WINDOW = 5;
let shellDir: string;
let home: string;
let aveHome: string;
let shown: string[];
let store: TerminalScrollbackStore;

const lastPty = (): FakePty => {
  const pty = ptys.at(-1);
  if (!pty) throw new Error("no shell was started");
  return pty;
};
const keptFiles = (): string[] => existsSync(join(aveHome, TERMINAL_SCROLLBACK_DIRECTORY)) ? readdirSync(join(aveHome, TERMINAL_SCROLLBACK_DIRECTORY)) : [];
const start = (options: { restore?: boolean; tabId?: string } = {}) =>
  spawnTerminal({ tabId: options.tabId ?? TAB, lane: "manual", purpose: "workspace", ownerWindowId: WINDOW, cwd: tmpdir(), ...(options.restore ? { restore: true } : {}) });

beforeEach(() => {
  shellDir = mkdtempSync(join(tmpdir(), "ave-scrollback-shell-"));
  home = mkdtempSync(join(tmpdir(), "ave-scrollback-home-"));
  aveHome = mkdtempSync(join(tmpdir(), "ave-scrollback-avehome-"));
  const zsh = join(shellDir, "zsh");
  writeFileSync(zsh, "#!/bin/sh\n");
  chmodSync(zsh, 0o755);
  vi.stubEnv("SHELL", zsh);
  vi.stubEnv("HOME", home);
  vi.stubEnv("AVE_HOME", aveHome);
  ptys.length = 0;
  shown = [];
  __resetTerminalsForTest();
  setTerminalEmitter((event, payload) => { if (event === "data" && "chunk" in payload) shown.push(payload.chunk); });
  store = terminalScrollbackStore(PROFILE);
  setTerminalScrollbackStore(store);
});
afterEach(() => {
  __resetTerminalsForTest();
  vi.unstubAllEnvs();
  for (const directory of [shellDir, home, aveHome]) rmSync(directory, { recursive: true, force: true });
});

describe("the file a tab's output is kept in", () => {
  const directory = (): string => join(aveHome, TERMINAL_SCROLLBACK_DIRECTORY);

  it("is readable by the user alone, in a directory no confined process is granted", async () => {
    const store = terminalScrollbackStore(PROFILE);
    await store.save(TAB, ("secret-token-output\r\n"));
    const [name] = readdirSync(directory());
    if (name === undefined) throw new Error("nothing was kept");
    if (process.platform !== "win32") {
      expect(statSync(directory()).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory(), name)).mode & 0o777).toBe(0o600);
    }
    // The tab id is a renderer's string: it names nothing on disk.
    expect(name).toMatch(/^[0-9a-f]{16}-[0-9a-f]{32}\.scrollback$/u);
    expect(readdirSync(directory())).toHaveLength(1);
    expect(isAveHomeReadReallowed([TERMINAL_SCROLLBACK_DIRECTORY])).toBe(false);
    expect(isAveHomeReadReallowed([TERMINAL_SCROLLBACK_DIRECTORY, name])).toBe(false);
  });

  it.skipIf(process.platform === "win32")("closes a directory that was left open to other users before writing into it", async () => {
    mkdirSync(directory(), { mode: 0o755 });
    chmodSync(directory(), 0o755);
    await terminalScrollbackStore(PROFILE).save(TAB, ("x\r\n"));
    expect(statSync(directory()).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("does not write through a staging file somebody prepared: the kept file is the user's alone", async () => {
    mkdirSync(directory(), { mode: 0o700 });
    await terminalScrollbackStore(PROFILE).save(TAB, ("first\r\n"));
    const [name] = readdirSync(directory());
    if (name === undefined) throw new Error("nothing was kept");
    // The name a predictable scheme would stage under, left world-readable.
    const planted = join(directory(), `${name}.${process.pid}.tmp`);
    writeFileSync(planted, "planted", { mode: 0o644 });
    chmodSync(planted, 0o644);
    await terminalScrollbackStore(PROFILE).save(TAB, ("second\r\n"));
    expect(statSync(join(directory(), name)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory(), name), "utf-8")).toContain("second");
    expect(readFileSync(planted, "utf-8")).toBe("planted");
  });

  it.skipIf(process.platform === "win32")("refuses a directory that is a link, and puts nothing where it points", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ave-scrollback-workspace-"));
    try {
      symlinkSync(workspace, directory());
      const store = terminalScrollbackStore(PROFILE);
      await expect(store.save(TAB, ("SENTINEL-private-output\r\n"))).rejects.toThrow(/not a directory of its own/u);
      expect(readdirSync(workspace)).toEqual([]);
      // Nor is anything read, forgotten or pruned through it.
      writeFileSync(join(workspace, "theirs.txt"), "theirs");
      await expect(store.read(TAB)).rejects.toThrow(/not a directory of its own/u);
      await expect(store.forget(TAB)).rejects.toThrow(/not a directory of its own/u);
      await expect(store.keepOnly(new Set())).rejects.toThrow(/not a directory of its own/u);
      expect(readdirSync(workspace)).toEqual(["theirs.txt"]);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("replaces a kept file that is a link instead of writing or reading through it", async () => {
    const outside = join(home, "elsewhere.txt");
    writeFileSync(outside, "elsewhere");
    const store = terminalScrollbackStore(PROFILE);
    await store.save(TAB, ("first\r\n"));
    const [name] = readdirSync(directory());
    if (name === undefined) throw new Error("nothing was kept");
    rmSync(join(directory(), name));
    symlinkSync(outside, join(directory(), name));
    await expect(store.read(TAB)).rejects.toThrow();
    await store.save(TAB, ("second\r\n"));
    expect(readFileSync(outside, "utf-8")).toBe("elsewhere");
    expect(lstatSync(join(directory(), name)).isSymbolicLink()).toBe(false);
    expect(await store.read(TAB)).toContain("second");
  });

  it("is a path the file tools are refused outright, for reading as for writing", () => {
    const kept = join(aveHome, TERMINAL_SCROLLBACK_DIRECTORY, "0123456789abcdef0123456789abcdef.scrollback");
    expect(isSensitivePath(kept, "read")).toBe("ave-home:terminal-state");
    expect(isSensitivePath(kept, "write")).toBe("ave-home:terminal-state");
    expect(isSensitivePath(join(aveHome, TERMINAL_SCROLLBACK_DIRECTORY), "read")).toBe("ave-home:terminal-state");
    // Not a secret a user may choose to show an agent: refused before any rule, grant, reviewer or mode is consulted.
    expect(isAdmissionDeniedPath(kept, "read")).not.toBeNull();
    expect(isAdmissionDeniedPath(kept, "write")).not.toBeNull();
  });

  it("is written as the view gave it, and never larger than a terminal's replay", async () => {
    const store = terminalScrollbackStore(PROFILE);
    await expect(store.save(TAB, "y".repeat(TERMINAL_REPLAY_MAX_BYTES + 1))).rejects.toThrow(/larger than a terminal's replay/u);
    expect(keptFiles()).toEqual([]);
    await store.save(TAB, "exactly this\r\n");
    expect(await store.read(TAB)).toBe("exactly this\r\n");
  });

  it("round-trips, forgets one tab, and drops every tab a layout no longer has", async () => {
    const store = terminalScrollbackStore(PROFILE);
    expect(await store.read(TAB)).toBeNull();
    await store.keepOnly(new Set([TAB]));
    await store.save(TAB, ("a\r\n"));
    await store.save("terminal:other-1", ("b\r\n"));
    await store.save("terminal:gone-1", ("c\r\n"));
    expect(await store.read(TAB)).toBe("a\r\n");
    await store.keepOnly(new Set([TAB, "terminal:other-1"]));
    expect(keptFiles()).toHaveLength(2);
    expect(await store.read("terminal:gone-1")).toBeNull();
    await store.forget("terminal:other-1");
    expect(await store.read("terminal:other-1")).toBeNull();
    expect(await store.read(TAB)).not.toBeNull();
    // Nothing shown, nothing kept.
    await store.save("terminal:empty-1", (""));
    expect(keptFiles()).toHaveLength(1);
  });

  it("keeps each profile sharing the Ave home to its own tabs: a sweep leaves another profile's files, staging files included", async () => {
    const installed = terminalScrollbackStore(PROFILE);
    const sourceRun = terminalScrollbackStore(terminalScrollbackProfile(home));
    await installed.save(TAB, "installed\r\n");
    await installed.save("terminal:closed-1", "installed, closed\r\n");
    // The same tab id in the other profile is another tab.
    expect(await sourceRun.read(TAB)).toBeNull();
    await sourceRun.save(TAB, "source run\r\n");
    expect(await installed.read(TAB)).toBe("installed\r\n");
    const installedName = keptFiles().find((name) => readFileSync(join(directory(), name), "utf-8") === "installed\r\n");
    if (installedName === undefined) throw new Error("the installed profile kept nothing");
    const unfinished = `${installedName}.0123456789abcdef0123456789abcdef.tmp`;
    writeFileSync(join(directory(), unfinished), "unfinished");
    // The other profile's layout has no tabs: it sweeps its own files and none of the installed profile's.
    await sourceRun.keepOnly(new Set());
    expect(await sourceRun.read(TAB)).toBeNull();
    expect(await installed.read(TAB)).toBe("installed\r\n");
    expect(await installed.read("terminal:closed-1")).toBe("installed, closed\r\n");
    expect(keptFiles()).toContain(unfinished);
    // The installed profile's own sweep takes its closed tab and its unfinished staging file.
    await installed.keepOnly(new Set([TAB]));
    expect(await installed.read("terminal:closed-1")).toBeNull();
    expect(keptFiles()).not.toContain(unfinished);
    expect(await installed.read(TAB)).toBe("installed\r\n");
  });

  it("names one profile for its settings directory however the directory is reached: through a link, or through /tmp for /private/tmp", () => {
    // `/tmp` is a link to `/private/tmp` on macOS; Windows reaches its temporary directory through a short name as often as not.
    const temporary = process.platform === "win32" ? tmpdir() : "/tmp";
    const userData = mkdtempSync(join(realpathSync.native(temporary), "ave-scrollback-reached-"));
    const link = join(home, "linked-user-data");
    try {
      const named = terminalScrollbackProfile(userData);
      expect(terminalScrollbackProfile(join(temporary, basename(userData)))).toBe(named);
      symlinkSync(userData, link, process.platform === "win32" ? "junction" : "dir");
      expect(terminalScrollbackProfile(link)).toBe(named);
      expect(terminalScrollbackProfile(`${userData}/`)).toBe(named);
      // Paths on macOS and Windows volumes are matched without case; elsewhere another case is another directory, which this one is not.
      const otherCase = join(dirname(userData), basename(userData).toUpperCase());
      if (process.platform === "darwin" || process.platform === "win32") expect(terminalScrollbackProfile(otherCase)).toBe(named);
      else expect(() => terminalScrollbackProfile(otherCase)).toThrow();
      // Another directory is another profile.
      expect(terminalScrollbackProfile(home)).not.toBe(named);
    } finally {
      rmSync(link, { force: true, recursive: false });
      rmSync(userData, { recursive: true, force: true });
    }
  });

  it("refuses to name a profile for a settings directory that does not resolve; the path as given names it only when asked to", () => {
    const missing = join(home, "no-such-user-data");
    expect(() => terminalScrollbackProfile(missing)).toThrow();
    expect(unresolvedTerminalScrollbackProfile(missing)).toMatch(/^[0-9a-f]{16}-$/u);
    // Given as the filesystem names it, the path as given is the profile's own name.
    expect(unresolvedTerminalScrollbackProfile(realpathSync.native(PROFILE_DIR))).toBe(PROFILE);
    // Named without the filesystem, a path still follows the platform's case rule: one profile on macOS and Windows, two elsewhere.
    const otherCase = join(dirname(missing), basename(missing).toUpperCase());
    if (process.platform === "darwin" || process.platform === "win32") expect(unresolvedTerminalScrollbackProfile(otherCase)).toBe(unresolvedTerminalScrollbackProfile(missing));
    else expect(unresolvedTerminalScrollbackProfile(otherCase)).not.toBe(unresolvedTerminalScrollbackProfile(missing));
  });

  it("deletes, when it sweeps, files no profile owns: a tab's file or a staging file named before files carried their profile", async () => {
    await store.save(TAB, "kept\r\n");
    const other = terminalScrollbackStore(terminalScrollbackProfile(home));
    await other.save(TAB, "other profile\r\n");
    const unowned = "0123456789abcdef0123456789abcdef.scrollback";
    const unownedStaging = `${unowned}.fedcba9876543210fedcba9876543210.tmp`;
    // Not a name this store has ever written: not its to judge.
    const foreign = "notes.txt";
    for (const name of [unowned, unownedStaging, foreign]) writeFileSync(join(directory(), name), "export TOKEN=left-by-an-earlier-build\r\n", { mode: 0o600 });
    await store.keepOnly(new Set([TAB]));
    expect(keptFiles()).not.toContain(unowned);
    expect(keptFiles()).not.toContain(unownedStaging);
    expect(keptFiles()).toContain(foreign);
    expect(await store.read(TAB)).toBe("kept\r\n");
    expect(await other.read(TAB)).toBe("other profile\r\n");
  });

  it("runs what it is asked in the order it was asked, without being waited on", async () => {
    const store = terminalScrollbackStore(PROFILE);
    void store.save(TAB, "first\r\n");
    void store.save(TAB, "second\r\n");
    const read = store.read(TAB);
    void store.forget(TAB);
    expect(await read).toContain("second");
    await store.settled();
    expect(keptFiles()).toEqual([]);
  });

  it("holds at most one waiting save of a tab, the latest, however many its view sends", async () => {
    const namespace = openFeatureNamespace(TERMINAL_SCROLLBACK_DIRECTORY);
    let written = 0;
    const counting = new Proxy(namespace, {
      get: (target, key) => key === "createFile"
        ? (...args: Parameters<typeof namespace.createFile>) => { written += 1; return target.createFile(...args); }
        : Reflect.get(target, key),
    });
    const store = terminalScrollbackStore(PROFILE, counting);
    await store.save(TAB, "earlier\r\n");
    written = 0;
    // One save is under way; ten thousand more arrive behind it.
    const running = store.save(TAB, "running\r\n");
    await Promise.resolve();
    const saves: Promise<void>[] = [];
    for (let index = 0; index < 10_000; index++) saves.push(store.save(TAB, `flood-${index}\r\n`));
    // They are one waiting save, which writes the latest output once.
    expect(new Set(saves).size).toBe(1);
    await Promise.all([running, ...saves]);
    expect(written).toBeLessThanOrEqual(2);
    expect(await store.read(TAB)).toBe("flood-9999\r\n");
    // A cleared screen sent after a waiting save is what stays.
    void store.save(TAB, "busy\r\n");
    void store.save(TAB, "shown\r\n");
    await store.save(TAB, "");
    expect(keptFiles()).toEqual([]);
    // A forget stays after the save it follows, and a save after the forget comes after it.
    void store.save(TAB, "busy\r\n");
    void store.save(TAB, "before the forget\r\n");
    void store.forget(TAB);
    await store.save(TAB, "after the forget\r\n");
    expect(await store.read(TAB)).toBe("after the forget\r\n");
    // Other tabs' saves are not merged into it.
    await Promise.all([store.save(TAB, "one\r\n"), store.save("terminal:other-1", "two\r\n")]);
    expect(await store.read("terminal:other-1")).toBe("two\r\n");
  });

  it("refuses a file larger than a terminal's replay", async () => {
    const store = terminalScrollbackStore(PROFILE);
    await store.save(TAB, ("x\r\n"));
    writeFileSync(join(directory(), keptFiles()[0] ?? ""), "y".repeat(TERMINAL_REPLAY_MAX_BYTES + 1));
    await expect(store.read(TAB)).rejects.toThrow(/larger than a terminal's replay/u);
  });

  it("finds a saved layout's terminal tabs wherever they are", () => {
    const terminal = (tabId: string) => ({ kind: "terminal" as const, tabId, ordinal: 1, cwd: null, url: null });
    const layout = {
      version: 2, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main", panelOpenIds: [], thumbnailOpenIds: [],
      surfaces: { main: terminal("terminal:shown-1") },
      openSurfaces: [terminal("terminal:shown-1"), terminal("terminal:listed-2"), { kind: "browser", tabId: "browser:1", ordinal: 1, cwd: null, url: "https://example.test" }],
      sideTabs: { main: [terminal("terminal:side-3")] },
    } as unknown as MainLayoutSnapshot;
    expect([...savedTerminalTabIds(layout)].sort()).toEqual(["terminal:listed-2", "terminal:shown-1", "terminal:side-3"]);
    expect(savedTerminalTabIds(undefined).size).toBe(0);
  });
});

describe("the file a tab's output is kept in, read the way Windows reads it", () => {
  const directory = (): string => join(aveHome, TERMINAL_SCROLLBACK_DIRECTORY);
  const SYMLINK = 0xa000000c;
  const JUNCTION = 0xa0000003;
  const REPARSE_POINT = 0x400;
  const component = (exists: boolean, reparseTag = 0, isDirectory = false) => exists
    ? {
      exists: true, canonical: "C:\\kept", volumeSerial: "0x0000000000000001", fileId: "0x00000000000000000000000000000001",
      volumeSerialNumber: "0x0000000000000001", fileIndex: "0x0000000000000001", changeTime: "0x0000000000000001",
      attributes: reparseTag === 0 ? 0 : REPARSE_POINT, reparseTag, directory: isDirectory, reparseTarget: null,
    }
    : {
      exists: false, canonical: null, volumeSerial: null, fileId: null, volumeSerialNumber: null, fileIndex: null, changeTime: null,
      attributes: 0, reparseTag: 0, directory: false, reparseTarget: null,
    };
  /** What the native walk reports for a path on disk: a link is reported as the reparse point it is, and never followed for its content. */
  const factsOnDisk = (ancestorTag = 0): WindowsKeptFileFacts => (path) => {
    let link = false;
    let isDirectory = false;
    try {
      const info = lstatSync(path);
      link = info.isSymbolicLink();
      isDirectory = info.isDirectory();
    } catch {
      return { ...component(false), ancestors: [component(true, ancestorTag, true)], contentHex: null } as unknown as WindowsDaclFacts;
    }
    const final = component(true, link ? SYMLINK : 0, isDirectory);
    const contentHex = link || isDirectory ? null : readFileSync(path).toString("hex");
    return { ...final, ancestors: [component(true, ancestorTag, true)], contentHex } as unknown as WindowsDaclFacts;
  };

  it("refuses a kept file that is a link and reads nothing where it points", async () => {
    const outside = join(home, "elsewhere.txt");
    writeFileSync(outside, "OUTSIDE-SENTINEL");
    await terminalScrollbackStore(PROFILE).save(TAB, ("first\r\n"));
    const [name] = readdirSync(directory());
    if (name === undefined) throw new Error("nothing was kept");
    rmSync(join(directory(), name));
    symlinkSync(outside, join(directory(), name));
    const store = terminalScrollbackStore(PROFILE, undefined, windowsKeptFileReader(factsOnDisk()));
    await expect(store.read(TAB)).rejects.toThrow(/not a file of its own/u);
  });

  it("refuses a kept file below a junction", async () => {
    await terminalScrollbackStore(PROFILE).save(TAB, ("first\r\n"));
    const store = terminalScrollbackStore(PROFILE, undefined, windowsKeptFileReader(factsOnDisk(JUNCTION)));
    await expect(store.read(TAB)).rejects.toThrow(/not a file of its own/u);
  });

  it("refuses a path the walk could not finish below a link", async () => {
    await terminalScrollbackStore(PROFILE).save(TAB, ("first\r\n"));
    const unfinished: WindowsKeptFileFacts = () => ({
      ...component(false), exists: null, ancestors: [component(true, SYMLINK, true)], contentHex: null,
    }) as unknown as WindowsDaclFacts;
    await expect(terminalScrollbackStore(PROFILE, undefined, windowsKeptFileReader(unfinished)).read(TAB)).rejects.toThrow(/not a file of its own/u);
  });

  it("returns the bytes of the file it checked, though the name is pointed elsewhere after the check", async () => {
    const outside = join(home, "elsewhere.txt");
    writeFileSync(outside, "OUTSIDE-SENTINEL");
    await terminalScrollbackStore(PROFILE).save(TAB, ("checked\r\n"));
    const onDisk = factsOnDisk();
    const swappedAfterCheck: WindowsKeptFileFacts = (path) => {
      const row = onDisk(path);
      rmSync(path);
      symlinkSync(outside, path);
      return row;
    };
    const kept = await terminalScrollbackStore(PROFILE, undefined, windowsKeptFileReader(swappedAfterCheck)).read(TAB);
    expect(kept).toBe("checked\r\n");
    expect(kept).not.toContain("OUTSIDE-SENTINEL");
  });

  it("reads a kept file of its own, and reports none when there is none", async () => {
    const store = terminalScrollbackStore(PROFILE, undefined, windowsKeptFileReader(factsOnDisk()));
    expect(await store.read(TAB)).toBeNull();
    await store.save(TAB, ("plain\r\n"));
    expect(await store.read(TAB)).toBe("plain\r\n");
  });
});

describe("a host tab comes back with what its view kept", () => {
  /** What the tab's view shows as its window goes, as it serialized it. */
  const SHOWN = "\x1b[0mbefore-restart-line\r\n\x1b[?1047l\x1b[!p\x1b[0m\r\n";

  it("keeps what the view sent and hands it to the restored tab's view, ahead of the new shell's own", async () => {
    expect((await start()).ok).toBe(true);
    lastPty().emitData("before-restart-line\r\n");
    expect(keepTerminalOutput(TAB, WINDOW, SHOWN)).toEqual({ ok: true });
    // Shutdown waits for what the views kept as the windows' documents closed.
    await forceKillAllTerminalsForShutdown(0);
    expect(await terminalScrollbackStore(PROFILE).read(TAB)).toBe(SHOWN);

    // The next run of the app.
    __resetTerminalsForTest();
    shown = [];
    setTerminalEmitter((event, payload) => { if (event === "data" && "chunk" in payload) shown.push(payload.chunk); });
    setTerminalScrollbackStore(terminalScrollbackStore(PROFILE));
    const restored = await start({ restore: true });
    if (!restored.ok) throw new Error(restored.message);
    expect(restored.scrollback).toBe(SHOWN);
    // It reaches the view in the reply only, once: not also as output of the new shell.
    expect(shown.join("")).toBe("");
    lastPty().emitData("after-restart-line\r\n");
    // A reloaded window is handed the old output, then the new, as history: none of it as output of the running shell.
    shown = [];
    const replayed = await start();
    expect(replayed).toMatchObject({ ok: true, replayed: true, scrollback: `${SHOWN}after-restart-line\r\n` });
    expect(shown.join("")).toBe("");
  });

  it("does not hand the output to a view that did not ask to be restored, and continues the tab's replay from it", async () => {
    await terminalScrollbackStore(PROFILE).save(TAB, "ended-shell-line\r\n");
    const restarted = await start();
    if (!restarted.ok) throw new Error(restarted.message);
    // A view that kept the tab's terminal alive already shows it.
    expect("scrollback" in restarted).toBe(false);
    expect(shown.join("")).toBe("");
  });

  it("keeps a window's tabs as its view sent them before the window closed, and shutdown waits for them", async () => {
    expect((await start({ tabId: "terminal:0000beef-2" })).ok).toBe(true);
    lastPty().emitData("window closing\r\n");
    keepTerminalOutput("terminal:0000beef-2", WINDOW, "window closing\r\n");
    killTerminalsOwnedBy(WINDOW);
    // Shutdown right after a window closes waits for what that window's tabs showed, though no shell is left to end.
    await forceKillAllTerminalsForShutdown(0);
    expect(await terminalScrollbackStore(PROFILE).read("terminal:0000beef-2")).toBe("window closing\r\n");
  });

  it("keeps a tab for its own window only, a closed tab not at all, and nothing larger than a terminal's replay", async () => {
    expect((await start()).ok).toBe(true);
    expect(keepTerminalOutput(TAB, WINDOW + 1, "another window's\r\n")).toEqual({ ok: false, error: "no-terminal" });
    expect(keepTerminalOutput(TAB, WINDOW, "y".repeat(TERMINAL_REPLAY_MAX_BYTES + 1))).toEqual({ ok: false, error: "invalid-params" });
    await store.settled();
    expect(keptFiles()).toEqual([]);
    // What the tab's close does: end the shell, forget its output. Its view's last word, arriving after, does not write it back.
    killTerminal(TAB);
    forgetTerminalScrollback(TAB);
    expect(keepTerminalOutput(TAB, WINDOW, "closing this tab\r\n")).toEqual({ ok: false, error: "no-terminal" });
    await forceKillAllTerminalsForShutdown(0);
    expect(keptFiles()).toEqual([]);
  });

  it("drops what was kept and says so once when the view could not serialize its terminal, or the disk refused", async () => {
    const quiet = vi.fn();
    setTerminalScrollbackStore(store, quiet);
    expect((await start()).ok).toBe(true);
    keepTerminalOutput(TAB, WINDOW, "kept tab\r\n");
    await store.settled();
    expect(quiet).not.toHaveBeenCalled();
    expect(await store.read(TAB)).toBe("kept tab\r\n");
    // The view's terminal could not be serialized: what was kept before does not come back in its place.
    expect(keepTerminalOutput(TAB, WINDOW, null)).toEqual({ ok: true });
    await store.settled();
    expect(keptFiles()).toEqual([]);
    expect(quiet).toHaveBeenCalledOnce();

    const refusing: TerminalScrollbackStore = { ...store, save: () => Promise.reject(new Error("no space left on device")) };
    const notKept = vi.fn();
    setTerminalScrollbackStore(refusing, notKept);
    keepTerminalOutput(TAB, WINDOW, "first\r\n");
    await vi.waitFor(() => expect(notKept).toHaveBeenCalledOnce());
    expect((await start({ tabId: "terminal:0000beef-2" })).ok).toBe(true);
    keepTerminalOutput("terminal:0000beef-2", WINDOW, "second\r\n");
    keepTerminalOutput(TAB, WINDOW, null);
    await forceKillAllTerminalsForShutdown(0);
    await Promise.resolve();
    expect(notKept).toHaveBeenCalledOnce();
  });

  it("says once that the output a tab kept could not be read, and starts the tab without it", async () => {
    const notKept = vi.fn();
    const unreadable: TerminalScrollbackStore = { ...store, read: () => Promise.reject(new Error("kept terminal output is larger than a terminal's replay")) };
    setTerminalScrollbackStore(unreadable, notKept);
    const restored = await start({ restore: true });
    if (!restored.ok) throw new Error(restored.message);
    expect("scrollback" in restored).toBe(false);
    expect(notKept).toHaveBeenCalledOnce();
    expect((await start({ tabId: "terminal:0000beef-2", restore: true })).ok).toBe(true);
    expect(notKept).toHaveBeenCalledOnce();
  });

  it("keeps a secret the shell printed out of everything but the private file", async () => {
    expect((await start()).ok).toBe(true);
    lastPty().emitData("export TOKEN=SENTINEL-7f3a\r\n");
    keepTerminalOutput(TAB, WINDOW, "export TOKEN=SENTINEL-7f3a\r\n");
    await forceKillAllTerminalsForShutdown(0);
    const directory = join(aveHome, TERMINAL_SCROLLBACK_DIRECTORY);
    const everywhere: string[] = [];
    const walk = (at: string): void => {
      for (const name of readdirSync(at)) {
        const path = join(at, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (readFileSync(path, "utf-8").includes("SENTINEL-7f3a")) everywhere.push(path);
      }
    };
    walk(aveHome);
    expect(everywhere).toEqual([join(directory, keptFiles()[0] ?? "")]);
  });
});
