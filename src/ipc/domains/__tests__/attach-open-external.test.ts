// attach.openExternal through the shared default-app sequence: stable failure codes and one pre-open frame re-check.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { HOST_FRAME_URL } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const { handlers, defaultSession, openPathMock, senderCheck } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  defaultSession: {},
  openPathMock: vi.fn(async (_path: string) => ""),
  senderCheck: { calls: 0, answers: [] as boolean[] },
}));

vi.mock("electron", () => ({
  session: { defaultSession },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }) },
  nativeImage: { createFromBuffer: vi.fn(() => ({ getSize: () => ({ width: 1, height: 1 }) })) },
  shell: { openPath: openPathMock },
}));

vi.mock("../../app-window-sender.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app-window-sender.js")>();
  return {
    ...actual,
    validateAppWindowMainFrameSender: (...args: Parameters<typeof actual.validateAppWindowMainFrameSender>) => {
      senderCheck.calls += 1;
      const scripted = senderCheck.answers.shift();
      return scripted ?? actual.validateAppWindowMainFrameSender(...args);
    },
  };
});

import { CHANNELS } from "../../../contract/app-contract.js";
import { registerAttachHandlers } from "../attach.js";

const frame = { url: HOST_FRAME_URL, processId: 3, routingId: 0, detached: false, isDestroyed: () => false };
const sender = Object.assign(new EventEmitter(), { id: 3, mainFrame: frame, session: defaultSession, getType: () => "window", isDestroyed: () => false });
const event = { senderFrame: frame, sender, frameId: 0, processId: 3 };
const call = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!(event, ...args));

let root: string;
let notes: string;
let script: string;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ave-attach-open-")));
  notes = join(root, "notes.txt");
  script = join(root, "build");
  writeFileSync(notes, "hello");
  writeFileSync(script, "#!/bin/sh\n");
  registerAttachHandlers({ auditLogger: { log: vi.fn() }, getMainWindow: () => null,
    getAppWindows: () => [{ webContents: sender, isDestroyed: () => false }] } as never);
  // Picker authority comes from a redeemed drop, as in the composer.
  const registered = await call(CHANNELS.attach.registerDrop, [notes, script]) as { token: string };
  await call(CHANNELS.attach.redeemDrop, registered.token);
});

beforeEach(() => {
  openPathMock.mockReset();
  openPathMock.mockResolvedValue("");
  senderCheck.calls = 0;
  senderCheck.answers = [];
});

afterAll(async () => {
  await cleanupTmpDir(root);
});

describe("attach.openExternal", () => {
  it("checks the frame at entry and once more just before the open", async () => {
    expect(await call(CHANNELS.attach.openExternal, notes)).toEqual({ ok: true });
    expect(senderCheck.calls).toBe(2);
    expect(openPathMock).toHaveBeenCalledWith(notes);
  });

  it("refuses when the frame stops being the app window before the open", async () => {
    senderCheck.answers = [true, false];
    expect(await call(CHANNELS.attach.openExternal, notes)).toEqual({ ok: false, error: "unauthorized" });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("reports an OS failure as open-failed, not the OS message", async () => {
    openPathMock.mockResolvedValueOnce("No application knows how to open /secret/path");
    expect(await call(CHANNELS.attach.openExternal, notes)).toEqual({ ok: false, error: "open-failed" });
  });

  it("refuses an attached file with an execute bit", async ({ skip }) => {
    if (process.platform === "win32") skip("Windows has no execute bit");
    chmodSync(script, 0o755);
    expect(await call(CHANNELS.attach.openExternal, script)).toEqual({ ok: false, error: "executable" });
    expect(openPathMock).not.toHaveBeenCalled();
  });
});
