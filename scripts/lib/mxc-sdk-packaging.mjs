import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MxcIntegrityError, PTY_SOURCE_BUILD_DIRECTORIES, SDK_INSTALLATION_AUXILIARIES, verifyMxcSdk, verifyMxcSupervisorRuntime } from "./mxc-sdk-integrity.mjs";
import PINS from "../../src/permissions/mxc-launcher-pins.json" with { type: "json" };
import LINUX_FILTER_PINS from "../../src/permissions/mxc-linux-seccomp-pins.json" with { type: "json" };
import { mxcLauncherForTarget } from "../fetch-mxc.mjs";

export function assertPackagedLauncher(resources, target) {
  const pin = mxcLauncherForTarget(target);
  const directory = path.join(resources, "mxc", pin.arch);
  const file = path.join(directory, pin.name);
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry?.isFile()) throw new Error(`Packaged launcher missing or not a regular file: ${file}`);
  if (realpathSync(directory) !== path.resolve(directory)) throw new Error(`Packaged launcher directory redirected: ${directory}`);
  const entries = readdirSync(directory);
  const expected = pin.platform === "win32" ? [pin.name, "supervisor-runtime-pins.json"] : [pin.name];
  if (entries.some((name) => !expected.includes(name))) throw new Error(`Unexpected packaged launcher entry: ${directory}`);
  if (pin.platform !== "win32" && (entry.mode & 0o111) !== 0o111) throw new Error(`Packaged launcher is not executable: ${file}`);
  if (createHash("sha256").update(readFileSync(file)).digest("hex") !== pin.sha256) {
    throw new Error(`Packaged launcher hash mismatch: ${file}`);
  }
}

export function stagePackagedLinuxShellFilter(resources, arch) {
  if (!Object.hasOwn(LINUX_FILTER_PINS, arch)) throw new Error(`Unsupported Linux shell filter architecture: ${arch}`);
  const source = new URL("../../resources/", import.meta.url);
  const relative = `linux-shell-seccomp/${arch}/apply-seccomp`;
  const packaged = path.join(resources, relative);
  mkdirSync(path.dirname(packaged), { recursive: true });
  copyFileSync(new URL(relative, source), packaged);
  const entry = lstatSync(packaged);
  if (!entry.isFile() || (entry.mode & 0o111) !== 0o111
    || createHash("sha256").update(readFileSync(packaged)).digest("hex") !== LINUX_FILTER_PINS[arch]) {
    throw new Error(`Packaged Linux shell filter does not match its ${arch} pin`);
  }
  cpSync(new URL("licenses/linux-shell-seccomp/", source), path.join(resources, "licenses", "linux-shell-seccomp"), { recursive: true });
}

export function finalizePackagedMxcSdk(resources, arch, executable) {
  prunePackagedMxcSdk(resources, arch);
  recordMxcSupervisorRuntime(resources, arch, executable);
}

export function assertPackagedMxcSdk(resources, arch, platform = "win32", verifyAddonBytes = false) {
  return withPackagingPayload(() => {
    const modules = path.join(resources, "app.asar.unpacked", "node_modules");
    if (platform === "win32" && existsSync(path.join(modules, "node-pty", "third_party"))) throw new Error("Unexpected packaged PTY source-build payload");
    const verified = verifyMxcSdk(modules, arch, PINS, {}, true, platform, verifyAddonBytes);
    assertMxcSdkAddonArchitecture(modules, arch, platform);
    if (existsSync(path.join(verified.sdkRoot, "node_modules", ".bin"))) throw new Error("Unexpected packaged SDK command shims");
    const bin = path.join(verified.sdkRoot, "bin");
    for (const entry of readdirSync(bin)) {
      if (entry !== arch) throw new Error(`Unexpected packaged SDK architecture: ${entry}`);
    }
    const allowed = new Set(platform === "darwin" ? [path.basename(PINS.targets["darwin-arm64"].library.member)] : ["mxc_ffi.dll", "wslcsdk.dll"]);
    for (const entry of readdirSync(path.join(bin, arch))) {
      if (!allowed.has(entry)) throw new Error(`Unexpected packaged SDK backend: ${entry}`);
    }
    for (const [notice, expected] of Object.entries({ "LICENSE.md": PINS.licenseSha256, ...PINS.sdk.notices })) {
      const bytes = readFileSync(path.join(resources, "licenses", "mxc", notice));
      if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Native SDK notice mismatch: ${notice}`);
    }
    return verified;
  });
}

export function prunePackagedMxcSdk(resources, arch, platform = "win32") {
  return withPackagingPayload(() => {
    assertMutationTreesSafe(resources, [
      "app.asar.unpacked/node_modules/@koromix",
      "app.asar.unpacked/node_modules/@microsoft/mxc-sdk",
      "app.asar.unpacked/node_modules/node-pty",
    ], PTY_SOURCE_BUILD_DIRECTORIES.map((name) => `app.asar.unpacked/node_modules/node-pty/${name}`));
    const modules = path.join(resources, "app.asar.unpacked", "node_modules");
    pruneMxcSdkAddonArchitectures(modules, arch, platform);
    rmSync(path.join(modules, "@microsoft", "mxc-sdk", "node_modules", ".bin"), { recursive: true, force: true });
    const bin = path.join(resources, "app.asar.unpacked", "node_modules", "@microsoft", "mxc-sdk", "bin");
    for (const entry of readdirSync(bin)) {
      if (["x64", "arm64"].includes(entry) && entry !== arch) rmSync(path.join(bin, entry), { recursive: true, force: true });
    }
    const directory = path.join(bin, arch);
    const darwinLibrary = path.basename(PINS.targets["darwin-arm64"].library.member);
    for (const entry of readdirSync(directory)) {
      if (platform === "darwin" && entry === darwinLibrary) continue;
      const foreignLibrary = platform === "darwin" && ["mxc_ffi.dll", "wslcsdk.dll"].includes(entry);
      if (foreignLibrary || SDK_INSTALLATION_AUXILIARIES.has(entry) || ["dotnet", "_manifest"].includes(entry)) rmSync(path.join(directory, entry), { recursive: true, force: true });
    }
    if (platform === "win32") {
      const addon = path.join(modules, "@koromix", `koffi-win32-${arch}`, `win32_${arch}`);
      for (const entry of readdirSync(addon)) {
        if (/\.(lib|exp)$/i.test(entry)) rmSync(path.join(addon, entry));
      }
      pruneMxcPtyBuildPayloads(modules, arch);
    }
    assertPackagedMxcSdk(resources, arch, platform, true);
  });
}

export function recordMxcSupervisorRuntime(resources, arch, executable) {
  return withPackagingPayload(() => {
    const directory = path.dirname(executable);
    const names = readdirSync(directory).filter((name) => /\.dll$/i.test(name));
    names.push(path.basename(executable));
    const files = Object.fromEntries(names.sort().map((name) => [name,
      createHash("sha256").update(readFileSync(path.join(directory, name))).digest("hex"),
    ]));
    const target = path.join(resources, "mxc", arch, "supervisor-runtime-pins.json");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ version: 1, arch, files }, null, 2) + "\n");
    verifyMxcSupervisorRuntime(executable, resources, arch);
  });
}

// Staging is idempotent in the checkout. Package output must contain only the
// selected target even after sequential cross-architecture builds.
export function pruneMxcSdkAddonArchitectures(modules, arch, platform = "win32") {
  return withPackagingPayload(() => {
    if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported SDK addon architecture");
    assertMutationTreesSafe(modules, ["@koromix"]);
    const scope = path.join(modules, "@koromix");
    for (const name of readdirSync(scope)) {
      if (name.startsWith(`koffi-${platform}-`) && name !== `koffi-${platform}-${arch}`) rmSync(path.join(scope, name), { recursive: true, force: true });
    }
    assertMxcSdkAddonArchitecture(modules, arch, platform);
  });
}

function assertMxcSdkAddonArchitecture(modules, arch, platform) {
  const names = readdirSync(path.join(modules, "@koromix")).filter((name) => name.startsWith(`koffi-${platform}-`));
  if (names.length !== 1 || names[0] !== `koffi-${platform}-${arch}`) throw new Error("Unexpected packaged SDK addon architecture");
}

export function assertPackagedMxcMacLibrary(resources) {
  const { member, sha256 } = PINS.targets["darwin-arm64"].library;
  const file = path.join(resources, "app.asar.unpacked", "node_modules", PINS.package, member);
  if (realpathSync(file) !== path.resolve(file) || !lstatSync(file).isFile()) throw new Error("Packaged native library path redirected");
  if (createHash("sha256").update(readFileSync(file)).digest("hex") !== sha256) throw new Error("Packaged native library hash mismatch");
}

export function assertMxcSupervisorFuse(config) {
  if (config.electronFuses?.runAsNode !== true) throw new Error("Extension supervisor requires the RunAsNode fuse");
}

function withPackagingPayload(operation) {
  try {
    return operation();
  } catch (error) {
    const missing = error instanceof MxcIntegrityError ? error.cause : error;
    if (missing?.code === "ENOENT") {
      const message = `Native SDK packaging payload missing: ${missing.path}`;
      if (error instanceof MxcIntegrityError && error.message === message) throw error;
      throw new MxcIntegrityError(message, { cause: error });
    }
    throw error;
  }
}

// Source trees and locally rebuilt addons are not Windows runtime payloads.
export function pruneMxcPtyBuildPayloads(modules, arch) {
  if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported SDK addon architecture");
  assertMutationTreesSafe(modules, ["node-pty"], PTY_SOURCE_BUILD_DIRECTORIES.map((name) => `node-pty/${name}`));
  const root = path.join(modules, "node-pty");
  // Empty patch-install markers are package-manager bookkeeping, never runtime inputs.
  for (const name of readdirSync(root)) {
    if (name.length !== 25 || !/^\.bun-tag-[0-9a-f]{16}$/.test(name)) continue;
    const file = path.join(root, name), entry = lstatSync(file);
    if (entry.isFile() && entry.size === 0) rmSync(file);
  }
  for (const name of PTY_SOURCE_BUILD_DIRECTORIES) rmSync(path.join(root, name), { recursive: true, force: true });
  const prebuilds = path.join(root, "prebuilds");
  for (const name of readdirSync(prebuilds)) {
    if (/^(?:darwin|linux|win32)-(?:x64|arm64)$/.test(name) && name !== `win32-${arch}`) {
      rmSync(path.join(prebuilds, name), { recursive: true, force: true });
    }
  }
  const pruneSymbols = (directory) => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name), entry = lstatSync(file);
      if (entry.isDirectory()) pruneSymbols(file);
      else if (entry.isFile() && name.endsWith(".pdb")) rmSync(file);
    }
  };
  pruneSymbols(path.join(prebuilds, `win32-${arch}`));
}

// Inspect retained subtrees and each whole-deletion root before mutation. A
// recursive removal unlinks internal symlinks without traversing their targets.
// Missing paths keep the owning operation's exact-path diagnostics.
function assertMutationTreesSafe(base, relatives, wholeDeletionRoots = []) {
  const opaque = new Set(wholeDeletionRoots.map((relative) => path.join(base, ...relative.split("/"))));
  const inspect = (file) => {
    let entry;
    try { entry = lstatSync(file); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (entry.isSymbolicLink()) throw new MxcIntegrityError(`Packaging mutation path redirected: ${file}`);
    return entry;
  };
  const walk = (file) => {
    const entry = inspect(file);
    if (entry?.isDirectory() && !opaque.has(file)) for (const name of readdirSync(file)) walk(path.join(file, name));
  };
  if (inspect(base) && realpathSync(base) !== path.resolve(base)) {
    throw new MxcIntegrityError(`Packaging mutation path redirected: ${base}`);
  }
  for (const relative of relatives) {
    const segments = relative.split("/");
    let ancestor = base;
    for (const segment of segments) {
      ancestor = path.join(ancestor, segment);
      if (!inspect(ancestor)) break;
    }
    walk(path.join(base, ...segments));
  }
}
