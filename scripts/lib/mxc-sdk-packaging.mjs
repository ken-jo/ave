import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MxcIntegrityError, verifyMxcSdk, verifyMxcSupervisorRuntime } from "./mxc-sdk-integrity.mjs";
import PINS from "../../src/permissions/mxc-launcher-pins.json" with { type: "json" };

export function assertPackagedMxcSdk(resources, arch) {
  return withPackagingPayload(() => {
    const modules = path.join(resources, "app.asar.unpacked", "node_modules");
    if (existsSync(path.join(modules, "node-pty", "third_party"))) throw new Error("Unexpected packaged PTY source-build payload");
    const verified = verifyMxcSdk(modules, arch, PINS, {}, true);
    assertMxcSdkAddonArchitecture(modules, arch);
    if (existsSync(path.join(verified.sdkRoot, "node_modules", ".bin"))) throw new Error("Unexpected packaged SDK command shims");
    const bin = path.join(verified.sdkRoot, "bin");
    for (const entry of readdirSync(bin)) {
      if (entry !== arch) throw new Error(`Unexpected packaged SDK architecture: ${entry}`);
    }
    const allowed = new Set(["mxc_ffi.dll", "wslcsdk.dll"]);
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

export function prunePackagedMxcSdk(resources, arch) {
  return withPackagingPayload(() => {
    const modules = path.join(resources, "app.asar.unpacked", "node_modules");
    pruneMxcSdkAddonArchitectures(modules, arch);
    rmSync(path.join(modules, "@microsoft", "mxc-sdk", "node_modules", ".bin"), { recursive: true, force: true });
    const bin = path.join(resources, "app.asar.unpacked", "node_modules", "@microsoft", "mxc-sdk", "bin");
    for (const entry of readdirSync(bin)) {
      if (entry !== arch) rmSync(path.join(bin, entry), { recursive: true, force: true });
    }
    const directory = path.join(bin, arch);
    for (const entry of readdirSync(directory)) {
      if (!["mxc_ffi.dll", "wslcsdk.dll"].includes(entry)) rmSync(path.join(directory, entry), { recursive: true, force: true });
    }
    const addon = path.join(resources, "app.asar.unpacked", "node_modules", "@koromix", `koffi-win32-${arch}`, `win32_${arch}`);
    for (const entry of readdirSync(addon)) {
      if (/\.(lib|exp)$/i.test(entry)) rmSync(path.join(addon, entry));
    }
    assertPackagedMxcSdk(resources, arch);
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
export function pruneMxcSdkAddonArchitectures(modules, arch) {
  return withPackagingPayload(() => {
    if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported SDK addon architecture");
    const scope = path.join(modules, "@koromix");
    for (const name of readdirSync(scope)) {
      if (name.startsWith("koffi-win32-") && name !== `koffi-win32-${arch}`) rmSync(path.join(scope, name), { recursive: true, force: true });
    }
    assertMxcSdkAddonArchitecture(modules, arch);
  });
}

function assertMxcSdkAddonArchitecture(modules, arch) {
  const names = readdirSync(path.join(modules, "@koromix")).filter((name) => name.startsWith("koffi-win32-"));
  if (names.length !== 1 || names[0] !== `koffi-win32-${arch}`) throw new Error("Unexpected packaged SDK addon architecture");
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
