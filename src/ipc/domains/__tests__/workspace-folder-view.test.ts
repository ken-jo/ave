// Folder view main-side contract: widened listDir entries and the user-gesture open-in-default-app channel.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import * as fsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const { handlers, openPathMock, additionalDirectories, defaultSession } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openPathMock: vi.fn(async (_target: string) => ""),
  additionalDirectories: { value: [] as string[] },
  defaultSession: {},
}));

vi.mock("electron", () => ({
  session: { defaultSession },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: openPathMock },
}));

vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({
    permissions: { additionalDirectories: additionalDirectories.value, pendingWorkspaceRootRemovals: [] },
  }),
  addAllowedDirectoryPersist: vi.fn(async () => []),
  removeAllowedDirectoryPersist: vi.fn(async () => []),
  beginWorkspaceRootRemovalPersist: vi.fn(),
  completeWorkspaceRootRemovalPersist: vi.fn(),
}));

import { registerWorkspaceHandlers } from "../workspace.js";
import { linkChainVerdict } from "../../../main/external-open-target.js";
import { CHANNELS } from "../../../contract/app-contract.js";

const appWindows: Array<{ isDestroyed: () => boolean; webContents: unknown }> = [];
const auditLog = vi.fn();
const deps = {
  auditLogger: { log: auditLog },
  pluginRuntime: { retireSandboxGrantsOutsideCeiling: vi.fn(async () => []) },
  getMainWindow: () => appWindows[0] ?? null,
  getAppWindows: () => appWindows,
} as never;

const OK_FRAME = "file:///app/index.html";
const GESTURE = Object.freeze({ inputOrigin: "user-keyboard", userActivation: true });

function frameEvent(options: { url?: string; mainFrame?: boolean } = {}) {
  const frame = { url: options.url ?? OK_FRAME, processId: 1, routingId: 0, detached: false, isDestroyed: () => false };
  const otherFrame = { ...frame, routingId: 9 };
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: options.mainFrame === false ? otherFrame : frame,
    session: defaultSession,
    getType: () => "window",
    isDestroyed: () => false,
  });
  appWindows.push({ isDestroyed: () => false, webContents: sender });
  return { sender, senderFrame: frame };
}

function invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(handler(event, ...args));
}

type ListResult = {
  ok: boolean;
  error?: string;
  truncated?: boolean;
  hidden?: number;
  entries?: Array<{ name: string; path: string; type: string; outside?: boolean; size: number; mtimeMs: number; birthtimeMs: number }>;
};

const openPath = (payload: unknown, event: unknown = frameEvent()) =>
  invoke(CHANNELS.workspace.openPath, event, payload) as Promise<{ ok: boolean; error?: string }>;

let root: string;
let outside: string;
// File symlinks need a privilege Windows grants only in developer mode; tests that rely on them skip without it.
let fileLinks = true;
function linkFile(target: string, path: string): void {
  if (!fileLinks) return;
  try {
    symlinkSync(target, path, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    fileLinks = false;
  }
}
const needsFileLinks = (skip: (note?: string) => void): void => { if (!fileLinks) skip("file symlinks need a privilege this host lacks"); };

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ave-folder-view-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "ave-folder-view-outside-")));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "notes.md"), "# Notes\n");
  writeFileSync(join(root, "settlement.sqlite"), Buffer.from([0x53, 0x51, 0x4c, 0x00]));
  writeFileSync(join(root, "deploy.sh"), "#!/bin/sh\necho hi\n");
  writeFileSync(join(outside, "secret.txt"), "outside\n");
  writeFileSync(join(outside, "run.sh"), "#!/bin/sh\n");
  symlinkSync(outside, join(root, "shared-config"), process.platform === "win32" ? "junction" : "dir");
  linkFile(join(outside, "secret.txt"), join(root, "escape.txt"));
  linkFile(join(root, "src", "notes.md"), join(root, "inside-link.md"));
  linkFile(join(root, "src", "index.ts"), join(root, "innocent.sh"));
  linkFile(join(outside, "run.sh"), join(root, "looks-fine.txt"));
  additionalDirectories.value = [root];
  registerWorkspaceHandlers(deps);
});

afterAll(async () => {
  await cleanupTmpDir(root);
  await cleanupTmpDir(outside);
});

beforeEach(() => {
  appWindows.length = 0;
  openPathMock.mockClear();
  openPathMock.mockResolvedValue("");
  auditLog.mockClear();
});

describe("workspace.listDir folder-view entries", () => {
  it("adds size, modified and created times from one lstat per entry", async () => {
    const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), root)) as ListResult;
    expect(res.ok).toBe(true);
    const file = res.entries?.find((entry) => entry.name === "settlement.sqlite");
    expect(file).toMatchObject({ type: "file", size: 4 });
    expect(file!.mtimeMs).toBeGreaterThan(0);
    expect(file!.birthtimeMs).toBeGreaterThanOrEqual(0);
    expect(res.hidden).toBe(0);
  });

  it("reports a link as a link with an outside flag and never follows it", async ({ skip }) => {
    needsFileLinks(skip);
    const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), root)) as ListResult;
    const shared = res.entries?.find((entry) => entry.name === "shared-config");
    const escape = res.entries?.find((entry) => entry.name === "escape.txt");
    const inside = res.entries?.find((entry) => entry.name === "inside-link.md");
    expect(shared).toMatchObject({ type: "link", outside: true, path: join(root, "shared-config") });
    expect(escape).toMatchObject({ type: "link", outside: true, path: join(root, "escape.txt") });
    expect(inside).toMatchObject({ type: "link", outside: false });
    // The link's target never crosses IPC.
    expect(JSON.stringify(res)).not.toContain(outside);
  });

  it("counts hidden sensitive entries so the empty copy can say whether any were hidden", async () => {
    const dir = join(root, "hidden-only");
    mkdirSync(dir);
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), dir)) as ListResult;
      expect(res).toMatchObject({ ok: true, entries: [], hidden: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hides a sensitive name that is a link, and counts it", async ({ skip }) => {
    needsFileLinks(skip);
    const dir = join(root, "linked-secret");
    mkdirSync(dir);
    writeFileSync(join(dir, "plain.txt"), "x");
    linkFile("plain.txt", join(dir, ".env"));
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), dir)) as ListResult;
      expect(res.ok).toBe(true);
      expect(res.entries?.map((entry) => entry.name)).toEqual(["plain.txt"]);
      expect(res.hidden).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["EACCES", "EPERM"])("maps %s to permission-denied", async (code) => {
    const locked = join(root, "keys");
    mkdirSync(locked);
    // Simulated so the case also runs as root and on Windows, where chmod 000 does not lock a folder.
    const spy = vi.spyOn(fsModule.promises, "readdir").mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), locked)) as ListResult;
      expect(res).toMatchObject({ ok: false, error: "permission-denied" });
    } finally {
      spy.mockRestore();
      rmSync(locked, { recursive: true, force: true });
    }
  });

  it("maps a folder that vanished to not-found", async () => {
    const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), join(root, "gone"))) as ListResult;
    expect(res).toMatchObject({ ok: false, error: "not-found" });
  });

  it("sets truncated at the 1,001st entry", async () => {
    const many = join(root, "many");
    mkdirSync(many);
    for (let i = 0; i < 1_001; i += 1) writeFileSync(join(many, `f${i}.txt`), "");
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), many)) as ListResult;
      expect(res.ok).toBe(true);
      expect(res.entries).toHaveLength(1_000);
      expect(res.truncated).toBe(true);
    } finally {
      rmSync(many, { recursive: true, force: true });
    }
  });
});

describe("workspace.openPath", () => {
  it("opens a regular in-project file with the default app and audits an opaque reference", async () => {
    const target = join(root, "settlement.sqlite");
    expect(await openPath({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: true });
    expect(openPathMock).toHaveBeenCalledWith(target);
    const entry = auditLog.mock.calls.map(([value]) => value as { input?: string }).find((value) =>
      value.input?.includes(CHANNELS.workspace.openPath));
    expect(entry?.input).toBeDefined();
    expect(entry!.input).not.toContain(root);
    expect(entry!.input).toContain("\"ok\":true");
  });

  it("follows an in-project link to an in-project file", async ({ skip }) => {
    needsFileLinks(skip);
    expect(await openPath({ projectRoot: root, path: join(root, "inside-link.md"), intent: GESTURE })).toEqual({ ok: true });
    expect(openPathMock).toHaveBeenCalledWith(join(root, "src", "notes.md"));
  });

  it("refuses a call without a user gesture", async () => {
    const target = join(root, "settlement.sqlite");
    expect(await openPath({ projectRoot: root, path: target, intent: { inputOrigin: "user-keyboard", userActivation: false } }))
      .toEqual({ ok: false, error: "user-keyboard-required" });
    expect(await openPath({ projectRoot: root, path: target })).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("refuses a sender that is not an app window's main frame", async () => {
    const payload = { projectRoot: root, path: join(root, "settlement.sqlite"), intent: GESTURE };
    expect(await openPath(payload, frameEvent({ mainFrame: false }))).toEqual({ ok: false, error: "unauthorized" });
    expect(await openPath(payload, frameEvent({ url: "https://evil.example.com/" }))).toEqual({ ok: false, error: "unauthorized" });
    const detached = frameEvent();
    appWindows.length = 0;
    expect(await openPath(payload, detached)).toEqual({ ok: false, error: "unauthorized" });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("refuses a project root that is not registered", async () => {
    expect(await openPath({ projectRoot: outside, path: join(outside, "secret.txt"), intent: GESTURE }))
      .toEqual({ ok: false, error: "root-not-registered" });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("refuses path traversal out of the project", async () => {
    // Spelled with its `..` segments: `join` would fold them away.
    const traversal = [root, "src", "..", "..", outside.split(/[\\/]/).pop()!, "secret.txt"].join("/");
    expect(await openPath({ projectRoot: root, path: traversal, intent: GESTURE })).toEqual({ ok: false, error: "invalid-request" });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("refuses an in-project link whose target escapes the project", async ({ skip }) => {
    needsFileLinks(skip);
    // The outside folder is readable scope here, so only the in-project check can refuse it.
    additionalDirectories.value = [root, outside];
    try {
      expect(await openPath({ projectRoot: root, path: join(root, "escape.txt"), intent: GESTURE }))
        .toEqual({ ok: false, error: "outside-project" });
    } finally {
      additionalDirectories.value = [root];
    }
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("judges the type on the requested spelling and on the link target", async ({ skip }) => {
    needsFileLinks(skip);
    expect(await openPath({ projectRoot: root, path: join(root, "deploy.sh"), intent: GESTURE }))
      .toEqual({ ok: false, error: "type-not-allowed" });
    expect(await openPath({ projectRoot: root, path: join(root, "innocent.sh"), intent: GESTURE }))
      .toEqual({ ok: false, error: "type-not-allowed" });
    additionalDirectories.value = [root, outside];
    try {
      expect(await openPath({ projectRoot: root, path: join(root, "looks-fine.txt"), intent: GESTURE }))
        .toEqual({ ok: false, error: "type-not-allowed" });
    } finally {
      additionalDirectories.value = [root];
    }
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("refuses a directory, including an .app bundle and one named like a document", async () => {
    mkdirSync(join(root, "Tool.app"), { recursive: true });
    mkdirSync(join(root, "bundle.zip"), { recursive: true });
    try {
      expect(await openPath({ projectRoot: root, path: join(root, "src"), intent: GESTURE }))
        .toEqual({ ok: false, error: "type-not-allowed" });
      expect(await openPath({ projectRoot: root, path: join(root, "bundle.zip"), intent: GESTURE }))
        .toEqual({ ok: false, error: "not-a-file" });
      expect(await openPath({ projectRoot: root, path: join(root, "Tool.app"), intent: GESTURE }))
        .toEqual({ ok: false, error: "type-not-allowed" });
    } finally {
      rmSync(join(root, "Tool.app"), { recursive: true, force: true });
      rmSync(join(root, "bundle.zip"), { recursive: true, force: true });
    }
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("refuses malformed payloads", async () => {
    expect(await openPath(null)).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(await openPath({ projectRoot: 3, path: join(root, "settlement.sqlite"), intent: GESTURE }))
      .toEqual({ ok: false, error: "invalid-request" });
    expect(await openPath({ projectRoot: root, path: "", intent: GESTURE })).toEqual({ ok: false, error: "invalid-request" });
    expect(await openPath({ projectRoot: root, path: "src/index.ts", intent: GESTURE })).toEqual({ ok: false, error: "invalid-request" });
  });

  it("refuses a file swapped for an outside link between the check and the open", async ({ skip }) => {
    needsFileLinks(skip);
    additionalDirectories.value = [root, outside];
    const swapped = join(root, "swap.txt");
    writeFileSync(swapped, "inside\n");
    const realStat = fsModule.promises.stat;
    const spy = vi.spyOn(fsModule.promises, "stat").mockImplementationOnce(async (...args: Parameters<typeof realStat>) => {
      const result = await realStat(...args);
      unlinkSync(swapped);
      symlinkSync(join(outside, "secret.txt"), swapped, "file");
      return result;
    });
    try {
      const res = await openPath({ projectRoot: root, path: swapped, intent: GESTURE });
      expect(res.ok).toBe(false);
      expect(["changed", "outside-project"]).toContain(res.error);
      expect(openPathMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      additionalDirectories.value = [root];
      rmSync(swapped, { force: true });
    }
  });

  it("reports the default app's failure without claiming success", async () => {
    openPathMock.mockResolvedValueOnce("No application knows how to open this file");
    expect(await openPath({ projectRoot: root, path: join(root, "settlement.sqlite"), intent: GESTURE }))
      .toEqual({ ok: false, error: "open-failed" });
  });

  // Only documents, media, plain data and zip reach the default app; everything else is refused, whatever the OS would do.
  it.each(["pdf", "png", "docx", "xlsx", "md", "csv", "json", "mp4", "zip", "sqlite"])("opens a .%s file", async (extension) => {
    const target = join(root, `sample.${extension}`);
    writeFileSync(target, "x", { mode: 0o644 });
    try {
      expect(await openPath({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: true });
      expect(openPathMock).toHaveBeenCalledWith(target);
    } finally {
      rmSync(target, { force: true });
    }
  });

  it.each([
    // Formats an earlier deny list named, and the ones review found it missed.
    "command", "webloc", "inetloc", "ftploc", "afploc", "mpkg", "lnk", "url", "js", "hta", "reg", "jar",
    "py", "pyw", "jnlp", "appinstaller", "diagcab", "library-ms", "search-ms", "searchConnector-ms", "ts", "html", "svg", "xml",
  ])("refuses to open a .%s file", async (extension) => {
    const target = join(root, `payload.${extension}`);
    writeFileSync(target, "x", { mode: 0o644 });
    try {
      expect(await openPath({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: false, error: "type-not-allowed" });
      expect(openPathMock).not.toHaveBeenCalled();
    } finally {
      rmSync(target, { force: true });
    }
  });

  it("refuses an extensionless file and judges a double extension by the last one", async () => {
    const cases: Array<[string, boolean]> = [["Makefile", false], ["report.pdf.exe", false], ["archive.exe.zip", true], ["notes.", false]];
    for (const [name, allowed] of cases) {
      const target = join(root, name);
      writeFileSync(target, "x", { mode: 0o644 });
      try {
        expect(await openPath({ projectRoot: root, path: target, intent: GESTURE }))
          .toEqual(allowed ? { ok: true } : { ok: false, error: "type-not-allowed" });
      } finally {
        rmSync(target, { force: true });
      }
    }
  });

  it("refuses a disallowed format reached through an innocent-looking link", async ({ skip }) => {
    needsFileLinks(skip);
    const shortcut = join(root, "elsewhere.lnk");
    writeFileSync(shortcut, "x", { mode: 0o644 });
    linkFile(shortcut, join(root, "notes.txt"));
    try {
      expect(await openPath({ projectRoot: root, path: join(root, "notes.txt"), intent: GESTURE }))
        .toEqual({ ok: false, error: "type-not-allowed" });
      expect(openPathMock).not.toHaveBeenCalled();
    } finally {
      rmSync(join(root, "notes.txt"), { force: true });
      rmSync(shortcut, { force: true });
    }
  });

  it("refuses an allowed format that carries an execute bit", async ({ skip }) => {
    if (process.platform === "win32") skip("Windows has no execute bit");
    for (const name of ["notes.txt", "photo.png"]) {
      const target = join(root, name);
      writeFileSync(target, "#!/bin/sh\n");
      chmodSync(target, 0o755);
      try {
        expect(await openPath({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: false, error: "executable" });
      } finally {
        rmSync(target, { force: true });
      }
    }
    expect(openPathMock).not.toHaveBeenCalled();
  });
});

describe("workspace.openPath links to network locations", () => {
  it("refuses a chain that ends at a UNC path before resolving anything", async ({ skip }) => {
    needsFileLinks(skip);
    linkFile("//fileserver/share/a.txt", join(root, "hop.txt"));
    linkFile("hop.txt", join(root, "shared-notes.txt"));
    const realpath = vi.spyOn(fsModule.promises, "realpath");
    try {
      expect(await openPath({ projectRoot: root, path: join(root, "shared-notes.txt"), intent: GESTURE }))
        .toEqual({ ok: false, error: "network-target" });
      expect(realpath).not.toHaveBeenCalled();
      expect(openPathMock).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
      rmSync(join(root, "shared-notes.txt"), { force: true });
      rmSync(join(root, "hop.txt"), { force: true });
    }
  });
});

describe("the open path's link chain with `..`", () => {
  it("refuses a link whose target climbs out of another link, which a lexical follow would place beside it", async ({ skip }) => {
    needsFileLinks(skip);
    const dir = join(root, "climb-open");
    mkdirSync(dir);
    writeFileSync(join(dir, "x.txt"), "x");
    symlinkSync("../out/sub", join(dir, "linkdir"), process.platform === "win32" ? "dir" : undefined);
    linkFile("linkdir/../x.txt", join(dir, "trick"));
    try {
      expect(await linkChainVerdict(join(dir, "x.txt"))).toBe("local");
      expect(await linkChainVerdict(join(dir, "trick"))).toBe("network");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a requested `.` or `..` segment before any lstat or realpath", async ({ skip }) => {
    needsFileLinks(skip);
    // `mnt/..` is `other` to the OS but `root` to a lexical fold, where `x.txt` links to a UNC path: the checks and the open
    // must never see different files.
    const dir = join(root, "climb-request");
    mkdirSync(join(dir, "other", "inner"), { recursive: true });
    writeFileSync(join(dir, "other", "x.txt"), "x");
    symlinkSync("other/inner", join(dir, "mnt"), process.platform === "win32" ? "dir" : undefined);
    linkFile("//fileserver/share/x.txt", join(dir, "x.txt"));
    const lstat = vi.spyOn(fsModule.promises, "lstat");
    const realpath = vi.spyOn(fsModule.promises, "realpath");
    try {
      for (const path of [`${dir}/mnt/../x.txt`, `${dir}/./x.txt`]) {
        expect(await openPath({ projectRoot: root, path, intent: GESTURE })).toEqual({ ok: false, error: "invalid-request" });
      }
      expect(lstat).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
      expect(openPathMock).not.toHaveBeenCalled();
    } finally {
      lstat.mockRestore();
      realpath.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workspace.listDir under a root spelled in NFD", () => {
  it("keeps in-project links inside when the root's name is decomposed (a Finder-made Korean folder)", async ({ skip }) => {
    needsFileLinks(skip);
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-folder-view-nfd-")));
    const nfdRoot = join(parent, "프로젝트".normalize("NFD"));
    mkdirSync(join(nfdRoot, "docs"), { recursive: true });
    writeFileSync(join(nfdRoot, "docs", "a.txt"), "x");
    linkFile("docs/a.txt", join(nfdRoot, "relative"));
    // A link written with the composed spelling of the same root: one folder on APFS, which compares names by meaning.
    const composed = process.platform === "darwin" ? join(parent, "프로젝트".normalize("NFC"), "docs", "a.txt") : join(nfdRoot, "docs", "a.txt");
    linkFile(composed, join(nfdRoot, "absolute"));
    linkFile(join(outside, "secret.txt"), join(nfdRoot, "away"));
    additionalDirectories.value = [root, nfdRoot];
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), nfdRoot)) as ListResult;
      const outsideOf = (name: string) => res.entries?.find((entry) => entry.name === name)?.outside;
      expect(outsideOf("relative")).toBe(false);
      // Link targets compare as spelled, with no NFC folding: the composed spelling of the root is outside on macOS (fail
      // closed), and the decomposed spelling elsewhere is inside.
      expect(outsideOf("absolute")).toBe(process.platform === "darwin");
      expect(outsideOf("away")).toBe(true);
    } finally {
      additionalDirectories.value = [root];
      await cleanupTmpDir(parent);
    }
  });
});

describe("workspace.listDir links to network locations", () => {
  it("never resolves through a link: chains and linked folders on the way count as outside", async ({ skip }) => {
    needsFileLinks(skip);
    const dir = join(root, "chain");
    mkdirSync(dir);
    writeFileSync(join(dir, "plain.txt"), "x");
    linkFile("//fileserver/share/config", join(dir, "b"));
    linkFile("b", join(dir, "a"));
    symlinkSync("//fileserver/share", join(dir, "mnt"), process.platform === "win32" ? "dir" : undefined);
    linkFile("mnt/file.txt", join(dir, "through-folder"));
    linkFile("plain.txt", join(dir, "local"));
    linkFile("../src/index.ts", join(dir, "up"));
    const realpath = vi.spyOn(fsModule.promises, "realpath");
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), dir)) as ListResult;
      const outsideOf = (name: string) => res.entries?.find((entry) => entry.name === name)?.outside;
      expect(outsideOf("a")).toBe(true);
      expect(outsideOf("b")).toBe(true);
      expect(outsideOf("mnt")).toBe(true);
      expect(outsideOf("through-folder")).toBe(true);
      expect(outsideOf("local")).toBe(false);
      // A `..` in a target is not judged lexically: fail closed, even when it would land inside.
      expect(outsideOf("up")).toBe(true);
      // Only the listed folder and its project root are resolved, never a link.
      expect(realpath.mock.calls.every(([path]) => String(path) === dir || String(path) === root)).toBe(true);
    } finally {
      realpath.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it("marks a link whose target climbs through another link outside", async ({ skip }) => {
    needsFileLinks(skip);
    const dir = join(root, "climb");
    mkdirSync(dir);
    writeFileSync(join(dir, "x.txt"), "x");
    // The OS resolves `linkdir/..` to the parent of `../out/sub`, not to `climb`: `trick` names `../out/x.txt`.
    symlinkSync("../out/sub", join(dir, "linkdir"), process.platform === "win32" ? "dir" : undefined);
    linkFile("linkdir/../x.txt", join(dir, "trick"));
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), dir)) as ListResult;
      expect(res.entries?.find((entry) => entry.name === "trick")).toMatchObject({ type: "link", outside: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a link outside when its target names an NFC sibling of an NFD folder (Linux keeps both)", async ({ skip }) => {
    needsFileLinks(skip);
    if (process.platform !== "linux") skip();
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "ave-folder-view-nfc-sibling-")));
    const nfdRoot = join(parent, "프로젝트".normalize("NFD"));
    const nfcSibling = join(parent, "프로젝트".normalize("NFC"));
    mkdirSync(nfdRoot);
    mkdirSync(nfcSibling);
    writeFileSync(join(nfcSibling, "a.txt"), "sibling");
    linkFile(join(nfcSibling, "a.txt"), join(nfdRoot, "sibling"));
    additionalDirectories.value = [root, nfdRoot];
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), nfdRoot)) as ListResult;
      expect(res.entries?.find((entry) => entry.name === "sibling")?.outside).toBe(true);
    } finally {
      additionalDirectories.value = [root];
      await cleanupTmpDir(parent);
    }
  });

  it("marks a link to a UNC path outside without resolving it", async ({ skip }) => {
    needsFileLinks(skip);
    const dir = join(root, "net");
    mkdirSync(dir);
    linkFile("//fileserver/share/config", join(dir, "shared"));
    const realpath = vi.spyOn(fsModule.promises, "realpath");
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), dir)) as ListResult;
      expect(res.entries?.find((entry) => entry.name === "shared")).toMatchObject({ type: "link", outside: true });
      expect(realpath.mock.calls.some(([path]) => String(path) === join(dir, "shared"))).toBe(false);
    } finally {
      realpath.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
