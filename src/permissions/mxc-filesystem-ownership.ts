import { win32 as winPath } from "node:path";
import { isWindowsPathAtOrUnder } from "./mxc-windows.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";

/** Host-captured generation/data/socket/run ownership, independent of a child's requested grants. */
export interface MxcExtensionFilesystemOwnership {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly hostStorageRoots: readonly string[];
}

/** A literal allow-list cannot safely carve broad plugin grants back into unrelated private holders. */
export function assertMxcExtensionFilesystemOwnership(input: {
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly pluginNamespaceRoots: readonly string[];
  readonly ownership?: MxcExtensionFilesystemOwnership;
}): void {
  const ownership = input.ownership ?? { readRoots: [], writeRoots: [], hostStorageRoots: [] };
  const namespaces = input.pluginNamespaceRoots;
  const atOrAboveNamespace = (path: string): boolean => namespaces.some(root => isWindowsPathAtOrUnder(root, path));
  const intersects = (left: string, right: string): boolean =>
    isWindowsPathAtOrUnder(left, right) || isWindowsPathAtOrUnder(right, left);
  const storageOverlap = (path: string): boolean => ownership.hostStorageRoots.some(storage => intersects(path, storage));
  for (const path of [...ownership.readRoots, ...ownership.writeRoots, ...ownership.hostStorageRoots]) {
    if (!/^[a-z]:\\/iu.test(path) || /[\0*?\[\]%]/u.test(path) || winPath.parse(path).root === winPath.normalize(path)) {
      throw new MxcProcessContractError("Container filesystem ownership requires literal non-root paths");
    }
  }
  for (const root of [...ownership.readRoots, ...ownership.writeRoots]) {
    if (atOrAboveNamespace(root) || storageOverlap(root)) {
      throw new MxcProcessContractError("Container filesystem ownership reaches another holder or host storage");
    }
  }
  const check = (grants: readonly string[], ownRoots: readonly string[]): void => {
    for (const grant of grants) {
      if (atOrAboveNamespace(grant) || storageOverlap(grant)) {
        throw new MxcProcessContractError("Container filesystem grant reaches another holder or host storage");
      }
      if (namespaces.some(root => isWindowsPathAtOrUnder(grant, root))
          && !ownRoots.some(root => isWindowsPathAtOrUnder(grant, root))) {
        throw new MxcProcessContractError("Container filesystem grant is outside this holder's owned roots");
      }
    }
  };
  check(input.allowRead, [...ownership.readRoots, ...ownership.writeRoots]);
  check(input.allowWrite, ownership.writeRoots);
}
