#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const pins = require("../src/permissions/srt-win-pins.json");
const { TARGETS, RECEIPTS_DIRECTORY, digest, readPlainFile, readBuildReceipts, readUpstreamSrtWinInput, assertBuildReceipt, assertSrtWinVendor, assertSrtWinBuildInputs, assertSrtWinReceiptModule } = require("./lib/srt-win-integrity.cjs");

export function parseBuildOptions(args) {
  const options = { arches: Object.keys(TARGETS), testNative: false, sourceArchive: undefined };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--test-native") options.testNative = true;
    else if (arg === "--arch") {
      const arch = args[++index];
      if (!Object.hasOwn(TARGETS, arch)) throw new Error("Unsupported helper architecture");
      options.arches = [arch];
    } else if (arg === "--source-archive") {
      const path = args[++index];
      if (!path) throw new Error("Missing source archive path");
      options.sourceArchive = resolve(path);
    } else throw new Error(`Unknown native helper build option: ${arg}`);
  }
  return options;
}
export function assertSourceArchive(bytes) {
  if (!/^[a-f0-9]{40}$/.test(pins.source.revision) || digest(bytes) !== pins.source.sha256 ||
      !pins.source.url.endsWith(`/tarball/${pins.source.revision}`)) throw new Error("srt-win-source-integrity-mismatch");
}
export function canReuseSrtWinBuild(vendor, arches, receipts = readBuildReceipts()) {
  let current = true;
  for (const arch of arches) {
    const directory = join(vendor, "srt-win", arch);
    const path = join(directory, "build-receipt.json");
    if (!existsSync(path)) { current = false; continue; }
    const receipt = JSON.parse(readPlainFile(path));
    // Corruption never becomes an implicit rebuild, even when an input pin also changed.
    if (digest(readPlainFile(join(directory, "srt-win.exe"))) !== receipt.binarySha256) {
      throw new Error(`srt-win-integrity-mismatch: ${arch}`);
    }
    try { assertBuildReceipt(receipt, arch); }
    catch { current = false; continue; }
    if (!Object.hasOwn(receipts, arch)) { current = false; continue; }
    try { assertBuildReceipt(receipts[arch], arch); }
    catch { current = false; continue; }
    assertSrtWinVendor(vendor, [arch], receipts);
  }
  return current;
}
export function assertBaselineRegression(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error || result.status !== 101 || !output.includes("parent_fdc_is_object_only_and_round_trips") ||
      !output.includes("assertion `left == right` failed") || !/left:\s*\[\(1, 3, 64\)\]/.test(output) ||
      !/right:\s*\[\(1, 0, 64\)\]/.test(output)) {
    throw new Error("Native baseline did not demonstrate the expected parent inheritance regression");
  }
}
function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native helper command failed: ${command} (${result.status})`);
  return result;
}
function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  let created = false;
  try {
    const descriptor = openSync(temporary, "wx");
    created = true;
    try { writeFileSync(descriptor, contents); }
    finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } finally { if (created) rmSync(temporary, { force: true }); }
}
export function retainUpstreamSrtWinInputs(vendor, arches) {
  for (const arch of arches) {
    const bytes = readUpstreamSrtWinInput(vendor, arch);
    const retained = join(vendor, "srt-win", arch, "upstream-srt-win.exe");
    if (lstatSync(retained, { throwIfNoEntry: false }) === undefined) {
      writeFileSync(retained, bytes, { flag: "wx" });
      readUpstreamSrtWinInput(vendor, arch);
    }
  }
}
export function publishSrtWinExecutable(vendor, arch, bytes) {
  if (!Object.hasOwn(TARGETS, arch)) throw new Error("Unsupported helper architecture");
  // Replacement breaks package-cache hardlinks instead of mutating their shared inode.
  atomicWrite(join(vendor, "srt-win", arch, "srt-win.exe"), bytes);
}
export function recordBuildReceipts(vendor, newReceipts, receiptsDirectory = RECEIPTS_DIRECTORY) {
  const previousPath = join(receiptsDirectory, "srt-win-build-receipts.json");
  const previous = existsSync(previousPath) ? JSON.parse(readPlainFile(previousPath)) : {};
  const receipts = {};
  for (const arch of Object.keys(TARGETS)) {
    const path = join(vendor, "srt-win", arch, "build-receipt.json");
    if (!Object.hasOwn(newReceipts, arch) && !existsSync(path)) continue;
    // Only this build or a previously trusted central entry can supply a hash.
    if (!Object.hasOwn(newReceipts, arch) && !Object.hasOwn(previous, arch)) continue;
    const receipt = newReceipts[arch] ?? JSON.parse(readPlainFile(path));
    if (digest(readPlainFile(join(vendor, "srt-win", arch, "srt-win.exe"))) !== receipt.binarySha256) {
      throw new Error(`srt-win-integrity-mismatch: ${arch}`);
    }
    try { assertBuildReceipt(receipt, arch); }
    catch (error) {
      if (Object.hasOwn(newReceipts, arch)) throw error;
      // A separately requested architecture may still carry an older build; omit its trust entry.
      continue;
    }
    if (!Object.hasOwn(newReceipts, arch)) assertSrtWinVendor(vendor, [arch], previous);
    receipts[arch] = receipt;
  }
  const json = JSON.stringify(receipts, null, 2);
  atomicWrite(join(receiptsDirectory, "srt-win-build-receipts.json"), `${json}\n`);
  atomicWrite(join(receiptsDirectory, "srt-win-build-receipts.js"), `// Generated by build-srt-win.mjs.\nexport default ${json};\n`);
  return receipts;
}
export async function buildSrtWin(options) {
  if (process.platform !== "win32") throw new Error("Native helper builds require Windows");
  require("./prepare-srt-win-receipts.cjs").prepareSrtWinReceipts();
  const vendor = join(dirname(require.resolve(`${pins.package}/package.json`)), "vendor");
  assertSrtWinBuildInputs(vendor);
  if (options.testNative && !options.arches.includes(process.arch)) throw new Error("Native tests require the host architecture");
  retainUpstreamSrtWinInputs(vendor, options.arches);
  if (!options.testNative && !options.sourceArchive) {
    assertSrtWinReceiptModule();
    if (canReuseSrtWinBuild(vendor, options.arches)) {
      console.log(`srt-win: reusing verified native build for ${options.arches.join(", ")}`);
      return;
    }
  }
  const patch = readPlainFile(join(vendor, "srt-win", "persistent-denies.patch"));
  const scratch = mkdtempSync(join(tmpdir(), "ave-srt-native-build-"));
  try {
    let archive;
    if (options.sourceArchive) archive = readPlainFile(options.sourceArchive);
    else {
      const response = await fetch(pins.source.url, { headers: { "User-Agent": "ave-native-build" } });
      if (!response.ok) throw new Error(`Native source download failed: ${response.status}`);
      archive = Buffer.from(await response.arrayBuffer());
    }
    assertSourceArchive(archive);
    const archivePath = join(scratch, "source.tar.gz");
    writeFileSync(archivePath, archive, { flag: "wx" });
    const extracted = join(scratch, "source");
    mkdirSync(extracted);
    run("tar.exe", ["-xzf", archivePath, "--strip-components=1", "-C", extracted], scratch);
    // The immutable archive hash authenticates the complete source tree before patching.
    const source = join(extracted, "vendor", "srt-win-src");
    if (!existsSync(join(source, "Cargo.lock"))) throw new Error("Native source lockfile is missing");
    const toolchain = readFileSync(join(extracted, "rust-toolchain.toml"), "utf8");
    if (!toolchain.includes(`channel = "${pins.rustToolchain}"`)) throw new Error("Native source toolchain mismatch");
    const baseline = join(scratch, "baseline");
    if (options.testNative) cpSync(source, baseline, { recursive: true });
    const patchPath = join(scratch, "persistent-denies.patch");
    writeFileSync(patchPath, patch, { flag: "wx" });
    run("git", ["-C", extracted, "apply", "--check", "--whitespace=error-all", patchPath], extracted);
    run("git", ["-C", extracted, "apply", "--whitespace=error-all", patchPath], extracted);
    run("rustup", ["toolchain", "install", pins.rustToolchain, "--profile", "minimal"], extracted);
    if (options.testNative) {
      const target = TARGETS[process.arch];
      run("rustup", ["target", "add", "--toolchain", pins.rustToolchain, target], extracted);
      copyFileSync(join(source, "tests", "acl_parent_scope.rs"), join(baseline, "tests", "acl_parent_scope.rs"));
      const result = spawnSync("cargo", [`+${pins.rustToolchain}`, "test", "--release", "--locked", "--manifest-path",
        join(baseline, "Cargo.toml"), "--target", target, "--test", "acl_parent_scope",
        "parent_fdc_is_object_only_and_round_trips", "--", "--exact", "--nocapture"],
      { cwd: extracted, encoding: "utf8", windowsHide: true });
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      assertBaselineRegression(result);
      console.log("srt-win: pristine source demonstrates parent inheritance regression");
    }
    const receipts = {};
    for (const arch of options.arches) {
      const target = TARGETS[arch];
      run("rustup", ["target", "add", "--toolchain", pins.rustToolchain, target], extracted);
      const cargoArgs = [`+${pins.rustToolchain}`, "--release", "--locked", "--manifest-path", join(source, "Cargo.toml"), "--target", target];
      run("cargo", [cargoArgs[0], "build", ...cargoArgs.slice(1)], extracted);
      if (options.testNative && arch === process.arch) run("cargo", [cargoArgs[0], "test", "--no-fail-fast", ...cargoArgs.slice(1), "--", "--nocapture"], extracted);
      const binary = join(source, "target", target, "release", "srt-win.exe");
      const bytes = readPlainFile(binary);
      receipts[arch] = { schemaVersion: 1, sourceRevision: pins.source.revision, sourceArchiveSha256: pins.source.sha256,
        nativePatchSha256: pins.nativePatchSha256, rustToolchain: pins.rustToolchain, target, binarySha256: digest(bytes) };
      const directory = join(vendor, "srt-win", arch);
      mkdirSync(directory, { recursive: true });
      publishSrtWinExecutable(vendor, arch, bytes);
      atomicWrite(join(directory, "build-receipt.json"), `${JSON.stringify(receipts[arch], null, 2)}\n`);
    }
    const complete = recordBuildReceipts(vendor, receipts);
    assertSrtWinVendor(vendor, options.arches, complete);
    console.log(`srt-win: built and verified ${options.arches.join(", ")}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildSrtWin(parseBuildOptions(process.argv.slice(2)));
