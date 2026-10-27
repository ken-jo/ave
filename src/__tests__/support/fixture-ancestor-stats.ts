import * as fs from "node:fs";
import { dirname } from "node:path";
import { vi } from "vitest";

const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");

/** Isolate unrelated workers' temporary-directory churn, retaining real fixture evidence. */
export function stabilizeFixtureAncestorStats(root: string): void {
  const ancestors = new Map<string, fs.BigIntStats>();
  for (let path = dirname(root); ; path = dirname(path)) {
    ancestors.set(path, nativeFs.lstatSync(path, { bigint: true }));
    if (dirname(path) === path) break;
  }
  vi.spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
    const stat = nativeFs.lstatSync(path, options);
    const baseline = typeof path === "string" ? ancestors.get(path) : undefined;
    if (options !== undefined && typeof options === "object" && options.bigint === true
      && stat !== undefined && baseline !== undefined) {
      // Only shared ancestors outside the owned fixture are stabilized. Current
      // identity, type, ownership and permissions still come from the filesystem.
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        size: baseline.size, nlink: baseline.nlink, mtimeNs: baseline.mtimeNs, ctimeNs: baseline.ctimeNs,
      });
    }
    return stat;
  }) as typeof fs.lstatSync);
}
