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
  // Writes are bound to the host-captured envelope everywhere, not only inside plugin namespaces.
  for (const grant of input.allowWrite) {
    if (!ownership.writeRoots.some(root => isWindowsPathAtOrUnder(grant, root))) {
      throw new MxcProcessContractError("Container filesystem write grant is outside this holder's captured write roots");
    }
  }
}

/** HOME/temp must be inside the captured write envelope and outside the shared private HOME/temp/handoff roots. */
export function assertMxcHolderPrivateDirectories(input: {
  readonly home: string;
  readonly temp: string;
  readonly ownership: MxcExtensionFilesystemOwnership;
  readonly sharedPrivateRoots: readonly string[];
}): void {
  for (const directory of [input.home, input.temp]) {
    if (!input.ownership.writeRoots.some(root => isWindowsPathAtOrUnder(directory, root))) {
      throw new MxcProcessContractError("Container HOME and temp must lie inside this holder's captured write roots");
    }
    // Ancestor enumerate grants on a shared private root would list every other holder's leaf there.
    if (input.sharedPrivateRoots.some(root => isWindowsPathAtOrUnder(directory, root))) {
      throw new MxcProcessContractError("Container HOME and temp must use a dedicated staging tree, not the shared private roots");
    }
  }
}

/** Holder adapters (rows 3–5) place HOME and temp at exactly `<AVE_HOME>\mxc-staging\<opaque-id>\home` and `…\temp`,
 * where the id is 32 lowercase hex digits (no plugin ID or other name). Every spelling Win32 would alias is refused:
 * each path must already be in `win32.normalize` form (no `.`/`..` or forward slash) with no trailing separator, which `normalize` keeps, the leaf
 * names are the exact lowercase literals (no case alias, trailing dot or space, or `:` stream suffix), and the parent
 * is compared exactly. The planner forms these with `win32.join` and passes them on unchanged. Returns the staging
 * directory, which the adapter grants as the holder's private write root. */
export function assertMxcHolderStaging(input: { readonly aveHome: string; readonly home: string; readonly temp: string }): string {
  const staging = winPath.dirname(input.home);
  const id = winPath.basename(staging);
  const canonical = (path: string): boolean => winPath.normalize(path) === path && !/[\\/]$/u.test(path);
  if (!canonical(input.home) || !canonical(input.temp)
      || winPath.basename(input.home) !== "home" || winPath.basename(input.temp) !== "temp"
      || winPath.dirname(input.temp) !== staging || !/^[0-9a-f]{32}$/u.test(id)
      || staging !== winPath.join(input.aveHome, "mxc-staging", id)) {
    throw new MxcProcessContractError("Container HOME and temp must be <AVE_HOME>\\mxc-staging\\<opaque-id>\\home and \\temp");
  }
  return staging;
}
