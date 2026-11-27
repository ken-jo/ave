// The holder helper's pin survives code signing and nothing else: every byte outside the fields signing rewrites counts.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { machoImageDigest } from "../../scripts/lib/macho-image-digest.mjs";
import { machoFixture } from "./fixtures/macho-fixture.js";

describe("Mach-O image digest", () => {
  it("is equal for an image and the same image with a different signature, UUID and linkedit sizes", () => {
    const unsigned = machoFixture();
    const signed = machoFixture({ signature: Buffer.alloc(200, 0x33), uuid: Buffer.alloc(16, 0x11) });
    expect(signed.equals(unsigned)).toBe(false);
    expect(machoImageDigest(signed)).toBe(machoImageDigest(unsigned));
  });

  it("changes when one code byte, one load-command byte or one symbol byte changes", () => {
    const base = machoImageDigest(machoFixture());
    expect(machoImageDigest(machoFixture({ code: Buffer.from("code-bytes-0123456789abcdeF") }))).not.toBe(base);
    const command = machoFixture();
    command[32 + 24] ^= 1; // __TEXT vmaddr, a load-command byte
    expect(machoImageDigest(command)).not.toBe(base);
    const linkedit = machoFixture();
    linkedit[32 + 72 + 40] ^= 0x40; // __LINKEDIT fileoff stays in the digest
    expect(() => machoImageDigest(linkedit)).toThrow();
    const symbols = machoFixture();
    symbols[symbols.length - 64 - 1] ^= 1; // last byte before the signature
    expect(machoImageDigest(symbols)).not.toBe(base);
  });

  it("refuses a fat file, a file with no or two signature commands, and a signature that is not the tail", () => {
    expect(() => machoImageDigest(machoFixture({ magic: 0xbebafeca }))).toThrow("not a thin");
    expect(() => machoImageDigest(machoFixture({ signatureCommands: 0 }))).toThrow("no code signature command");
    expect(() => machoImageDigest(machoFixture({ signatureCommands: 2 }))).toThrow("one code signature command");
    expect(() => machoImageDigest(machoFixture({ trailing: Buffer.from("tail") }))).toThrow("not the file's tail");
    expect(() => machoImageDigest(Buffer.alloc(8))).toThrow("too short");
  });

  it.runIf(process.platform === "darwin" && process.arch === "arm64")("keeps the built helper's digest across a real ad hoc hardened-runtime re-sign", () => {
    const helper = resolve("resources/macos-holder-sweep/arm64/ave-holder-sweep");
    if (!existsSync(helper)) throw new Error("Build the helper first: node scripts/build-macos-holder-sweep.mjs");
    const dir = mkdtempSync(join(tmpdir(), "ave-macho-digest-"));
    try {
      const copy = join(dir, "ave-holder-sweep");
      copyFileSync(helper, copy);
      const signed = spawnSync("codesign", ["-f", "-s", "-", "--options", "runtime", copy], { encoding: "utf8" });
      expect(signed.status, signed.stderr).toBe(0);
      expect(readFileSync(copy).equals(readFileSync(helper))).toBe(false);
      expect(machoImageDigest(readFileSync(copy))).toBe(machoImageDigest(readFileSync(helper)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
