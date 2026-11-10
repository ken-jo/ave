const { dirname, join } = require("node:path");
const { assertSrtWinVendor, assertUpstreamSrtWinVendor, assertSrtWinBuildInputs } = require("./lib/srt-win-integrity.cjs");

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--upstream" && arg !== "--inputs")) throw new Error("Invalid helper integrity option");
const vendor = join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "vendor");
if (args.includes("--upstream")) assertUpstreamSrtWinVendor(vendor);
if (args.includes("--inputs")) assertSrtWinBuildInputs(vendor);
if (args.length === 0) assertSrtWinVendor(vendor);
console.log("srt-win: requested integrity checks passed");
