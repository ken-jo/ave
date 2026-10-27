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
    protocol: { handle: () => {} },
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
  "refreshActiveLlmWildcard",
  "refreshSandboxNetworkConfig",
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
  "refreshPluginEventBridge",
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
  "startAlerts",
  "alertsService",
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

  it("registers the side-chat child transcript read exactly once without a side-chat loop", () => {
    expect(channels.filter((channel) => channel === CHANNELS.sidechat.getSubAgentTranscript))
      .toEqual([CHANNELS.sidechat.getSubAgentTranscript]);
  });
  it("keeps subscription status invalidation internal and outbound-only", () => {
    const event = CHANNELS.settings.subscriptionRuntimeStatusUpdated;
    expect(event).toBe("ave:settings:subscription:status-updated");
    expect(channels).not.toContain(event);
    expect(PUBLIC_CHANNELS).not.toContain(event);
    expect(isPublicChannel(event)).toBe(false);
    expect(CHANNEL_GESTURE[event]).toBeUndefined();
  });

  it("keeps the browser tab-op and control events internal and outbound-only", () => {
    for (const event of [CHANNELS.browser.tabOp, CHANNELS.browser.control]) {
      expect(channels).not.toContain(event);
      expect(PUBLIC_CHANNELS).not.toContain(event);
      expect(isPublicChannel(event)).toBe(false);
      expect(CHANNEL_GESTURE[event]).toBeUndefined();
    }
    for (const invoke of [CHANNELS.browser.bindTab, CHANNELS.browser.stop, CHANNELS.surface.setActive]) {
      expect(channels).toContain(invoke);
      expect(isPublicChannel(invoke)).toBe(false);
    }
  });

  it("keeps document observation push outbound-only and its read-only acknowledgement private", () => {
    const event = CHANNELS.preview.observationEvents;
    const acknowledgement = CHANNELS.preview.observationAck;
    const frames = CHANNELS.preview.observationPreviewFrames;
    const preview = CHANNELS.preview.observationPreview;
    expect(channels).not.toContain(event);
    expect(channels).not.toContain(frames);
    expect(channels.filter((channel) => channel === acknowledgement)).toEqual([acknowledgement]);
    expect(channels.filter((channel) => channel === preview)).toEqual([preview]);
    for (const channel of [event, acknowledgement, frames, preview]) {
      expect(PUBLIC_CHANNELS).not.toContain(channel);
      expect(isPublicChannel(channel)).toBe(false);
      expect(CHANNEL_GESTURE[channel]).toBeUndefined();
    }
  });

  it("keeps the bootstrap status event outbound-only, beside its invoke twin", () => {
    // The event channel had a second spelling in `src/boot/bootstrap-status.ts`
    // that no gate compared against the contract, because only the invoke
    // channel below reaches `ipcMain` and so only that one is in the snapshot.
    // An outbound event needs its own lock or the literal can drift again.
    const event = CHANNELS.bootstrap.status;
    expect(event).toBe("ave:bootstrap:status");
    expect(channels).not.toContain(event);
    expect(PUBLIC_CHANNELS).not.toContain(event);
    expect(isPublicChannel(event)).toBe(false);
    expect(CHANNEL_GESTURE[event]).toBeUndefined();
    // The late-mount pull is the registered half, and stays in the snapshot.
    expect(CHANNELS.bootstrap.statusGet).toBe("ave:bootstrap:status:get");
    expect(channels).toContain(CHANNELS.bootstrap.statusGet);
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
        "ave:a2a-remote:tasks",
        "ave:agents:list",
        "ave:agents:uninstall",
        "ave:alerts:card-closed",
        "ave:alerts:list-kinds",
        "ave:alerts:list-open",
        "ave:alerts:remove-predecessor",
        "ave:alerts:set-kind",
        "ave:alerts:set-os-notifications-enabled",
        "ave:app:info",
        "ave:app:relaunch",
        "ave:approval:pending",
        "ave:approval:respond",
        "ave:ask-user-question:pending",
        "ave:ask-user-question:respond",
        "ave:attach:discardClipboardImage",
        "ave:attach:openExternal",
        "ave:attach:openFile",
        "ave:attach:readImage",
        "ave:attach:redeemDrop",
        "ave:attach:registerDrop",
        "ave:attach:saveClipboardImage",
        "ave:audit:search",
        "ave:audit:stats",
        "ave:away-authority:arm",
        "ave:away-authority:disarm",
        "ave:away-authority:status",
        "ave:bootstrap:retry",
        "ave:bootstrap:status:get",
        "ave:browser-workspace:clear-history",
        "ave:browser-workspace:find",
        "ave:browser-workspace:get-state",
        "ave:browser-workspace:preview",
        "ave:browser-workspace:set-bookmark",
        "ave:browser-workspace:set-site-permission",
        "ave:browser-workspace:stop-find",
        "ave:browser-workspace:zoom",
        "ave:browser:bind-tab",
        "ave:browser:get-session-bindings",
        "ave:browser:get-state",
        "ave:browser:pause",
        "ave:browser:pause-popup",
        "ave:browser:resume",
        "ave:browser:resume-popup",
        "ave:browser:stop",
        "ave:chat:abort",
        "ave:chat:branch-from-checkpoint",
        "ave:chat:compact",
        "ave:chat:continue-last-user",
        "ave:chat:control-shell-task",
        "ave:chat:edit-resend",
        "ave:chat:enter-checkpoint-view",
        "ave:chat:exit-checkpoint-view",
        "ave:chat:export",
        "ave:chat:fork",
        "ave:chat:get-history",
        "ave:chat:get-sub-agent-transcript",
        "ave:chat:get-turn-review",
        "ave:chat:get-verbatim-tool-result",
        "ave:chat:get-write-diff",
        "ave:chat:group-release",
        "ave:chat:guide",
        "ave:chat:has-provider",
        "ave:chat:import",
        "ave:chat:list-custom-commands",
        "ave:chat:list-shell-tasks",
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
        "ave:git:runtime:install",
        "ave:git:runtime:status",
        "ave:home-docs:custom:get",
        "ave:home-docs:custom:update",
        "ave:home-docs:marker:keep-mine",
        "ave:home-docs:marker:read",
        "ave:home-docs:merge:apply",
        "ave:home-docs:merge:discard",
        "ave:home-docs:merge:run",
        "ave:home-docs:packaged:apply",
        "ave:home-docs:upgrade-markers:list",
        "ave:host:plugin-theme-notify",
        "ave:llm:get-model-catalog",
        "ave:llm:ping",
        "ave:logs:tail",
        "ave:marketplace:boot-installs:dismiss",
        "ave:marketplace:boot-installs:notice",
        "ave:marketplace:catalog:list",
        "ave:marketplace:components:approve",
        "ave:marketplace:content:installed",
        "ave:marketplace:content:language-messages",
        "ave:marketplace:deep-link:take",
        "ave:marketplace:direct:preview",
        "ave:marketplace:install:execute",
        "ave:marketplace:install:plan",
        "ave:marketplace:package:detail",
        "ave:marketplace:sources:accept-rewrite",
        "ave:marketplace:sources:acknowledge",
        "ave:marketplace:sources:add",
        "ave:marketplace:sources:delete-token",
        "ave:marketplace:sources:list",
        "ave:marketplace:sources:pick-folder",
        "ave:marketplace:sources:preview",
        "ave:marketplace:sources:refresh",
        "ave:marketplace:sources:remove",
        "ave:marketplace:sources:reveal",
        "ave:marketplace:sources:set-enabled",
        "ave:marketplace:sources:set-token",
        "ave:marketplace:uninstall",
        "ave:marketplace:update:plan",
        "ave:marketplace:updates:apply-now",
        "ave:marketplace:updates:check",
        "ave:marketplace:updates:status",
        "ave:mcp:attach-resource",
        "ave:mcp:attach-resource-template",
        "ave:mcp:authenticate",
        "ave:mcp:call-tool",
        "ave:mcp:config:add",
        "ave:mcp:config:get",
        "ave:mcp:config:path",
        "ave:mcp:config:remove",
        "ave:mcp:config:set-api-key",
        "ave:mcp:dispose-ui-session",
        "ave:mcp:get-prompt",
        "ave:mcp:import:claude-desktop:apply",
        "ave:mcp:import:claude-desktop:preview",
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
        "ave:onboarding:proposals:answer",
        "ave:onboarding:proposals:list-pending",
        "ave:permission:add-rule",
        "ave:permission:get-mode",
        "ave:permission:list-rules",
        "ave:permission:list-scoped-rules",
        "ave:permission:remove-rule",
        "ave:permission:remove-scoped-rule",
        "ave:permission:set-mode",
        "ave:permissions:approval-sentence-select",
        "ave:permissions:approve-extensions-without-isolation",
        "ave:permissions:audit-show",
        "ave:permissions:audit-verify",
        "ave:permissions:deferred-list",
        "ave:permissions:deferred-resolve",
        "ave:permissions:dir-dispatch",
        "ave:permissions:egress-denials-recent",
        "ave:permissions:egress-grant-revoke",
        "ave:permissions:egress-grants-list",
        "ave:permissions:hook-trust-list",
        "ave:permissions:judge-get",
        "ave:permissions:judge-set",
        "ave:permissions:reviewer-dispatch",
        "ave:permissions:sandbox-capability",
        "ave:permissions:sandbox-windows-install",
        "ave:permissions:sandbox-windows-status",
        "ave:permissions:upstream-proxy-get",
        "ave:permissions:upstream-proxy-set",
        "ave:permissions:user-approval-list",
        "ave:permissions:user-approval-record",
        "ave:permissions:user-approval-revoke",
        "ave:plugin-studio:checkout:write",
        "ave:plugin-studio:connector-copy:confirm",
        "ave:plugin-studio:connector-copy:preview",
        "ave:plugin-studio:drafts:install-preview",
        "ave:plugin-studio:drafts:list",
        "ave:plugin-studio:drafts:read",
        "ave:plugin-studio:drafts:review",
        "ave:plugin-studio:drafts:validate",
        "ave:plugin-studio:drafts:write",
        "ave:plugin-studio:export",
        "ave:plugin-studio:file:install",
        "ave:plugin-studio:file:preview",
        "ave:plugin-studio:import",
        "ave:plugin-studio:installed:export",
        "ave:plugin-studio:parts:list",
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
        "ave:plugins:install-local",
        "ave:plugins:perf-stats",
        "ave:plugins:set-enabled",
        "ave:plugins:ui:list",
        "ave:plugins:ui:read-module",
        "ave:plugins:uninstall",
        "ave:policy:get",
        "ave:policy:set",
        "ave:preview:document-open-ack",
        "ave:preview:observation-ack",
        "ave:preview:observation-preview",
        "ave:preview:read-document",
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
        "ave:session-goal:clear",
        "ave:session-goal:get",
        "ave:session-goal:pause",
        "ave:session-goal:resume",
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
        "ave:settings:marketplace:install-provider-preset",
        "ave:settings:marketplace:uninstall-provider-preset",
        "ave:settings:set-api-key",
        "ave:settings:set-web-api-key",
        "ave:settings:subscription:acknowledge-notice",
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
        "ave:sidechat:control-shell-task",
        "ave:sidechat:end-pane-chat",
        "ave:sidechat:get-sub-agent-transcript",
        "ave:sidechat:list-shell-tasks",
        "ave:sidechat:load",
        "ave:sidechat:new",
        "ave:sidechat:pane-history",
        "ave:sidechat:send",
        "ave:skills:list",
        "ave:skills:uninstall",
        "ave:starred:add",
        "ave:starred:list",
        "ave:starred:remove",
        "ave:surface:set-active",
        "ave:tailnet-observer:apply",
        "ave:tailnet-observer:configure-serve",
        "ave:tailnet-observer:guided-setup",
        "ave:tailnet-observer:set-own-device-admission",
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
        "ave:terminal:block",
        "ave:terminal:blocks",
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
        "ave:usage:pricing-overrides",
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
        "ave:work-board:run-briefing",
        "ave:work-board:run-transcript",
        "ave:work-board:transition",
        "ave:work-board:update",
        "ave:workspace:drop-prepare",
        "ave:workspace:list-dir",
        "ave:workspace:list-roots",
        "ave:workspace:pick-root",
        "ave:workspace:remove-root",
        "ave:workspace:reveal",
        "ave:workspace:search-files",
        "window:close",
        "window:minimize",
        "window:syncTitleBarTheme",
        "window:toggleMaximize",
      ]
    `);
  });
});
