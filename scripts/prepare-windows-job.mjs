// Prepare the native helpers and hold fixture for tests.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWindowsPathKind } from "./build-windows-path-kind.mjs";
import { assertWindowsPathKindArtifactDigests, verifyWindowsPathKindReceipt, windowsPathKindPath } from "./lib/windows-path-kind-build.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_COMMAND = "bun run build:windows-job";
const PATH_KIND_BUILD_COMMAND = "bun run build:windows-path-kind --fixture";
const MSVC_COMPONENT = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";

export function windowsJobLauncherPath(arch = process.arch, policyReaderFixture = false) {
  return path.join("resources", "windows-job", arch, policyReaderFixture ? "ave-job-policy-reader-test.exe" : "ave-job.exe");
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

export function windowsJobLauncherState(root, { platform = process.platform, arch = process.arch, policyReaderFixture = false } = {}) {
  const launcher = windowsJobLauncherPath(arch, policyReaderFixture);
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
  return `Windows job launcher ${launcher} needs building, but the Visual Studio C++ build tools (MSVC, ` +
    `${MSVC_COMPONENT}) were not found. Install them, then run: ${BUILD_COMMAND}`;
}

export function prepareWindowsJob({
  root = PROJECT_ROOT,
  platform = process.platform,
  arch = process.arch,
  env = {},
  findBuildTools = hasCppBuildTools,
  runSync = spawnSync,
  buildPathKind = buildWindowsPathKind,
  log = (line) => console.log(line),
} = {}) {
  const job = windowsJobLauncherState(root, { platform, arch });
  if (job.state === "skip") return job;
  const prepareLauncher = (artifact, policyReaderFixture) => {
    if (artifact.state === "fresh") {
      log(`[windows-job] up to date: ${artifact.launcher}`);
      return;
    }
    if (!findBuildTools()) throw new Error(missingBuildToolsMessage(artifact.launcher));
    const reason = artifact.state === "stale" ? `older than ${artifact.newer}` : "missing";
    log(`[windows-job] building ${artifact.launcher} (${reason})`);
    const args = ["run", "build:windows-job", "-Arch", arch, ...(policyReaderFixture ? ["-PolicyReaderFixture"] : [])];
    const result = runSync("bun.exe", args,
      { cwd: root, shell: false, stdio: "inherit", windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(`bun ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`})`);
    }
    if (windowsJobLauncherState(root, { platform, arch, policyReaderFixture }).state !== "fresh") {
      throw new Error(`bun ${args.join(" ")} did not produce an up-to-date ${artifact.launcher}`);
    }
  };
  prepareLauncher(job, false);
  prepareLauncher(windowsJobLauncherState(root, { platform, arch, policyReaderFixture: true }), true);

  const launcher = windowsPathKindPath(arch);
  if (env.AVE_WINDOWS_TEST_PLAN !== undefined) {
    assertWindowsPathKindArtifactDigests(root, arch, {
      binarySha256: env.AVE_WINDOWS_PATH_KIND_SHA256,
      receiptSha256: env.AVE_WINDOWS_PATH_KIND_RECEIPT_SHA256,
      holdFixtureSha256: env.AVE_WINDOWS_PATH_KIND_HOLD_FIXTURE_SHA256,
    });
    verifyWindowsPathKindReceipt(root, arch);
    log(`[windows-path-kind] verified producing build: ${launcher}`);
    return job;
  }
  log(`[windows-path-kind] building ${launcher} (fresh build)`);
  try {
    buildPathKind({ root, arch, fixture: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Windows path helper ${launcher} build failed: ${message}. To build manually, run: ${PATH_KIND_BUILD_COMMAND}`, { cause: error });
  }
  return job;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    prepareWindowsJob({ env: process.env });
  } catch (err) {
    console.error(`[windows-job] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
