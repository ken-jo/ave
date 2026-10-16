import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { preferAsarUnpackedPath } from "./asar-unpacked-path.js";

const require = createRequire(import.meta.url);

interface CodexPlatformTarget {
  readonly packageName: string;
  readonly targetTriple: string;
  readonly executableSuffix: "" | ".exe";
}

/**
 * The pinned `@openai/codex` package installs exactly one of these optional
 * platform packages. Each carries `vendor/<triple>/bin/codex[.exe]` under
 * `node_modules/@openai/codex*`, which package.json lists in `asarUnpack`, so
 * packaged builds execute it from `app.asar.unpacked`.
 */
const PLATFORM_TARGETS: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, CodexPlatformTarget>>>> = {
  darwin: {
    x64: { packageName: "@openai/codex-darwin-x64", targetTriple: "x86_64-apple-darwin", executableSuffix: "" },
    arm64: { packageName: "@openai/codex-darwin-arm64", targetTriple: "aarch64-apple-darwin", executableSuffix: "" },
  },
  linux: {
    x64: { packageName: "@openai/codex-linux-x64", targetTriple: "x86_64-unknown-linux-musl", executableSuffix: "" },
    arm64: { packageName: "@openai/codex-linux-arm64", targetTriple: "aarch64-unknown-linux-musl", executableSuffix: "" },
  },
  win32: {
    x64: { packageName: "@openai/codex-win32-x64", targetTriple: "x86_64-pc-windows-msvc", executableSuffix: ".exe" },
    arm64: { packageName: "@openai/codex-win32-arm64", targetTriple: "aarch64-pc-windows-msvc", executableSuffix: ".exe" },
  },
};

/** Which vendored executable of the platform package to resolve. */
export type CodexVendorExecutable = "codex";

const VENDOR_DIRECTORY: Record<CodexVendorExecutable, string> = {
  codex: "bin",
};

/**
 * Resolve a native executable shipped inside the pinned Codex platform
 * package. We deliberately never fall back to a PATH-resolved binary: every
 * argv value the callers pass is host-owned and the binary must be the one
 * package.json pins. `unavailable` builds the caller's domain error.
 */
export function resolveCodexVendorExecutable(
  executable: CodexVendorExecutable,
  unavailable: () => Error,
): string {
  const target = PLATFORM_TARGETS[process.platform]?.[process.arch];
  if (!target) throw unavailable();

  let packageJson: string;
  try {
    packageJson = require.resolve(`${target.packageName}/package.json`);
  } catch {
    throw unavailable();
  }
  const packagedPath = join(
    dirname(packageJson),
    "vendor",
    target.targetTriple,
    VENDOR_DIRECTORY[executable],
    `${executable}${target.executableSuffix}`,
  );
  const resolved = preferAsarUnpackedPath(packagedPath);
  if (resolved === null || !existsSync(resolved)) throw unavailable();
  return resolved;
}
