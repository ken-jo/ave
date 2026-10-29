import { isPathAllowed } from "../permissions/allowed-directories.js";
import { caseFoldForMatch, foldCanonicalPathSeparators } from "../permissions/sensitive-paths.js";

/** Automatic writes require both the declared location and its resolved target inside project roots. */
export function areProjectWriteTargetsInside(
  targets: readonly { filePath: string; canonicalPath: string }[],
  lexicalRoots: readonly string[],
  canonicalRoots: readonly string[],
  declaredPaths?: readonly string[],
): boolean {
  // Resolution can erase drive-relative or current-drive-rooted syntax.
  if (process.platform === "win32" && declaredPaths?.some((path) =>
    /^[a-z]:[^/\\]/i.test(path) || /^[a-z]:$/i.test(path) || /^[\\/]/.test(path))) return false;
  return targets.length > 0 && targets.every((target) => {
    const lexical = caseFoldForMatch(foldCanonicalPathSeparators(target.filePath));
    const canonical = caseFoldForMatch(foldCanonicalPathSeparators(target.canonicalPath));
    // Only fully qualified local-drive paths enter the automatic Windows lane.
    // Network, device and drive-relative paths retain ordinary permission routing.
    if (process.platform === "win32" && (!/^[a-z]:\//.test(lexical) || !/^[a-z]:\//.test(canonical))) return false;
    return isPathAllowed(lexical, { directories: lexicalRoots })
      && isPathAllowed(canonical, { directories: canonicalRoots });
  });
}
