import { createRequire } from "node:module";

// Use the host filesystem even in suites that replace filesystem modules.
const nodeRequire = createRequire(import.meta.url);
const { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } = nodeRequire("node:fs") as typeof import("node:fs");
const { tmpdir } = nodeRequire("node:os") as typeof import("node:os");
const { join } = nodeRequire("node:path") as typeof import("node:path");

const capabilities = new Map<string, boolean>();

/** Skip dependent cases only when the host refuses unprivileged symlink creation. */
export function canCreateSymlinks(kind: "file" | "dir" | "junction" = "file"): boolean {
  const cached = capabilities.get(kind);
  if (cached !== undefined) return cached;
  let available: boolean;
  const root = mkdtempSync(join(tmpdir(), "ave-symlink-capability-"));
  try {
    const target = join(root, "target");
    if (kind === "file") writeFileSync(target, "probe");
    else mkdirSync(target);
    symlinkSync(target, join(root, "link"), kind);
    available = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    available = false;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  capabilities.set(kind, available);
  return available;
}
