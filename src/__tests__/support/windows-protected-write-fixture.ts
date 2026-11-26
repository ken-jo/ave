import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_NAMED_ENTRIES } from "../../permissions/sandbox-write-policy.js";

export function createWindowsProtectedWriteTargets(root: string, missing?: string): string[] {
  const targets = SANDBOX_NAMED_ENTRIES.filter(entry => entry !== missing).map(entry => join(root, entry));
  for (const target of targets) mkdirSync(target, { recursive: true });
  return targets;
}
