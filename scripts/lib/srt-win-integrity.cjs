const { createHash } = require("node:crypto");
const { lstatSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const pins = require("../../src/permissions/srt-win-pins.json");

function assertSrtWinFile(path, arch) {
  if (!Object.hasOwn(pins.sha256, arch) || !lstatSync(path).isFile() ||
      createHash("sha256").update(readFileSync(path)).digest("hex") !== pins.sha256[arch]) {
    throw new Error(`srt-win-integrity-mismatch: ${arch}`);
  }
}

function assertSrtWinVendor(vendorDirectory, arches = Object.keys(pins.sha256)) {
  for (const arch of arches) assertSrtWinFile(join(vendorDirectory, "srt-win", arch, "srt-win.exe"), arch);
}

module.exports = { assertSrtWinVendor };
