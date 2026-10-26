import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import { vi } from "vitest";
import { HOST_FRAME_URL } from "../test-helpers.js";

let currentEvent: IpcMainInvokeEvent | undefined;

/** Register a real app-window identity for tests that invoke native chat IPC. */
export async function installNativeChatWindow(candidate?: unknown): Promise<void> {
  const window = (candidate ?? {}) as Record<string, unknown>;
  const contents = (window.webContents ?? {}) as Record<string, unknown>;
  const mainFrame = { url: HOST_FRAME_URL };
  Object.assign(contents, {
    id: contents.id ?? 7101,
    mainFrame,
    isDestroyed: contents.isDestroyed ?? (() => false),
    on: contents.on ?? vi.fn(),
    send: contents.send ?? vi.fn(),
  });
  Object.assign(window, { id: window.id ?? 710, isDestroyed: window.isDestroyed ?? (() => false), webContents: contents });
  // Chat fixtures reset modules between registrations; use that live module's
  // registry rather than retaining an older copy's window identity.
  const { resetMainWindowsForTests, registerMainWindow } = await import("../../main/app-state.js");
  resetMainWindowsForTests();
  registerMainWindow(window as unknown as BrowserWindow, "primary");
  currentEvent = { sender: contents as unknown as WebContents, senderFrame: mainFrame } as IpcMainInvokeEvent;
}

export function nativeChatFrameEvent(): IpcMainInvokeEvent {
  if (!currentEvent) throw new Error("Native chat test window is not installed");
  return currentEvent;
}

export function invokeNativeChatHandler<T = unknown>(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string,
  ...args: unknown[]
): T {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for: ${channel}`);
  return handler(nativeChatFrameEvent(), ...args) as T;
}
