// Container ranking fixtures state a policy as the shell's lists.
import { rankMxcFilesystem, type MxcDirectoryEntry, type MxcFilesystemGrants } from "../../permissions/mxc-windows.js";
import { shellPolicyModel, type MxcShellPolicyLists } from "../../tools/mxc-shell-launch.js";

export { shellPolicyModel as mxcPolicyModel };

/** Ranks a policy stated as lists. */
export function rankMxcLists(
  lists: MxcShellPolicyLists, exists: (path: string) => boolean, list?: (directory: string) => readonly MxcDirectoryEntry[],
): MxcFilesystemGrants {
  return rankMxcFilesystem(shellPolicyModel(lists), exists, list);
}
