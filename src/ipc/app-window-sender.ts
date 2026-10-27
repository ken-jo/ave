import { session, type IpcMainInvokeEvent } from "electron";
import type { IpcDeps } from "./types.js";
import { validateHostRendererSender } from "./gated.js";

/** Privileged panel actions belong only to a live registered app window's main frame. */
export function validateAppWindowMainFrameSender(
  event: IpcMainInvokeEvent | null | undefined,
  deps: Pick<IpcDeps, "getMainWindow" | "getAppWindows">,
): boolean {
  try {
    const sender = event?.sender;
    const frame = event?.senderFrame;
    if (!validateHostRendererSender(event) || !sender || sender.isDestroyed()
      || sender.getType() !== "window" || sender.session !== session.defaultSession
      || !frame || frame !== sender.mainFrame || frame.isDestroyed() || frame.detached) return false;
    const windows = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    return windows.some(window => window && !window.isDestroyed() && window.webContents === sender);
  } catch {
    // Native identity getters can expire during navigation or teardown; uncertainty grants no authority.
    return false;
  }
}
