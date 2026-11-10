import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertBaselineRegression, assertSourceArchive, canReuseSrtWinBuild, parseBuildOptions, recordBuildReceipts } from "../../scripts/build-srt-win.mjs";
const require = createRequire(import.meta.url);
const pins = require("../../src/permissions/srt-win-pins.json");
const { TARGETS, assertBuildReceipt, assertSrtWinVendor, assertUpstreamSrtWinVendor, assertSrtWinBuildInputs } = require("../../scripts/lib/srt-win-integrity.cjs");
function fixture(t) {
  const vendor = mkdtempSync(join(tmpdir(), "ave-native-integrity-"));
  t.after(() => rmSync(vendor, { recursive: true, force: true }));
  const receipts = {};
  for (const arch of Object.keys(TARGETS)) {
    const bytes = Buffer.from(`native fixture ${arch}`);
    const directory = join(vendor, "srt-win", arch);
    mkdirSync(directory, { recursive: true });
    const receipt = { schemaVersion: 1, sourceRevision: pins.source.revision, sourceArchiveSha256: pins.source.sha256,
      nativePatchSha256: pins.nativePatchSha256, rustToolchain: pins.rustToolchain, target: TARGETS[arch], binarySha256: createHash("sha256").update(bytes).digest("hex") };
    writeFileSync(join(directory, "srt-win.exe"), bytes);
    writeFileSync(join(directory, "build-receipt.json"), JSON.stringify(receipt));
    receipts[arch] = receipt;
  }
  return { vendor, receipts };
}
test("native build accepts both target architectures and rejects ambiguous options", () => {
  assert.deepEqual(parseBuildOptions([]).arches, ["x64", "arm64"]);
  assert.deepEqual(parseBuildOptions(["--arch", "arm64", "--test-native"]).arches, ["arm64"]);
  for (const args of [["--arch", "ia32"], ["--arch", "constructor"], ["--unknown"], ["--source-archive"]]) assert.throws(() => parseBuildOptions(args));
});
test("source archive is independently hash pinned to an immutable revision", () => {
  assert.equal(pins.source.revision, "626a59671ee2be556d70a290a8036224be996193");
  assert.ok(pins.source.url.endsWith(`/tarball/${pins.source.revision}`));
  assert.throws(() => assertSourceArchive(Buffer.from("tampered source")), /srt-win-source-integrity-mismatch/);
});
test("native helper compilation refuses a non-native host", () => {
  const moduleUrl = new URL("../../scripts/build-srt-win.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { buildSrtWin, parseBuildOptions } = await import(${JSON.stringify(moduleUrl)});
    await assert.rejects(buildSrtWin(parseBuildOptions([])), /require Windows/);
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
test("compiled payload requires matching trusted inputs and bytes for both architectures", (t) => {
  const { vendor, receipts } = fixture(t);
  assert.doesNotThrow(() => assertSrtWinVendor(vendor, undefined, receipts));
  writeFileSync(join(vendor, "srt-win", "arm64", "srt-win.exe"), "changed binary");
  assert.throws(() => assertSrtWinVendor(vendor, undefined, receipts), /integrity-mismatch/);
});
test("changing both local binary and receipt cannot change the embedded trust anchor", (t) => {
  const { vendor, receipts } = fixture(t);
  const directory = join(vendor, "srt-win", "x64");
  const receipt = { ...receipts.x64, binarySha256: createHash("sha256").update("substituted binary").digest("hex") };
  writeFileSync(join(directory, "srt-win.exe"), "substituted binary");
  writeFileSync(join(directory, "build-receipt.json"), JSON.stringify(receipt));
  assert.throws(() => assertSrtWinVendor(vendor, ["x64"], receipts), /integrity-mismatch/);
});
test("each receipt build input is fixed independently", (t) => {
  const { receipts } = fixture(t);
  for (const key of ["schemaVersion", "sourceRevision", "sourceArchiveSha256", "nativePatchSha256", "rustToolchain", "target", "binarySha256"]) {
    assert.throws(() => assertBuildReceipt({ ...receipts.x64, [key]: "stale" }, "x64"), /integrity-mismatch/, key);
  }
  assert.throws(() => assertBuildReceipt(receipts.x64, "constructor"), /integrity-mismatch/);
});
test("upstream supply verification remains distinct from compiled payload verification", (t) => {
  const { vendor, receipts } = fixture(t);
  assert.doesNotThrow(() => assertSrtWinVendor(vendor, ["x64"], receipts));
  assert.throws(() => assertUpstreamSrtWinVendor(vendor), /upstream-integrity-mismatch/);
  assert.throws(() => assertSrtWinVendor(vendor, ["x64"], {}), /integrity-mismatch/);
});
test("missing receipts and link-substituted images are refused", (t) => {
  const { vendor, receipts } = fixture(t);
  const directory = join(vendor, "srt-win", "x64");
  rmSync(join(directory, "build-receipt.json"));
  assert.throws(() => assertSrtWinVendor(vendor, ["x64"], receipts));
  writeFileSync(join(directory, "build-receipt.json"), JSON.stringify(receipts.x64));
  rmSync(join(directory, "srt-win.exe"));
  symlinkSync(join(vendor, "srt-win", "arm64", "srt-win.exe"), join(directory, "srt-win.exe"));
  assert.throws(() => assertSrtWinVendor(vendor, ["x64"], receipts), /integrity-mismatch/);
});
test("native patch bytes must equal the committed digest before source extraction", (t) => {
  const { vendor } = fixture(t);
  writeFileSync(join(vendor, "srt-win", "persistent-denies.patch"), "untrusted patch");
  assert.throws(() => assertSrtWinBuildInputs(vendor), /native-patch-integrity-mismatch/);
});
test("verified build reuse rejects tampering and rebuilds after fixed input changes", (t) => {
  const { vendor, receipts } = fixture(t);
  assert.equal(canReuseSrtWinBuild(vendor, ["x64", "arm64"], receipts), true);
  const receiptPath = join(vendor, "srt-win", "x64", "build-receipt.json");
  writeFileSync(receiptPath, JSON.stringify({ ...receipts.x64, nativePatchSha256: "f".repeat(64) }));
  assert.equal(canReuseSrtWinBuild(vendor, ["x64"], receipts), false);
  writeFileSync(join(vendor, "srt-win", "x64", "srt-win.exe"), "tampered cache");
  assert.throws(() => canReuseSrtWinBuild(vendor, ["x64"], receipts), /integrity-mismatch/);
});
test("native baseline requires the exact inheritance assertion rather than a compilation failure", () => {
  const expected = { status: 101, stdout: "parent_fdc_is_object_only_and_round_trips FAILED", stderr:
    "assertion `left == right` failed\n left: [(1, 3, 64)]\n right: [(1, 0, 64)]" };
  assert.doesNotThrow(() => assertBaselineRegression(expected));
  for (const result of [{ ...expected, status: 0 }, { ...expected, stderr: "compilation failed" },
    { ...expected, stderr: expected.stderr.replace("(1, 3, 64)", "(1, 2, 64)") },
    { ...expected, error: new Error("spawn failed") }]) {
    assert.throws(() => assertBaselineRegression(result), /expected parent inheritance regression/);
  }
});
test("single architecture refresh omits stale trust for the other architecture", (t) => {
  const { vendor, receipts } = fixture(t);
  const directory = join(vendor, "generated");
  writeFileSync(join(vendor, "srt-win", "arm64", "build-receipt.json"),
    JSON.stringify({ ...receipts.arm64, nativePatchSha256: "f".repeat(64) }));
  const recorded = recordBuildReceipts(vendor, { x64: receipts.x64 }, directory);
  assert.deepEqual(Object.keys(recorded), ["x64"]);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "srt-win-build-receipts.json"))), recorded);
  assert.throws(() => assertSrtWinVendor(vendor, undefined, recorded), /integrity-mismatch/);
});
test("a partial refresh cannot promote a forged adjacent receipt into central trust", (t) => {
  const { vendor, receipts } = fixture(t);
  const generated = join(vendor, "generated");
  recordBuildReceipts(vendor, receipts, generated);
  const binary = Buffer.from("unbuilt replacement");
  const directory = join(vendor, "srt-win", "arm64");
  writeFileSync(join(directory, "srt-win.exe"), binary);
  writeFileSync(join(directory, "build-receipt.json"), JSON.stringify({ ...receipts.arm64, binarySha256: createHash("sha256").update(binary).digest("hex") }));
  assert.throws(() => recordBuildReceipts(vendor, { x64: receipts.x64 }, generated), /integrity-mismatch/);
});
test("a partial refresh omits an architecture without prior central trust", (t) => {
  const { vendor, receipts } = fixture(t);
  const recorded = recordBuildReceipts(vendor, { x64: receipts.x64 }, join(vendor, "generated"));
  assert.deepEqual(Object.keys(recorded), ["x64"]);
});
test("runtime bundling embeds generated receipts rather than reading a mutable runtime receipt", async () => {
  const { build } = await import("esbuild");
  const module = new URL("../../src/permissions/srt-win-integrity.ts", import.meta.url);
  const result = await build({ entryPoints: [fileURLToPath(module)], bundle: true, write: false, metafile: true,
    format: "esm", platform: "node", target: "node22", logLevel: "silent" });
  assert.ok(Object.keys(result.metafile.inputs).some((path) => path.endsWith("generated/srt-win-build-receipts.js")));
  assert.ok(Object.values(result.metafile.outputs).every((output) =>
    output.imports.every((entry) => !entry.path.includes("srt-win-build-receipts"))));
});
