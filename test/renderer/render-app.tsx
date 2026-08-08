/**
 * renderApp helper.
 *
 * Stubs window.aveApi / window.ave with the provided overrides, renders
 * <App /> via @testing-library/react, returns the mock fns so tests can
 * assert IPC calls.
 */
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import {
  makeMockAveApi,
  makeMockAveNamespace,
  type MockAveApi,
} from "./mock-ave-api.js";

type RenderAppOpts = Parameters<typeof makeMockAveApi>[0] & {
  aveEnv?: Partial<{
    isDev: boolean;
    isE2E: boolean;
    enableDevConsole: boolean;
    debugStream: boolean;
  }>;
};

export type RenderAppReturn = {
  container: RenderResult["container"];
  rerender: RenderResult["rerender"];
  unmount: RenderResult["unmount"];
  api: MockAveApi;
  emitChatStream: (ev: unknown) => void;
  emitAgentSpawnEvent: ReturnType<typeof makeMockAveApi>["emitAgentSpawnEvent"];
  emitOverlayShow: (item: unknown) => void;
  emitOverlayDismiss: (id: string) => void;
  emitRoutineFiredV2: (r: unknown) => void;
  emitPluginEvent: (eventType: string, payload: unknown) => void;
  emitViewActivate: (v: string, settingsTab?: string) => void;
  emitAskUserQuestion: (r: unknown) => void;
  emitApproval: (r: unknown) => void;
  emitPluginRuntimeUpdated: (payload: { pluginId: string }) => void;
  emitNotificationToast: (payload: unknown) => void;
  emitNotificationClicked: (payload: unknown) => void;
};

export async function renderApp(opts: RenderAppOpts = {}): Promise<RenderAppReturn> {
  const { aveEnv, ...apiOpts } = opts;
  const {
    api,
    emitChatStream,
    emitAgentSpawnEvent,
    emitOverlayShow,
    emitOverlayDismiss,
    emitRoutineFiredV2,
    emitPluginEvent,
    emitViewActivate,
    emitAskUserQuestion,
    emitPluginRuntimeUpdated,
    emitNotificationToast,
    emitNotificationClicked,
  } = makeMockAveApi(apiOpts);
  const { ns, emitApproval } = makeMockAveNamespace({ env: aveEnv });

  vi.stubGlobal("aveApi", api);
  vi.stubGlobal("ave", ns);
  (window as unknown as { aveApi: MockAveApi }).aveApi = api;
  (window as unknown as { ave: unknown }).ave = ns;

  const { App } = await import("../../src/renderer.js");
  const result = render(<App />);

  return {
    container: result.container,
    rerender: result.rerender,
    unmount: result.unmount,
    api,
    emitChatStream,
    emitAgentSpawnEvent,
    emitOverlayShow,
    emitOverlayDismiss,
    emitRoutineFiredV2,
    emitPluginEvent,
    emitViewActivate,
    emitAskUserQuestion,
    emitApproval,
    emitPluginRuntimeUpdated,
    emitNotificationToast,
    emitNotificationClicked,
  };
}
