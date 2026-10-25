// Base grants survive new conversations; sessionAdditionalDirectories does not. Allowing world-writable /tmp lets other local processes stage files the agent can touch, an accepted tradeoff bounded by sensitive-path sanitization, filesystem-root rejection and access auditing.
import { tmpdir } from "node:os";

// The conventional shared temp path on POSIX. Deliberately separate from tmpdir: on macOS `os.tmpdir` resolves to the per-user `$TMPDIR` (`/var/folders/…`), NOT `/tmp`; on CI it often resolves to a runner-specific directory. Covering only `os.tmpdir` would leave the path people actually type still denied.
export const POSIX_SHARED_TMP = "/tmp";

// Raw temp-directory candidates for the per-turn allow-list. Returned UNSANITIZED on purpose. The consumer is `getTurnAdditionalDirectories`, whose output reaches `buildAllowedScope` (`tools/pipeline/invocation-context.ts`), and that canonicalizes and case-folds every entry through `sanitizeAllowedDirectories`. Sanitizing here as well would produce entries normalized by the *runtime* variant, which preserves OS case — a different shape from the folded one the matcher compares against, and a contract `isPathAllowed` states explicitly. Duplicates and non-existent paths are likewise the scope builder's job.
export function baseAllowedDirectories(): readonly string[] {
  return process.platform === "win32" ? [tmpdir()] : [tmpdir(), POSIX_SHARED_TMP];
}
