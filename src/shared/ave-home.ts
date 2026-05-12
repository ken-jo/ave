import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Single source of truth for the Ave user-data root.
 *
 * Default: `~/.ave` per architecture §5 + project CLAUDE.md storage
 * namespace convention.
 *
 * Override via `AVE_HOME` env — used by e2e fixtures to point host state at
 * a per-test temp dir so encrypted-secret blobs from a previous dev run on
 * `~/.ave/secrets/` do not bleed into isolated test runs. Consumers that
 * resolve Ave sub-paths MUST go through this helper rather than calling
 * `homedir()` directly, otherwise the env override leaks past one feature.
 */
export function aveHome(): string {
  return process.env.AVE_HOME ?? join(homedir(), ".ave");
}
