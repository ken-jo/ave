import { constants, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const file = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", () => ({ open: file.open }));
vi.mock("../../shared/image-preparation-policy.js", async (original) => {
  const actual = await original<typeof import("../../shared/image-preparation-policy.js")>();
  return { ...actual, IMAGE_PREPARATION_POLICY: { ...actual.IMAGE_PREPARATION_POLICY, maxInputBytes: 64, readChunkBytes: 16 } };
});
import { readImageInput } from "../image-preparation-input.js";

describe("image source read bounds", () => {
  it("bounds actual reads when a file grows after the opened handle size check", async () => {
    const source = Buffer.alloc(100);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(source);
    const close = vi.fn(async () => {});
    let highestRead = 0;
    file.open.mockResolvedValue({
      stat: async () => ({ size: 8, isFile: () => true }), close,
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        highestRead = Math.max(highestRead, position + length);
        return { bytesRead: source.copy(buffer, offset, position, position + length) };
      },
    });
    await expect(readImageInput("growing.png", new AbortController().signal)).rejects.toThrow("Source grew");
    expect(highestRead).toBe(65);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the opened handle when cancelled during a read", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    file.open.mockResolvedValue({
      stat: async () => ({ size: 8, isFile: () => true }), close,
      read: async () => { controller.abort(new Error("read cancelled")); return { bytesRead: 0 }; },
    });
    await expect(readImageInput("cancelled.png", controller.signal)).rejects.toThrow("read cancelled");
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses special files without reading their contents", async () => {
    const close = vi.fn(async () => {});
    const read = vi.fn();
    file.open.mockResolvedValue({ stat: async () => ({ isFile: () => false }), read, close });
    await expect(readImageInput("pipe", new AbortController().signal)).rejects.toThrow("regular file");
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns bytes only from the file the judged path still names after the read", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(12)]);
    const protectedBytes = Buffer.from("PROTECTED");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ave-image-input-")));
    const shots = join(base, "shots");
    const elsewhere = join(base, "elsewhere", ".ssh");
    const image = join(shots, "qr.png");
    mkdirSync(shots);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(image, png);
    writeFileSync(join(elsewhere, "qr.png"), Buffer.concat([png, protectedBytes]));
    try {
      // The folder, or the last name (a second name for the protected file standing in for a link), leads into the
      // protected folder only while the file is opened; the open lacks the flag that refuses a link, as on Windows.
      for (const swapped of ["folder", "last name"] as const) {
        const swap = swapped === "folder"
          ? { to: () => { renameSync(shots, `${shots}.orig`); symlinkSync(elsewhere, shots, "junction"); },
            back: () => { unlinkSync(shots); renameSync(`${shots}.orig`, shots); } }
          : { to: () => { renameSync(image, `${image}.orig`); linkSync(join(elsewhere, "qr.png"), image); },
            back: () => { unlinkSync(image); renameSync(`${image}.orig`, image); } };
        file.open.mockImplementationOnce(async (target: string, flags: number) => {
          swap.to();
          try {
            return await actual.open(target, flags & ~(constants.O_NOFOLLOW ?? 0));
          } finally {
            swap.back();
          }
        });
        await expect(readImageInput(image, new AbortController().signal), swapped).rejects.toThrow("image-source-changed");
      }
      // Nothing swapped: the file is read.
      file.open.mockImplementationOnce(actual.open);
      expect((await readImageInput(image, new AbortController().signal)).equals(png)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
