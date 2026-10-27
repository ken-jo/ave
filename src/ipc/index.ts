/**
 * IPC registration orchestrator.
 *
 * Handler registration is split per domain: each domain file owns its own
 * slice of channels, and `ipc-bridge.ts` delegates here while re-exporting the
 * public API, so an external caller imports from either without knowing which.
 *
 * Domain → channel prefix mapping. One line per registrar called below, so a
 * reader can answer "which file owns this channel" without opening all of them:
 *   settings      ave:settings:*, ave:shell:open-external,
 *                 ave:telemetry:consent-answer
 *   tour          ave:tour:*        — SpotlightTour state + broadcast
 *   chat          ave:chat:*, ave:llm:*, ave:memory:*, ave:starred:*,
 *                 ave:feedback:*, ave:ask-user-question:*
 *   sidechat      ave:sidechat:*
 *   plugins       ave:plugins:*, ave:plugin:*, ave:mcp:*, ave:runtime:*,
 *                 ave:agents:*, ave:skills:*, ave:bootstrap:*,
 *                 ave:marketplace:ping, ave:host:plugin-theme-notify,
 *                 ave:notification:clicked
 *   prompts       ave:prompts:*
 *   home-docs     ave:home-docs:* — ~/.ave reference docs + upgrade markers
 *   usage         ave:usage:*
 *   git-runtime   ave:git:runtime:* — git marketplace runtime status + managed install
 *   audit         ave:audit:*, ave:dlp:*
 *   diagnostics   ave:diagnostics:*, ave:logs:tail
 *   permissions   ave:permission:*, ave:permissions:*, ave:approval:respond,
 *                 ave:policy:*
 *   window        window:*, ave:window:open-html-preview
 *   routines      ave:routines:*
 *   session-tasks  ave:session-tasks:*
 *   app           ave:app:*
 *   work-board    ave:work-board:* (CRUD, lifecycle, run, run-transcript,
 *                 generate-report)
 *   attach        ave:attach:*
 *   preview       ave:preview:read-file, ave:preview:read-document
 *   workspace     ave:workspace:*
 *   ui            ave:ui:*
 *   terminal      ave:terminal:*
 *   remote-a2a    ave:a2a-remote:*
 *   tailnet-sharing     ave:tailnet-sharing:*
 *   telegram-connection ave:telegram-connection:*
 *   away-authority      ave:away-authority:*
 *   dev           ave:dev:*  (registered only when `getIsPackaged()` is false)
 *
 * `ave:trigger:*` is absent on purpose. The constants exist in
 * `contract/app-contract.ts` and the preload invokes `trigger.dismiss` and
 * `trigger.import`, but no `ipcMain.handle` for any `ave:trigger:` channel
 * exists in `src/` — those two invokes have no receiver. Recorded rather than
 * fixed here: giving them one is a behaviour change, not a rename.
 */
import { initDlpAudit } from "../audit/dlp-filter.js";
import { getIsPackaged } from "../boot/dev-flags.js";
import { registerSettingsHandlers } from "./domains/settings.js";
import { registerTourHandlers } from "./domains/tour.js";
import { registerChatHandlers } from "./domains/chat.js";
import { registerSideChatHandlers } from "./domains/sidechat.js";
import { registerPluginsHandlers } from "./domains/plugins.js";
import { registerPromptHandlers } from "./domains/prompts.js";
import { registerHomeDocsHandlers } from "./domains/home-docs.js";
import { registerUsageHandlers } from "./domains/usage.js";
import { registerGitRuntimeHandlers } from "./domains/git-runtime.js";
import { registerMarketplaceContentHandlers } from "./domains/marketplace-content.js";
import { registerGitMarketplaceHandlers, type GitMarketplaceRegistration } from "./domains/git-marketplace.js";
import { registerPluginStudioHandlers } from "./domains/plugin-studio.js";
import { registerAuditHandlers } from "./domains/audit.js";
import { registerDiagnosticsHandlers } from "./domains/diagnostics.js";
import { registerPermissionsHandlers } from "./domains/permissions.js";
import { registerPermissionJudgeHandlers } from "./domains/permission-judge.js";
import { registerWindowHandlers } from "./domains/window.js";
import { registerRoutineHandlers } from "./domains/routines.js";
import { registerSessionTasksHandlers } from "./domains/session-tasks.js";
import { registerSessionGoalHandlers } from "./domains/session-goal.js";
import { registerAlertsHandlers } from "./domains/alerts.js";
import { registerAppHandlers } from "./domains/app.js";
import { registerWorkBoardHandlers } from "./domains/work-board.js";
import { registerAttachHandlers } from "./domains/attach.js";
import { registerPreviewHandlers } from "./domains/preview.js";
import { registerDocumentEngineHandlers } from "./domains/document-engine.js";
import { registerWorkspaceHandlers } from "./domains/workspace.js";
import { registerUiHandlers } from "./domains/ui.js";
import { registerTerminalHandlers } from "./domains/terminal.js";
import { registerBrowserHandlers } from "./domains/browser.js";
import { registerDevHandlers } from "./domains/dev.js";
import { registerRemoteA2AHandlers } from "./domains/remote-a2a.js";
import { registerTailnetObserverHandlers } from "./domains/tailnet-observer.js";
import { registerTailnetSharingHandlers } from "./domains/tailnet-sharing.js";
import { registerTelegramConnectionHandlers } from "./domains/telegram-connection.js";
import { registerAwayAuthorityHandlers } from "./domains/away-authority.js";
import type { IpcDeps } from "./types.js";
import type { AppServices } from "../boot/types.js";
import type { BrowserWindow } from "electron";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "../main/conversation-command-port.js";
import type { TailnetSharingOwnerService } from "../main/tailnet-sharing-owner-service.js";
import type { TelegramConnectionService } from "../main/telegram-connection-service.js";
import type { TailnetObserverConfigService } from "../main/tailnet-observer-config-service.js";

export type { IpcDeps } from "./types.js";
export { registerWindowEventListeners } from "./domains/window.js";
export { unregisterPluginWebview } from "./domains/plugins.js";
export { validateSender, validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized, validatePluginFrame } from "./gated.js";

/**
 * Register all IPC handlers. Called once during app boot (from main.ts /
 * ipc-bridge.ts). The `services` bag is spread into `IpcDeps` along with
 * the `getMainWindow` accessor.
 */
/** What the desktop launch starts once the window has loaded. */
export interface IpcRegistration {
  gitMarketplace: GitMarketplaceRegistration;
}

export function registerIpcHandlers(
  services: AppServices,
  getMainWindow: () => BrowserWindow | null,
  getAppWindows: () => Array<BrowserWindow | null | undefined> = () => [getMainWindow()],
  conversationSurfaceRuntime?: ConversationSurfaceRuntime,
  conversationCommandPort?: ConversationCommandPort,
  tailnetSharingOwnerService?: TailnetSharingOwnerService,
  telegramConnectionService?: TelegramConnectionService,
  tailnetObserverConfigService?: TailnetObserverConfigService,
): IpcRegistration {
  const deps: IpcDeps = {
    ...services,
    getMainWindow,
    getAppWindows,
    ...(conversationSurfaceRuntime ? { conversationSurfaceRuntime } : {}),
    ...(conversationCommandPort ? { conversationCommandPort } : {}),
    ...(tailnetSharingOwnerService ? { tailnetSharingOwnerService } : {}),
    ...(telegramConnectionService ? { telegramConnectionService } : {}),
    ...(tailnetObserverConfigService ? { tailnetObserverConfigService } : {}),
  };

  // Resolve the session at each DLP hit: chat new/resume/fork can change the
  // loop's session after handlers have been registered.
  initDlpAudit(deps.auditLogger, () => deps.conversationLoop.getSessionId());

  // The git marketplace registers below; a settings write reaches it only once IPC is live.
  let gitMarketplaceRegistration: GitMarketplaceRegistration | null = null;
  registerSettingsHandlers(deps, {
    marketplaceSettingsChanged: () => gitMarketplaceRegistration!.settingsChanged(),
  });
  registerTourHandlers(deps);
  registerChatHandlers(deps);
  registerSideChatHandlers(deps);
  registerPluginsHandlers(deps);
  registerPromptHandlers(deps);
  registerHomeDocsHandlers(deps);
  registerUsageHandlers(deps);
  registerGitRuntimeHandlers(deps);
  // Bundled sign-in pruning waits while a package install, update or uninstall is open.
  deps.mcpManager.setPackageTransactionProbe(() => gitMarketplaceRegistration?.packageTransactionsIdle() ?? true);
  const installedContent = registerMarketplaceContentHandlers(deps);
  registerPluginStudioHandlers(deps, installedContent);
  const gitMarketplace = registerGitMarketplaceHandlers(deps, installedContent);
  gitMarketplaceRegistration = gitMarketplace;
  registerAuditHandlers(deps);
  registerDiagnosticsHandlers(deps);
  registerPermissionsHandlers(deps);
  registerPermissionJudgeHandlers(deps);
  registerWindowHandlers(deps);
  registerRoutineHandlers(deps);
  registerSessionTasksHandlers(deps);
  registerSessionGoalHandlers(deps);
  registerAppHandlers(deps);
  registerWorkBoardHandlers(deps);
  registerAlertsHandlers(deps, gitMarketplace.getService);
  registerAttachHandlers(deps);
  registerPreviewHandlers(deps);
  registerDocumentEngineHandlers(deps);
  registerWorkspaceHandlers(deps);
  registerUiHandlers(deps);
  registerTerminalHandlers(deps);
  registerBrowserHandlers(deps);
  registerRemoteA2AHandlers(deps);
  registerTailnetSharingHandlers(deps);
  registerTailnetObserverHandlers(deps);
  registerTelegramConnectionHandlers(deps);
  registerAwayAuthorityHandlers(deps);
  // Dev IPC is *not* registered in packaged builds — the channels never
  // exist on `ipcMain`, so a compromised renderer/preload cannot probe them.
  if (!getIsPackaged()) {
    registerDevHandlers(deps);
  }
  return { gitMarketplace };
}
