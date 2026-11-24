import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { takeWindowsHelperLaunches } from "../../../__tests__/support/windows-helper-spawns.js";
import { configureHostResources } from "../../../main/host-resources.js";
import { queryWindowsSystemDirectory, queryWindowsSystemDirectorySync, windowsPathKindHelperIn } from "../../../main/windows-path-kind-launcher.js";
import { pinWindowsPaths } from "../../../shared/windows-path-facts.js";
import { getMainWindows, registerMainWindow, setSessionContentsLookup, unregisterMainWindow } from "../../../main/app-state.js";

vi.mock("node:child_process", async (importOriginal) =>
  (await import("../../../__tests__/support/windows-helper-spawns.js")).countingChildProcess(await importOriginal()));

const { handlers, additionalDirectories, defaultSession } = vi.hoisted(() => ({
  defaultSession: {},
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  additionalDirectories: { value: [] as string[] },
}));

vi.mock("electron", () => ({
  session: { defaultSession },
  dialog: { showMessageBox: vi.fn() },
  nativeImage: {},
  shell: { openPath: vi.fn(async () => "") },
  ipcMain: { handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }) },
}));

vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({
    permissions: { additionalDirectories: additionalDirectories.value, pendingWorkspaceRootRemovals: [] },
  }),
}));

import { registerPreviewHandlers, type PreviewReadFileResult } from "../preview.js";
import { CHANNELS } from "../../../contract/app-contract.js";

const resourcePath = fileURLToPath(new URL("../../../../resources/", import.meta.url));
const helperPresent = process.platform === "win32" && existsSync(windowsPathKindHelperIn(resourcePath));
const appWindows: Array<{ isDestroyed: () => boolean; webContents: object }> = [];
const deps = { auditLogger: { log: vi.fn() }, getAppWindows: () => appWindows, getMainWindow: () => null } as never;

// The ceiling binds. The exact pin is the current measurement (0 on main cde88405d): lower it when launches are removed;
// raise it only up to PREVIEW_TEXT_OPEN_TARGET, stating the measured count in the PR.
const PREVIEW_TEXT_OPEN_TARGET = 4;
const PREVIEW_TEXT_OPEN_LAUNCHES = {};

let root: string;

function documentEvent() {
  const frame = { url: "file:///app/index.html", processId: 1, routingId: 0, detached: false, isDestroyed: (): boolean => false };
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame, isDestroyed: (): boolean => false,
    getType: (): string => "window", session: defaultSession, send: vi.fn() });
  appWindows.push({ isDestroyed: () => false, webContents: sender });
  return { sender, senderFrame: frame };
}

const total = (launches: Record<string, number>) => Object.values(launches).reduce((sum, count) => sum + count, 0);

// Windows CI builds the helper, so a missing helper there is a failure, not a skip.
it.runIf(Boolean(process.env.CI) && process.platform === "win32")("has the native path helper built on Windows CI", () => {
  expect(helperPresent).toBe(true);
});

// The native helper only runs on Windows; elsewhere these launches do not exist.
describe.skipIf(!helperPresent)("preview native helper launch budget", () => {
  beforeAll(() => {
    configureHostResources({ resourcePath, isPackaged: false });
    root = mkdtempSync(join(tmpdir(), "ave-preview-budget-"));
    writeFileSync(join(root, "notes.txt"), "plain");
    additionalDirectories.value = [root];
    registerPreviewHandlers(deps);
  });

  afterAll(async () => {
    for (const window of getMainWindows()) unregisterMainWindow(window);
    setSessionContentsLookup(null);
    await cleanupTmpDir(root);
  });

  it("counts a synchronous pin as one helper launch", () => {
    takeWindowsHelperLaunches();
    expect(pinWindowsPaths([root])).toHaveLength(1);
    expect(takeWindowsHelperLaunches()).toEqual({ "--pin": 1 });
  });

  it("counts an asynchronous helper query as one launch", async () => {
    takeWindowsHelperLaunches();
    await queryWindowsSystemDirectory();
    expect(takeWindowsHelperLaunches()).toEqual({ "--system-directory": 1 });
  });

  it("counts a synchronous helper spawn as one launch", () => {
    takeWindowsHelperLaunches();
    queryWindowsSystemDirectorySync();
    expect(takeWindowsHelperLaunches()).toEqual({ "--system-directory": 1 });
  });

  it.each(["first", "repeated"])("opens a text preview within its launch budget (%s open)", async () => {
    const event = documentEvent();
    for (const window of getMainWindows()) unregisterMainWindow(window);
    registerMainWindow({ id: event.sender.id, webContents: event.sender, isDestroyed: () => false } as never, "primary");
    setSessionContentsLookup((sessionId) => sessionId === "session-one" ? event.sender as never : null);
    takeWindowsHelperLaunches();
    const read = handlers.get(CHANNELS.preview.readFile);
    if (!read) throw new Error("preview.readFile is not registered");
    const result = await read(event, join(root, "notes.txt"), { sessionId: "session-one" }) as PreviewReadFileResult;
    // Let launches the handler left running land in this window, not the next one.
    await new Promise(resolve => setImmediate(resolve));
    const launches = takeWindowsHelperLaunches();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, content: "plain" });
    expect(total(launches), JSON.stringify(launches)).toBeLessThanOrEqual(PREVIEW_TEXT_OPEN_TARGET);
    expect(launches, JSON.stringify(launches)).toEqual(PREVIEW_TEXT_OPEN_LAUNCHES);
    event.sender.emit("destroyed");
  });
});
