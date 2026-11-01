const { join } = require("node:path");

// This packaging-only entry shares the production SDK finalizer. It neither
// compiles the unrelated native helpers nor executes the packaged application.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") throw new Error("Packaging check requires a Windows target");
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  const { finalizePackagedMxcSdk } = await import("./lib/mxc-sdk-packaging.mjs");
  finalizePackagedMxcSdk(join(context.appOutDir, "resources"), arch,
    join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`));
};
