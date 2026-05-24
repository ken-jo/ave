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
 *   auth         ave:auth:* (#893 mockup login)
 *   demo         ave:demo:* (activation-code → .env.demo decrypt + persist)
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
 *   ui           ave:ui:*
 *   dev          ave:dev:*  (only registered when !app.isPackaged)
 */
import { initDlpAudit } from "../audit/dlp-filter.js";
import { getIsPackaged } from "../boot/dev-flags.js";
import { registerSettingsHandlers } from "./domains/settings.js";
import { registerAuthHandlers } from "./domains/auth.js";
import { registerDemoHandlers } from "./domains/demo.js";
import { registerTourHandlers } from "./domains/tour.js";
import { registerChatHandlers } from "./domains/chat.js";
import { registerPluginsHandlers } from "./domains/plugins.js";
import { registerPromptHandlers } from "./domains/prompts.js";
import { registerUsageHandlers } from "./domains/usage.js";
import { registerAuditHandlers } from "./domains/audit.js";
import { registerPermissionsHandlers } from "./domains/permissions.js";
import { registerWindowHandlers } from "./domains/window.js";
import { registerMiscHandlers } from "./domains/misc.js";
import { registerAttachHandlers } from "./domains/attach.js";
import { registerUiHandlers } from "./domains/ui.js";
import { registerDevHandlers } from "./domains/dev.js";
import type { IpcDeps } from "./types.js";
import type { AppServices } from "../boot/types.js";
import type { BrowserWindow } from "electron";

export type { IpcDeps } from "./types.js";
export { registerWindowEventListeners } from "./domains/window.js";
export { unregisterPluginWebview } from "./domains/plugins.js";
export { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized, validatePluginFrame } from "./gated.js";

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

  // Wire DLP audit logging so redactForLLM records hits to audit JSONL.
  initDlpAudit(deps.auditLogger, deps.conversationLoop.getSessionId());

  registerSettingsHandlers(deps);
  registerAuthHandlers(deps);
  registerDemoHandlers(deps);
  registerTourHandlers(deps);
  registerChatHandlers(deps);
  registerPluginsHandlers(deps);
  registerPromptHandlers(deps);
  registerUsageHandlers(deps);
  registerAuditHandlers(deps);
  registerPermissionsHandlers(deps);
  registerWindowHandlers(deps);
  registerMiscHandlers(deps);
  registerAttachHandlers(deps);
  registerUiHandlers(deps);
  // Dev IPC is *not* registered in packaged builds — the channels never
  // exist on `ipcMain`, so a compromised renderer/preload cannot probe them.
  if (!getIsPackaged()) {
    registerDevHandlers(deps);
  }
}
