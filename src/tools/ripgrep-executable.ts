import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { preferAsarUnpackedPath } from "../main/asar-unpacked-path.js";

const require = createRequire(import.meta.url);

/**
 * Release targets and the platform package that carries each one's ripgrep
 * binary. The packages select themselves by `os`/`cpu`, so exactly one is
 * installed per target; `scripts/lib/ripgrep-runtime-files.cjs` holds the same
 * table for the packaging assertions and a lock suite keeps the two equal.
 */
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

/**
 * Resolve the ripgrep executable that package.json pins for this platform.
 * There is deliberately no PATH fallback: every argv value the caller passes
 * is host-owned and the binary must be the pinned one. `unavailable` builds
 * the caller's domain error.
 */
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
