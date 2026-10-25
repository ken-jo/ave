const { accessSync, constants: fsConstants, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

// Packaging and runtime target tables must agree with dependency CPU and OS selection.
const RIPGREP_PLATFORM_PACKAGES = Object.freeze({
  "darwin-x64": "@vscode/ripgrep-darwin-x64",
  "darwin-arm64": "@vscode/ripgrep-darwin-arm64",
  "linux-x64": "@vscode/ripgrep-linux-x64",
  "linux-arm64": "@vscode/ripgrep-linux-arm64",
  "win32-x64": "@vscode/ripgrep-win32-x64",
  "win32-arm64": "@vscode/ripgrep-win32-arm64",
});

/**
 * Notices shipped under `resources/licenses/ripgrep` (extraResources
 * `licenses/ripgrep`): ripgrep under its MIT option with the dual-licence
 * statement and the Unlicense, the statically linked PCRE2, and the
 * @vscode/ripgrep wrapper.
 */
const RIPGREP_LICENSE_NOTICES = Object.freeze([
  "README.txt",
  "COPYING",
  "LICENSE-MIT",
  "UNLICENSE",
  "PCRE2-LICENCE.txt",
  "VSCODE-RIPGREP-LICENSE",
]);

function assertRipgrepRuntimeFiles(nodeModules, platform, arch) {
  const target = `${platform}-${arch}`;
  const packageName = RIPGREP_PLATFORM_PACKAGES[target];
  if (!packageName) throw new Error(`unsupported ripgrep target: ${target}`);
  const packageDir = join(nodeModules, ...packageName.split("/"));
  const manifestPath = join(packageDir, "package.json");
  const manifestInfo = statSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestInfo?.isFile()) {
    throw new Error(`packaged ripgrep package missing: ${manifestPath} (asarUnpack of node_modules/@vscode/ripgrep*/** drifted?)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== packageName) throw new Error(`wrong ripgrep package for ${target}: ${manifest.name}`);
  const binary = join(packageDir, "bin", platform === "win32" ? "rg.exe" : "rg");
  const binaryInfo = statSync(binary, { throwIfNoEntry: false });
  if (!binaryInfo?.isFile() || binaryInfo.size === 0) {
    throw new Error(`packaged ripgrep binary missing or empty: ${binary}`);
  }
  if (platform !== "win32") {
    try {
      accessSync(binary, fsConstants.X_OK);
    } catch {
      throw new Error(`packaged ripgrep binary is not executable: ${binary}`);
    }
  }
  return binary;
}

module.exports = { assertRipgrepRuntimeFiles, RIPGREP_LICENSE_NOTICES };
