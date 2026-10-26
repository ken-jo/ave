import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { resolveWindowsPathKindHelper } from "../main/windows-path-kind-launcher.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

export const WINDOWS_READ_DENY_MASK = 0x1f01ff;
export const WINDOWS_WRITE_DENY_MASK = 0x10116;

export interface WindowsDenyAcl {
  readonly denyMask: number;
  readonly inheritableMask: number;
  readonly parentMask: number;
  readonly directory: boolean;
}

// One short native call keeps obligation capture through publication in the same
// event-loop turn. No child-process binding is evaluated on import.
export function readWindowsDenyAcls(paths: readonly string[], sandboxUserSid: string): readonly WindowsDenyAcl[] {
  if (paths.length === 0) return [];
  const targets = paths.map(path => resolve(path));
  const identities = targets.map(path => lstatSync(path, { bigint: true, throwIfNoEntry: false }));
  try {
    const output = execFileSync(resolveWindowsPathKindHelper(), ["--deny-acls", sandboxUserSid, ...targets], {
      encoding: "utf8", windowsHide: true,
      timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBuffer: 2 * 1024 * 1024,
    });
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows) || rows.length !== paths.length) throw new Error("Invalid deny DACL response");
    return rows.map((row: WindowsDenyAcl, index) => {
      if (row === null || typeof row !== "object" || typeof row.directory !== "boolean"
        || [row.denyMask, row.inheritableMask, row.parentMask].some(mask => !Number.isInteger(mask) || mask < 0 || mask > 0xffffffff)) {
        throw new Error("Invalid deny DACL masks");
      }
      const before = identities[index];
      const after = lstatSync(targets[index]!, { bigint: true, throwIfNoEntry: false });
      if (before?.dev !== after?.dev || before?.ino !== after?.ino || after?.isSymbolicLink()) {
        throw new Error("Deny DACL object identity changed");
      }
      return row;
    });
  } catch (error) {
    throw new Error("Windows deny DACL verification failed", { cause: error });
  }
}
