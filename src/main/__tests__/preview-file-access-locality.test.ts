import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { session, type IpcMainInvokeEvent } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { IpcDeps } from "../../ipc/types.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";
import { configureHostResources } from "../host-resources.js";
import { previewFileReadAuthorizes, recordPreviewFileAccess } from "../preview-file-access.js";

vi.unmock("../../shared/windows-drive-locality.js");
vi.mock("electron", () => ({ session: { defaultSession: {} } }));
vi.mock("../app-state.js", () => ({ findSessionMainWindowContents: () => null }));

const readPermissionSettings = vi.hoisted(() => vi.fn<() => { permissions: { additionalDirectories: string[] } }>());
vi.mock("../../permissions/permission-settings-store.js", () => ({ readPermissionSettings }));

describe.runIf(process.platform === "win32")("preview file access drive queries", () => {
  const query = vi.fn<(drive: string) => string | null>();
  let root: string;
  let sender: EventEmitter;
  let event: IpcMainInvokeEvent;
  let deps: Pick<IpcDeps, "getMainWindow" | "getAppWindows">;

  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "preview-locality-")));
    const frame = { url: "file:///app/index.html", processId: 1, routingId: 0, detached: false, isDestroyed: () => false };
    sender = Object.assign(new EventEmitter(), {
      id: 1, mainFrame: frame, isDestroyed: () => false, getType: () => "window", session: session.defaultSession,
    });
    event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    deps = {
      getMainWindow: () => null,
      getAppWindows: () => [{ isDestroyed: () => false, webContents: sender }] as unknown as ReturnType<NonNullable<IpcDeps["getAppWindows"]>>,
    };
    readPermissionSettings.mockReset().mockReturnValue({ permissions: { additionalDirectories: [root] } });
    query.mockReset().mockReturnValue(String.raw`\Device\HarddiskVolume1`);
    setWindowsDriveQueryForTest(query);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });

  afterEach(async () => {
    sender.emit("destroyed");
    vi.useRealTimers();
    setWindowsDriveQueryForTest();
    await cleanupTmpDir(root);
  });

  function receiptPath(name: string): string {
    const path = join(root, name);
    writeFileSync(path, "text");
    return realpathSync.native(path);
  }

  function expectOneQueryPerDrive(): void {
    const drives = query.mock.calls.map(([drive]) => drive);
    expect(drives).toContain(root.slice(0, 2).toUpperCase());
    expect(drives).toEqual([...new Set(drives)]);
  }

  it("queries each drive once for the current read scope and its receipt check", () => {
    recordPreviewFileAccess(event, deps, receiptPath("notes.txt"));
    expect(readPermissionSettings).toHaveBeenCalledTimes(1);
    expectOneQueryPerDrive();
  });

  it("revokes the frame receipts and stops polling when a later drive query throws", () => {
    const first = receiptPath("first.txt");
    const paths = [first, receiptPath("second.txt")];
    for (const path of paths) recordPreviewFileAccess(event, deps, path);

    const interval = PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs;
    vi.advanceTimersByTime(interval);
    for (const path of paths) expect(previewFileReadAuthorizes(event, deps, path)).toBe(true);

    query.mockImplementationOnce(() => { throw new Error("unexpected drive query failure"); });
    expect(() => vi.advanceTimersByTime(interval)).not.toThrow();
    for (const path of paths) expect(previewFileReadAuthorizes(event, deps, path)).toBe(false);
    expect(sender.listenerCount("destroyed")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    recordPreviewFileAccess(event, deps, first);
    expect(previewFileReadAuthorizes(event, deps, first)).toBe(true);
    query.mockClear();
    vi.advanceTimersByTime(interval);
    expectOneQueryPerDrive();
  });

  it("queries each drive once per tick for multiple receipts and rechecks a revoked scope", () => {
    const paths = Array.from({ length: 12 }, (_, index) => receiptPath(`notes-${index}.txt`));
    for (const path of paths) {
      recordPreviewFileAccess(event, deps, path);
      expect(previewFileReadAuthorizes(event, deps, path)).toBe(true);
    }

    query.mockClear();
    readPermissionSettings.mockClear();
    vi.advanceTimersByTime(PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs);
    expect(readPermissionSettings).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.length).toBeLessThanOrEqual(4);
    expectOneQueryPerDrive();

    query.mockClear();
    readPermissionSettings.mockClear();
    readPermissionSettings.mockReturnValueOnce({ permissions: { additionalDirectories: [] } });
    vi.advanceTimersByTime(PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs);
    expect(readPermissionSettings).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.length).toBeLessThanOrEqual(4);
    expectOneQueryPerDrive();

    for (const path of paths) expect(previewFileReadAuthorizes(event, deps, path)).toBe(false);
    vi.advanceTimersByTime(PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs);
    expect(readPermissionSettings).toHaveBeenCalledTimes(1);
  });
});
