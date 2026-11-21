/** Boot's one sweep of host tabs' kept output and the store it installs. The settings are the real service over a real settings file, the store is the
 * real one on a real directory; a fake PTY stands for the shell. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { configureHostResources } from "../../../main/host-resources.js";

type ExitCb = (e: { exitCode: number; signal?: number }) => void;
class FakePty {
  pid = 4243;
  private exitCbs = new Set<ExitCb>();
  onData() { return { dispose: () => {} }; }
  onExit(cb: ExitCb) { this.exitCbs.add(cb); return { dispose: () => { this.exitCbs.delete(cb); } }; }
  write() {}
  resize() {}
  kill() { for (const cb of [...this.exitCbs]) cb({ exitCode: 0 }); }
}
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({ spawn: () => { const pty = new FakePty(); ptys.push(pty); return pty; } }));
vi.mock("../../../main/terminal/shell-process.js", () => ({
  readTerminalForeground: vi.fn(async () => ({ ok: true, foreground: { pid: 4243, command: "zsh", cwd: "/w" } })),
  readSandboxedShell: vi.fn(),
  forwardResizeToSandboxedPtyRelay: vi.fn(),
}));

import { __resetTerminalsForTest, keepTerminalOutput, spawnTerminal } from "../../../main/terminal/pty-manager.js";
import {
  terminalScrollbackProfile, terminalScrollbackStore, unresolvedTerminalScrollbackProfile, type TerminalScrollbackStore,
} from "../../../main/terminal/terminal-scrollback-store.js";
import { SettingsService, settingsFilePath } from "../../../data/settings-store.js";
import { createBootHostFixture, createDesktopHostFixture, unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { getLocale, setLocale } from "../../../i18n/index.js";
import { _resetAveHomePrivacyForTest, setAveHomeConfigurationRefusedAtBoot } from "../../../shared/ave-home.js";
import { setupTerminalScrollback } from "../terminal-scrollback-setup.js";

/** Shown in the saved layout's pane. */
const SHOWN = "terminal:0000c0de-1";
/** One of the saved layout's side tabs. */
const SIDE = "terminal:0000c0de-2";
/** Closed by an earlier run: in no layout. */
const CLOSED = "terminal:0000dead-9";
const WINDOW = 5;

/** A layout the settings load accepts: SHOWN in the pane, and the given side tabs beside it. */
const layoutWithSideTabs = (sideTabs: readonly string[]) => {
  const shown = { kind: "terminal", tabId: SHOWN, ordinal: 1, cwd: null, url: null, projectRoot: tmpdir() };
  return {
    version: 2, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main", panelOpenIds: [], thumbnailOpenIds: [],
    surfaces: { main: shown }, openSurfaces: [shown],
    sideTabs: { main: sideTabs.map((tabId, index) => ({ kind: "terminal", tabId, ordinal: index + 2, cwd: null, url: null })) },
  };
};

let shellDir: string;
let home: string;
let aveHome: string;
let userData: string;
/** The store the step installs in each test, awaited before the test's directories go. */
let store: TerminalScrollbackStore;
const fire = vi.fn();

/** This run's settings, loaded from the file the previous run left: its text, or none at all. */
const loadSettings = (file: string | null): SettingsService => {
  if (file !== null) writeFileSync(settingsFilePath(userData), file, "utf-8");
  return new SettingsService({ userDataPath: userData, encryption: unavailableSecretEncryption });
};
/** The one-time migrations this build marks a fresh install with, so a file written here loads without a migration write. */
let currentMigrations: readonly string[] = [];
let migrationsDir: string;
beforeAll(() => {
  migrationsDir = mkdtempSync(join(tmpdir(), "ave-boot-scrollback-migrations-"));
  currentMigrations = new SettingsService({ userDataPath: migrationsDir, encryption: unavailableSecretEncryption }).getAll().appliedMigrations ?? [];
});
afterAll(() => { rmSync(migrationsDir, { recursive: true, force: true }); });
const settingsFile = (settings: Record<string, unknown>): string => JSON.stringify({ ...settings, appliedMigrations: currentMigrations });
const settingsWithSystem = (system: unknown): string => settingsFile({ system });
const boot = (settingsService: SettingsService, options: { desktop?: boolean } = {}) => ({
  host: createBootHostFixture({ userDataPath: userData, ...(options.desktop === false ? {} : { desktop: createDesktopHostFixture() }) }),
  settingsService,
  notificationService: { fire },
}) as unknown as Parameters<typeof setupTerminalScrollback>[0];
const inLocale = <T>(locale: "en" | "ko", run: () => T): T => {
  const previous = getLocale();
  setLocale(locale);
  try { return run(); } finally { setLocale(previous); }
};

const start = (tabId: string, options: { restore?: boolean } = {}) =>
  spawnTerminal({ tabId, lane: "manual", purpose: "workspace", ownerWindowId: WINDOW, cwd: tmpdir(), ...(options.restore ? { restore: true } : {}) });
const restoredScrollback = async (tabId: string): Promise<string | undefined> => {
  const restored = await start(tabId, { restore: true });
  if (!restored.ok) throw new Error(restored.message);
  return restored.scrollback;
};
/** What each tab has kept, read after everything asked of the store has run. */
const kept = async () => {
  await store.settled();
  return { shown: await store.read(SHOWN), side: await store.read(SIDE), closed: await store.read(CLOSED) };
};
const EVERYTHING_KEPT = { shown: "shown\r\n", side: "side\r\n", closed: "export TOKEN=closed-tab-secret\r\n" };

beforeEach(async () => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  shellDir = mkdtempSync(join(tmpdir(), "ave-boot-scrollback-shell-"));
  home = mkdtempSync(join(tmpdir(), "ave-boot-scrollback-home-"));
  aveHome = mkdtempSync(join(tmpdir(), "ave-boot-scrollback-avehome-"));
  userData = mkdtempSync(join(tmpdir(), "ave-boot-scrollback-userdata-"));
  const zsh = join(shellDir, "zsh");
  writeFileSync(zsh, "#!/bin/sh\n");
  chmodSync(zsh, 0o755);
  vi.stubEnv("SHELL", zsh);
  vi.stubEnv("HOME", home);
  vi.stubEnv("AVE_HOME", aveHome);
  ptys.length = 0;
  fire.mockClear();
  __resetTerminalsForTest();
  // What the previous run kept: two tabs its layout brings back, and one closed while its window was not showing it.
  const previousRun = terminalScrollbackStore(terminalScrollbackProfile(userData));
  await previousRun.save(SHOWN, "shown\r\n");
  await previousRun.save(SIDE, "side\r\n");
  await previousRun.save(CLOSED, "export TOKEN=closed-tab-secret\r\n");
  store = terminalScrollbackStore(terminalScrollbackProfile(userData));
});
afterEach(async () => {
  await store.settled();
  __resetTerminalsForTest();
  _resetAveHomePrivacyForTest();
  vi.unstubAllEnvs();
  for (const directory of [shellDir, home, aveHome, userData]) rmSync(directory, { recursive: true, force: true });
});

describe("kept terminal output at boot, against a layout read from the settings file", () => {
  it("deletes a closed tab's output though the run never opens a terminal", async () => {
    const settings = loadSettings(settingsWithSystem({ mainLayout: layoutWithSideTabs([SIDE]) }));
    expect(settings.loadedMainLayout()).toMatchObject({ kind: "read", layout: { focusedId: "main" } });
    // The store boot builds itself: the one of the profile whose settings these are.
    setupTerminalScrollback(boot(settings));
    await vi.waitFor(async () => expect(await store.read(CLOSED)).toBeNull());
    expect(await kept()).toEqual({ ...EVERYTHING_KEPT, closed: null });
    expect(ptys).toHaveLength(0);
    expect(fire).not.toHaveBeenCalled();
  });

  it("deletes every tab's output when the file holds settings without a layout", async () => {
    for (const file of [settingsWithSystem({ closeBehavior: "quit" }), settingsFile({})]) {
      await store.save(SHOWN, "shown\r\n");
      await store.save(CLOSED, "export TOKEN=closed-tab-secret\r\n");
      const settings = loadSettings(file);
      expect(settings.loadedMainLayout()).toEqual({ kind: "read", layout: undefined });
      setupTerminalScrollback(boot(settings), () => store);
      expect(await kept()).toEqual({ shown: null, side: null, closed: null });
    }
    expect(fire).not.toHaveBeenCalled();
  });

  it("keeps a tab the loaded layout brings back, though its window saves a layout without it before the tab's view mounts", async () => {
    const settings = loadSettings(settingsWithSystem({ mainLayout: layoutWithSideTabs([SIDE]) }));
    setupTerminalScrollback(boot(settings), () => store);
    // The window settles and saves before the side tab's view has mounted: the layout it writes has no side tabs. The pane's terminal starts
    // first, the side tab's when its view mounts.
    await settings.patch({ system: { mainLayout: layoutWithSideTabs([]) } } as never);
    expect(settings.get("system").mainLayout?.sideTabs).toEqual({ main: [] });
    expect(await restoredScrollback(SHOWN)).toBe("shown\r\n");
    expect(await restoredScrollback(SIDE)).toBe("side\r\n");
    expect((await kept()).closed).toBeNull();
  });

  it("puts the sweep ahead of every read and save of the run, and sweeps once however many terminals start", async () => {
    const keepOnly = vi.spyOn(store, "keepOnly");
    setupTerminalScrollback(boot(loadSettings(settingsWithSystem({ mainLayout: layoutWithSideTabs([SIDE]) }))), () => store);
    // Nothing is awaited after boot: the first shell starts and a tab opened in this run keeps its output at once.
    const opened = "terminal:0000f00d-3";
    const restoring = restoredScrollback(SHOWN);
    expect((await start(opened)).ok).toBe(true);
    expect(keepTerminalOutput(opened, WINDOW, "opened this run\r\n")).toEqual({ ok: true });
    expect(await restoring).toBe("shown\r\n");
    // The new tab is in no loaded layout; its save came after the sweep, so it stays.
    expect((await kept()).closed).toBeNull();
    expect(await store.read(opened)).toBe("opened this run\r\n");
    expect(keepOnly).toHaveBeenCalledOnce();
    expect(keepOnly.mock.calls[0]?.[0]).toEqual(new Set([SHOWN, SIDE]));
  });
});

describe("kept terminal output at boot, when the layout on disk is not known", () => {
  it.each([
    ["no settings file (a fresh install)", null, "no-file"],
    ["a settings file that cannot be parsed", "{ \"system\": { \"mainLayout\":", "unreadable"],
    ["a settings file that does not hold settings", "[]", "unreadable"],
    ["a stored layout this build refuses", settingsWithSystem({ mainLayout: { ...layoutWithSideTabs([SIDE]), version: 99 } }), "layout-refused"],
    ["a stored system block this build refuses", settingsFile({ system: "not settings" }), "layout-refused"],
  ] as const)("deletes nothing for %s, and keeps saving and restoring", async (_case, file, reason) => {
    const settings = loadSettings(file);
    // The run starts on defaults, which name no tab: a sweep against them would delete every tab's output.
    expect(settings.get("system").mainLayout).toBeUndefined();
    expect(settings.loadedMainLayout()).toEqual({ kind: "unknown", reason });
    const keepOnly = vi.spyOn(store, "keepOnly");
    setupTerminalScrollback(boot(settings), () => store);
    expect(keepOnly).not.toHaveBeenCalled();
    expect(await kept()).toEqual(EVERYTHING_KEPT);
    expect(await restoredScrollback(SHOWN)).toBe("shown\r\n");
    const opened = "terminal:0000f00d-3";
    expect((await start(opened)).ok).toBe(true);
    expect(keepTerminalOutput(opened, WINDOW, "opened this run\r\n")).toEqual({ ok: true });
    await store.settled();
    expect(await store.read(opened)).toBe("opened this run\r\n");
    expect(fire).not.toHaveBeenCalled();
  });

  it("deletes nothing when the settings file cannot be read", async () => {
    // Something is at the settings path but cannot be read as a file.
    mkdirSync(settingsFilePath(userData));
    const settings = loadSettings(null);
    expect(settings.get("system").mainLayout).toBeUndefined();
    expect(settings.loadedMainLayout()).toEqual({ kind: "unknown", reason: "unreadable" });
    setupTerminalScrollback(boot(settings), () => store);
    expect(await kept()).toEqual(EVERYTHING_KEPT);
    expect(await restoredScrollback(SIDE)).toBe("side\r\n");
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("kept terminal output at boot, for what the layout does not speak for", () => {
  it("deletes nothing in a run that refused the Ave home's configuration, and keeps saving and restoring", async () => {
    setAveHomeConfigurationRefusedAtBoot(aveHome);
    const settings = loadSettings(settingsWithSystem({ mainLayout: layoutWithSideTabs([]) }));
    // The file is read, and its layout names neither the side tab nor the closed one.
    expect(settings.loadedMainLayout()).toMatchObject({ kind: "read" });
    const keepOnly = vi.spyOn(store, "keepOnly");
    setupTerminalScrollback(boot(settings), () => store);
    expect(keepOnly).not.toHaveBeenCalled();
    expect(await kept()).toEqual(EVERYTHING_KEPT);
    expect(await restoredScrollback(SIDE)).toBe("side\r\n");
    expect(keepTerminalOutput(SIDE, WINDOW, "side, later\r\n")).toEqual({ ok: true });
    await store.settled();
    expect(await store.read(SIDE)).toBe("side, later\r\n");
    expect(fire).not.toHaveBeenCalled();
  });

  it("leaves another profile's tabs alone: a profile sharing the Ave home sweeps only its own", async () => {
    // Another profile (a source run's, say) with the same Ave home, whose readable settings hold no layout, and one closed tab of its own.
    const otherUserData = mkdtempSync(join(tmpdir(), "ave-boot-scrollback-other-userdata-"));
    try {
      const otherTab = "terminal:0000f00d-7";
      const otherStore = terminalScrollbackStore(terminalScrollbackProfile(otherUserData));
      await otherStore.save(otherTab, "other profile, closed\r\n");
      writeFileSync(settingsFilePath(otherUserData), settingsWithSystem({ closeBehavior: "quit" }), "utf-8");
      const otherSettings = new SettingsService({ userDataPath: otherUserData, encryption: unavailableSecretEncryption });
      expect(otherSettings.loadedMainLayout()).toEqual({ kind: "read", layout: undefined });
      const otherBoot = { ...boot(otherSettings), host: createBootHostFixture({ userDataPath: otherUserData }) } as Parameters<typeof setupTerminalScrollback>[0];
      setupTerminalScrollback(otherBoot, () => otherStore);
      await otherStore.settled();
      expect(await otherStore.read(otherTab)).toBeNull();
      // This profile's tabs, the closed one too, are not the other layout's to judge.
      expect(await kept()).toEqual(EVERYTHING_KEPT);
      // This profile's own sweep still takes its closed tab.
      setupTerminalScrollback(boot(loadSettings(settingsWithSystem({ mainLayout: layoutWithSideTabs([SIDE]) }))), () => store);
      expect(await kept()).toEqual({ ...EVERYTHING_KEPT, closed: null });
    } finally {
      rmSync(otherUserData, { recursive: true, force: true });
    }
  });
});

describe("kept terminal output at boot, when the sweep fails", () => {
  it("deletes nothing when the settings directory cannot be resolved, tells the user once, and still keeps this run's tabs", async () => {
    const settings = loadSettings(settingsWithSystem({ mainLayout: layoutWithSideTabs([]) }));
    // The directory went after settings loaded: its earlier files may be under a name this run cannot know.
    rmSync(userData, { recursive: true, force: true });
    const asked: string[] = [];
    const keepOnly = vi.spyOn(store, "keepOnly");
    inLocale("en", () => setupTerminalScrollback(boot(settings), (profile) => { asked.push(profile); return store; }));
    expect(asked).toEqual([unresolvedTerminalScrollbackProfile(userData)]);
    expect(keepOnly).not.toHaveBeenCalled();
    expect(fire).toHaveBeenCalledExactlyOnceWith({ kind: "system", title: "Terminal", body: "Saved output of closed terminal tabs couldn't be deleted." });
    // The layout names neither the side tab nor the closed one, and both are kept; the store is installed.
    expect(await kept()).toEqual(EVERYTHING_KEPT);
    expect(await restoredScrollback(SIDE)).toBe("side\r\n");
    expect(keepTerminalOutput(SIDE, WINDOW, "side, later\r\n")).toEqual({ ok: true });
    await store.settled();
    expect(await store.read(SIDE)).toBe("side, later\r\n");
    expect(fire).toHaveBeenCalledOnce();
  });

  it("starts the first shell and tells the user once, in their language, when the layout cannot be read, removing nothing", async () => {
    const settings = loadSettings(settingsWithSystem({ mainLayout: layoutWithSideTabs([SIDE]) }));
    for (const [locale, title, body] of [
      ["en", "Terminal", "Saved output of closed terminal tabs couldn't be deleted."],
      ["ko", "터미널", "닫은 터미널 탭에 저장된 출력을 삭제하지 못했습니다."],
    ] as const) {
      fire.mockClear();
      vi.spyOn(settings, "loadedMainLayout").mockImplementationOnce(() => { throw new Error("the layout is not readable"); });
      expect(() => inLocale(locale, () => setupTerminalScrollback(boot(settings), () => store))).not.toThrow();
      expect(fire).toHaveBeenCalledExactlyOnceWith({ kind: "system", title, body });
    }
    expect(await restoredScrollback(SHOWN)).toBe("shown\r\n");
    expect(await kept()).toEqual(EVERYTHING_KEPT);
    expect(fire).toHaveBeenCalledOnce();
  });

  it("starts the first shell and tells the user once when the sweep fails", async () => {
    const failing: TerminalScrollbackStore = { ...store, keepOnly: () => Promise.reject(new Error("the kept terminal output directory is open to other users")) };
    setupTerminalScrollback(boot(loadSettings(settingsWithSystem({ mainLayout: layoutWithSideTabs([SIDE]) }))), () => failing);
    await vi.waitFor(() => expect(fire).toHaveBeenCalledOnce());
    expect(await restoredScrollback(SHOWN)).toBe("shown\r\n");
    expect((await start(SIDE)).ok).toBe(true);
    expect(fire).toHaveBeenCalledOnce();
  });

  it("only logs a failed sweep in a run without a desktop", async () => {
    const settings = loadSettings(settingsWithSystem({ mainLayout: layoutWithSideTabs([SIDE]) }));
    vi.spyOn(settings, "loadedMainLayout").mockImplementationOnce(() => { throw new Error("the layout is not readable"); });
    setupTerminalScrollback(boot(settings, { desktop: false }), () => store);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("the store boot installs", () => {
  it("tells the user, in their language, of a tab whose output could not be kept", async () => {
    const settings = loadSettings(settingsWithSystem({ mainLayout: layoutWithSideTabs([SIDE]) }));
    setupTerminalScrollback(boot(settings), () => store);
    expect(await restoredScrollback(SHOWN)).toBe("shown\r\n");
    for (const [locale, title, body] of [
      ["en", "Terminal", "Terminal output couldn't be saved; it won't be restored."],
      ["ko", "터미널", "터미널 출력을 저장하지 못했습니다. 복원되지 않습니다."],
    ] as const) {
      // Each boot installs the store anew, and with it the once-per-run notice.
      setupTerminalScrollback(boot(settings), () => store);
      fire.mockClear();
      expect(inLocale(locale, () => keepTerminalOutput(SHOWN, WINDOW, null))).toEqual({ ok: true });
      expect(fire).toHaveBeenCalledExactlyOnceWith({ kind: "system", title, body });
    }
  });
});
