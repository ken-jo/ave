const { createHash } = require("node:crypto");
const { existsSync, readFileSync, readdirSync, rmSync, statSync } = require("node:fs");
const { constants: fsConstants, accessSync, chmodSync } = require("node:fs");
const { join } = require("node:path");
const { gunzipSync } = require("node:zlib");
const { assertGraphicsRuntimeFiles } = require("./lib/graphics-runtime-files.cjs");
const { assertSandboxRuntimeFiles } = require("./lib/sandbox-runtime-files.cjs");
const { assertSrtWinVendor } = require("./lib/srt-win-integrity.cjs");
const { assertImageRuntimeFiles } = require("./lib/image-runtime-files.cjs");
const { assertRipgrepRuntimeFiles, RIPGREP_LICENSE_NOTICES } = require("./lib/ripgrep-runtime-files.cjs");
const { assertCanvasRuntimeFiles, assertPdfRuntimeEntries, assertPdfUnpackedData, PAGE_RENDERER_LICENSE_NOTICES } = require("./lib/page-runtime-files.cjs");

// Map the packager's numeric architecture enum to native artifact directory names.
const ARCH_DIR_BY_ENUM = { 1: "x64", 3: "arm64" };

function electronResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    const productFilename = context.packager.appInfo.productFilename;
    return join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources");
  }
  return join(context.appOutDir, "resources");
}

function assertBundledUvResource(context) {
  const resourcesDir = electronResourcesDir(context);
  const uvDir = join(resourcesDir, "uv");
  if (!existsSync(uvDir)) {
    throw new Error(`packaged uv resource missing: ${uvDir}`);
  }

  const uvTargets = readdirSync(uvDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (uvTargets.length !== 1) {
    throw new Error(`packaged uv resource must contain exactly one target; found ${uvTargets.join(", ")}`);
  }

  const uvTarget = uvTargets[0];
  const expectedPrefix = context.electronPlatformName === "win32" ? "win32-" : `${context.electronPlatformName}-`;
  if (!uvTarget.startsWith(expectedPrefix)) {
    throw new Error(`packaged uv target ${uvTarget} does not match ${context.electronPlatformName}`);
  }

  const uvTargetDir = join(uvDir, uvTarget);
  const uvBin = uvTarget.startsWith("win32-") ? "uv.exe" : "uv";
  const uvFiles = new Set(readdirSync(uvTargetDir));
  if (uvFiles.has(uvBin)) {
    throw new Error(`raw uv binary leaked into package: ${join(uvTargetDir, uvBin)}`);
  }
  if (!uvFiles.has(`${uvBin}.gz`)) {
    throw new Error(`compressed uv archive missing: ${join(uvTargetDir, `${uvBin}.gz`)}`);
  }
  if (!uvFiles.has("uv.meta.json")) {
    throw new Error(`packaged uv metadata missing: ${join(uvTargetDir, "uv.meta.json")}`);
  }
  const metaPath = join(uvTargetDir, "uv.meta.json");
  const compressedBin = join(uvTargetDir, `${uvBin}.gz`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (typeof meta.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.binarySha256)) {
    throw new Error(`packaged uv metadata has invalid binarySha256: ${metaPath}`);
  }
  const actualBinarySha256 = sha256Hex(gunzipSync(readFileSync(compressedBin)));
  if (actualBinarySha256 !== meta.binarySha256) {
    throw new Error(
      `packaged uv binary SHA mismatch: expected ${meta.binarySha256}, got ${actualBinarySha256}: ${compressedBin}`,
    );
  }

  const uvLicense = join(resourcesDir, "licenses", "uv", "LICENSE-MIT");
  if (!existsSync(uvLicense)) {
    throw new Error(`uv license notice missing: ${uvLicense}`);
  }
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Prune vendor binaries after unpacking: per-platform file arrays replace the root allow-list.
// Assert that target executables remain and foreign-platform binaries are absent.
function assertSandboxVendorBinaries(context) {
  const platform = context.electronPlatformName;
  const resourcesDir = electronResourcesDir(context);
  const vendorDir = join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "@anthropic-ai",
    "sandbox-runtime",
    "vendor",
  );

  // Check the packed architecture; unknown architectures scan all vendor directories.
  const arch = ARCH_DIR_BY_ENUM[context.arch] ?? null;
  const matrix = {
    win32: { keep: { dir: "srt-win", binary: "srt-win.exe" }, prune: ["seccomp"] },
    linux: { keep: { dir: "seccomp", binary: "apply-seccomp" }, prune: ["srt-win"] },
    darwin: { keep: null, prune: ["srt-win", "seccomp"] },
  };
  const spec = matrix[platform];
  if (!spec) return;

  for (const pruned of spec.prune) {
    const prunedDir = join(vendorDir, pruned);
    rmSync(prunedDir, { recursive: true, force: true });
    if (existsSync(prunedDir)) {
      throw new Error(
        `packaged sandbox-runtime vendor binary not pruned for ${platform}: ${prunedDir} should be absent`,
      );
    }
  }

  assertSandboxRuntimeFiles(vendorDir, platform);
  if (platform === "win32") {
    // Check every shipped image, including an architecture the host cannot execute.
    assertSrtWinVendor(vendorDir, readdirSync(join(vendorDir, "srt-win")));
  }

  if (!spec.keep) return;

  const keepRoot = join(vendorDir, spec.keep.dir);
  if (!existsSync(keepRoot)) {
    throw new Error(
      `packaged sandbox-runtime vendor binary missing for ${platform}: ${keepRoot} (kept binary directory absent)`,
    );
  }
  // Keep only the packed architecture; foreign executables fail package architecture audits.
  if (arch) {
    for (const archDir of readdirSync(keepRoot)) {
      if (archDir !== arch) rmSync(join(keepRoot, archDir), { recursive: true, force: true });
    }
  }
  const archDirs = arch ? [arch] : readdirSync(keepRoot);
  let found = false;
  for (const archDir of archDirs) {
    const binPath = join(keepRoot, archDir, spec.keep.binary);
    if (!existsSync(binPath)) continue;
    found = true;
    const mode = statSync(binPath).mode;
    // Windows requires a regular non-empty file; POSIX also requires owner execute permission.
    if (platform === "win32") {
      if (statSync(binPath).size === 0) {
        throw new Error(`packaged srt-win binary is empty: ${binPath}`);
      }
    } else {
      try {
        accessSync(binPath, fsConstants.X_OK);
      } catch {
        throw new Error(
          `packaged sandbox-runtime vendor binary not executable for ${platform}: ${binPath} (mode ${(mode & 0o777).toString(8)})`,
        );
      }
    }
  }
  if (!found) {
    throw new Error(
      `packaged sandbox-runtime vendor binary missing for ${platform}: ${spec.keep.binary} under ${keepRoot} (arch dirs: ${archDirs.join(", ")})`,
    );
  }
}

// Resolve the binding directory in loader order; available prebuilds need no ABI-specific rebuild.
function resolveNodePtyBindingDir(context) {
  const platform = context.electronPlatformName;
  const ptyModuleRoot = join(
    electronResourcesDir(context),
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
  );
  const arch = ARCH_DIR_BY_ENUM[context.arch];
  if (!arch) {
    throw new Error(
      `packaged node-pty binding: unsupported arch enum ${context.arch} for ${platform}`,
    );
  }
  const searchDirs = [
    join(ptyModuleRoot, "build", "Release"),
    join(ptyModuleRoot, "build", "Debug"),
    join(ptyModuleRoot, "prebuilds", `${platform}-${arch}`),
  ];
  const resolved = searchDirs.find((dir) => existsSync(join(dir, "pty.node")));
  if (!resolved) {
    throw new Error(
      `packaged node-pty native addon missing: no pty.node in ${searchDirs.join(", ")} `
      + `(asarUnpack of node_modules/node-pty/** drifted?)`,
    );
  }
  return resolved;
}

// Keep only the target prebuild; platforms compiling locally must not ship foreign binaries.
function pruneForeignNodePtyPrebuilds(context) {
  const arch = ARCH_DIR_BY_ENUM[context.arch];
  if (!arch) return;
  const prebuildsDir = join(electronResourcesDir(context), "app.asar.unpacked", "node_modules", "node-pty", "prebuilds");
  if (!existsSync(prebuildsDir)) return;
  const keep = `${context.electronPlatformName}-${arch}`;
  for (const entry of readdirSync(prebuildsDir)) {
    if (entry !== keep) rmSync(join(prebuildsDir, entry), { recursive: true, force: true });
  }
}

// Assert native addons and required helpers in the loader-resolved unpacked directory.
function assertNodePtyBinary(context) {
  const platform = context.electronPlatformName;
  pruneForeignNodePtyPrebuilds(context);
  const ptyRoot = resolveNodePtyBindingDir(context);
  const requiredNativeFiles = platform === "win32"
    ? [
        "pty.node",
        "conpty.node",
        "conpty_console_list.node",
        "winpty.dll",
        "winpty-agent.exe",
      ]
    : ["pty.node"];
  for (const file of requiredNativeFiles) {
    const nodeAddon = join(ptyRoot, file);
    if (!existsSync(nodeAddon)) {
      throw new Error(
        `packaged node-pty native addon missing: ${nodeAddon} (asarUnpack of node_modules/node-pty/** drifted?)`,
      );
    }
    if (statSync(nodeAddon).size === 0) {
      throw new Error(`packaged node-pty native addon is empty: ${nodeAddon}`);
    }
  }
  // Only macOS requires spawn-helper to set the controlling terminal; Linux uses forkpty directly.
  if (platform === "darwin") {
    const helper = join(ptyRoot, "spawn-helper");
    if (!existsSync(helper)) {
      throw new Error(
        `packaged node-pty spawn-helper missing for ${platform}: ${helper}`,
      );
    }
    // Published prebuild helpers may lack execute permission; packaging must set it before asserting.
    try {
      chmodSync(helper, 0o755);
    } catch (err) {
      throw new Error(
        `packaged node-pty spawn-helper could not be made executable for ${platform}: ${helper} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    try {
      accessSync(helper, fsConstants.X_OK);
    } catch {
      throw new Error(
        `packaged node-pty spawn-helper not executable for ${platform}: ${helper} (mode ${(statSync(helper).mode & 0o777).toString(8)})`,
      );
    }
  }
}

// Native database bindings must remain unpacked and match the target platform and architecture.
// Keep only the prebuild the runtime loads.
function assertBetterSqlite3Binary(context) {
  const platform = context.electronPlatformName;
  const win = platform === "win32";
  const platformPrefix = platform === "darwin" ? "darwin" : win ? "win32" : "linux";
  const arch = ARCH_DIR_BY_ENUM[context.arch];
  if (!arch) {
    throw new Error(
      `packaged better-sqlite3 prebuild: unsupported arch enum ${context.arch} for ${platform}`,
    );
  }
  const targetFile = `${platformPrefix}-${arch}.node`;

  const resourcesDir = electronResourcesDir(context);
  const prebuildsDir = join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "prebuilds",
  );
  const prebuild = join(prebuildsDir, targetFile);
  if (!existsSync(prebuild)) {
    throw new Error(
      `packaged better-sqlite3 prebuild missing: ${prebuild} (asarUnpack of node_modules/better-sqlite3/** drifted?)`,
    );
  }
  if (statSync(prebuild).size === 0) {
    throw new Error(`packaged better-sqlite3 prebuild is empty: ${prebuild}`);
  }

  // Drop prebuilds this target cannot load.
  if (existsSync(prebuildsDir)) {
    for (const entry of readdirSync(prebuildsDir)) {
      if (entry === targetFile) continue;
      rmSync(join(prebuildsDir, entry), { recursive: true, force: true });
    }
  }

  // Assert the target survived pruning.
  if (!existsSync(prebuild) || statSync(prebuild).size === 0) {
    throw new Error(`packaged better-sqlite3 prebuild was pruned away: ${prebuild}`);
  }
}

module.exports = async function afterPack(context) {
  assertBundledUvResource(context);
  assertSandboxVendorBinaries(context);
  assertNodePtyBinary(context);
  assertBetterSqlite3Binary(context);
  assertImageRuntimeFiles(join(electronResourcesDir(context), "app.asar.unpacked", "node_modules"), context.electronPlatformName, ARCH_DIR_BY_ENUM[context.arch]);
  assertRipgrepRuntimeFiles(join(electronResourcesDir(context), "app.asar.unpacked", "node_modules"), context.electronPlatformName, ARCH_DIR_BY_ENUM[context.arch]);
  for (const notice of RIPGREP_LICENSE_NOTICES) {
    const path = join(electronResourcesDir(context), "licenses", "ripgrep", notice);
    if (!existsSync(path)) throw new Error(`ripgrep license notice missing: ${path}`);
  }
  assertCanvasRuntimeFiles(join(electronResourcesDir(context), "app.asar.unpacked", "node_modules"), context.electronPlatformName, ARCH_DIR_BY_ENUM[context.arch]);
  assertPdfUnpackedData(join(electronResourcesDir(context), "app.asar.unpacked", "node_modules"));
  const { listPackage } = await import("@electron/asar");
  // Read the archive itself, not Electron's archive redirection, when this runs under Electron.
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    assertPdfRuntimeEntries(listPackage(join(electronResourcesDir(context), "app.asar")));
  } finally {
    process.noAsar = previousNoAsar;
  }
  for (const notice of PAGE_RENDERER_LICENSE_NOTICES) {
    const path = join(electronResourcesDir(context), "licenses", "canvas", notice);
    if (!existsSync(path)) throw new Error(`page renderer license notice missing: ${path}`);
  }

  let libraryDirectory = context.appOutDir;
  if (context.electronPlatformName === "darwin") {
    const productFilename = context.packager.appInfo.productFilename;
    libraryDirectory = join(
      context.appOutDir,
      `${productFilename}.app`,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Libraries",
    );
  }
  assertGraphicsRuntimeFiles(libraryDirectory, context.electronPlatformName);
  if (context.electronPlatformName === "win32") {
    const { finalizePackagedMxcSdk } = await import("./lib/mxc-sdk-packaging.mjs");
    finalizePackagedMxcSdk(electronResourcesDir(context), ARCH_DIR_BY_ENUM[context.arch], join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`));
  } else {
    rmSync(join(electronResourcesDir(context), "app.asar.unpacked", "node_modules", "@microsoft", "mxc-sdk", "bin"), { recursive: true, force: true });
  }
};
