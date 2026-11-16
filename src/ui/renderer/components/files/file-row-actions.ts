/** What a person can do with one file or folder row. Both file explorers (the folder view's columns and the side panel's
 * tree) build their row menu from this one list, so a row offers the same actions wherever it is shown. */
import { FileSymlink, FolderOpen, Link2, MessageSquarePlus, Route, SquareTerminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AttachTextResult } from "../../preview/composer-targets.js";
import { relativeToRoot } from "../folder-view/folder-columns.js";
import { revealKey } from "../folder-view/FolderColumn.js";

type FileRowActionId = "open" | "reveal" | "copy-path" | "copy-relative-path" | "add-to-chat" | "open-terminal";

export interface FileRowTarget {
  path: string;
  type: "file" | "directory" | "link";
  /** Links only: the target is outside the project. */
  outside?: boolean | undefined;
  /** The folder that holds the row. */
  parent: string;
  /** The project root the relative path is counted from; null for a row outside every project. */
  root: string | null;
}

/** What the surrounding explorer can do; an action whose capability is absent is not offered. */
export interface FileRowActionHost {
  /** Open the row where the explorer shows things: a file in its viewer, a folder as its next level. */
  open?: (() => void) | undefined;
  /** Put a reference to `path` into a chat composer. */
  addToChat?: ((path: string) => AttachTextResult) | undefined;
  openTerminal?: ((dir: string) => void) | undefined;
  /** Show (or with null, clear) the i18n key of a failure next to the list. Every action clears it first. */
  report: (messageKey: string | null) => void;
}

export interface FileRowAction {
  id: FileRowActionId;
  /** i18n key of the menu label. */
  labelKey: string;
  icon: LucideIcon;
  run: () => void;
}

function copyText(text: string, host: FileRowActionHost): void {
  void navigator.clipboard.writeText(text).then(undefined, () => host.report("folderView.copyFailed"));
}

export function fileRowActions(target: FileRowTarget, host: FileRowActionHost): FileRowAction[] {
  const actions: FileRowAction[] = [];
  const act = (run: () => void) => () => { host.report(null); run(); };
  if (host.open && target.type !== "link") actions.push({ id: "open", labelKey: "chatPreviewRail.ctxOpen", icon: FileSymlink, run: act(host.open) });
  // A link that leaves the project is not handed to the file manager, which would open where it points.
  if (!(target.type === "link" && target.outside)) {
    actions.push({ id: "reveal", labelKey: revealKey(), icon: FolderOpen, run: act(() => {
      void window.ave.workspace.reveal(target.path).then(
        (result) => { if (!result.ok) host.report("folderView.revealFailed"); },
        () => host.report("folderView.revealFailed"),
      );
    }) });
  }
  actions.push({ id: "copy-path", labelKey: "folderView.copyPath", icon: Link2, run: act(() => copyText(target.path, host)) });
  if (target.root !== null) {
    const root = target.root;
    actions.push({ id: "copy-relative-path", labelKey: "folderView.copyRelativePath", icon: Route,
      run: act(() => copyText(relativeToRoot(root, target.path), host)) });
  }
  if (host.addToChat && target.type !== "link") {
    const addToChat = host.addToChat;
    actions.push({ id: "add-to-chat", labelKey: "folderView.addToContext", icon: MessageSquarePlus, run: act(() => {
      const result = addToChat(target.path);
      if (result !== true) host.report(result === false ? "folderView.addToContextFull" : "folderView.addToContextNoComposer");
    }) });
  }
  if (host.openTerminal && target.type !== "link") {
    const openTerminal = host.openTerminal;
    // A folder opens itself; a file opens the folder it is in.
    actions.push({ id: "open-terminal", labelKey: "folderView.openTerminalHere", icon: SquareTerminal,
      run: act(() => openTerminal(target.type === "directory" ? target.path : target.parent)) });
  }
  return actions;
}
