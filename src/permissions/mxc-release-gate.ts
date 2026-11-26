import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A one-use marker in the already-proved host-only runtime root. */
export function createMxcReleaseGate(root: string): { path: string; revoke(): void } {
  const path = join(root, `release-${randomUUID()}`);
  writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  return { path, revoke() {
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } };
}
