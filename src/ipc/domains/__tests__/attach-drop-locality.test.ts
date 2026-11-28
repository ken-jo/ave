import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HOST_FRAME_URL } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const { handlers, defaultSession } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  defaultSession: {},
}));

vi.unmock("../../../shared/windows-drive-locality.js");
vi.mock("electron", () => ({
  session: { defaultSession },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }) },
  nativeImage: { createFromBuffer: vi.fn(() => ({ getSize: () => ({ width: 1, height: 1 }) })) },
  shell: { openPath: vi.fn(async () => "") },
}));

import { CHANNELS } from "../../../contract/app-contract.js";
import { setWindowsDriveQueryForTest } from "../../../shared/windows-drive-locality.js";
import { registerAttachHandlers } from "../attach.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const frame = { url: HOST_FRAME_URL, processId: 7, routingId: 0, detached: false, isDestroyed: () => false };
const sender = Object.assign(new EventEmitter(), { id: 7, mainFrame: frame, session: defaultSession,
  getType: () => "window", isDestroyed: () => false });
const event = { senderFrame: frame, sender, frameId: 0, processId: 7 };
const call = (channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve(handlers.get(channel)?.(event, ...args));

describe.runIf(process.platform === "win32")("drop redemption on a failed drive query", () => {
  let root: string;

  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-attach-locality-")));
    setWindowsDriveQueryForTest(() => String.raw`\Device\HarddiskVolume1`);
    registerAttachHandlers({ getMainWindow: () => null,
      getAppWindows: () => [{ webContents: sender, isDestroyed: () => false }] } as never);
  });

  afterAll(async () => {
    setWindowsDriveQueryForTest();
    await cleanupTmpDir(root);
  });

  it("leaves no attachment authority behind", async () => {
    const files = ["one.png", "two.png"].map((name) => join(root, name));
    for (const file of files) writeFileSync(file, PNG);
    const registered = await call(CHANNELS.attach.registerDrop, files) as { ok: boolean; token: string };
    expect(registered.ok).toBe(true);
    setWindowsDriveQueryForTest(() => { throw new Error("drive query failed"); });
    await expect(call(CHANNELS.attach.redeemDrop, registered.token)).rejects.toThrow("drive query failed");
    setWindowsDriveQueryForTest(() => String.raw`\Device\HarddiskVolume1`);
    for (const file of files) {
      expect(await call(CHANNELS.attach.readImage, file)).toEqual({ ok: false, error: "path_not_authorized" });
    }
  });
});
