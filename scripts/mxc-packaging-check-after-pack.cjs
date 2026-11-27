const { rmSync } = require("node:fs");
const { join } = require("node:path");

// This packaging-only entry shares the launcher check and SDK finalizer.
// It does not compile unrelated native helpers or execute the packaged app.
module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  const target = `${platform}-${arch}`;
  const product = context.packager.appInfo.productFilename;
  const resources = platform === "darwin"
    ? join(context.appOutDir, `${product}.app`, "Contents", "Resources") : join(context.appOutDir, "resources");
  const { assertPackagedLauncher, finalizePackagedMxcSdk, prunePackagedMxcSdk, stagePackagedLinuxShellFilter } = await import("./lib/mxc-sdk-packaging.mjs");
  if (platform === "darwin") {
    prunePackagedMxcSdk(resources, arch, platform);
    return;
  }
  assertPackagedLauncher(resources, target);
  if (platform === "win32") {
    finalizePackagedMxcSdk(resources, arch, join(context.appOutDir, `${product}.exe`));
  } else {
    rmSync(join(resources, "app.asar.unpacked", "node_modules", "@microsoft", "mxc-sdk", "bin"), { recursive: true, force: true });
    if (platform === "linux") stagePackagedLinuxShellFilter(resources, arch);
  }
};
