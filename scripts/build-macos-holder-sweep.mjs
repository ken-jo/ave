// Builds the macOS helper that ends every process carrying one holder's Seatbelt label
// (native/macos-holder-sweep/README.md) with the pinned Rust toolchain, offline; it downloads nothing.
//
//   node scripts/build-macos-holder-sweep.mjs [--arch arm64] [--if-stale] [--test-builds]
//
// `--if-stale` rebuilds only a missing helper or one older than its sources, and does nothing on another platform, so
// the app build and the test preparation can run it everywhere. `--test-builds` also builds the variant that finds
// members but never signals them (the `fixture` feature); it is never packaged.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { machoImageDigest } from "./lib/macho-image-digest.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = path.join("native", "macos-holder-sweep");
const CRATE_FILES = ["Cargo.toml", "Cargo.lock", path.join("src", "main.rs")];
const TARGET = "aarch64-apple-darwin";
export const MACOS_HOLDER_SWEEP_EXECUTABLE = "ave-holder-sweep";
export const MACOS_HOLDER_SWEEP_NEVER_SIGNALS = "ave-holder-sweep-never-signals";
// Constant spellings the build's own directories are remapped to, so the output does not depend on where it was built.
const REMAPPED = Object.freeze({ crate: "/ave/native/macos-holder-sweep", cargoHome: "/ave/cargo-home", rustupHome: "/ave/rustup-home" });

export function macosHolderSweepOutput(root, arch, executable = MACOS_HOLDER_SWEEP_EXECUTABLE) {
  if (arch !== "arm64") throw new Error(`unsupported macOS holder helper architecture: ${arch}`);
  return path.join(root, "resources", "macos-holder-sweep", arch, executable);
}

/** The pinned channel from `rust-toolchain.toml`; the build never picks a toolchain by itself. */
export function macosHolderSweepToolchain(root) {
  const match = /^\s*channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/mu.exec(readFileSync(path.join(root, "rust-toolchain.toml"), "utf8"));
  if (!match) throw new Error("rust-toolchain.toml does not pin an exact Rust channel");
  return match[1];
}

// The packaged app's minimum macOS version is the helper's too.
function minimumSystemVersion(root) {
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).build?.mac?.minimumSystemVersion;
  if (typeof version !== "string" || !/^\d+\.\d+$/u.test(version)) throw new Error("package.json build.mac.minimumSystemVersion is missing");
  return version;
}

function sources(root) {
  return [
    path.join(root, "package.json"), path.join(root, "rust-toolchain.toml"), path.join(root, "scripts", "build-macos-holder-sweep.mjs"),
    path.join(root, "scripts", "lib", "macho-image-digest.mjs"), ...CRATE_FILES.map((file) => path.join(root, CRATE, file)),
  ];
}

function fresh(root, outputs) {
  if (!outputs.every((output) => existsSync(output))) return false;
  const built = Math.min(...outputs.map((output) => statSync(output).mtimeMs));
  return sources(root).every((source) => statSync(source).mtimeMs <= built);
}

/** The exact cargo invocation; `features` selects the test variant. */
export function macosHolderSweepCargoArgs(manifest, targetDir, features = []) {
  return ["build", "--locked", "--offline", "--release", "--target", TARGET, "--target-dir", targetDir,
    "--manifest-path", manifest, "--bin", MACOS_HOLDER_SWEEP_EXECUTABLE, ...features];
}

function digests(bytes) {
  return { binarySha256: createHash("sha256").update(bytes).digest("hex"), imageSha256: machoImageDigest(bytes) };
}

function publish(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o755 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

// `spawn` runs cargo; tests replace it so they need no toolchain.
export function buildMacosHolderSweep({
  root = PROJECT_ROOT, arch = process.arch, ifStale = false, testBuilds = false, platform = process.platform,
  log = console.log, spawn = spawnSync, env = process.env,
} = {}) {
  if (platform !== "darwin") {
    if (ifStale) return null;
    throw new Error("the macOS holder helper builds on macOS only");
  }
  const helper = macosHolderSweepOutput(root, arch);
  const neverSignals = macosHolderSweepOutput(root, arch, MACOS_HOLDER_SWEEP_NEVER_SIGNALS);
  const outputs = testBuilds ? [helper, neverSignals] : [helper];
  if (ifStale && fresh(root, outputs)) {
    log(`[macos-holder-sweep] up to date: ${path.relative(root, helper)}`);
    return { ...digests(readFileSync(helper)), helper };
  }
  const toolchain = macosHolderSweepToolchain(root);
  const buildDir = mkdtempSync(path.join(realpathSync(tmpdir()), "ave-holder-sweep-cargo-"));
  try {
    const crateDir = path.join(buildDir, "crate");
    const cargoHome = path.join(buildDir, "cargo-home");
    const targetDir = path.join(buildDir, "target");
    for (const file of CRATE_FILES) {
      mkdirSync(path.dirname(path.join(crateDir, file)), { recursive: true });
      copyFileSync(path.join(root, CRATE, file), path.join(crateDir, file));
    }
    mkdirSync(cargoHome);
    const rustupHome = env.RUSTUP_HOME ?? path.join(homedir(), ".rustup");
    const rustflags = [
      `--remap-path-prefix=${crateDir}=${REMAPPED.crate}`,
      `--remap-path-prefix=${cargoHome}=${REMAPPED.cargoHome}`,
      `--remap-path-prefix=${rustupHome}=${REMAPPED.rustupHome}`,
    ];
    const cargoEnv = {
      PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? homedir(), RUSTUP_HOME: rustupHome, RUSTUP_TOOLCHAIN: toolchain,
      CARGO_HOME: cargoHome, TMPDIR: buildDir, MACOSX_DEPLOYMENT_TARGET: minimumSystemVersion(root),
      CARGO_ENCODED_RUSTFLAGS: rustflags.join("\x1f"),
    };
    const build = (features, label) => {
      const result = spawn("cargo", macosHolderSweepCargoArgs(path.join(crateDir, "Cargo.toml"), path.join(targetDir, label), features), {
        cwd: buildDir, env: cargoEnv, stdio: ["ignore", "inherit", "inherit"], shell: false,
      });
      if (result.error) throw new Error(`cargo could not start; install rustup, which fetches the pinned ${toolchain} toolchain (${result.error.message})`);
      if (result.status !== 0) throw new Error(`the macOS holder helper build failed (exit ${result.status})`);
      return readFileSync(path.join(targetDir, label, TARGET, "release", MACOS_HOLDER_SWEEP_EXECUTABLE));
    };
    log(`[macos-holder-sweep] building ${path.relative(root, helper)} with Rust ${toolchain}`);
    const bytes = build([], "release");
    const built = digests(bytes);
    if (testBuilds) publish(neverSignals, build(["--features", "fixture"], "fixture"));
    publish(helper, bytes);
    return { ...built, helper };
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const archIndex = argv.indexOf("--arch");
  const known = new Set(["--arch", "--if-stale", "--test-builds"]);
  const unknown = argv.filter((arg, index) => !known.has(arg) && index !== archIndex + 1);
  try {
    if (unknown.length > 0 || (archIndex >= 0 && argv[archIndex + 1] === undefined)) throw new Error(`unknown arguments: ${unknown.join(" ") || "--arch needs a value"}`);
    buildMacosHolderSweep({
      arch: archIndex >= 0 ? argv[archIndex + 1] : process.arch,
      ifStale: argv.includes("--if-stale"),
      testBuilds: argv.includes("--test-builds"),
    });
  } catch (error) {
    console.error(`[macos-holder-sweep] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
