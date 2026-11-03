import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutinesStore } from "../routines-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

// A store backed by `<scratch>/routines.json`; `cleanup` removes the scratch dir.
export function tempRoutinesStore(): {
  store: RoutinesStore;
  dir: string;
  cleanup: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "ave-routines-"));
  const store = new RoutinesStore(join(dir, "routines.json"));
  const cleanup = () => cleanupTmpDir(dir);
  return { store, dir, cleanup };
}

// ISO stamp `offsetMs` from now.
function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

// A schedule that is due later, never already past.
export function futureIso(offsetMs = 60_000): string {
  return isoFromNow(offsetMs);
}

// A schedule that is already due.
export function pastIso(offsetMs = -1000): string {
  return isoFromNow(offsetMs);
}

// The owner fields every add now names: the project it is listed under and who added it.
export const TEST_OWNER = { projectRoot: "/work/project", createdBy: "user" } as const;
