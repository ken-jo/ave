import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifyMxcSdk, verifyMxcSupervisorRuntime } from "./mxc-sdk-integrity.mjs";
import PINS from "../../src/permissions/mxc-launcher-pins.json" with { type: "json" };

export function assertPackagedMxcSdk(resources, arch) {
  const modules = path.join(resources, "app.asar.unpacked", "node_modules");
  const verified = verifyMxcSdk(modules, arch, PINS, {}, true);
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
}

export function prunePackagedMxcSdk(resources, arch) {
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
}

export function recordMxcSupervisorRuntime(resources, arch, executable) {
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
}
