// Container ranking fixtures state a policy as the shell's lists.
import { admitMxcFilesystem, rankMxcFilesystem, rankMxcRowsBySpelling, type MxcDirectoryEntry, type MxcFilesystemGrants, type MxcSpelledGrants } from "../../permissions/mxc-windows.js";
import type { ObligationSet } from "../../permissions/admitted-obligation.js";
import { shellPolicyModel, type MxcShellPolicyLists } from "../../tools/mxc-shell-launch.js";

export { shellPolicyModel as mxcPolicyModel };

/** Ranks a policy stated as lists by spelling, on a simulated layout. */
export function rankMxcLists(
  lists: MxcShellPolicyLists, exists: (path: string) => boolean, list?: (directory: string) => readonly MxcDirectoryEntry[],
): MxcSpelledGrants {
  return rankMxcRowsBySpelling(shellPolicyModel(lists), exists, list);
}

/** Ranks a policy stated as lists through admission, on the real filesystem. */
export function rankAdmittedMxcLists(lists: MxcShellPolicyLists): MxcFilesystemGrants {
  return rankMxcFilesystem(shellPolicyModel(lists));
}

/** Admits the literal rows of a policy stated as lists, as a container launch does. */
export function admitMxcLists(lists: MxcShellPolicyLists): ObligationSet {
  return admitMxcFilesystem(shellPolicyModel(lists));
}
