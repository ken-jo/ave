import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { vi } from "vitest";
import { securitySettingsGestures } from "../../ipc/security-settings-gesture.js";
import { WORK_BOARD } from "../../shared/ipc-channels.js";
import { workBoardDecisionKey, type WorkBoardDecisionChannel } from "../../shared/work-board-decision-intent.js";

export function workBoardTestSender() {
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn(),
    mainFrame: { url: "file:///index.html" },
  });
  securitySettingsGestures.observe(sender as unknown as WebContents);
  return sender;
}

export function pressWorkBoardTestKey(event: { sender: ReturnType<typeof workBoardTestSender> }): void {
  event.sender.emit("before-input-event", {}, { type: "keyDown", isAutoRepeat: false });
}

export function invokeWithWorkBoardTestKey(
  handler: (channel: string) => (...args: unknown[]) => unknown,
  channel: string, event: { sender: ReturnType<typeof workBoardTestSender> }, ...args: unknown[]
): unknown {
  pressWorkBoardTestKey(event);
  return handler(channel)(event, ...args);
}

export async function captureWorkBoardTestGesture(
  handler: (channel: string) => (...args: unknown[]) => unknown,
  event: { sender: ReturnType<typeof workBoardTestSender> },
  channel: WorkBoardDecisionChannel, itemId: unknown, input: unknown,
): Promise<string> {
  const token = randomUUID();
  event.sender.emit("before-mouse-event", {}, { type: "mouseUp" });
  const accepted = await handler(WORK_BOARD.captureDecisionIntent)(event, token, workBoardDecisionKey(channel, itemId, input));
  if (accepted !== true) throw new Error("The host did not accept the native work-board gesture");
  return token;
}
