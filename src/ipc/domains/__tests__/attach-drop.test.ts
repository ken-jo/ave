/**
 * Composer drag-drop: the one-shot token main mints for a dropped file list.
 *
 * Registering validates and binds; only REDEEMING authorizes. These pin the
 * misuse cases the token exists for — reuse, an unknown or other-window token,
 * expiry — and the paths registration must refuse outright: a sensitive file,
 * a symlink to one, a deny-listed type, a folder.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { shell } from "electron";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_FRAME_URL } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  nativeImage: {
    createFromBuffer: vi.fn(() => ({ getSize: () => ({ width: 1, height: 1 }) })),
  },
  shell: { openPath: vi.fn(async () => "") },
}));

import { CHANNELS } from "../../../contract/app-contract.js";
import { DROP_TOKEN_TTL_MS, registerAttachHandlers } from "../attach.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A host-renderer event from the webContents with id `senderId`. */
function hostEvent(senderId: number) {
  return { senderFrame: { url: HOST_FRAME_URL }, sender: { id: senderId }, frameId: 0, processId: 0 };
}

function call(channel: string, senderId: number, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  return Promise.resolve(fn(hostEvent(senderId), ...args));
}

let root: string;
let imagePath: string;
let notesPath: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ave-attach-drop-"));
  imagePath = join(root, "shot.png");
  notesPath = join(root, "notes.txt");
  writeFileSync(imagePath, PNG);
  writeFileSync(notesPath, "hello");
  writeFileSync(join(root, ".env"), "SECRET=1");
  symlinkSync(join(root, ".env"), join(root, "innocent.txt"));
  writeFileSync(join(root, "run.exe"), "MZ");
  mkdirSync(join(root, "folder"));
  registerAttachHandlers({ auditLogger: { log: vi.fn() }, getMainWindow: () => ({}) } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanupTmpDir(root);
});

async function register(senderId: number, paths: unknown) {
  return call(CHANNELS.attach.registerDrop, senderId, paths) as Promise<{
    ok: boolean;
    token?: string;
    error?: string;
    rejected?: Array<{ name: string; reason: string }>;
  }>;
}

describe("composer drop token", () => {
  it("authorizes the dropped files only when the token is redeemed", async () => {
    const reg = await register(7, [imagePath, notesPath]);
    expect(reg).toMatchObject({ ok: true, rejected: [] });
    // Registered but not redeemed: nothing is readable yet.
    expect(await call(CHANNELS.attach.readImage, 7, imagePath)).toEqual({
      ok: false,
      error: "path_not_authorized",
    });
    const redeemed = await call(CHANNELS.attach.redeemDrop, 7, reg.token) as {
      ok: boolean;
      files: Array<{ path: string; isImage: boolean }>;
    };
    expect(redeemed.ok).toBe(true);
    expect(redeemed.files.map((f) => [f.path, f.isImage])).toEqual([
      [imagePath, true],
      [notesPath, false],
    ]);
    expect(await call(CHANNELS.attach.readImage, 7, imagePath)).toMatchObject({ ok: true });
  });

  it("refuses a reused token", async () => {
    const reg = await register(7, [notesPath]);
    expect(await call(CHANNELS.attach.redeemDrop, 7, reg.token)).toMatchObject({ ok: true });
    expect(await call(CHANNELS.attach.redeemDrop, 7, reg.token)).toEqual({
      ok: false,
      error: "drop-token-invalid",
    });
  });

  it("refuses an unknown token and a non-string token", async () => {
    expect(await call(CHANNELS.attach.redeemDrop, 7, "not-a-token")).toEqual({
      ok: false,
      error: "drop-token-invalid",
    });
    expect(await call(CHANNELS.attach.redeemDrop, 7, { token: "x" })).toEqual({
      ok: false,
      error: "drop-token-invalid",
    });
  });

  it("refuses a token minted for another window, and burns it", async () => {
    const reg = await register(7, [notesPath]);
    expect(await call(CHANNELS.attach.redeemDrop, 8, reg.token)).toEqual({
      ok: false,
      error: "drop-token-invalid",
    });
    // The wrong-window attempt consumed it: the owner cannot use it either.
    expect(await call(CHANNELS.attach.redeemDrop, 7, reg.token)).toEqual({
      ok: false,
      error: "drop-token-invalid",
    });
  });

  it("refuses an expired token", async () => {
    const start = Date.now();
    const reg = await register(7, [notesPath]);
    vi.spyOn(Date, "now").mockReturnValue(start + DROP_TOKEN_TTL_MS + 1_000);
    expect(await call(CHANNELS.attach.redeemDrop, 7, reg.token)).toEqual({
      ok: false,
      error: "drop-token-expired",
    });
  });

  it("refuses a sensitive path, a symlink to one, a blocked type and a folder", async () => {
    const reg = await register(7, [
      join(root, ".env"),
      join(root, "innocent.txt"),
      join(root, "run.exe"),
      join(root, "folder"),
      notesPath,
    ]);
    expect(reg.ok).toBe(true);
    expect(reg.rejected).toEqual([
      { name: ".env", reason: "sensitive-path" },
      { name: "innocent.txt", reason: "sensitive-path" },
      { name: "run.exe", reason: "denied-extension" },
      { name: "folder", reason: "not-a-file" },
    ]);
    const redeemed = await call(CHANNELS.attach.redeemDrop, 7, reg.token) as {
      files: Array<{ path: string }>;
    };
    expect(redeemed.files.map((f) => f.path)).toEqual([notesPath]);
    expect(await call(CHANNELS.attach.openExternal, 7, join(root, ".env"))).toEqual({
      ok: false,
      error: "path_not_authorized",
    });
  });

  it("re-checks a dropped symlink's current target when it is opened or read", async () => {
    const link = join(root, "retarget.txt");
    symlinkSync(notesPath, link);
    const reg = await register(7, [link]);
    expect(reg.ok).toBe(true);
    await call(CHANNELS.attach.redeemDrop, 7, reg.token);

    // Validated while it pointed at notes.txt, then pointed at an executable.
    rmSync(link);
    symlinkSync(join(root, "run.exe"), link);
    vi.mocked(shell.openPath).mockClear();
    expect(await call(CHANNELS.attach.openExternal, 7, link)).toEqual({ ok: false, error: "denied_extension" });
    expect(shell.openPath).not.toHaveBeenCalled();

    // ...or at a credential file.
    rmSync(link);
    symlinkSync(join(root, ".env"), link);
    expect(await call(CHANNELS.attach.readImage, 7, link)).toEqual({ ok: false, error: "sensitive-path" });
    expect(await call(CHANNELS.attach.openExternal, 7, link)).toEqual({ ok: false, error: "sensitive-path" });
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("mints no token when nothing is attachable, and rejects malformed payloads", async () => {
    expect(await register(7, [join(root, ".env")])).toMatchObject({
      ok: false,
      error: "nothing-attachable",
    });
    expect(await register(7, "/etc/hosts")).toEqual({ ok: false, error: "invalid-payload" });
    expect(await register(7, ["relative/path.txt"])).toEqual({ ok: false, error: "invalid-payload" });
    expect(await register(7, [])).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("refuses a sender without a webContents id", async () => {
    const fn = handlers.get(CHANNELS.attach.registerDrop)!;
    expect(await fn({ senderFrame: { url: HOST_FRAME_URL }, sender: {} }, [notesPath])).toEqual({
      ok: false,
      error: "unauthorized",
    });
  });
});
