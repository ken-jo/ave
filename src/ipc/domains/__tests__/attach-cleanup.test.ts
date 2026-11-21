import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeFs from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, promises as fsPromises, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { invokeAppIpcHandler, makeAppIpcFrameInvoker } from "./test-helpers.js";
import { cleanupTmpDir, removeLinkOnly } from "../../../__tests__/support/tmp-dir-teardown.js";

const { handlers, showOpenDialogMock, profile } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialogMock: vi.fn(),
  // A profile path no other test run shares, so this file's clipboard image directory is its own.
  profile: { userData: `attach-cleanup-profile-${process.pid}-${Date.now()}` },
}));

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

vi.mock("electron", () => ({
  app: { getPath: () => profile.userData },
  dialog: { showOpenDialog: showOpenDialogMock },
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
import * as lockRetry from "../../../lib/transient-fs-lock-retry.js";
import { clipboardImageRoot, registerAttachHandlers, sweepLeftoverClipboardImages } from "../attach.js";
import { MAX_COMPOSER_IMAGE_BYTES } from "../../../shared/composer-image-input.js";

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const invoke = (channel: string, ...args: unknown[]) => invokeAppIpcHandler(handlers, channel, ...args);
const invokeWithSenderFrame = makeAppIpcFrameInvoker(handlers);

const savedPaths = new Set<string>();
const savedTempDirs = new Set<string>();
let root: string;

async function saveOwnedClipboardImage(): Promise<string> {
  const result = await invoke(CHANNELS.attach.saveClipboardImage, { base64: PNG_BASE64 }) as {
    ok: boolean;
    path?: string;
  };
  expect(result).toMatchObject({ ok: true });
  expect(result.path).toEqual(expect.any(String));
  savedPaths.add(result.path!);
  savedTempDirs.add(dirname(result.path!));
  return result.path!;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ave-attach-cleanup-"));
  registerAttachHandlers({
    auditLogger: { log: vi.fn() },
    getMainWindow: () => ({}),
  } as never);
});

beforeEach(() => {
  showOpenDialogMock.mockReset();
});

afterAll(async () => {
  for (const filePath of savedPaths) rmSync(filePath, { force: true });
  for (const directory of savedTempDirs) {
    await cleanupTmpDir(directory);
  }
  await cleanupTmpDir(root);
  await cleanupTmpDir(clipboardImageRoot());
});

describe("ave:attach:release", () => {
  it("deletes the clipboard image this app wrote, its directory, and the emptied profile directory", async () => {
    const filePath = await saveOwnedClipboardImage();
    expect(dirname(dirname(filePath))).toBe(clipboardImageRoot());
    expect(existsSync(filePath)).toBe(true);

    expect(await invoke(CHANNELS.attach.release, [filePath])).toEqual({ ok: true });
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(dirname(filePath))).toBe(false);
    expect(existsSync(clipboardImageRoot())).toBe(false);
    expect(await invoke(CHANNELS.attach.readImage, filePath)).toEqual({ ok: false, error: "path_not_authorized" });
    // A second release of the same path finds nothing to give back.
    expect(await invoke(CHANNELS.attach.release, [filePath])).toEqual({ ok: true });
  });

  it("keeps a different file put at the clipboard image's path, and still withdraws the authorization", async () => {
    const filePath = await saveOwnedClipboardImage();
    const priorOwnedPath = `${filePath}.original`;
    renameSync(filePath, priorOwnedPath);
    writeFileSync(filePath, Buffer.from("user-managed replacement file"));

    expect(await invoke(CHANNELS.attach.release, [filePath])).toEqual({ ok: true });
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(priorOwnedPath)).toBe(true);
    expect(await invoke(CHANNELS.attach.readImage, filePath)).toEqual({ ok: false, error: "path_not_authorized" });

    rmSync(filePath, { force: true });
    rmSync(priorOwnedPath, { force: true });
  });

  it("keeps a file that takes the image's place after the directory was read, and gives it its name back", async () => {
    const filePath = await saveOwnedClipboardImage();
    const movedAway = join(root, `own-image-${readdirSync(root).length}`);
    // The swap happens at the last moment a name-based check could have passed: just as the image is about to be taken.
    const take = vi.spyOn(lockRetry, "renameFile").mockImplementationOnce(async (from, to) => {
      take.mockRestore();
      renameSync(filePath, movedAway);
      writeFileSync(filePath, "the person's own file");
      await lockRetry.renameFile(from, to);
    });

    expect(await invoke(CHANNELS.attach.release, [filePath])).toEqual({ ok: true });
    expect(readFileSync(filePath, "utf8")).toBe("the person's own file");
    expect(readdirSync(dirname(filePath))).toEqual([basename(filePath)]);
    expect(existsSync(movedAway)).toBe(true);
    expect(await invoke(CHANNELS.attach.readImage, filePath)).toEqual({ ok: false, error: "path_not_authorized" });
    rmSync(filePath, { force: true });
  });

  it("keeps a replacement under its new name when no link can give its name back, and never overwrites a newer file", async () => {
    const filePath = await saveOwnedClipboardImage();
    const movedAway = join(root, `own-image-${readdirSync(root).length}`);
    renameSync(filePath, movedAway);
    writeFileSync(filePath, "a replacement");
    // The volume makes no hard links. The person's newer file arrives just as anything would try to move the
    // replacement back, or, when nothing tries, right after the release.
    const link = vi.spyOn(fsPromises, "link").mockRejectedValueOnce(Object.assign(new Error("no hard links here"), { code: "ENOTSUP" }));
    const realRename = fsPromises.rename.bind(fsPromises);
    let arrived = false;
    const arrive = () => {
      if (!arrived) writeFileSync(filePath, "the person's newer file");
      arrived = true;
    };
    const rename = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      if (to === filePath) arrive();
      await realRename(from, to);
    });
    try {
      expect(await invoke(CHANNELS.attach.release, [filePath])).toEqual({ ok: true });
    } finally {
      rename.mockRestore();
      link.mockRestore();
    }
    arrive();
    expect(readFileSync(filePath, "utf8")).toBe("the person's newer file");
    const kept = readdirSync(dirname(filePath)).filter((name) => name !== basename(filePath));
    expect(kept).toEqual([expect.stringMatching(/^\.reclaim-[0-9a-f]{24}$/u)]);
    for (const name of kept) expect(readFileSync(join(dirname(filePath), name), "utf8")).toBe("a replacement");
    expect(existsSync(movedAway)).toBe(true);
    expect(await invoke(CHANNELS.attach.readImage, filePath)).toEqual({ ok: false, error: "path_not_authorized" });
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it.each([null, "EPERM", "EISDIR"] as const)("deletes nothing elsewhere when the image directory becomes a link after it was read (unlink refusal: %s)", async (unlinkRefusal) => {
    const filePath = await saveOwnedClipboardImage();
    const directory = dirname(filePath);
    const elsewhere = join(root, `elsewhere-${readdirSync(root).length}`);
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, basename(filePath)), "the person's own file");
    const readdir = vi.spyOn(fsPromises, "readdir").mockImplementationOnce((async (target: string) => {
      readdir.mockRestore();
      const names = await fsPromises.readdir(target);
      renameSync(directory, join(root, `real-image-directory-${readdirSync(root).length}`));
      symlinkSync(elsewhere, directory, "junction");
      return names;
    }) as never);
    const realRm = nodeFs.rmSync;
    const realUnlink = nodeFs.unlinkSync;
    const realRmdir = nodeFs.rmdirSync;
    const remove = vi.spyOn(nodeFs, "rmSync").mockImplementation((target, options) => {
      if (unlinkRefusal && target === directory && !options?.recursive) {
        throw Object.assign(new Error("directory link requires a directory removal operation"), { code: "EPERM" });
      }
      realRm(target, options);
    });
    const unlink = vi.spyOn(nodeFs, "unlinkSync").mockImplementation((target) => {
      if (unlinkRefusal && target === directory) {
        throw Object.assign(new Error("directory link requires a directory removal operation"), { code: unlinkRefusal });
      }
      realUnlink(target);
    });
    const removeDirectory = vi.spyOn(nodeFs, "rmdirSync").mockImplementation((target) => {
      if (unlinkRefusal && target === directory && process.platform !== "win32") realUnlink(target);
      else realRmdir(target);
    });
    try {
      expect(await invoke(CHANNELS.attach.release, [filePath])).toEqual({ ok: true });
      expect(lstatSync(directory).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(elsewhere, basename(filePath)), "utf8")).toBe("the person's own file");
      expect(readdirSync(elsewhere)).toEqual([basename(filePath)]);
      removeLinkOnly(directory);
      expect(existsSync(directory)).toBe(false);
      expect(readFileSync(join(elsewhere, basename(filePath)), "utf8")).toBe("the person's own file");
      expect(readdirSync(elsewhere)).toEqual([basename(filePath)]);
      expect(remove).not.toHaveBeenCalled();
      expect(unlink).toHaveBeenCalledWith(directory);
      if (unlinkRefusal) expect(removeDirectory).toHaveBeenCalledWith(directory);
      for (const args of removeDirectory.mock.calls) expect(args).toEqual([directory]);
    } finally {
      remove.mockRestore();
      unlink.mockRestore();
      removeDirectory.mockRestore();
      readdir.mockRestore();
      if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) removeLinkOnly(directory);
    }
  });

  it("gives back a picked file's authorization and never deletes the person's file", async () => {
    const userFilePath = join(root, "user-picked.png");
    writeFileSync(userFilePath, Buffer.from(PNG_BASE64, "base64"));
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [userFilePath] });
    expect(await invoke(CHANNELS.attach.openFile)).toMatchObject({ canceled: false, files: [{ path: userFilePath }] });
    expect(await invoke(CHANNELS.attach.readImage, userFilePath)).toMatchObject({ ok: true });

    expect(await invoke(CHANNELS.attach.release, [userFilePath])).toEqual({ ok: true });
    expect(existsSync(userFilePath)).toBe(true);
    expect(await invoke(CHANNELS.attach.readImage, userFilePath)).toEqual({ ok: false, error: "path_not_authorized" });
  });

  it("keeps a file attached twice readable until both attachments are gone", async () => {
    const userFilePath = join(root, "twice.png");
    writeFileSync(userFilePath, Buffer.from(PNG_BASE64, "base64"));
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [userFilePath] });
    await invoke(CHANNELS.attach.openFile);
    await invoke(CHANNELS.attach.openFile);

    await invoke(CHANNELS.attach.release, [userFilePath]);
    expect(await invoke(CHANNELS.attach.readImage, userFilePath)).toMatchObject({ ok: true });
    await invoke(CHANNELS.attach.release, [userFilePath]);
    expect(await invoke(CHANNELS.attach.readImage, userFilePath)).toEqual({ ok: false, error: "path_not_authorized" });
  });

  it("refuses a payload that is not a short list of paths", async () => {
    expect(await invoke(CHANNELS.attach.release, "/tmp/x.png")).toEqual({ ok: false, error: "invalid-payload" });
    expect(await invoke(CHANNELS.attach.release, [42])).toEqual({ ok: false, error: "invalid-payload" });
    expect(await invoke(CHANNELS.attach.release, Array.from({ length: 65 }, (_, i) => `/tmp/${i}`)))
      .toEqual({ ok: false, error: "invalid-payload" });
  });

  it("accepts only a host renderer frame", async () => {
    const hostFilePath = await saveOwnedClipboardImage();
    expect(await invokeWithSenderFrame(CHANNELS.attach.release, "file:///app/index.html", [hostFilePath])).toEqual({ ok: true });
    expect(existsSync(hostFilePath)).toBe(false);

    const pluginFilePath = await saveOwnedClipboardImage();
    expect(await invokeWithSenderFrame(
      CHANNELS.attach.release,
      "ave-mcp-app://s-66697874757265/proxy.html?t=fixture",
      [pluginFilePath],
    )).toEqual({ ok: false, error: "unauthorized" });
    expect(await invoke(CHANNELS.attach.readImage, pluginFilePath)).toMatchObject({ ok: true });

    const remoteFilePath = await saveOwnedClipboardImage();
    expect(await invokeWithSenderFrame(CHANNELS.attach.release, "https://untrusted.example/settings", [remoteFilePath]))
      .toEqual({ ok: false, error: "unauthorized" });
    expect(await invoke(CHANNELS.attach.readImage, remoteFilePath)).toMatchObject({ ok: true });
    await invoke(CHANNELS.attach.release, [pluginFilePath, remoteFilePath]);
  });
});

describe("sweepLeftoverClipboardImages", () => {
  function makeRoot(): string {
    const sweepRoot = join(root, `sweep-${readdirSync(root).length}`);
    mkdirSync(sweepRoot, { mode: 0o700 });
    return sweepRoot;
  }
  function leftover(sweepRoot: string, name: string, files: Record<string, string> = { "image.png": "png" }): string {
    const directory = join(sweepRoot, name);
    mkdirSync(directory, { mode: 0o700 });
    for (const [file, body] of Object.entries(files)) writeFileSync(join(directory, file), body);
    return directory;
  }
  /** The record an earlier run leaves: which file it wrote in each directory, by the identity the file had then. */
  function receipts(sweepRoot: string, written: Record<string, string>): void {
    writeFileSync(join(sweepRoot, "written.json"), JSON.stringify(Object.fromEntries(Object.entries(written).map(([directory, file]) => {
      const stat = statSync(join(sweepRoot, directory, file), { bigint: true });
      return [directory, { file, dev: stat.dev.toString(), ino: stat.ino.toString() }];
    }))));
  }

  it("removes the images an earlier run recorded as written, the record, and the root once it is empty", async () => {
    const sweepRoot = makeRoot();
    const first = leftover(sweepRoot, "ave-clip-AbC123");
    const second = leftover(sweepRoot, "ave-clip-zzZ999", { "image.jpeg": "jpeg" });
    receipts(sweepRoot, { "ave-clip-AbC123": "image.png", "ave-clip-zzZ999": "image.jpeg" });

    expect(await sweepLeftoverClipboardImages(sweepRoot)).toEqual({ removed: 2, kept: 0 });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(sweepRoot)).toBe(false);
  });

  it("keeps a directory that only looks like this app's: no record says the app wrote the file in it", async () => {
    const sweepRoot = makeRoot();
    const recorded = leftover(sweepRoot, "ave-clip-Known1");
    const unrecorded = leftover(sweepRoot, "ave-clip-NoRec1");
    receipts(sweepRoot, { "ave-clip-Known1": "image.png" });

    expect(await sweepLeftoverClipboardImages(sweepRoot)).toEqual({ removed: 1, kept: 1 });
    expect(existsSync(recorded)).toBe(false);
    expect(existsSync(join(unrecorded, "image.png"))).toBe(true);
  });

  it("keeps a file that replaced the recorded image between runs", async () => {
    const sweepRoot = makeRoot();
    const directory = leftover(sweepRoot, "ave-clip-Swap01");
    receipts(sweepRoot, { "ave-clip-Swap01": "image.png" });
    // The earlier run ended; before the next start the image is replaced by a file of the person's own.
    renameSync(join(directory, "image.png"), join(root, `moved-away-${readdirSync(root).length}`));
    writeFileSync(join(directory, "image.png"), "the person's own file");

    expect(await sweepLeftoverClipboardImages(sweepRoot)).toEqual({ removed: 0, kept: 1 });
    expect(readFileSync(join(directory, "image.png"), "utf8")).toBe("the person's own file");
    expect(readdirSync(directory)).toEqual(["image.png"]);
  });

  it("deletes nothing when the record is missing or cannot be read", async () => {
    const missing = makeRoot();
    const first = leftover(missing, "ave-clip-AbC123");
    expect(await sweepLeftoverClipboardImages(missing)).toEqual({ removed: 0, kept: 1 });
    expect(existsSync(join(first, "image.png"))).toBe(true);

    const garbled = makeRoot();
    const second = leftover(garbled, "ave-clip-AbC123");
    writeFileSync(join(garbled, "written.json"), "{ not json");
    expect(await sweepLeftoverClipboardImages(garbled)).toEqual({ removed: 0, kept: 1 });
    expect(existsSync(join(second, "image.png"))).toBe(true);
  });

  it("leaves everything it does not recognize as its own", async () => {
    const sweepRoot = makeRoot();
    // Not this app's directory name.
    const foreign = leftover(sweepRoot, "notes", { "image.png": "png" });
    const nearMiss = leftover(sweepRoot, "ave-clip-toolong1");
    // This app's name and a record for it, with a file it never writes beside the image.
    const mixed = leftover(sweepRoot, "ave-clip-Mixed1", { "image.png": "png", "report.pdf": "pdf" });
    const looseFile = join(sweepRoot, "ave-clip-File01");
    writeFileSync(looseFile, "a file, not a directory");
    receipts(sweepRoot, { "ave-clip-Mixed1": "image.png" });

    expect(await sweepLeftoverClipboardImages(sweepRoot)).toEqual({ removed: 0, kept: 1 });
    expect(existsSync(join(foreign, "image.png"))).toBe(true);
    expect(existsSync(join(nearMiss, "image.png"))).toBe(true);
    expect(existsSync(join(mixed, "image.png"))).toBe(true);
    expect(existsSync(join(mixed, "report.pdf"))).toBe(true);
    expect(existsSync(looseFile)).toBe(true);
  });

  it("never follows a link: not as an image directory, not as the root", async () => {
    const outside = join(root, `outside-${readdirSync(root).length}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "image.png"), "the person's own file");
    const sweepRoot = makeRoot();
    // "junction" is the directory link Windows allows without elevation; other platforms ignore the type.
    symlinkSync(outside, join(sweepRoot, "ave-clip-Link01"), "junction");
    receipts(sweepRoot, { "ave-clip-Link01": "image.png" });

    expect(await sweepLeftoverClipboardImages(sweepRoot)).toEqual({ removed: 0, kept: 0 });
    expect(existsSync(join(outside, "image.png"))).toBe(true);

    const linkedRoot = join(root, `linked-root-${readdirSync(root).length}`);
    const realRoot = makeRoot();
    leftover(realRoot, "ave-clip-Real01");
    receipts(realRoot, { "ave-clip-Real01": "image.png" });
    symlinkSync(realRoot, linkedRoot, "junction");
    expect(await sweepLeftoverClipboardImages(linkedRoot)).toEqual({ removed: 0, kept: 0 });
    expect(existsSync(join(realRoot, "ave-clip-Real01", "image.png"))).toBe(true);
  });

  it("leaves a root other accounts can enter, where the platform can tell", async () => {
    const sweepRoot = join(root, `shared-${readdirSync(root).length}`);
    mkdirSync(sweepRoot, { mode: 0o755 });
    const directory = leftover(sweepRoot, "ave-clip-Open01");
    receipts(sweepRoot, { "ave-clip-Open01": "image.png" });
    // Windows reports no owner or mode; its temp directory is per account, so the root is taken as private there.
    const readsMode = process.platform !== "win32";
    expect(await sweepLeftoverClipboardImages(sweepRoot)).toEqual({ removed: readsMode ? 0 : 1, kept: 0 });
    expect(existsSync(join(directory, "image.png"))).toBe(readsMode);
  });

  it("does nothing when the profile has no clipboard image directory", async () => {
    expect(await sweepLeftoverClipboardImages(join(root, "never-created"))).toEqual({ removed: 0, kept: 0 });
  });

  it("at the next start removes an image a paste wrote and never gave back, and nothing beside it", async () => {
    // A paste in this run writes the image and its record; the run then ends without a release.
    const pastedEarlier = await saveOwnedClipboardImage();
    const ownRoot = clipboardImageRoot();
    // Beside it: a directory of the same shape that no record names.
    const lookalike = leftover(ownRoot, "ave-clip-Start1");
    // A directory of the old layout, directly in the shared temp directory: another running Ave may be using it.
    const legacy = mkdtempSync(join(tmpdir(), "ave-clip-"));
    writeFileSync(join(legacy, "image.png"), "png");
    savedTempDirs.add(legacy);
    savedTempDirs.add(lookalike);

    registerAttachHandlers({ auditLogger: { log: vi.fn() }, getMainWindow: () => ({}) } as never);
    // A paste queues behind the sweep, so its answer means the sweep has finished.
    const pasted = await saveOwnedClipboardImage();

    expect(existsSync(pastedEarlier)).toBe(false);
    expect(existsSync(join(lookalike, "image.png"))).toBe(true);
    expect(existsSync(join(legacy, "image.png"))).toBe(true);
    expect(existsSync(pasted)).toBe(true);
    await invoke(CHANNELS.attach.release, [pasted]);
  });
});

describe("ave:attach image MIME normalization", () => {
  it("uses magic-derived MIME for renamed and extensionless picker images", async () => {
    const renamed = join(root, "png-content.jpg");
    const extensionless = join(root, "png-content");
    const png = Buffer.from(PNG_BASE64, "base64");
    writeFileSync(renamed, png);
    writeFileSync(extensionless, png);
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [renamed, extensionless] });

    expect(await invoke(CHANNELS.attach.openFile)).toMatchObject({
      canceled: false,
      files: [
        { path: renamed, ext: "jpg", isImage: true, mimeType: "image/png" },
        { path: extensionless, ext: "", isImage: true, mimeType: "image/png" },
      ],
    });

    for (const filePath of [renamed, extensionless]) {
      expect(await invoke(CHANNELS.attach.readImage, filePath)).toMatchObject({
        ok: true,
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${PNG_BASE64}`,
      });
    }
  });

  it("canonicalizes permissive clipboard base64 and rejects nonimages", async () => {
    const result = await invoke(CHANNELS.attach.saveClipboardImage, {
      base64: `${PNG_BASE64}\n`,
    }) as { ok: boolean; path?: string; mimeType?: string; dataUrl?: string };

    expect(result).toMatchObject({
      ok: true,
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${PNG_BASE64}`,
    });
    expect(result.path).toEqual(expect.any(String));
    savedPaths.add(result.path!);
    savedTempDirs.add(dirname(result.path!));
    expect(basename(dirname(result.path!))).toMatch(/^ave-clip-/u);
    expect(basename(result.path!)).toBe("image.png");
    if (process.platform !== "win32") {
      expect(statSync(result.path!).mode & 0o077).toBe(0);
    }

    expect(await invoke(CHANNELS.attach.saveClipboardImage, {
      base64: Buffer.from("not an image").toString("base64"),
    })).toEqual({
      ok: false,
      error: "not_image",
    });
  });
});

describe("ave:attach:openFile refusals", () => {
  it("returns each refused selection by name with the reason the composer shows", async () => {
    const kept = join(root, "notes.txt");
    writeFileSync(kept, "notes");
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: [join(root, "setup.exe"), kept, join(root, "gone.txt")],
    });

    expect(await invoke(CHANNELS.attach.openFile)).toMatchObject({
      canceled: false,
      files: [{ path: kept, name: "notes.txt" }],
      rejected: [
        { name: "setup.exe", reason: "denied-extension" },
        { name: "gone.txt", reason: "not-found" },
      ],
    });
  });
});

describe("ave:attach:saveClipboardImage size refusal", () => {
  it("answers an oversized clipboard image with a bare code, never the byte counts", async () => {
    const oversized = "A".repeat(MAX_COMPOSER_IMAGE_BYTES * 2 + 4);
    expect(await invoke(CHANNELS.attach.saveClipboardImage, { base64: oversized })).toEqual({
      ok: false,
      error: "clipboard_too_large",
    });
  });
});
