import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PINS from "../../permissions/mxc-launcher-pins.json" with { type: "json" };
import type { ContainerTarget } from "../../shared/container-platform.js";
import { contentHash } from "./content-hash.js";

const DARWIN_ADDON = "@koromix/koffi-darwin-arm64/";

/**
 * Copy the macOS shell SDK payload into `modules`: every pinned SDK file, the darwin koffi addon and the shell library.
 * A host without the darwin addon gets inert stand-in bytes, re-pinned in the returned pins; the real JS, manifests and
 * library keep their production hashes.
 */
function copyMxcMacSdkPayload(modules: string): { pins: typeof PINS; substituted: boolean } {
  const project = fileURLToPath(new URL("../../../", import.meta.url));
  const installed = join(project, "node_modules");
  const pins = structuredClone(PINS);
  const substituted = !existsSync(join(installed, DARWIN_ADDON));
  const library = `${PINS.package}/${PINS.targets["darwin-arm64"].library.member}`;
  for (const relative of [...Object.keys({ ...pins.sdk.files, ...pins.sdk.darwinFiles }), library]) {
    if (substituted && relative.startsWith(DARWIN_ADDON)) continue;
    const target = join(modules, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(installed, relative), target);
  }
  if (substituted) {
    for (const [relative, bytes] of Object.entries({
      "package.json": JSON.stringify(pins.sdk.packageMetadata[`${DARWIN_ADDON}package.json`]),
      "index.js": "throw new Error('Packaging fixture must never execute');\n",
      "darwin_arm64/koffi.node": "inert packaging addon fixture",
    })) {
      const target = join(modules, DARWIN_ADDON, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      (pins.sdk.darwinFiles as Record<string, string>)[DARWIN_ADDON + relative] = contentHash(bytes);
    }
  }
  return { pins, substituted };
}

/**
 * Copy the installed package inputs and notice for a before-pack fixture without network access: the launcher for
 * Windows and Linux, the shell SDK payload for macOS, which ships no launcher.
 */
export function copyMxcLauncherPackageInputs(projectRoot: string, target: ContainerTarget): void {
  const project = fileURLToPath(new URL("../../../", import.meta.url));
  const inputs = ["resources/licenses/mxc/LICENSE.md"];
  if (target === "darwin-arm64") {
    if (copyMxcMacSdkPayload(join(projectRoot, "node_modules")).substituted) {
      throw new Error("macOS before-pack inputs need the installed darwin koffi addon");
    }
  } else {
    inputs.push(join("node_modules", PINS.package, PINS.targets[target].launcher.member));
  }
  for (const relative of inputs) {
    const destination = join(projectRoot, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(project, relative), destination);
  }
}

/** Hash-verification fixture only; no addon or SDK code is executed. */
export function writeMxcRuntimePackage(resources: string, executable: string): string {
  const project = fileURLToPath(new URL("../../../", import.meta.url));
  const installed = join(project, "node_modules");
  const modules = join(resources, "app.asar.unpacked", "node_modules");
  const pins = structuredClone(PINS);
  const addon = "@koromix/koffi-win32-x64/";
  const substituted = !existsSync(join(installed, addon));
  for (const relative of Object.keys({ ...pins.sdk.files, ...pins.sdk.architectures.x64 })) {
    if (substituted && relative.startsWith(addon)) continue;
    const target = join(modules, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(installed, relative), target);
  }
  // A host without the target addon uses explicitly re-pinned inert bytes.
  // The real installed JS, DLLs and their production hashes stay unchanged.
  if (substituted) {
    for (const [relative, bytes] of Object.entries({
      "package.json": JSON.stringify(pins.sdk.packageMetadata["@koromix/koffi-win32-x64/package.json"]),
      "index.js": "throw new Error('Packaging fixture must never execute');\n",
      "win32_x64/koffi.node": "inert packaging addon fixture",
    })) {
      const target = join(modules, addon, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      (pins.sdk.architectures.x64 as Record<string, string>)[addon + relative] = contentHash(bytes);
    }
  }
  for (const notice of ["LICENSE.md", ...Object.keys(pins.sdk.notices)]) {
    const target = join(resources, "licenses", "mxc", notice);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(project, "resources", "licenses", "mxc", notice), target);
  }
  writeFileSync(executable, "inert packaged runtime fixture");
  const pinFile = join(resources, "fixture-sdk-pins.json");
  writeFileSync(pinFile, JSON.stringify(pins));
  return pinFile;
}

/** Hash-verification fixture for the macOS package; no addon or SDK code is executed. Returns the pins it was built for. */
export function writeMxcMacRuntimePackage(resources: string): { pinFile: string; substituted: boolean } {
  const project = fileURLToPath(new URL("../../../", import.meta.url));
  const { pins, substituted } = copyMxcMacSdkPayload(join(resources, "app.asar.unpacked", "node_modules"));
  for (const notice of ["LICENSE.md", ...Object.keys(pins.sdk.notices)]) {
    const target = join(resources, "licenses", "mxc", notice);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(project, "resources", "licenses", "mxc", notice), target);
  }
  const pinFile = join(resources, "fixture-sdk-pins.json");
  writeFileSync(pinFile, JSON.stringify(pins));
  return { pinFile, substituted };
}
