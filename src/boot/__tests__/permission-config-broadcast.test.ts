/** Permission broadcasts use curated app windows and reach every loop that can mutate permission state. */
import { describe, expect, it, vi } from "vitest";
import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  makeConversationLoopMemoryManager,
  makeConversationLoopSettings,
} from "../../engine/__tests__/conversation-loop-test-helpers.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { liveWindow } from "../../__tests__/test-helpers.js";

const h = vi.hoisted(() => ({
  curatedWindows: [] as unknown[],
  mainWindow: null as unknown,
  getAllWindows: vi.fn(() => [] as unknown[]),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: h.getAllWindows },
  shell: { openExternal: vi.fn(async () => {}) },
}));

vi.mock("../../main/main-window.js", () => ({
  getAppWindows: () => h.curatedWindows,
}));

vi.mock("../../main/app-state.js", () => ({
  getMainWindow: () => h.mainWindow,
}));

import { broadcastPermissionConfigChangedFromHost } from "../permission-config-broadcast.js";
import {
  createConversationLoop,
  createRoutineConversationLoop,
  createSideChatConversationLoop,
  type ConversationDeps,
  type RoutineConversationLoopDeps,
  type SideChatConversationLoopDeps,
} from "../conversation.js";

/** Typing the spy through each factory dependency type catches keys hidden by fixture casts. */
type LoopBroadcastCallback =
  & NonNullable<ConversationDeps["broadcastPermissionConfigChanged"]>
  & NonNullable<RoutineConversationLoopDeps["broadcastPermissionConfigChanged"]>
  & NonNullable<SideChatConversationLoopDeps["broadcastPermissionConfigChanged"]>;

function sharedLoopDeps() {
  return {
    settingsService: makeConversationLoopSettings(),
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: makeConversationLoopMemoryManager(),
    memoryReviewer: { review: async () => "recap" },
    pluginRuntime: { listPluginCards: () => [], listPluginIds: () => [], listAll: () => [] },
    permissionManager: {},
    approvalGate: {},
    hookRunner: {},
    bashAstValidator: {},
    pluginOperationGrants: {},
    pluginOperationIdentityProvider: {},
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: vi.fn(),
      setOriginSource: vi.fn(),
      setActiveSessionId: vi.fn(),
      setActiveRolePrompt: vi.fn(),
      setProjectContext: vi.fn(),
      setRoutineMode: vi.fn(),
    },
  };
}

describe("host permission-config broadcast — window set", () => {
  it("fans out over the curated app windows and never the raw window list", () => {
    const curated = liveWindow();
    const oauthWindow = liveWindow();
    h.curatedWindows = [curated];
    h.mainWindow = curated;
    h.getAllWindows.mockReturnValue([curated, oauthWindow]);

    broadcastPermissionConfigChangedFromHost([curated as never]);

    expect(curated.webContents.send).toHaveBeenCalledWith(PERMISSIONS.configChanged, {});
    // Uncurated auth and external-content windows must not receive host permission events.
    expect(oauthWindow.webContents.send).not.toHaveBeenCalled();
    expect(h.getAllWindows).not.toHaveBeenCalled();
  });
});

describe("permission-config broadcast — every real loop factory reports", () => {
  it.each([
    ["main chat", (deps: Record<string, unknown>) => createConversationLoop(deps as never)],
    ["side chat", (deps: Record<string, unknown>) => createSideChatConversationLoop({
      ...deps,
      sideChatMemoryManager: makeConversationLoopMemoryManager(),
    } as never)],
    ["routine", (deps: Record<string, unknown>) => createRoutineConversationLoop(deps as never, {})],
  ])("%s loop broadcasts a session-directory grant", (_name, build) => {
    const broadcastPermissionConfigChanged: LoopBroadcastCallback = vi.fn();
    const loop = build({ ...sharedLoopDeps(), broadcastPermissionConfigChanged });

    loop.addSessionAdditionalDirectory("/tmp/granted-scope");

    expect(broadcastPermissionConfigChanged).toHaveBeenCalledTimes(1);
  });
});
