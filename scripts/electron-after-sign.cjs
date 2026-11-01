const { join } = require("node:path");
const { readdirSync } = require("node:fs");
const { assertSrtWinVendor } = require("./lib/srt-win-integrity.cjs");

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "win32") return;
  const { assertPackagedMxcSdk, recordMxcSupervisorRuntime } = await import("./lib/mxc-sdk-packaging.mjs");
  recordMxcSupervisorRuntime(join(context.appOutDir, "resources"), { 1: "x64", 3: "arm64" }[context.arch], join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`));
  assertPackagedMxcSdk(join(context.appOutDir, "resources"), { 1: "x64", 3: "arm64" }[context.arch]);
  const vendor = join(context.appOutDir, "resources", "app.asar.unpacked", "node_modules", "@anthropic-ai", "sandbox-runtime", "vendor");
  assertSrtWinVendor(vendor, readdirSync(join(vendor, "srt-win")));
};
