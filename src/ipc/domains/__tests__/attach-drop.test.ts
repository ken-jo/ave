// Registration binds a drop token; only single-use, sender-bound redemption grants authority.
import { isSensitivePath } from "../../../permissions/sensitive-paths.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { shell } from "electron";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { HOST_FRAME_URL } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { canCreateSymlinks } from "../../../__tests__/support/symlink-capability.js";

const { handlers, defaultSession } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  defaultSession: {},
}));

vi.mock("electron", () => ({
  session: { defaultSession },
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

const appEvents = new Map<number, ReturnType<typeof createHostEvent>>();
function createHostEvent(senderId: number) {
  const frame = { url: HOST_FRAME_URL, processId: senderId, routingId: 0, detached: false, isDestroyed: () => false };
  const sender = Object.assign(new EventEmitter(), { id: senderId, mainFrame: frame, session: defaultSession,
    getType: () => "window", isDestroyed: () => false });
  return { senderFrame: frame, sender, frameId: 0, processId: senderId };
}
function hostEvent(senderId: number) {
  const event = appEvents.get(senderId) ?? createHostEvent(senderId);
  appEvents.set(senderId, event);
  return event;
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
  writeFileSync(join(root, "run.exe"), "MZ");
  mkdirSync(join(root, "folder"));
  registerAttachHandlers({ auditLogger: { log: vi.fn() }, getMainWindow: () => null,
    getAppWindows: () => [...appEvents.values()].map(({ sender }) => ({ webContents: sender, isDestroyed: () => false })),
  } as never);
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
    expect(await call(CHANNELS.attach.openExternal, 7, notesPath)).toEqual({ ok: true });
  });

  it("reads the extension from the file name, never from a dotted directory", async () => {
    const dotted = join(root, "a", ".config", "notes");
    const dottedDir = join(root, "b.c", "file");
    mkdirSync(join(root, "a", ".config"), { recursive: true });
    mkdirSync(join(root, "b.c"), { recursive: true });
    writeFileSync(dotted, "hello");
    writeFileSync(dottedDir, "hello");
    const reg = await register(8, [dotted, dottedDir]);
    expect(reg).toMatchObject({ ok: true, rejected: [] });
    const redeemed = await call(CHANNELS.attach.redeemDrop, 8, reg.token) as {
      ok: boolean;
      files: Array<{ path: string; ext: string }>;
    };
    expect(redeemed.files.map((f) => [f.path, f.ext])).toEqual([
      [dotted, ""],
      [dottedDir, ""],
    ]);
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
    // A wrong-window redemption attempt consumes the token.
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

  it("refuses a key-extension file that holds a private key and takes one that does not", async () => {
    // The header is written in two parts so no scanner takes this test file for key material.
    writeFileSync(join(root, "tls.key"), "-----BEGIN PRIVATE" + " KEY-----\nFIXTURE\n");
    writeFileSync(join(root, "Quarterly review.key"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    writeFileSync(join(root, "chain.pem"), "-----BEGIN CERTIFICATE-----\nFIXTURE\n-----END CERTIFICATE-----\n");
    // Longer than what is read: a presentation archive nobody could show harmless, and a key whose header is in the part
    // that was read.
    const window = 1024 * 1024;
    writeFileSync(join(root, "Big deck.key"), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(window * 2, "s")]));
    writeFileSync(join(root, "big.key"), Buffer.concat([Buffer.from("-----BEGIN PRIVATE" + " KEY-----\nFIXTURE\n"), Buffer.alloc(window * 2, "x")]));
    // Dropping the files is the person bringing them to Ave, from a folder that is no project: each is looked at, and
    // only the ones that hold a private key are refused. The large deck is the person's own choice and is taken.
    const dropped = ["tls.key", "Quarterly review.key", "chain.pem", "Big deck.key", "big.key"].map((name) => join(root, name));
    const reg = await register(7, dropped);
    expect(reg.ok).toBe(true);
    expect(reg.rejected).toEqual([{ name: "tls.key", reason: "sensitive-path" }, { name: "big.key", reason: "sensitive-path" }]);
    const redeemed = await call(CHANNELS.attach.redeemDrop, 7, reg.token) as { ok: boolean; files: Array<{ path: string; name: string; bytes: number }> };
    expect(redeemed.ok).toBe(true);
    expect(redeemed.files.map((file) => file.path)).toEqual([join(root, "Quarterly review.key"), join(root, "chain.pem"), join(root, "Big deck.key")]);
    // The chip shows it as any other file: its own name and size.
    expect(redeemed.files[2]).toMatchObject({ name: "Big deck.key", bytes: window * 2 + 4 });
    // The agent reading the attached deck still asks: its unread part is not taken for harmless.
    expect(isSensitivePath(realpathSync(join(root, "Big deck.key")), "read")).toBe("**/*.key");
    rmSync(join(root, "Big deck.key"));
    rmSync(join(root, "big.key"));
    // That covers the dropped files only. The same folder's other key-extension names, which nobody brought, are still
    // judged on the name alone by every other reader.
    writeFileSync(join(root, "Other deck.key"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    expect(isSensitivePath(realpathSync(join(root, "Other deck.key")), "read")).toBe("**/*.key");
    expect(isSensitivePath(realpathSync(join(root, "Quarterly review.key")), "read")).toBeNull();
  });

  it("refuses a sensitive path, a blocked type and a folder", async () => {
    const reg = await register(7, [
      join(root, ".env"),
      join(root, "run.exe"),
      join(root, "folder"),
      notesPath,
    ]);
    expect(reg.ok).toBe(true);
    expect(reg.rejected).toEqual([
      { name: ".env", reason: "sensitive-path" },
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

  it.skipIf(!canCreateSymlinks())("refuses a symlink to a sensitive path", async () => {
    const link = join(root, "innocent.txt");
    symlinkSync(join(root, ".env"), link);
    expect(await register(7, [link])).toMatchObject({
      ok: false,
      rejected: [{ name: "innocent.txt", reason: "sensitive-path" }],
    });
  });

  it.skipIf(!canCreateSymlinks())("re-checks a dropped symlink's current target when it is opened or read", async () => {
    const link = join(root, "retarget.txt");
    symlinkSync(notesPath, link);
    const reg = await register(7, [link]);
    expect(reg.ok).toBe(true);
    await call(CHANNELS.attach.redeemDrop, 7, reg.token);

    // Swap the symlink after registration to test redemption-time path validation.
    rmSync(link);
    symlinkSync(join(root, "run.exe"), link);
    vi.mocked(shell.openPath).mockClear();
    expect(await call(CHANNELS.attach.openExternal, 7, link)).toEqual({ ok: false, error: "type-not-allowed" });
    expect(shell.openPath).not.toHaveBeenCalled();

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
