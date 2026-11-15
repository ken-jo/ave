const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");

const BUNDLED_RENDERER_NOTICES = Object.freeze([
  {
    "packageName": "@dnd-kit/core",
    "noticeFile": "dnd-kit-core-LICENSE",
    "sha256": "537607e3f1533ad2c5b12978967f5ab27f34ffb7e626e321017a7ccca6cc24ff"
  },
  {
    "packageName": "@dnd-kit/utilities",
    "noticeFile": "dnd-kit-utilities-LICENSE",
    "sha256": "537607e3f1533ad2c5b12978967f5ab27f34ffb7e626e321017a7ccca6cc24ff"
  },
  {
    "packageName": "@dnd-kit/accessibility",
    "noticeFile": "dnd-kit-accessibility-LICENSE",
    "sha256": "537607e3f1533ad2c5b12978967f5ab27f34ffb7e626e321017a7ccca6cc24ff"
  }
]);

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

module.exports = { BUNDLED_RENDERER_NOTICES, assertBundledRendererNotices };
