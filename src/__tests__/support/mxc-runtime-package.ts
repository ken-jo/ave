import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PINS from "../../permissions/mxc-launcher-pins.json" with { type: "json" };
import { contentHash } from "./content-hash.js";

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
