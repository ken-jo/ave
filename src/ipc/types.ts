import type { BrowserWindow } from "electron";
import type { AppServices } from "../boot/types.js";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "../main/conversation-command-port.js";
import type { TailnetSharingOwnerService } from "../main/tailnet-sharing-owner-service.js";
import type { TelegramConnectionService } from "../main/telegram-connection-service.js";
import type { TailnetObserverConfigService } from "../main/tailnet-observer-config-service.js";

export type IpcDeps = AppServices & {
  getMainWindow: () => BrowserWindow | null;
  getAppWindows?: () => Array<BrowserWindow | null | undefined>;
  // Production surfaces share one host-owned lease and event runtime; focused single-transport tests may omit it.
  conversationSurfaceRuntime?: ConversationSurfaceRuntime;
  // Production surfaces share one command entrypoint; only focused domain tests may omit it.
  conversationCommandPort?: ConversationCommandPort;
  // The pairing/share facade exists only when its immutable boot gate is enabled.
  tailnetSharingOwnerService?: TailnetSharingOwnerService;
  // Absent connection wiring returns telegram-connection-disabled.
  telegramConnectionService?: TelegramConnectionService;
  // Absent observer wiring returns tailnet-observer-unavailable.
  tailnetObserverConfigService?: TailnetObserverConfigService;
};
