import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getBuiltinModule } from "node:process";
import type { SrtWinBuildReceipt } from "../../permissions/generated/srt-win-build-receipts.js";
import pins from "../../permissions/srt-win-pins.json" with { type: "json" };

const { existsSync, readFileSync } = getBuiltinModule("node:fs");

// Pin-based receipts accompany upstream fixture bytes only.
export function upstreamSrtWinReceiptFixtures(): Readonly<Record<string, SrtWinBuildReceipt>> {
  return Object.fromEntries(Object.entries(pins.sha256).map(([arch, binarySha256]) => [arch, {
    schemaVersion: 1,
    sourceRevision: pins.source.revision,
    sourceArchiveSha256: pins.source.sha256,
    nativePatchSha256: pins.nativePatchSha256,
    rustToolchain: pins.rustToolchain,
    target: arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc",
    binarySha256,
  }]));
}
const require = createRequire(import.meta.url);
const vendor = join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "vendor");
const { assertBuildReceipt } = require("../../../scripts/lib/srt-win-integrity.cjs") as {
  assertBuildReceipt: (receipt: SrtWinBuildReceipt, arch: string) => void;
};

export function selectSrtWinTestReceipts(
  generated: Readonly<Record<string, SrtWinBuildReceipt>>,
  vendorDirectory = vendor,
): Readonly<Record<string, SrtWinBuildReceipt>> {
  const fixtures = upstreamSrtWinReceiptFixtures();
  return Object.fromEntries(Object.keys(fixtures).map(arch => {
    const directory = join(vendorDirectory, "srt-win", arch);
    const adjacent = join(directory, "build-receipt.json");
    const receipt = Object.hasOwn(generated, arch) ? generated[arch]
      : existsSync(adjacent) ? JSON.parse(readFileSync(adjacent, "utf8")) as SrtWinBuildReceipt
        : fixtures[arch];
    assertBuildReceipt(receipt, arch);
    const digest = createHash("sha256").update(readFileSync(join(directory, "srt-win.exe"))).digest("hex");
    if (digest !== receipt.binarySha256) throw new Error(`Test helper receipt does not match installed bytes: ${arch}`);
    return [arch, receipt];
  }));
}

export function readSrtWinTestInput(arch: string): Buffer {
  return readFileSync(join(vendor, "srt-win", arch, "srt-win.exe"));
}

export function hasNativeSrtWinBuildReceipt(arch = process.arch): boolean {
  const generated = require("../../permissions/generated/srt-win-build-receipts.json") as Record<string, SrtWinBuildReceipt>;
  return Object.hasOwn(generated, arch);
}
