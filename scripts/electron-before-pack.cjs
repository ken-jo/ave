const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { assertSrtWinVendor } = require("./lib/srt-win-integrity.cjs");
module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== "win32") return;
  if (process.platform !== "win32") throw new Error("Windows job launcher requires a native Windows build");
  const { windowsPowerShellEnv } = await import("./lib/windows-powershell-env.mjs");
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  if (!arch) throw new Error(`Unsupported Windows job launcher architecture: ${context.arch}`);
  assertSrtWinVendor(join(context.packager.projectDir, "node_modules", "@anthropic-ai", "sandbox-runtime", "vendor"));
  for (const helper of ["job", "path-kind"]) {
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(context.packager.projectDir, "scripts", "build-windows-job.ps1"), "-Arch", arch, "-Helper", helper], { stdio: "inherit", env: windowsPowerShellEnv() });
  }
  const { stageMxcSdkAddon, stageMxcLauncher } = await import(pathToFileURL(join(context.packager.projectDir, "scripts", "fetch-mxc.mjs")).href);
  await stageMxcSdkAddon({ arch, projectRoot: context.packager.projectDir });
  const { verifyMxcSdk } = await import("./lib/mxc-sdk-integrity.mjs");
  const pins = require("../src/permissions/mxc-launcher-pins.json");
  verifyMxcSdk(join(context.packager.projectDir, "node_modules"), arch, pins, {});
  // Stage the hash-pinned container launcher; mismatches fail the build.
  const staged = await stageMxcLauncher({ arch, projectRoot: context.packager.projectDir });
  console.log(`fetch-mxc: ${staged} verified against src/permissions/mxc-launcher-pins.json`);
};
