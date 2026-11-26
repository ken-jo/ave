import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFile, statFile } from "@electron/asar";
import { windowsPeImageDigest } from "./windows-path-kind-image-digest.mjs";

// The before-pack build of each package, held in the packager's memory for its later hooks.
const builds = new Map();
const BUNDLE_FILE = /^(?:chunks\/)?[a-z0-9_-]+\.js$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
export const WINDOWS_PATH_KIND_BUNDLE_PIN = "__aveWindowsPathKindPin";

export function windowsPathKindBundlePinDeclaration(imageSha256) {
  return `const ${WINDOWS_PATH_KIND_BUNDLE_PIN} = ${JSON.stringify(imageSha256)};`;
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function packagedHelper(appOutDir, arch) {
  return join(appOutDir, "resources", "windows-path-kind", arch, "ave-path-kind.exe");
}

function recordedBuild(appOutDir, arch) {
  const build = builds.get(appOutDir);
  if (build?.arch !== arch) throw new Error(`No Windows path helper build was recorded for this ${arch} package`);
  return build;
}

/** before-pack: the fresh build must be the image the main bundle pins. */
export function recordWindowsPathKindPackageBuild({ appOutDir, arch, manifest, build, bundleDir }) {
  const pin = manifest?.windowsPathKind;
  if (pin?.arch !== arch || pin.imageSha256 !== build.imageSha256) {
    throw new Error(`The main bundle does not pin this ${arch} Windows path helper build. Rebuild the bundle for ${arch}.`);
  }
  const bundle = Object.entries(pin.bundleSha256 ?? {});
  if (!bundle.some(([file]) => file === "main.js")) throw new Error("Missing Windows main bundle build digests");
  const declaration = windowsPathKindBundlePinDeclaration(build.imageSha256) + "\n";
  for (const [file, digest] of bundle) {
    if (!BUNDLE_FILE.test(file) || typeof digest !== "string" || !SHA256.test(digest)) {
      throw new Error("Invalid Windows main bundle build digest");
    }
    const bytes = readFileSync(join(bundleDir, file));
    if (sha256(bytes) !== digest) throw new Error("The main bundle bytes do not match the producing build");
    const headerStart = bytes.subarray(0, 2).equals(Buffer.from("#!")) ? bytes.indexOf(10) + 1 : 0;
    if (bytes.toString("utf8", headerStart, headerStart + declaration.length) !== declaration) {
      throw new Error("The main bundle pin does not match the before-pack build");
    }
  }
  builds.set(appOutDir, { arch, binarySha256: build.binarySha256, imageSha256: build.imageSha256, bundle });
}

/** after-pack: the packaged copy must be the before-pack build byte for byte. */
export function assertPackagedWindowsPathKind(appOutDir, arch) {
  const { binarySha256, bundle } = recordedBuild(appOutDir, arch);
  if (sha256(readFileSync(packagedHelper(appOutDir, arch))) !== binarySha256) {
    throw new Error("The packaged Windows path helper is not the before-pack build");
  }
  const archive = join(appOutDir, "resources", "app.asar");
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    for (const [file, digest] of bundle) {
      const entry = join("dist", "src", "main", file);
      const info = statFile(archive, entry, false);
      if (!("offset" in info) || info.unpacked || sha256(extractFile(archive, entry, false)) !== digest) {
        throw new Error("The archived main bundle does not match the before-pack build");
      }
    }
  } finally {
    process.noAsar = previousNoAsar;
  }
}

/** after-sign: signing may change only the fields the image digest leaves out. */
export function assertSignedWindowsPathKind(appOutDir, arch) {
  const { imageSha256 } = recordedBuild(appOutDir, arch);
  if (windowsPeImageDigest(readFileSync(packagedHelper(appOutDir, arch))) !== imageSha256) {
    throw new Error("The signed Windows path helper is not the before-pack build");
  }
}
