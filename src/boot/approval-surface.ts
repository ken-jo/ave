import type { BrowserWindow, WebContents } from "electron";
import { sideChatOwnerWindow } from "../main/app-state.js";
import { approvalConversationRoot } from "../permissions/user-approval-store.js";
import type { BootHost } from "./host-runtime.js";

interface ApprovalConversationSurfaces {
  readonly sideChatConversationLoop?: { getSessionId(): string };
  readonly paneChatLoops?: { holding(sessionId: string): { windowId: number } | undefined };
}

/** Attributed approvals belong only to the conversation's current live owner. */
export function approvalSurfaceResolver(
  host: Pick<BootHost, "desktop">,
  getMainWindow: () => BrowserWindow | null,
  conversations: ApprovalConversationSurfaces,
): (sessionId: string | undefined, terminalTabId?: string) => WebContents | null {
  return (sessionId, terminalTabId) => {
    const desktop = host.desktop;
    if (!desktop) return null;
    // An unavailable terminal owner does not transfer authority to the session owner.
    if (terminalTabId !== undefined) return desktop.findTerminalSurface(terminalTabId);
    if (sessionId === undefined) {
      const active = getMainWindow();
      return active && !active.isDestroyed() && !active.webContents.isDestroyed()
        ? active.webContents
        : null;
    }

    const rootSessionId = approvalConversationRoot(sessionId);
    const mainChatOwner = desktop.findSessionSurface(rootSessionId);
    if (mainChatOwner) return mainChatOwner;
    // These loops are installed after the gate; inspect current boot state per call.
    if (conversations.sideChatConversationLoop?.getSessionId() === rootSessionId) {
      return sideChatOwnerWindow()?.webContents ?? null;
    }
    const pane = conversations.paneChatLoops?.holding(rootSessionId);
    if (!pane) return null;
    const owner = desktop.getAppWindows().find((window) => window.id === pane.windowId);
    return owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()
      ? owner.webContents
      : null;
  };
}
