#!/usr/bin/env node
import { resolve } from "node:path";
import { archSpec, auditLinuxRelease } from "./lib/linux-package-arch.mjs";

function parseArgs(argv) {
  let releaseDir = null;
  let arch = null;
  let requireInstallers = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--release-dir" || arg === "--arch") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--release-dir") releaseDir = value;
      else arch = value;
      i += 1;
    } else if (arg === "--require-installers") {
      requireInstallers = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!releaseDir) throw new Error("--release-dir is required");
  if (!arch) throw new Error("--arch is required");
  archSpec(arch);
  return { releaseDir: resolve(releaseDir), arch, requireInstallers };
}

try {
  const { releaseDir, arch, requireInstallers } = parseArgs(process.argv.slice(2));
  const { violations, checked } = auditLinuxRelease(releaseDir, arch, { requireInstallers });
  for (const { path, file } of checked) process.stdout.write(`[linux-arch] ${path}: ${file}\n`);
  if (violations.length > 0) {
    for (const violation of violations) process.stderr.write(`[linux-arch] FAIL ${violation}\n`);
    process.stderr.write(`[linux-arch] ${violations.length} violation(s): the package is not pure ${arch}\n`);
    process.exit(1);
  }
  process.stdout.write(`[linux-arch] OK: ${checked.length} binaries are ${arch}${requireInstallers ? " (unpacked app, AppImage, deb, rpm)" : " (unpacked app)"}\n`);
} catch (err) {
  process.stderr.write(`[linux-arch] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
