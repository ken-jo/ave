import { existsSync } from "node:fs";
import { sep } from "node:path";

/**
 * Resolve a packaged native executable to its physical `app.asar.unpacked`
 * copy. `require.resolve` reports a virtual path inside `app.asar`, which the
 * OS cannot execute; electron-builder extracts `asarUnpack` globs to the
 * sibling tree. A dev checkout has no `app.asar` segment and is returned as is.
 *
 * A path inside `app.asar` whose unpacked copy is missing returns `null`:
 * Electron's patched `fs` reports the virtual path as existing, so handing it
 * back would turn a packaging defect into an opaque spawn ENOENT/ENOTDIR
 * instead of the caller's own "unavailable" error.
 */
export function preferAsarUnpackedPath(
  candidate: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const asarSegment = `${sep}app.asar${sep}`;
  if (!candidate.includes(asarSegment)) return candidate;
  const unpacked = candidate.replace(asarSegment, `${sep}app.asar.unpacked${sep}`);
  return exists(unpacked) ? unpacked : null;
}
