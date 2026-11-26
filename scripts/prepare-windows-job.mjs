// Prepare the native helpers tests load, without the job failure fixtures.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWindowsPathKindBuild, windowsPathKindPath } from "./lib/windows-path-kind-build.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_COMMAND = "bun run build:windows-job";
const PATH_KIND_BUILD_COMMAND = "bun run build:windows-path-kind";
const MSVC_COMPONENT = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";

export function windowsJobLauncherPath(arch = process.arch) {
  return path.join("resources", "windows-job", arch, "ave-job.exe");
}

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

export function windowsJobLauncherState(root, { platform = process.platform, arch = process.arch } = {}) {
  const launcher = windowsJobLauncherPath(arch);
  if (platform !== "win32") return { state: "skip", launcher };
  if (!existsSync(path.join(root, launcher))) return { state: "missing", launcher };
  const built = statSync(path.join(root, launcher)).mtimeMs;
  const newer = windowsJobSources(root).find((source) => statSync(path.join(root, source)).mtimeMs > built);
  return newer ? { state: "stale", launcher, newer } : { state: "fresh", launcher };
}

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
  if (launcher.includes("windows-path-kind")) {
    return "Windows path helper " + launcher + " needs building. Install the MSVC tools ("
      + MSVC_COMPONENT + ") and the pinned Rust toolchain, then run: " + PATH_KIND_BUILD_COMMAND;
  }
  const command = BUILD_COMMAND;
  return `Windows job launcher ${launcher} needs building, but the Visual Studio C++ build tools (MSVC, ` +
    `${MSVC_COMPONENT}) were not found. Install them, then run: ${command}`;
}

export function prepareWindowsJob({
  root = PROJECT_ROOT,
  platform = process.platform,
  arch = process.arch,
  findBuildTools = hasCppBuildTools,
  runSync = spawnSync,
  log = (line) => console.log(line),
} = {}) {
  const job = windowsJobLauncherState(root, { platform, arch });
  if (job.state === "skip") return job;
  const prepare = (directory, launcher, reason, args, check) => {
    const prefix = `[${directory}] `;
    if (!reason) {
      log(`${prefix}up to date: ${launcher}`);
      return;
    }
    if (!findBuildTools()) throw new Error(missingBuildToolsMessage(launcher));
    log(`${prefix}building ${launcher} (${reason})`);
    const result = runSync("bun.exe", args, { cwd: root, shell: false, stdio: "inherit", windowsHide: true });
    const command = ["bun", ...args].join(" ");
    if (result.error || result.status !== 0) {
      throw new Error(`${command} failed (${result.error?.message ?? `exit ${result.status}`})`);
    }
    if (!check()) throw new Error(`${command} did not produce an up-to-date ${launcher}`);
  };
  const jobReason = job.state === "stale" ? `older than ${job.newer}` : job.state === "missing" ? "missing" : "";
  prepare("windows-job", job.launcher, jobReason, ["run", "build:windows-job", "-Arch", arch],
    () => windowsJobLauncherState(root, { platform, arch }).state === "fresh");

  const launcher = windowsPathKindPath(arch);
  const hasCurrentPathKind = () => {
    try {
      verifyWindowsPathKindBuild(root, arch);
      return true;
    } catch {
      return false;
    }
  };
  const reason = hasCurrentPathKind() ? "" : "missing or changed build inputs or executable";
  prepare("windows-path-kind", launcher, reason, ["run", "build:windows-path-kind", "--", "--arch", arch, "--fixture"], hasCurrentPathKind);
  return job;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    prepareWindowsJob();
  } catch (err) {
    console.error(`[windows-job] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
