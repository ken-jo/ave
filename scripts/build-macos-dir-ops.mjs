// Builds the macOS helper that moves, copies and removes staged browser downloads relative to held directory descriptors
// (native/macos-dir-ops/README.md), with the installed command-line tools; it downloads nothing.
//
//   node scripts/build-macos-dir-ops.mjs [--arch arm64|x64] [--if-stale] [--test-builds]
//
// `--if-stale` rebuilds only a missing helper or one older than its sources, and does nothing on another platform, so the app
// build and the test preparation can run it everywhere. `--test-builds` also builds the test-only variants that inject a fault (see
// MACOS_DIR_OPS_TEST_BUILDS); they are never packaged.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRECTORY = path.join("native", "macos-dir-ops");
const SOURCE = path.join(SOURCE_DIRECTORY, "dir-ops.c");
export const MACOS_DIR_OPS_EXECUTABLE = "ave-dir-ops";
// Each test variant enables the faults named by its build flags.
export const MACOS_DIR_OPS_TEST_BUILDS = Object.freeze([
  Object.freeze({ executable: "ave-dir-ops-short-writes", defines: ["AVE_DIR_OPS_TEST_WRITE_LIMIT=4093"] }),
  Object.freeze({ executable: "ave-dir-ops-stalled-writes", defines: ["AVE_DIR_OPS_TEST_STALLED_WRITES"] }),
  Object.freeze({ executable: "ave-dir-ops-never-ready", defines: ["AVE_DIR_OPS_TEST_NEVER_READY"] }),
  Object.freeze({ executable: "ave-dir-ops-ignores-eof", defines: ["AVE_DIR_OPS_TEST_IGNORES_EOF"] }),
  Object.freeze({ executable: "ave-dir-ops-reused-file-id", defines: ["AVE_DIR_OPS_TEST_REUSED_FILE_ID"] }),
  Object.freeze({ executable: "ave-dir-ops-swap-restored", defines: ["AVE_DIR_OPS_TEST_SWAP_RESTORED"] }),
  Object.freeze({ executable: "ave-dir-ops-swap-rollback", defines: ["AVE_DIR_OPS_TEST_SWAP_COMMIT", "AVE_DIR_OPS_TEST_SWAP_ROLLBACK"] }),
  Object.freeze({ executable: "ave-dir-ops-swap-commit", defines: ["AVE_DIR_OPS_TEST_SWAP_COMMIT"] }),
  Object.freeze({ executable: "ave-dir-ops-fail-restored", defines: ["AVE_DIR_OPS_TEST_FAIL_RESTORED"] }),
  Object.freeze({ executable: "ave-dir-ops-copy-commit-failure", defines: ["AVE_DIR_OPS_TEST_COPY_COMMIT_FAILURE"] }),
  Object.freeze({ executable: "ave-dir-ops-copy-restore-failure", defines: ["AVE_DIR_OPS_TEST_COPY_RESTORE_FAILURE"] }),
  Object.freeze({ executable: "ave-dir-ops-copy-occupied", defines: ["AVE_DIR_OPS_TEST_COPY_OCCUPIED"] }),
]);

export function macosDirOpsOutput(root, arch, executable = MACOS_DIR_OPS_EXECUTABLE) {
  return path.join(root, "resources", "macos-dir-ops", arch, executable);
}

function sources(root) {
  return [
    path.join(root, "scripts", "build-macos-dir-ops.mjs"),
    ...readdirSync(path.join(root, SOURCE_DIRECTORY)).map((name) => path.join(root, SOURCE_DIRECTORY, name)),
  ];
}

function fresh(root, output) {
  if (!existsSync(output)) return false;
  const built = statSync(output).mtimeMs;
  return sources(root).every((source) => statSync(source).mtimeMs <= built);
}

// The packaged app's minimum macOS version is the helper's too.
function minimumSystemVersion(root) {
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).build?.mac?.minimumSystemVersion;
  if (typeof version !== "string" || !/^\d+\.\d+$/u.test(version)) throw new Error("package.json build.mac.minimumSystemVersion is missing");
  return version;
}

function compile(root, arch, output, defines, spawn) {
  mkdirSync(path.dirname(output), { recursive: true });
  const args = [
    "--sdk", "macosx", "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    `-mmacosx-version-min=${minimumSystemVersion(root)}`, "-arch", arch === "x64" ? "x86_64" : "arm64",
    ...defines.map((define) => `-D${define}`), "-o", output, path.join(root, SOURCE),
  ];
  const result = spawn("xcrun", args, { stdio: "inherit", shell: false });
  if (result.error) throw new Error(`xcrun could not start; install the command-line developer tools (${result.error.message})`);
  if (result.status !== 0) throw new Error(`the macOS download file helper build failed (exit ${result.status})`);
}

// `spawn` runs the compiler; tests replace it so they need no toolchain.
export function buildMacosDirOps({
  root = PROJECT_ROOT, arch = process.arch, ifStale = false, testBuilds = false, platform = process.platform, log = console.log, spawn = spawnSync,
} = {}) {
  if (platform !== "darwin") {
    if (ifStale) return [];
    throw new Error("the macOS download file helper builds on macOS only");
  }
  if (arch !== "arm64" && arch !== "x64") throw new Error(`unsupported macOS helper architecture: ${arch}`);
  const builds = [{ executable: MACOS_DIR_OPS_EXECUTABLE, defines: [] }, ...(testBuilds ? MACOS_DIR_OPS_TEST_BUILDS : [])];
  const built = [];
  for (const { executable, defines } of builds) {
    const output = macosDirOpsOutput(root, arch, executable);
    if (ifStale && fresh(root, output)) {
      log(`[macos-dir-ops] up to date: ${path.relative(root, output)}`);
      continue;
    }
    log(`[macos-dir-ops] building ${path.relative(root, output)}`);
    compile(root, arch, output, defines, spawn);
    built.push(output);
  }
  return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const archIndex = argv.indexOf("--arch");
  const known = new Set(["--arch", "--if-stale", "--test-builds"]);
  const unknown = argv.filter((arg, index) => !known.has(arg) && index !== archIndex + 1);
  try {
    if (unknown.length > 0 || (archIndex >= 0 && argv[archIndex + 1] === undefined)) throw new Error(`unknown arguments: ${unknown.join(" ") || "--arch needs a value"}`);
    buildMacosDirOps({
      arch: archIndex >= 0 ? argv[archIndex + 1] : process.arch,
      ifStale: argv.includes("--if-stale"),
      testBuilds: argv.includes("--test-builds"),
    });
  } catch (error) {
    console.error(`[macos-dir-ops] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
