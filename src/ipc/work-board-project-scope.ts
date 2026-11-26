import type { WebContents, WebFrameMain } from "electron";
import { resolveAuthorizedWorkspaceProject } from "../main/project-root-authorization.js";
import type { MainWindow } from "../main/main-window-host.js";
import { WORK_BOARD } from "../shared/ipc-channels.js";
import { projectRootEquals, type ProjectIdentity } from "../shared/project-identity.js";
import type { WorkBoardRunEvent } from "../shared/work-board-types.js";
import { fanOutToAllWindows, type FanOutOptions } from "./window-fanout.js";

const observed = new WeakSet<WebContents>();
const scopes = new WeakMap<WebContents, { frame: WebFrameMain; project: ProjectIdentity }>();

export function setWorkBoardProjectScope(contents: WebContents, root: unknown): boolean {
  scopes.delete(contents);
  if (typeof root !== "string" || !root) return false;
  const resolved = resolveAuthorizedWorkspaceProject(root);
  if (!resolved.authorized || !resolved.project) return false;
  if (!observed.has(contents)) {
    observed.add(contents);
    contents.on("did-start-navigation", details => {
      if (details.isMainFrame && !details.isSameDocument) scopes.delete(contents);
    });
    contents.on("render-process-gone", () => scopes.delete(contents));
  }
  scopes.set(contents, { frame: contents.mainFrame, project: resolved.project });
  return true;
}

export function workBoardProjectAllows(contents: WebContents | undefined, root: string | undefined): boolean {
  if (!contents || contents.isDestroyed()) return false;
  const scope = scopes.get(contents);
  if (!scope || scope.frame !== contents.mainFrame) return false;
  if (!root) return scope.project.isDefault === true;
  const resolved = resolveAuthorizedWorkspaceProject(root);
  return resolved.authorized && projectRootEquals(resolved.project?.projectRoot, scope.project.projectRoot);
}

export function deliverWorkBoardProgress(
  windows: Array<MainWindow | null | undefined>, event: WorkBoardRunEvent, projectRoot: string | undefined, options?: FanOutOptions,
): void {
  fanOutToAllWindows(windows.filter(window => window && !window.isDestroyed() && workBoardProjectAllows(window.webContents, projectRoot)),
    WORK_BOARD.runProgress, event, options);
}
