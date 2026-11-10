import type { SrtWinBuildReceipt } from "../../permissions/generated/srt-win-build-receipts.js";
import pins from "../../permissions/srt-win-pins.json" with { type: "json" };

// These bytes are fixtures on non-native test hosts; production always requires a compiled receipt.
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
