// Folder view main-side contract: widened listDir entries and the user-gesture open-in-default-app channel.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ave-folder-view-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "ave-folder-view-outside-")));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "settlement.sqlite"), Buffer.from([0x53, 0x51, 0x4c, 0x00]));
  writeFileSync(join(root, "deploy.sh"), "#!/bin/sh\necho hi\n");
  writeFileSync(join(outside, "secret.txt"), "outside\n");
  writeFileSync(join(outside, "run.sh"), "#!/bin/sh\n");
  symlinkSync(outside, join(root, "shared-config"), process.platform === "win32" ? "junction" : "dir");
  symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
  symlinkSync(join(root, "src", "index.ts"), join(root, "inside-link.ts"));
  symlinkSync(join(root, "src", "index.ts"), join(root, "innocent.sh"));
  symlinkSync(join(outside, "run.sh"), join(root, "looks-fine.txt"));
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

  it("reports a link as a link with an outside flag and never follows it", async () => {
    const res = (await invoke(CHANNELS.workspace.listDir, frameEvent(), root)) as ListResult;
    const shared = res.entries?.find((entry) => entry.name === "shared-config");
    const escape = res.entries?.find((entry) => entry.name === "escape.txt");
    const inside = res.entries?.find((entry) => entry.name === "inside-link.ts");
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

  it("follows an in-project link to an in-project file", async () => {
    expect(await openPath({ projectRoot: root, path: join(root, "inside-link.ts"), intent: GESTURE })).toEqual({ ok: true });
    expect(openPathMock).toHaveBeenCalledWith(join(root, "src", "index.ts"));
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
    const traversal = join(root, "src", "..", "..", outside.split(/[\\/]/).pop()!, "secret.txt");
    const res = await openPath({ projectRoot: root, path: traversal, intent: GESTURE });
    expect(res.ok).toBe(false);
    expect(["path-not-allowed", "outside-project"]).toContain(res.error);
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("refuses an in-project link whose target escapes the project", async () => {
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

  it("refuses denied extensions on the requested spelling and on the link target", async () => {
    expect(await openPath({ projectRoot: root, path: join(root, "deploy.sh"), intent: GESTURE }))
      .toEqual({ ok: false, error: "denied_extension" });
    expect(await openPath({ projectRoot: root, path: join(root, "innocent.sh"), intent: GESTURE }))
      .toEqual({ ok: false, error: "denied_extension" });
    additionalDirectories.value = [root, outside];
    try {
      expect(await openPath({ projectRoot: root, path: join(root, "looks-fine.txt"), intent: GESTURE }))
        .toEqual({ ok: false, error: "denied_extension" });
    } finally {
      additionalDirectories.value = [root];
    }
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("refuses a directory, including an .app bundle", async () => {
    mkdirSync(join(root, "Tool.app"), { recursive: true });
    try {
      expect(await openPath({ projectRoot: root, path: join(root, "src"), intent: GESTURE }))
        .toEqual({ ok: false, error: "not-a-file" });
      expect(await openPath({ projectRoot: root, path: join(root, "Tool.app"), intent: GESTURE }))
        .toEqual({ ok: false, error: "denied_extension" });
    } finally {
      rmSync(join(root, "Tool.app"), { recursive: true, force: true });
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

  it("refuses a file swapped for an outside link between the check and the open", async () => {
    additionalDirectories.value = [root, outside];
    const swapped = join(root, "swap.txt");
    writeFileSync(swapped, "inside\n");
    const realStat = fsModule.promises.stat;
    const spy = vi.spyOn(fsModule.promises, "stat").mockImplementationOnce(async (...args: Parameters<typeof realStat>) => {
      const result = await realStat(...args);
      unlinkSync(swapped);
      symlinkSync(join(outside, "secret.txt"), swapped);
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
});
