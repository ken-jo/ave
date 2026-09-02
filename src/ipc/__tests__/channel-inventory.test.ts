/**
 * #1409 IPC wire lock — Commit C0 safety snapshot.
 *
 * Records every channel `registerIpcHandlers` registers on `ipcMain`
 * (`handle` / `handleOnce` / `on`) and snapshots the SORTED, UNIQUE list.
 * This is the wire contract for the behavior-preserving IPC refactor that
 * follows: a renamed / removed / added channel MUST change this snapshot.
 *
 * MUST pass against the current (unchanged) code.
 *
 * Determinism: the dev-flags gate is forced to unpackaged (`setIsPackaged(false)`)
 * so the dev domain (`index.ts` gates it on `!getIsPackaged()`) and the mockup
 * every application IPC handler
 * are always registered — capturing the full wire independent of the host env.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `vi.hoisted` guarantees `channels` exists before the hoisted `vi.mock`
// factory runs, so the static `registerIpcHandlers` import can record into it.
const { channels } = vi.hoisted(() => ({ channels: [] as string[] }));

vi.mock("electron", () => {
  const record = (channel: unknown): void => {
    if (typeof channel === "string") channels.push(channel);
  };
  const ipcMain = {
    handle: (channel: string) => record(channel),
    handleOnce: (channel: string) => record(channel),
    on: (channel: string) => record(channel),
    removeHandler: () => {},
    removeAllListeners: () => {},
    off: () => {},
    emit: () => {},
  };
  class BrowserWindow {
    webContents = {
      send: () => {},
      on: () => {},
      setWindowOpenHandler: () => {},
      id: 1,
    };
    on() {}
    loadURL() {}
    show() {}
    close() {}
    setMenu() {}
    isDestroyed() {
      return false;
    }
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
    static getFocusedWindow() {
      return null;
    }
  }
  const electron = {
    ipcMain,
    BrowserWindow,
    app: {
      getPath: () => "/tmp/ave-test",
      getAppPath: () => "/tmp/ave",
      getName: () => "ave",
      getVersion: () => "0.0.0-test",
      getLocale: () => "en-US",
      isPackaged: false,
      on: () => {},
      whenReady: () => Promise.resolve(),
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
    Menu: class Menu {
      append() {}
      popup() {}
      static buildFromTemplate() {
        return new Menu();
      }
      static setApplicationMenu() {}
    },
    MenuItem: class MenuItem {},
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
      createFromDataURL: () => ({ isEmpty: () => true }),
    },
    nativeTheme: { shouldUseDarkColors: false, on: () => {} },
    shell: { openExternal: async () => {}, openPath: async () => "" },
    webContents: { getAllWebContents: () => [], fromId: () => null },
    clipboard: { readText: () => "", writeText: () => {} },
    session: {
      fromPartition: () => ({ setPermissionRequestHandler: () => {} }),
      defaultSession: { setPermissionRequestHandler: () => {} },
    },
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { invoke: async () => {}, on: () => {}, send: () => {}, removeListener: () => {},
    },
  };
  return { ...electron, default: electron };
});

import { registerIpcHandlers } from "../index.js";
import { setIsPackaged, _resetForTest } from "../../boot/dev-flags.js";
import type { AppServices } from "../../boot/types.js";
import {
  CHANNELS,
  CHANNEL_GESTURE,
  isPublicChannel,
  PUBLIC_CHANNELS,
} from "../../contract/app-contract.js";

// Every top-level service field of AppServices. The mock proxy enumerates
// these so `{ ...services }` inside registerIpcHandlers carries a live nested
// proxy for each — no registrar destructure resolves to `undefined`.
const SERVICE_KEYS: (string | symbol)[] = [
  "pythonRuntime",
  "pythonPath",
  "pluginRuntime",
  "pluginMarketplace",
  "settingsService",
  "memoryConsolidationService",
  "memoryMaintenanceCoordinator",
  "memoryManager",
  "inputClassifier",
  "routeEngine",
  "toolRegistry",
  "systemPromptBuilder",
  "conversationLoop",
  "routineEngine",
  "mcpManager",
  "mcpArtifactStore",
  "agentArtifactStore",
  "skillArtifactStore",
  "idleScheduler",
  "preferenceRefreshService",
  "bashAstValidator",
  "auditService",
  "auditLogger",
  "postTurnHookChain",
  "approvalGate",
  "rewireReviewerAgent",
  "refreshMarketplaceFetcherConfig",
  "refreshActiveLlmWildcard",
  "refreshSandboxNetworkConfig",
  "knowledgeAvailable",
  "starredStore",
  "feedbackStore",
  "getSubAgentRunner",
  "routinesStore",
  "routinesScheduler",
  "sessionTasksStore",
  "workBoardStore",
  "workBoardEngine",
  "workBoardReport",
  "askUserQuestionGate",
  "skillStore",
  "agentProfileStore",
  "personaPromptStore",
  "refreshPluginNotifications",
  "pluginPaths",
  "clearAuthPartitionService",
  "listPluginAuthPartitionsService",
  "forgetPluginAuthPartitionsService",
  "registerPluginEventBridge",
  "telemetry",
  "pluginTelemetry",
  "autoUpdaterStop",
  "runPluginShutdownHandlers",
  "shutdown",
  "startRoutinesScheduler",
  "startWorkBoardDueSoon",
  "notificationService",
  "scriptHookManager",
];

import { makeDeepProxy } from "../../__tests__/support/deep-proxy.js";

beforeAll(() => {
  channels.length = 0;
  setIsPackaged(false);
  const services = makeDeepProxy(SERVICE_KEYS) as unknown as AppServices;
  registerIpcHandlers(services, () => null);
});

afterAll(() => {
  _resetForTest();
});

describe("IPC channel inventory (#1409 wire lock)", () => {
  it("registers a stable, sizeable set of channels", () => {
    const unique = [...new Set(channels)];
    // Sanity bound — a wholesale regression (registrars not wired) trips this
    // before the snapshot diff even matters.
    expect(unique.length).toBeGreaterThan(50);
  });
  it("keeps subscription status invalidation internal and outbound-only", () => {
    const event = CHANNELS.settings.subscriptionRuntimeStatusUpdated;
    expect(event).toBe("ave:settings:subscription:status-updated");
    expect(channels).not.toContain(event);
    expect(PUBLIC_CHANNELS).not.toContain(event);
    expect(isPublicChannel(event)).toBe(false);
    expect(CHANNEL_GESTURE[event]).toBeUndefined();
  });

  it("locks the sorted unique channel list", () => {
    const sorted = [...new Set(channels)].sort();
    expect(sorted).toMatchInlineSnapshot(`
      [
        "ave:a2a-remote:action",
        "ave:a2a-remote:send",
        "ave:a2a-remote:status",
        "ave:a2a-remote:targets",
        "ave:a2a-remote:task",
        "ave:agents:install",
        "ave:agents:list",
        "ave:agents:uninstall",
        "ave:app:info",
        "ave:approval:pending",
        "ave:approval:respond",
        "ave:ask-user-question:respond",
        "ave:attach:discardClipboardImage",
        "ave:attach:openExternal",
        "ave:attach:openFile",
        "ave:attach:readImage",
        "ave:attach:saveClipboardImage",
        "ave:audit:search",
        "ave:audit:stats",
        "ave:away-authority:arm",
        "ave:away-authority:disarm",
        "ave:away-authority:status",
        "ave:bootstrap:retry",
        "ave:chat:abort",
        "ave:chat:branch-from-checkpoint",
        "ave:chat:compact",
        "ave:chat:continue-last-user",
        "ave:chat:edit-resend",
        "ave:chat:enter-checkpoint-view",
        "ave:chat:exit-checkpoint-view",
        "ave:chat:export",
        "ave:chat:fork",
        "ave:chat:get-history",
        "ave:chat:get-sub-agent-transcript",
        "ave:chat:get-verbatim-tool-result",
        "ave:chat:get-write-diff",
        "ave:chat:group-release",
        "ave:chat:guide",
        "ave:chat:has-provider",
        "ave:chat:import",
        "ave:chat:main-active-state",
        "ave:chat:new",
        "ave:chat:retry-effort",
        "ave:chat:rewind-to",
        "ave:chat:send",
        "ave:chat:session-delete",
        "ave:chat:session-history",
        "ave:chat:session-resume",
        "ave:chat:session-update",
        "ave:chat:sessions",
        "ave:dev:getPreflightStatus",
        "ave:dev:setPreflightOverride",
        "ave:diagnostics:crash-list",
        "ave:diagnostics:export",
        "ave:dlp:stats",
        "ave:feedback:submit",
        "ave:host:plugin-theme-notify",
        "ave:llm:ping",
        "ave:logs:tail",
        "ave:marketplace:ping",
        "ave:mcp:attach-resource",
        "ave:mcp:attach-resource-template",
        "ave:mcp:call-tool",
        "ave:mcp:catalog:list",
        "ave:mcp:config:add",
        "ave:mcp:config:get",
        "ave:mcp:config:path",
        "ave:mcp:config:remove",
        "ave:mcp:config:set-api-key",
        "ave:mcp:dispose-ui-session",
        "ave:mcp:get-prompt",
        "ave:mcp:import:claude-desktop:apply",
        "ave:mcp:import:claude-desktop:preview",
        "ave:mcp:install-from-marketplace",
        "ave:mcp:kill",
        "ave:mcp:list-resource-templates",
        "ave:mcp:list-resources",
        "ave:mcp:servers",
        "ave:mcp:ui-download-file",
        "ave:mcp:ui-message",
        "ave:mcp:ui-model-context",
        "ave:mcp:ui-resource",
        "ave:memory:agents-md:get",
        "ave:memory:agents-md:update",
        "ave:memory:candidates:activate",
        "ave:memory:candidates:delete",
        "ave:memory:candidates:list",
        "ave:memory:entries:delete",
        "ave:memory:entries:list",
        "ave:memory:entries:save",
        "ave:memory:entries:search",
        "ave:memory:index:get",
        "ave:memory:index:sections:update",
        "ave:memory:index:update-if-unchanged",
        "ave:memory:long-term:refresh",
        "ave:memory:sessions:list",
        "ave:memory:sessions:search",
        "ave:memory:user-prefs:get",
        "ave:memory:user-prefs:refresh",
        "ave:memory:user-prefs:update",
        "ave:notification:clicked",
        "ave:permission:add-rule",
        "ave:permission:get-mode",
        "ave:permission:list-rules",
        "ave:permission:remove-rule",
        "ave:permission:set-mode",
        "ave:permissions:approval-sentence-select",
        "ave:permissions:audit-show",
        "ave:permissions:audit-verify",
        "ave:permissions:deferred-list",
        "ave:permissions:deferred-resolve",
        "ave:permissions:dir-dispatch",
        "ave:permissions:hook-trust-list",
        "ave:permissions:reviewer-dispatch",
        "ave:permissions:reviewer-provider-has-key",
        "ave:permissions:sandbox-capability",
        "ave:permissions:sandbox-windows-install",
        "ave:permissions:sandbox-windows-status",
        "ave:permissions:user-approval-list",
        "ave:permissions:user-approval-record",
        "ave:permissions:user-approval-revoke",
        "ave:plugin:call-tool",
        "ave:plugin:config:get",
        "ave:plugin:config:set",
        "ave:plugin:emit-event",
        "ave:plugin:ensure-partition",
        "ave:plugin:get-entry-url",
        "ave:plugin:get-theme",
        "ave:plugin:register-webview",
        "ave:plugin:request-operation-grant",
        "ave:plugin:storage:get",
        "ave:plugin:storage:set",
        "ave:plugins:call",
        "ave:plugins:cards",
        "ave:plugins:config:get",
        "ave:plugins:config:schema:get",
        "ave:plugins:config:secret:list-keys",
        "ave:plugins:config:secret:set",
        "ave:plugins:config:set",
        "ave:plugins:contribution-trust:list",
        "ave:plugins:contribution-trust:set",
        "ave:plugins:e2e:bundle-snapshot",
        "ave:plugins:install",
        "ave:plugins:install-local",
        "ave:plugins:marketplace:list",
        "ave:plugins:perf-stats",
        "ave:plugins:rollback",
        "ave:plugins:set-enabled",
        "ave:plugins:ui:list",
        "ave:plugins:ui:read-module",
        "ave:plugins:uninstall",
        "ave:policy:get",
        "ave:policy:set",
        "ave:preview:read-file",
        "ave:prompts:delete",
        "ave:prompts:list",
        "ave:prompts:list-summaries",
        "ave:prompts:save",
        "ave:routines:ack-result",
        "ave:routines:add",
        "ave:routines:dismiss",
        "ave:routines:list",
        "ave:routines:list-sessions",
        "ave:routines:pending-results",
        "ave:routines:remove",
        "ave:routines:trigger-now",
        "ave:runtime:counts",
        "ave:runtime:env",
        "ave:session-tasks:clear",
        "ave:session-tasks:list",
        "ave:settings:acp-subscription:cancel-login",
        "ave:settings:acp-subscription:choose-runtime",
        "ave:settings:acp-subscription:forget-runtime",
        "ave:settings:acp-subscription:logout",
        "ave:settings:acp-subscription:open-login-browser",
        "ave:settings:acp-subscription:start-login",
        "ave:settings:acp-subscription:status",
        "ave:settings:acp-subscription:verify",
        "ave:settings:codex-subscription:cancel-login",
        "ave:settings:codex-subscription:list-models",
        "ave:settings:codex-subscription:logout",
        "ave:settings:codex-subscription:start-browser-login",
        "ave:settings:codex-subscription:start-device-code-login",
        "ave:settings:codex-subscription:status",
        "ave:settings:delete-api-key",
        "ave:settings:delete-web-api-key",
        "ave:settings:env-forced",
        "ave:settings:get",
        "ave:settings:has-api-key",
        "ave:settings:has-web-api-key",
        "ave:settings:list-llm-models",
        "ave:settings:marketplace:delete-api-key",
        "ave:settings:marketplace:has-api-key",
        "ave:settings:marketplace:install-provider-preset",
        "ave:settings:marketplace:set-api-key",
        "ave:settings:marketplace:uninstall-provider-preset",
        "ave:settings:set-api-key",
        "ave:settings:set-web-api-key",
        "ave:settings:subscription:cancel-login",
        "ave:settings:subscription:choose-runtime",
        "ave:settings:subscription:forget-runtime",
        "ave:settings:subscription:list-models",
        "ave:settings:subscription:logout",
        "ave:settings:subscription:open-login-browser",
        "ave:settings:subscription:start-login",
        "ave:settings:subscription:status",
        "ave:settings:subscription:use-api-for-chat",
        "ave:settings:subscription:use-for-chat",
        "ave:settings:subscription:verify",
        "ave:settings:update",
        "ave:shell:open-external",
        "ave:sidechat:abort",
        "ave:sidechat:list",
        "ave:sidechat:load",
        "ave:sidechat:new",
        "ave:sidechat:send",
        "ave:skills:install",
        "ave:skills:list",
        "ave:skills:uninstall",
        "ave:starred:add",
        "ave:starred:list",
        "ave:starred:remove",
        "ave:tailnet-observer:apply",
        "ave:tailnet-observer:configure-serve",
        "ave:tailnet-observer:snapshot",
        "ave:tailnet-sharing:activate-pairing",
        "ave:tailnet-sharing:create-current-conversation-share",
        "ave:tailnet-sharing:create-invitation",
        "ave:tailnet-sharing:revoke-pairing",
        "ave:tailnet-sharing:revoke-share",
        "ave:tailnet-sharing:snapshot",
        "ave:telegram-connection:approve-current-conversation",
        "ave:telegram-connection:connect",
        "ave:telegram-connection:create-pairing-code",
        "ave:telegram-connection:disconnect",
        "ave:telegram-connection:pause",
        "ave:telegram-connection:resume",
        "ave:telegram-connection:revoke-approval",
        "ave:telegram-connection:revoke-pairing",
        "ave:telegram-connection:snapshot",
        "ave:telemetry:allowed-hosts",
        "ave:telemetry:consent-answer",
        "ave:terminal:input",
        "ave:terminal:kill",
        "ave:terminal:resize",
        "ave:terminal:spawn",
        "ave:tour:dismiss",
        "ave:tour:get-state",
        "ave:tour:mark-complete",
        "ave:tour:start",
        "ave:ui:dynamic-menu",
        "ave:ui:native-context-menu",
        "ave:usage:daily-summary",
        "ave:usage:export-csv",
        "ave:usage:range",
        "ave:usage:summary",
        "ave:window:open-html-preview",
        "ave:work-board:accept-proposal",
        "ave:work-board:add",
        "ave:work-board:complete",
        "ave:work-board:dismiss-proposal",
        "ave:work-board:generate-report",
        "ave:work-board:get",
        "ave:work-board:list",
        "ave:work-board:list-proposals",
        "ave:work-board:remove",
        "ave:work-board:reopen",
        "ave:work-board:run",
        "ave:work-board:run-transcript",
        "ave:work-board:transition",
        "ave:work-board:update",
        "ave:workspace:drop-prepare",
        "ave:workspace:list-dir",
        "ave:workspace:list-roots",
        "ave:workspace:pick-root",
        "ave:workspace:remove-root",
        "ave:workspace:reveal",
        "window:close",
        "window:minimize",
        "window:syncTitleBarTheme",
        "window:toggleMaximize",
      ]
    `);
  });
});
