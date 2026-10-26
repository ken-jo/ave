// Every harness consumer needs shared cleanup and DOM polyfills, even without another setup import.
import "./setup.js";
import { setContainerWidths, type ContainerWidths } from "./setup.js";
import { act, render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import {
  makeMockAveApi,
  makeMockAveNamespace,
  type MockAveApi,
} from "./mock-ave-api.js";

type RenderAppOpts = Parameters<typeof makeMockAveApi>[0] & {
  shellWidth?: number;
  canvasWidth?: number;
  aveEnv?: Partial<{
    isDev: boolean;
    isE2E: boolean;
    enableDevConsole: boolean;
    debugStream: boolean;
  }>;
  pendingApprovals?: unknown[];
  workspaceRoots?: Array<{ path: string; isDefault: boolean }>;
  nativeContextMenu?: boolean;
};

export type RenderAppReturn = {
  resizeContainers: (widths: Partial<ContainerWidths>) => Promise<void>;
  container: RenderResult["container"];
  rerender: RenderResult["rerender"];
  unmount: RenderResult["unmount"];
  api: MockAveApi;
  releasedGroupIds: () => string[];
  emitChatStream: (ev: unknown) => void;
  emitChatFallback: ReturnType<typeof makeMockAveApi>["emitChatFallback"];
  emitAgentSpawnEvent: ReturnType<typeof makeMockAveApi>["emitAgentSpawnEvent"];
  emitSkillLoaded: ReturnType<typeof makeMockAveApi>["emitSkillLoaded"];
  emitSessionTasksChanged: ReturnType<typeof makeMockAveApi>["emitSessionTasksChanged"];
  emitOverlayShow: (item: unknown) => void;
  emitOverlayDismiss: (id: string) => void;
  emitRoutineFired: (r: unknown) => void;
  emitRoutineRunningStarted: (p: unknown) => void;
  emitPluginEvent: (eventType: string, payload: unknown) => void;
  emitViewActivate: (v: string, settingsTab?: string) => void;
  emitAskUserQuestion: (r: unknown) => void;
  emitApproval: (r: unknown) => void;
  emitApprovalSettled: (requestId: string) => void;
  chooseNativeMenuCommand: (command: string) => void;
  emitPluginRuntimeUpdated: (payload: { pluginId: string }) => void;
  emitNotificationToast: (payload: unknown) => void;
  emitNotificationClicked: (payload: unknown) => void;
};

export async function renderApp(opts: RenderAppOpts = {}): Promise<RenderAppReturn> {
  const { shellWidth = 1600, canvasWidth = shellWidth, aveEnv, pendingApprovals, workspaceRoots, nativeContextMenu, ...apiOpts } = opts;
  setContainerWidths({ shellWidth, canvasWidth });
  const {
    api,
    releasedGroupIds,
    emitChatStream,
    emitChatFallback,
    emitAgentSpawnEvent,
    emitSkillLoaded,
    emitSessionTasksChanged,
    emitOverlayShow,
    emitOverlayDismiss,
    emitRoutineFired,
    emitRoutineRunningStarted,
    emitPluginEvent,
    emitViewActivate,
    emitAskUserQuestion,
    emitPluginRuntimeUpdated,
    emitNotificationToast,
    emitNotificationClicked,
  } = makeMockAveApi(apiOpts);
  const { ns, emitApproval, emitApprovalSettled, chooseNativeMenuCommand } = makeMockAveNamespace({
    env: aveEnv, pendingApprovals, workspaceRoots, nativeContextMenu,
  });

  vi.stubGlobal("aveApi", api);
  vi.stubGlobal("ave", ns);
  (window as unknown as { aveApi: MockAveApi }).aveApi = api;
  (window as unknown as { ave: unknown }).ave = ns;

  const { App } = await import("../../src/renderer.js");
  const result = render(<App />);

  return {
    resizeContainers: async (widths) => { await act(async () => setContainerWidths(widths)); },
    container: result.container,
    rerender: result.rerender,
    unmount: result.unmount,
    api,
    releasedGroupIds,
    emitChatStream,
    emitChatFallback,
    emitAgentSpawnEvent,
    emitSkillLoaded,
    emitSessionTasksChanged,
    emitOverlayShow,
    emitOverlayDismiss,
    emitRoutineFired,
    emitRoutineRunningStarted,
    emitPluginEvent,
    emitViewActivate,
    emitAskUserQuestion,
    emitApproval,
    emitApprovalSettled,
    chooseNativeMenuCommand,
    emitPluginRuntimeUpdated,
    emitNotificationToast,
    emitNotificationClicked,
  };
}

// Test visible surfaces rather than mounting: hidden conversations keep their stream subscription.
export function atHome(container: HTMLElement): boolean {
  return container
    .querySelector('[data-testid="chat-surface"]')
    ?.getAttribute("data-visible") === "true";
}
