const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
module.exports = async function beforePack(context) {
  const renameArch = { 1: "x64", 3: "arm64" }[context.arch];
  if (!renameArch || process.platform !== context.electronPlatformName) throw new Error("Exclusive rename helper requires a native target build");
  execFileSync(process.execPath, [join(context.packager.projectDir, "scripts", "build-rename-entry.mjs"), renameArch], { stdio: "inherit" });
  if (context.electronPlatformName !== "win32") return;
  if (process.platform !== "win32") throw new Error("Windows job launcher requires a native Windows build");
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  if (!arch) throw new Error(`Unsupported Windows job launcher architecture: ${context.arch}`);
  // The job launcher, then the folder classifier (native/windows-path-kind/).
  for (const helper of ["job", "path-kind"]) {
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(context.packager.projectDir, "scripts", "build-windows-job.ps1"), "-Arch", arch, "-Helper", helper], { stdio: "inherit" });
  }
};
