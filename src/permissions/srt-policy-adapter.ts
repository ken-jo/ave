// The one place policy rows become the sandbox runtime package's shape.
//
// Package types are still imported, on purpose, by the modules that build or feed a package config: asrt-sandbox.ts,
// sandbox-write-policy.ts, windows-stamp-targets.ts, offline-process-sandbox.ts, and egress-ask.ts with egress-runtime.ts (their
// callback is handed to the package's proxy). No container adapter imports them. All of these imports, and this file, go when the
// package dependency goes.
import type { FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";
import { isPolicyFloorRow, policyFloorRow, type PolicyFloorRow, type PolicyModel } from "./policy-model.js";

/** The four filesystem lists of a sandbox runtime package config, in the package's own entry types. */
export interface SrtFilesystemLists {
  readonly allowRead: string[];
  readonly allowWrite: string[];
  readonly denyRead: string[];
  readonly denyWrite: FilesystemPathEntry[];
}

/**
 * Projects policy rows onto the sandbox runtime package's filesystem lists. Every package-shaped config Ave builds, the Windows
 * helper's and the macOS/Linux wrap's alike, takes its lists from this one function.
 *
 * Rows keep their order inside each list and nothing is merged. A composer that omits a list from its config (a per-command config
 * replaces only the lists it names) still decides that itself.
 *
 * This is a projection only. It does not withhold a grant beneath a `secrets` row: the caller must have filtered its read grants
 * (`readGrantsOutsideReadDenies` in asrt-sandbox.ts) before stating them, as both composers there do.
 *
 * @deprecated Throwaway adapter. It exists only while Ave still launches through the sandbox runtime package, and it is deleted
 * together with that package dependency. Do not add callers outside the code that builds a package config.
 */
export function toSrtConfig(model: PolicyModel): SrtFilesystemLists {
  const lists: SrtFilesystemLists = { allowRead: [], allowWrite: [], denyRead: [], denyWrite: [] };
  for (const row of model.rows) {
    if (row.reason === "floor-pierce") {
      // The package has no list for it: its composers withhold floored grants before they state their rows.
      throw new Error(`Sandbox runtime config cannot carry a floor pierce: ${row.path}`);
    }
    if (isPolicyFloorRow(row) && row.access === "ro") {
      lists.denyWrite.push(row.literal ? { path: row.path, literal: true } : row.path);
      continue;
    }
    // Only write-floor rows are ever marked literal by the package's composers; the other lists are replayed as plain spellings.
    // So a model whose every row is literal, such as a container admission's, is refused here rather than replayed as patterns.
    if (row.literal) throw new Error(`Sandbox runtime config carries literal rows only on the write floor: ${row.reason} ${row.access}`);
    if (isPolicyFloorRow(row)) lists.denyRead.push(row.path);
    else if (row.access === "rw") lists.allowWrite.push(row.path);
    else lists.allowRead.push(row.path);
  }
  return lists;
}

/** A package path entry as a write-floor row. */
export function srtWriteFloorRow(entry: FilesystemPathEntry): PolicyFloorRow {
  return typeof entry === "string" ? policyFloorRow(entry, "ro", "protected-name", false) : policyFloorRow(entry.path, "ro", "protected-name", true);
}
