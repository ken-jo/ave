/**
 * prepare-windows-job.mjs — build the Windows job launcher before tests when
 * it is missing or older than its sources.
 *
 * `resources/windows-job/<arch>/ave-job.exe` is git-ignored, so a fresh
 * Windows checkout has none, and the background-shell suites fail with
 * "Windows job launcher is missing". `test:prepare` and the pre-push hook run
 * this script; the build itself stays in `build:windows-job`
 * (scripts/build-windows-job.ps1). Only the launcher the suite loads is built:
 * the `-FailureFixture` executable belongs to scripts/test-windows-job.mjs.
 *
 * Stale means some file under native/windows-job/ or the build script is newer
 * than the executable. Without the C++ build tools the script fails, naming
 * them and the command to run; it never continues without the launcher.
 * Off Windows it does nothing.
 *
 * Usage: node scripts/prepare-windows-job.mjs   (test:prepare, pre-push)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_COMMAND = "bun run build:windows-job";
const MSVC_COMPONENT = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";

/** The launcher path the app resolves (src/main/windows-job-launcher.ts), relative to `root`. */
export function windowsJobLauncherPath(arch = process.arch) {
  return path.join("resources", "windows-job", arch, "ave-job.exe");
}

/** The build script and every file under native/windows-job/, relative to `root`. */
export function windowsJobSources(root) {
  const sources = [path.join("scripts", "build-windows-job.ps1")];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) sources.push(child);
    }
  };
  walk(path.join("native", "windows-job"));
  return sources.sort();
}

/**
 * `{ state: "skip" | "missing" | "stale" | "fresh", launcher, newer? }`.
 * `newer` is the first source newer than the launcher.
 */
export function windowsJobLauncherState(root, { platform = process.platform, arch = process.arch } = {}) {
  const launcher = windowsJobLauncherPath(arch);
  if (platform !== "win32") return { state: "skip", launcher };
  if (!existsSync(path.join(root, launcher))) return { state: "missing", launcher };
  const built = statSync(path.join(root, launcher)).mtimeMs;
  const newer = windowsJobSources(root).find((source) => statSync(path.join(root, source)).mtimeMs > built);
  return newer ? { state: "stale", launcher, newer } : { state: "fresh", launcher };
}

/** Whether vswhere reports an installation with the MSVC x86/x64 tools, as build-windows-job.ps1 asks it. */
export function hasCppBuildTools({
  programFilesX86 = process.env["ProgramFiles(x86)"],
  exists = existsSync,
  runSync = spawnSync,
} = {}) {
  if (!programFilesX86) return false;
  const vswhere = path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!exists(vswhere)) return false;
  const result = runSync(vswhere, ["-latest", "-products", "*", "-requires", MSVC_COMPONENT, "-property", "installationPath"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return result.status === 0 && typeof result.stdout === "string" && result.stdout.trim() !== "";
}

export function missingBuildToolsMessage(launcher) {
  return `Windows job launcher ${launcher} needs building, but the Visual Studio C++ build tools (MSVC, ` +
    `${MSVC_COMPONENT}) were not found. Install them, then run: ${BUILD_COMMAND}`;
}

/** Build the launcher when it is missing or stale. Returns the state found; throws when it cannot build. */
export function prepareWindowsJob({
  root = PROJECT_ROOT,
  platform = process.platform,
  arch = process.arch,
  findBuildTools = hasCppBuildTools,
  runSync = spawnSync,
  log = (line) => console.log(line),
} = {}) {
  const found = windowsJobLauncherState(root, { platform, arch });
  if (found.state === "skip") return found;
  if (found.state === "fresh") {
    log(`[windows-job] up to date: ${found.launcher}`);
    return found;
  }
  if (!findBuildTools()) throw new Error(missingBuildToolsMessage(found.launcher));
  log(`[windows-job] building ${found.launcher} (${found.state === "stale" ? `older than ${found.newer}` : "missing"})`);
  const result = runSync("bun.exe", ["run", "build:windows-job", "-Arch", arch], {
    cwd: root,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${BUILD_COMMAND} failed (${result.error?.message ?? `exit ${result.status}`})`);
  }
  if (windowsJobLauncherState(root, { platform, arch }).state !== "fresh") {
    throw new Error(`${BUILD_COMMAND} did not produce an up-to-date ${found.launcher}`);
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    prepareWindowsJob();
  } catch (err) {
    console.error(`[windows-job] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
