import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { windowsPeImageDigest } from "./windows-pe-image-digest.mjs";

// The before-pack build of each package, held in the packager's memory for its later hooks.
const builds = new Map();

function packagedHelper(appOutDir, arch) {
  return join(appOutDir, "resources", "windows-path-kind", arch, "ave-path-kind.exe");
}

function recordedBuild(appOutDir, arch) {
  const build = builds.get(appOutDir);
  if (build?.arch !== arch) throw new Error(`No Windows path helper build was recorded for this ${arch} package`);
  return build;
}

/** before-pack: the fresh build must be the image the main bundle pins. */
export function recordWindowsPathKindPackageBuild({ appOutDir, arch, manifest, build }) {
  const pin = manifest?.windowsPathKind;
  if (pin?.arch !== arch || pin.imageSha256 !== build.imageSha256) {
    throw new Error(`The main bundle does not pin this ${arch} Windows path helper build. Rebuild the bundle for ${arch}.`);
  }
  builds.set(appOutDir, { arch, binarySha256: build.binarySha256, imageSha256: build.imageSha256 });
}

/** after-pack: the packaged copy must be the before-pack build byte for byte. */
export function assertPackagedWindowsPathKind(appOutDir, arch) {
  const { binarySha256 } = recordedBuild(appOutDir, arch);
  const actual = createHash("sha256").update(readFileSync(packagedHelper(appOutDir, arch))).digest("hex");
  if (actual !== binarySha256) throw new Error("The packaged Windows path helper is not the before-pack build");
}

/** after-sign: signing may change only the fields the image digest leaves out. */
export function assertSignedWindowsPathKind(appOutDir, arch) {
  const { imageSha256 } = recordedBuild(appOutDir, arch);
  if (windowsPeImageDigest(readFileSync(packagedHelper(appOutDir, arch))) !== imageSha256) {
    throw new Error("The signed Windows path helper is not the before-pack build");
  }
}
