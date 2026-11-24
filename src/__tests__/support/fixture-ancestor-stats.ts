import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { dirname } from "node:path";
import { vi } from "vitest";

const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const nativeFsPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

/** Isolate unrelated workers' temporary-directory churn, retaining real fixture evidence. */
export function stabilizeFixtureAncestorStats(root: string): void {
  const ancestors = new Map<string, fs.BigIntStats>();
  for (let path = dirname(root); ; path = dirname(path)) {
    ancestors.set(path, nativeFs.lstatSync(path, { bigint: true }));
    if (dirname(path) === path) break;
  }
  const stabilize = <T>(path: unknown, options: unknown, stat: T): T => {
    const baseline = typeof path === "string" ? ancestors.get(path) : undefined;
    if (options !== undefined && options !== null && typeof options === "object" && (options as { bigint?: boolean }).bigint === true
      && stat !== undefined && baseline !== undefined) {
      // Only shared ancestors outside the owned fixture are stabilized. Current
      // identity, type, ownership and permissions still come from the filesystem.
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        size: baseline.size, nlink: baseline.nlink, mtimeNs: baseline.mtimeNs, ctimeNs: baseline.ctimeNs,
      });
    }
    return stat;
  };
  vi.spyOn(fs, "lstatSync").mockImplementation(((path, options) => stabilize(path, options, nativeFs.lstatSync(path, options))) as typeof fs.lstatSync);
  // The asynchronous inspection driver reads the same ancestors; callers mock node:fs/promises with { spy: true }.
  vi.spyOn(fsPromises, "lstat").mockImplementation((async (path: fs.PathLike, options?: fs.StatOptions) =>
    stabilize(path, options, await nativeFsPromises.lstat(path, options))) as typeof fsPromises.lstat);
}
