import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { TestContext } from "vitest";

/**
 * Skips the running test, with a reason, when `directory`'s filesystem refuses
 * unprivileged symlink creation. It probes through the module's own `node:fs`
 * import, so a suite that mocks `symlinkSync` sees its mock here.
 */
export function requireSymlinkCapability(directory: string, type: "file" | "dir", skip: TestContext["skip"]): void {
  const root = mkdtempSync(join(directory, "symlink-probe-"));
  try {
    const target = join(root, "target");
    if (type === "dir") mkdirSync(target);
    else writeFileSync(target, "probe");
    try {
      symlinkSync(target, join(root, "link"), type);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") skip("Symlink creation requires an unavailable privilege");
      throw error;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// canCreateSymlinks uses the host filesystem even in suites that replace
// filesystem modules, since it runs at collection time for `it.skipIf`.
const nodeRequire = createRequire(import.meta.url);
const hostFs = nodeRequire("node:fs") as typeof import("node:fs");
const { tmpdir } = nodeRequire("node:os") as typeof import("node:os");
const hostPath = nodeRequire("node:path") as typeof import("node:path");

const capabilities = new Map<string, boolean>();

/** Skip dependent cases only when the host refuses unprivileged symlink creation. */
export function canCreateSymlinks(kind: "file" | "dir" | "junction" = "file"): boolean {
  const cached = capabilities.get(kind);
  if (cached !== undefined) return cached;
  let available: boolean;
  const root = hostFs.mkdtempSync(hostPath.join(tmpdir(), "ave-symlink-capability-"));
  try {
    const target = hostPath.join(root, "target");
    if (kind === "file") hostFs.writeFileSync(target, "probe");
    else hostFs.mkdirSync(target);
    hostFs.symlinkSync(target, hostPath.join(root, "link"), kind);
    available = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    available = false;
  } finally {
    hostFs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  capabilities.set(kind, available);
  return available;
}
