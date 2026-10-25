import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { preferAsarUnpackedPath } from "../main/asar-unpacked-path.js";

const require = createRequire(import.meta.url);

// Platform packages select the bundled binary; packaging assertions share this table through scripts/lib/ripgrep-runtime-files.cjs.
export const RIPGREP_PLATFORM_PACKAGES = Object.freeze({
  "darwin-x64": "@vscode/ripgrep-darwin-x64",
  "darwin-arm64": "@vscode/ripgrep-darwin-arm64",
  "linux-x64": "@vscode/ripgrep-linux-x64",
  "linux-arm64": "@vscode/ripgrep-linux-arm64",
  "win32-x64": "@vscode/ripgrep-win32-x64",
  "win32-arm64": "@vscode/ripgrep-win32-arm64",
} as const);

type RipgrepTarget = keyof typeof RIPGREP_PLATFORM_PACKAGES;

function isRipgrepTarget(value: string): value is RipgrepTarget {
  return Object.prototype.hasOwnProperty.call(RIPGREP_PLATFORM_PACKAGES, value);
}

// Resolve only the pinned platform binary, never PATH; callers supply the domain-specific unavailable error.
export function resolvePinnedRipgrepExecutable(
  unavailable: () => Error,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const target = `${platform}-${arch}`;
  if (!isRipgrepTarget(target)) throw unavailable();
  let packageJson: string;
  try {
    packageJson = require.resolve(`${RIPGREP_PLATFORM_PACKAGES[target]}/package.json`);
  } catch {
    throw unavailable();
  }
  const binary = join(dirname(packageJson), "bin", platform === "win32" ? "rg.exe" : "rg");
  const resolved = preferAsarUnpackedPath(binary);
  if (resolved === null || !existsSync(resolved)) throw unavailable();
  return resolved;
}
