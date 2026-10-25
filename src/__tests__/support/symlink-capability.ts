import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "vitest";

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
