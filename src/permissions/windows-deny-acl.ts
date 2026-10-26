import { resolve } from "node:path";
import { admitWindowsReparse, leadingWindowsDenies, readWindowsDacls } from "../shared/windows-path-facts.js";

export const WINDOWS_READ_DENY_MASK = 0x1f01ff;
export const WINDOWS_WRITE_DENY_MASK = 0x10116;

export interface WindowsDenyAcl {
  readonly denyMask: number;
  readonly inheritableMask: number;
  readonly parentMask: number;
  readonly directory: boolean;
}

export function readWindowsDenyAcls(paths: readonly string[], sandboxUserSid: string): readonly WindowsDenyAcl[] {
  try {
    return readWindowsDacls(paths.map(path => resolve(path)), { parent: true }).map(row => {
      if (!admitWindowsReparse(row, "evidence")) throw new Error("Reparse path refused");
      const target = leadingWindowsDenies(row.dacl, sandboxUserSid);
      if (!row.exists) return { denyMask: 0, inheritableMask: 0, parentMask: 0, directory: false };
      if (!row.parent) throw new Error("Deny DACL parent is missing");
      return { denyMask: target.mask, inheritableMask: target.inheritable,
        parentMask: leadingWindowsDenies(row.parent, sandboxUserSid).mask, directory: row.directory };
    });
  } catch (error) {
    throw new Error("Windows deny DACL verification failed", { cause: error });
  }
}
