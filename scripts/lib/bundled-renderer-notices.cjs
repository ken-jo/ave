const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");

const BUNDLED_RENDERER_NOTICES = require("./bundled-renderer-notices.json");

function assertBundledRendererNotices(resourcesDir) {
  for (const { packageName, noticeFile, sha256 } of BUNDLED_RENDERER_NOTICES) {
    const path = join(resourcesDir, "licenses", "renderer", noticeFile);
    let bytes;
    try { bytes = readFileSync(path); }
    catch { throw new Error(`Bundled renderer notice missing: ${packageName}`); }
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new Error(`Bundled renderer notice mismatch: ${packageName}`);
    }
  }
}

module.exports = { assertBundledRendererNotices };
