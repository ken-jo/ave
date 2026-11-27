import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { machoImageDigest } from "./macho-image-digest.mjs";

// The before-pack build of each package, held in the packager's memory for its later hooks.
const builds = new Map();
export const MACOS_HOLDER_SWEEP_BUNDLE_PIN = "__aveMacosHolderSweepPin";
const LICENSES = new URL("../../resources/licenses/macos-holder-sweep/", import.meta.url);

export function macosHolderSweepBundlePinDeclaration(imageSha256) {
  return `const ${MACOS_HOLDER_SWEEP_BUNDLE_PIN} = ${JSON.stringify(imageSha256)};`;
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function packagedMacosHolderSweep(resourcesDir, arch) {
  return join(resourcesDir, "macos-holder-sweep", arch, "ave-holder-sweep");
}

function recordedBuild(appOutDir, arch) {
  const build = builds.get(appOutDir);
  if (build?.arch !== arch) throw new Error(`No macOS holder helper build was recorded for this ${arch} package`);
  return build;
}

/** before-pack: the fresh build must be the image the main bundle was built with. */
export function recordMacosHolderSweepPackageBuild({ appOutDir, arch, build, bundleDir }) {
  const main = readFileSync(join(bundleDir, "main.js"));
  const headerStart = main.subarray(0, 2).equals(Buffer.from("#!")) ? main.indexOf(10) + 1 : 0;
  const declaration = `${macosHolderSweepBundlePinDeclaration(build.imageSha256)}\n`;
  if (main.toString("utf8", headerStart, headerStart + declaration.length) !== declaration) {
    throw new Error(`The main bundle does not pin this ${arch} macOS holder helper build. Rebuild the bundle.`);
  }
  builds.set(appOutDir, { arch, binarySha256: build.binarySha256, imageSha256: build.imageSha256 });
}

/** after-pack: the packaged copy must be the before-pack build byte for byte, and its notices must ship beside it. */
export function assertPackagedMacosHolderSweep(appOutDir, resourcesDir, arch) {
  const { binarySha256 } = recordedBuild(appOutDir, arch);
  if (sha256(readFileSync(packagedMacosHolderSweep(resourcesDir, arch))) !== binarySha256) {
    throw new Error("The packaged macOS holder helper is not the before-pack build");
  }
  cpSync(LICENSES, join(resourcesDir, "licenses", "macos-holder-sweep"), { recursive: true });
}

function codesignDetails(file, run) {
  const result = run("codesign", ["-d", "--verbose=2", file], { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) throw new Error(`codesign could not describe ${file}`);
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const team = /^TeamIdentifier=(.+)$/mu.exec(text)?.[1];
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/mu.exec(text)?.[1] ?? "";
  return { team: team === undefined || team === "not set" ? undefined : team, runtime: flags.split(",").includes("runtime") };
}

/**
 * after-sign: signing may change only what the image digest leaves out; the signature must verify; a Developer
 * ID-signed app's helper carries the hardened runtime and the app's team. `run` executes codesign; tests replace it.
 */
export function assertSignedMacosHolderSweep(appOutDir, resourcesDir, appBundle, arch, run = spawnSync) {
  const { imageSha256 } = recordedBuild(appOutDir, arch);
  const helper = packagedMacosHolderSweep(resourcesDir, arch);
  if (machoImageDigest(readFileSync(helper)) !== imageSha256) throw new Error("The signed macOS holder helper is not the before-pack build");
  const verify = run("codesign", ["--verify", "--strict", helper], { encoding: "utf8", shell: false });
  if (verify.error || verify.status !== 0) throw new Error("The signed macOS holder helper does not pass codesign --verify --strict");
  const app = codesignDetails(appBundle, run);
  if (app.team === undefined) return;
  const own = codesignDetails(helper, run);
  if (own.team !== app.team || !own.runtime) {
    throw new Error("The macOS holder helper must be signed with the app's team and the hardened runtime");
  }
}
