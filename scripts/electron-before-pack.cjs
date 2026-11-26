const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { readFileSync } = require("node:fs");
const { assertSrtWinVendor, assertSrtWinReceiptModule } = require("./lib/srt-win-integrity.cjs");
module.exports = async function beforePack(context) {
  const { projectDir: projectRoot } = context.packager;
  const platform = context.electronPlatformName;
  const { assertMxcVerificationPayload } = await import("./lib/mxc-verification-build.mjs");
  assertMxcVerificationPayload(join(context.packager.projectDir, "dist", "src", "main"));
  const { assertSkillScriptInventory } = await import("./lib/skill-script-inventory.mjs");
  assertSkillScriptInventory(join(context.packager.projectDir, "dist", "skill-scripts"));
  if (platform === "darwin") {
    // The helper that publishes staged browser downloads through held directories (native/macos-dir-ops), built for the packaged arch.
    if (process.platform !== "darwin") throw new Error("The macOS download file helper requires a native macOS build");
    if (context.arch !== 3) throw new Error(`Unsupported macOS package architecture: ${context.arch}`);
    const arch = "arm64";
    const { buildMacosDirOps } = await import(pathToFileURL(join(__dirname, "build-macos-dir-ops.mjs")).href);
    buildMacosDirOps({ root: context.packager.projectDir, arch });
    const { stageMxcLauncher } = await import("./fetch-mxc.mjs");
    await stageMxcLauncher({ target: `darwin-${arch}`, projectRoot });
    return;
  }
  if (platform === "linux") {
    const arch = { 1: "x64", 3: "arm64" }[context.arch];
    const { stageMxcLauncher } = await import("./fetch-mxc.mjs");
    await stageMxcLauncher({ target: `linux-${arch}`, projectRoot });
    return;
  }
  if (context.electronPlatformName !== "win32") return;
  const { assertMxcSupervisorFuse } = await import("./lib/mxc-sdk-packaging.mjs");
  assertMxcSupervisorFuse(context.packager.config);
  if (process.platform !== "win32") throw new Error("Windows job launcher requires a native Windows build");
  const { windowsPowerShellEnv } = await import("./lib/windows-powershell-env.mjs");
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  if (!arch) throw new Error(`Unsupported Windows job launcher architecture: ${context.arch}`);
  const bundleDir = join(context.packager.projectDir, "dist", "src", "main");
  const manifest = JSON.parse(readFileSync(join(bundleDir, "bundle-manifest.json")));
  if (manifest.srtWinReceiptsSha256 !== assertSrtWinReceiptModule()) throw new Error("Windows helper receipts changed after bundling");
  assertSrtWinVendor(join(context.packager.projectDir, "node_modules", "@anthropic-ai", "sandbox-runtime", "vendor"));
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    join(context.packager.projectDir, "scripts", "build-windows-job.ps1"), "-Arch", arch], { stdio: "inherit", env: windowsPowerShellEnv() });
  const { buildWindowsPathKind } = await import("./build-windows-path-kind.mjs");
  const pathKind = buildWindowsPathKind({ root: context.packager.projectDir, arch });
  // The later hooks check the packaged and signed copies against this build.
  const { recordWindowsPathKindPackageBuild } = await import("./lib/windows-path-kind-package.mjs");
  recordWindowsPathKindPackageBuild({
    appOutDir: context.appOutDir, arch, build: pathKind, bundleDir,
    receiptPath: process.env.AVE_WINDOWS_PATH_KIND_BUNDLE_RECEIPT,
  });
  const { stageMxcSdkAddon, stageMxcLauncher } = await import(pathToFileURL(join(context.packager.projectDir, "scripts", "fetch-mxc.mjs")).href);
  await stageMxcSdkAddon({ arch, projectRoot: context.packager.projectDir });
  const { verifyMxcSdkSource } = await import("./lib/mxc-sdk-integrity.mjs");
  const pins = require("../src/permissions/mxc-launcher-pins.json");
  verifyMxcSdkSource(join(context.packager.projectDir, "node_modules"), arch, pins, {});
  // Stage the hash-pinned container launcher; mismatches fail the build.
  const staged = await stageMxcLauncher({ target: `win32-${arch}`, projectRoot: context.packager.projectDir });
  console.log(`fetch-mxc: ${staged} verified against src/permissions/mxc-launcher-pins.json`);
};
