import { existsSync } from "node:fs";
import { sep } from "node:path";

// Native executables need the physical app.asar.unpacked path; virtual ASAR paths cannot be spawned. Return null when the unpacked copy is missing, even
// if patched fs reports the virtual path exists.
export function preferAsarUnpackedPath(
  candidate: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const asarSegment = `${sep}app.asar${sep}`;
  if (!candidate.includes(asarSegment)) return candidate;
  const unpacked = candidate.replace(asarSegment, `${sep}app.asar.unpacked${sep}`);
  return exists(unpacked) ? unpacked : null;
}
