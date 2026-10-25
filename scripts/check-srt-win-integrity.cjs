const { dirname, join } = require("node:path");
const { assertSrtWinVendor } = require("./lib/srt-win-integrity.cjs");

const root = dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));
assertSrtWinVendor(join(root, "vendor"));
console.log("srt-win: all vendored architectures match the pinned SHA-256");
