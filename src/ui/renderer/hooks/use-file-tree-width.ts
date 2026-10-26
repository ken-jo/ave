import type { AveApi } from "../types.js";
import { FILE_TREE_WIDTH_PREF, usePanelWidth } from "./use-panel-width.js";

/** Files share the shell's persisted-width lifecycle without retaining a second split preference. */
export function useFileTreeWidth(api: AveApi) {
  const { width, setWidth, commitWidth } = usePanelWidth(api, FILE_TREE_WIDTH_PREF);
  return { treeWidth: width, setTreeWidth: setWidth, commitTreeWidth: commitWidth };
}
