/**
 * IPC registration orchestrator.
 *
 * Replaces the monolithic `src/ipc-bridge.ts::registerIpcHandlers` with
 * per-domain registrars. Each domain file owns its own slice of channels;
 * `ipc-bridge.ts` delegates here and re-exports the public API so external
 * callers don't need to update their imports.
 *
 * Domain → channel prefix mapping:
 *   settings     ave:settings:*, ave:shell:*, ave:telemetry:consent-answer
 *   tour         ave:tour:*        — Tutorial-C SpotlightTour state + broadcast
 *   chat         ave:chat:*, ave:llm:*, ave:routines:*, ave:routine:*, ave:trigger:*,
 *                ave:memory:*, ave:starred:*, ave:feedback:*, ave:ask-user-question:*
 *   plugins      ave:plugins:*, ave:bootstrap:*, ave:runtime:*, ave:marketplace:*,
 *                ave:mcp:*, ave:plugin:*, ave:file:*, ave:notification:clicked
 *   prompts      ave:prompts:*
 *   usage        ave:usage:*
 *   audit        ave:audit:*, ave:dlp:*
 *   permissions  ave:permission:*, ave:approval:*, ave:policy:*
 *   window       window:*
 *   misc         ave:routines:v2:*, ave:session-todo:*
 *   work-board   ave:work-board:* (board CRUD + lifecycle; run/report deferred)
 *   ui           ave:ui:*
 *   dev          ave:dev:*  (only registered when !app.isPackaged)
 */
import { initDlpAudit } from "../audit/dlp-filter.js";
import { getIsPackaged } from "../boot/dev-flags.js";
import { registerSettingsHandlers } from "./domains/settings.js";
import { registerTourHandlers } from "./domains/tour.js";
import { registerChatHandlers } from "./domains/chat.js";
import { registerSideChatHandlers } from "./domains/sidechat.js";
import { registerPluginsHandlers } from "./domains/plugins.js";
import { registerPromptHandlers } from "./domains/prompts.js";
import { registerUsageHandlers } from "./domains/usage.js";
import { registerAuditHandlers } from "./domains/audit.js";
import { registerDiagnosticsHandlers } from "./domains/diagnostics.js";
import { registerPermissionsHandlers } from "./domains/permissions.js";
import { registerWindowHandlers } from "./domains/window.js";
import { registerMiscHandlers } from "./domains/misc.js";
import { registerWorkBoardHandlers } from "./domains/work-board.js";
import { registerAttachHandlers } from "./domains/attach.js";
import { registerPreviewHandlers } from "./domains/preview.js";
import { registerWorkspaceHandlers } from "./domains/workspace.js";
import { registerUiHandlers } from "./domains/ui.js";
import { registerTerminalHandlers } from "./domains/terminal.js";
import { registerDevHandlers } from "./domains/dev.js";
import { registerRemoteA2AHandlers } from "./domains/remote-a2a.js";
import type { IpcDeps } from "./types.js";
import type { AppServices } from "../boot/types.js";
import type { BrowserWindow } from "electron";

export type { IpcDeps } from "./types.js";
export { registerWindowEventListeners } from "./domains/window.js";
export { unregisterPluginWebview } from "./domains/plugins.js";
export { validateSender, validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized, validatePluginFrame } from "./gated.js";

/**
 * Register all IPC handlers. Called once during app boot (from main.ts /
 * ipc-bridge.ts). The `services` bag is spread into `IpcDeps` along with
 * the `getMainWindow` accessor.
 */
export function registerIpcHandlers(
  services: AppServices,
  getMainWindow: () => BrowserWindow | null,
  getAppWindows: () => Array<BrowserWindow | null | undefined> = () => [getMainWindow()],
): void {
  const deps: IpcDeps = { ...services, getMainWindow, getAppWindows };

  // Resolve the session at each DLP hit: chat new/resume/fork can change the
  // loop's session after handlers have been registered.
  initDlpAudit(deps.auditLogger, () => deps.conversationLoop.getSessionId());

  registerSettingsHandlers(deps);
  registerTourHandlers(deps);
  registerChatHandlers(deps);
  registerSideChatHandlers(deps);
  registerPluginsHandlers(deps);
  registerPromptHandlers(deps);
  registerUsageHandlers(deps);
  registerAuditHandlers(deps);
  registerDiagnosticsHandlers(deps);
  registerPermissionsHandlers(deps);
  registerWindowHandlers(deps);
  registerMiscHandlers(deps);
  registerWorkBoardHandlers(deps);
  registerAttachHandlers(deps);
  registerPreviewHandlers(deps);
  registerWorkspaceHandlers(deps);
  registerUiHandlers(deps);
  registerTerminalHandlers(deps);
  registerRemoteA2AHandlers(deps);
  // Dev IPC is *not* registered in packaged builds — the channels never
  // exist on `ipcMain`, so a compromised renderer/preload cannot probe them.
  if (!getIsPackaged()) {
    registerDevHandlers(deps);
  }
}
