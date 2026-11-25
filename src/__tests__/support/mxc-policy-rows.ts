// Container ranking fixtures state a policy as six path lists; this turns them into policy rows.
import { rankMxcFilesystem, type MxcDirectoryEntry, type MxcFilesystemGrants } from "../../permissions/mxc-windows.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, type PolicyModel } from "../../permissions/policy-model.js";

export interface MxcPolicyLists {
  readonly allowWrite: readonly string[];
  readonly allowRead: readonly string[];
  /** Read denies a more specific grant re-opens. */
  readonly denyRead: readonly string[];
  /** The write floor. */
  readonly denyWrite: readonly string[];
  /** The protected read floor. */
  readonly protectedFloor: readonly string[];
  readonly floorPierces?: readonly string[];
}

export function mxcPolicyModel(lists: MxcPolicyLists): PolicyModel {
  return buildPolicyModel({
    floors: [
      ...lists.denyRead.map((path) => policyFloorRow(path, "denied", "read-boundary")),
      ...lists.denyWrite.map((path) => policyFloorRow(path, "ro", "protected-name")),
      ...lists.protectedFloor.map((path) => policyFloorRow(path, "denied", "secrets")),
    ],
    userGrants: [],
    extensionManifests: [],
    launchGrants: [
      ...lists.allowWrite.map((path) => policyGrantRow(path, "rw", "launch-grant")),
      ...lists.allowRead.map((path) => policyGrantRow(path, "ro", "launch-grant")),
      ...(lists.floorPierces ?? []).map((path) => policyGrantRow(path, "ro", "floor-pierce")),
    ],
  });
}

/** Ranks a policy stated as lists. */
export function rankMxcLists(
  lists: MxcPolicyLists, exists: (path: string) => boolean, list?: (directory: string) => readonly MxcDirectoryEntry[],
): MxcFilesystemGrants {
  return rankMxcFilesystem(mxcPolicyModel(lists), exists, list);
}
