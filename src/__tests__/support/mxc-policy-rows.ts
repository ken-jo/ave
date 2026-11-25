// Container ranking fixtures state a policy as six path lists; this turns them into policy rows and back.
import { rankMxcFilesystem, type MxcDirectoryEntry, type MxcFilesystemGrants } from "../../permissions/mxc-windows.js";
import {
  buildPolicyModel, isPolicyFloorRow, policyFloorRow, policyGrantRow, type PolicyModel, type PolicyRow,
} from "../../permissions/policy-model.js";

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
      ...lists.allowWrite.map((path) => policyGrantRow(path, "rw", "launch-grant", null)),
      ...lists.allowRead.map((path) => policyGrantRow(path, "ro", "launch-grant", null)),
      ...(lists.floorPierces ?? []).map((path) => policyGrantRow(path, "ro", "floor-pierce", null)),
    ],
  });
}

export function mxcPolicyLists(model: PolicyModel): Required<MxcPolicyLists> {
  const paths = (keep: (row: PolicyRow) => boolean): string[] => model.rows.filter(keep).map((row) => row.path);
  const grant = (row: PolicyRow): boolean => !isPolicyFloorRow(row) && row.reason !== "floor-pierce";
  return {
    allowWrite: paths((row) => grant(row) && row.access === "rw"),
    allowRead: paths((row) => grant(row) && row.access === "ro"),
    denyRead: paths((row) => isPolicyFloorRow(row) && row.access === "denied" && row.reason !== "secrets"),
    denyWrite: paths((row) => isPolicyFloorRow(row) && row.access === "ro"),
    protectedFloor: paths((row) => row.reason === "secrets"),
    floorPierces: paths((row) => row.reason === "floor-pierce"),
  };
}

/** Ranks a policy stated as lists. */
export function rankMxcLists(
  lists: MxcPolicyLists, exists: (path: string) => boolean, list?: (directory: string) => readonly MxcDirectoryEntry[],
): MxcFilesystemGrants {
  return rankMxcFilesystem(mxcPolicyModel(lists), exists, list);
}
