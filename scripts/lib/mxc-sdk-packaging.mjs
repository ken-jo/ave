import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { verifyMxcSdk } from "./mxc-sdk-integrity.mjs";
import PINS from "../../src/permissions/mxc-launcher-pins.json" with { type: "json" };

export function assertPackagedMxcSdk(resources, arch) {
  const modules = path.join(resources, "app.asar.unpacked", "node_modules");
  const verified = verifyMxcSdk(modules, arch, PINS, {});
  const bin = path.join(verified.sdkRoot, "bin");
  for (const entry of readdirSync(bin)) {
    if (entry !== arch) throw new Error(`Unexpected packaged SDK architecture: ${entry}`);
  }
  const allowed = new Set(["mxc_ffi.dll", "wslcsdk.dll"]);
  for (const entry of readdirSync(path.join(bin, arch))) {
    if (!allowed.has(entry)) throw new Error(`Unexpected packaged SDK backend: ${entry}`);
  }
  for (const notice of ["LICENSE.md", "koffi-LICENSE.txt", "semver-LICENSE.txt", "node-pty-LICENSE.txt"]) {
    if (!existsSync(path.join(resources, "licenses", "mxc", notice))) throw new Error(`Native SDK notice missing: ${notice}`);
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
  assertPackagedMxcSdk(resources, arch);
}
