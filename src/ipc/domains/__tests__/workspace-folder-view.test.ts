// Folder view main-side contract: widened listDir entries and the user-gesture open-in-default-app channel.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import fsModule from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
import * as fileAccessPolicy from "../../../tools/file-access-policy.js";
import { linkChainVerdict } from "../../../main/external-open-target.js";
import { CHANNELS } from "../../../contract/app-contract.js";

const appWindows: Array<{ isDestroyed: () => boolean; webContents: unknown }> = [];
const auditLog = vi.fn();
const editorCommand = { value: "" };
const deps = {
  auditLogger: { log: auditLog },
  settingsService: { get: (section: string) => (section === "documents" ? { openMode: "direct", editorCommand: editorCommand.value } : undefined) },
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
  editorCommand.value = "";
});

describe("workspace.searchFiles in one folder", () => {
  type SearchResult = { ok: boolean; error?: string; matches?: Array<{ path: string; relativePath: string; root: string }> };
  const search = (query: unknown, options?: unknown) => (options === undefined
    ? invoke(CHANNELS.workspace.searchFiles, frameEvent(), query)
    : invoke(CHANNELS.workspace.searchFiles, frameEvent(), query, options)) as Promise<SearchResult>;

  it("searches the named folder of a registered root by file name", async () => {
    const res = await search("notes", { folder: join(root, "src") });
    expect(res.ok).toBe(true);
    expect(res.matches).toEqual([expect.objectContaining({ path: join(root, "src", "notes.md"), relativePath: "notes.md", root })]);
    // "src" is in every path under the folder but in no file name.
    expect((await search("src", { folder: join(root, "src") })).matches).toEqual([]);
  });

  it("refuses a folder outside every registered root, a relative folder and a malformed option", async () => {
    expect(await search("secret", { folder: outside })).toEqual({ ok: false, error: "folder-not-allowed" });
    expect(await search("notes", { folder: "src" })).toEqual({ ok: false, error: "invalid-query" });
    expect(await search("notes", { folder: 7 })).toEqual({ ok: false, error: "invalid-query" });
    expect(await search("notes", "src")).toEqual({ ok: false, error: "invalid-query" });
  });
});

describe("workspace.listDir folder-view entries", () => {
  it("sorts before it caps, so a folder past the first 1,000 names is still listed, and counts what the cap left out", async ({ onTestFinished }) => {
    const many = mkdtempSync(join(root, "sort-cap-"));
    onTestFinished(() => rmSync(many, { recursive: true, force: true }));
    for (let i = 0; i < 1_100; i += 1) writeFileSync(join(many, `f${String(i).padStart(4, "0")}.txt`), "x");
    mkdirSync(join(many, "zz-folder"));
    const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), many)) as ListResult & { omitted?: number };
    expect(res.ok).toBe(true);
    expect(res.entries).toHaveLength(1_000);
    expect(res.entries?.[0]).toMatchObject({ name: "zz-folder", type: "directory" });
    expect(res.entries?.[1]?.name).toBe("f0000.txt");
    expect(res.entries?.[999]?.name).toBe("f0998.txt");
    expect(res.truncated).toBe(true);
    expect(res.omitted).toBe(101);
  });

  it("keeps synchronous realpath lookups constant as regular siblings are added", async ({ onTestFinished }) => {
    const dir = mkdtempSync(join(root, "sibling-cost-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const list = () => invoke(CHANNELS.workspace.listDir, frameEvent(), dir) as Promise<ListResult>;
    writeFileSync(join(dir, "first.txt"), "");
    // Warm process-wide policy caches before comparing two requests.
    expect((await list()).entries).toHaveLength(1);
    const realpath = vi.spyOn(fsModule.realpathSync, "native");
    onTestFinished(() => { realpath.mockRestore(); });
    expect((await list()).entries).toHaveLength(1);
    const oneEntryCalls = realpath.mock.calls.length;
    expect(oneEntryCalls).toBeGreaterThan(0);
    realpath.mockClear();
    for (let i = 1; i < 32; i += 1) writeFileSync(join(dir, `sibling-${i}.txt`), "");
    expect((await list()).entries).toHaveLength(32);
    expect(realpath).toHaveBeenCalledTimes(oneEntryCalls);
  });

  it("reports nothing omitted for a folder under the cap", async () => {
    const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), join(root, "src"))) as ListResult & { omitted?: number };
    expect(res.truncated).toBe(false);
    expect(res.omitted).toBe(0);
  });

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

  it("hides a key-extension file only when it holds a private key", async () => {
    const dir = join(root, "key-files");
    mkdirSync(dir);
    // The header is written in two parts so no scanner takes this test file for key material.
    writeFileSync(join(dir, "tls.key"), "-----BEGIN PRIVATE" + " KEY-----\nFIXTURE\n");
    writeFileSync(join(dir, "server.pem"), "-----BEGIN RSA PRIVATE" + " KEY-----\nFIXTURE\n");
    writeFileSync(join(dir, "Quarterly review.key"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    mkdirSync(join(dir, "Roadmap.key"));
    writeFileSync(join(dir, "chain.pem"), "-----BEGIN CERTIFICATE-----\nFIXTURE\n-----END CERTIFICATE-----\n");
    // Longer than what is read: a presentation archive nobody could show harmless, and a key whose header is in the part
    // that was read.
    const window = 1024 * 1024;
    writeFileSync(join(dir, "Big deck.key"), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(window * 2, "s")]));
    writeFileSync(join(dir, "big.key"), Buffer.concat([Buffer.from("-----BEGIN PRIVATE" + " KEY-----\nFIXTURE\n"), Buffer.alloc(window * 2, "x")]));
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), dir)) as ListResult;
      expect(res.ok).toBe(true);
      // Only a confirmed key is hidden; the large deck stays the person's to see.
      expect(res.entries?.map((entry) => entry.name).sort()).toEqual(["Big deck.key", "Quarterly review.key", "Roadmap.key", "chain.pem"]);
      expect(res.hidden).toBe(3);
      // An agent read of the large deck still asks: what was not read is not taken for harmless.
      expect(fileAccessPolicy.sensitiveFilePattern(join(dir, "Big deck.key"), "read")).toBe("**/*.key");
      expect(fileAccessPolicy.sensitiveFilePattern(join(dir, "Quarterly review.key"), "read")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes each stored entry name unchanged to key inspection", async () => {
    const dir = join(root, "stored-key-names");
    mkdirSync(dir);
    for (const name of ["Cafe\u0301.key", "\u212A.key", "MiXeD.key"]) {
      writeFileSync(join(dir, name), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    }
    const storedNames = await fsModule.promises.readdir(dir);
    const opened = vi.spyOn(fsModule, "openSync");
    syncBuiltinESMExports();
    try {
      const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), dir)) as ListResult;
      expect(res).toMatchObject({ ok: true, hidden: 0 });
      expect(res.entries?.map((entry) => entry.name).sort()).toEqual(storedNames.sort());
      const inspectedPaths = opened.mock.calls
        .map(([path]) => path)
        .filter((path): path is string => typeof path === "string" && dirname(path) === dir);
      expect(inspectedPaths.sort()).toEqual(storedNames.map((name) => join(dir, name)).sort());
    } finally {
      opened.mockRestore();
      syncBuiltinESMExports();
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

  it("sets truncated at the 1,001st entry", async ({ onTestFinished }) => {
    const many = mkdtempSync(join(root, "truncation-"));
    onTestFinished(() => rmSync(many, { recursive: true, force: true }));
    for (let i = 0; i < 1_001; i += 1) writeFileSync(join(many, `f${i}.txt`), "");
    const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), many)) as ListResult;
    expect(res.ok).toBe(true);
    expect(res.entries).toHaveLength(1_000);
    expect(res.truncated).toBe(true);
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

  it("opens a large presentation document for the person and refuses a confirmed key", async () => {
    const window = 1024 * 1024;
    const deck = join(root, "Big deck.key");
    const key = join(root, "big.key");
    writeFileSync(deck, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(window * 2, "s")]));
    writeFileSync(key, Buffer.concat([Buffer.from("-----BEGIN PRIVATE" + " KEY-----\nFIXTURE\n"), Buffer.alloc(window * 2, "x")]));
    try {
      expect(await openPath({ projectRoot: root, path: deck, intent: GESTURE })).toEqual({ ok: true });
      expect(openPathMock).toHaveBeenCalledWith(deck);
      expect(await openPath({ projectRoot: root, path: key, intent: GESTURE })).toEqual({ ok: false, error: "sensitive-path" });
      expect(openPathMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(deck, { force: true });
      rmSync(key, { force: true });
    }
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
      expect(realpath.mock.calls.map(([path]) => relative(root, String(path)))).toEqual(["chain", ""]);
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

describe("workspace.openInEditor", () => {
  type EditorResult = { ok: boolean; error?: string };
  const openInEditor = (payload: unknown, event: unknown = frameEvent()) =>
    invoke(CHANNELS.workspace.openInEditor, event, payload) as Promise<EditorResult>;
  // A stand-in editor: the runner's script runtime records the arguments it was started with, then exits.
  let recorder: string;
  let runs = 0;
  beforeAll(() => {
    recorder = join(outside, "record-arguments.cjs");
    writeFileSync(recorder, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\nprocess.exit(0);\n');
  });
  function recordingEditor(template: string): { started: () => Promise<string[]> } {
    const out = join(outside, `editor-run-${++runs}.json`);
    const runtime = process.env.AVE_TEST_NODE_EXEC_PATH;
    if (!runtime) throw new Error("The test runner must provide its script runtime");
    editorCommand.value = `"${runtime}" "${recorder}" "${out}" ${template}`;
    return {
      started: async () => {
        await vi.waitFor(() => expect(existsSync(out) && readFileSync(out, "utf8").length > 0).toBe(true), { timeout: 20_000, interval: 50 });
        return JSON.parse(readFileSync(out, "utf8")) as string[];
      },
    };
  }

  it("starts the configured command with the file and the line as whole arguments, and audits an opaque reference", async () => {
    const target = join(root, "src", "index.ts");
    const editor = recordingEditor("--goto {file}:{line}");
    expect(await openInEditor({ projectRoot: root, path: target, line: 7, intent: GESTURE })).toEqual({ ok: true });
    expect(await editor.started()).toEqual(["--goto", `${target}:7`]);
    expect(openPathMock).not.toHaveBeenCalled();
    const entry = auditLog.mock.calls.map(([value]) => value as { input?: string }).find((value) =>
      value.input?.includes(CHANNELS.workspace.openInEditor));
    expect(entry?.input).toBeDefined();
    expect(entry?.input).not.toContain(root);
    expect(entry?.input).toContain("\"ok\":true");
  });

  it("keeps a path with blanks, a quote and shell characters inside one argument, and uses line 1 when none is given", async () => {
    // Every character here is valid in a file name on all three platforms.
    const odd = join(root, "my notes; it's odd $(touch pwned) & more %PATH% ^.txt");
    writeFileSync(odd, "text\n");
    try {
      const editor = recordingEditor("+{line} {file}");
      expect(await openInEditor({ projectRoot: root, path: odd, intent: GESTURE })).toEqual({ ok: true });
      expect(await editor.started()).toEqual(["+1", odd]);
      expect(existsSync(join(root, "pwned"))).toBe(false);
    } finally {
      rmSync(odd, { force: true });
    }
  });

  it("opens a script and a file with an execute bit, which the default app refuses", async ({ skip }) => {
    if (process.platform === "win32") skip("execute bits are POSIX");
    const runnable = join(root, "run-me.txt");
    writeFileSync(runnable, "#!/bin/sh\n");
    chmodSync(runnable, 0o755);
    try {
      for (const target of [join(root, "deploy.sh"), runnable]) {
        const editor = recordingEditor("{file}");
        expect(await openInEditor({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: true });
        expect(await editor.started()).toEqual([target]);
        expect((await openPath({ projectRoot: root, path: target, intent: GESTURE })).ok).toBe(false);
      }
    } finally {
      rmSync(runnable, { force: true });
    }
  });

  it("passes the real file when the requested name is an in-project link", async ({ skip }) => {
    needsFileLinks(skip);
    const editor = recordingEditor("{file}");
    expect(await openInEditor({ projectRoot: root, path: join(root, "inside-link.md"), intent: GESTURE })).toEqual({ ok: true });
    expect(await editor.started()).toEqual([join(root, "src", "notes.md")]);
  });

  it("answers not-configured when no command is set and invalid-command for one it will not start", async () => {
    const target = join(root, "src", "index.ts");
    expect(await openInEditor({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: false, error: "not-configured" });
    editorCommand.value = 'edit "{file}';
    expect(await openInEditor({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: false, error: "invalid-command" });
    editorCommand.value = "./edit {file}";
    expect(await openInEditor({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: false, error: "invalid-command" });
  });

  it("reports a program that cannot be started", async () => {
    editorCommand.value = `"${join(outside, "no-such-editor")}" {file}`;
    expect(await openInEditor({ projectRoot: root, path: join(root, "src", "index.ts"), intent: GESTURE }))
      .toEqual({ ok: false, error: "launch-failed" });
    const entry = auditLog.mock.calls.map(([value]) => value as { input?: string }).find((value) =>
      value.input?.includes(CHANNELS.workspace.openInEditor));
    expect(entry?.input).toContain("\"error\":\"open-failed\"");
  });

  it("refuses everything the default-app open refuses before the hand-off, and starts nothing", async ({ skip }) => {
    needsFileLinks(skip);
    recordingEditor("{file}");
    const out = join(outside, `editor-run-${runs}.json`);
    const target = join(root, "src", "index.ts");
    expect(await openInEditor({ projectRoot: root, path: target })).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(await openInEditor({ projectRoot: root, path: target, intent: { inputOrigin: "user-keyboard", userActivation: false } }))
      .toEqual({ ok: false, error: "user-keyboard-required" });
    expect(await openInEditor({ projectRoot: root, path: target, intent: GESTURE }, frameEvent({ mainFrame: false })))
      .toEqual({ ok: false, error: "unauthorized" });
    expect(await openInEditor({ projectRoot: root, path: target, intent: GESTURE }, frameEvent({ url: "https://evil.example.com/" })))
      .toEqual({ ok: false, error: "unauthorized" });
    expect(await openInEditor({ projectRoot: outside, path: join(outside, "secret.txt"), intent: GESTURE }))
      .toEqual({ ok: false, error: "root-not-registered" });
    expect(await openInEditor({ projectRoot: root, path: `${join(root, "src")}/../src/index.ts`, intent: GESTURE }))
      .toEqual({ ok: false, error: "invalid-request" });
    for (const line of [0, -1, 1.5, "3", Number.NaN]) {
      expect(await openInEditor({ projectRoot: root, path: target, line, intent: GESTURE })).toEqual({ ok: false, error: "invalid-request" });
    }
    expect(await openInEditor({ projectRoot: root, path: join(root, "src"), intent: GESTURE })).toEqual({ ok: false, error: "not-a-file" });
    expect(await openInEditor({ projectRoot: root, path: join(root, "gone.txt"), intent: GESTURE })).toEqual({ ok: false, error: "not-found" });
    additionalDirectories.value = [root, outside];
    try {
      expect(await openInEditor({ projectRoot: root, path: join(root, "escape.txt"), intent: GESTURE }))
        .toEqual({ ok: false, error: "outside-project" });
    } finally {
      additionalDirectories.value = [root];
    }
    const secret = join(root, ".env");
    writeFileSync(secret, "TOKEN=1\n");
    try {
      expect(await openInEditor({ projectRoot: root, path: secret, intent: GESTURE })).toEqual({ ok: false, error: "sensitive-path" });
    } finally {
      rmSync(secret, { force: true });
    }
    expect(existsSync(out)).toBe(false);
  });
});

describe("workspace.readForEdit and workspace.saveEdit", () => {
  type ReadResult = { ok: boolean; error?: string; text?: string; hash?: string };
  type SaveResult = { ok: boolean; error?: string; hash?: string };
  const readForEdit = (payload: unknown, event: unknown = frameEvent()) =>
    invoke(CHANNELS.workspace.readForEdit, event, payload) as Promise<ReadResult>;
  const saveEdit = (payload: unknown, event: unknown = frameEvent()) =>
    invoke(CHANNELS.workspace.saveEdit, event, payload) as Promise<SaveResult>;
  let target: string;
  let serial = 0;
  beforeEach(() => {
    // The checkpoint ledger the save consults lives under this test's own state folder.
    vi.stubEnv("AVE_HOME", join(outside, "edit-state"));
    target = join(root, `editable-${++serial}.txt`);
  });
  afterAll(() => { vi.unstubAllEnvs(); });
  async function opened(path = target): Promise<string> {
    const read = await readForEdit({ projectRoot: root, path, intent: GESTURE });
    if (!read.ok || read.hash === undefined) throw new Error(`read refused: ${read.error}`);
    return read.hash;
  }

  it("reads the text with LF line breaks and saves an edit back in the file's own CRLF and byte order mark", async () => {
    writeFileSync(target, "﻿one\r\ntwo\r\nthree\r\n");
    const read = await readForEdit({ projectRoot: root, path: target, intent: GESTURE });
    expect(read).toMatchObject({ ok: true, text: "one\ntwo\nthree\n" });
    const saved = await saveEdit({ projectRoot: root, path: target, baseHash: read.hash, text: "one\nTWO\nthree\n", intent: GESTURE });
    expect(saved.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("﻿one\r\nTWO\r\nthree\r\n");
    // The returned hash is the new base: a second save from it goes through without another read.
    expect((await saveEdit({ projectRoot: root, path: target, baseHash: saved.hash, text: "x\n", intent: GESTURE })).ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("﻿x\r\n");
  });

  it("writes nothing when the project is removed while the save is on its way", async () => {
    writeFileSync(target, "start\n");
    const baseHash = await opened();
    // The write guard is asked before staging, after staging and at the effect. The project leaves the list after the
    // second answer, so only a guard that reads the list again at the effect can refuse.
    let calls = 0;
    const guard = vi.spyOn(fileAccessPolicy, "ensureFileAccess").mockImplementation(() => {
      if (++calls === 2) additionalDirectories.value = [];
      return null;
    });
    try {
      expect(await saveEdit({ projectRoot: root, path: target, baseHash, text: "mine\n", intent: GESTURE })).toEqual({ ok: false, error: "denied" });
    } finally {
      guard.mockRestore();
      additionalDirectories.value = [root];
    }
    expect(calls).toBe(2);
    expect(readFileSync(target, "utf8")).toBe("start\n");
  });

  it("writes nothing when the project is removed while the file is read for the last check", async () => {
    writeFileSync(target, "start\n");
    const baseHash = await opened();
    // The third answer opens the last check; the project leaves the list while that check reads the file. Only a
    // question asked after the read, directly before the rename, finds the project gone.
    let calls = 0;
    const guard = vi.spyOn(fileAccessPolicy, "ensureFileAccess").mockImplementation(() => {
      if (++calls === 3) queueMicrotask(() => { additionalDirectories.value = []; });
      return null;
    });
    try {
      expect(await saveEdit({ projectRoot: root, path: target, baseHash, text: "mine\n", intent: GESTURE })).toEqual({ ok: false, error: "denied" });
    } finally {
      guard.mockRestore();
      additionalDirectories.value = [root];
    }
    expect(calls).toBe(3);
    expect(readFileSync(target, "utf8")).toBe("start\n");
  });

  it("writes nothing when the file changed after it was opened", async () => {
    writeFileSync(target, "start\n");
    const baseHash = await opened();
    writeFileSync(target, "changed in another program\n");
    expect(await saveEdit({ projectRoot: root, path: target, baseHash, text: "mine\n", intent: GESTURE })).toEqual({ ok: false, error: "changed" });
    expect(readFileSync(target, "utf8")).toBe("changed in another program\n");
  });

  it("refuses files a text box cannot give back byte for byte, with the reason", async () => {
    writeFileSync(target, "a\r\nb\n");
    expect(await readForEdit({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: false, error: "mixed-line-endings" });
    writeFileSync(target, Buffer.from([0x61, 0x00, 0xff]));
    expect(await readForEdit({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: false, error: "not-text" });
    writeFileSync(target, Buffer.alloc(1024 * 1024 + 1, 0x61));
    expect(await readForEdit({ projectRoot: root, path: target, intent: GESTURE })).toEqual({ ok: false, error: "too-large" });
  });

  it("needs the user gesture, the app window's main frame and a registered project for the read and for the save", async () => {
    writeFileSync(target, "start\n");
    const baseHash = await opened();
    const save = { projectRoot: root, path: target, baseHash, text: "mine\n" };
    expect(await readForEdit({ projectRoot: root, path: target })).toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(await saveEdit(save)).toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(await saveEdit({ ...save, intent: GESTURE }, frameEvent({ mainFrame: false }))).toEqual({ ok: false, error: "unauthorized" });
    expect(await saveEdit({ ...save, projectRoot: outside, intent: GESTURE })).toEqual({ ok: false, error: "root-not-registered" });
    expect(await saveEdit({ ...save, baseHash: "not-a-hash", intent: GESTURE })).toEqual({ ok: false, error: "invalid-request" });
    expect(await saveEdit({ ...save, baseHash: "not-a-hash" })).toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(readFileSync(target, "utf8")).toBe("start\n");
  });

  it("does not write through a link that leaves the project", async () => {
    const elsewhere = join(outside, `edit-elsewhere-${serial}.txt`);
    writeFileSync(elsewhere, "outside\n");
    const link = join(root, `edit-link-${serial}.txt`);
    symlinkSync(elsewhere, link);
    try {
      const read = await readForEdit({ projectRoot: root, path: link, intent: GESTURE });
      expect(read.ok).toBe(false);
      const saved = await saveEdit({ projectRoot: root, path: link, baseHash: "0".repeat(64), text: "mine\n", intent: GESTURE });
      expect(saved.ok).toBe(false);
      expect(readFileSync(elsewhere, "utf8")).toBe("outside\n");
    } finally {
      unlinkSync(link);
    }
  });

  it("audits a save with opaque references and its outcome", async () => {
    writeFileSync(target, "start\n");
    const baseHash = await opened();
    auditLog.mockClear();
    expect((await saveEdit({ projectRoot: root, path: target, baseHash, text: "mine\n", intent: GESTURE })).ok).toBe(true);
    const entry = auditLog.mock.calls.map(([value]) => value as { input?: string }).find((value) =>
      value.input?.includes(CHANNELS.workspace.saveEdit));
    expect(entry?.input).toContain('"ok":true');
    expect(entry?.input).not.toContain(target);
  });
});
