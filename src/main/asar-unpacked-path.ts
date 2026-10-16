import { existsSync } from "node:fs";
import { sep } from "node:path";

/**
 * Resolve a packaged native executable to its physical `app.asar.unpacked`
 * copy. `require.resolve` reports a virtual path inside `app.asar`, which the
 * OS cannot execute; electron-builder extracts `asarUnpack` globs to the
 * sibling tree. A dev checkout has no `app.asar` segment and is returned as is.
 */
export function preferAsarUnpackedPath(candidate: string): string {
  const asarSegment = `${sep}app.asar${sep}`;
  if (!candidate.includes(asarSegment)) return candidate;
  const unpacked = candidate.replace(asarSegment, `${sep}app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : candidate;
}
