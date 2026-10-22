import { mkdtempSync, promises as fs, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeExecutableBytes } from "../../__tests__/support/native-executable.js";
import { isNativeExecutableFile } from "../native-executable-format.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function accepts(bytes: Buffer, platform: NodeJS.Platform, arch: NodeJS.Architecture = "x64"): Promise<boolean> {
  const root = mkdtempSync(join(tmpdir(), "ave-executable-header-"));
  roots.push(root);
  const path = join(root, "binary");
  writeFileSync(path, bytes);
  const handle = await fs.open(path, "r");
  try { return await isNativeExecutableFile(handle, platform, arch); } finally { await handle.close(); }
}

describe("native executable formats", () => {
  it.each(["linux", "darwin", "win32"] as const)("checks the full %s header and architecture", async (platform) => {
    for (const arch of ["x64", "arm64"] as const) {
      const bytes = nativeExecutableBytes(platform, arch);
      await expect(accepts(bytes, platform, arch)).resolves.toBe(true);
      await expect(accepts(bytes, platform, arch === "x64" ? "arm64" : "x64")).resolves.toBe(false);
      await expect(accepts(bytes.subarray(0, 20), platform, arch)).resolves.toBe(false);
    }
  });

  it("rejects ELF-prefixed shell text before any process can be started", async () => {
    await expect(accepts(Buffer.from("\x7fELF\necho executed > marker\n"), "linux")).resolves.toBe(false);
  });

  it.each(["x64", "arm64"] as const)("rejects oversized and malformed %s ELF property notes that native loaders refuse", async (arch) => {
    const bytes = nativeExecutableBytes("linux", arch);
    bytes.writeUInt16LE(2, 56); bytes.writeUInt32LE(0x6474e553, 120);
    bytes.writeBigUInt64LE(512n, 128); bytes.writeBigUInt64LE(2048n, 152);
    await expect(accepts(bytes, "linux", arch)).resolves.toBe(false);
    bytes.writeBigUInt64LE(32n, 152);
    await expect(accepts(bytes, "linux", arch)).resolves.toBe(false);
    bytes.writeUInt32LE(4, 512); bytes.writeUInt32LE(16, 516);
    bytes.writeUInt32LE(5, 520); bytes.writeUInt32LE(0x00554e47, 524);
    bytes.writeUInt32LE(arch === "arm64" ? 0xc0000000 : 0xc0000002, 528); bytes.writeUInt32LE(4, 532);
    await expect(accepts(bytes, "linux", arch)).resolves.toBe(true);
    bytes.writeUInt32LE(8, 532);
    await expect(accepts(bytes, "linux", arch)).resolves.toBe(false);
  });

  it.each([
    (bytes: Buffer) => bytes.writeUInt16LE(63, 52),
    (bytes: Buffer) => bytes.writeBigUInt64LE(4090n, 32),
    (bytes: Buffer) => bytes.writeBigUInt64LE(8192n, 96),
    (bytes: Buffer) => bytes.writeUInt32LE(4, 68),
    (bytes: Buffer) => bytes.writeBigUInt64LE(0x800000n, 24),
    (bytes: Buffer) => bytes.writeBigUInt64LE(3n, 112),
  ])("rejects a malformed ELF loader structure %#", async (edit) => {
    const bytes = nativeExecutableBytes("linux", "x64"); edit(bytes);
    await expect(accepts(bytes, "linux")).resolves.toBe(false);
  });

  it.each([
    (bytes: Buffer) => bytes.writeUInt32LE(6, 12),
    (bytes: Buffer) => bytes.writeUInt32LE(4096, 20),
    (bytes: Buffer) => bytes.writeUInt32LE(0, 36),
    (bytes: Buffer) => bytes.writeBigUInt64LE(8192n, 80),
    (bytes: Buffer) => bytes.writeUInt32LE(1, 92),
    (bytes: Buffer) => bytes.writeBigUInt64LE(4096n, 112),
  ])("rejects a malformed Mach-O loader structure %#", async (edit) => {
    const bytes = nativeExecutableBytes("darwin", "x64"); edit(bytes);
    await expect(accepts(bytes, "darwin")).resolves.toBe(false);
  });

  it("validates each slice of a universal Mach-O container", async () => {
    const bytes = Buffer.alloc(12288);
    bytes.writeUInt32BE(0xcafebabe, 0); bytes.writeUInt32BE(2, 4);
    for (const [index, arch] of ["x64", "arm64"].entries()) {
      const start = 8 + index * 20;
      bytes.writeUInt32BE(arch === "x64" ? 0x01000007 : 0x0100000c, start);
      bytes.writeUInt32BE(4096 * (index + 1), start + 8);
      bytes.writeUInt32BE(4096, start + 12); bytes.writeUInt32BE(12, start + 16);
      nativeExecutableBytes("darwin", arch as NodeJS.Architecture).copy(bytes, 4096 * (index + 1));
    }
    await expect(accepts(bytes, "darwin")).resolves.toBe(true);
    bytes.writeUInt32BE(4096, 36);
    await expect(accepts(bytes, "darwin")).resolves.toBe(false);
  });

  it.each([
    (bytes: Buffer) => bytes.writeUInt32LE(4090, 60),
    (bytes: Buffer) => bytes.writeUInt32LE(0, 128),
    (bytes: Buffer) => bytes.writeUInt16LE(0x2002, 150),
    (bytes: Buffer) => bytes.writeUInt16LE(0x10b, 152),
    (bytes: Buffer) => bytes.writeUInt32LE(8192, 412),
    (bytes: Buffer) => bytes.writeUInt32LE(0, 428),
    (bytes: Buffer) => bytes.writeUInt32LE(0, 168),
  ])("rejects a malformed PE loader structure %#", async (edit) => {
    const bytes = nativeExecutableBytes("win32", "x64"); edit(bytes);
    await expect(accepts(bytes, "win32")).resolves.toBe(false);
  });
});
